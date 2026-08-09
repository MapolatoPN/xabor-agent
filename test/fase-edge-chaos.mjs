// Chaos integrado: 500 rondas, dos negocios, fallos aleatorios reproducibles.
//
// No busca "que no reviente". Busca que la CUENTA cuadre: se calcula
// matemáticamente cuántos trabajos debe producir el routing, y al final se
// compara con lo que hay en la base. Y que todo trabajo acabe en un estado
// explicable, sin huérfanos.
//
// La semilla se fija con SEED= para poder repetir un fallo exacto.
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

const SEED = Number(process.env.SEED || 20260809);
const RONDAS = Number(process.env.CHAOS_RONDAS || 500);
const PUERTO = process.env.TEST_PORT || '4974';

const { pool } = await import('../src/services/database.js');
const { crearImpresora, crearRuta, crearTrabajosDeComanda,
        registrarAckDeTerminal, registrarInstalacion } = await import('../src/services/impresionService.js');
const { crearEdge: altaEdge, generarEmparejamiento, canjearEmparejamiento } =
  await import('../src/services/edgeService.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

// Generador determinista (xorshift32). Con la misma semilla, el mismo caos.
function crearAzar(semilla) {
  let x = semilla >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0xFFFFFFFF;
  };
}
const azar = crearAzar(SEED);
const entre = (a, b) => a + Math.floor(azar() * (b - a + 1));
const elegir = (arr) => arr[Math.floor(azar() * arr.length)];

const temporales = [];
const dirTemporal = () => { const d = mkdtempSync(join(tmpdir(), 'xabor-chaos-')); temporales.push(d); return d; };
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
async function hasta(cond, { limiteMs = 20000, pasoMs = 60, que = 'la condición' } = {}) {
  const fin = Date.now() + limiteMs;
  while (Date.now() < fin) { if (await cond()) return true; await esperar(pasoMs); }
  throw new Error(`se agotó la espera de ${que}`);
}

// ─── Montaje: dos negocios, cada uno con su Edge y sus impresoras ───────────
async function montarNegocio(slug, nombre, impresoras) {
  const { rows: [n] } = await pool.query(
    `INSERT INTO negocios (nombre, slug) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET nombre = $1 RETURNING id`,
    [nombre, slug]);
  await pool.query(
    `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')
     ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true`, [n.id]);

  const edgeDb = await altaEdge(n.id, { nombre: `PC ${nombre}` });
  const { codigo } = await generarEmparejamiento(n.id, edgeDb.id);
  const cred = await canjearEmparejamiento(codigo);

  const sims = {}, imps = {};
  for (const nom of impresoras) {
    sims[nom] = crearImpresoraSimulada({ nombre: `${slug}-${nom}` });
    await sims[nom].encender();
    imps[nom] = await crearImpresora(n.id, {
      terminalId: edgeDb.id, nombre: nom, transporte: 'tcp_raw',
      host: '127.0.0.1', puerto: sims[nom].puerto,
    });
  }
  return { negocioId: n.id, edgeDb, cred, sims, imps };
}

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const URL_WS = `ws://localhost:${PUERTO}/ws/print-agent`;

const IMPRESORAS = ['TICKETS', 'CHILAQUILES', 'COCINA GENERAL', 'BEBIDAS'];
const A = await montarNegocio('chaos-a', 'Chaos A', IMPRESORAS);
const B = await montarNegocio('chaos-b', 'Chaos B', IMPRESORAS);

// Routing idéntico en ambos: es el de Mapolato.
for (const N of [A, B]) {
  await crearRuta(N.negocioId, { impresoraId: N.imps['COCINA GENERAL'].id, ambito: 'categoria', clave: 'Fuertes' });
  await crearRuta(N.negocioId, { impresoraId: N.imps['COCINA GENERAL'].id, ambito: 'categoria', clave: 'Ensaladas' });
  await crearRuta(N.negocioId, { impresoraId: N.imps['BEBIDAS'].id, ambito: 'categoria', clave: 'Bebidas' });
  await crearRuta(N.negocioId, { impresoraId: N.imps['CHILAQUILES'].id, ambito: 'producto', clave: 'Chilaquiles' });
  await crearRuta(N.negocioId, { impresoraId: N.imps['TICKETS'].id, ambito: 'documento', clave: 'cuenta' });
}

