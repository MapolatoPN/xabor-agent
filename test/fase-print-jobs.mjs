// Trabajos de impresión en la nube: persistencia, snapshot, idempotencia,
// aislamiento entre negocios, ACK, reimpresión y estado.
//
// Corre contra Postgres y contra el servidor real. Es la mitad que decide si
// una comanda se pierde o no, así que casi todo aquí es una forma distinta de
// preguntar "¿puede esto imprimir dos veces o ninguna?".
import assert from 'assert';
import { randomUUID } from 'crypto';
import { arrancarServidor } from './lib-servidor.mjs';

const PUERTO = process.env.TEST_PORT || '4971';
const { pool } = await import('../src/services/database.js');
const {
  crearImpresora, crearRuta, crearTrabajosDeComanda, crearTrabajosDeDocumento,
  crearTrabajoDePrueba, reimprimirTrabajo, trabajosPendientesDeTerminal,
  marcarEntregado, registrarAckDeTerminal, estadoImpresion, listarTrabajos,
  construirClaveIdempotencia, MAX_INTENTOS,
} = await import('../src/services/impresionService.js');
const { crearEdge: crearEdgeDb, generarEmparejamiento, canjearEmparejamiento, revocarCredencial, listarEdges } =
  await import('../src/services/edgeService.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

// ─── Dos negocios completos, cada uno con su sucursal ───────────────────────
async function montarNegocio(slug, nombre) {
  const { rows: [n] } = await pool.query(
    `INSERT INTO negocios (nombre, slug) VALUES ($1,$2)
     ON CONFLICT (slug) DO UPDATE SET nombre = $1 RETURNING id`, [nombre, slug]);
  const { rows: [s] } = await pool.query(
    `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')
     ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true RETURNING id`, [n.id]);
  return { negocioId: n.id, sucursalId: s.id };
}

const A = await montarNegocio('edge-mapolato-demo', 'Mapolato Demo (Edge)');
const B = await montarNegocio('edge-otro-negocio', 'Otro Negocio (Edge)');

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });

// ─── Alta del Edge y su credencial ──────────────────────────────────────────
let edgeA, edgeB, tokenA;

await t('EDGE', '1. se da de alta un Edge y nace SIN credencial', async () => {
  edgeA = await crearEdgeDb(A.negocioId, { nombre: 'PC Caja' });
  assert.ok(edgeA.id);
  const lista = await listarEdges(A.negocioId);
  const mio = lista.find(e => e.id === edgeA.id);
  assert.strictEqual(mio.tiene_credencial, false, 'un Edge recién creado no puede autenticarse todavía');
  const { rows } = await pool.query('SELECT token_hash FROM terminales WHERE id = $1', [edgeA.id]);
  assert.strictEqual(rows[0].token_hash, null);
});

await t('EDGE', '2. el emparejamiento entrega el token UNA vez y solo guarda su hash', async () => {
  const { codigo } = await generarEmparejamiento(A.negocioId, edgeA.id);
  assert.match(codigo, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/, 'código corto, dictable, sin caracteres confundibles');

  const r = await canjearEmparejamiento(codigo);
  tokenA = r.token;
  assert.strictEqual(r.terminalId, edgeA.id);
  assert.ok(tokenA.length >= 32);

  const { rows } = await pool.query('SELECT token_hash FROM terminales WHERE id = $1', [edgeA.id]);
  assert.ok(rows[0].token_hash, 'quedó credencial');
  assert.notStrictEqual(rows[0].token_hash, tokenA, 'JAMÁS se guarda el token en claro');

  const { rows: emp } = await pool.query('SELECT codigo_hash FROM edge_emparejamientos WHERE terminal_id = $1', [edgeA.id]);
  assert.ok(!emp.some(e => e.codigo_hash === codigo), 'tampoco se guarda el código en claro');
});

