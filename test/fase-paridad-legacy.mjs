// PARIDAD: UN NEGOCIO LEGACY NO NOTA EL DESPLIEGUE.
//
// La pregunta que responde esta suite es una sola, y es la que decide si la
// rama se puede desplegar con otros negocios atendiendo clientes:
//
//   ¿un negocio SIN `pedido_reconciliador_v2` se comporta igual en la rama que
//   en `c859e72`?
//
// No se responde razonando sobre el código: se corre la MISMA conversación
// contra las dos revisiones, entrando por el webhook real, y se comparan las
// huellas. El archivo está escrito para poder ejecutarse tal cual en las dos —
// no importa nada que solo exista en la rama— y escribe su resultado en
// `PARIDAD_SALIDA` para que alguien de fuera los difunda.
//
// Lo que se compara es lo OBSERVABLE, que es lo que le importa al negocio:
// qué le contesta el bot al cliente, qué pedido queda registrado con qué
// artículos y qué total, y qué efectos operativos se disparan.
//
// ── Por qué el modelo responde con una función ────────────────────────────
//
// Cada turno puede provocar llamadas auxiliares (extracción de menciones,
// extracción forzada del borrador) y su número depende del camino. Si se
// encolaran respuestas fijas, una llamada de más en una revisión desalinearía
// la cola y la comparación mediría el desajuste en vez del comportamiento. El
// respondedor mira el prompt y contesta lo que toque, así que las dos
// revisiones reciben lo MISMO ante la misma pregunta.
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT_PARIDAD || '4333';
const ETIQUETA = process.env.PARIDAD_ETIQUETA || 'local';
const SALIDA = process.env.PARIDAD_SALIDA || join(__dirname, `.paridad-${ETIQUETA}.json`);
const TEL = process.env.PARIDAD_TEL || '5218800921001';
const NEG = SEED.negocioA;
const PNID = 'PNID_PARIDAD';

const { pool, actualizarConfiguracion } = await import('../src/services/database.js');

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Catálogo fijo ───────────────────────────────────────────────────────────
await pool.query(`DELETE FROM whatsapp_entradas WHERE telefono LIKE '52188009210%'`).catch(() => {});
await pool.query(`DELETE FROM whatsapp_conversaciones WHERE telefono LIKE '52188009210%'`).catch(() => {});
await pool.query(`DELETE FROM conversacion_estado WHERE session_id LIKE '%52188009210%'`).catch(() => {});
await pool.query(`DELETE FROM mensajes WHERE telefono LIKE '52188009210%'`).catch(() => {});
await pool.query(`DELETE FROM clientes WHERE telefono LIKE '52188009210%'`).catch(() => {});
await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1 AND datos->'cliente'->>'telefono' LIKE '52188009210%'`, [NEG]).catch(() => {});
await pool.query(`DELETE FROM menu_modificadores_opciones WHERE negocio_id=$1 AND grupo_id IN
  (SELECT g.id FROM menu_modificadores_grupos g JOIN menu_productos p ON p.id=g.producto_id
   WHERE p.negocio_id=$1 AND p.nombre LIKE 'PAR %')`, [NEG]).catch(() => {});
await pool.query(`DELETE FROM menu_modificadores_grupos WHERE negocio_id=$1 AND producto_id IN
  (SELECT id FROM menu_productos WHERE negocio_id=$1 AND nombre LIKE 'PAR %')`, [NEG]).catch(() => {});
await pool.query(`DELETE FROM menu_productos WHERE negocio_id=$1 AND nombre LIKE 'PAR %'`, [NEG]);
await pool.query(`DELETE FROM menu_categorias WHERE negocio_id=$1 AND nombre = 'PAR Carta'`, [NEG]);

const { rows: [cat] } = await pool.query(
  `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,'PAR Carta',TRUE,998) RETURNING id`, [NEG]);
const prod = async (nombre, precio) => (await pool.query(
  `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden)
   VALUES ($1,$2,$3,$4,TRUE,0) RETURNING id`, [NEG, cat.id, nombre, precio])).rows[0].id;
const chilaquiles = await prod('PAR Chilaquiles', 150);
await prod('PAR Hotcakes', 80);
await prod('PAR Cafe', 40);
const { rows: [g1] } = await pool.query(
  `INSERT INTO menu_modificadores_grupos (negocio_id, producto_id, nombre, requerido, minimo, maximo)
   VALUES ($1,$2,'Salsa',TRUE,1,1) RETURNING id`, [NEG, chilaquiles]);
for (const o of ['Roja', 'Verde']) {
  await pool.query(`INSERT INTO menu_modificadores_opciones (negocio_id, grupo_id, nombre, precio_extra, disponible)
    VALUES ($1,$2,$3,0,TRUE)`, [NEG, g1.id, o]);
}
const { rows: [g2] } = await pool.query(
  `INSERT INTO menu_modificadores_grupos (negocio_id, producto_id, nombre, requerido, minimo, maximo)
   VALUES ($1,$2,'Proteina',TRUE,1,1) RETURNING id`, [NEG, chilaquiles]);
for (const o of ['Pollo', 'Cerdo']) {
  await pool.query(`INSERT INTO menu_modificadores_opciones (negocio_id, grupo_id, nombre, precio_extra, disponible)
    VALUES ($1,$2,$3,0,TRUE)`, [NEG, g2.id, o]);
}

await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'whatsapp','activo')
  ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [NEG]);
await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'asistente_comercial_cotizaciones','no_configurado')
  ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='no_configurado'`, [NEG]);
