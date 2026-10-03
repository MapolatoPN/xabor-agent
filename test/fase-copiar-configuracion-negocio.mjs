// Copiar la configuración de un negocio a otro (scripts/copiar-configuracion-negocio.mjs):
// lista cerrada, Flows propios del destino, modo prueba, reglas con lo propio del
// destino, respaldo, apertura y reversa. Base local test_botones_*; sin Meta.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../src/services/database.js';
import { ejecutar, CLAVE_RESPALDO } from '../scripts/copiar-configuracion-negocio.mjs';

let n = 0, fallidas = 0;
async function caso(nombre, fn) {
  try { await fn(); console.log(`OK copiar-config ${++n}: ${nombre}`); }
  catch (e) { fallidas++; console.log(`FALLA copiar-config: ${nombre}\n  ${String(e?.message || e).replace(/\s+/g, ' ').slice(0, 400)}`); }
}
const q = async (sql, p = []) => (await pool.query(sql, p)).rows;
const cfg = async (id) => Object.fromEntries((await q('SELECT clave,valor FROM configuracion WHERE negocio_id=$1', [id])).map((r) => [r.clave, r.valor]));
const poner = async (id, valores) => { for (const [k, v] of Object.entries(valores)) await q(`INSERT INTO configuracion(negocio_id,clave,valor) VALUES($1,$2,$3)
  ON CONFLICT(negocio_id,clave) DO UPDATE SET valor=EXCLUDED.valor`, [id, k, v]); };
const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
const reglasOrigen = { horarios: Object.fromEntries(DIAS.map((d) => [d, { abierto: true, apertura: '04:30', cierre: '00:00' }])),
  pedidos: { costo_envio: 60, pedido_minimo_entrega: 0, modalidades: ['recoger en tienda', 'entrega a domicilio'], zonas_entrega: [{ nombre: 'UTNC', costo: 150 }],
    tiempo_preparacion_minutos: 25 }, cierres_especiales: [], promociones: [], politicas: [],
  bot: { tono: 'amable', saludo: 'Hola', informacion_importante: 'envíos a UTNC $150' } };
async function par() {
  const [o] = await q('INSERT INTO negocios(nombre,slug,bot_whatsapp_activo) VALUES($1,$2,true) RETURNING id', ['Origen config', `cfg-${randomUUID().slice(0, 8)}`]);
  const [d] = await q('INSERT INTO negocios(nombre,slug,bot_whatsapp_activo) VALUES($1,$2,false) RETURNING id', ['Destino config', `cfg-${randomUUID().slice(0, 8)}`]);
  await poner(o.id, { mesero_agente_v1: 'true', whatsapp_flows_v1: 'true', whatsapp_flow_carrito_duplicar_v1: 'true', timezone: 'America/Matamoros',
    iva_pct_default: '8', direccion: 'Calle del origen 1', telefono: '8780000000', whatsapp_flow_categorias_id: '1908733896776951',
    whatsapp_inicio_mapo_respaldo_20260930: '{"x":1}', reglas_atencion: JSON.stringify(reglasOrigen) });
  await poner(d.id, { nombre: 'Destino config', telefono: '8770000000', reglas_atencion: JSON.stringify({ ...reglasOrigen, bot: { informacion_importante: 'todavía no abre' } }) });
  return { o: o.id, d: d.id };
}
const ajustes = { flows: { whatsapp_flow_categorias_id: '1111111111111111', whatsapp_flow_carrito_id: '2222222222222222' },
  telefonosPrueba: ['520000000001', '5210000000001'], horarioTexto: 'Lunes a Sábado de 7:30 am a 2:00 pm',
  horarios: { ...Object.fromEntries(DIAS.slice(0, 6).map((d) => [d, { abierto: true, apertura: '07:30', cierre: '14:00' }])), domingo: { abierto: false, apertura: '07:30', cierre: '14:00' } },
  zonas: [], informacionImportante: 'costo de envio es de $60' };