await t('EDGE', '3. el código de emparejamiento es de un solo uso', async () => {
  const { codigo } = await generarEmparejamiento(A.negocioId, edgeA.id);
  await canjearEmparejamiento(codigo);
  await assert.rejects(() => canjearEmparejamiento(codigo), /inválido o vencido/i,
    'un código filtrado no puede servir dos veces');
});

await t('EDGE', '4. un código vencido no sirve', async () => {
  const { codigo } = await generarEmparejamiento(A.negocioId, edgeA.id);
  await pool.query(`UPDATE edge_emparejamientos SET expira_at = NOW() - INTERVAL '1 minute' WHERE terminal_id = $1 AND usado_at IS NULL`, [edgeA.id]);
  await assert.rejects(() => canjearEmparejamiento(codigo), /inválido o vencido/i);
});

await t('EDGE', '5. no se puede emparejar un Edge de otro negocio', async () => {
  edgeB = await crearEdgeDb(B.negocioId, { nombre: 'PC Otro' });
  await assert.rejects(() => generarEmparejamiento(A.negocioId, edgeB.id), /no encontrado/i,
    'el negocio A no puede generar credenciales para el Edge de B');
});

await t('EDGE', '6. revocar deja al Edge sin poder autenticarse', async () => {
  const tmp = await crearEdgeDb(A.negocioId, { nombre: 'PC Temporal' });
  const { codigo } = await generarEmparejamiento(A.negocioId, tmp.id);
  await canjearEmparejamiento(codigo);
  await revocarCredencial(A.negocioId, tmp.id);
  const { rows } = await pool.query('SELECT token_hash FROM terminales WHERE id = $1', [tmp.id]);
  assert.strictEqual(rows[0].token_hash, null);
  await assert.rejects(() => revocarCredencial(B.negocioId, tmp.id), /no encontrado/i,
    'ni siquiera se puede revocar el Edge de otro negocio');
});