// ─── Catálogo y destinos ESPERADOS, calculados a mano ───────────────────────
//
// Esta tabla es la fuente de verdad del test: si el motor de routing cambia
// sin querer, la cuenta no cuadra y el chaos falla, en vez de pasar por no
// haber lanzado excepciones.
const CATALOGO = [
  { producto: 'Chilaquiles', categoria: 'Fuertes',   destinos: ['CHILAQUILES', 'COCINA GENERAL'] },
  { producto: 'Enchiladas',  categoria: 'Fuertes',   destinos: ['COCINA GENERAL'] },
  { producto: 'Ensalada',    categoria: 'Ensaladas', destinos: ['COCINA GENERAL'] },
  { producto: 'Coca-Cola',   categoria: 'Bebidas',   destinos: ['BEBIDAS'] },
  { producto: 'Café',        categoria: 'Bebidas',   destinos: ['BEBIDAS'] },
  { producto: 'Flan',        categoria: 'Postres',   destinos: [] },   // sin ruta a propósito
];

function generarRonda(mesa, numero) {
  const cuantos = entre(1, 4);
  const items = [];
  for (let i = 0; i < cuantos; i++) {
    const base = elegir(CATALOGO);
    items.push({
      producto: base.producto, categoria: base.categoria, cantidad: entre(1, 3),
      modificadores: azar() < 0.4
        ? [{ grupo: 'Salsa', opcion: elegir(['Verde', 'Roja']) }, { grupo: 'Proteína', opcion: 'Bistec' }]
        : [],
      notas: azar() < 0.25 ? 'Sin cebolla' : null,
    });
  }
  return { comanda: numero, tipo: numero === 1 ? 'inicial' : 'adicional',
           mesa, personas: entre(1, 6), mesero: 'CHAOS', items };
}

// Cuántos trabajos DEBE producir una ronda: un destino distinto = un trabajo.
function trabajosEsperadosDe(ronda) {
  const destinos = new Set();
  for (const item of ronda.items) {
    const base = CATALOGO.find(c => c.producto === item.producto);
    for (const d of base.destinos) destinos.add(d);
  }
  return destinos.size;
}

function configEdge(cred, dir) {
  return {
    ...cargarConfig({ env: {} }),
    urlNube: URL_WS, terminalId: cred.terminalId, terminalToken: cred.token,
    rutaDatos: dir, almacen: 'sqlite',
    reintentoBaseMs: 20, reintentoMaximoMs: 150, maxIntentos: 6,
    intervaloColaMs: 30, reconexionBaseMs: 40, reconexionMaximaMs: 300,
    heartbeatMs: 3000, timeoutImpresoraMs: 900,
  };
}
const nuevoEdge = (cred, dir) => crearEdge({
  config: configEdge(cred, dir), logger: loggerSilencioso,
  transportes: crearTransportes({ logger: loggerSilencioso, timeoutMs: 900, graciaMs: 150 }),
});

// ─── EL CAOS ────────────────────────────────────────────────────────────────
const metricas = {
  rondas: 0, esperados: 0, creados: 0, duplicadosCreacion: 0,
  crashes: 0, desconexiones: 0, fallosImpresora: 0,
  crossTenantIntentos: 0, crossTenantExitosos: 0,
  entregasDuplicadas: 0,
};
const dirA = dirTemporal();
let edgeA = nuevoEdge(A.cred, dirA);
let edgeB = nuevoEdge(B.cred, dirTemporal());
const idsCreados = [];
const sinCapturar = [];
process.on('unhandledRejection', (e) => sinCapturar.push(String(e?.message || e)));