try {
  await caso('preparar: copia la lista cerrada, Flows propios, modo prueba y reglas del destino; no toca lo general ni el origen', async () => {
    const { o, d } = await par();
    const antesO = await cfg(o);
    const r = await ejecutar(pool, { origen: o, destino: d, modo: 'preparar', ajustes });
    assert.equal(r.modo, 'preparar');
    const c = await cfg(d);
    assert.equal(c.mesero_agente_v1, 'true'); assert.equal(c.iva_pct_default, '8'); assert.equal(c.timezone, 'America/Matamoros');
    assert.equal(c.whatsapp_flow_categorias_id, '1111111111111111');
    assert.equal(c.telefono, '8770000000', 'el teléfono del destino se queda'); assert.equal(c.direccion, undefined, 'la dirección del origen no viaja');
    assert.equal(c.whatsapp_inicio_mapo_respaldo_20260930, undefined, 'los respaldos del origen no viajan');
    assert.equal(c.bot_whatsapp_solo_prueba, 'true'); assert.equal(c.mesero_agente_porcentaje, '0');
    assert.equal(c.mesero_agente_telefonos, '520000000001,5210000000001'); assert.equal(c.whatsapp_atencion_general_v1, 'false');
    const reglas = JSON.parse(c.reglas_atencion);
    assert.equal(reglas.horarios.domingo.abierto, false); assert.equal(reglas.horarios.lunes.apertura, '07:30');
    assert.deepEqual(reglas.pedidos.zonas_entrega, []); assert.equal(reglas.pedidos.tiempo_preparacion_minutos, 25);
    assert.equal(reglas.bot.informacion_importante, 'costo de envio es de $60'); assert.equal(reglas.bot.tono, 'amable');
    assert(c[CLAVE_RESPALDO]);
    assert.deepEqual(await cfg(o), antesO, 'el origen no cambió');
    assert.equal((await ejecutar(pool, { origen: o, destino: d, modo: 'preparar', ajustes })).sinCambios, true);
  });

  await caso('las preguntas frecuentes del origen no viajan: el destino da las suyas (teléfono de mesas, 3-oct)', async () => {
    const { o, d } = await par();
    const conFaqs = { ...reglasOrigen, bot: { ...reglasOrigen.bot,
      faqs: [{ pregunta: '¿Tienen mesas?', respuesta: 'Para información más rápida y confiable, por favor márcanos al 8780000000' }] } };
    await poner(o, { reglas_atencion: JSON.stringify(conFaqs) });
    await assert.rejects(ejecutar(pool, { origen: o, destino: d, modo: 'preparar', ajustes }), /ajustes\.faqs/);
    const faqs = [{ pregunta: '¿Tienen mesas?', respuesta: 'Para información más rápida y confiable, por favor márcanos al 8770000000' }];
    await ejecutar(pool, { origen: o, destino: d, modo: 'preparar', ajustes: { ...ajustes, faqs } });
    const reglas = JSON.parse((await cfg(d)).reglas_atencion);
    assert.deepEqual(reglas.bot.faqs, faqs);
    assert.doesNotMatch(JSON.stringify(reglas), /8780000000/, 'el teléfono del origen no viajó');
  });
  await caso('se niega con un Flow del origen, con el bot del destino encendido o con teléfonos inválidos', async () => {
    const { o, d } = await par();
    await assert.rejects(ejecutar(pool, { origen: o, destino: d, modo: 'preparar',
      ajustes: { ...ajustes, flows: { whatsapp_flow_categorias_id: '1908733896776951' } } }), /es el Flow del origen/);
    await assert.rejects(ejecutar(pool, { origen: o, destino: d, modo: 'preparar', ajustes: { ...ajustes, telefonosPrueba: [] } }), /telefonosPrueba/);
    await q('UPDATE negocios SET bot_whatsapp_activo=true WHERE id=$1', [d]);
    await assert.rejects(ejecutar(pool, { origen: o, destino: d, modo: 'preparar', ajustes }), /apagado/);
    assert.equal((await cfg(d))[CLAVE_RESPALDO], undefined, 'nada escrito');
  });

  await caso('abrir exige el bot encendido y la preparación; revertir deshace la apertura y luego la copia', async () => {
    const { o, d } = await par();
    const antes = await cfg(d);
    await ejecutar(pool, { origen: o, destino: d, modo: 'preparar', ajustes });
    await assert.rejects(ejecutar(pool, { origen: o, destino: d, modo: 'abrir' }), /apagado/);
    await q('UPDATE negocios SET bot_whatsapp_activo=true WHERE id=$1', [d]);
    await ejecutar(pool, { origen: o, destino: d, modo: 'abrir' });
    let c = await cfg(d);
    assert.equal(c.bot_whatsapp_solo_prueba, 'false'); assert.equal(c.whatsapp_atencion_general_v1, 'true');
    assert.equal(c.mesero_agente_porcentaje, '100'); assert.equal(c.mesero_agente_telefonos, '');
    assert.equal((await ejecutar(pool, { origen: o, destino: d, modo: 'abrir' })).sinCambios, true);
    await ejecutar(pool, { origen: o, destino: d, modo: 'revertir' });
    c = await cfg(d);
    assert.equal(c.bot_whatsapp_solo_prueba, 'true', 'la reversa de la apertura vuelve a modo prueba');
    await ejecutar(pool, { origen: o, destino: d, modo: 'revertir' });
    assert.deepEqual(await cfg(d), antes, 'la segunda reversa deja el destino como estaba');
  });

  await caso('revertir no sobrescribe una clave que alguien cambió después', async () => {
    const { o, d } = await par();
    await ejecutar(pool, { origen: o, destino: d, modo: 'preparar', ajustes });
    await poner(d, { iva_pct_default: '16' });
    await assert.rejects(ejecutar(pool, { origen: o, destino: d, modo: 'revertir' }), /cambió después/);
  });
} finally { await pool.end(); }
console.log(`copiar-config: ${n} OK, ${fallidas} fallos`);
if (fallidas) process.exitCode = 1;