await t('SEGURIDAD', '7. la credencial del Edge no es PANEL_SECRET ni ninguna clave global', async () => {
  const fs = await import('node:fs');
  // Los comentarios del archivo SÍ nombran PANEL_SECRET, justo para explicar
  // por qué no se usa. Se comprueba el código, no la prosa.
  const codigo = fs.readFileSync('src/services/edgeService.js', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
  for (const prohibido of ['PANEL_SECRET', 'SESSION_SECRET', 'ADMIN_PASSWORD', 'process.env']) {
    assert.ok(!codigo.includes(prohibido), `edgeService no debe usar ${prohibido}: cada Edge tiene su propia credencial`);
  }
  assert.ok(tokenA && tokenA !== process.env.PANEL_SECRET);
});

// ─── Impresoras y rutas ─────────────────────────────────────────────────────
const IMP = {};

await t('CONFIG', '8. se crean las cuatro impresoras de Obispado bajo el Edge', async () => {
  for (const [clave, nombre] of [['tickets', 'TICKETS'], ['chilaquiles', 'CHILAQUILES'], ['general', 'COCINA GENERAL'], ['bebidas', 'BEBIDAS']]) {
    IMP[clave] = await crearImpresora(A.negocioId, { terminalId: edgeA.id, nombre, transporte: 'mock' });
    assert.strictEqual(IMP[clave].negocio_id, A.negocioId);
    assert.strictEqual(IMP[clave].sucursal_id, A.sucursalId, 'la sucursal se deriva de la terminal, no del request');
  }
});

await t('CONFIG', '9. una impresora tcp_raw exige host y puerto explícitos', async () => {
  await assert.rejects(() => crearImpresora(A.negocioId, { terminalId: edgeA.id, nombre: 'SIN HOST', transporte: 'tcp_raw' }), /host/i);
  await assert.rejects(() => crearImpresora(A.negocioId, { terminalId: edgeA.id, nombre: 'SIN PUERTO', transporte: 'tcp_raw', host: '10.0.0.5' }), /puerto/i);
  const ok = await crearImpresora(A.negocioId, { terminalId: edgeA.id, nombre: 'CON DATOS', transporte: 'tcp_raw', host: '10.0.0.5', puerto: 9100 });
  assert.strictEqual(ok.puerto, 9100, 'el puerto se configura, no se supone');
});

await t('SEGURIDAD', '10. no se puede colgar una impresora del Edge de otro negocio', async () => {
  await assert.rejects(() => crearImpresora(A.negocioId, { terminalId: edgeB.id, nombre: 'ROBADA' }), /Terminal no encontrada/i);
});

await t('CONFIG', '11. las rutas replican la configuración real de Mapolato', async () => {
  await crearRuta(A.negocioId, { impresoraId: IMP.general.id, ambito: 'categoria', clave: 'Fuertes' });
  await crearRuta(A.negocioId, { impresoraId: IMP.general.id, ambito: 'categoria', clave: 'Ensaladas' });
  await crearRuta(A.negocioId, { impresoraId: IMP.bebidas.id, ambito: 'categoria', clave: 'Bebidas' });
  await crearRuta(A.negocioId, { impresoraId: IMP.chilaquiles.id, ambito: 'producto', clave: 'Chilaquiles' });
  await crearRuta(A.negocioId, { impresoraId: IMP.tickets.id, ambito: 'documento', clave: 'cuenta' });
  const rutas = await pool.query('SELECT count(*)::int AS n FROM impresion_rutas WHERE negocio_id = $1', [A.negocioId]);
  assert.strictEqual(rutas.rows[0].n, 5);
});

await t('CONFIG', '12. la misma regla dos veces se rechaza (un doble clic no duplica destinos)', async () => {
  await assert.rejects(() => crearRuta(A.negocioId, { impresoraId: IMP.bebidas.id, ambito: 'categoria', clave: 'BEBIDAS' }),
    /ya existe/i, 'la clave se normaliza: "BEBIDAS" y "Bebidas" son la misma regla');
});

await t('SEGURIDAD', '13. no se puede enrutar a la impresora de otro negocio', async () => {
  const impB = await crearImpresora(B.negocioId, { terminalId: edgeB.id, nombre: 'COCINA B' });
  await assert.rejects(() => crearRuta(A.negocioId, { impresoraId: impB.id, ambito: 'categoria', clave: 'Fuertes' }),
    /Impresora no encontrada/i, 'sería una fuga de comandas entre restaurantes');
});

// ─── La ronda demo ──────────────────────────────────────────────────────────
const CUENTA = randomUUID();
const COMANDA = {
  comanda: 1, tipo: 'inicial', mesa: 4, personas: 4, mesero: 'ANGEL DEMO',
  items: [
    { producto: 'Chilaquiles', categoria: 'Fuertes', cantidad: 1,
      modificadores: [{ grupo: 'Salsa', opcion: 'Verde' }, { grupo: 'Proteína', opcion: 'Bistec' },
                      { grupo: 'Guarnición', opcion: 'Frijoles' }, { grupo: 'Guarnición', opcion: 'Papas' }],
      notas: 'Sin cebolla', precio_unitario: 195 },
    { producto: 'Ensalada', categoria: 'Ensaladas', cantidad: 1, modificadores: [], notas: null, precio_unitario: 160 },
    { producto: 'Coca-Cola', categoria: 'Bebidas', cantidad: 2, modificadores: [], notas: null, precio_unitario: 35 },
  ],
};

let trabajosRonda;

await t('COMANDA', '14. la ronda demo produce exactamente los 3 trabajos esperados', async () => {
  const r = await crearTrabajosDeComanda({ negocioId: A.negocioId, cuentaId: CUENTA, comanda: COMANDA });
  trabajosRonda = r.creados;
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.creados.length, 3, `se esperaban 3 trabajos y hay ${r.creados.length}`);

  const porImpresora = Object.fromEntries(r.creados.map(t2 => [t2.impresora_nombre, t2.payload.items.map(i => i.producto)]));
  assert.deepStrictEqual(porImpresora['CHILAQUILES'], ['Chilaquiles']);
  assert.deepStrictEqual(porImpresora['COCINA GENERAL'], ['Chilaquiles', 'Ensalada']);
  assert.deepStrictEqual(porImpresora['BEBIDAS'], ['Coca-Cola']);
  assert.strictEqual(porImpresora['TICKETS'], undefined, 'la cuenta no se imprime al mandar la comanda');
});

