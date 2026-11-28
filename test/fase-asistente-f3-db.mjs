// ASISTENTE DEL RESTAURANTE, Fase 3: la IA y el resumen por WhatsApp, contra
// Postgres y con el servidor real.
//
// Negocios, usuarios, números y ventas INVENTADOS, creados aquí y borrados al
// final. La IA y Meta son de mentira (se inyectan) y la red está cerrada
// (red-solo-local). Cubre:
//   M. la migración 165: lo que acepta y lo que rechaza la base;
//   D. la configuración del resumen guardada y leída por sucursal, la tarjeta,
//      la bitácora sin el número completo;
//   E. el resumen: las cifras de ESTA sucursal, a su número y con su conexión;
//      nunca dos veces (ni con dos a la vez); lo atorado; cada error de Meta a
//      la campanita de esa sucursal; sin ventas no sale; con la IA y sin ella;
//      el tope de gasto por sucursal y su aviso una vez al mes;
//   T. el reloj de cada minuto: la hora de la sucursal, el semanal de los
//      lunes (espera la revisión o las 10:00), la bandera y el número;
//   F. la revisión de la mañana: sin «Redactar con IA» queda igual que en la
//      Fase 2; con ella, el texto revisado, su orden y el estado de la IA;
//   R. las rutas: «Enviar prueba» solo para quien recibe los avisos, al número
//      guardado, máximo 5 por hora y por sucursal; el reporte de las 22:01
//      responde 410 a superadmin y nada a los demás;
//   Z. la reversa: el _down, el Pre-Deploy otra vez, y que la 160 y la 164
//      siguen «Ya aplicadas» con la 165 encima.
//
// Las sucursales de prueba viven en una zona donde AHORA son de las 0 a las 5:
// el servidor de prueba corre cada minuto la revisión (6 a 12), el resumen
// diario (18:00 en adelante) y el semanal (lunes 9 a 14), y así no les toca.
import assert from 'assert';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raiz = (r) => join(__dirname, '..', r);

if (!process.env.DATABASE_URL) { console.error('Falta DATABASE_URL'); process.exit(2); }
if (/railway|rlwy/i.test(process.env.DATABASE_URL)) { console.error('Esta suite no corre contra Railway'); process.exit(2); }

