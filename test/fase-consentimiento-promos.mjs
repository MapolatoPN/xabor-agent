// ─── CONSENTIMIENTO DE PROMOCIONES (saneamiento de Clientes, fase 2) ─────────
//
// Pedido de Mario del 21-nov-2026 (prompt maestro, puntos 7 a 9; «sí,
// empieza»). Contra una base local test_botones_* y sin red externa:
//
//   M. la 146: se aplica sin tocar los consentimientos que ya había (los que
//      dicen «aceptó» lo siguen diciendo), es repetible, es aditiva y sus
//      reglas frenan lo que no debe entrar.
//   A. el aviso por negocio: texto por omisión sembrado una sola vez, cada
//      cambio es una versión, validación, y la tienda nunca falla por él.
//   C. la aceptación al pedir en la tienda: solo con el aviso encendido a la
//      vista, con el folio y la versión, nunca deshace una baja, no cuenta
//      pedidos sin pagar, cancelados o de otro canal, dentro del negocio.
//   L. la Lista: tarjeta y filtro con los tres estados; la ficha los nombra.
//   R. las rutas: solo administradores, el negocio de la sesión, errores sin
//      detalles internos; la tienda pública entrega el aviso.
//   P. el panel y la tienda: el aviso se pinta escapado, el editor vive en su
//      archivo con su huella y el servidor encadena el trabajo en segundo plano.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import express from 'express';

// ── Guardas: solo base local de pruebas, solo red local ──────────────────────
{
  const url = new URL(process.env.DATABASE_URL);
  assert(['127.0.0.1', 'localhost'].includes(url.hostname), 'solo base local');
  assert.match(url.pathname, /^\/test_botones_/, 'solo una base test_botones_*');
  assert.match(process.env.NODE_OPTIONS || '', /red-solo-local/, 'corre con NODE_OPTIONS=--import=./test/red-solo-local.mjs');
}

const { pool } = await import('../src/services/database.js');
const aviso = await import('../src/services/avisoPromociones.js');
const { registrarRutasAvisoPromociones } = await import('../src/services/avisoPromocionesRutas.js');
const crm = await import('../src/services/clientesCrm.js');
const { consentimientosVigentes } = await import('../src/services/clientesNegocio.js');
const { registrarRutasTienda } = await import('../src/services/tiendaRutasCore.js');