await t('COMANDA', '15. el snapshot congela mesa, mesero, ronda, modificadores y notas', async () => {
  const chila = trabajosRonda.find(t2 => t2.impresora_nombre === 'CHILAQUILES');
  const p = chila.payload;
  assert.strictEqual(p.mesa, 4);
  assert.strictEqual(p.mesero, 'ANGEL DEMO');
  assert.strictEqual(p.ronda, 1);
  assert.strictEqual(p.items[0].notas, 'Sin cebolla');
  assert.strictEqual(p.items[0].modificadores.length, 4);
  assert.deepStrictEqual(p.items[0].modificadores[1], { grupo: 'Proteína', opcion: 'Bistec' });
  assert.ok(p.emitidoAt, 'queda la hora de emisión');
});

await t('COMANDA', '16. el snapshot NO se recalcula desde el menú actual', async () => {
  // Si mañana sube el precio o se renombra el platillo, la comanda de anoche
  // tiene que seguir diciendo lo que decía anoche.
  const { rows } = await pool.query('SELECT payload FROM impresion_trabajos WHERE id = $1', [trabajosRonda[0].id]);
  assert.ok(rows[0].payload.items.length > 0, 'el payload vive en la fila, no se reconstruye');
  assert.ok(!JSON.stringify(rows[0].payload).includes('producto_id'), 'no hay punteros al catálogo vivo');
});

await t('IDEMPOTENCIA', '17. reenviar la MISMA ronda no crea trabajos nuevos', async () => {
  const r2 = await crearTrabajosDeComanda({ negocioId: A.negocioId, cuentaId: CUENTA, comanda: COMANDA });
  assert.strictEqual(r2.creados.length, 0, 'ningún trabajo nuevo');
  assert.strictEqual(r2.duplicados.length, 3, 'los tres se reconocen como ya existentes');
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM impresion_trabajos WHERE negocio_id = $1 AND origen_id = $2`, [A.negocioId, `${CUENTA}:1`]);
  assert.strictEqual(rows[0].n, 3, 'en la base siguen siendo 3, no 6');
});

await t('IDEMPOTENCIA', '18. diez reintentos simultáneos de la misma ronda dejan 3 trabajos', async () => {
  const cuenta = randomUUID();
  const comanda = { ...COMANDA, comanda: 7 };
  const resultados = await Promise.all(
    Array.from({ length: 10 }, () => crearTrabajosDeComanda({ negocioId: A.negocioId, cuentaId: cuenta, comanda }))
  );
  const creados = resultados.reduce((s, r) => s + r.creados.length, 0);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM impresion_trabajos WHERE negocio_id = $1 AND origen_id = $2`, [A.negocioId, `${cuenta}:7`]);
  assert.strictEqual(rows[0].n, 3, `la carrera dejó ${rows[0].n} trabajos en vez de 3`);
  assert.strictEqual(creados, 3, `solo una de las diez llamadas debe reportar creación (reportaron ${creados})`);
});

await t('IDEMPOTENCIA', '19. la clave de idempotencia es determinista y no lleva reloj ni azar', async () => {
  const a1 = construirClaveIdempotencia({ negocioId: 'n', origenTipo: 'restaurante_comanda', origenId: 'c:1', impresoraId: 'i' });
  const a2 = construirClaveIdempotencia({ negocioId: 'n', origenTipo: 'restaurante_comanda', origenId: 'c:1', impresoraId: 'i' });
  assert.strictEqual(a1, a2);
  const otra = construirClaveIdempotencia({ negocioId: 'n', origenTipo: 'restaurante_comanda', origenId: 'c:1', impresoraId: 'otra' });
  assert.notStrictEqual(a1, otra, 'dos impresoras del mismo item son trabajos distintos');
  assert.ok(a1.startsWith('n:'), 'la clave lleva el negocio dentro: no puede chocar entre restaurantes');
});

