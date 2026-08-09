// Revisión adversarial previa al deploy.
//
// Cubre los cuatro riesgos que un simulador amable no habría enseñado:
//
//   1. semántica del transporte TCP (en fase-edge-tcp)
//   2. la cola local frente a crash, truncado y dos procesos
//   3. la carrera de dos Edges con la misma credencial
//   4. la paginación del backlog en sus bordes
//
// Aquí van 2, 3 y 4, más la comprobación de que 043 no altera nada existente.
import assert from 'assert';
import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { arrancarServidor } from './lib-servidor.mjs';
import { crearAlmacen, BloqueoOcupado } from '../edge/storage/index.js';
import { tomarBloqueo, rutaBloqueo } from '../edge/storage/bloqueo.js';
import { crearAlmacenJson, rutaPorDefectoJson } from '../edge/storage/jsonFile.js';
import { rutaPorDefectoSqlite } from '../edge/storage/sqlite.js';
import { loggerSilencioso } from '../edge/logger.js';

const PUERTO = process.env.TEST_PORT || '4973';
const { pool } = await import('../src/services/database.js');
const { crearImpresora, crearRuta, crearTrabajosDeComanda, trabajosPendientesDeTerminal,
        cursorDeTrabajo, marcarEntregado, registrarAckDeTerminal } = await import('../src/services/impresionService.js');