await t('CHAOS', `1. ${RONDAS} rondas con fallos aleatorios (seed ${SEED})`, async () => {
  await edgeA.iniciar();
  await edgeB.iniciar();
  await hasta(() => edgeA.conexion.conectado && edgeB.conexion.conectado, { que: 'los dos Edges conectados' });

  const mesas = new Map();

  for (let i = 0; i < RONDAS; i++) {
    const N = azar() < 0.7 ? A : B;
    const mesa = entre(1, 40);
    const clave = `${N.negocioId}:${mesa}`;
    const numero = (mesas.get(clave) || 0) + 1;
    mesas.set(clave, numero);

    const ronda = generarRonda(mesa, numero);
    const esperados = trabajosEsperadosDe(ronda);
    metricas.rondas++;
    metricas.esperados += esperados;

    const cuentaId = randomUUID();
    const r = await crearTrabajosDeComanda({ negocioId: N.negocioId, cuentaId, comanda: ronda });
    assert.strictEqual(r.error, null, 'crear trabajos NUNCA puede lanzar hacia la comanda');
    assert.strictEqual(r.creados.length, esperados,
      `ronda ${i}: se esperaban ${esperados} trabajos y se crearon ${r.creados.length}`);
    metricas.creados += r.creados.length;
    idsCreados.push(...r.creados.map(x => x.id));

    // ── Entrega duplicada desde la nube (10%)
    if (azar() < 0.10) {
      const rep = await crearTrabajosDeComanda({ negocioId: N.negocioId, cuentaId, comanda: ronda });
      metricas.duplicadosCreacion += rep.duplicados.length;
      assert.strictEqual(rep.creados.length, 0, 'reenviar la misma ronda no puede crear trabajos nuevos');
      metricas.entregasDuplicadas++;
    }

    // ── Fallos de impresora (20%): se apaga una y se vuelve a encender luego
    if (azar() < 0.20) {
      const nombre = elegir(['CHILAQUILES', 'COCINA GENERAL', 'BEBIDAS']);
      const sim = N.sims[nombre];
      const modo = elegir(['apagar', 'cortar', 'timeout', 'silenciosa']);
      metricas.fallosImpresora++;
      if (modo === 'apagar') { await sim.apagar(); setTimeout(() => sim.reencender().catch(() => {}), entre(80, 300)); }
      else { sim.modo(modo); setTimeout(() => sim.modo('online'), entre(80, 300)); }
    }

    // ── Desconexión del Edge (12%)
    if (azar() < 0.12) {
      metricas.desconexiones++;
      const E = N === A ? edgeA : edgeB;
      E.conexion.cerrar();
      setTimeout(() => { try { E.conexion.iniciar(); } catch {} }, entre(40, 200));
    }

    // ── Crash y reinicio del Edge A (2%)
    if (azar() < 0.02) {
      metricas.crashes++;
      await edgeA.detener();
      edgeA = nuevoEdge(A.cred, dirA);      // MISMA carpeta: retoma su cola
      await edgeA.iniciar();
    }

    // ── Intentos cruzados entre negocios (8%)
    if (azar() < 0.08 && idsCreados.length) {
      metricas.crossTenantIntentos++;
      const ajeno = elegir(idsCreados);
      const { rows } = await pool.query('SELECT negocio_id, terminal_id FROM impresion_trabajos WHERE id = $1', [ajeno]);
      const terminalAjena = rows[0].negocio_id === A.negocioId ? B.edgeDb.id : A.edgeDb.id;
      const res = await registrarAckDeTerminal(terminalAjena, { trabajoId: ajeno, resultado: 'enviado' });
      if (res) metricas.crossTenantExitosos++;
    }

    if (i % 50 === 0) await esperar(30);    // deja respirar a los workers
  }

  // Reconectar todo y dejar que la cola se vacíe.
  for (const E of [edgeA, edgeB]) { try { E.conexion.cerrar(); E.conexion.iniciar(); } catch {} }
  for (const N of [A, B]) for (const s of Object.values(N.sims)) { s.modo('online'); await s.reencender().catch(() => {}); }

  await hasta(async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM impresion_trabajos
        WHERE id = ANY($1::uuid[]) AND estado IN ('pendiente','entregado','fallido')`, [idsCreados]);
    return rows[0].n === 0;
  }, { que: 'que la cola se vacíe', limiteMs: 120000 });
});

await t('CHAOS', '2. la cuenta cuadra: esperados == creados, sin duplicados', async () => {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM impresion_trabajos WHERE id = ANY($1::uuid[])`, [idsCreados]);
  assert.strictEqual(metricas.creados, metricas.esperados,
    `esperados ${metricas.esperados}, creados ${metricas.creados}`);
  assert.strictEqual(rows[0].n, metricas.esperados, 'en la base hay exactamente los esperados');
  assert.strictEqual(new Set(idsCreados).size, idsCreados.length, 'ningún id repetido');
});

await t('CHAOS', '3. todo trabajo termina en un estado explicable: no hay huérfanos', async () => {
  const { rows } = await pool.query(
    `SELECT estado, count(*)::int AS n FROM impresion_trabajos WHERE id = ANY($1::uuid[]) GROUP BY estado`,
    [idsCreados]);
  const conteo = Object.fromEntries(rows.map(r => [r.estado, r.n]));
  const total = rows.reduce((s, r) => s + r.n, 0);
  console.log(`      estados: ${JSON.stringify(conteo)}`);
  assert.strictEqual(total, metricas.esperados, 'la suma de estados es el total de trabajos');
  const permitidos = ['enviado', 'incierto', 'agotado', 'cancelado', 'pendiente', 'entregado', 'fallido'];
  for (const estado of Object.keys(conteo)) {
    assert.ok(permitidos.includes(estado), `estado inesperado: ${estado}`);
  }
  metricas.estados = conteo;
});