await t('RONDA 2', '20. la segunda ronda imprime SOLO lo nuevo', async () => {
  const ronda2 = { comanda: 2, tipo: 'adicional', mesa: 4, personas: 4, mesero: 'ANGEL DEMO',
                   items: [{ producto: 'Café', categoria: 'Bebidas', cantidad: 1, modificadores: [], notas: null }] };
  const r = await crearTrabajosDeComanda({ negocioId: A.negocioId, cuentaId: CUENTA, comanda: ronda2 });
  assert.strictEqual(r.creados.length, 1, 'un solo destino: bebidas');
  assert.strictEqual(r.creados[0].impresora_nombre, 'BEBIDAS');
  assert.deepStrictEqual(r.creados[0].payload.items.map(i => i.producto), ['Café']);
  assert.strictEqual(r.creados[0].payload.ronda, 2);
});

await t('SIN RUTA', '21. un producto sin ruta no rompe nada y queda avisado', async () => {
  const r = await crearTrabajosDeComanda({
    negocioId: A.negocioId, cuentaId: randomUUID(),
    comanda: { comanda: 1, tipo: 'inicial', mesa: 9, mesero: 'X',
               items: [{ producto: 'Flan', categoria: 'Postres', cantidad: 1, modificadores: [] },
                       { producto: 'Coca-Cola', categoria: 'Bebidas', cantidad: 1, modificadores: [] }] },
  });
  assert.strictEqual(r.error, null, 'nunca lanza hacia el flujo de la comanda');
  assert.deepStrictEqual(r.sinRuta, ['Flan']);
  assert.strictEqual(r.creados.length, 1, 'la coca se imprime igual');
});

await t('SIN EDGE', '22. un negocio sin impresoras no rompe la comanda', async () => {
  const r = await crearTrabajosDeComanda({
    negocioId: B.negocioId, cuentaId: randomUUID(),
    comanda: { comanda: 1, tipo: 'inicial', mesa: 1, mesero: 'Y', items: [{ producto: 'Algo', categoria: 'Fuertes', cantidad: 1 }] },
  });
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.creados.length, 0);
  assert.ok(r.sinRuta.length > 0 || r.avisos.length > 0, 'se avisa, no se falla');
});

// ─── Cuenta ─────────────────────────────────────────────────────────────────
await t('CUENTA', '23. la cuenta va a TICKETS y a ninguna impresora de cocina', async () => {
  const r = await crearTrabajosDeDocumento({
    negocioId: A.negocioId, documento: 'cuenta', origenTipo: 'restaurante_cuenta', origenId: 'XAB-9001',
    payload: { mesa: 4, total: 460, items: [] },
  });
  assert.strictEqual(r.creados.length, 1);
  assert.strictEqual(r.creados[0].impresora_nombre, 'TICKETS');
  const cocina = r.creados.filter(x => x.impresora_nombre !== 'TICKETS');
  assert.strictEqual(cocina.length, 0, 'la cuenta NUNCA puede salir en cocina');
});

await t('CUENTA', '24. cerrar dos veces la misma cuenta no imprime dos tickets', async () => {
  const r2 = await crearTrabajosDeDocumento({
    negocioId: A.negocioId, documento: 'cuenta', origenTipo: 'restaurante_cuenta', origenId: 'XAB-9001',
    payload: { mesa: 4, total: 460, items: [] },
  });
  assert.strictEqual(r2.creados.length, 0);
  assert.strictEqual(r2.duplicados.length, 1);
});

// ─── Entrega, ACK y estados ─────────────────────────────────────────────────
await t('ENTREGA', '25. la cola de la terminal trae sus trabajos con la config de la impresora', async () => {
  const pendientes = await trabajosPendientesDeTerminal(edgeA.id);
  assert.ok(pendientes.length >= 3);
  const uno = pendientes.find(p => p.impresora_nombre === 'BEBIDAS');
  assert.ok(uno, 'la cola incluye los trabajos de bebidas');
  assert.strictEqual(uno.transporte, 'mock', 'viaja el transporte configurado');
  assert.ok('host' in uno && 'puerto' in uno, 'host/puerto viajan como datos al Edge');
});