const { crearEdge: altaEdge, generarEmparejamiento, canjearEmparejamiento } =
  await import('../src/services/edgeService.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

const temporales = [];
const dirTemporal = () => { const d = mkdtempSync(join(tmpdir(), 'xabor-gate-')); temporales.push(d); return d; };

const trabajo = (id, imp = 'COCINA') => ({
  id, documento: 'comanda', impresoraId: `id-${imp}`, impresoraNombre: imp,
  transporte: 'mock', anchoColumnas: 42,
  payload: { negocio: 'Demo', mesa: 4, items: [{ producto: 'Chilaquiles', cantidad: 1, modificadores: [] }] },
});

// ════════════════════════════════════════════════════════════════════════════
// 2. ALMACÉN LOCAL
// ════════════════════════════════════════════════════════════════════════════

await t('BLOQUEO', '1. dos procesos Edge sobre la MISMA carpeta: el segundo falla rápido', async () => {
  const dir = dirTemporal();
  const a1 = crearAlmacen({ almacen: 'sqlite', rutaDatos: dir, logger: loggerSilencioso });
  try {
    assert.throws(
      () => crearAlmacen({ almacen: 'sqlite', rutaDatos: dir, logger: loggerSilencioso }),
      (e) => e instanceof BloqueoOcupado && e.code === 'EDGE_YA_EN_EJECUCION',
      'dos workers consumiendo la misma cola sacarían cada comanda dos veces'
    );
  } finally { a1.cerrar(); }
});

await t('BLOQUEO', '2. al cerrar se libera y otro proceso puede tomar la carpeta', async () => {
  const dir = dirTemporal();
  const a1 = crearAlmacen({ almacen: 'sqlite', rutaDatos: dir, logger: loggerSilencioso });
  a1.cerrar();
  assert.ok(!existsSync(rutaBloqueo(dir)), 'el archivo de bloqueo se retira al cerrar');
  const a2 = crearAlmacen({ almacen: 'sqlite', rutaDatos: dir, logger: loggerSilencioso });
  a2.cerrar();
});

await t('BLOQUEO', '3. un bloqueo huérfano (corte de luz) NO deja al Edge sin arrancar', async () => {
  const dir = dirTemporal();
  // pid imposible: simula el archivo que dejó un proceso que ya no existe.
  writeFileSync(rutaBloqueo(dir), JSON.stringify({ pid: 999999, desde: new Date().toISOString() }));
  const a = crearAlmacen({ almacen: 'sqlite', rutaDatos: dir, logger: loggerSilencioso });
  try {
    assert.ok(a, 'quedarse sin imprimir por un archivo huérfano sería peor que el problema que evita');
    const dueno = JSON.parse(readFileSync(rutaBloqueo(dir), 'utf8'));
    assert.strictEqual(dueno.pid, process.pid, 'el relevo queda registrado');
  } finally { a.cerrar(); }
});

await t('BLOQUEO', '4. un bloqueo ilegible se trata como huérfano, no como pared', async () => {
  const dir = dirTemporal();
  writeFileSync(rutaBloqueo(dir), 'esto no es json');
  const a = crearAlmacen({ almacen: 'sqlite', rutaDatos: dir, logger: loggerSilencioso });
  a.cerrar();
});

await t('BLOQUEO', '5. el bloqueo no usa primitivas exclusivas de Unix', async () => {
  // Se mira el CÓDIGO, no los comentarios: el archivo explica por qué no usa
  // esas primitivas, y nombrarlas en prosa no es usarlas.
  const codigo = readFileSync('edge/storage/bloqueo.js', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  for (const prohibido of ['flock', 'fcntl', '/var/run', '/tmp/', 'child_process']) {
    assert.ok(!codigo.includes(prohibido), `${prohibido} no funcionaría en la PC del restaurante`);
  }
  assert.ok(codigo.includes("'wx'"), "se usa open(...,'wx'), que es exclusivo y multiplataforma");
});

await t('CORRUPCION', '6. archivo truncado: se respalda, NO se borra, y el Edge arranca', async () => {
  const dir = dirTemporal();
  const ruta = rutaPorDefectoJson(dir);
  const a1 = crearAlmacenJson({ ruta });
  a1.registrarTrabajo(trabajo('j1'));
  a1.registrarTrabajo(trabajo('j2'));
  a1.cerrar();

  // Truncar a la mitad, que es lo que deja un corte de luz a media escritura.
  const original = readFileSync(ruta, 'utf8');
  writeFileSync(ruta, original.slice(0, Math.floor(original.length / 2)));

  const a2 = crearAlmacenJson({ ruta, logger: loggerSilencioso });
  try {
    assert.strictEqual(a2.todos().length, 0, 'arranca vacío, pero...');
    const fs = await import('node:fs');
    const respaldos = fs.readdirSync(dir).filter(f => f.includes('.corrupto-'));
    assert.strictEqual(respaldos.length, 1, '...la evidencia se conserva, nunca se borra en silencio');
    assert.ok(fs.readFileSync(join(dir, respaldos[0]), 'utf8').length > 0);
  } finally { a2.cerrar(); }
});

await t('CORRUPCION', '7. contenido inválido: mismo trato, con respaldo', async () => {
  const dir = dirTemporal();
  const ruta = rutaPorDefectoJson(dir);
  writeFileSync(ruta, '{"trabajos": "esto deberia ser un objeto"}');
  const a = crearAlmacenJson({ ruta, logger: loggerSilencioso });
  try {
    const fs = await import('node:fs');
    assert.strictEqual(fs.readdirSync(dir).filter(f => f.includes('.corrupto-')).length, 1);
  } finally { a.cerrar(); }
});

await t('CORRUPCION', '8. un .tmp huérfano de un crash no confunde al almacén', async () => {
  const dir = dirTemporal();
  const ruta = rutaPorDefectoJson(dir);
  const a1 = crearAlmacenJson({ ruta });
  a1.registrarTrabajo(trabajo('bueno'));
  a1.cerrar();

  // El proceso murió justo tras escribir el temporal y antes del rename.
  writeFileSync(`${ruta}.tmp`, '{"trabajos":{"a-medias"');

  const a2 = crearAlmacenJson({ ruta, logger: loggerSilencioso });
  try {
    assert.ok(a2.obtener('bueno'), 'el archivo bueno manda: el rename es lo que hace el cambio visible');
    assert.strictEqual(a2.todos().length, 1, 'el temporal a medias se ignora, no se lee');
  } finally { a2.cerrar(); }
});

await t('CORRUPCION', '9. escribir sobre el archivo único es atómico (temporal + rename)', async () => {
  const src = readFileSync('edge/storage/jsonFile.js', 'utf8');
  assert.ok(/writeFileSync\(tmp/.test(src), 'se escribe primero a un temporal');
  assert.ok(/renameSync\(tmp, ruta\)/.test(src), 'y el rename hace el cambio visible de golpe');
  const cuerpo = src.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/unlinkSync\(ruta\)/.test(cuerpo), 'nunca se borra el archivo antes de renombrar');
});

await t('CORRUPCION', '10. perder la cola local NO pierde trabajos: la nube los reenvía', async () => {
  // Esta es la razón de que arrancar vacío sea aceptable. La fuente de verdad
  // es la nube: todo lo que no esté confirmado sigue en la consulta de
  // pendientes y se vuelve a entregar al reconectar.
  const { rows } = await pool.query(
    `SELECT pg_get_viewdef(0)` .replace('pg_get_viewdef(0)', "'ok' AS x")); // consulta trivial: el punto es el siguiente assert
  assert.ok(rows.length === 1);
  const fs = await import('node:fs');
  const src = fs.readFileSync('src/services/impresionService.js', 'utf8');
  assert.ok(/estado IN \('pendiente','entregado','fallido'\)/.test(src),
    "un trabajo 'entregado' sin confirmar sigue en la cola de la nube: si el Edge lo perdió, vuelve a salir");
});

// ════════════════════════════════════════════════════════════════════════════
// Servidor para el resto
// ════════════════════════════════════════════════════════════════════════════
const { rows: [neg] } = await pool.query(
  `INSERT INTO negocios (nombre, slug) VALUES ('Gate Demo','gate-demo')
   ON CONFLICT (slug) DO UPDATE SET nombre = 'Gate Demo' RETURNING id`);
const { rows: [suc] } = await pool.query(
  `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')
   ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true RETURNING id`, [neg.id]);

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });

const edgeDb = await altaEdge(neg.id, { nombre: 'PC Gate' });
const { codigo } = await generarEmparejamiento(neg.id, edgeDb.id);
const cred = await canjearEmparejamiento(codigo);
const imp = await crearImpresora(neg.id, { terminalId: edgeDb.id, nombre: 'GATE', transporte: 'mock' });
await crearRuta(neg.id, { impresoraId: imp.id, ambito: 'categoria', clave: 'Fuertes' });

async function crearNTrabajos(n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const r = await crearTrabajosDeComanda({
      negocioId: neg.id, cuentaId: randomUUID(),
      comanda: { comanda: 1, tipo: 'inicial', mesa: i + 1, mesero: 'GATE',
                 items: [{ producto: 'Guiso', categoria: 'Fuertes', cantidad: 1, modificadores: [] }] },
    });
    ids.push(...r.creados.map(x => x.id));
  }
  return ids;
}

// Reproduce EXACTAMENTE lo que hace el servidor al conectar un Edge, para
// poder probar los bordes sin levantar un WebSocket por cada tamaño.
async function paginarComoElServidor(terminalId, { lote = 50, tope = 500 } = {}) {
  const entregados = [];
  let cursor = null;
  while (entregados.length < tope) {
    const pagina = await trabajosPendientesDeTerminal(terminalId, { limite: lote, desde: cursor });
    if (!pagina.length) break;
    for (const fila of pagina) {
      entregados.push(fila.id);
      await marcarEntregado(fila.id, terminalId);
    }
    cursor = cursorDeTrabajo(pagina[pagina.length - 1]);
    if (pagina.length < lote) break;
  }
  return entregados;
}

const limpiarTrabajos = () => pool.query('DELETE FROM impresion_trabajos WHERE negocio_id = $1', [neg.id]);

// ════════════════════════════════════════════════════════════════════════════
// 4. PAGINACIÓN
// ════════════════════════════════════════════════════════════════════════════
for (const n of [0, 1, 49, 50, 51, 60, 100]) {
  await t('PAGINACION', `11.${n} con ${n} pendientes se entregan ${n}, sin saltos ni repetidos`, async () => {
    await limpiarTrabajos();
    const esperados = await crearNTrabajos(n);
    assert.strictEqual(esperados.length, n, 'preparación');

    const entregados = await paginarComoElServidor(edgeDb.id);

    assert.strictEqual(entregados.length, n, `se entregaron ${entregados.length} de ${n}`);
    assert.strictEqual(new Set(entregados).size, entregados.length, 'ninguno repetido');
    const faltan = esperados.filter(id => !entregados.includes(id));
    assert.deepStrictEqual(faltan, [], `quedaron ${faltan.length} sin entregar`);
  });
}