const leer = (r) => readFileSync(new URL(`../${r}`, import.meta.url), 'utf8');
let n = 0; let fallidas = 0;
const SOLO = (process.env.CASOS || '').split(',').map((s) => s.trim()).filter(Boolean);
async function caso(nombre, fn) {
  if (SOLO.length && !SOLO.includes(nombre.split(' ')[0])) return;
  try { await fn(); console.log(`OK consentimiento-promos ${++n}: ${nombre}`); }
  catch (e) {
    fallidas++;
    const detalle = e?.code === 'ERR_ASSERTION' && e.generatedMessage
      ? ` · obtenido=${JSON.stringify(e.actual)?.slice(0, 240)} · esperado=${JSON.stringify(e.expected)?.slice(0, 160)}` : '';
    console.log(`FALLA ${nombre.split(' ')[0]} consentimiento-promos: ${nombre}\n  ${String(e?.message || e).split('\n')[0]}${detalle}`);
  }
}
async function rechaza(promesa, codigo) {
  let e = null;
  try { await promesa; } catch (x) { e = x; }
  assert.ok(e instanceof aviso.ErrorAviso, `debía rechazar con ${codigo}: ${e?.message || 'no rechazó'}`);
  assert.equal(e.codigo, codigo, e.message);
  return e;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const creados = [];
const marca = () => randomUUID().slice(0, 6);
const tel = () => `52${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`;
async function negocio({ tienda = true, titular = 'Tacos Prueba', nombre = 'Negocio Consentimiento' } = {}) {
  const m = marca();
  const { rows: [r] } = await pool.query("INSERT INTO negocios(nombre,slug) VALUES($1,$2) RETURNING id", [nombre, `consent-${m}-${randomUUID().slice(0, 4)}`]);
  creados.push(r.id);
  if (tienda) {
    await pool.query(`INSERT INTO tienda_config(negocio_id, estado, slug_publico, titular) VALUES($1,'publicada',$2,$3)`,
      [r.id, `consent-tienda-${m}`, titular]);
    await pool.query("INSERT INTO negocio_modulos(negocio_id,modulo,estado) VALUES($1,'tienda_online','activo')", [r.id]);
  }
  return { id: r.id, slug: `consent-tienda-${m}` };
}
async function cliente(neg, t = tel(), nombre = 'Cliente Consent') {
  const { rows: [r] } = await pool.query('INSERT INTO clientes_negocio(negocio_id,telefono,nombre) VALUES($1,$2,$3) RETURNING id', [neg.id, t, nombre]);
  return { id: r.id, telefono: t };
}
let folios = 0;
const sufijo = marca();
// Un pedido tal como lo deja la tienda (canal tienda_online), con folio propio
// fuera de XAB-: la barrera de folios lo deja pasar. `cuando` es un Date.
async function pedido(neg, telefono, { canal = 'tienda_online', estado = 'nuevo', cuando = new Date() } = {}) {
  const folio = `CP-${sufijo}-${++folios}`;
  const datos = { canal, modalidad: 'recoger en tienda', total: 150, forma_pago: 'efectivo', cliente: { nombre: 'Cliente Consent', telefono },
    items: [{ nombre: 'Producto CP', cantidad: 1, precio: 150 }] };
  // created_at es timestamp SIN zona y guarda UTC.
  await pool.query(
    `INSERT INTO pedidos_activos (folio, estado, datos, created_at, updated_at, negocio_id)
     VALUES ($1, $2, $3, ($4::timestamptz AT TIME ZONE 'UTC'), ($4::timestamptz AT TIME ZONE 'UTC'), $5)`,
    [folio, estado, JSON.stringify(datos), cuando.toISOString(), neg.id]);
  return folio;
}
const haceMin = (m) => new Date(Date.now() - m * 60000);
async function versionCon(neg, { texto = 'Aviso de prueba', enTienda = true, cuando }) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO aviso_promociones(negocio_id, texto, en_tienda, creado_por, created_at) VALUES($1,$2,$3,'u-prueba',$4) RETURNING id`,
    [neg.id, texto, enTienda, cuando.toISOString()]);
  return Number(r.id);
}
async function filas(neg, cli) {
  const { rows } = await pool.query(
    `SELECT otorgado, fuente, referencia, aviso_id, created_at FROM cliente_consentimientos
      WHERE negocio_id=$1 AND cliente_id=$2 AND canal='whatsapp' ORDER BY id`, [neg.id, cli.id]);
  return rows.map((r) => ({ ...r, aviso_id: r.aviso_id == null ? null : Number(r.aviso_id) }));
}
async function anotar(neg, cli, otorgado, fuente, cuando = new Date()) {
  await pool.query(`INSERT INTO cliente_consentimientos(negocio_id,cliente_id,canal,otorgado,fuente,created_at) VALUES($1,$2,'whatsapp',$3,$4,$5)`,
    [neg.id, cli.id, otorgado, fuente, cuando.toISOString()]);
}
function predeploy() {
  const r = spawnSync(process.execPath, ['scripts/predeploy-146-aviso-promociones.mjs'], { env: process.env, encoding: 'utf8', timeout: 60000 });
  const salida = `${r.stdout || ''}${r.stderr || ''}`;
  // El motivo de un fallo va primero: es la línea que se ve en el resumen.
  return { codigo: r.status, salida: [...salida.split('\n').filter((l) => /FALLO/.test(l)), salida].join('\n') };
}
async function fallaSql(sql, params, patron) {
  let e = null;
  try { await pool.query(sql, params); } catch (x) { e = x; }
  assert.ok(e, `la base debía rechazar: ${sql.slice(0, 80)}`);
  if (patron) assert.match(e.message, patron);
}

try {
  // ── M. La migración 146 ────────────────────────────────────────────────────
  await caso('M1 la 146 se aplica sin tocar los consentimientos existentes: los que aceptaron siguen aceptando', async () => {
    // Una base con la 146 puesta se regresa primero (la reversa es la del repo).
    const { rows: [ya] } = await pool.query(`SELECT to_regclass('public.aviso_promociones') IS NOT NULL AS hay`);
    if (ya.hay) await pool.query(leer('migrations/146_aviso_promociones_down.sql'));
    const neg = await negocio();
    const a1 = await cliente(neg); const a2 = await cliente(neg); const b = await cliente(neg);
    await anotar(neg, a1, true, 'mi_cuenta'); await anotar(neg, a2, true, 'mi_cuenta'); await anotar(neg, b, false, 'campana_boton_baja');
    const antes = (await pool.query(`SELECT id, negocio_id, cliente_id, canal, otorgado, fuente, created_at FROM cliente_consentimientos ORDER BY id`)).rows;
    const r = predeploy();
    assert.equal(r.codigo, 0, r.salida);
    assert.match(r.salida, /\[predeploy-146\] Aplicada: \d+ consentimiento\(s\) sin cambios \(\d+ aceptado\(s\)\)/);
    const despues = (await pool.query(`SELECT id, negocio_id, cliente_id, canal, otorgado, fuente, created_at FROM cliente_consentimientos ORDER BY id`)).rows;
    assert.deepEqual(despues, antes);
    assert.equal((await pool.query(`SELECT count(*)::int n FROM cliente_consentimientos WHERE referencia IS NOT NULL OR aviso_id IS NOT NULL`)).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT count(*)::int n FROM aviso_promociones`)).rows[0].n, 0, 'la 146 nace sin avisos');
    for (const c of [a1, a2]) assert.equal((await consentimientosVigentes(neg.id, c.id)).whatsapp.estado, 'acepto');
    assert.equal((await consentimientosVigentes(neg.id, b.id)).whatsapp.estado, 'baja');
  });

  await caso('M2 la 146 es repetible y repara lo que falte', async () => {
    const r = predeploy();
    assert.equal(r.codigo, 0, r.salida);
    assert.match(r.salida, /\[predeploy-146\] Ya aplicada/);
    await pool.query('DROP INDEX cliente_consentimientos_tienda_pedido_unica');
    const r2 = predeploy();
    assert.equal(r2.codigo, 0, r2.salida);
    assert.match(r2.salida, /Reparada \(faltaba: índice cliente_consentimientos_tienda_pedido_unica\)/);
    assert.match(predeploy().salida, /Ya aplicada/);
  });

  await caso('M3 la 146 es aditiva, va después de la 143 en el runner y su reversa no borra filas', () => {
    const sql = leer('migrations/146_aviso_promociones.sql').replace(/^\s*--.*$/gm, '').replace(/\bON DELETE\b/gi, '');
    assert.ok(!/\bDROP (COLUMN|TABLE|INDEX)\b|(^|;)\s*(DELETE|UPDATE|TRUNCATE|INSERT)\b/im.test(sql), 'la 146 debe ser aditiva');
    const runner = leer('scripts/predeploy-run-032-033.mjs');
    const i143 = runner.indexOf("'143-clientes-saneamiento'"); const i146 = runner.indexOf("'146-aviso-promociones'");
    assert.ok(i143 > 0 && i146 > i143, 'la 146 no está en SCRIPTS después de la 143');
    assert.match(leer('scripts/predeploy-146-aviso-promociones.mjs'), /migrations\/146_aviso_promociones\.sql/);
    assert.ok(existsSync(new URL('../migrations/146_aviso_promociones_down.sql', import.meta.url)));
    const down = leer('migrations/146_aviso_promociones_down.sql').replace(/^\s*--.*$/gm, '');
    assert.ok(!/(^|;)\s*(DELETE|UPDATE|TRUNCATE)\b/im.test(down), 'la reversa no borra consentimientos');
  });

  await caso('M4 las reglas de la 146: texto vacío o largo, dos aceptaciones al pedir, versión inexistente', async () => {
    const neg = await negocio();
    const c = await cliente(neg);
    await fallaSql(`INSERT INTO aviso_promociones(negocio_id,texto) VALUES($1,'   ')`, [neg.id], /aviso_promociones_texto/);
    await fallaSql(`INSERT INTO aviso_promociones(negocio_id,texto) VALUES($1,$2)`, [neg.id, 'x'.repeat(301)], /aviso_promociones_texto/);
    await pool.query(`INSERT INTO cliente_consentimientos(negocio_id,cliente_id,canal,otorgado,fuente) VALUES($1,$2,'whatsapp',true,'tienda_pedido')`, [neg.id, c.id]);
    await fallaSql(`INSERT INTO cliente_consentimientos(negocio_id,cliente_id,canal,otorgado,fuente) VALUES($1,$2,'whatsapp',true,'tienda_pedido')`,
      [neg.id, c.id], /cliente_consentimientos_tienda_pedido_unica/);
    // Las otras fuentes son bitácora: se repiten sin problema.
    await anotar(neg, c, false, 'campana_boton_baja'); await anotar(neg, c, true, 'mi_cuenta'); await anotar(neg, c, false, 'mi_cuenta');
    await fallaSql(`INSERT INTO cliente_consentimientos(negocio_id,cliente_id,canal,otorgado,fuente,aviso_id) VALUES($1,$2,'email',true,'x',987654321)`,
      [neg.id, c.id], /aviso_id_fkey/);
  });

  // ── A. El aviso por negocio ────────────────────────────────────────────────
  await caso('A1 el aviso por omisión se siembra una vez, con el nombre de la tienda, solo donde hay tienda', async () => {
    const conTienda = await negocio({ titular: 'Pizzas Lupe' });
    const sinTitular = await negocio({ titular: null, nombre: 'Café Norte' });
    const sinTienda = await negocio({ tienda: false });
    assert.ok(await aviso.asegurarAvisoInicial() >= 2);
    const v = await aviso.avisoVigente(conTienda.id);
    assert.equal(v.texto, 'Al pedir aceptas recibir promociones de Pizzas Lupe; puedes darte de baja cuando quieras.');
    assert.equal(v.enTienda, true); assert.equal(v.creadoPor, 'sistema');
    assert.match((await aviso.avisoVigente(sinTitular.id)).texto, /promociones de Café Norte;/);
    assert.equal(await aviso.avisoVigente(sinTienda.id), null);
    assert.equal(await aviso.asegurarAvisoInicial(), 0, 'la segunda vez no siembra nada');
    assert.equal((await pool.query('SELECT count(*)::int n FROM aviso_promociones WHERE negocio_id=$1', [conTienda.id])).rows[0].n, 1);
  });

  await caso('A2 guardar: cada cambio es una versión; lo mismo no escribe; se valida el texto y el interruptor', async () => {
    const neg = await negocio();
    await aviso.asegurarAvisoInicial();
    const r1 = await aviso.guardarAviso(neg.id, { texto: '  Al pedir aceptas\npromos;\tbaja cuando quieras.  ', enTienda: true }, 'u-admin');
    assert.equal(r1.cambio, true);
    assert.equal(r1.vigente.texto, 'Al pedir aceptas promos; baja cuando quieras.', 'sin saltos ni tabuladores');
    assert.equal(r1.vigente.creadoPor, 'u-admin');
    const r2 = await aviso.guardarAviso(neg.id, { texto: 'Al pedir aceptas promos; baja cuando quieras.', enTienda: true }, 'u-admin');
    assert.equal(r2.cambio, false);
    const r3 = await aviso.guardarAviso(neg.id, { texto: 'Al pedir aceptas promos; baja cuando quieras.', enTienda: false }, 'u-admin');
    assert.equal(r3.cambio, true, 'apagarlo es otra versión');
    assert.equal((await pool.query('SELECT count(*)::int n FROM aviso_promociones WHERE negocio_id=$1', [neg.id])).rows[0].n, 3);
    await rechaza(aviso.guardarAviso(neg.id, { texto: '   ', enTienda: true }), 'TEXTO_VACIO');
    await rechaza(aviso.guardarAviso(neg.id, { texto: 'x'.repeat(301), enTienda: true }), 'TEXTO_LARGO');
    await rechaza(aviso.guardarAviso(neg.id, { texto: 'Hola', enTienda: 'si' }), 'EN_TIENDA_INVALIDO');
    const panel = await aviso.avisoParaPanel(neg.id);
    assert.equal(panel.vigente.enTienda, false);
    assert.equal(panel.historial.length, 3);
    assert.match(panel.porOmision, /^Al pedir aceptas recibir promociones de Tacos Prueba;/);
    assert.equal(panel.maxTexto, 300);
  });

  await caso('A3 apagado por el administrador se queda apagado: no se vuelve a sembrar', async () => {
    const neg = await negocio();
    await aviso.asegurarAvisoInicial();
    const v = await aviso.avisoVigente(neg.id);
    await aviso.guardarAviso(neg.id, { texto: v.texto, enTienda: false }, 'u-admin');
    await aviso.asegurarAvisoInicial();
    assert.equal((await aviso.avisoVigente(neg.id)).enTienda, false);
    assert.equal(await aviso.avisoParaTienda(neg.id), null);
  });

  await caso('A4 la tienda nunca falla por el aviso: encendido da { id, texto }; apagado, sin aviso o con error, null', async () => {
    const neg = await negocio();
    assert.equal(await aviso.avisoParaTienda(neg.id), null, 'sin versión todavía');
    const id = await versionCon(neg, { texto: 'Promos <b>sí</b>', cuando: haceMin(1) });
    assert.deepEqual(await aviso.avisoParaTienda(neg.id), { id, texto: 'Promos <b>sí</b>' });
    const orig = console.error; console.error = () => {};
    try { assert.equal(await aviso.avisoParaTienda('no-es-uuid'), null); } finally { console.error = orig; }
  });

  // ── C. La aceptación al pedir ──────────────────────────────────────────────
  await caso('C1 pedir en la tienda con el aviso a la vista deja «aceptó», con folio, versión y la hora del pedido; una sola vez', async () => {
    const neg = await negocio();
    const v = await versionCon(neg, { cuando: haceMin(60) });
    const c = await cliente(neg);
    const hora = haceMin(30);
    const f1 = await pedido(neg, c.telefono, { cuando: hora });
    await pedido(neg, c.telefono, { cuando: haceMin(10) });
    await aviso.registrarAceptacionesTienda();
    const r = await filas(neg, c);
    assert.equal(r.length, 1);
    assert.equal(r[0].otorgado, true); assert.equal(r[0].fuente, 'tienda_pedido');
    assert.equal(r[0].referencia, f1, 'el primer pedido con el aviso');
    assert.equal(r[0].aviso_id, v);
    assert.ok(Math.abs(new Date(r[0].created_at) - hora) < 1000, `fecha del pedido: ${r[0].created_at.toISOString()} vs ${hora.toISOString()}`);
    assert.equal(await aviso.registrarAceptacionesTienda(), 0, 'idempotente');
    const vig = await consentimientosVigentes(neg.id, c.id);
    assert.equal(vig.whatsapp.estado, 'acepto'); assert.equal(vig.whatsapp.fuente, 'tienda_pedido');
    // El teléfono en formato WhatsApp (521…) también es el mismo cliente.
    const c2 = await cliente(neg);
    await pedido(neg, `521${c2.telefono}`, { cuando: haceMin(5) });
    await aviso.registrarAceptacionesTienda();
    assert.equal((await filas(neg, c2)).length, 1);
  });

  await caso('C2 un pedido anterior al aviso no deja nada; la versión de cada pedido es la que estaba a la vista', async () => {
    const neg = await negocio();
    const antes = await cliente(neg); const entre = await cliente(neg); const despues = await cliente(neg);
    await pedido(neg, antes.telefono, { cuando: haceMin(120) });
    const v1 = await versionCon(neg, { texto: 'Versión uno', cuando: haceMin(100) });
    await pedido(neg, entre.telefono, { cuando: haceMin(80) });
    const v2 = await versionCon(neg, { texto: 'Versión dos', cuando: haceMin(60) });
    await pedido(neg, despues.telefono, { cuando: haceMin(40) });
    await aviso.registrarAceptacionesTienda();
    assert.deepEqual(await filas(neg, antes), []);
    assert.equal((await filas(neg, entre))[0].aviso_id, v1);
    assert.equal((await filas(neg, despues))[0].aviso_id, v2);
  });

  await caso('C3 pedir NO deshace una baja ni duplica una aceptación de la cuenta', async () => {
    const neg = await negocio();
    await versionCon(neg, { cuando: haceMin(60) });
    const baja = await cliente(neg); const acepto = await cliente(neg);
    await anotar(neg, baja, false, 'campana_boton_baja', haceMin(50));
    await anotar(neg, acepto, true, 'mi_cuenta', haceMin(50));
    await pedido(neg, baja.telefono, { cuando: haceMin(20) });
    await pedido(neg, acepto.telefono, { cuando: haceMin(20) });
    await aviso.registrarAceptacionesTienda();
    assert.deepEqual((await filas(neg, baja)).map((x) => [x.otorgado, x.fuente]), [[false, 'campana_boton_baja']]);
    assert.deepEqual((await filas(neg, acepto)).map((x) => [x.otorgado, x.fuente]), [[true, 'mi_cuenta']]);
    assert.equal((await consentimientosVigentes(neg.id, baja.id)).whatsapp.estado, 'baja');
  });

  await caso('C4 con el aviso apagado al pedir no hay aceptación; encendido otra vez, el pedido siguiente sí', async () => {
    const neg = await negocio();
    await versionCon(neg, { cuando: haceMin(100) });
    await versionCon(neg, { enTienda: false, cuando: haceMin(80) });
    const c = await cliente(neg);
    await pedido(neg, c.telefono, { cuando: haceMin(60) });
    await aviso.registrarAceptacionesTienda();
    assert.deepEqual(await filas(neg, c), []);
    const v3 = await versionCon(neg, { cuando: haceMin(40) });
    const f = await pedido(neg, c.telefono, { cuando: haceMin(20) });
    await aviso.registrarAceptacionesTienda();
    const r = await filas(neg, c);
    assert.equal(r.length, 1); assert.equal(r[0].referencia, f); assert.equal(r[0].aviso_id, v3);
  });

  await caso('C5 solo cuenta pedir de verdad en la tienda: ni otro canal, ni cancelado, ni pendiente de pago (hasta que se paga)', async () => {
    const neg = await negocio();
    await versionCon(neg, { cuando: haceMin(100) });
    const wa = await cliente(neg); const can = await cliente(neg); const pend = await cliente(neg);
    await pedido(neg, wa.telefono, { canal: 'whatsapp', cuando: haceMin(50) });
    await pedido(neg, wa.telefono, { canal: 'presencial', cuando: haceMin(50) });
    await pedido(neg, can.telefono, { estado: 'cancelado', cuando: haceMin(50) });
    const fp = await pedido(neg, pend.telefono, { estado: 'pendiente_pago', cuando: haceMin(50) });
    await aviso.registrarAceptacionesTienda();
    for (const c of [wa, can, pend]) assert.deepEqual(await filas(neg, c), []);
    await pool.query(`UPDATE pedidos_activos SET estado='nuevo' WHERE folio=$1`, [fp]);
    await aviso.registrarAceptacionesTienda();
    assert.equal((await filas(neg, pend))[0]?.referencia, fp, 'pagado dentro de la ventana: se anota');
  });

  await caso('C6 dentro del negocio: el mismo teléfono en otro negocio no recibe la aceptación', async () => {
    const a = await negocio(); const b = await negocio();
    await versionCon(a, { cuando: haceMin(60) }); await versionCon(b, { cuando: haceMin(60) });
    const t = tel();
    const enA = await cliente(a, t); const enB = await cliente(b, t);
    await pedido(a, t, { cuando: haceMin(20) });
    await aviso.registrarAceptacionesTienda();
    assert.equal((await filas(a, enA)).length, 1);
    assert.deepEqual(await filas(b, enB), []);
  });

  await caso('C7 dos servidores reconciliando a la vez dejan una sola aceptación', async () => {
    const neg = await negocio();
    await versionCon(neg, { cuando: haceMin(60) });
    const cs = [];
    for (let i = 0; i < 6; i++) { const c = await cliente(neg); cs.push(c); await pedido(neg, c.telefono, { cuando: haceMin(30 - i) }); }
    await Promise.all([aviso.registrarAceptacionesTienda(), aviso.registrarAceptacionesTienda(), aviso.registrarAceptacionesTienda()]);
    for (const c of cs) assert.equal((await filas(neg, c)).length, 1);
  });

  await caso('C8 fuera de la ventana no se mira (pedidos viejos no se recorren cada 5 min)', async () => {
    const neg = await negocio();
    await versionCon(neg, { cuando: new Date(Date.now() - 5 * 86400000) });
    const c = await cliente(neg);
    await pedido(neg, c.telefono, { cuando: new Date(Date.now() - 3 * 86400000) });
    await aviso.registrarAceptacionesTienda();
    assert.deepEqual(await filas(neg, c), []);
    await aviso.registrarAceptacionesTienda('4 days');
    assert.equal((await filas(neg, c)).length, 1, 'con una ventana mayor sí');
  });

  // ── L. La Lista ────────────────────────────────────────────────────────────
  await caso('L1 tarjeta y filtro con los tres estados: aceptaron, se dieron de baja y sin dato', async () => {
    const neg = await negocio();
    const a = await cliente(neg); const b1 = await cliente(neg); const b2 = await cliente(neg); const s = await cliente(neg);
    const vuelve = await cliente(neg);
    await anotar(neg, a, true, 'tienda_pedido');
    await anotar(neg, b1, false, 'campana_boton_baja'); await anotar(neg, b2, false, 'meta_131050');
    // Aceptó y luego se dio de baja: cuenta como baja (la fila más reciente).
    await anotar(neg, vuelve, true, 'mi_cuenta', haceMin(60)); await anotar(neg, vuelve, false, 'campana_boton_baja', haceMin(1));
    const r = await crm.resumenClientesCrm(neg.id);
    assert.deepEqual([r.consent_whatsapp, r.consent_whatsapp_baja, r.consent_whatsapp_sin_dato], [1, 3, 1]);
    const ids = async (estado) => (await crm.listarClientesCrm(neg.id, { consent_wa_estado: estado })).clientes.map((x) => x.id).sort();
    assert.deepEqual(await ids('acepto'), [a.id]);
    assert.deepEqual(await ids('baja'), [b1.id, b2.id, vuelve.id].sort());
    assert.deepEqual(await ids('sin_dato'), [s.id]);
    assert.equal((await crm.listarClientesCrm(neg.id, { consent_wa_estado: "x' OR 1=1 --" })).total, 5, 'un valor desconocido no filtra');
    const fila = (await crm.listarClientesCrm(neg.id, { consent_wa_estado: 'baja' })).clientes[0];
    assert.equal(fila.consentWhatsappEstado, 'baja');
  });

  await caso('L2 la ficha dice el estado, la fecha y de dónde salió', async () => {
    const neg = await negocio();
    const c = await cliente(neg); const s = await cliente(neg);
    await anotar(neg, c, true, 'tienda_pedido', haceMin(30));
    const f = await crm.fichaClienteCrm(neg.id, c.id);
    assert.equal(f.consentimientos.whatsapp.estado, 'acepto');
    assert.equal(f.consentimientos.whatsapp.fuente, 'tienda_pedido');
    assert.ok(f.consentimientos.whatsapp.fecha);
    assert.equal(f.consentimientos.email.estado, 'sin_dato');
    assert.deepEqual((await crm.fichaClienteCrm(neg.id, s.id)).consentimientos.whatsapp, { otorgado: false, estado: 'sin_dato', fecha: null, fuente: null });
  });

  // ── R. Rutas ───────────────────────────────────────────────────────────────
  const sesion = await negocio({ titular: 'Sesión Tacos' });
  const ajeno = await negocio({ titular: 'Ajeno' });
  const llamadas = [];
  const app = express();
  app.use(express.json());
  const requireAdminSeguro = (req, res, next) => {
    if (req.get('x-rol') !== 'admin') return res.status(403).json({ error: 'Permiso insuficiente' });
    req.negocioId = sesion.id; req.usuarioId = 'u-sesion'; next();
  };
  registrarRutasAvisoPromociones(app, { requireAdminSeguro, servicio: {
    leer: async (nid) => { llamadas.push(['leer', nid]); if (app.locals.romper) throw new Error('relation secreta no existe'); return aviso.avisoParaPanel(nid); },
    guardar: async (nid, d, quien) => { llamadas.push(['guardar', nid, d, quien]); return aviso.guardarAviso(nid, d, quien); },
  } });
  // La tienda pública, con las rutas reales y middlewares de paso.
  const paso = (req, res, next) => next();
  registrarRutasTienda(app, { requireAuthSeguro: paso, requireModulo: () => paso, requireModuloAlguno: () => paso });
  const servidor = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const pedir = (metodo, ruta, cuerpo, { rol = 'admin' } = {}) => fetch(base + ruta, {
    method: metodo, headers: { 'content-type': 'application/json', ...(rol ? { 'x-rol': rol } : {}) },
    body: metodo === 'GET' ? undefined : JSON.stringify(cuerpo || {}),
  });
  const RUTA = '/api/admin/clientes/aviso-promociones';
  try {
    await caso('R1 el operador o sin sesión: 403 y el servicio ni se entera', async () => {
      for (const rol of ['staff', null]) {
        for (const m of ['GET', 'PUT']) {
          const r = await pedir(m, RUTA, { texto: 'x', enTienda: true }, { rol });
          assert.equal(r.status, 403, `${m} ${rol}`);
        }
      }
      assert.deepEqual(llamadas, []);
    });

    await caso('R2 el negocio sale de la sesión, nunca del cuerpo; guardar responde la versión nueva y el historial', async () => {
      const r = await pedir('PUT', `${RUTA}?negocioId=${ajeno.id}`, { texto: 'Aviso de la sesión', enTienda: true, negocioId: ajeno.id, negocio_id: ajeno.id });
      assert.equal(r.status, 200);
      const d = await r.json();
      assert.equal(d.ok, true); assert.equal(d.cambio, true);
      assert.equal(d.vigente.texto, 'Aviso de la sesión');
      assert.equal(d.historial[0].texto, 'Aviso de la sesión');
      assert.equal(llamadas.find((x) => x[0] === 'guardar')[1], sesion.id);
      assert.equal(llamadas.find((x) => x[0] === 'guardar')[3], 'u-sesion');
      assert.notEqual((await aviso.avisoVigente(ajeno.id))?.texto, 'Aviso de la sesión');
      const g = await (await pedir('GET', RUTA)).json();
      assert.equal(g.vigente.texto, 'Aviso de la sesión');
      assert.match(g.porOmision, /Sesión Tacos/);
    });

    await caso('R3 errores: 400 con el motivo; 500 sin detalles internos', async () => {
      const r = await pedir('PUT', RUTA, { texto: '', enTienda: true });
      assert.equal(r.status, 400);
      assert.equal((await r.json()).codigo, 'TEXTO_VACIO');
      app.locals.romper = true;
      const orig = console.error; console.error = () => {};
      try {
        const r2 = await pedir('GET', RUTA);
        assert.equal(r2.status, 500);
        assert.ok(!/secreta|relation/.test(await r2.text()));
      } finally { console.error = orig; app.locals.romper = false; }
    });

    await caso('R4 la tienda pública entrega el aviso encendido y null si está apagado', async () => {
      await aviso.guardarAviso(sesion.id, { texto: 'Al pedir aceptas <promos>', enTienda: true }, 'u');
      const r = await fetch(`${base}/api/tienda/${sesion.slug}`);
      assert.equal(r.status, 200, await r.clone().text());
      const d = await r.json();
      assert.equal(d.avisoPromociones.texto, 'Al pedir aceptas <promos>');
      assert.equal(d.avisoPromociones.id, (await aviso.avisoVigente(sesion.id)).id);
      await aviso.guardarAviso(sesion.id, { texto: 'Al pedir aceptas <promos>', enTienda: false }, 'u');
      assert.equal((await (await fetch(`${base}/api/tienda/${sesion.slug}`)).json()).avisoPromociones, null);
    });
  } finally {
    await new Promise((ok) => servidor.close(ok));
  }

  // ── P. Panel, tienda y servidor ────────────────────────────────────────────
  await caso('P1 la tienda pinta el aviso escapado, junto al botón de pedir y nunca con el pedido mínimo sin cubrir', () => {
    const html = leer('panel/tienda.html');
    const esc = html.match(/^const esc = s => .*$/m)?.[0];
    const fn = html.match(/^function avisoPromocionesHtml\(\) \{[\s\S]*?^\}/m)?.[0];
    assert.ok(esc && fn, 'falta esc o avisoPromocionesHtml en tienda.html');
    const ctx = { TIENDA: { avisoPromociones: { texto: '<img src=x onerror=alert(1)> & "promos"' } } };
    vm.runInNewContext(`${esc}\n${fn}\nthis.salida = avisoPromocionesHtml();`, ctx);
    assert.equal(ctx.salida, '<div class="aviso-promos" id="aviso-promos">&lt;img src=x onerror=alert(1)&gt; &amp; &quot;promos&quot;</div>');
    const vacio = { TIENDA: { avisoPromociones: null } };
    vm.runInNewContext(`${esc}\n${fn}\nthis.salida = avisoPromocionesHtml();`, vacio);
    assert.equal(vacio.salida, '');
    // Va en las dos ramas del botón (pago en línea y pagar al recibir), no en la del mínimo.
    const pie = html.match(/\$\('ck-pie'\)\.innerHTML = bloqueoMinimo[\s\S]*?;\n\}/)?.[0] || '';
    assert.match(pie, /: \(enLinea && metodo\.proveedorNombre[\s\S]*\) \+ avisoPromocionesHtml\(\);/);
    assert.match(leer('src/services/tiendaRutasCore.js'), /avisoPromociones: await avisoParaTienda\(tienda\.negocioId\),/);
  });

  await caso('P2 el panel carga clientes-consentimiento.js con su huella; filtro, tarjeta, ficha y botón con los tres estados', () => {
    const panel = leer('panel/index.html');
    const js = readFileSync(new URL('../panel/clientes-consentimiento.js', import.meta.url));
    const huella = createHash('sha256').update(js).digest('hex').slice(0, 8);
    const m = panel.match(/<script src="\/clientes-consentimiento\.js\?v=([0-9a-f]+)"><\/script>/);
    assert.ok(m, 'el panel no carga /clientes-consentimiento.js');
    assert.equal(m[1], huella, `panel: actualiza la etiqueta a ?v=${huella}`);
    const texto = js.toString('utf8');
    assert.ok(!/onclick=/i.test(texto), 'sin onclick en línea');
    assert.deepEqual([...texto.matchAll(/window\.(\w+)\s*=(?!=)/g)].map((x) => x[1]), ['XaborClientesConsentimiento']);
    assert.deepEqual([...new Set([...texto.matchAll(/'(\/api\/[^']+)'/g)].map((x) => x[1]))], ['/api/admin/clientes/aviso-promociones']);
    // Lo que escribió una persona (el aviso y sus versiones) va siempre escapado.
    assert.match(texto, /\$\{esc\(texto\)\}<\/textarea>/);
    assert.match(texto, /<div>\$\{esc\(h\.texto\)\}<\/div>/);
    assert.ok(!/\$\{(texto|h\.texto|v\.texto)\}/.test(texto), 'un texto sin escapar');
    assert.match(panel, /data-cpr-acc="aviso"/);
    for (const [valor, filtro] of [['consent_wa', 'acepto'], ['consent_wa_baja', 'baja'], ['consent_wa_sin_dato', 'sin_dato']]) {
      assert.match(panel, new RegExp(`<option value="${valor}">Promos por WhatsApp: `));
      assert.match(panel, new RegExp(`${valor}:'consent_wa_estado=${filtro}'`));
    }
    assert.match(panel, /id="cli-tarjeta-promos"[\s\S]{0,400}Aceptaron[\s\S]{0,300}Se dieron de baja[\s\S]{0,300}Sin dato/);
    assert.match(panel, /tienda_pedido: 'al pedir en la tienda'/);
    // La columna «Promos» de la Lista también distingue la baja.
    assert.match(panel, /WA\$\{c\.consentWhatsappEstado === 'baja' \? ' ⛔' : c\.consentWhatsapp \? ' ✓' : ''\}/);
    assert.match(panel, /campana_boton_baja: 'tocó «Detener promociones»'/);
  });

  await caso('P3 el servidor registra las rutas como admin y encadena aviso y aceptaciones después de dar de alta clientes', () => {
    const srv = leer('src/server.js');
    assert.match(srv, /registrarRutasAvisoPromociones\(app, \{ requireAdminSeguro \}\);/);
    const cadena = srv.match(/const reconciliarCrm = \(\) =>[\s\S]*?\.catch\(/)?.[0] || '';
    const iClientes = cadena.indexOf('reconciliarClientesDesdePedidos()');
    const iAviso = cadena.indexOf('asegurarAvisoInicial()');
    const iAcepta = cadena.indexOf('registrarAceptacionesTienda()');
    assert.ok(iClientes > 0 && iAviso > iClientes && iAcepta > iAviso, 'orden: clientes → aviso → aceptaciones');
    const rutas = leer('src/services/avisoPromocionesRutas.js');
    assert.equal([...rutas.matchAll(/app\.(get|put|post|patch|delete)\(/g)].length, 2);
    assert.equal([...rutas.matchAll(/app\.(get|put)\('[^']+', requireAdminSeguro,/g)].length, 2, 'las dos rutas con requireAdminSeguro');
    assert.ok(!/req\.(body|query|params)\.negocio/i.test(rutas), 'el negocio nunca sale de la petición');
  });

  console.log(`Consentimiento de promociones: ${n} pasadas, ${fallidas} fallidas. Base local; sin red externa ni teléfonos reales.`);
  if (fallidas) process.exitCode = 1;
} finally {
  await pool.end();
}
