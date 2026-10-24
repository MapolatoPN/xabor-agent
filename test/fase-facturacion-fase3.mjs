// Facturación, fase 3: la factura global la hace Xabor, a mano (decisiones de
// Mario del 23-oct). Esta suite fija:
//   A. el mes: en la zona del negocio, terminado y desde `global_desde`;
//   B. qué entra y qué no, con su motivo, y solo del negocio;
//   C. el timbrado: una global por forma de pago con exactamente los tickets
//      elegidos; la misma solicitud no timbra dos veces; un ticket nunca está
//      en dos globales vivas; el recibo que falta se crea con la fecha de la venta;
//   D. las fallas: rechazo libera los tickets; sin respuesta queda por
//      conciliar y se concilia con lo que dice Facturapi;
//   E. la forma de pago de cada recibo y su configuración;
//   F. CFDI del negocio y rutas solo para el administrador;
//   G. el panel (totales en vivo, pestaña y configuración) y el predeploy.
// Facturapi es un simulado dentro del proceso: nada sale a la red.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.ok(process.env.DATABASE_URL, 'DATABASE_URL requerida');
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname), 'solo base local');
assert.ok(process.env.INTEGRATIONS_ENCRYPTION_KEY, 'INTEGRATIONS_ENCRYPTION_KEY requerida');
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const leer = (r) => readFileSync(join(RAIZ, r), 'utf8');

const express = (await import('express')).default;
const { pool } = await import('../src/services/database.js');
const { guardarCredencialesFacturapi } = await import('../src/services/integracionesService.js');
const fs = await import('../src/services/facturacionService.js');
const fg = await import('../src/services/facturaGlobal.js');
const formas = await import('../src/services/formaPagoSat.js');
const docs = await import('../src/services/facturacionDocumentos.js');
const ritmo = await import('../src/services/facturapiRitmo.js');
const { zonaHorariaNegocio } = await import('../src/services/cortesCaja.js');

let pasadas = 0; const fallos = [];
async function t(nombre, fn) {
  ritmo._reiniciarRitmoFacturapi();
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallos.push(`${nombre}: ${e.message}`); }
}

// ── Facturapi simulado ──────────────────────────────────────────────────────
const llamadas = [];
let nGlobal = 0, nRecibo = 0;
let responderGlobal = null;            // (body, n) → { status, body } | { timeout: true }
let estadoRecibo = (id) => ({ id, status: 'open' });
let reciboNuevo = () => ({});          // (body) → campos que cambian en el recibo creado, o { rechazo }
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith('https://www.facturapi.io/')) return fetchOriginal(url, init);
  const ruta = u.replace('https://www.facturapi.io/v2', '');
  const metodo = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : null;
  llamadas.push({ ruta: `${metodo} ${ruta}`, body });
  const json = (status, b) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
  if (metodo === 'POST' && ruta === '/receipts/global-invoice') {
    nGlobal += 1;
    const r = responderGlobal ? responderGlobal(body, nGlobal) : null;
    if (r?.timeout) { const e = new Error('agotado'); e.name = 'TimeoutError'; throw e; }
    if (r) return json(r.status, r.body);
    return json(200, { id: `glob${String(nGlobal).padStart(4, '0')}`, uuid: `UUID-GLOBAL-${nGlobal}`, total: 0, series: 'G', folio_number: nGlobal });
  }
  if (metodo === 'POST' && ruta === '/receipts') {
    nRecibo += 1;
    const cambio = reciboNuevo(body);
    if (cambio.rechazo) return json(400, { message: cambio.rechazo });
    return json(200, { id: `recnuevo${nRecibo}`, key: `k${nRecibo}`, self_invoice_url: `https://factura.space/x/${nRecibo}`,
      status: 'open', total: body.items[0].product.price, payment_form: body.payment_form, date: body.date || null, ...cambio });
  }
  if (metodo === 'GET' && ruta.startsWith('/receipts/')) return json(200, estadoRecibo(ruta.split('/receipts/')[1]));
  if (metodo === 'GET' && ruta.startsWith('/invoices/')) {
    const id = ruta.split('/invoices/')[1];
    return json(200, { id, uuid: `UUID-${id}`, total: 100, series: 'G', folio_number: 7 });
  }
  return json(404, { message: 'no simulado' });
};
const globalesLlamadas = () => llamadas.filter((l) => l.ruta === 'POST /receipts/global-invoice');

// ── Negocios, configuración y ventas de prueba ──────────────────────────────
const { rows: negs } = await pool.query('SELECT id FROM negocios WHERE slug IS NOT NULL ORDER BY created_at LIMIT 2');
const NEG = negs[0].id, NEG_B = negs[1].id;
const TZ = await zonaHorariaNegocio(NEG);
const P = 'XAB-F3';
const { rows: [cfgPrevia] } = await pool.query(
  `SELECT *, to_char(global_desde, 'YYYY-MM-DD') AS global_desde_txt FROM facturacion_configuracion WHERE negocio_id=$1`, [NEG]);
const { rows: [moduloPrevio] } = await pool.query(`SELECT estado FROM negocio_modulos WHERE negocio_id=$1 AND modulo='facturacion'`, [NEG]);
const { rows: integPrevias } = await pool.query(`SELECT id, estado, activo FROM integraciones_canal WHERE canal='facturacion' AND proveedor='facturapi'`);
const { rows: [previaNeg] } = await pool.query(`SELECT id FROM integraciones_canal WHERE canal='facturacion' AND proveedor='facturapi' AND negocio_id=$1`, [NEG]);
// El mes anterior y el actual, en la zona del negocio.
const { rows: [MES] } = await pool.query(
  `SELECT extract(year FROM d)::int AS anio, extract(month FROM d)::int AS mes, to_char(d, 'YYYY-MM') AS ym,
          to_char(d + interval '1 month' - interval '1 day', 'YYYY-MM-DD') AS ultimo,
          to_char(d + interval '1 month', 'YYYY-MM') AS ym_sig,
          extract(year FROM d + interval '1 month')::int AS anio_sig, extract(month FROM d + interval '1 month')::int AS mes_sig
     FROM (SELECT date_trunc('month', now() AT TIME ZONE $1) - interval '1 month' AS d) x`, [TZ]);