await t('ENTREGA', '26. marcar entregado solo funciona para la terminal dueña', async () => {
  const trabajo = trabajosRonda[0];
  const ajeno = await marcarEntregado(trabajo.id, edgeB.id);
  assert.strictEqual(ajeno, null, 'el Edge de otro negocio no puede tocarlo');
  const propio = await marcarEntregado(trabajo.id, edgeA.id);
  assert.strictEqual(propio.estado, 'entregado');
});

await t('ACK', '27. el ACK de enviado cierra el trabajo', async () => {
  const trabajo = trabajosRonda[0];
  const r = await registrarAckDeTerminal(edgeA.id, { trabajoId: trabajo.id, resultado: 'enviado' });
  assert.strictEqual(r.estado, 'enviado');
  assert.strictEqual(r.intentos, 1);
  const { rows } = await pool.query('SELECT acked_at FROM impresion_trabajos WHERE id = $1', [trabajo.id]);
  assert.ok(rows[0].acked_at, 'queda la hora de confirmación');
});

await t('ACK', '28. un Edge ajeno NO puede confirmar el trabajo de otro', async () => {
  const trabajo = trabajosRonda[1];
  const r = await registrarAckDeTerminal(edgeB.id, { trabajoId: trabajo.id, resultado: 'enviado' });
  assert.strictEqual(r, null, 'el filtro por terminal_id es lo que impide falsear resultados de otro negocio');
  const { rows } = await pool.query('SELECT estado FROM impresion_trabajos WHERE id = $1', [trabajo.id]);
  assert.notStrictEqual(rows[0].estado, 'enviado');
});

await t('ACK', '29. un trabajo ya enviado no se puede "des-imprimir"', async () => {
  const trabajo = trabajosRonda[0];
  const r = await registrarAckDeTerminal(edgeA.id, { trabajoId: trabajo.id, resultado: 'fallido', error: 'tarde' });
  assert.strictEqual(r, null, 'un ACK tardío no puede reabrir algo ya confirmado');
});

await t('ACK', '30. tras MAX_INTENTOS fallos el trabajo queda agotado, no perdido', async () => {
  const trabajo = trabajosRonda[2];
  let estado;
  for (let i = 0; i < MAX_INTENTOS; i++) {
    const r = await registrarAckDeTerminal(edgeA.id, { trabajoId: trabajo.id, resultado: 'fallido', error: 'ECONNREFUSED' });
    estado = r.estado;
  }
  assert.strictEqual(estado, 'agotado');
  const { rows } = await pool.query('SELECT estado, intentos, ultimo_error FROM impresion_trabajos WHERE id = $1', [trabajo.id]);
  assert.strictEqual(rows[0].estado, 'agotado');
  assert.strictEqual(rows[0].intentos, MAX_INTENTOS);
  assert.match(rows[0].ultimo_error, /ECONNREFUSED/);
});

await t('ACK', '31. el estado incierto existe y no se confunde con enviado ni con fallido', async () => {
  const r = await crearTrabajosDeComanda({
    negocioId: A.negocioId, cuentaId: randomUUID(),
    comanda: { comanda: 1, tipo: 'inicial', mesa: 3, mesero: 'Z', items: [{ producto: 'Coca-Cola', categoria: 'Bebidas', cantidad: 1 }] },
  });
  const ack = await registrarAckDeTerminal(edgeA.id, { trabajoId: r.creados[0].id, resultado: 'incierto', error: 'ECONNRESET tras enviar' });
  assert.strictEqual(ack.estado, 'incierto');
  const { rows } = await pool.query(`SELECT estado FROM impresion_trabajos WHERE id = $1`, [r.creados[0].id]);
  assert.strictEqual(rows[0].estado, 'incierto', 'no se puede afirmar que salió papel, y tampoco que no');
});