await actualizarConfiguracion({ int_wa_phone_id: PNID, int_wa_token: 'fake-token-paridad',
  modo_pedidos: 'transaccional', pedido_requiere_anticipo: 'false' }, NEG);
await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo)
  VALUES ($1,'whatsapp',$2,'Paridad',TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [NEG, PNID]);
for (const [tipo, orden] of [['efectivo', 0], ['terminal', 1]]) {
  await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden) VALUES ($1,$2,TRUE,$3)
    ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = TRUE`, [NEG, tipo, orden]);
}
// EL BOT ENCENDIDO: este negocio atiende clientes, como Acuña y Nonna Maye.
await pool.query(`UPDATE negocios SET bot_whatsapp_activo = TRUE WHERE id = $1`, [NEG]);
// Y en LEGACY: las dos llaves, borradas. Es el estado del que no pidió nada.
await pool.query(`DELETE FROM configuracion WHERE negocio_id=$1 AND clave IN ('pedido_shadow','pedido_reconciliador_v2')`, [NEG]);

const metaMock = await arrancarMetaMock();
const anthropicMock = await arrancarAnthropicMock();
const srv = await arrancarServidor({
  PORT: PUERTO,
  META_GRAPH_BASE_URL: metaMock.baseUrl,
  ANTHROPIC_BASE_URL: anthropicMock.baseUrl,
  ANTHROPIC_API_KEY: 'sk-ant-test-paridad',
  // La global de sombra ENCENDIDA a propósito: con el negocio sin su llave
  // local, no debe cambiar nada. Es la mitad de la garantía multiempresa.
  PEDIDO_SHADOW_MODE: 'true',
}, { timeoutMs: 30000 });

let wamidSeq = 0;
async function enviar(texto) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: PNID },
      messages: [{ type: 'text', from: TEL, id: `wamid.PAR-${ETIQUETA}-${wamidSeq++}`, text: { body: texto } }],
      contacts: [{ profile: { name: 'Cliente Paridad' } }],
    } }] }],
  };
  await fetch(srv.base + '/webhook/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  await esperar(9000);   // la cola de 6 s del canal, con margen
}

/**
 * El respondedor. Mira el prompt y contesta lo que corresponda, así que las dos
 * revisiones reciben lo mismo ante la misma pregunta aunque una llame una vez
 * más que la otra.
 */
function responder(borrador) {
  return (payload) => {
    const sys = String(payload?.system || '');
    if (sys.includes('MENCIONES COMERCIALES')) return JSON.stringify({ menciones: [] });
    if (sys.includes('Extrae el pedido que el cliente')) return JSON.stringify({ items: [] });
    return borrador === null ? 'Con gusto.' : `Claro. <PEDIDO_BORRADOR>${JSON.stringify(borrador)}</PEDIDO_BORRADOR>`;
  };
}
function guion(borrador) {
  anthropicMock.drenar();
  for (let i = 0; i < 6; i++) anthropicMock.encolarRespuesta(responder(borrador));
}

// ── Normalización: lo que cambia entre corridas y no es comportamiento ─────
const anonimo = (s) => String(s ?? '')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
  .replace(/XAB-\d+/g, '<folio>')
  .replace(/\d{10,}/g, '<tel>')
  .replace(/\s+/g, ' ')
  .trim();

const textosDelBot = (desde) => metaMock.obtenerMensajesEnviados().slice(desde)
  .filter((m) => m?.text?.body).map((m) => anonimo(m.text.body));

const conteo = async (sql) => (await pool.query(sql, [NEG])).rows[0].n;
const pedidoDeLaPrueba = async () => {
  const { rows } = await pool.query(
    `SELECT estado, datos FROM pedidos_activos
      WHERE negocio_id=$1 AND datos->'cliente'->>'telefono' LIKE '52188009210%' ORDER BY created_at DESC LIMIT 1`, [NEG]);
  if (!rows.length) return null;
  const d = rows[0].datos || {};
  return {
    estado: rows[0].estado,
    total: d.total ?? null,
    modalidad: d.modalidad ?? null,
    forma_pago: d.forma_pago ?? d.formaPago ?? null,
    // Los ids de catálogo se quitan: cada corrida recrea la carta y recibe
    // series nuevas, así que compararlos mediría el orden de las corridas y no
    // el comportamiento. Lo que identifica una opción para el cliente —y para
    // la cocina— es su NOMBRE y su precio.
    items: (d.items || []).map((i) => ({
      n: i.nombre ?? i.producto, c: i.cantidad, nota: i.notas ?? '',
      m: (i.modificadores ?? []).map((m) =>
        `${m.grupo ?? ''}:${m.opcion ?? m.nombre ?? ''}:${m.precio_extra ?? 0}`).join(' | '),
    })),
  };
};

const traza = { etiqueta: ETIQUETA, pasos: [] };
async function paso(id, texto, borrador) {
  const desde = metaMock.obtenerMensajesEnviados().length;
  guion(borrador);
  await enviar(texto);
  traza.pasos.push({ id, dijo: texto, contesto: textosDelBot(desde) });
}

try {

// L1 — pedido simple con modificadores
await paso('L1', 'Quiero unos PAR Chilaquiles con salsa roja y pollo',
  { items: [{ nombre: 'PAR Chilaquiles', cantidad: 1,
    modificadores: [{ grupo: 'Salsa', opciones: ['Roja'] }, { grupo: 'Proteina', opciones: ['Pollo'] }] }] });

// L2 — cantidad
await paso('L2', 'agregame 2 PAR Hotcakes',
  { items: [{ nombre: 'PAR Chilaquiles', cantidad: 1,
      modificadores: [{ grupo: 'Salsa', opciones: ['Roja'] }, { grupo: 'Proteina', opciones: ['Pollo'] }] },
    { nombre: 'PAR Hotcakes', cantidad: 2, modificadores: [] }] });

// L3 — cambio de modificador a media conversación
await paso('L3', 'mejor los chilaquiles con salsa verde',
  { items: [{ nombre: 'PAR Chilaquiles', cantidad: 1,
      modificadores: [{ grupo: 'Salsa', opciones: ['Verde'] }, { grupo: 'Proteina', opciones: ['Pollo'] }] },
    { nombre: 'PAR Hotcakes', cantidad: 2, modificadores: [] }] });

// L4 — nota
await paso('L4', 'los chilaquiles sin cebolla porfa',
  { items: [{ nombre: 'PAR Chilaquiles', cantidad: 1,
      modificadores: [{ grupo: 'Salsa', opciones: ['Verde'] }, { grupo: 'Proteina', opciones: ['Pollo'] }],
      notas: 'sin cebolla' },
    { nombre: 'PAR Hotcakes', cantidad: 2, modificadores: [] }] });

// L5 — sustitución de producto
await paso('L5', 'quita los PAR Hotcakes y ponme un PAR Cafe',
  { items: [{ nombre: 'PAR Chilaquiles', cantidad: 1,
      modificadores: [{ grupo: 'Salsa', opciones: ['Verde'] }, { grupo: 'Proteina', opciones: ['Pollo'] }],
      notas: 'sin cebolla' },
    { nombre: 'PAR Cafe', cantidad: 1, modificadores: [] }] });

// L7 — modalidad
await paso('L7', 'para recoger',
  { items: [{ nombre: 'PAR Chilaquiles', cantidad: 1,
      modificadores: [{ grupo: 'Salsa', opciones: ['Verde'] }, { grupo: 'Proteina', opciones: ['Pollo'] }],
      notas: 'sin cebolla' },
    { nombre: 'PAR Cafe', cantidad: 1, modificadores: [] }],
    modalidad: 'recoger' });

// L8 — forma de pago
await paso('L8', 'en efectivo',
  { items: [{ nombre: 'PAR Chilaquiles', cantidad: 1,
      modificadores: [{ grupo: 'Salsa', opciones: ['Verde'] }, { grupo: 'Proteina', opciones: ['Pollo'] }],
      notas: 'sin cebolla' },
    { nombre: 'PAR Cafe', cantidad: 1, modificadores: [] }],
    modalidad: 'recoger', forma_pago: 'efectivo' });

// L6 / L9 / L10 — confirmación, pedido registrado y efectos operativos
const impresionAntes = await conteo(`SELECT count(*)::int n FROM impresion_trabajos WHERE negocio_id=$1`);
const pagosAntes = await conteo(`SELECT count(*)::int n FROM pagos WHERE negocio_id=$1`);
await paso('L6', 'si, confirmo', null);
traza.pedido = await pedidoDeLaPrueba();
traza.impresion_nuevas = (await conteo(`SELECT count(*)::int n FROM impresion_trabajos WHERE negocio_id=$1`)) - impresionAntes;
traza.pagos_nuevos = (await conteo(`SELECT count(*)::int n FROM pagos WHERE negocio_id=$1`)) - pagosAntes;

// La huella de V2: el estado durable de la conversación. En `c859e72` la clave
// `carrito` no existe; en la rama, un negocio legacy tampoco debe tenerla.
const { rows: est } = await pool.query(
  `SELECT estado FROM conversacion_estado WHERE negocio_id=$1 AND session_id LIKE '%52188009210%' LIMIT 1`, [NEG]);
traza.estado_tiene_carrito = Boolean(est[0]?.estado?.carrito);
traza.sombra_en_el_log = srv.obtenerSalida().includes('evento=carrito_sombra');

// L9/L10 — QUÉ RUTA SE INVOCÓ, no solo cuántas filas quedaron.
//
// Que `impresion_trabajos` esté en cero en las dos revisiones no demuestra que
// la comanda siga saliendo por donde salía: demuestra que ninguna escribió ahí.
// Lo que sí lo demuestra es la secuencia de marcadores que el servidor emite al
// registrar un pedido: el anuncio, la emisión operacional, el aviso al panel y
// la decisión de impresión. Se comparan en ORDEN.
traza.ruta_operativa = srv.obtenerSalida().split(String.fromCharCode(10))
  .map((l) => {
    const m = l.match(/\[TXN\] evento=([a-z_0-9]+)/);
    if (m) return 'txn:' + m[1];
    if (l.includes('NUEVO PEDIDO')) return 'anuncio:nuevo_pedido';
    if (l.includes('[Impresion]')) return 'impresion:' + (l.match(/razon=([a-z_]+)/)?.[1] || 'sin_razon');
    if (l.includes('[Clip]')) return 'pago:clip';
    return null;
  })
  .filter(Boolean);

writeFileSync(SALIDA, JSON.stringify(traza, null, 1));
console.log(`traza escrita en ${SALIDA}`);
console.log(`  ruta operativa: ${traza.ruta_operativa.join(' > ') || '(vacia)'}`);
console.log(`  pasos: ${traza.pasos.length} | pedido: ${traza.pedido ? 'SI' : 'NO'} `
  + `| impresion: ${traza.impresion_nuevas} | pagos: ${traza.pagos_nuevos} `
  + `| carrito en estado durable: ${traza.estado_tiene_carrito} | sombra: ${traza.sombra_en_el_log}`);
assert.ok(traza.pasos.every((p) => p.contesto.length), 'el bot tenía que contestar en TODOS los pasos');

} finally {
  await pool.query(`UPDATE negocios SET bot_whatsapp_activo = FALSE WHERE id = $1`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM integraciones_canal WHERE canal='whatsapp' AND identificador=$1`, [PNID]).catch(() => {});
  srv.detener(); metaMock.detener(); anthropicMock.detener();
  await pool.end();
}