async function limpiar() {
  await pool.query(`DELETE FROM facturacion_globales WHERE negocio_id = ANY($1::uuid[])`, [[NEG, NEG_B]]);
  await pool.query(`DELETE FROM facturacion_bitacora WHERE negocio_id=$1 AND accion IN ('timbrar_global','global_rechazada')`, [NEG]);
  await pool.query(`DELETE FROM facturacion_recibos WHERE folio LIKE $1`, [`${P}%`]);
  await pool.query(`DELETE FROM facturas_pedido WHERE folio LIKE $1`, [`${P}%`]);
  await pool.query(`DELETE FROM pedidos_activos WHERE folio LIKE $1`, [`${P}%`]);
}
// Venta a una hora local del negocio ('AAAA-MM-DD HH:MI').
async function venta(sufijo, { local = `${MES.ym}-10 13:00`, total = 200, forma = 'efectivo', canal = 'pos', estado = 'entregado', negocio = NEG, extra = {} } = {}) {
  const folio = `${P}-${sufijo}`;
  await pool.query(
    `INSERT INTO pedidos_activos (negocio_id, folio, estado, datos, created_at)
     VALUES ($1,$2,$3,$4::jsonb, ($5::timestamp AT TIME ZONE $6) AT TIME ZONE 'UTC')`,
    [negocio, folio, estado, JSON.stringify({ total, forma_pago: forma, canal, pago_confirmado: true, cliente: { nombre: `Cliente ${sufijo}` }, ...extra }), local, TZ]);
  return folio;
}
async function recibo(folio, { estado = 'abierto', total = 200, forma = null, reciboId = null, facturaId = null, negocio = NEG } = {}) {
  await pool.query(
    `INSERT INTO facturacion_recibos (negocio_id, folio, recibo_id, estado, total, idempotency_key, factura_id, forma_pago)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [negocio, folio, reciboId === false ? null : (reciboId || `rec_${folio}`), estado, total, `${negocio}:${folio}`, facturaId, forma]);
}
const candidatos = async (negocio = NEG, periodo = MES) => fg.candidatosGlobal(negocio, { anio: periodo.anio, mes: periodo.mes });
const mias = (r) => r.ventas.filter((v) => v.folio.startsWith(P));
const ponerConfig = (campos = {}) => pool.query(
  `UPDATE facturacion_configuracion SET global_desde=$2::date, forma_tarjeta=$3, forma_mixto=$4, forma_rappi=$5, global_incluir_rappi=$6
    WHERE negocio_id=$1`,
  [NEG, campos.globalDesde || '2020-01-01', campos.tarjeta || '28', campos.mixto || 'por_definir', campos.rappi ?? null, campos.incluirRappi ?? true]);
let nSolicitud = 0;
const solicitud = () => `prueba-f3-${Date.now()}-${++nSolicitud}`;
const ACTOR = { usuarioId: 'u-admin', rol: 'admin' };
const esperaError = async (p, codigo) => {
  const e = await p.then(() => null, (x) => x);
  assert.ok(e, `se esperaba ${codigo}`);
  assert.equal(e.codigo, codigo, `${e.codigo}: ${e.message}`);
  return e;
};

try {
  await limpiar();
  await pool.query(`INSERT INTO facturacion_configuracion (negocio_id, iva_tasa, autoemitir_recibo) VALUES ($1, 0.08, false)
                    ON CONFLICT (negocio_id) DO UPDATE SET iva_tasa=0.08, autoemitir_recibo=false`, [NEG]);
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'facturacion','activo')
                    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [NEG]);
  await guardarCredencialesFacturapi(NEG, 'sk_test_fase3_00000000000', null);
  await ponerConfig();

  // ── A. El mes ────────────────────────────────────────────────────────────
  await t('A1. un mes anterior a la global de Xabor es del contador: se ve, no se timbra', async () => {
    await limpiar();
    await ponerConfig({ globalDesde: `${MES.ym_sig}-01` });
    const f = await venta('A1'); await recibo(f);
    const c = await candidatos();
    assert.equal(c.periodo.del_contador, true); assert.equal(c.periodo.disponible, false);
    const antes = llamadas.length;
    await esperaError(fg.emitirGlobal(NEG, { anio: MES.anio, mes: MES.mes, folios: [f], solicitud: solicitud() }, ACTOR), 'PERIODO_DEL_CONTADOR');
    assert.equal(llamadas.length, antes, 'llamó a Facturapi');
    await ponerConfig();
  });

  await t('A2. el mes en curso no se timbra', async () => {
    await limpiar();
    const actual = { anio: MES.anio_sig, mes: MES.mes_sig };
    const c = await candidatos(NEG, actual);
    assert.equal(c.periodo.terminado, false); assert.equal(c.periodo.disponible, false);
    await esperaError(fg.emitirGlobal(NEG, { ...actual, folios: ['XAB-0001'], solicitud: solicitud() }, ACTOR), 'PERIODO_ABIERTO');
  });

  await t('A3. el mes se corta a medianoche en la zona del negocio', async () => {
    await limpiar();
    await venta('A3-PRIMERO', { local: `${MES.ym}-01 00:10` });
    await venta('A3-ULTIMO', { local: `${MES.ultimo} 23:30` });
    await venta('A3-SIGUIENTE', { local: `${MES.ym_sig}-01 00:30` });
    const folios = mias(await candidatos()).map((v) => v.folio);
    assert.ok(folios.includes(`${P}-A3-PRIMERO`), 'falta el del día 1 a las 00:10');
    assert.ok(folios.includes(`${P}-A3-ULTIMO`), 'falta el del último día a las 23:30');
    assert.ok(!folios.includes(`${P}-A3-SIGUIENTE`), 'entró una venta del mes siguiente');
  });

  // ── B. Qué entra ─────────────────────────────────────────────────────────
  await t('B1. cada exclusión con su motivo; lo demás entra marcado', async () => {
    await limpiar();
    const casos = {
      PRUEBA: await venta('B-PRUEBA', { canal: 'prueba_admin' }),
      CANCELADA: await venta('B-CANCEL', { estado: 'cancelado' }),
      CANCELADA_R: await venta('B-CANCELR'),
      FACTURADA: await venta('B-FACT'),
      FACTURADA_R: await venta('B-FACTR'),
      EN_GLOBAL: await venta('B-GLOB'),
      SIN_COBRAR: await venta('B-COBRO', { estado: 'nuevo', forma: 'por_cobrar', extra: { pago_confirmado: false } }),
      SIN_IMPORTE: await venta('B-CERO', { total: 0 }),
      RECIBO_CON_ERROR: await venta('B-ERR'),
      TOTAL_CAMBIO: await venta('B-TOTAL'),
      FORMA_POR_DEFINIR: await venta('B-MIXTO', { forma: 'mixto', canal: 'restaurante_mesa' }),
      OK: await venta('B-OK'),
    };
    await recibo(casos.CANCELADA_R, { estado: 'cancelado' });
    await pool.query(`INSERT INTO facturas_pedido (negocio_id, folio, factura_id, uuid, total, fuente) VALUES ($1,$2,'fact_b','UUID-B',200,'panel')`, [NEG, casos.FACTURADA]);
    await recibo(casos.FACTURADA_R, { estado: 'facturado', facturaId: 'fact_br' });
    await recibo(casos.EN_GLOBAL, { estado: 'global', facturaId: 'glob_vieja' });
    await recibo(casos.RECIBO_CON_ERROR, { estado: 'error' });
    await recibo(casos.TOTAL_CAMBIO, { total: 150 });
    await recibo(casos.FORMA_POR_DEFINIR);
    await recibo(casos.OK);
    const v = new Map(mias(await candidatos()).map((x) => [x.folio, x]));
    const esperado = { PRUEBA: 'PRUEBA', CANCELADA: 'CANCELADA', CANCELADA_R: 'CANCELADA', FACTURADA: 'FACTURADA', FACTURADA_R: 'FACTURADA',
      EN_GLOBAL: 'EN_GLOBAL', SIN_COBRAR: 'SIN_COBRAR', SIN_IMPORTE: 'SIN_IMPORTE', RECIBO_CON_ERROR: 'RECIBO_CON_ERROR',
      TOTAL_CAMBIO: 'TOTAL_CAMBIO', FORMA_POR_DEFINIR: 'FORMA_POR_DEFINIR' };
    for (const [k, motivo] of Object.entries(esperado)) {
      const fila = v.get(casos[k]);
      assert.ok(fila, `falta ${k}`);
      assert.equal(fila.elegible, false, `${k} entró`);
      assert.equal(fila.motivo, motivo, `${k}: ${fila.motivo}`);
      assert.ok(fila.motivo_texto, `${k} sin texto`);
    }
    const ok = v.get(casos.OK);
    assert.equal(ok.elegible, true); assert.equal(ok.marcado, true); assert.equal(ok.forma, '01'); assert.equal(ok.sin_recibo, false);
  });

  await t('B2. un ticket en una global viva no entra en otra', async () => {
    await limpiar();
    const f = await venta('B2'); await recibo(f);
    const { rows: [g] } = await pool.query(
      `INSERT INTO facturacion_globales (negocio_id, solicitud, desde, hasta, mes, anio, forma_pago, estado, tickets, total)
       VALUES ($1,'viva-0000001',$2::date,$3::date,$4,$5,'01','por_conciliar',1,200) RETURNING id`,
      [NEG, `${MES.ym}-01`, MES.ultimo, String(MES.mes).padStart(2, '0'), MES.anio]);
    await pool.query(`INSERT INTO facturacion_global_recibos (global_id, negocio_id, folio, recibo_id, total) VALUES ($1,$2,$3,$4,200)`, [g.id, NEG, f, `rec_${f}`]);
    const fila = mias(await candidatos()).find((x) => x.folio === f);
    assert.equal(fila.motivo, 'EN_GLOBAL');
  });

  await t('B3. Rappi: su forma configurada; marcado según la configuración', async () => {
    await limpiar();
    await ponerConfig({ rappi: '31', incluirRappi: false });
    const conRecibo = await venta('B3-R1', { canal: 'rappi', forma: '' }); await recibo(conRecibo, { forma: '31' });
    const sinRecibo = await venta('B3-R2', { canal: 'rappi', forma: '' });
    const viejo = await venta('B3-R3', { canal: 'rappi', forma: '' }); await recibo(viejo); // creado con 99
    const v = new Map(mias(await candidatos()).map((x) => [x.folio, x]));
    assert.equal(v.get(conRecibo).elegible, true); assert.equal(v.get(conRecibo).forma, '31'); assert.equal(v.get(conRecibo).marcado, false);
    assert.equal(v.get(sinRecibo).elegible, true); assert.equal(v.get(sinRecibo).sin_recibo, true); assert.equal(v.get(sinRecibo).forma, '31');
    assert.equal(v.get(viejo).motivo, 'FORMA_POR_DEFINIR', 'un recibo viejo conserva su 99');
    await ponerConfig({ rappi: '31', incluirRappi: true });
    assert.equal(mias(await candidatos()).find((x) => x.folio === conRecibo).marcado, true);
    await ponerConfig();
  });

  await t('B4. solo las ventas del negocio', async () => {
    await limpiar();
    const ajena = await venta('B4-AJENA', { negocio: NEG_B }); await recibo(ajena, { negocio: NEG_B });
    const propia = await venta('B4-PROPIA'); await recibo(propia);
    const folios = mias(await candidatos()).map((x) => x.folio);
    assert.ok(folios.includes(propia)); assert.ok(!folios.includes(ajena), 'se coló una venta de otro negocio');
    await esperaError(fg.emitirGlobal(NEG, { anio: MES.anio, mes: MES.mes, folios: [ajena], solicitud: solicitud() }, ACTOR), 'SELECCION_NO_ELEGIBLE');
  });

  // ── C. Timbrado ──────────────────────────────────────────────────────────
  await t('C1. una global por forma de pago con exactamente los tickets elegidos', async () => {
    await limpiar();
    const e1 = await venta('C1-E1', { total: 100 }); await recibo(e1, { total: 100, forma: '01' });
    const e2 = await venta('C1-E2', { total: 50 }); await recibo(e2, { total: 50 });            // legado: efectivo → 01
    const t1 = await venta('C1-T1', { forma: 'terminal', total: 300 }); await recibo(t1, { total: 300, forma: '28' });
    const fuera = await venta('C1-NO'); await recibo(fuera);                                    // elegible, no elegido
    const antes = llamadas.length;
    const r = await fg.emitirGlobal(NEG, { anio: MES.anio, mes: MES.mes, folios: [e1, e2, t1], solicitud: solicitud() }, ACTOR);
    const nuevas = llamadas.slice(antes).filter((l) => l.ruta === 'POST /receipts/global-invoice');
    assert.equal(nuevas.length, 2, `llamadas: ${nuevas.length}`);
    const porForma = new Map(nuevas.map((l) => [l.body.payment_form, l.body]));
    assert.deepEqual([...porForma.get('01').receipts].sort(), [`rec_${e1}`, `rec_${e2}`].sort());
    assert.deepEqual(porForma.get('28').receipts, [`rec_${t1}`]);
    for (const b of nuevas.map((l) => l.body)) {
      assert.equal(b.periodicity, 'month'); assert.equal(b.months, String(MES.mes).padStart(2, '0'));
    }
    assert.equal(r.globales.length, 2);
    assert.ok(r.globales.every((g) => g.estado === 'timbrada' && g.factura_id && g.uuid), JSON.stringify(r.globales));
    const g01 = r.globales.find((g) => g.forma_pago === '01');
    assert.equal(g01.tickets, 2); assert.equal(g01.total, 150);
    const { rows: rec } = await pool.query(`SELECT folio, estado, factura_id FROM facturacion_recibos WHERE folio = ANY($1)`, [[e1, e2, t1, fuera]]);
    const est = new Map(rec.map((x) => [x.folio, x]));
    assert.equal(est.get(e1).estado, 'global'); assert.equal(est.get(e1).factura_id, g01.factura_id);
    assert.equal(est.get(t1).estado, 'global');
    assert.equal(est.get(fuera).estado, 'abierto', 'tocó un ticket no elegido');
    const { rows: [b] } = await pool.query(`SELECT count(*)::int n FROM facturacion_bitacora WHERE negocio_id=$1 AND accion='timbrar_global'`, [NEG]);
    assert.equal(b.n, 2);
  });

  await t('C2. el periodo que se manda es el mes en la zona del negocio', async () => {
    await limpiar();
    const f = await venta('C2'); await recibo(f);
    const antes = llamadas.length;
    await fg.emitirGlobal(NEG, { anio: MES.anio, mes: MES.mes, folios: [f], solicitud: solicitud() }, ACTOR);
    const b = llamadas.slice(antes).find((l) => l.ruta === 'POST /receipts/global-invoice').body;
    const { rows: [lim] } = await pool.query(
      `SELECT ($1::date::timestamp AT TIME ZONE $2) AS ini,
              (($1::date + interval '1 month')::timestamp AT TIME ZONE $2) - interval '1 second' AS fin`, [`${MES.ym}-01`, TZ]);
    assert.equal(b.from, lim.ini.toISOString()); assert.equal(b.to, lim.fin.toISOString());
  });

  await t('C3. la misma solicitud no timbra dos veces, ni en paralelo', async () => {
    await limpiar();
    const f1 = await venta('C3-1'); await recibo(f1);
    const f2 = await venta('C3-2', { forma: 'terminal' }); await recibo(f2, { forma: '28' });
    const sol = solicitud();
    const antes = globalesLlamadas().length;
    const [a, b] = await Promise.all([
      fg.emitirGlobal(NEG, { anio: MES.anio, mes: MES.mes, folios: [f1, f2], solicitud: sol }, ACTOR),
      fg.emitirGlobal(NEG, { anio: MES.anio, mes: MES.mes, folios: [f1, f2], solicitud: sol }, ACTOR),
    ]);
    await fg.emitirGlobal(NEG, { anio: MES.anio, mes: MES.mes, folios: [f1, f2], solicitud: sol }, ACTOR);
    assert.equal(globalesLlamadas().length - antes, 2, 'timbró de más');
    assert.equal(a.globales.length, 2); assert.equal(b.globales.length, 2);
    const { rows: [n] } = await pool.query(`SELECT count(*)::int n FROM facturacion_globales WHERE negocio_id=$1 AND solicitud=$2`, [NEG, sol]);
    assert.equal(n.n, 2);
  });

  await t('C4. dos solicitudes con el mismo ticket: solo una lo timbra', async () => {
    await limpiar();
    const f = await venta('C4'); await recibo(f);
    const antes = globalesLlamadas().length;
    const res = await Promise.allSettled([
      fg.emitirGlobal(NEG, { anio: MES.anio, mes: MES.mes, folios: [f], solicitud: solicitud() }, ACTOR),
      fg.emitirGlobal(NEG, { anio: MES.anio, mes: MES.mes, folios: [f], solicitud: solicitud() }, ACTOR),
    ]);
    assert.equal(res.filter((x) => x.status === 'fulfilled').length, 1, JSON.stringify(res.map((x) => x.reason?.codigo || x.status)));
    assert.ok(['SELECCION_NO_ELEGIBLE', 'SELECCION_CAMBIO', 'TICKET_EN_OTRA_GLOBAL'].includes(res.find((x) => x.status === 'rejected').reason.codigo));
    assert.equal(globalesLlamadas().length - antes, 1);
  });

  await t('C5. un ticket que no puede entrar detiene todo antes de llamar a Facturapi', async () => {
    await limpiar();
    const ok = await venta('C5-OK'); await recibo(ok);
    const mixto = await venta('C5-MIXTO', { forma: 'mixto' }); await recibo(mixto);
    const otroMes = await venta('C5-SIG', { local: `${MES.ym_sig}-02 12:00` }); await recibo(otroMes);
    const antes = llamadas.length;
    const e = await esperaError(fg.emitirGlobal(NEG, { anio: MES.anio, mes: MES.mes, folios: [ok, mixto, otroMes], solicitud: solicitud() }, ACTOR), 'SELECCION_NO_ELEGIBLE');
    const motivos = new Map(e.errores.map((x) => [x.folio, x.motivo]));
    assert.equal(motivos.get(mixto), 'FORMA_POR_DEFINIR'); assert.equal(motivos.get(otroMes.toUpperCase()), 'FUERA_DEL_PERIODO');
    assert.equal(llamadas.length, antes);
    const { rows: [n] } = await pool.query(`SELECT count(*)::int n FROM facturacion_globales WHERE negocio_id=$1`, [NEG]);
    assert.equal(n.n, 0);
  });

  await t('C6. el recibo que falta se crea con la fecha y la forma de la venta antes de la global', async () => {
    await limpiar();
    await ponerConfig({ tarjeta: '04' });
    const f = await venta('C6', { local: `${MES.ym}-15 21:45`, forma: 'tarjeta', total: 420 });
    const antes = llamadas.length;
    const r = await fg.emitirGlobal(NEG, { anio: MES.anio, mes: MES.mes, folios: [f], solicitud: solicitud() }, ACTOR);
    const nuevas = llamadas.slice(antes);
    const crear = nuevas.find((l) => l.ruta === 'POST /receipts');
    assert.ok(crear, 'no creó el recibo');
    assert.equal(crear.body.payment_form, '04');
    const { rows: [vf] } = await pool.query(`SELECT ($1::timestamp AT TIME ZONE $2) AS v`, [`${MES.ym}-15 21:45`, TZ]);
    assert.equal(crear.body.date, vf.v.toISOString());
    assert.ok(nuevas.indexOf(crear) < nuevas.findIndex((l) => l.ruta === 'POST /receipts/global-invoice'), 'la global antes que el recibo');
    assert.equal(r.globales[0].forma_pago, '04'); assert.equal(r.globales[0].estado, 'timbrada');
    const { rows: [rec] } = await pool.query(`SELECT forma_pago, estado FROM facturacion_recibos WHERE folio=$1`, [f]);
    assert.equal(rec.forma_pago, '04'); assert.equal(rec.estado, 'global');
    await ponerConfig();
  });

  await t('C7. la preparación espera el candado del negocio; dos clics de la misma solicitud timbran una vez', async () => {
    await limpiar();
    const f1 = await venta('C7-1'); await recibo(f1);
    const f2 = await venta('C7-2'); await recibo(f2);
    const bloqueo = await pool.connect();
    const llave = `hashtextextended('factura-global:' || $1, 0)`;
    await bloqueo.query(`SELECT pg_advisory_lock(${llave})`, [NEG]);
    const sol = solicitud();
    const antes = globalesLlamadas().length;
    let terminadas = 0;
    const pedidos = [1, 2].map(() => fg.emitirGlobal(NEG, { anio: MES.anio, mes: MES.mes, folios: [f1, f2], solicitud: sol }, ACTOR)
      .finally(() => { terminadas += 1; }));
    await new Promise((r) => setTimeout(r, 400));
    const esperaron = terminadas === 0 && globalesLlamadas().length === antes;
    await bloqueo.query(`SELECT pg_advisory_unlock(${llave})`, [NEG]);
    bloqueo.release();
    const [a, b] = await Promise.all(pedidos);
    assert.ok(esperaron, 'preparó sin esperar el candado');
    assert.equal(globalesLlamadas().length - antes, 1, 'timbró dos veces');
    assert.equal(a.globales[0].id, b.globales[0].id);
    const { rows: [g] } = await pool.query(`SELECT estado, tickets FROM facturacion_globales WHERE id=$1`, [a.globales[0].id]);
    assert.equal(g.estado, 'timbrada'); assert.equal(g.tickets, 2);
  });

  // ── D. Fallas ────────────────────────────────────────────────────────────
  await t('D1. Facturapi rechaza: la global queda en error y sus tickets, libres', async () => {
    await limpiar();
    const f = await venta('D1'); await recibo(f);
    responderGlobal = () => ({ status: 400, body: { message: 'El periodo no coincide', code: 'invalid_period' } });
    const r = await fg.emitirGlobal(NEG, { anio: MES.anio, mes: MES.mes, folios: [f], solicitud: solicitud() }, ACTOR);
    responderGlobal = null;
    assert.equal(r.globales[0].estado, 'error'); assert.match(r.globales[0].error_detalle, /periodo/);
    const fila = mias(await candidatos()).find((x) => x.folio === f);
    assert.equal(fila.elegible, true, `no quedó libre: ${fila.motivo}`);
    const { rows: [rec] } = await pool.query(`SELECT estado FROM facturacion_recibos WHERE folio=$1`, [f]);
    assert.equal(rec.estado, 'abierto');
    const { rows: [b] } = await pool.query(`SELECT count(*)::int n FROM facturacion_bitacora WHERE negocio_id=$1 AND accion='global_rechazada'`, [NEG]);
    assert.equal(b.n, 1);
    const otra = await fg.emitirGlobal(NEG, { anio: MES.anio, mes: MES.mes, folios: [f], solicitud: solicitud() }, ACTOR);
    assert.equal(otra.globales[0].estado, 'timbrada', 'no se pudo volver a intentar');
  });

  await t('D2. sin respuesta: por conciliar, sin reintento a ciegas; se concilia con el recibo', async () => {
    await limpiar();
    const f = await venta('D2'); await recibo(f);
    responderGlobal = () => ({ timeout: true });
    const sol = solicitud();
    const r = await fg.emitirGlobal(NEG, { anio: MES.anio, mes: MES.mes, folios: [f], solicitud: sol }, ACTOR);
    responderGlobal = null;
    const g = r.globales[0];
    assert.equal(g.estado, 'por_conciliar');
    assert.equal(mias(await candidatos()).find((x) => x.folio === f).motivo, 'EN_GLOBAL', 'el ticket quedó libre');
    const antes = globalesLlamadas().length;
    await fg.emitirGlobal(NEG, { anio: MES.anio, mes: MES.mes, folios: [f], solicitud: sol }, ACTOR);
    assert.equal(globalesLlamadas().length, antes, 'reintentó a ciegas');
    estadoRecibo = (id) => ({ id, status: 'open' });
    await esperaError(fg.conciliarGlobal(NEG, g.id, ACTOR), 'GLOBAL_EN_PROCESO');
    estadoRecibo = (id) => ({ id, status: 'invoiced_globally', invoice: 'globtardia01' });
    const c = await fg.conciliarGlobal(NEG, g.id, ACTOR);
    estadoRecibo = (id) => ({ id, status: 'open' });
    assert.equal(c.estado, 'timbrada'); assert.equal(c.factura_id, 'globtardia01'); assert.equal(c.uuid, 'UUID-globtardia01');
    const { rows: [rec] } = await pool.query(`SELECT estado, factura_id FROM facturacion_recibos WHERE folio=$1`, [f]);
    assert.equal(rec.estado, 'global'); assert.equal(rec.factura_id, 'globtardia01');
  });

  await t('D3. sin respuesta y el recibo sigue abierto pasado el margen: error y tickets libres', async () => {
    await limpiar();
    const f = await venta('D3'); await recibo(f);
    responderGlobal = () => ({ status: 503, body: { message: 'caído' } });
    const r = await fg.emitirGlobal(NEG, { anio: MES.anio, mes: MES.mes, folios: [f], solicitud: solicitud() }, ACTOR);
    responderGlobal = null;
    assert.equal(r.globales[0].estado, 'por_conciliar');
    await pool.query(`UPDATE facturacion_globales SET timbrando_at = now() - interval '11 minutes' WHERE id=$1`, [r.globales[0].id]);
    const c = await fg.conciliarGlobal(NEG, r.globales[0].id, ACTOR);
    assert.equal(c.estado, 'error'); assert.equal(c.error_codigo, 'SIN_TIMBRAR');
    assert.equal(mias(await candidatos()).find((x) => x.folio === f).elegible, true);
  });

  await t('D4. Facturapi responde que no hay recibos abiertos: error y libres', async () => {
    await limpiar();
    const f = await venta('D4'); await recibo(f);
    responderGlobal = () => ({ status: 200, body: null });
    const r = await fg.emitirGlobal(NEG, { anio: MES.anio, mes: MES.mes, folios: [f], solicitud: solicitud() }, ACTOR);
    responderGlobal = null;
    assert.equal(r.globales[0].estado, 'error'); assert.equal(r.globales[0].error_codigo, 'SIN_RECIBOS_ABIERTOS');
    assert.equal(mias(await candidatos()).find((x) => x.folio === f).elegible, true);
  });

  await t('D5. un recibo que cambió entre la lista y la preparación detiene todo', async () => {
    await limpiar();
    const ok = await venta('D5-OK'); await recibo(ok);
    const nuevo = await venta('D5-NUEVO');                 // sin recibo: se crea al timbrar…
    reciboNuevo = () => ({ status: 'invoiced_to_customer', invoice: 'fact_d5' }); // …y ya viene facturado
    const antes = globalesLlamadas().length;
    await esperaError(fg.emitirGlobal(NEG, { anio: MES.anio, mes: MES.mes, folios: [ok, nuevo], solicitud: solicitud() }, ACTOR), 'SELECCION_CAMBIO');
    reciboNuevo = () => ({});
    assert.equal(globalesLlamadas().length, antes);
    const { rows: [n] } = await pool.query(`SELECT count(*)::int n FROM facturacion_globales WHERE negocio_id=$1`, [NEG]);
    assert.equal(n.n, 0);
  });

  await t('D6. si no se puede crear un recibo que falta, no se timbra nada', async () => {
    await limpiar();
    const ok = await venta('D6-OK'); await recibo(ok);
    const nuevo = await venta('D6-NUEVO');
    reciboNuevo = () => ({ rechazo: 'fecha fuera de rango' });
    const antes = globalesLlamadas().length;
    const e = await esperaError(fg.emitirGlobal(NEG, { anio: MES.anio, mes: MES.mes, folios: [ok, nuevo], solicitud: solicitud() }, ACTOR), 'RECIBOS_NO_CREADOS');
    reciboNuevo = () => ({});
    assert.equal(e.errores[0].folio, nuevo);
    assert.equal(globalesLlamadas().length, antes);
  });

  // ── E. Forma de pago ─────────────────────────────────────────────────────
  await t('E1. la forma SAT de cada venta según la configuración', async () => {
    const F = (pedido, cfg = {}) => formas.formaPagoSatDeVenta(pedido, cfg);
    assert.equal(F({ forma_pago: 'efectivo' }), '01');
    assert.equal(F({ forma_pago: 'enlace de pago' }), '04');
    assert.equal(F({ forma_pago: 'enlace_pago' }), '04');
    assert.equal(F({ forma_pago: 'terminal' }), '28');
    assert.equal(F({ forma_pago: 'terminal (tarjeta presente)' }), '28');
    assert.equal(F({ forma_pago: 'tarjeta' }), '28');
    assert.equal(F({ forma_pago: 'tarjeta' }, { forma_tarjeta: '04' }), '04');
    assert.equal(F({ forma_pago: 'mixto', pagos: [{ monto: 2498, metodo: 'efectivo' }, { monto: 200, metodo: 'terminal' }] }), '99');
    assert.equal(F({ forma_pago: 'mixto', pagos: [{ monto: 2498, metodo: 'efectivo' }, { monto: 200, metodo: 'terminal' }] }, { forma_mixto: 'mayor' }), '01');
    assert.equal(F({ forma_pago: 'mixto', pagos: [{ monto: 72, metodo: 'efectivo' }, { monto: 251, metodo: 'terminal' }] }, { forma_mixto: 'mayor', forma_tarjeta: '04' }), '04');
    assert.equal(F({ forma_pago: '', canal: 'rappi' }), '99');
    assert.equal(F({ forma_pago: '', canal: 'rappi' }, { forma_rappi: '31' }), '31');
    assert.equal(F({ forma_pago: 'rappi', canal: 'pos' }, { forma_rappi: '03' }), '03');
    assert.equal(formas.formaPagoLegado({ forma_pago: 'tarjeta' }), '99', 'la regla vieja cambió');
  });

  await t('E2. el recibo nuevo lleva la forma decidida y la guarda; manda la de Facturapi', async () => {
    await limpiar();
    await ponerConfig({ rappi: '31' });
    const f = await venta('E2', { canal: 'rappi', forma: '' });
    const antes = llamadas.length;
    const r = await fs.asegurarReciboPedido(NEG, f);
    const crear = llamadas.slice(antes).find((l) => l.ruta === 'POST /receipts');
    assert.equal(crear.body.payment_form, '31'); assert.equal(crear.body.date, undefined, 'un recibo normal no lleva fecha');
    assert.equal(r.forma_pago, '31');
    // Si Facturapi lo guarda con otra forma, manda la de Facturapi.
    const otro = await venta('E2-B', { canal: 'rappi', forma: '' });
    reciboNuevo = () => ({ payment_form: '03' });
    const r2 = await fs.asegurarReciboPedido(NEG, otro);
    reciboNuevo = () => ({});
    assert.equal(r2.forma_pago, '03');
    await ponerConfig();
  });

  await t('E3. la configuración de formas se valida y, si no se manda, se conserva', async () => {
    const base = { ivaTasa: 0.08, autoemitirRecibo: false };
    let c = await fs.guardarConfiguracionFacturacion(NEG, { ...base, formaTarjeta: '04', formaMixto: 'mayor', formaRappi: '31', globalIncluirRappi: false });
    assert.equal(c.forma_tarjeta, '04'); assert.equal(c.forma_mixto, 'mayor'); assert.equal(c.forma_rappi, '31'); assert.equal(c.global_incluir_rappi, false);
    c = await fs.guardarConfiguracionFacturacion(NEG, base);
    assert.equal(c.forma_tarjeta, '04'); assert.equal(c.forma_rappi, '31'); assert.equal(c.global_incluir_rappi, false);
    c = await fs.guardarConfiguracionFacturacion(NEG, { ...base, formaRappi: '' });
    assert.equal(c.forma_rappi, null, '«por definir» no limpió Rappi');
    for (const malo of [{ formaTarjeta: '01' }, { formaMixto: 'menor' }, { formaRappi: '99' }]) {
      const e = await fs.guardarConfiguracionFacturacion(NEG, { ...base, ...malo }).catch((x) => x);
      assert.equal(e?.codigo, 'FORMA_PAGO_INVALIDA', JSON.stringify(malo));
    }
    await ponerConfig();
  });

  // ── F. CFDI y permisos ───────────────────────────────────────────────────
  await t('F1. el PDF y el XML de una global solo para su negocio', async () => {
    await limpiar();
    const f = await venta('F1'); await recibo(f);
    const r = await fg.emitirGlobal(NEG, { anio: MES.anio, mes: MES.mes, folios: [f], solicitud: solicitud() }, ACTOR);
    const g = r.globales[0];
    assert.equal(g.estado, 'timbrada');
    // Solo por la global: sin el recibo que también la nombra.
    await pool.query(`UPDATE facturacion_recibos SET factura_id=NULL WHERE factura_id=$1`, [g.factura_id]);
    assert.equal(await docs.cfdiDelNegocio(NEG, g.factura_id), true);
    assert.equal(await docs.cfdiDelNegocio(NEG_B, g.factura_id), false);
  });

  await t('F2. las rutas de la global son solo del administrador', async () => {
    const app = express(); app.use(express.json());
    const requireAdminSeguro = (req, res, next) => (req.get('x-rol') === 'admin' ? (req.negocioId = NEG, next()) : res.status(403).json({ error: 'solo admin' }));
    const requireModulo = () => (req, res, next) => next();
    fg.registrarRutasFacturaGlobal(app, { requireAdminSeguro, requireModulo, responderError: (res, e) => res.status(e.status || 400).json({ error: e.message, codigo: e.codigo }) });
    const s = app.listen(0); const base = `http://127.0.0.1:${s.address().port}`;
    try {
      const pedir = (metodo, ruta, rol) => fetchOriginal(`${base}${ruta}`, { method: metodo, headers: { 'Content-Type': 'application/json', 'x-rol': rol }, body: metodo === 'POST' ? '{}' : undefined });
      const rutas = [['GET', `/api/admin/facturacion/global/candidatos?anio=${MES.anio}&mes=${MES.mes}`], ['POST', '/api/admin/facturacion/global'],
        ['GET', '/api/admin/facturacion/globales'], ['POST', '/api/admin/facturacion/globales/00000000-0000-0000-0000-000000000000/conciliar']];
      for (const [m, r] of rutas) assert.equal((await pedir(m, r, 'operador')).status, 403, `${m} ${r} abierta al operador`);
      assert.equal((await pedir('GET', rutas[0][1], 'admin')).status, 200);
    } finally { s.close(); }
    assert.match(leer('src/server.js'), /registrarRutasFacturaGlobal\(app, \{ requireAdminSeguro, requireModulo, responderError: responderErrorFacturacion \}\)/);
  });

  // ── G. Panel y predeploy ─────────────────────────────────────────────────
  await t('G1. el panel suma la selección por forma de pago con el IVA incluido', async () => {
    const panel = leer('panel/index.html');
    const codigo = panel.slice(panel.indexOf('function fgResumen'), panel.indexOf('async function facturacionGlobalInicializar'));
    const ctx = {}; vm.createContext(ctx); vm.runInContext(`${codigo}; this.fgResumen = fgResumen;`, ctx);
    const ventas = [
      { folio: 'A', elegible: true, forma: '01', forma_nombre: 'Efectivo', total: 108 },
      { folio: 'B', elegible: true, forma: '01', forma_nombre: 'Efectivo', total: 216 },
      { folio: 'C', elegible: true, forma: '28', forma_nombre: 'Tarjeta de débito', total: 54 },
      { folio: 'D', elegible: false, forma: '99', forma_nombre: 'Por definir', total: 999 },
      { folio: 'E', elegible: true, forma: '28', forma_nombre: 'Tarjeta de débito', total: 1000 },
    ];
    const r = ctx.fgResumen(ventas, new Set(['A', 'B', 'C', 'D']), 0.08);
    assert.equal(r.tickets, 3); assert.equal(r.total, 378);
    assert.deepEqual(JSON.parse(JSON.stringify(r.formas)), [
      { forma: '01', nombre: 'Efectivo', tickets: 2, total: 324, subtotal: 300, iva: 24 },
      { forma: '28', nombre: 'Tarjeta de débito', tickets: 1, total: 54, subtotal: 50, iva: 4 },
    ]);
  });

  await t('G2. pestaña, configuración de formas y predeploy', async () => {
    const panel = leer('panel/index.html');
    assert.match(panel, /data-facturacion-pane="global" onclick="facturacionIr\('global'\)"/);
    assert.match(panel, /<section data-facturacion-section="global" hidden>/);
    assert.equal((panel.match(/\['facturas', 'global', 'clientes', 'configuracion'\]\.includes\(pane\)/g) || []).length, 2, 'la pestaña no se abre por dirección o por clic');
    assert.match(panel, /if \(elegido === 'global'\) facturacionGlobalInicializar\(\);/);
    for (const id of ['fc-forma-tarjeta', 'fc-forma-mixto', 'fc-forma-rappi', 'fc-global-rappi']) assert.match(panel, new RegExp(`id="${id}"`));
    assert.match(panel, /forma_rappi: document\.getElementById\('fc-forma-rappi'\)\?\.value \|\| ''/);
    assert.match(panel, /solicitud: FG\.solicitud/);
    assert.match(leer('scripts/predeploy-run-032-033.mjs'), /'124-factura-global',\n\];/);
    const e = await pool.query(
      `INSERT INTO facturacion_globales (negocio_id, solicitud, desde, hasta, mes, anio, forma_pago, tickets, total)
       VALUES ($1,'forma-99-000001','2026-11-01','2026-11-30','11',2026,'99',1,10)`, [NEG]).catch((x) => x);
    assert.equal(e?.code, '23514', 'aceptó una global con forma 99');
    // La base impide que un ticket esté en dos globales vivas.
    const nueva = async (sol) => (await pool.query(
      `INSERT INTO facturacion_globales (negocio_id, solicitud, desde, hasta, mes, anio, forma_pago, tickets, total)
       VALUES ($1,$2,'2026-11-01','2026-11-30','11',2026,'01',1,10) RETURNING id`, [NEG, sol])).rows[0].id;
    const g1 = await nueva('indice-viva-01'), g2 = await nueva('indice-viva-02');
    await pool.query(`INSERT INTO facturacion_global_recibos (global_id, negocio_id, folio, recibo_id, total) VALUES ($1,$2,'XAB-F3-IDX','r1',10)`, [g1, NEG]);
    const dup = await pool.query(`INSERT INTO facturacion_global_recibos (global_id, negocio_id, folio, recibo_id, total) VALUES ($1,$2,'xab-f3-idx','r1',10)`, [g2, NEG]).catch((x) => x);
    assert.equal(dup?.code, '23505', 'un ticket entró en dos globales vivas');
    await pool.query(`UPDATE facturacion_global_recibos SET vivo=false WHERE global_id=$1`, [g1]);
    await pool.query(`INSERT INTO facturacion_global_recibos (global_id, negocio_id, folio, recibo_id, total) VALUES ($1,$2,'XAB-F3-IDX','r1',10)`, [g2, NEG]);
  });
} finally {
  globalThis.fetch = fetchOriginal;
  await limpiar().catch((e) => console.log('limpieza:', e.message));
  if (cfgPrevia) {
    await pool.query(
      `UPDATE facturacion_configuracion SET iva_tasa=$2, autoemitir_recibo=$3, global_desde=$4::date,
              forma_tarjeta=$5, forma_mixto=$6, forma_rappi=$7, global_incluir_rappi=$8 WHERE negocio_id=$1`,
      [NEG, cfgPrevia.iva_tasa, cfgPrevia.autoemitir_recibo, cfgPrevia.global_desde_txt || '2026-11-01',
        cfgPrevia.forma_tarjeta || '28', cfgPrevia.forma_mixto || 'por_definir', cfgPrevia.forma_rappi ?? null, cfgPrevia.global_incluir_rappi ?? true]).catch(() => {});
  } else await pool.query('DELETE FROM facturacion_configuracion WHERE negocio_id=$1', [NEG]).catch(() => {});
  if (moduloPrevio) await pool.query(`UPDATE negocio_modulos SET estado=$2 WHERE negocio_id=$1 AND modulo='facturacion'`, [NEG, moduloPrevio.estado]).catch(() => {});
  else await pool.query(`DELETE FROM negocio_modulos WHERE negocio_id=$1 AND modulo='facturacion'`, [NEG]).catch(() => {});
  for (const p of integPrevias) await pool.query(`UPDATE integraciones_canal SET estado=$2, activo=$3 WHERE id=$1`, [p.id, p.estado, p.activo]).catch(() => {});
  if (!previaNeg) {
    await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN
      (SELECT id FROM integraciones_canal WHERE negocio_id=$1 AND canal='facturacion' AND proveedor='facturapi')`, [NEG]).catch(() => {});
    await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id=$1 AND canal='facturacion' AND proveedor='facturapi'`, [NEG]).catch(() => {});
  }
  await pool.end().catch(() => {});
}
console.log(`\nPASADAS: ${pasadas}   FALLOS: ${fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