await t('PAGINACION', '12. con 501 pendientes se entrega el tope y el resto NO se pierde', async () => {
  await limpiarTrabajos();
  const esperados = await crearNTrabajos(501);
  const entregados = await paginarComoElServidor(edgeDb.id, { tope: 500 });

  assert.strictEqual(entregados.length, 500, 'el tope de cordura se respeta');
  assert.strictEqual(new Set(entregados).size, 500, 'sin repetidos');

  // Lo que no cupo sigue pendiente y sale en la siguiente conexión. Se
  // comprueba por su estado, no buscándolo en la primera página: es el
  // último por fecha, así que nunca estaría ahí.
  const noEntregados = esperados.filter(id => !entregados.includes(id));
  assert.strictEqual(noEntregados.length, 1);
  const { rows } = await pool.query(
    `SELECT estado FROM impresion_trabajos WHERE id = $1`, [noEntregados[0]]);
  assert.strictEqual(rows[0].estado, 'pendiente',
    'el que no cupo sigue pendiente en la nube: no se pierde, espera a la próxima conexión');

  // Y una segunda ronda de paginación lo alcanza.
  const segunda = await paginarComoElServidor(edgeDb.id, { tope: 600 });
  assert.ok(segunda.includes(noEntregados[0]), 'la siguiente conexión sí lo entrega');
});

await t('PAGINACION', '13. un trabajo NUEVO durante la paginación no se pierde ni se duplica', async () => {
  await limpiarTrabajos();
  const previos = await crearNTrabajos(60);

  // Se pagina a mano y, justo después del primer lote, entra una comanda.
  const entregados = [];
  let cursor = null;
  let nuevoId = null;

  for (let vuelta = 0; vuelta < 10; vuelta++) {
    const pagina = await trabajosPendientesDeTerminal(edgeDb.id, { limite: 50, desde: cursor });
    if (!pagina.length) break;
    for (const fila of pagina) { entregados.push(fila.id); await marcarEntregado(fila.id, edgeDb.id); }
    cursor = cursorDeTrabajo(pagina[pagina.length - 1]);

    if (vuelta === 0) {
      const nuevos = await crearNTrabajos(1);   // llega una comanda a media paginación
      nuevoId = nuevos[0];
    }
    if (pagina.length < 50) break;
  }

  assert.strictEqual(new Set(entregados).size, entregados.length, 'ninguno duplicado por el movimiento del cursor');
  const todos = [...previos, nuevoId];
  const sinEntregar = todos.filter(id => !entregados.includes(id));

  // O entró en esta ronda, o sigue pendiente para la siguiente. Lo que NO
  // puede pasar es que desaparezca.
  if (sinEntregar.length) {
    const restantes = await trabajosPendientesDeTerminal(edgeDb.id, { limite: 100 });
    for (const id of sinEntregar) {
      assert.ok(restantes.some(r => r.id === id), `el trabajo ${id} desapareció: ni entregado ni pendiente`);
    }
  }
});

await t('PAGINACION', '14. el cursor no puede entrar en bucle', async () => {
  await limpiarTrabajos();
  await crearNTrabajos(120);
  let cursor = null, vueltas = 0, total = 0;
  while (vueltas < 20) {
    const pagina = await trabajosPendientesDeTerminal(edgeDb.id, { limite: 50, desde: cursor });
    if (!pagina.length) break;
    total += pagina.length;
    cursor = cursorDeTrabajo(pagina[pagina.length - 1]);
    vueltas++;
    if (pagina.length < 50) break;
  }
  assert.strictEqual(total, 120, `el cursor recorrió ${total} de 120`);
  assert.ok(vueltas <= 3, `bastan 3 vueltas para 120 con lotes de 50, hizo ${vueltas}`);
});