const { pool } = await import('../src/services/database.js');
const { instanteLocal, fechaOperativaDe } = await import('../src/services/cortesCaja.js');
const R = await import('../src/asistenteRestaurante/reglas.js');
const P = await import('../src/asistenteRestaurante/proceso.js');
const AV = await import('../src/asistenteRestaurante/avisos.js');
const C = await import('../src/asistenteRestaurante/configuracion.js');
const RS = await import('../src/asistenteRestaurante/resumen.js');
const EN = await import('../src/asistenteRestaurante/envioResumen.js');
const IA = await import('../src/asistenteRestaurante/ia.js');
const AP = await import('../src/services/avisosPanel.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  if (process.env.CASOS && !new RegExp(process.env.CASOS).test(nombre)) return;
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ═══ La zona, las fechas y los datos inventados ═══════════════════════════
const ZONAS = ['Pacific/Honolulu', 'America/Los_Angeles', 'America/Matamoros', 'America/Sao_Paulo', 'Atlantic/Azores', 'Europe/Madrid',
  'Europe/Moscow', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland'];
const TZ = ZONAS.find((z) => [0, 20, 40].every((m) => P.horaLocal(new Date(Date.now() + m * 60000), z) < 5));
assert.ok(TZ, 'ninguna zona entre las 0 y las 5');
const HOY = fechaOperativaDe(new Date(), TZ);
const AYER = R.sumarDias(HOY, -1);
const DIA = R.sumarDias(HOY, -3);          // el día del resumen diario
const PASADA = R.sumarDias(DIA, -7);       // el mismo día de la semana anterior
const SIG = R.sumarDias(DIA, -6);          // el «mañana» de la semana pasada (sugerencia)
const DIA2 = R.sumarDias(HOY, -2);         // el día del reloj
const LUNES = [1, 2, 3, 4, 5, 6, 7].map((n) => R.sumarDias(HOY, -n - 7)).find((d) => RS.esLunes(d));
const a = (fecha, h, mi = 0) => { const [y, mo, d] = fecha.split('-').map(Number); return instanteLocal(y, mo, d, h, mi, 0, TZ); };

const TAG = 'AT' + (Date.now() % 1e8).toString(36).toUpperCase();
const SLUG = (l) => `${TAG.toLowerCase()}-asis-f3-${l}`;
const q = (sql, params) => pool.query(sql, params);
const uno = async (sql, params) => (await q(sql, params)).rows[0];

async function limpiar() {
  const { rows } = await q(`SELECT id FROM negocios WHERE slug LIKE '%-asis-f3-_'`);
  for (const { id } of rows) {
    const del = (sql) => q(sql, [id]).catch(() => {});
    await del('DELETE FROM superadmin_totp WHERE usuario_id IN (SELECT id FROM usuarios WHERE negocio_id = $1)');
    await del('DELETE FROM administradores_plataforma WHERE usuario_id IN (SELECT id FROM usuarios WHERE negocio_id = $1)');
    await del('DELETE FROM auditoria_plataforma WHERE negocio_id = $1');
    await del('DELETE FROM avisos_panel WHERE negocio_id = $1');
    await del('DELETE FROM asistente_restaurante_resumenes WHERE negocio_id = $1');
    await del('DELETE FROM asistente_restaurante_gasto_ia WHERE negocio_id = $1');
    await del('DELETE FROM asistente_restaurante_silenciados WHERE negocio_id = $1');
    await del('DELETE FROM asistente_restaurante_corridas WHERE negocio_id = $1');
    await del('DELETE FROM pedidos_activos WHERE negocio_id = $1');
    await del('DELETE FROM configuracion WHERE negocio_id = $1');
    await del('DELETE FROM negocio_modulos WHERE negocio_id = $1');
    await del('DELETE FROM usuario_negocios WHERE negocio_id = $1');
  }
  for (const { id } of rows) {
    await q('DELETE FROM usuarios WHERE negocio_id = $1', [id]).catch(() => {});
    await q('DELETE FROM negocios WHERE id = $1', [id]).catch(() => {});
  }
}
await limpiar();

async function negocio(l, nombre) {
  const n = await uno('INSERT INTO negocios (nombre, slug) VALUES ($1, $2) RETURNING id', [nombre, SLUG(l)]);
  for (const m of ['pos', 'caja', 'whatsapp']) await q(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')`, [n.id, m]);
  await q(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1, 'timezone', $2)`, [n.id, TZ]);
  return n.id;
}
async function usuario(neg, nombre, rol) {
  const u = await uno(`INSERT INTO usuarios (negocio_id, nombre, email, password_hash, activo) VALUES ($1,$2,$3,'x',true) RETURNING id`,
    [neg, nombre, `${TAG.toLowerCase()}-${nombre.replace(/\W+/g, '').toLowerCase()}@test.local`]);
  await q('INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1,$2,$3,true)', [u.id, neg, rol]);
  return u.id;
}
async function cfg(neg, clave, valor) {
  await q('DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2', [neg, clave]);
  if (valor !== undefined) await q('INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,$2,$3)', [neg, clave, valor]);
}
const F = (s) => `ACT-${TAG}-${s}`;
const item = (nombre, precio) => ({ nombre, cantidad: 1, precio_unitario: precio });
async function venta(neg, folio, instante, total, extra = {}) {
  await q('INSERT INTO pedidos_activos (folio, estado, datos, negocio_id, created_at) VALUES ($1,$2,$3,$4,$5::timestamp)',
    [folio, 'entregado', JSON.stringify({ id: folio, canal: 'pos', modalidad: 'recoger en tienda', forma_pago: 'efectivo', subtotal: total, total, items: [item('Café', total)], ...extra }), neg, instante.toISOString()]);
}

const NOMBRE_A = `${TAG} Sucursal A`;
const NOMBRE_B = `${TAG} Sucursal B`;
const A = await negocio('a', NOMBRE_A);
const B = await negocio('b', NOMBRE_B);
const ADMIN_A = await usuario(A, `${TAG} Dueño A`, 'admin');
const ADMIN2_A = await usuario(A, `${TAG} Gerente A`, 'admin');
const STAFF_A = await usuario(A, `${TAG} Cajera A`, 'staff');
const ADMIN_B = await usuario(B, `${TAG} Dueño B`, 'admin');
const SUPER = await usuario(A, `${TAG} Soporte`, 'admin');
await q('INSERT INTO administradores_plataforma (usuario_id) VALUES ($1)', [SUPER]);
const NA = { id: A, nombre: NOMBRE_A, tz: TZ };
const NB = { id: B, nombre: NOMBRE_B, tz: TZ };
const NUM_A = '8780000001';
const NUM_B = '8780000002';
for (const [n, d] of [[A, ADMIN_A], [B, ADMIN_B]]) {
  await cfg(n, AV.BANDERA, 'true');
  await cfg(n, AV.CLAVE_DESTINATARIOS, JSON.stringify([d]));
  await cfg(n, 'avisos_panel_v1', 'true');
}

// A: el día del resumen (la de las 22:00 es después de la hora; la de $9,000 es
// grande) y el mismo día de la semana anterior. B: cifras que no deben salir
// NUNCA en lo de A.
await venta(A, F('D1'), a(DIA, 10), 500);
await venta(A, F('D2'), a(DIA, 14), 700);
await venta(A, F('D3'), a(DIA, 22), 300);
await venta(A, F('D4'), a(DIA, 13), 9000);
await venta(A, F('P1'), a(PASADA, 11), 400);
await venta(A, F('P2'), a(PASADA, 20), 600);
await venta(A, F('P3'), a(PASADA, 22, 30), 1000);
await venta(A, F('S1'), a(SIG, 12), 800);
await venta(A, F('E1'), a(DIA2, 12), 650);
// Para la revisión de la mañana: ayer, 3 ventas sin forma de pago (control).
for (let i = 1; i <= 5; i++) await venta(A, F(`AOK${i}`), a(AYER, 9 + i), 120);
await venta(A, F('ASF1'), a(AYER, 15), 150, { forma_pago: undefined });
await venta(A, F('ASF2'), a(AYER, 16), 200, { forma_pago: undefined });
await venta(A, F('ASF3'), a(AYER, 17), 250, { forma_pago: undefined });
await venta(B, F('BD1'), a(DIA, 12), 77777);
await venta(B, F('BP1'), a(PASADA, 12), 55555);
await venta(B, F('BE1'), a(DIA2, 12), 66666);

// ─── Meta y la IA de mentira ─────────────────────────────────────────────
const CRED = { [A]: { phoneNumberId: 'PHONE-A-INVENTADO', accessToken: 'TOKEN-A-INVENTADO' }, [B]: { phoneNumberId: 'PHONE-B-INVENTADO', accessToken: 'TOKEN-B-INVENTADO' } };
function credenciales(mapa = CRED) {
  const pedidas = [];
  const f = async (nid) => { pedidas.push(nid); return mapa[nid] || null; };
  f.pedidas = pedidas;
  return f;
}
function meta(status = 200, cuerpo = { messages: [{ id: 'wamid.INVENTADO' }] }) {
  const pedidas = [];
  const f = async (url, opts) => {
    pedidas.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization });
    return { ok: status >= 200 && status < 300, status, json: async () => cuerpo };
  };
  f.pedidas = pedidas;
  return f;
}
const USO = { input_tokens: 1000, output_tokens: 500 };
function iaQue(responder) {
  const pedidas = [];
  return {
    pedidas,
    messages: {
      create: async (body) => {
        pedidas.push(body);
        if (responder instanceof Error) throw responder;
        const datos = JSON.parse(body.messages[0].content);
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(responder(datos)) }], usage: USO };
      },
    },
  };
}
const ON = (extra = {}) => ({ ...C.RESUMEN_DE_SIEMPRE, diario: true, numero: NUM_A, ...extra });
const cfgCon = (resumen) => ({ activo: true, modo: 'ensayo', destinatarios: [], tiposApagados: [], ajustes: { ...C.AJUSTES_DE_SIEMPRE }, resumen });
const filas = async (neg) => (await q(`SELECT tipo, fecha::text AS fecha, estado, con_ia, variables, destino, wamid, error_codigo, error
  FROM asistente_restaurante_resumenes WHERE negocio_id = $1 ORDER BY id`, [neg])).rows;
const avisosDe = async (neg, tipo) => (await q('SELECT tipo, telefono, datos FROM avisos_panel WHERE negocio_id = $1 AND tipo = $2 ORDER BY id', [neg, tipo])).rows;
const gastos = async (neg) => (await q('SELECT proposito, resultado, costo_usd::float AS costo FROM asistente_restaurante_gasto_ia WHERE negocio_id = $1 ORDER BY id', [neg])).rows;
const borrarResumenes = async () => { await q('DELETE FROM asistente_restaurante_resumenes WHERE negocio_id = ANY($1::uuid[])', [[A, B]]); };
const borrarAvisos = async () => { await q('DELETE FROM avisos_panel WHERE negocio_id = ANY($1::uuid[])', [[A, B]]); };
const borrarGastos = async () => { await q('DELETE FROM asistente_restaurante_gasto_ia WHERE negocio_id = ANY($1::uuid[])', [[A, B]]); };
const enviar = (extra = {}) => EN.prepararYEnviar({ db: pool, negocio: NA, tipo: 'diario', hoy: DIA, ahora: a(DIA, 21, 30), cfg: cfgCon(ON()), ...extra });
const VENTA_A = `$1,200 en 2 tickets; el ${RS.diaDeLaSemana(PASADA)} pasado, $1,000 en 2 tickets (+20 %)`;
const sinCifrasDeB = (texto) => !/77,?777|55,?555|66,?666/.test(texto);

try {
  // ═══ M. La migración 165 ══════════════════════════════════════════════
  await t('M1. la base acepta solo lo válido y deja un diario y un semanal por sucursal y día (las pruebas, todas)', async () => {
    const mal = [
      [`INSERT INTO asistente_restaurante_resumenes (negocio_id, tipo, fecha) VALUES ($1, 'mensual', '2026-01-01')`, /resumenes_tipo/],
      [`INSERT INTO asistente_restaurante_resumenes (negocio_id, tipo, fecha, estado) VALUES ($1, 'diario', '2026-01-01', 'raro')`, /resumenes_estado/],
      [`INSERT INTO asistente_restaurante_resumenes (negocio_id, tipo, fecha, destino) VALUES ($1, 'diario', '2026-01-01', '8780000001')`, /resumenes_destino/],
      [`INSERT INTO asistente_restaurante_resumenes (negocio_id, tipo, fecha, variables) VALUES ($1, 'diario', '2026-01-01', '{}')`, /resumenes_variables/],
      [`INSERT INTO asistente_restaurante_gasto_ia (negocio_id, proposito, modelo, costo_usd, resultado) VALUES ($1, 'chat', 'm', 0, 'ok')`, /gasto_ia_proposito/],
      [`INSERT INTO asistente_restaurante_gasto_ia (negocio_id, proposito, modelo, costo_usd, resultado) VALUES ($1, 'avisos', 'm', 0, 'quizá')`, /gasto_ia_resultado/],
      [`INSERT INTO asistente_restaurante_gasto_ia (negocio_id, proposito, modelo, costo_usd, resultado) VALUES ($1, 'avisos', 'm', -1, 'ok')`, /gasto_ia_costo/],
      [`INSERT INTO asistente_restaurante_corridas (negocio_id, fecha, modo, ia) VALUES ($1, '2001-01-01', 'ensayo', 'quizá')`, /corridas_ia/],
      [`INSERT INTO avisos_panel (negocio_id, tipo) VALUES ($1, 'asistente_otro')`, /avisos_panel_tipo/],
    ];
    for (const [sql, patron] of mal) await assert.rejects(q(sql, [A]), patron, sql.slice(0, 90));
    await q(`INSERT INTO asistente_restaurante_resumenes (negocio_id, tipo, fecha) VALUES ($1, 'diario', '2026-01-01')`, [A]);
    await assert.rejects(q(`INSERT INTO asistente_restaurante_resumenes (negocio_id, tipo, fecha) VALUES ($1, 'diario', '2026-01-01')`, [A]), /uno_al_dia/);
    await q(`INSERT INTO asistente_restaurante_resumenes (negocio_id, tipo, fecha) VALUES ($1, 'diario', '2026-01-01')`, [B]);
    await q(`INSERT INTO asistente_restaurante_resumenes (negocio_id, tipo, fecha) VALUES ($1, 'semanal', '2026-01-01')`, [A]);
    for (let i = 0; i < 2; i++) await q(`INSERT INTO asistente_restaurante_resumenes (negocio_id, tipo, fecha) VALUES ($1, 'prueba', '2026-01-01')`, [A]);
    for (const tipo of ['asistente_resumen_fallo', 'asistente_tope_ia']) await q('INSERT INTO avisos_panel (negocio_id, tipo) VALUES ($1, $2)', [A, tipo]);
    const { rows: [c] } = await q(`SELECT column_default FROM information_schema.columns WHERE table_name = 'asistente_restaurante_corridas' AND column_name = 'ia'`);
    assert.strictEqual(c.column_default, null, 'la columna ia nace con un valor: las corridas viejas no deben cambiar');
    await borrarResumenes(); await borrarAvisos();
  });

  // ═══ D. La configuración ══════════════════════════════════════════════
  await t('D1. sin nada guardado todo está apagado; lo dañado vuelve a lo de siempre; cada sucursal lee lo suyo', async () => {
    assert.deepStrictEqual((await C.leerConfiguracion(pool, A)).resumen, C.RESUMEN_DE_SIEMPRE);
    await cfg(A, C.CLAVE_RESUMEN, '{dañado');
    assert.deepStrictEqual((await C.leerConfiguracion(pool, A)).resumen, C.RESUMEN_DE_SIEMPRE);
    await cfg(B, C.CLAVE_RESUMEN, JSON.stringify({ ...C.RESUMEN_DE_SIEMPRE, diario: true, numero: NUM_B, topeUsd: 3 }));
    assert.deepStrictEqual((await C.leerConfiguracion(pool, A)).resumen, C.RESUMEN_DE_SIEMPRE, 'A leyó la de B');
    assert.deepStrictEqual((await C.leerConfiguracion(pool, B)).resumen, { ...C.RESUMEN_DE_SIEMPRE, diario: true, numero: NUM_B, topeUsd: 3 });
    await cfg(A, C.CLAVE_RESUMEN, undefined);
    await cfg(B, C.CLAVE_RESUMEN, undefined);
  });

  // ═══ E. El resumen ════════════════════════════════════════════════════
  await t('E1. diario: las cifras de A, a su número, con SU conexión; queda registrado con solo 4 dígitos', async () => {
    const m = meta(); const cr = credenciales();
    const r = await enviar({ fetchImpl: m, credencialesDe: cr });
    assert.deepStrictEqual(r, { estado: 'enviado', conIa: false });
    assert.deepStrictEqual(cr.pedidas, [A], 'pidió credenciales de otra sucursal');
    assert.strictEqual(m.pedidas.length, 1);
    const p = m.pedidas[0];
    assert.match(p.url, /\/PHONE-A-INVENTADO\/messages$/);
    assert.strictEqual(p.auth, 'Bearer TOKEN-A-INVENTADO');
    assert.strictEqual(p.body.to, `52${NUM_A}`);
    const vs = p.body.template.components[0].parameters.map((x) => x.text);
    assert.strictEqual(vs[0], NOMBRE_A);
    assert.strictEqual(vs[1], `${RS.diaDeLaSemana(DIA)} ${R.fechaCorta(DIA)}, hasta las 21:30`);
    assert.strictEqual(vs[2], VENTA_A);
    assert.strictEqual(vs[3], 'Aparte, 1 pedido grande por $9,000 (no entra en la comparación)');
    assert.match(vs[6], /vendiste \$800 en 1 ticket/);
    assert.ok(sinCifrasDeB(JSON.stringify(p.body)), 'el resumen de A trae cifras de B');
    const [f] = await filas(A);
    assert.deepStrictEqual({ ...f, variables: undefined }, {
      tipo: 'diario', fecha: DIA, estado: 'enviado', con_ia: false, variables: undefined, destino: '0001', wamid: 'wamid.INVENTADO', error_codigo: null, error: null,
    });
    assert.deepStrictEqual(f.variables, vs);
    assert.deepStrictEqual(await filas(B), []);
    assert.deepStrictEqual(await gastos(A), [], 'sin IA se registró gasto');
  });

  await t('E2. nunca dos veces: ni otra vez el mismo día, ni dos al mismo tiempo', async () => {
    const m = meta();
    assert.deepStrictEqual(await enviar({ fetchImpl: m, credencialesDe: credenciales() }), { omitido: true });
    assert.strictEqual(m.pedidas.length, 0, 'mandó otra vez el resumen de un día ya mandado');
    const otro = R.sumarDias(DIA, -14);
    await venta(A, F('X1'), a(otro, 12), 300);
    const m2 = meta();
    const rs = await Promise.all([1, 2, 3].map(() => enviar({ hoy: otro, ahora: a(otro, 21, 30), fetchImpl: m2, credencialesDe: credenciales() })));
    assert.strictEqual(m2.pedidas.length, 1, `con tres a la vez salieron ${m2.pedidas.length}`);
    assert.strictEqual(rs.filter((x) => x.estado === 'enviado').length, 1);
    assert.strictEqual(rs.filter((x) => x.omitido).length, 2);
    // El semanal del mismo día es otro mensaje: no lo frena el diario.
    assert.strictEqual((await filas(A)).filter((f) => f.fecha === otro).length, 1);
  });

  await t('E3. uno atorado «preparando» se retoma a los 30 min; «enviando» o «incierto» nunca (pudo haber salido)', async () => {
    const casos = [['preparando', 31, 'enviado'], ['preparando', 5, null], ['enviando', 120, null], ['incierto', 120, null], ['fallo', 120, null]];
    for (const [i, [estado, minutos, esperado]] of casos.entries()) {
      const dia = R.sumarDias(DIA, -20 - i);
      await venta(A, F(`AT${i}`), a(dia, 12), 300);
      await q(`INSERT INTO asistente_restaurante_resumenes (negocio_id, tipo, fecha, estado, creado_en) VALUES ($1, 'diario', $2, $3, now() - make_interval(mins => $4))`, [A, dia, estado, minutos]);
      const m = meta();
      const r = await enviar({ hoy: dia, ahora: a(dia, 21, 30), fetchImpl: m, credencialesDe: credenciales() });
      if (esperado) assert.strictEqual(r.estado, esperado, `${estado} de ${minutos} min`);
      else assert.deepStrictEqual(r, { omitido: true }, `${estado} de ${minutos} min se volvió a mandar`);
      assert.strictEqual(m.pedidas.length, esperado ? 1 : 0);
    }
  });

  await t('E4. cada error de Meta queda en la tabla y en la campanita de ESA sucursal, sin el número', async () => {
    await borrarResumenes(); await borrarAvisos();
    const casos = [
      [meta(400, { error: { code: 132001 } }), 'fallo', 132001, /La plantilla xabor_resumen_asistente_v1 no existe o no está aprobada en Meta/],
      [meta(503, {}), 'incierto', null, /Meta no contestó a tiempo: puede que sí haya llegado/],
    ];
    for (const [i, [m, estado, codigo, patron]] of casos.entries()) {
      const dia = R.sumarDias(DIA, -30 - i);
      await venta(A, F(`ER${i}`), a(dia, 12), 300);
      const r = await enviar({ hoy: dia, ahora: a(dia, 21, 30), fetchImpl: m, credencialesDe: credenciales() });
      assert.strictEqual(r.estado, estado);
      const f = (await filas(A)).find((x) => x.fecha === dia);
      assert.strictEqual(f.estado, estado);
      assert.strictEqual(f.error_codigo, codigo);
      assert.match(f.error, patron);
    }
    const sinConexion = R.sumarDias(DIA, -32);
    await venta(A, F('ER9'), a(sinConexion, 12), 300);
    const m = meta();
    assert.strictEqual((await enviar({ hoy: sinConexion, ahora: a(sinConexion, 21, 30), fetchImpl: m, credencialesDe: credenciales({}) })).estado, 'fallo');
    assert.strictEqual(m.pedidas.length, 0);
    const av = await avisosDe(A, 'asistente_resumen_fallo');
    assert.strictEqual(av.length, 3, JSON.stringify(av));
    assert.match(av[0].datos.motivo, /no existe o no está aprobada/);
    assert.strictEqual(av[0].datos.razon, `Resumen diario del ${R.fechaCorta(R.sumarDias(DIA, -30))}`);
    assert.match(av[2].datos.motivo, /no tiene WhatsApp conectado/);
    assert.ok(av.every((x) => x.telefono === null && !JSON.stringify(x.datos).includes(NUM_A) && !JSON.stringify(x.datos).includes('0001')), 'el aviso trae el número');
    assert.deepStrictEqual(await avisosDe(B, 'asistente_resumen_fallo'), [], 'el error de A llegó a la campanita de B');
    const lista = await AP.listarAvisosPanel(A);
    assert.ok(lista.avisos.some((x) => x.tipo === 'asistente_resumen_fallo'), 'la campanita de A no lo lista');
    assert.ok(!(await AP.listarAvisosPanel(B)).avisos.some((x) => x.tipo === 'asistente_resumen_fallo'));
  });

  await t('E5. un día sin ventas no se manda ni avisa', async () => {
    await borrarAvisos();
    const vacio = R.sumarDias(DIA, -40);
    const m = meta();
    assert.deepStrictEqual(await enviar({ hoy: vacio, ahora: a(vacio, 21, 30), fetchImpl: m, credencialesDe: credenciales() }), { estado: 'omitido' });
    assert.strictEqual(m.pedidas.length, 0);
    assert.strictEqual((await filas(A)).find((x) => x.fecha === vacio).estado, 'omitido');
    assert.deepStrictEqual(await avisosDe(A, 'asistente_resumen_fallo'), []);
  });

  await t('E6. con la IA: su texto revisado; lo que no cumple vuelve a las reglas; si falla, sale igual sin IA', async () => {
    await borrarResumenes(); await borrarGastos();
    const buena = iaQue((d) => ({ venta: `Hoy: ${d.venta}`, puntos: d.puntos.map((p) => `Ojo: ${p}`), sugerencia: 'Prepara lo de siempre para mañana.' }));
    const m = meta();
    const r = await enviar({ cfg: cfgCon(ON({ ia: true })), fetchImpl: m, credencialesDe: credenciales(), clienteIA: buena });
    assert.deepStrictEqual(r, { estado: 'enviado', conIa: true });
    const entrada = JSON.parse(buena.pedidas[0].messages[0].content);
    assert.strictEqual(entrada.venta, VENTA_A, 'a la IA le llegó otra cosa');
    assert.ok(sinCifrasDeB(buena.pedidas[0].messages[0].content), 'a la IA de A le llegaron cifras de B');
    const vs = m.pedidas[0].body.template.components[0].parameters.map((x) => x.text);
    assert.strictEqual(vs[2], `Hoy: ${VENTA_A}`);
    assert.strictEqual(vs[3], 'Ojo: Aparte, 1 pedido grande por $9,000 (no entra en la comparación)');
    assert.strictEqual(vs[6], 'Prepara lo de siempre para mañana.');
    assert.strictEqual((await filas(A))[0].con_ia, true);
    assert.deepStrictEqual(await gastos(A), [{ proposito: 'resumen_diario', resultado: 'ok', costo: 0.014 }]);
    assert.deepStrictEqual(await gastos(B), []);

    await borrarResumenes();
    const inventa = iaQue((d) => ({ venta: 'Vendiste $1,350 hoy.', puntos: d.puntos, sugerencia: 'Pide más café porque se acabó.' }));
    const m2 = meta();
    await enviar({ cfg: cfgCon(ON({ ia: true })), fetchImpl: m2, credencialesDe: credenciales(), clienteIA: inventa });
    const vs2 = m2.pedidas[0].body.template.components[0].parameters.map((x) => x.text);
    assert.strictEqual(vs2[2], VENTA_A, 'pasó una cifra inventada');
    assert.match(vs2[6], /vendiste \$800/, 'pasó lenguaje causal');

    await borrarResumenes();
    const m3 = meta();
    const r3 = await enviar({ cfg: cfgCon(ON({ ia: true })), fetchImpl: m3, credencialesDe: credenciales(), clienteIA: iaQue(new Error('sin red')) });
    assert.deepStrictEqual(r3, { estado: 'enviado', conIa: false }, 'si la IA falla el resumen debe salir igual');
    assert.strictEqual(m3.pedidas[0].body.template.components[0].parameters[2].text, VENTA_A);
  });

  await t('E7. el tope es por sucursal y por mes: sin margen no se llama a la IA y la campanita avisa UNA vez', async () => {
    await borrarResumenes(); await borrarGastos(); await borrarAvisos();
    const ahora = new Date();
    await q(`INSERT INTO asistente_restaurante_gasto_ia (negocio_id, proposito, modelo, costo_usd, resultado) VALUES ($1, 'avisos', 'm', 9.99, 'ok')`, [A]);
    await q(`INSERT INTO asistente_restaurante_gasto_ia (negocio_id, proposito, modelo, costo_usd, resultado, creado_en) VALUES ($1, 'avisos', 'm', 40, 'ok', now() - interval '40 days')`, [B]);
    await q(`INSERT INTO asistente_restaurante_gasto_ia (negocio_id, proposito, modelo, costo_usd, resultado) VALUES ($1, 'avisos', 'm', 0.5, 'ok')`, [B]);
    assert.strictEqual(await IA.gastoDelMes(pool, A, TZ, ahora), 9.99, 'a A le contó el gasto de B');
    assert.strictEqual(await IA.gastoDelMes(pool, B, TZ, ahora), 0.5, 'a B le contó el gasto de otro mes o el de A');
    const otroDia = R.sumarDias(DIA, -2);
    await venta(A, F('TP1'), a(otroDia, 12), 300);
    for (const dia of [DIA, otroDia]) {
      const ia = iaQue(() => ({ venta: 'x', puntos: [], sugerencia: 'x' }));
      const r = await EN.prepararYEnviar({ db: pool, negocio: NA, tipo: 'diario', hoy: dia, ahora: a(dia, 21, 30), cfg: cfgCon(ON({ ia: true })), fetchImpl: meta(), credencialesDe: credenciales(), clienteIA: ia });
      assert.strictEqual(r.estado, 'enviado');
      assert.strictEqual(ia.pedidas.length, 0, 'llamó a la IA sin margen en el tope');
    }
    const av = await avisosDe(A, 'asistente_tope_ia');
    assert.strictEqual(av.length, 1, `el aviso del tope salió ${av.length} veces`);
    assert.strictEqual(av[0].datos.motivo, 'US$10');
    assert.deepStrictEqual(await avisosDe(B, 'asistente_tope_ia'), []);
    // B (con el gasto de A al tope) sí llama a su IA.
    const iaB = iaQue((d) => ({ venta: d.venta, puntos: d.puntos, sugerencia: d.sugerencia }));
    await EN.prepararYEnviar({ db: pool, negocio: NB, tipo: 'diario', hoy: DIA, ahora: a(DIA, 21, 30), cfg: cfgCon({ ...ON({ ia: true }), numero: NUM_B }), fetchImpl: meta(), credencialesDe: credenciales(), clienteIA: iaB });
    assert.strictEqual(iaB.pedidas.length, 1, 'el tope de A frenó a B');
    // Subir el tope reactiva la IA el mismo mes.
    await borrarResumenes();
    const ia2 = iaQue((d) => ({ venta: d.venta, puntos: d.puntos, sugerencia: d.sugerencia }));
    await EN.prepararYEnviar({ db: pool, negocio: NA, tipo: 'diario', hoy: DIA, ahora: a(DIA, 21, 30), cfg: cfgCon(ON({ ia: true, topeUsd: 11 })), fetchImpl: meta(), credencialesDe: credenciales(), clienteIA: ia2 });
    assert.strictEqual(ia2.pedidas.length, 1);
    await borrarGastos(); await borrarAvisos();
  });

  // ═══ T. El reloj de cada minuto ═══════════════════════════════════════
  await t('T1. el diario sale a la hora de la sucursal, una vez, solo donde está encendido y con número', async () => {
    await borrarResumenes();
    await cfg(A, C.CLAVE_RESUMEN, JSON.stringify(ON({ hora: '21:30', semanal: true })));
    await cfg(B, C.CLAVE_RESUMEN, JSON.stringify({ ...C.RESUMEN_DE_SIEMPRE, numero: NUM_B }));
    const correr = async (ahora) => { const m = meta(); const r = await EN.enviarResumenesPendientes({ db: pool, ahora, fetchImpl: m, credencialesDe: credenciales() }); return { r, m }; };
    let x = await correr(a(DIA2, 21, 29));
    assert.deepStrictEqual(x.r, { revisadas: 0, enviados: 0, fallos: 0 }, 'salió antes de su hora');
    x = await correr(a(DIA2, 21, 31));
    assert.deepStrictEqual(x.r, { revisadas: 1, enviados: 1, fallos: 0 });
    assert.strictEqual(x.m.pedidas.length, 1);
    assert.match(x.m.pedidas[0].url, /PHONE-A-INVENTADO/, 'salió de la conexión de otra sucursal');
    assert.ok(sinCifrasDeB(JSON.stringify(x.m.pedidas[0].body)));
    assert.match(x.m.pedidas[0].body.template.components[0].parameters[2].text, /^\$650 en 1 ticket/);
    x = await correr(a(DIA2, 22, 10));
    assert.deepStrictEqual(x.r, { revisadas: 0, enviados: 0, fallos: 0 }, 'el reloj lo mandó dos veces');
    // El asistente apagado en la sucursal: nada, aunque el resumen esté encendido.
    await cfg(A, AV.BANDERA, undefined);
    try {
      x = await correr(a(R.sumarDias(DIA2, -1), 21, 31));
      assert.strictEqual(x.m.pedidas.length, 0, 'salió con el asistente apagado');
    } finally { await cfg(A, AV.BANDERA, 'true'); }
    // Sin número (guardado a mano, dañado): nada.
    await cfg(A, C.CLAVE_RESUMEN, JSON.stringify(ON({ numero: '' })));
    x = await correr(a(R.sumarDias(DIA2, -1), 21, 31));
    assert.strictEqual(x.m.pedidas.length, 0, 'salió sin número');
  });

  await t('T2. el semanal: lunes desde las 9:00, espera la revisión de la mañana o las 10:00; después de las 14:00 ya no', async () => {
    await borrarResumenes();
    await cfg(A, C.CLAVE_RESUMEN, JSON.stringify(ON({ diario: false, semanal: true })));
    const correr = async (ahora) => { const m = meta(); await EN.enviarResumenesPendientes({ db: pool, ahora, fetchImpl: m, credencialesDe: credenciales() }); return m.pedidas; };
    assert.strictEqual((await correr(a(LUNES, 8, 59))).length, 0, 'salió antes de las 9');
    assert.strictEqual((await correr(a(LUNES, 9, 30))).length, 0, 'no esperó a la revisión de la mañana');
    const enviados = await correr(a(LUNES, 10, 1));
    assert.strictEqual(enviados.length, 1, 'a las 10 no salió sin la revisión');
    assert.match(enviados[0].body.template.components[0].parameters[1].text, /^semana del /);
    await borrarResumenes();
    const c = await uno(`INSERT INTO asistente_restaurante_corridas (negocio_id, fecha, modo, estado) VALUES ($1, $2, 'ensayo', 'lista') RETURNING id`, [A, LUNES]);
    assert.strictEqual((await correr(a(LUNES, 9, 5))).length, 1, 'con la revisión lista no salió a las 9');
    await q('DELETE FROM asistente_restaurante_corridas WHERE id = $1', [c.id]);
    await borrarResumenes();
    assert.strictEqual((await correr(a(LUNES, 14, 0))).length, 0, 'salió después de las 14');
    assert.strictEqual((await correr(a(R.sumarDias(LUNES, 1), 10, 30))).length, 0, 'salió un martes');
    await cfg(A, C.CLAVE_RESUMEN, undefined);
    await cfg(B, C.CLAVE_RESUMEN, undefined);
  });

  // ═══ F. La revisión de la mañana ═══════════════════════════════════════
  const correrA = async (clienteIA) => {
    await q('DELETE FROM asistente_restaurante_corridas WHERE negocio_id = $1', [A]);
    const r = await P.correrSucursal({ negocio: NA, modo: 'visible', hoy: HOY, ahora: a(HOY, 7), clienteIA });
    assert.ok(r.corridaId, 'la corrida no corrió');
    return r;
  };
  const hallazgosA = async () => (await q(`SELECT tipo, elegido, motivo, titulo, contenido FROM asistente_restaurante_hallazgos WHERE negocio_id = $1 ORDER BY id`, [A])).rows;
  await cfg(A, AV.CLAVE_MODO, 'visible');
  let ELEGIDOS_REGLAS = null;

  await t('F1. sin «Redactar con IA» la revisión es la de la Fase 2: no llama a la IA ni deja rastro de ella', async () => {
    await borrarGastos();
    const nunca = iaQue(() => { throw new Error('no debía llamarse'); });
    const r = await correrA(nunca);
    assert.strictEqual(r.ia, null);
    assert.strictEqual(nunca.pedidas.length, 0);
    const { rows: [c] } = await q('SELECT ia FROM asistente_restaurante_corridas WHERE id = $1', [r.corridaId]);
    assert.strictEqual(c.ia, null);
    const hs = await hallazgosA();
    assert.ok(hs.some((h) => h.tipo === 'ventas_sin_forma_pago' && h.elegido), JSON.stringify(hs.map((h) => h.tipo)));
    assert.ok(hs.every((h) => !('ia' in (h.contenido || {}))), 'quedó texto de IA sin IA');
    ELEGIDOS_REGLAS = hs.filter((h) => h.elegido).map((h) => h.tipo);
    const l = await AV.listarAvisosAsistente(pool, A, ADMIN_A);
    assert.ok(l.avisos.length >= 1);
    assert.ok(l.avisos.every((x) => !('explicacion' in x) && !('redactadoConIA' in x)), 'la lista cambió de forma sin IA');
    assert.deepStrictEqual(await gastos(A), []);
  });

  await t('F2. con la IA: su texto revisado y su orden en la lista; las cifras del detalle son las de las reglas', async () => {
    await cfg(A, C.CLAVE_RESUMEN, JSON.stringify({ ...C.RESUMEN_DE_SIEMPRE, ia: true }));
    const ia = iaQue((d) => ({
      avisos: d.obligatorios.map((id) => ({ id, titulo: 'Hubo ventas sin forma de pago.', explicacion: 'Algunos cobros de ayer quedaron sin registrar cómo se pagaron.', sugerencia: 'Pide al cajero que registre la forma de pago de cada venta.' })),
    }));
    const r = await correrA(ia);
    assert.strictEqual(r.ia, 'ok');
    assert.strictEqual(ia.pedidas.length, 1);
    const entrada = ia.pedidas[0].messages[0].content;
    assert.ok(!entrada.includes(NOMBRE_B) && !entrada.includes('@'), 'a la IA le llegó algo de otra sucursal o un dato personal');
    const { rows: [c] } = await q('SELECT ia FROM asistente_restaurante_corridas WHERE id = $1', [r.corridaId]);
    assert.strictEqual(c.ia, 'ok');
    const h = (await hallazgosA()).find((x) => x.tipo === 'ventas_sin_forma_pago');
    assert.deepStrictEqual(h.contenido.ia, { titulo: 'Hubo ventas sin forma de pago.', explicacion: 'Algunos cobros de ayer quedaron sin registrar cómo se pagaron.', sugerencia: 'Pide al cajero que registre la forma de pago de cada venta.', orden: 0 });
    assert.match(h.titulo, /\d/, 'se perdió el título de las reglas');
    const l = await AV.listarAvisosAsistente(pool, A, ADMIN_A);
    const x = l.avisos.find((y) => y.tipo === 'ventas_sin_forma_pago');
    assert.strictEqual(x.titulo, 'Hubo ventas sin forma de pago.');
    assert.strictEqual(x.explicacion, 'Algunos cobros de ayer quedaron sin registrar cómo se pagaron.');
    assert.strictEqual(x.redactadoConIA, true);
    assert.deepStrictEqual(x.detalle, h.contenido.detalle, 'el detalle no es el de las reglas');
    assert.deepStrictEqual((await gastos(A)).map((g) => [g.proposito, g.resultado]), [['avisos', 'ok']]);
  });

  await t('F3. si la IA deja fuera el de control, quedan los de las reglas y la corrida dice «invalida»', async () => {
    const ia = iaQue((d) => ({ avisos: d.avisos.filter((x) => !d.obligatorios.includes(x.id)).slice(0, 1).map((x) => ({ id: x.id, titulo: 'Otro.', explicacion: 'Otro.', sugerencia: 'Otro.' })) }));
    assert.ok(ELEGIDOS_REGLAS, 'F1 no corrió');
    const r = await correrA(ia);
    assert.strictEqual(r.ia, 'invalida');
    assert.deepStrictEqual((await hallazgosA()).filter((h) => h.elegido).map((h) => h.tipo), ELEGIDOS_REGLAS, 'una respuesta inválida cambió la elección');
    await cfg(A, C.CLAVE_RESUMEN, undefined);
    await borrarGastos();
  });

  // ═══ R. Las rutas, con el servidor real ════════════════════════════════
  const { crearTokenSesion } = await import('../src/services/session.js');
  const { cookieSuperadminCon2fa } = await import('./lib-superadmin-2fa.mjs');
  const { arrancarServidor } = await import('./lib-servidor.mjs');
  const ses = (u, n, rol) => `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: u, negocioId: n, rol }))}`;
  const S = {
    adminA: ses(ADMIN_A, A, 'admin'), admin2A: ses(ADMIN2_A, A, 'admin'), staffA: ses(STAFF_A, A, 'staff'), adminB: ses(ADMIN_B, B, 'admin'),
    super: await cookieSuperadminCon2fa({ usuarioId: SUPER, negocioId: A, rol: 'admin' }),
  };
  const srv = await arrancarServidor({ PORT: process.env.TEST_PORT_ASISTENTE_F3 || '4799' }, { timeoutMs: 40000 });
  const RUTA = '/api/admin/asistente-restaurante/configuracion';
  async function api(ruta, cookie, metodo = 'GET', cuerpo = undefined) {
    const r = await fetch(`${srv.base}${ruta}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    let datos = null; try { datos = await r.json(); } catch {}
    return { status: r.status, datos };
  }
  const cambio = (extra = {}) => ({ modo: 'ensayo', tiposApagados: [], ajustes: { ...C.AJUSTES_DE_SIEMPRE }, destinatarios: [ADMIN_A], ...extra });
  const resumenOk = { ia: true, topeUsd: 7, diario: true, hora: '22:00', semanal: true, numero: '+52 878 000 0001' };
  const valorResumen = async (neg) => (await q('SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2', [neg, C.CLAVE_RESUMEN])).rows[0]?.valor ?? null;
  try {
    await t('R1. la tarjeta trae el resumen (todo apagado), sus límites, la plantilla y el estado de ESTA sucursal', async () => {
      await borrarResumenes(); await borrarGastos();
      await q(`INSERT INTO asistente_restaurante_resumenes (negocio_id, tipo, fecha, estado, destino) VALUES ($1, 'diario', $2, 'enviado', '0002')`, [B, DIA]);
      await q(`INSERT INTO asistente_restaurante_gasto_ia (negocio_id, proposito, modelo, costo_usd, resultado) VALUES ($1, 'avisos', 'm', 4.5, 'ok')`, [B]);
      await q(`INSERT INTO asistente_restaurante_gasto_ia (negocio_id, proposito, modelo, costo_usd, resultado) VALUES ($1, 'avisos', 'm', 0.25, 'ok')`, [A]);
      const d = (await api(RUTA, S.adminA)).datos;
      assert.deepStrictEqual(d.resumen, C.RESUMEN_DE_SIEMPRE);
      assert.deepStrictEqual(d.limitesResumen, { topeUsd: { min: 1, max: 50 }, hora: { desde: '18:00', hasta: '23:30' } });
      assert.deepStrictEqual(d.plantilla, C.PLANTILLA_RESUMEN);
      assert.deepStrictEqual(d.estadoResumen, { gastoMesUsd: 0.25, ultimos: [] }, 'la tarjeta de A ve envíos o gasto de B');
      assert.deepStrictEqual((await api(RUTA, S.admin2A)).datos, { disponible: false });
      await borrarResumenes(); await borrarGastos();
    });

    await t('R2. guardar el resumen: completo, con el número a 10 dígitos; la bitácora solo lleva los últimos 4', async () => {
      // Sin lo que pudo dejar otro caso al fallar: así «escribió en B» solo puede ser una fuga.
      await q('DELETE FROM configuracion WHERE negocio_id = ANY($1::uuid[]) AND clave = $2', [[A, B], C.CLAVE_RESUMEN]);
      const r = await api(RUTA, S.adminA, 'PUT', cambio({ resumen: resumenOk }));
      assert.strictEqual(r.status, 200, JSON.stringify(r.datos));
      assert.deepStrictEqual(r.datos.resumen, { ...resumenOk, numero: NUM_A });
      assert.deepStrictEqual(JSON.parse(await valorResumen(A)), { ...resumenOk, numero: NUM_A });
      assert.strictEqual(await valorResumen(B), null, 'guardar en A escribió en B');
      const { rows } = await q(`SELECT estado_anterior::text AS antes, estado_nuevo::text AS nuevo, estado_nuevo FROM auditoria_plataforma WHERE negocio_id = $1 AND accion = 'asistente_restaurante_configuracion' ORDER BY created_at, id`, [A]);
      const ultima = rows[rows.length - 1];
      assert.strictEqual(ultima.estado_nuevo.resumen.numero, '…0001');
      assert.ok(!rows.some((x) => `${x.antes}${x.nuevo}`.includes(NUM_A)), 'el número completo quedó en la bitácora');
      // Una tarjeta de la Fase 2 (sin «resumen») no borra lo guardado.
      const viejo = await api(RUTA, S.adminA, 'PUT', cambio());
      assert.strictEqual(viejo.status, 200);
      assert.deepStrictEqual(JSON.parse(await valorResumen(A)), { ...resumenOk, numero: NUM_A }, 'guardar sin resumen lo borró');
    });

    await t('R3. el servidor rechaza un resumen inválido y no cambia nada', async () => {
      const antes = await valorResumen(A);
      const casos = [
        [{ ...resumenOk, topeUsd: 60 }, /entre 1 y 50/],
        [{ ...resumenOk, hora: '17:00' }, /entre las 18:00 y las 23:30/],
        [{ ...resumenOk, numero: '123' }, /10 dígitos/],
        [{ ...resumenOk, numero: '' }, /Escribe el número/],
        [{ ...resumenOk, negocioId: B }, /No se reconoce/],
      ];
      for (const [resumen, patron] of casos) {
        const r = await api(RUTA, S.adminA, 'PUT', cambio({ resumen }));
        assert.strictEqual(r.status, 400, JSON.stringify(resumen));
        assert.match(r.datos?.error || '', patron);
      }
      assert.strictEqual(await valorResumen(A), antes, 'un resumen rechazado se guardó');
      assert.strictEqual((await api(RUTA, S.admin2A, 'PUT', cambio({ destinatarios: [ADMIN2_A], resumen: resumenOk }))).status, 403);
    });

    await t('R4. «Enviar prueba»: solo quien recibe los avisos; al número guardado; máximo 5 por hora y por sucursal', async () => {
      const P_ = `${RUTA}/enviar-prueba`;
      assert.strictEqual((await api(P_, null, 'POST', {})).status, 401);
      assert.strictEqual((await api(P_, S.staffA, 'POST', {})).status, 403);
      assert.strictEqual((await api(P_, S.admin2A, 'POST', {})).status, 403, 'otro administrador mandó la prueba');
      // Las sucursales de prueba no tienen WhatsApp conectado: el servidor lo dice y no apunta nada.
      const r = await api(P_, S.adminA, 'POST', { numero: '8789999999' });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.datos, { ok: false, mensaje: 'La sucursal no tiene WhatsApp conectado.' });
      assert.deepStrictEqual(await filas(A), []);
      for (let i = 0; i < 5; i++) await q(`INSERT INTO asistente_restaurante_resumenes (negocio_id, tipo, fecha, estado) VALUES ($1, 'prueba', $2, 'enviado')`, [A, HOY]);
      assert.match((await api(P_, S.adminA, 'POST', {})).datos.mensaje, /Ya mandaste 5 pruebas en la última hora/);
      // B: sin número guardado, y las pruebas de A no le cuentan.
      assert.deepStrictEqual((await api(P_, S.adminB, 'POST', {})).datos, { ok: false, mensaje: 'Primero guarda el número que recibe el resumen.' });
      await borrarResumenes();
    });

    await t('R5. «Enviar prueba» por dentro: la plantilla sin cifras al número guardado; si Meta la rechaza lo dice', async () => {
      const leida = await C.leerConfiguracion(pool, A);
      const m = meta();
      const ok = await EN.enviarPrueba({ db: pool, negocio: NA, cfg: leida, fetchImpl: m, credencialesDe: credenciales() });
      assert.deepStrictEqual(ok, { ok: true, mensaje: 'Listo: Meta aceptó la prueba para el número que termina en 0001.' });
      assert.strictEqual(m.pedidas[0].body.to, `52${NUM_A}`);
      assert.deepStrictEqual(m.pedidas[0].body.template.components[0].parameters.map((x) => x.text), RS.variablesDePrueba(NOMBRE_A));
      const mal = await EN.enviarPrueba({ db: pool, negocio: NA, cfg: leida, fetchImpl: meta(400, { error: { code: 132001 } }), credencialesDe: credenciales() });
      assert.deepStrictEqual(mal, { ok: false, mensaje: 'No salió: La plantilla xabor_resumen_asistente_v1 no existe o no está aprobada en Meta.' });
      assert.deepStrictEqual((await filas(A)).map((f) => [f.tipo, f.estado, f.destino]), [['prueba', 'enviado', '0001'], ['prueba', 'fallo', '0001']]);
      assert.deepStrictEqual(await avisosDe(A, 'asistente_resumen_fallo'), [], 'una prueba fallida no va a la campanita: la tarjeta ya lo dice');
      const d = (await api(RUTA, S.adminA)).datos;
      assert.deepStrictEqual(d.estadoResumen.ultimos.map((u) => [u.tipo, u.estado]), [['prueba', 'fallo'], ['prueba', 'enviado']]);
      assert.ok(!JSON.stringify(d.estadoResumen).includes(NUM_A));
      await borrarResumenes();
    });

    await t('R6. el reporte de las 22:01: superadmin recibe 410 y no se manda nada; un administrador ni eso', async () => {
      const r = await api('/api/admin/reporte-diario/enviar', S.super, 'POST', {});
      assert.strictEqual(r.status, 410, JSON.stringify(r.datos));
      assert.match(r.datos.error, /se retiró/);
      const adm = await api('/api/admin/reporte-diario/enviar', S.adminA, 'POST', {});
      assert.ok([401, 403].includes(adm.status), `un administrador recibió ${adm.status}`);
    });
  } finally {
    try { srv.detener(); } catch { /* ya terminó */ }
  }

  // ═══ Z. La reversa y el Pre-Deploy, en esta copia desechable ═══════════
  await t('Z1. con la 165 encima la 160 y la 164 siguen «Ya aplicadas»; el _down la quita, el reloj no falla y el Pre-Deploy la vuelve a poner', async () => {
    const { execFileSync } = await import('child_process');
    const correr = (n) => execFileSync(process.execPath, [`scripts/${n}.mjs`], { cwd: raiz(''), env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(correr('predeploy-160-avisos-panel'), /Ya aplicada/);
    assert.match(correr('predeploy-164-asistente-restaurante'), /\[predeploy-164\] Ya aplicada/);
    assert.match(correr('predeploy-165-asistente-ia-resumen'), /\[predeploy-165\] Ya aplicada/);
    await q(readFileSync(raiz('migrations/165_asistente_ia_resumen_down.sql'), 'utf8'));
    const { rows: [sin] } = await q("SELECT to_regclass('public.asistente_restaurante_resumenes') IS NULL AND to_regclass('public.asistente_restaurante_gasto_ia') IS NULL AS fuera");
    assert.ok(sin.fuera, 'el _down no quitó las tablas');
    await cfg(A, C.CLAVE_RESUMEN, JSON.stringify(ON()));
    assert.deepStrictEqual(await EN.enviarResumenesPendientes({ db: pool, ahora: a(DIA2, 23, 0), fetchImpl: meta(), credencialesDe: credenciales() }), { revisadas: 0, enviados: 0, fallos: 0 });
    assert.strictEqual(await C.estadoResumen(pool, A), null, 'sin la 165 la tarjeta debe pintarse sin el estado');
    assert.match(correr('predeploy-160-avisos-panel'), /Ya aplicada/, 'el _down dejó mal la lista de la campanita');
    assert.match(correr('predeploy-165-asistente-ia-resumen'), /\[predeploy-165\] Aplicada/);
    assert.match(correr('predeploy-165-asistente-ia-resumen'), /\[predeploy-165\] Ya aplicada/);
    await cfg(A, C.CLAVE_RESUMEN, undefined);
  });
} finally {
  await limpiar().catch((e) => console.error('limpieza:', e.message));
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas) console.log(fallos.map((f) => ` - ${f}`).join('\n'));
await pool.end().catch(() => {});
process.exit(fallidas ? 1 : 0);