await t('ACK', '32. un resultado de ACK inventado se rechaza', async () => {
  await assert.rejects(() => registrarAckDeTerminal(edgeA.id, { trabajoId: trabajosRonda[1].id, resultado: 'imprimiendo-quiza' }), /ACK/i);
});

// ─── Reimpresión ────────────────────────────────────────────────────────────
await t('REIMPRESION', '33. reimprimir crea un trabajo NUEVO y conserva el original', async () => {
  const original = trabajosRonda[0];
  const copia = await reimprimirTrabajo(A.negocioId, original.id, { motivo: 'se atoró el papel' });
  assert.notStrictEqual(copia.id, original.id);
  assert.strictEqual(copia.trabajo_original_id, original.id);
  assert.strictEqual(copia.estado, 'pendiente');
  assert.strictEqual(copia.origen_tipo, 'reimpresion');
  assert.strictEqual(copia.motivo, 'se atoró el papel');
  assert.strictEqual(copia.payload.reimpresion, true, 'el papel sale marcado como reimpresión');

  const { rows } = await pool.query('SELECT estado FROM impresion_trabajos WHERE id = $1', [original.id]);
  assert.strictEqual(rows[0].estado, 'enviado', 'el original NO se resetea: es la evidencia de lo que pasó');
});

await t('REIMPRESION', '34. dos reimpresiones seguidas son dos intenciones distintas', async () => {
  const a = await reimprimirTrabajo(A.negocioId, trabajosRonda[0].id, { motivo: 'otra vez' });
  const b = await reimprimirTrabajo(A.negocioId, trabajosRonda[0].id, { motivo: 'y otra' });
  assert.notStrictEqual(a.id, b.id, 'reimprimir dos veces debe sacar dos papeles');
});

await t('SEGURIDAD', '35. no se puede reimprimir el trabajo de otro negocio', async () => {
  await assert.rejects(() => reimprimirTrabajo(B.negocioId, trabajosRonda[0].id), /no encontrado/i);
});

// ─── Prueba de impresora ────────────────────────────────────────────────────
await t('PRUEBA', '36. la prueba pasa por la misma tubería y no usa atajos', async () => {
  const trabajo = await crearTrabajoDePrueba(A.negocioId, IMP.bebidas.id);
  assert.strictEqual(trabajo.documento, 'prueba');
  assert.strictEqual(trabajo.estado, 'pendiente', 'es un trabajo real de la cola');
  assert.strictEqual(trabajo.impresora_nombre, 'BEBIDAS');
  assert.ok(trabajo.payload.negocio && trabajo.payload.terminal, 'el papel dice a dónde salió');
});

await t('PRUEBA', '37. dos pruebas seguidas imprimen dos papeles', async () => {
  const a = await crearTrabajoDePrueba(A.negocioId, IMP.bebidas.id);
  const b = await crearTrabajoDePrueba(A.negocioId, IMP.bebidas.id);
  assert.notStrictEqual(a.id, b.id, 'una prueba es una intención nueva cada vez');
});

await t('PRUEBA', '38. no se puede probar una impresora de otro negocio ni una desactivada', async () => {
  await assert.rejects(() => crearTrabajoDePrueba(B.negocioId, IMP.bebidas.id), /no encontrada/i);
  await pool.query('UPDATE impresoras SET activa = false WHERE id = $1', [IMP.tickets.id]);
  await assert.rejects(() => crearTrabajoDePrueba(A.negocioId, IMP.tickets.id), /desactivada/i);
  await pool.query('UPDATE impresoras SET activa = true WHERE id = $1', [IMP.tickets.id]);
});