await t('CHAOS', '4. cero duplicados lógicos evitables en el papel', async () => {
  let totalPapeles = 0, totalTope = 0;
  for (const N of [A, B]) {
    for (const [nombre, sim] of Object.entries(N.sims)) {
      // Cada papel lleva el id del trabajo en su payload? No: se compara por
      // contenido + conteo contra los trabajos que la nube dio por enviados.
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM impresion_trabajos
          WHERE id = ANY($1::uuid[]) AND impresora_nombre = $2 AND estado = 'enviado'`,
        [idsCreados, nombre]);
      const enviadosNube = rows[0].n;
      const papeles = sim.recibidos.length;
      // El papel puede ser MAYOR que 'enviado' solo por trabajos inciertos
      // (salieron bytes y no se pudo confirmar). Nunca por duplicación.
      const { rows: ambiguos } = await pool.query(
        `SELECT count(*)::int AS n FROM impresion_trabajos
          WHERE id = ANY($1::uuid[]) AND impresora_nombre = $2 AND estado IN ('incierto','agotado')`,
        [idsCreados, nombre]);
      const tope = enviadosNube + ambiguos[0].n;

      // El papel puede ser MENOR que los trabajos (uno agotado nunca salió) y
      // puede igualar el tope (un incierto sí sacó papel). Lo que no puede
      // pasar NUNCA es superarlo: eso sería una impresión duplicada.
      assert.ok(papeles <= tope,
        `${nombre}: ${papeles} papeles con un tope de ${tope} (${enviadosNube} enviados + ${ambiguos[0].n} ambiguos) -- hay duplicación`);
      totalPapeles += papeles;
      totalTope += tope;
    }
  }
  console.log(`      papeles ${totalPapeles} · tope ${totalTope}`);
  assert.ok(totalPapeles <= totalTope, 'en total tampoco puede haber más papel que trabajos');
  assert.ok(totalPapeles > 0, 'el caos tiene que haber impreso de verdad');
});

await t('CHAOS', '5. cero cruces entre negocios', async () => {
  assert.strictEqual(metricas.crossTenantExitosos, 0,
    `${metricas.crossTenantExitosos} de ${metricas.crossTenantIntentos} ACK cruzados fueron aceptados`);
  assert.ok(metricas.crossTenantIntentos > 0, 'la prueba tiene que haber intentado cruzarlos de verdad');

  // Y ninguna impresora recibió papel del otro negocio.
  for (const [N, otro] of [[A, B], [B, A]]) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM impresion_trabajos t
        WHERE t.negocio_id = $1 AND t.terminal_id = $2`, [N.negocioId, otro.edgeDb.id]);
    assert.strictEqual(rows[0].n, 0, 'ningún trabajo quedó asignado a la terminal del otro negocio');
  }
});

await t('CHAOS', '6. ninguna promesa sin capturar durante todo el caos', async () => {
  await esperar(200);
  assert.deepStrictEqual(sinCapturar, [], 'una promesa sin capturar puede matar el proceso en producción');
});

await t('CHAOS', '7. resumen del caos', async () => {
  console.log(`      seed ${SEED} · rondas ${metricas.rondas} · esperados ${metricas.esperados} · creados ${metricas.creados}`);
  console.log(`      crashes ${metricas.crashes} · desconexiones ${metricas.desconexiones} · fallos de impresora ${metricas.fallosImpresora}`);
  console.log(`      entregas duplicadas ${metricas.entregasDuplicadas} (${metricas.duplicadosCreacion} detectadas) · cruces intentados ${metricas.crossTenantIntentos}, exitosos ${metricas.crossTenantExitosos}`);
  assert.ok(metricas.crashes > 0, 'el caos tiene que haber reiniciado el Edge al menos una vez');
  assert.ok(metricas.desconexiones > 0, 'y haberlo desconectado');
  assert.ok(metricas.fallosImpresora > 0, 'y haber tirado impresoras');
});

// ── Cierre ──────────────────────────────────────────────────────────────────
await edgeA.detener();
await edgeB.detener();
for (const N of [A, B]) for (const s of Object.values(N.sims)) await s.apagar();
for (const d of temporales) { try { rmSync(d, { recursive: true, force: true }); } catch {} }

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
