// CONSULTA INFORMATIVA DE PROMOCIONES POR FECHA.
//
// El agente debe poder responder "¿qué hay mañana?", "¿el miércoles?", "¿esta
// semana?" consultando el módulo estructurado en una FECHA objetivo — no solo
// "ahora". Se prueba: el resolvedor de fechas (puro), describirPromocionesParaFecha
// (backend por fecha) y responderConsultaPromos (path real: resolución temporal
// → consulta backend → texto), más la regresión del path "AHORA".
//
// Determinista: `ahora` fijo (martes 2024-01-02) y timezone 'UTC'.
// Uso: DATABASE_URL=... node test/fase-promo-consulta-fecha.mjs
import assert from 'assert';

const { pool } = await import('../src/services/database.js');
const { guardarPromocion, describirPromocionesVigentes, describirPromocionesParaFecha,
        responderConsultaPromos } = await import('../src/services/tiendaPromociones.js');
const { resolverCuandoPromo } = await import('../src/services/fechaPromos.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

async function montarNegocio(slug, nombre) {
  const { rows: [n] } = await pool.query(
    `INSERT INTO negocios (nombre, slug) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET nombre=$1 RETURNING id`, [nombre, slug]);
  return n.id;
}
async function categoria(negocioId, nombre) {
  const { rows } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, orden) VALUES ($1,$2,0) ON CONFLICT DO NOTHING RETURNING id`, [negocioId, nombre]);
  if (rows[0]) return rows[0].id;
  return (await pool.query(`SELECT id FROM menu_categorias WHERE negocio_id=$1 AND nombre=$2 LIMIT 1`, [negocioId, nombre])).rows[0].id;
}
async function producto(negocioId, catId, nombre, precio) {
  const { rows } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio) VALUES ($1,$2,$3,$4) RETURNING id`, [negocioId, catId, nombre, precio]);
  return rows[0].id;
}
async function grupo(negocioId, productoId, nombre) {
  const { rows } = await pool.query(
    `INSERT INTO menu_modificadores_grupos (negocio_id, producto_id, nombre, requerido, minimo, maximo, orden)
     VALUES ($1,$2,$3,FALSE,0,0,0) RETURNING id`, [negocioId, productoId, nombre]);
  return rows[0].id;
}
async function opcion(negocioId, grupoId, nombre) {
  const { rows } = await pool.query(
    `INSERT INTO menu_modificadores_opciones (negocio_id, grupo_id, nombre, precio_extra, disponible, orden)
     VALUES ($1,$2,$3,0,TRUE,0) RETURNING id`, [negocioId, grupoId, nombre]);
  return rows[0].id;
}
async function limpiar(negocioId) {
  await pool.query(`DELETE FROM tienda_promociones WHERE negocio_id=$1`, [negocioId]).catch(() => {});
  await pool.query(`DELETE FROM menu_modificadores_opciones WHERE negocio_id=$1`, [negocioId]).catch(() => {});
  await pool.query(`DELETE FROM menu_modificadores_grupos WHERE negocio_id=$1`, [negocioId]).catch(() => {});
  await pool.query(`DELETE FROM menu_productos WHERE negocio_id=$1`, [negocioId]).catch(() => {});
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id=$1`, [negocioId]).catch(() => {});
}

const NEG = await montarNegocio('promo-fecha-a', 'Promo Fecha A');
await limpiar(NEG);
const cat = await categoria(NEG, 'CHILAQUILES');
const pChila = await producto(NEG, cat, 'Chilaquiles Sencillos', 195);
const gSalsa = await grupo(NEG, pChila, 'Salsa');
const oRoja = await opcion(NEG, gSalsa, 'Roja');
const oVerde = await opcion(NEG, gSalsa, 'Verde');
const oSuiza = await opcion(NEG, gSalsa, 'Suiza');

const TZ = 'UTC';
const MARTES = new Date('2024-01-02T12:00:00Z');       // martes 12:00
const MARTES_1642 = new Date('2024-01-02T16:42:00Z');  // martes 16:42

// Promo de MARTES (para "ahora" y "esta semana").
await guardarPromocion(NEG, {
  nombre: 'Martes 2x1', tipo: '2x1', automatica: true, cantidadRequerida: 2, cantidadBeneficiada: 1,
  canales: ['whatsapp', 'pos'], productos: [pChila], diasSemana: [2], horaInicio: '00:00', horaFin: '23:59',
});
// Promo de MIÉRCOLES con condiciones (la del caso real).
await guardarPromocion(NEG, {
  nombre: 'Miércoles Chilaquiles', tipo: 'segundo_descuento', valor: 50, automatica: true,
  cantidadRequerida: 2, cantidadBeneficiada: 1, canales: ['whatsapp', 'pos'], productos: [pChila],
  diasSemana: [3], horaInicio: '00:00', horaFin: '15:00',
  condicionesModificadores: [{ productoId: pChila, grupoId: gSalsa, operador: 'una_de', optionIds: [oRoja, oVerde] }],
});
// Promo de MIÉRCOLES INACTIVA (no debe informarse).
await guardarPromocion(NEG, {
  nombre: 'Miércoles Inactiva', tipo: '2x1', automatica: true, cantidadRequerida: 2, cantidadBeneficiada: 1,
  canales: ['whatsapp', 'pos'], productos: [pChila], diasSemana: [3], horaInicio: '00:00', horaFin: '23:59', activa: false,
});
// Promo de MIÉRCOLES SOLO POS (no debe salir para WhatsApp).
await guardarPromocion(NEG, {
  nombre: 'Miércoles Solo POS', tipo: '2x1', automatica: true, cantidadRequerida: 2, cantidadBeneficiada: 1,
  canales: ['pos'], productos: [pChila], diasSemana: [3], horaInicio: '00:00', horaFin: '23:59',
});

const consulta = (cuando, ahora = MARTES, minutosHint) => responderConsultaPromos(NEG, cuando, { canal: 'whatsapp', ahora, timezone: TZ });

// ═══════════ TESTS ═══════════

await t('TEST 1 · hoy martes, "¿tienen promociones?" (AHORA) → promo de martes', async () => {
  const promos = await describirPromocionesVigentes(NEG, { canal: 'whatsapp', ahora: MARTES, timezone: TZ });
  assert.ok(promos.some(p => p.nombre === 'Martes 2x1'), 'aparece la de martes');
  assert.ok(!promos.some(p => p.nombre === 'Miércoles Chilaquiles'), 'NO aparece la de miércoles en "ahora"');
});

await t('TEST 2 · hoy martes, "¿qué promoción hay mañana?" → promo de miércoles', async () => {
  const txt = await consulta('mañana');
  assert.ok(/Miércoles Chilaquiles/.test(txt), 'menciona la promo de miércoles: ' + txt.slice(0, 120));
  assert.ok(/mañana/i.test(txt));
});

await t('TEST 3 · "¿qué tienen el miércoles?" → promo de miércoles', async () => {
  const txt = await consulta('miércoles');
  assert.ok(/Miércoles Chilaquiles/.test(txt));
});

await t('TEST 4 · follow-up: solo "Miércoles" resuelve al miércoles', async () => {
  const txt = await consulta('Miércoles');
  assert.ok(/Miércoles Chilaquiles/.test(txt), 'la aclaración de un solo día también consulta');
});

await t('TEST 5 · promo miércoles 00:00–15:00, consulta martes 16:42 "mañana" → SÍ aparece', async () => {
  const txt = await consulta('mañana', MARTES_1642);
  assert.ok(/Miércoles Chilaquiles/.test(txt), 'la hora actual no descarta la promo de mañana');
});

await t('TEST 6 · "mañana a las 16:00" → promo que termina 15:00 NO aplica a esa hora', async () => {
  const txt = await consulta('mañana a las 16:00', MARTES_1642);
  assert.ok(!/Miércoles Chilaquiles/.test(txt), 'a las 16:00 ya no aplica (termina 15:00): ' + txt.slice(0, 120));
  assert.ok(/no tenemos/i.test(txt));
});

await t('TEST 7 · promo miércoles INACTIVA → no aparece', async () => {
  const txt = await consulta('mañana');
  assert.ok(!/Inactiva/.test(txt), 'la promo inactiva jamás se informa');
});

await t('TEST 8 · promo solo POS → no aparece en consulta por WhatsApp', async () => {
  const txt = await consulta('mañana');
  assert.ok(!/Solo POS/.test(txt), 'una promo POS-only no sale para WhatsApp');
});

await t('TEST 9 · productos específicos → devuelve nombres reales', async () => {
  const txt = await consulta('mañana');
  assert.ok(/Chilaquiles Sencillos/.test(txt), 'nombre real del producto participante');
});

await t('TEST 10 · condiciones por modificadores → devuelve condiciones legibles', async () => {
  const txt = await consulta('mañana');
  // Renderer natural: se muestran las opciones (Roja o Verde), no el nombre del grupo.
  assert.ok(/Roja/.test(txt) && /Verde/.test(txt), 'condiciones legibles: ' + txt.slice(0, 200));
});

await t('TEST 11 · timezone: "mañana" se resuelve en la TZ del negocio', async () => {
  // 2024-01-03T02:00Z: en America/Matamoros (UTC-6) es martes 2 20:00 → mañana=miércoles 3.
  // En UTC ya sería miércoles 3 → mañana=jueves 4. Debe usar la TZ del negocio.
  const ahora = new Date('2024-01-03T02:00:00Z');
  const rMx = resolverCuandoPromo('mañana', { ahora, timezone: 'America/Matamoros' });
  const rUtc = resolverCuandoPromo('mañana', { ahora, timezone: 'UTC' });
  assert.strictEqual(rMx.dias[0].diaNombre, 'miércoles', 'TZ Matamoros: mañana = miércoles');
  assert.strictEqual(rUtc.dias[0].diaNombre, 'jueves', 'TZ UTC: mañana = jueves (distinto)');
});

await t('TEST 12 · "¿qué promociones hay esta semana?" → lista sin duplicados', async () => {
  const txt = await consulta('esta semana');
  assert.ok(/Martes 2x1/.test(txt) && /Miércoles Chilaquiles/.test(txt), 'incluye martes y miércoles');
  assert.ok(!/Inactiva/.test(txt) && !/Solo POS/.test(txt), 'sin inactiva ni pos-only');
  // Sin duplicados: "Miércoles Chilaquiles" aparece una sola vez.
  assert.strictEqual((txt.match(/Miércoles Chilaquiles/g) || []).length, 1, 'una sola vez');
});

await t('TEST 13 · regresión: consulta sin fecha (AHORA) mantiene comportamiento actual', async () => {
  // describirPromocionesVigentes aplica el filtro de hora actual: a las 16:42 la
  // promo de martes (00:00–23:59) sigue vigente; una que ya cerró no saldría.
  const promos = await describirPromocionesVigentes(NEG, { canal: 'whatsapp', ahora: MARTES_1642, timezone: TZ });
  assert.ok(promos.some(p => p.nombre === 'Martes 2x1'));
});

await t('E2E · path real: mensaje "mañana" → resolución temporal → backend → promo de miércoles con nombres y condiciones', async () => {
  // responderConsultaPromos es el path que ejecuta brain al ver <CONSULTA_PROMOS>.
  const txt = await responderConsultaPromos(NEG, 'mañana', { canal: 'whatsapp', ahora: MARTES, timezone: TZ });
  assert.ok(/Miércoles Chilaquiles/.test(txt), 'promo correcta');
  assert.ok(/Chilaquiles Sencillos/.test(txt), 'producto real');
  assert.ok(/Roja/.test(txt) && /Verde/.test(txt), 'condiciones reales');
  assert.ok(/50%|menor precio/.test(txt), 'describe el beneficio');
});

// ═══════════ RESUMEN ═══════════
await limpiar(NEG);
await pool.end();
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) { console.log('Fallos:\n  - ' + fallos.join('\n  - ')); process.exit(1); }