// ─── Estado y auditoría ─────────────────────────────────────────────────────
await t('ESTADO', '39. el estado distingue pendientes, último error y lo que necesita atención', async () => {
  const { impresoras } = await estadoImpresion(A.negocioId);
  const general = impresoras.find(i => i.nombre === 'COCINA GENERAL');
  assert.ok(general, 'aparece la impresora');
  assert.ok(typeof general.pendientes === 'number');
  assert.ok(typeof general.requieren_atencion === 'number');
  const conError = impresoras.find(i => i.ultimo_error);
  assert.ok(conError, 'el último error se puede consultar sin abrir la base');
  assert.ok(impresoras.every(i => 'terminal_nombre' in i && 'ultima_conexion' in i),
    'se distingue el estado del Edge del de cada impresora');
});

await t('ESTADO', '40. el historial de trabajos se puede listar y filtrar', async () => {
  const todos = await listarTrabajos(A.negocioId, { limite: 200 });
  assert.ok(todos.length > 5);
  const agotados = await listarTrabajos(A.negocioId, { estado: 'agotado' });
  assert.ok(agotados.every(t2 => t2.estado === 'agotado'));
  const delOtro = await listarTrabajos(B.negocioId, { limite: 200 });
  assert.ok(!delOtro.some(t2 => todos.some(x => x.id === t2.id)), 'ningún trabajo se cruza entre negocios');
});

await t('AISLAMIENTO', '41. la cola de un Edge nunca contiene trabajos de otro negocio', async () => {
  const colaB = await trabajosPendientesDeTerminal(edgeB.id);
  const idsA = new Set((await pool.query('SELECT id FROM impresion_trabajos WHERE negocio_id = $1', [A.negocioId])).rows.map(r => r.id));
  assert.ok(!colaB.some(t2 => idsA.has(t2.id)), 'el Edge de B no ve nada de A');
});

await t('AISLAMIENTO', '42. borrar una impresora conserva el historial de sus trabajos', async () => {
  const temp = await crearImpresora(A.negocioId, { terminalId: edgeA.id, nombre: 'TEMPORAL' });
  await crearRuta(A.negocioId, { impresoraId: temp.id, ambito: 'categoria', clave: 'Temporales' });
  const r = await crearTrabajosDeComanda({
    negocioId: A.negocioId, cuentaId: randomUUID(),
    comanda: { comanda: 1, tipo: 'inicial', mesa: 8, mesero: 'W', items: [{ producto: 'X', categoria: 'Temporales', cantidad: 1 }] },
  });
  assert.strictEqual(r.creados.length, 1);
  const trabajoId = r.creados[0].id;

  await pool.query('DELETE FROM impresoras WHERE id = $1', [temp.id]);
  const { rows } = await pool.query('SELECT id, impresora_id, impresora_nombre FROM impresion_trabajos WHERE id = $1', [trabajoId]);
  assert.strictEqual(rows.length, 1, 'el trabajo sobrevive: es evidencia de lo que ocurrió');
  assert.strictEqual(rows[0].impresora_id, null);
  assert.strictEqual(rows[0].impresora_nombre, 'TEMPORAL', 'y sigue diciendo a dónde iba');
});

// ─── SSRF ───────────────────────────────────────────────────────────────────
await t('SSRF', '43. la nube guarda host/puerto como datos y jamás abre un socket contra ellos', async () => {
  const lan = await crearImpresora(A.negocioId, {
    terminalId: edgeA.id, nombre: 'LAN COCINA', transporte: 'tcp_raw', host: '192.168.1.50', puerto: 9100,
  });
  assert.strictEqual(lan.host, '192.168.1.50');

  const fs = await import('node:fs');
  const sospechosos = ['src/server.js', 'src/services/impresionService.js', 'src/printing/routingEngine.js', 'src/services/edgeService.js'];
  for (const archivo of sospechosos) {
    const src = fs.readFileSync(archivo, 'utf8');
    assert.ok(!/net\.(connect|createConnection)|from ['"]node:net['"]|require\(['"]net['"]\)/.test(src),
      `${archivo} no puede abrir sockets: la LAN del restaurante solo la toca el Edge`);
    assert.ok(!/fetch\([^)]*\$\{[^}]*host/.test(src), `${archivo} no puede usar host de impresora en una petición`);
  }
});

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