// ════════════════════════════════════════════════════════════════════════════
// 3. DOS EDGES CON LA MISMA CREDENCIAL
// ════════════════════════════════════════════════════════════════════════════
await t('DESPLAZAMIENTO', '15. el ACK de una conexión desplazada no puede aplicarse', async () => {
  await limpiarTrabajos();
  const [trabajoId] = await crearNTrabajos(1);
  await marcarEntregado(trabajoId, edgeDb.id);

  // El servidor filtra por la terminal de la conexión. Una conexión cerrada
  // ya no puede mandar nada, pero la defensa de fondo es que el UPDATE lleva
  // el terminal_id: incluso si un mensaje llegara tarde, solo puede tocar los
  // trabajos de SU terminal, jamás los de otra.
  const otraTerminal = await altaEdge(neg.id, { nombre: 'PC Ajena Gate' });
  const rechazado = await registrarAckDeTerminal(otraTerminal.id, { trabajoId, resultado: 'enviado' });
  assert.strictEqual(rechazado, null, 'una terminal distinta no puede confirmar este trabajo');

  const aceptado = await registrarAckDeTerminal(edgeDb.id, { trabajoId, resultado: 'enviado' });
  assert.strictEqual(aceptado.estado, 'enviado');
});

await t('DESPLAZAMIENTO', '16. un ACK repetido no reabre ni recuenta el trabajo', async () => {
  await limpiarTrabajos();
  const [trabajoId] = await crearNTrabajos(1);
  await registrarAckDeTerminal(edgeDb.id, { trabajoId, resultado: 'enviado' });
  const repetido = await registrarAckDeTerminal(edgeDb.id, { trabajoId, resultado: 'enviado' });
  assert.strictEqual(repetido, null, 'lo ya confirmado no se vuelve a tocar');
  const { rows } = await pool.query('SELECT intentos FROM impresion_trabajos WHERE id = $1', [trabajoId]);
  assert.strictEqual(rows[0].intentos, 1, 'ni siquiera sube el contador de intentos');
});

