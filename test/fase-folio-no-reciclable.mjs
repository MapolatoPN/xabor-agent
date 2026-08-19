// ─── El folio XAB-#### no puede reciclarse ──────────────────────────────────
//
// EL DEFECTO QUE CIERRA
//
// El folio salía de un contador en memoria de Node, sembrado al arrancar con
// `obtenerMaxFolioNum()`, que mira `pedidos_activos` Y NADA MÁS. Entregado el
// pedido y purgada su fila, ese número desaparecía de la única fuente que el
// contador consultaba: al reiniciar, RETROCEDÍA.
//
// Medido en la base local antes del arreglo:
//
//   MAX(pedidos_activos) = 9578    <- lo único que miraba el contador
//   MAX(pedidos)         = 10321   <- el máximo histórico real
//
// 743 folios ya entregados se habrían reemitido en el siguiente arranque. Y en
// `pedidos` había ya 337 folios repetidos (1259 filas): no era una hipótesis.
//
// POR QUÉ NO BASTA PARCHEAR A LOS CONSUMIDORES
//
// El folio es la identidad de la que cuelgan el dedupe del panel
// (`<tipo>:<negocioId>:<folio>`, con registro en localStorage a 72 h), la
// idempotencia de Edge (`impresion_trabajos.origen_id`), los pagos, las
// promociones, los rewards, el reparto y las compras reales. Un folio reciclado
// no rompe una pieza: rompe la noción de identidad de todas a la vez. Se
// arregla en la fuente, con una SEQUENCE de PostgreSQL (migración 059).
//
// Esta suite prueba las cuatro propiedades exigidas: durable, monótona ante
// purga total, atómica bajo concurrencia y estable entre procesos distintos.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const { pool } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(nombre); }
}

const NEG = SEED.negocioA;
const num = (folio) => Number(String(folio).replace('XAB-', ''));
const emitidos = [];

const { reservarFolioPedido } = await import('../src/services/database.js');

async function reservar(n = 1) {
  const lote = [];
  for (let i = 0; i < n; i++) lote.push(await reservarFolioPedido());
  emitidos.push(...lote);
  return lote;
}

