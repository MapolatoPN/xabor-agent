// Xabor Edge de punta a punta, con todas las piezas reales.
//
// Servidor HTTP+WebSocket real, Postgres real, dos Edges reales conectados a
// la vez y cuatro impresoras TCP simuladas. Es el ensayo de lo que va a pasar
// en Obispado, salvo el papel.
//
// Lo que se demuestra aquí y en ningún otro sitio: que la cadena completa
// -- ronda → routing → trabajo persistente → WebSocket → cola local →
// socket TCP → ACK → estado en la nube -- no pierde ni duplica una comanda,
// ni siquiera cuando se cae la conexión, se apaga una impresora o se mata el
// proceso del Edge.
import assert from 'assert';
import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { arrancarServidor } from './lib-servidor.mjs';
import { crearImpresoraSimulada } from './simulador-impresora.mjs';
import { crearEdge } from '../edge/index.js';
import { cargarConfig } from '../edge/config.js';
import { loggerSilencioso } from '../edge/logger.js';
import { crearTransportes } from '../edge/transports/index.js';

const PUERTO = process.env.TEST_PORT || '4972';
const { pool } = await import('../src/services/database.js');
const { crearImpresora, crearRuta, crearTrabajosDeComanda, crearTrabajosDeDocumento, crearTrabajoDePrueba } =
  await import('../src/services/impresionService.js');