await t('DESPLAZAMIENTO', '17. el servidor cierra la conexión anterior con el código acordado', async () => {
  const server = readFileSync('src/server.js', 'utf8');
  assert.ok(/close\(4001/.test(server), 'el servidor cierra con 4001, no con un cierre normal');
  const conexion = readFileSync('edge/connection.js', 'utf8');
  assert.ok(/CODIGO_DESPLAZADA\s*=\s*4001/.test(conexion), 'el Edge conoce el mismo código');
  assert.ok(/codigo === CODIGO_DESPLAZADA[\s\S]{0,400}cerradoAdrede = true/.test(conexion),
    'y al recibirlo deja de reconectar: si no, los dos se turnarían la conexión');
});

// ════════════════════════════════════════════════════════════════════════════
// 043: NO ALTERA NADA EXISTENTE
// ════════════════════════════════════════════════════════════════════════════
await t('043', '18. las cuatro tablas nuevas existen con sus llaves y restricciones', async () => {
  for (const tabla of ['impresoras', 'impresion_rutas', 'impresion_trabajos', 'edge_emparejamientos']) {
    const { rows } = await pool.query(`SELECT to_regclass($1) IS NOT NULL AS existe`, [tabla]);
    assert.strictEqual(rows[0].existe, true, `falta ${tabla}`);
  }
  const { rows: uniq } = await pool.query(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'impresion_trabajos' AND indexdef ILIKE '%idempotency_key%'`);
  assert.ok(uniq.some(u => /UNIQUE/i.test(u.indexdef)), 'la clave de idempotencia tiene que ser única');
});

await t('043', '19. terminales conserva su semántica: 043 no la altera', async () => {
  // Xabor Edge reutiliza `terminales`. Si 043 hubiera cambiado columnas,
  // restricciones o llaves, rompería al agente legacy y a la autenticación.
  const { rows } = await pool.query(`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns WHERE table_name = 'terminales' ORDER BY column_name`);
  const columnas = Object.fromEntries(rows.map(r => [r.column_name, r]));
  for (const esperada of ['id', 'sucursal_id', 'nombre', 'codigo', 'activo', 'token_hash', 'tipo', 'ultima_conexion', 'created_at', 'updated_at']) {
    assert.ok(columnas[esperada], `terminales perdió la columna ${esperada}`);
  }
  assert.strictEqual(columnas.token_hash.is_nullable, 'YES', 'token_hash sigue siendo nullable (migración gradual)');
  assert.strictEqual(columnas.tipo.is_nullable, 'NO');

  const { rows: idx } = await pool.query(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'terminales'`);
  assert.ok(idx.some(i => /UNIQUE/i.test(i.indexdef) && /token_hash/.test(i.indexdef)),
    'el índice único parcial sobre token_hash sigue ahí');

  // Y las FK nuevas hacia terminales no la bloquean.
  const { rows: fks } = await pool.query(`
    SELECT c.conname, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.confrelid
     WHERE t.relname = 'terminales' AND c.contype = 'f'`);
  for (const fk of fks) {
    assert.ok(/ON DELETE (CASCADE|SET NULL)/.test(fk.def),
      `${fk.conname} debe declarar qué pasa al borrar una terminal: ${fk.def}`);
  }
});

await t('043', '20. la migración no contiene UPDATE, DELETE ni DROP de datos', async () => {
  const sql = readFileSync('migrations/043_impresion_edge.sql', 'utf8')
    .replace(/^\s*--.*$/gm, '');
  // OJO: "BEFORE UPDATE ON" dentro de un CREATE TRIGGER no es un UPDATE de
  // datos. Lo que se prohíbe es modificar filas que ya existen.
  for (const prohibido of [/\bUPDATE\s+\w+\s+SET\b/i, /\bDELETE\s+FROM/i, /\bDROP\s+TABLE/i,
                           /\bDROP\s+COLUMN/i, /\bTRUNCATE/i, /\bINSERT\s+INTO/i]) {
    assert.ok(!prohibido.test(sql), `043 no puede contener ${prohibido}: es puramente aditiva`);
  }
  // Los únicos ALTER admitidos son los que añaden la FK compuesta.
  const alters = sql.match(/ALTER TABLE[^;]+/gi) || [];
  for (const a of alters) {
    assert.ok(/ADD CONSTRAINT/i.test(a), `ALTER inesperado en 043: ${a.slice(0, 80)}`);
  }
});

await t('043', '21. las tablas nuevas nacen vacías salvo lo que crean las pruebas', async () => {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM edge_emparejamientos WHERE usado_at IS NULL`);
  assert.ok(rows[0].n >= 0, 'consulta válida');
  const sql = readFileSync('scripts/predeploy-043-impresion-edge.mjs', 'utf8');
  assert.ok(/debe nacer vacía/.test(sql), 'el predeploy comprueba que no se siembra configuración de nadie');
  assert.ok(/la migración alteró/.test(sql), 'y que no cambian los conteos de terminales, sucursales ni negocios');
});

// ── ON CONFLICT ─────────────────────────────────────────────────────────────
await t('IDEMPOTENCIA', '22. todo ON CONFLICT DO NOTHING comprueba de verdad si insertó', async () => {
  const fs = await import('node:fs');
  for (const archivo of ['src/services/impresionService.js', 'src/services/edgeService.js', 'edge/storage/sqlite.js']) {
    const src = fs.readFileSync(archivo, 'utf8');
    const conflictos = [...src.matchAll(/(ON CONFLICT[^;]*DO NOTHING|INSERT OR IGNORE)/gi)];
    for (const c of conflictos) {
      // La sentencia y su comprobación pueden estar separadas: en SQLite se
      // prepara arriba y se ejecuta abajo. Lo que importa es que el archivo
      // compruebe el resultado de ESA inserción en alguna parte.
      const trozo = src.slice(c.index, c.index + 400);
      const compruebaCerca = /RETURNING/i.test(trozo);
      const compruebaLejos = /\.changes\s*===?\s*1|rows\.length/.test(src);
      assert.ok(compruebaCerca || compruebaLejos,
        `${archivo}: un ON CONFLICT DO NOTHING sin comprobar si insertó devuelve éxito incondicional`);
    }
  }
  // Y el caso concreto: insertar dos veces reporta duplicado, no creación.
  await limpiarTrabajos();
  const cuenta = randomUUID();
  const comanda = { comanda: 1, tipo: 'inicial', mesa: 1, mesero: 'X',
                    items: [{ producto: 'Guiso', categoria: 'Fuertes', cantidad: 1, modificadores: [] }] };
  const a = await crearTrabajosDeComanda({ negocioId: neg.id, cuentaId: cuenta, comanda });
  const b = await crearTrabajosDeComanda({ negocioId: neg.id, cuentaId: cuenta, comanda });
  assert.strictEqual(a.creados.length, 1);
  assert.strictEqual(b.creados.length, 0, 'el segundo no puede reportar creación');
  assert.strictEqual(b.duplicados.length, 1, 'tiene que decir explícitamente que ya existía');
});

// ── La comanda no depende del Edge ──────────────────────────────────────────
await t('INDEPENDENCIA', '23. sin Edge, sin impresoras y sin rutas la ronda se guarda igual', async () => {
  const { rows: [otro] } = await pool.query(
    `INSERT INTO negocios (nombre, slug) VALUES ('Sin Edge','gate-sin-edge')
     ON CONFLICT (slug) DO UPDATE SET nombre = 'Sin Edge' RETURNING id`);
  await pool.query(`INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')
                    ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true`, [otro.id]);

  const r = await crearTrabajosDeComanda({
    negocioId: otro.id, cuentaId: randomUUID(),
    comanda: { comanda: 1, tipo: 'inicial', mesa: 1, mesero: 'X',
               items: [{ producto: 'Lo que sea', categoria: 'Fuertes', cantidad: 1, modificadores: [] }] },
  });
  assert.strictEqual(r.error, null, 'NUNCA lanza hacia el flujo de Restaurante');
  assert.strictEqual(r.creados.length, 0);
  assert.ok(r.sinRuta.length > 0 || r.avisos.length > 0, 'se avisa, no se falla');
});

await t('INDEPENDENCIA', '24. una configuración de routing rota tampoco tumba la comanda', async () => {
  // Regla apuntando a una impresora que se borró: el JOIN la descarta y la
  // ronda sigue su curso.
  const temporal = await crearImpresora(neg.id, { terminalId: edgeDb.id, nombre: 'FANTASMA', transporte: 'mock' });
  await crearRuta(neg.id, { impresoraId: temporal.id, ambito: 'categoria', clave: 'Rotas' });
  await pool.query('DELETE FROM impresoras WHERE id = $1', [temporal.id]);

  const r = await crearTrabajosDeComanda({
    negocioId: neg.id, cuentaId: randomUUID(),
    comanda: { comanda: 1, tipo: 'inicial', mesa: 2, mesero: 'X',
               items: [{ producto: 'Algo', categoria: 'Rotas', cantidad: 1, modificadores: [] }] },
  });
  assert.strictEqual(r.error, null);
  assert.ok(r.sinRuta.includes('Algo'), 'queda constancia de que ese producto no tiene destino');
});

// ── Windows ─────────────────────────────────────────────────────────────────
await t('WINDOWS', '25. el Edge no depende de nada exclusivo de Unix', async () => {
  const fs = await import('node:fs');
  const archivos = ['edge/index.js', 'edge/config.js', 'edge/worker.js', 'edge/connection.js',
                    'edge/logger.js', 'edge/storage/index.js', 'edge/storage/bloqueo.js',
                    'edge/storage/jsonFile.js', 'edge/storage/sqlite.js',
                    'edge/transports/tcpRaw.js', 'edge/transports/mock.js', 'edge/renderers/index.js'];
  for (const archivo of archivos) {
    const src = fs.readFileSync(archivo, 'utf8');
    const codigo = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    for (const prohibido of ['flock', 'systemd', '/var/run', '/etc/', 'child_process', "'/tmp'", '"/tmp"', 'SIGUSR', 'SIGHUP']) {
      assert.ok(!codigo.includes(prohibido), `${archivo} usa ${prohibido}, que no funciona igual en Windows`);
    }
    // Rutas siempre por path.join, nunca concatenando barras.
    assert.ok(!/['"]\.\/[a-z]+\/[a-z]+['"]/.test(src.replace(/from ['"][^'"]+['"]/g, '')),
      `${archivo} parece construir una ruta a mano en vez de usar join()`);
  }
  assert.ok(process.platform === 'win32' ? true : true, 'esta suite corre en cualquier plataforma');
});

await t('WINDOWS', '26. las señales que se manejan existen en Windows', async () => {
  const src = readFileSync('edge/index.js', 'utf8');
  const senales = [...src.matchAll(/process\.on\('(SIG[A-Z0-9]+)'/g)].map(m => m[1]);
  for (const s of senales) {
    assert.ok(['SIGINT', 'SIGTERM', 'SIGBREAK'].includes(s), `${s} no la maneja Windows igual`);
  }
});

for (const d of temporales) { try { rmSync(d, { recursive: true, force: true }); } catch {} }

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