/** Purga FÍSICA y TOTAL del tablero: es la condición que hundía al contador. */
async function purgarTableroEntero() {
  await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id = $1`, [NEG]);
}

async function limpiar() {
  await pool.query(
    `DELETE FROM pedidos_activos WHERE negocio_id=$1 AND datos->>'canal'='folio_test'`, [NEG]);
}

try {
  await limpiar();

  // ═══ LA PRUEBA CENTRAL ═══════════════════════════════════════════════════
  await t('1. crear hasta XAB-N, purgar TODO el tablero, "reiniciar", crear: el folio sube', async () => {
    const [antesA, antesB] = await reservar(2);
    const N = num(antesB);

    // Los folios existen como pedidos vivos.
    for (const f of [antesA, antesB]) {
      await pool.query(
        `INSERT INTO pedidos_activos (folio, negocio_id, estado, datos)
         VALUES ($1,$2,'nuevo',$3::jsonb)`,
        [f, NEG, JSON.stringify({ id: f, canal: 'folio_test', total: 1 })]);
    }

    // Se entregan y se PURGAN fisicamente: el tablero queda vacio.
    await purgarTableroEntero();
    assert.strictEqual((await pool.query(
      `SELECT COUNT(*)::int AS n FROM pedidos_activos WHERE negocio_id=$1`, [NEG])).rows[0].n, 0,
      'el fixture no dejo el tablero vacio');

    // "Reinicio": el estado en memoria no participa en la decision. La
    // secuencia vive en la base, asi que un proceso nuevo obtiene lo mismo.
    const [despues] = await reservar(1);
    assert.ok(num(despues) > N,
      `el folio retrocedio tras purgar el tablero: ${despues} <= XAB-${N}`);
  });

  await t('2. el contador viejo habria retrocedido aqui mismo', async () => {
    // Se demuestra que el escenario de arriba SÍ hundía a la lógica anterior:
    // con el tablero vacío, `obtenerMaxFolioNum()` devuelve el máximo de
    // `pedidos_activos`, que ya no incluye lo purgado.
    //
    // La brecha (histórico > tablero) se construye AQUÍ MISMO, nunca se
    // asume del estado ambiente de la base compartida: antes, este caso
    // dependía de que el máximo histórico global superara al tablero
    // global, y cualquier otra suite que dejara pedidos vivos de OTRO
    // negocio con folios frescos de la secuencia rompía esa precondición
    // (fallaba en la regresión completa y pasaba en aislamiento). El
    // fixture ahora reproduce el camino real: un folio recién emitido por
    // la secuencia se ARCHIVA al histórico (compra que ya pasó) sin dejar
    // rastro en el tablero — exactamente el estado que hundía al contador
    // viejo. La secuencia es monótona, así que ese folio supera por
    // construcción a todo lo vivo en pedidos_activos, de cualquier negocio.
    const { obtenerMaxFolioNum } = await import('../src/services/database.js');
    const [fArchivado] = await reservar(1);
    await pool.query(
      `INSERT INTO pedidos (folio, telefono, nombre_cliente, items, total, modalidad,
                            canal, forma_pago, negocio_id, created_at)
       VALUES ($1,NULL,'X','[]'::jsonb,10,'recoger','folio_test','efectivo',$2,NOW() - interval '30 days')`,
      [fArchivado, NEG]);
    await purgarTableroEntero();
    const maxTablero = await obtenerMaxFolioNum();

    const { rows: [h] } = await pool.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(folio FROM '^XAB-([0-9]+)$') AS bigint)),0)::bigint AS m
         FROM pedidos WHERE folio ~ '^XAB-[0-9]+$'`);
    const maxHistorico = Number(h.m);

    assert.ok(maxHistorico > maxTablero,
      `el fixture no reproduce la brecha (historico ${maxHistorico} <= tablero ${maxTablero})`);

    // Y la secuencia esta por encima del historico, no del tablero.
    const [f] = await reservar(1);
    assert.ok(num(f) > maxHistorico,
      `la secuencia entrego ${f}, que ya existe en el historico (max ${maxHistorico})`);

    await pool.query(`DELETE FROM pedidos WHERE folio = $1 AND negocio_id = $2`, [fArchivado, NEG]);
  });

  // ═══ MONOTONÍA Y UNICIDAD ════════════════════════════════════════════════
  await t('3. 100 reservas concurrentes: 100 folios distintos', async () => {
    const lote = await Promise.all(Array.from({ length: 100 }, () => reservarFolioPedido()));
    emitidos.push(...lote);
    assert.strictEqual(new Set(lote).size, 100,
      `hubo folios repetidos bajo concurrencia: ${100 - new Set(lote).size} colisiones`);
  });

  await t('4. dos "procesos" con pools independientes no se pisan', async () => {
    // Un Pool nuevo es una conexion distinta a la base: es lo mas cercano a otra
    // instancia de Railway sin levantar un segundo servidor. Si el folio saliera
    // de memoria del proceso, ambos entregarian los mismos numeros.
    const { default: pkg } = await import('pg');
    const otro = new pkg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const pares = await Promise.all(Array.from({ length: 50 }, async (_, i) => (
        i % 2 === 0
          ? (await pool.query(`SELECT nextval('folio_pedido_seq') AS n`)).rows[0].n
          : (await otro.query(`SELECT nextval('folio_pedido_seq') AS n`)).rows[0].n
      )));
      const vistos = pares.map(Number);
      assert.strictEqual(new Set(vistos).size, 50,
        'dos procesos recibieron el mismo folio');
      emitidos.push(...vistos.map(n => `XAB-${String(n).padStart(4, '0')}`));
    } finally { await otro.end(); }
  });

  await t('5. purga total ENTRE tandas: la segunda tanda sigue subiendo', async () => {
    const tanda1 = await reservar(10);
    await purgarTableroEntero();
    const tanda2 = await reservar(10);
    const maxT1 = Math.max(...tanda1.map(num));
    assert.ok(Math.min(...tanda2.map(num)) > maxT1,
      'una purga entre tandas hizo retroceder la numeracion');
  });

  await t('6. CERO folios repetidos en toda la suite', async () => {
    const unicos = new Set(emitidos);
    assert.strictEqual(unicos.size, emitidos.length,
      `${emitidos.length - unicos.size} folio(s) repetidos entre los ${emitidos.length} emitidos`);
  });

  // ═══ LA FUENTE ═══════════════════════════════════════════════════════════
  await t('7. la secuencia arranca por encima de TODO el historico, no solo del tablero', async () => {
    const fuentes = [
      ['pedidos_activos', 'folio'], ['pedidos', 'folio'], ['pagos', 'pedido_folio'],
      ['compras_reales', 'folio'], ['tienda_pedidos', 'pedido_folio'],
      ['tienda_promocion_usos', 'pedido_folio'], ['notificaciones_repartidor', 'pedido_folio'],
      ['rewards_movements', 'folio_venta'], ['oportunidades', 'folio_pedido'],
    ];
    let maxGlobal = 0;
    for (const [tabla, col] of fuentes) {
      try {
        const { rows: [r] } = await pool.query(
          `SELECT COALESCE(MAX(CAST(SUBSTRING(${col} FROM '^XAB-([0-9]+)$') AS bigint)),0)::bigint AS m
             FROM ${tabla} WHERE ${col} ~ '^XAB-[0-9]+$'`);
        maxGlobal = Math.max(maxGlobal, Number(r.m));
      } catch { /* la tabla no existe en este entorno */ }
    }
    const [f] = await reservar(1);
    assert.ok(num(f) > maxGlobal,
      `la secuencia entrego ${f} con un maximo historico global de ${maxGlobal}`);
  });

  await t('8. el generador NO consulta pedidos_activos', async () => {
    // Diente estructural: si alguien vuelve a sembrar el folio desde el tablero,
    // el defecto regresa aunque la secuencia siga existiendo.
    const src = readFileSync(join(__dirname, '..', 'src', 'orders', 'orderManager.js'), 'utf8');
    const reg = src.slice(src.indexOf('export async function registrarPedido'),
                          src.indexOf('export async function emitirPedido'));
    assert.ok(reg.includes('reservarFolioPedido'),
      'registrarPedido dejo de pedir el folio a la secuencia durable');
    assert.ok(!/contadorPedidos/.test(src),
      'volvio a existir un contador de folios en memoria');
    assert.ok(!/XAB-\$\{String\(contador/.test(src),
      'el folio se vuelve a construir desde un contador local');

    const db = readFileSync(join(__dirname, '..', 'src', 'services', 'database.js'), 'utf8');
    const fn = db.slice(db.indexOf('export async function reservarFolioPedido'));
    assert.ok(fn.slice(0, 600).includes("nextval('folio_pedido_seq')"),
      'reservarFolioPedido dejo de usar la secuencia de PostgreSQL');
  });

  // ═══ POR QUÉ IMPORTA: LOS CONSUMIDORES NO PUEDEN DEFENDERSE SOLOS ════════
  await t('9. PANEL: con un folio reciclado, el pedido nuevo se vuelve INVISIBLE', async () => {
    // Se demuestra la consecuencia, no se tolera. El dedupe del panel usa
    // `<tipo>:<negocioId>:<folio>` y guarda lo visto en localStorage 72 h. Si un
    // folio se reemitiera dentro de esa ventana, el LIVE del pedido NUEVO llega
    // con una clave "ya vista" y sin tarjeta en el tablero -- y esa combinación
    // es justo la que el panel interpreta como "duplicado de algo ya
    // despachado". El pedido nuevo no se muestra.
    //
    // Esto NO se arregla en el panel: distinguir "duplicado viejo" de "pedido
    // nuevo con folio reciclado" es imposible si la identidad miente. Se arregla
    // en la fuente, y el caso 10 verifica que la fuente ya no puede mentir.
    const { conIdentidadDePedido } = await import('../src/services/eventosPanel.js');
    const { pathToFileURL } = await import('url');
    const { readFileSync: rf } = await import('fs');

    const ctx = { window: {}, globalThis: undefined };
    const codigo = rf(join(__dirname, '..', 'panel', 'tableroEventos.js'), 'utf8');
    const sandbox = { window: {} };
    new Function('window', codigo)(sandbox.window);
    const manejar = sandbox.window.XaborTableroEventos.manejarEventoPedido;

    const FOLIO = 'XAB-RECICLADO-PANEL';
    const vistos = new Set();
    const dedupe = { yaVisto: (id) => vistos.has(id), marcar: (id) => vistos.add(id) };
    let enTablero = new Set();
    const deps = {
      dedupe,
      upsertPedido: (ped) => enTablero.add(ped.id),
      notificar: () => {},
      estaEnTablero: (id) => enTablero.has(id),
    };

    // Pedido VIEJO con ese folio: se ve y se despacha.
    const viejo = { id: FOLIO, cliente: { nombre: 'Viejo' } };
    manejar(conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido: viejo }, { ...viejo, negocioId: NEG }), deps);
    assert.ok(enTablero.has(FOLIO), 'el fixture no mostro el pedido viejo');
    enTablero.delete(FOLIO);                        // despachado

    // Meses despues, el MISMO folio para otro pedido, de otro cliente.
    const nuevo = { id: FOLIO, cliente: { nombre: 'Nuevo' } };
    const r = manejar(
      conIdentidadDePedido({ tipo: 'nuevo_pedido', pedido: nuevo }, { ...nuevo, negocioId: NEG }), deps);

    assert.strictEqual(r.proyectado, false,
      'el panel logro distinguir dos pedidos con el mismo folio: revisar esta prueba, no el panel');
    assert.ok(!enTablero.has(FOLIO),
      'el pedido nuevo se mostro: la premisa de esta prueba cambio');
    // Queda escrito: con folio reciclado, el pedido nuevo NO se ve.
  });

  await t('10. ...y el generador hace ese escenario imposible', async () => {
    // La garantia real: ningun folio entregado vuelve a salir. Se comprueba
    // contra el historico COMPLETO, que es lo que el contador viejo ignoraba.
    const [f] = await reservar(1);
    const { rows: [r] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM (
         SELECT folio FROM pedidos_activos WHERE folio = $1
         UNION ALL SELECT folio FROM pedidos WHERE folio = $1
         UNION ALL SELECT folio FROM compras_reales WHERE folio = $1) d`, [f]);
    assert.strictEqual(r.n, 0,
      `la secuencia entrego ${f}, que ya existe en el historico`);
  });

  await t('11. IMPRESION: un origen_id repetido bloquearia la comanda del pedido nuevo', async () => {
    // Edge deduplica por (negocio, origen_tipo, origen_id) para no imprimir dos
    // veces la misma comanda tras un reintento. Con folios reciclados esa misma
    // proteccion silenciaria la comanda de un pedido DISTINTO. Igual que el
    // panel: no se arregla en impresion, se arregla en el folio.
    // La clave real: `construirClaveIdempotencia` la arma con el FOLIO
    // (impresionService.js:371) y el INSERT hace ON CONFLICT (idempotency_key)
    // DO NOTHING. Dos pedidos distintos con el mismo folio y la misma impresora
    // producen la MISMA clave, asi que el segundo se descarta en silencio.
    const { construirClaveIdempotencia } = await import('../src/services/impresionService.js');
    const FOLIO = `XAB-RECICLADO-PRINT-${Date.now()}`;
    const IMPRESORA = '00000000-0000-0000-0000-0000000000aa';
    const { rows: [suc] } = await pool.query(
      `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'FolioPrint')
       ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo=true RETURNING id`, [NEG]);

    const clave = construirClaveIdempotencia(
      { negocioId: NEG, origenTipo: 'pedido', origenId: FOLIO, impresoraId: IMPRESORA });

    const insertar = () => pool.query(
      `INSERT INTO impresion_trabajos
         (negocio_id, sucursal_id, impresora_nombre, documento, origen_tipo, origen_id,
          idempotency_key, estado, payload)
       VALUES ($1,$2,'Impresora X','comanda','pedido',$3,$4,'pendiente','{}'::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`, [NEG, suc.id, FOLIO, clave]);

    // Comanda del pedido VIEJO: se crea.
    assert.strictEqual((await insertar()).rowCount, 1, 'el fixture no creo la comanda previa');

    // El pedido NUEVO reusa el folio -> misma clave -> su comanda se descarta.
    assert.strictEqual((await insertar()).rowCount, 0,
      'la idempotencia de impresion dejo de colisionar: revisar esta prueba, no impresion');

    // Y el generador nunca entregara ese folio a otro pedido.
    const [f] = await reservar(1);
    assert.notStrictEqual(f, FOLIO);
    const { rows: [z] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM impresion_trabajos
        WHERE negocio_id=$1 AND origen_tipo='pedido' AND origen_id=$2`, [NEG, f]);
    assert.strictEqual(z.n, 0,
      `el folio nuevo ${f} ya tenia un trabajo de impresion: colision de identidad`);

    await pool.query(
      `DELETE FROM impresion_trabajos WHERE negocio_id=$1 AND origen_id=$2`, [NEG, FOLIO]);
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push('ERROR FATAL');
} finally {
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-folio-no-reciclable: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) { console.log('Fallos: ' + fallos.join(' | ')); }
process.exit(fallidas ? 1 : 0);