const { crearEdge: altaEdge, generarEmparejamiento, canjearEmparejamiento } =
  await import('../src/services/edgeService.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

const temporales = [];
const dirTemporal = () => { const d = mkdtempSync(join(tmpdir(), 'xabor-e2e-')); temporales.push(d); return d; };
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

// Espera activa con tope: evita sleeps largos y hace la suite determinista.
async function hasta(condicion, { limiteMs = 8000, pasoMs = 50, que = 'la condición' } = {}) {
  const fin = Date.now() + limiteMs;
  while (Date.now() < fin) {
    if (await condicion()) return true;
    await esperar(pasoMs);
  }
  throw new Error(`se agotó la espera de ${que}`);
}

async function montarNegocio(slug, nombre) {
  const { rows: [n] } = await pool.query(
    `INSERT INTO negocios (nombre, slug) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET nombre = $1 RETURNING id`, [nombre, slug]);
  const { rows: [s] } = await pool.query(
    `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')
     ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true RETURNING id`, [n.id]);
  return { negocioId: n.id, sucursalId: s.id };
}

const A = await montarNegocio('e2e-mapolato', 'Mapolato Demo E2E');
const B = await montarNegocio('e2e-vecino', 'Restaurante Vecino E2E');

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const URL_WS = `ws://localhost:${PUERTO}/ws/print-agent`;

// ─── Las cuatro impresoras de Obispado, simuladas ───────────────────────────
const SIM = {};
for (const nombre of ['TICKETS', 'CHILAQUILES', 'COCINA GENERAL', 'BEBIDAS']) {
  SIM[nombre] = crearImpresoraSimulada({ nombre });
  await SIM[nombre].encender();
}

// ─── Alta y emparejamiento del Edge de A ────────────────────────────────────
const edgeDbA = await altaEdge(A.negocioId, { nombre: 'PC Caja Obispado' });
const { codigo: codigoA } = await generarEmparejamiento(A.negocioId, edgeDbA.id);
const credA = await canjearEmparejamiento(codigoA);

const IMP = {};
for (const nombre of Object.keys(SIM)) {
  IMP[nombre] = await crearImpresora(A.negocioId, {
    terminalId: edgeDbA.id, nombre, transporte: 'tcp_raw', host: '127.0.0.1', puerto: SIM[nombre].puerto,
  });
}
await crearRuta(A.negocioId, { impresoraId: IMP['COCINA GENERAL'].id, ambito: 'categoria', clave: 'Fuertes' });
await crearRuta(A.negocioId, { impresoraId: IMP['COCINA GENERAL'].id, ambito: 'categoria', clave: 'Ensaladas' });
await crearRuta(A.negocioId, { impresoraId: IMP['BEBIDAS'].id, ambito: 'categoria', clave: 'Bebidas' });
await crearRuta(A.negocioId, { impresoraId: IMP['CHILAQUILES'].id, ambito: 'producto', clave: 'Chilaquiles' });
await crearRuta(A.negocioId, { impresoraId: IMP['TICKETS'].id, ambito: 'documento', clave: 'cuenta' });

// Y un Edge del negocio vecino, con su impresora.
const edgeDbB = await altaEdge(B.negocioId, { nombre: 'PC Vecino' });
const { codigo: codigoB } = await generarEmparejamiento(B.negocioId, edgeDbB.id);
const credB = await canjearEmparejamiento(codigoB);
const simB = crearImpresoraSimulada({ nombre: 'COCINA VECINO' });
await simB.encender();
const impB = await crearImpresora(B.negocioId, {
  terminalId: edgeDbB.id, nombre: 'COCINA VECINO', transporte: 'tcp_raw', host: '127.0.0.1', puerto: simB.puerto,
});
await crearRuta(B.negocioId, { impresoraId: impB.id, ambito: 'categoria', clave: 'Fuertes' });

function configEdge(cred, dir) {
  return {
    ...cargarConfig({ env: {} }),
    urlNube: URL_WS, terminalId: cred.terminalId, terminalToken: cred.token,
    rutaDatos: dir, almacen: 'sqlite',
    reintentoBaseMs: 30, reintentoMaximoMs: 200, maxIntentos: 4,
    intervaloColaMs: 40, reconexionBaseMs: 50, reconexionMaximaMs: 400,
    heartbeatMs: 2000, timeoutImpresoraMs: 1500,
  };
}

function nuevoEdge(cred, dir) {
  return crearEdge({
    config: configEdge(cred, dir), logger: loggerSilencioso,
    transportes: crearTransportes({ logger: loggerSilencioso, timeoutMs: 1500 }),
  });
}

const RONDA = (mesa, comanda = 1) => ({
  comanda, tipo: comanda === 1 ? 'inicial' : 'adicional', mesa, personas: 4, mesero: 'ANGEL DEMO',
  items: [
    { producto: 'Chilaquiles', categoria: 'Fuertes', cantidad: 1,
      modificadores: [{ grupo: 'Salsa', opcion: 'Verde' }, { grupo: 'Proteína', opcion: 'Bistec' },
                      { grupo: 'Guarnición', opcion: 'Frijoles' }, { grupo: 'Guarnición', opcion: 'Papas' }],
      notas: 'Sin cebolla' },
    { producto: 'Ensalada', categoria: 'Ensaladas', cantidad: 1, modificadores: [] },
    { producto: 'Coca-Cola', categoria: 'Bebidas', cantidad: 2, modificadores: [] },
  ],
});

const estadoDe = async (id) => (await pool.query('SELECT estado, intentos FROM impresion_trabajos WHERE id = $1', [id])).rows[0];

let edgeA;

// ─── Autenticación ──────────────────────────────────────────────────────────
await t('AUTH', '1. el Edge se conecta con su credencial y la nube lo reconoce', async () => {
  edgeA = nuevoEdge(credA, dirTemporal());
  await edgeA.iniciar();
  await hasta(() => edgeA.conexion.conectado, { que: 'la conexión del Edge' });
  assert.strictEqual(edgeA.conexion.identidad.negocioId, A.negocioId,
    'el negocio lo resuelve el servidor desde la terminal, el Edge nunca lo declara');
  assert.strictEqual(edgeA.conexion.identidad.terminalId, edgeDbA.id);
});

await t('AUTH', '2. un token equivocado no autentica', async () => {
  const malo = crearEdge({
    config: configEdge({ terminalId: edgeDbA.id, token: 'a'.repeat(64) }, dirTemporal()),
    logger: loggerSilencioso, transportes: crearTransportes({ logger: loggerSilencioso }),
  });
  await malo.iniciar();
  await esperar(600);
  assert.strictEqual(malo.conexion.conectado, false, 'sin credencial válida no hay sesión');
  await malo.detener();
});

await t('AUTH', '3. una credencial revocada deja de servir', async () => {
  const tmp = await altaEdge(A.negocioId, { nombre: 'PC Revocable' });
  const { codigo } = await generarEmparejamiento(A.negocioId, tmp.id);
  const cred = await canjearEmparejamiento(codigo);
  await pool.query('UPDATE terminales SET token_hash = NULL WHERE id = $1', [tmp.id]);

  const revocado = nuevoEdge(cred, dirTemporal());
  await revocado.iniciar();
  await esperar(600);
  assert.strictEqual(revocado.conexion.conectado, false);
  await revocado.detener();
});

// ─── La ronda demo, completa ────────────────────────────────────────────────
let trabajosDemo;

await t('E2E', '4. la ronda demo llega a las tres impresoras correctas y a ninguna más', async () => {
  for (const s of Object.values(SIM)) s.limpiar();
  const cuenta = randomUUID();
  const r = await crearTrabajosDeComanda({ negocioId: A.negocioId, cuentaId: cuenta, comanda: RONDA(4) });
  trabajosDemo = r.creados;
  assert.strictEqual(r.creados.length, 3);

  // El Edge ya está conectado: al reconectar recibe los pendientes. Se fuerza
  // una reconexión rápida en vez de esperar al siguiente ciclo natural.
  edgeA.conexion.cerrar();
  edgeA.conexion.iniciar();
  await hasta(async () => SIM['CHILAQUILES'].recibidos.length >= 1 && SIM['COCINA GENERAL'].recibidos.length >= 1 && SIM['BEBIDAS'].recibidos.length >= 1,
    { que: 'que las tres impresoras reciban su comanda', limiteMs: 12000 });

  assert.strictEqual(SIM['CHILAQUILES'].recibidos.length, 1);
  assert.strictEqual(SIM['COCINA GENERAL'].recibidos.length, 1);
  assert.strictEqual(SIM['BEBIDAS'].recibidos.length, 1);
  assert.strictEqual(SIM['TICKETS'].recibidos.length, 0, 'la cuenta no sale al mandar la comanda');
});

await t('E2E', '5. el papel de cada impresora lleva exactamente lo suyo', async () => {
  const chila = SIM['CHILAQUILES'].recibidos[0].texto;
  assert.ok(chila.includes('CHILAQUILES'));
  assert.ok(chila.includes('Salsa: Verde') && chila.includes('Proteína: Bistec'));
  assert.ok(chila.includes('NOTA: Sin cebolla'));
  assert.ok(!chila.includes('COCA'), 'la estación de chilaquiles no ve las bebidas');

  const general = SIM['COCINA GENERAL'].recibidos[0].texto;
  assert.ok(general.includes('CHILAQUILES') && general.includes('ENSALADA'));

  const bebidas = SIM['BEBIDAS'].recibidos[0].texto;
  assert.ok(bebidas.includes('COCA-COLA') && bebidas.includes('MESA 4'));
  assert.ok(!bebidas.includes('ENSALADA'));
});

await t('E2E', '6. la nube recibe el ACK y marca los tres trabajos como impresos', async () => {
  await hasta(async () => {
    const estados = await Promise.all(trabajosDemo.map(x => estadoDe(x.id)));
    return estados.every(e => e.estado === 'impreso');
  }, { que: 'los ACK de los tres trabajos', limiteMs: 10000 });

  for (const x of trabajosDemo) {
    const e = await estadoDe(x.id);
    assert.strictEqual(e.estado, 'impreso');
    assert.strictEqual(e.intentos, 1, 'una impresora en línea no necesita reintentos');
  }
});

await t('E2E', '7. la cuenta sale por TICKETS y por ninguna de cocina', async () => {
  const antes = Object.fromEntries(Object.entries(SIM).map(([n, s]) => [n, s.recibidos.length]));
  const r = await crearTrabajosDeDocumento({
    negocioId: A.negocioId, documento: 'cuenta', origenTipo: 'restaurante_cuenta', origenId: `XAB-${Date.now()}`,
    payload: { negocio: 'Mapolato Demo', mesa: 4, total: 460, subtotal: 460, items: [{ producto: 'Chilaquiles', cantidad: 1, precioUnitario: 195, modificadores: [] }] },
  });
  assert.strictEqual(r.creados.length, 1);

  edgeA.conexion.cerrar(); edgeA.conexion.iniciar();
  await hasta(() => SIM['TICKETS'].recibidos.length === antes['TICKETS'] + 1, { que: 'el ticket de la cuenta' });

  for (const nombre of ['CHILAQUILES', 'COCINA GENERAL', 'BEBIDAS']) {
    assert.strictEqual(SIM[nombre].recibidos.length, antes[nombre], `${nombre} no debe recibir la cuenta`);
  }
  assert.ok(SIM['TICKETS'].recibidos.at(-1).texto.includes('$195.00'), 'la cuenta sí lleva importes');
});

await t('E2E', '8. la prueba de impresora sale por la impresora elegida', async () => {
  const antes = SIM['BEBIDAS'].recibidos.length;
  await crearTrabajoDePrueba(A.negocioId, IMP['BEBIDAS'].id);
  edgeA.conexion.cerrar(); edgeA.conexion.iniciar();
  await hasta(() => SIM['BEBIDAS'].recibidos.length === antes + 1, { que: 'la prueba de impresora' });
  assert.ok(SIM['BEBIDAS'].recibidos.at(-1).texto.includes('PRUEBA DE IMPRESORA'));
});

// ─── Aislamiento entre negocios ─────────────────────────────────────────────
await t('AISLAMIENTO', '9. el Edge del vecino no recibe NADA del otro restaurante', async () => {
  simB.limpiar();
  const edgeB = nuevoEdge(credB, dirTemporal());
  await edgeB.iniciar();
  await hasta(() => edgeB.conexion.conectado, { que: 'la conexión del Edge vecino' });
  try {
    const antes = Object.fromEntries(Object.entries(SIM).map(([n, s]) => [n, s.recibidos.length]));

    // Una ronda de CADA negocio, a la vez.
    await crearTrabajosDeComanda({ negocioId: A.negocioId, cuentaId: randomUUID(), comanda: RONDA(11) });
    await crearTrabajosDeComanda({
      negocioId: B.negocioId, cuentaId: randomUUID(),
      comanda: { comanda: 1, tipo: 'inicial', mesa: 1, mesero: 'VECINO', items: [{ producto: 'Pasta', categoria: 'Fuertes', cantidad: 1, modificadores: [] }] },
    });

    for (const e of [edgeA, edgeB]) { e.conexion.cerrar(); e.conexion.iniciar(); }
    await hasta(() => simB.recibidos.length >= 1 && SIM['BEBIDAS'].recibidos.length > antes['BEBIDAS'],
      { que: 'que ambos negocios impriman lo suyo', limiteMs: 12000 });

    assert.ok(simB.recibidos.every(r => r.texto.includes('PASTA')), 'el vecino solo imprime lo suyo');
    assert.ok(!simB.recibidos.some(r => r.texto.includes('CHILAQUILES')), 'jamás una comanda del otro restaurante');

    const trabajosB = edgeB.almacen.todos();
    assert.ok(trabajosB.every(x => x.impresoraNombre === 'COCINA VECINO'),
      'la cola local del vecino no contiene ni un trabajo ajeno');
  } finally { await edgeB.detener(); }
});

await t('AISLAMIENTO', '10. un Edge no puede confirmar el trabajo de otro negocio por WebSocket', async () => {
  const r = await crearTrabajosDeComanda({
    negocioId: B.negocioId, cuentaId: randomUUID(),
    comanda: { comanda: 1, tipo: 'inicial', mesa: 2, mesero: 'V', items: [{ producto: 'Pasta', categoria: 'Fuertes', cantidad: 1 }] },
  });
  const ajeno = r.creados[0];

  // El Edge de A manda un ACK sobre un trabajo de B, sabiendo su uuid.
  edgeA.conexion.confirmar({ trabajoId: ajeno.id, resultado: 'impreso' });
  await esperar(500);

  const e = await estadoDe(ajeno.id);
  assert.notStrictEqual(e.estado, 'impreso',
    'el servidor filtra por la terminal de la conexión: el ACK ajeno no puede tener efecto');
});

// ─── Caos ───────────────────────────────────────────────────────────────────
await t('CAOS', '11. impresora apagada: las demás imprimen y la caída se recupera sola', async () => {
  for (const s of Object.values(SIM)) s.limpiar();
  await SIM['CHILAQUILES'].apagar();

  const r = await crearTrabajosDeComanda({ negocioId: A.negocioId, cuentaId: randomUUID(), comanda: RONDA(12) });
  const chila = r.creados.find(x => x.impresora_nombre === 'CHILAQUILES');

  edgeA.conexion.cerrar(); edgeA.conexion.iniciar();
  await hasta(() => SIM['COCINA GENERAL'].recibidos.length >= 1 && SIM['BEBIDAS'].recibidos.length >= 1,
    { que: 'que las impresoras vivas impriman', limiteMs: 12000 });

  const local = edgeA.almacen.obtener(chila.id);
  assert.ok(['fallido', 'procesando', 'pendiente'].includes(local.estado),
    `la caída debe quedar en cola y quedó "${local?.estado}"`);
  assert.strictEqual(SIM['CHILAQUILES'].recibidos.length, 0);

  // Alguien la enciende.
  await SIM['CHILAQUILES'].reencender();
  await hasta(() => SIM['CHILAQUILES'].recibidos.length === 1, { que: 'la impresión tras recuperarse', limiteMs: 12000 });
  assert.strictEqual(SIM['CHILAQUILES'].recibidos.length, 1, 'una sola vez, sin duplicar');
  await hasta(async () => (await estadoDe(chila.id)).estado === 'impreso', { que: 'el ACK tardío' });
});

await t('CAOS', '12. la nube se cae y vuelve: el Edge reconecta y nada se pierde', async () => {
  for (const s of Object.values(SIM)) s.limpiar();

  // Se corta la conexión desde el lado del Edge (equivale a perder internet).
  edgeA.conexion.cerrar();
  const r = await crearTrabajosDeComanda({ negocioId: A.negocioId, cuentaId: randomUUID(), comanda: RONDA(13) });
  assert.strictEqual(r.creados.length, 3, 'la nube crea los trabajos aunque no haya nadie escuchando');
  await esperar(300);
  assert.strictEqual(SIM['BEBIDAS'].recibidos.length, 0, 'sin Edge no sale papel, pero tampoco se pierde nada');

  edgeA.conexion.iniciar();
  await hasta(() => SIM['BEBIDAS'].recibidos.length >= 1 && SIM['CHILAQUILES'].recibidos.length >= 1,
    { que: 'la entrega tras reconectar', limiteMs: 12000 });
  await hasta(async () => (await Promise.all(r.creados.map(x => estadoDe(x.id)))).every(e => e.estado === 'impreso'),
    { que: 'los ACK tras reconectar', limiteMs: 12000 });
});

await t('CAOS', '13. matar el Edge a media cola: al reiniciar termina el trabajo, sin duplicar', async () => {
  for (const s of Object.values(SIM)) s.limpiar();
  const dir = dirTemporal();

  // El Edge de siempre se aparta: aquí se prueba un proceso que muere y
  // revive. Dejarlo conectado sería probar otra cosa (dos Edges a la vez),
  // que tiene su propio caso más abajo.
  edgeA.conexion.cerrar();

  const efimero = nuevoEdge(credA, dir);
  await efimero.iniciar();
  await hasta(() => efimero.conexion.conectado, { que: 'la conexión del Edge efímero' });

  // Se apagan las cuatro para que los trabajos queden en cola sin poder salir.
  for (const s of Object.values(SIM)) await s.apagar();
  const r = await crearTrabajosDeComanda({ negocioId: A.negocioId, cuentaId: randomUUID(), comanda: RONDA(14) });
  efimero.conexion.cerrar(); efimero.conexion.iniciar();
  await hasta(() => efimero.almacen.todos().length >= 3, { que: 'que el Edge persista los tres trabajos' });

  // Muerte brusca: se cierra sin vaciar la cola.
  await efimero.detener();

  for (const s of Object.values(SIM)) await s.reencender();

  // Reinicio con el MISMO directorio de datos.
  const revivido = nuevoEdge(credA, dir);
  await revivido.iniciar();
  try {
    await hasta(() => SIM['CHILAQUILES'].recibidos.length >= 1 && SIM['COCINA GENERAL'].recibidos.length >= 1 && SIM['BEBIDAS'].recibidos.length >= 1,
      { que: 'que el Edge reiniciado termine lo que quedó', limiteMs: 15000 });

    assert.strictEqual(SIM['CHILAQUILES'].recibidos.length, 1, 'exactamente una, sin duplicar por el reinicio');
    assert.strictEqual(SIM['COCINA GENERAL'].recibidos.length, 1);
    assert.strictEqual(SIM['BEBIDAS'].recibidos.length, 1);
    await hasta(async () => (await Promise.all(r.creados.map(x => estadoDe(x.id)))).every(e => e.estado === 'impreso'),
      { que: 'los ACK tras el reinicio', limiteMs: 12000 });
  } finally {
    await revivido.detener();
    edgeA.conexion.iniciar();
    await hasta(() => edgeA.conexion.conectado, { que: 'la vuelta del Edge principal' });
  }
});

await t('CAOS', '13b. dos procesos Edge con la misma credencial NO imprimen por duplicado', async () => {
  for (const s of Object.values(SIM)) s.limpiar();

  // El escenario real: alguien deja abierto el agente viejo, o el servicio de
  // Windows arranca dos veces. Si los dos recibieran los trabajos, cada
  // comanda saldría dos veces en cocina.
  const intruso = nuevoEdge(credA, dirTemporal());
  await intruso.iniciar();
  await hasta(() => intruso.conexion.conectado, { que: 'la conexión del segundo Edge' });
  // El servidor cierra la conexión anterior al autenticarse la nueva.
  await hasta(() => !edgeA.conexion.conectado, { que: 'que el primero quede desplazado', limiteMs: 4000 });

  try {
    // Y el desplazado NO vuelve a intentarlo: si reconectara, los dos se
    // turnarían la conexión, cada uno recibiría trabajos en su propia cola y
    // la comanda saldría dos veces igual.
    await esperar(1500);
    assert.strictEqual(edgeA.conexion.conectado, false,
      'el Edge desplazado debe rendirse, no pelearse por la conexión');
    assert.strictEqual(intruso.conexion.conectado, true, 'y el nuevo se queda con ella');

    const r = await crearTrabajosDeComanda({ negocioId: A.negocioId, cuentaId: randomUUID(), comanda: RONDA(17) });
    intruso.conexion.cerrar(); intruso.conexion.iniciar();
    await hasta(async () => (await Promise.all(r.creados.map(x => estadoDe(x.id)))).every(e => e.estado === 'impreso'),
      { que: 'la impresión con dos Edges dados de alta', limiteMs: 15000 });
    await esperar(800);

    assert.strictEqual(SIM['CHILAQUILES'].recibidos.length, 1, 'una sola comanda aunque haya dos procesos Edge');
    assert.strictEqual(SIM['COCINA GENERAL'].recibidos.length, 1);
    assert.strictEqual(SIM['BEBIDAS'].recibidos.length, 1);
  } finally {
    await intruso.detener();
    edgeA.conexion.iniciar();
    await hasta(() => edgeA.conexion.conectado, { que: 'la vuelta del Edge principal' });
  }
});

await t('CAOS', '14. entrega duplicada desde la nube: una sola impresión', async () => {
  for (const s of Object.values(SIM)) s.limpiar();
  const r = await crearTrabajosDeComanda({ negocioId: A.negocioId, cuentaId: randomUUID(), comanda: RONDA(15) });

  // Tres reconexiones seguidas: el servidor reenvía los pendientes cada vez.
  for (let i = 0; i < 3; i++) { edgeA.conexion.cerrar(); edgeA.conexion.iniciar(); await esperar(200); }
  await hasta(async () => (await Promise.all(r.creados.map(x => estadoDe(x.id)))).every(e => e.estado === 'impreso'),
    { que: 'los tres impresos', limiteMs: 15000 });
  await esperar(500);   // margen por si llegara una entrega tardía

  assert.strictEqual(SIM['CHILAQUILES'].recibidos.length, 1, 'tres reenvíos, un solo papel');
  assert.strictEqual(SIM['COCINA GENERAL'].recibidos.length, 1);
  assert.strictEqual(SIM['BEBIDAS'].recibidos.length, 1);
});

await t('CAOS', '15. una impresora desactivada no rompe la ronda del resto', async () => {
  for (const s of Object.values(SIM)) s.limpiar();
  await pool.query('UPDATE impresoras SET activa = false WHERE id = $1', [IMP['CHILAQUILES'].id]);
  try {
    const r = await crearTrabajosDeComanda({ negocioId: A.negocioId, cuentaId: randomUUID(), comanda: RONDA(16) });
    assert.ok(r.creados.length >= 1, 'los demás destinos siguen produciendo trabajo');
    assert.ok(!r.creados.some(x => x.impresora_nombre === 'CHILAQUILES'),
      'una impresora desactivada deja de recibir trabajos nuevos');
    edgeA.conexion.cerrar(); edgeA.conexion.iniciar();
    await hasta(() => SIM['COCINA GENERAL'].recibidos.length >= 1, { que: 'la impresión del resto', limiteMs: 12000 });
  } finally {
    await pool.query('UPDATE impresoras SET activa = true WHERE id = $1', [IMP['CHILAQUILES'].id]);
  }
});

// ─── Concurrencia ───────────────────────────────────────────────────────────
await t('CONCURRENCIA', '16. 20 rondas simultáneas: 60 trabajos exactos, 0 duplicados, 0 perdidos', async () => {
  for (const s of Object.values(SIM)) s.limpiar();
  const cuentas = Array.from({ length: 20 }, () => randomUUID());

  const resultados = await Promise.all(cuentas.map((c, i) =>
    crearTrabajosDeComanda({ negocioId: A.negocioId, cuentaId: c, comanda: RONDA(20 + i) })));

  const creados = resultados.flatMap(r => r.creados);
  assert.strictEqual(creados.length, 60, `se esperaban 60 trabajos y se crearon ${creados.length}`);

  edgeA.conexion.cerrar(); edgeA.conexion.iniciar();
  await hasta(async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM impresion_trabajos WHERE id = ANY($1::uuid[]) AND estado = 'impreso'`,
      [creados.map(c => c.id)]);
    return rows[0].n === 60;
  }, { que: 'que los 60 trabajos queden impresos', limiteMs: 40000 });

  const total = SIM['CHILAQUILES'].recibidos.length + SIM['COCINA GENERAL'].recibidos.length + SIM['BEBIDAS'].recibidos.length;
  assert.strictEqual(SIM['CHILAQUILES'].recibidos.length, 20, 'una comanda por mesa en chilaquiles');
  assert.strictEqual(SIM['COCINA GENERAL'].recibidos.length, 20);
  assert.strictEqual(SIM['BEBIDAS'].recibidos.length, 20);
  assert.strictEqual(total, 60, `60 papeles exactos, salieron ${total}`);
  assert.strictEqual(SIM['TICKETS'].recibidos.length, 0, 'ni uno se fue a la impresora equivocada');

  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM impresion_trabajos WHERE negocio_id = $1 AND estado IN ('pendiente','fallido','agotado','incierto')`,
    [A.negocioId]);
  assert.strictEqual(rows[0].n, 0, `quedaron ${rows[0].n} trabajos sin resolver`);
});

// ─── Higiene ────────────────────────────────────────────────────────────────
await t('LOGS', '17. el servidor no registra el token ni el contenido de las comandas', async () => {
  const salida = srv.obtenerSalida();
  assert.ok(!salida.includes(credA.token), 'el token del Edge JAMÁS puede aparecer en un log');
  assert.ok(!salida.includes(credB.token));
  assert.ok(!salida.includes('Sin cebolla'), 'las notas del cliente no van al log');
  assert.ok(!salida.includes('Chilaquiles') && !salida.includes('Coca-Cola'), 'ni los platillos');
  // Pero sí tiene que quedar rastro operativo: por terminal y por trabajo.
  assert.ok(/\[Edge\] (trabajo=|terminal=\S+ recupera)/.test(salida),
    'debe poder seguirse qué se entregó y a quién');
  assert.ok(/\[PrintAgent\] Terminal autenticada/.test(salida), 'y quién se conectó');
});

await t('LOGS', '18. no hay promesas sin capturar ni errores de arranque', async () => {
  const salida = srv.obtenerSalida();
  for (const patron of [/UnhandledPromiseRejection/, /TypeError/, /ReferenceError/, /SyntaxError/]) {
    assert.ok(!patron.test(salida), `el servidor registró ${patron}`);
  }
});

// ─── Cierre ─────────────────────────────────────────────────────────────────
if (edgeA) await edgeA.detener();
for (const s of Object.values(SIM)) await s.apagar();
await simB.apagar();
for (const d of temporales) { try { rmSync(d, { recursive: true, force: true }); } catch {} }

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
