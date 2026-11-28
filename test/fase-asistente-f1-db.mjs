// ASISTENTE DEL RESTAURANTE, Fase 1: la corrida, la migración 164 y las rutas,
// contra Postgres y con el servidor real.
//
// Negocios y ventas INVENTADOS, creados aquí y borrados al final. Cubre:
//   M. la migración: tablas, reglas y llaves que impiden cruzar negocios;
//   C. la corrida: bandera apagada por omisión, ventana de 6 a 12, una sola
//      vez al día aunque lleguen dos procesos, ensayo (no se muestra) contra
//      visible, solo los datos de SU sucursal, sin repetir al día siguiente,
//      «No avisar de esto», una falla queda anotada y se reintenta pasada
//      una hora, y la lectura es de solo lectura;
//   R. las rutas: solo administrador con POS, solo destinatarios, solo su
//      negocio, y la lista de destinatarios falla cerrada;
//   Z. la reversa y el Pre-Deploy.
//
// El servidor de prueba corre la revisión de cada minuto: para que no compita
// con la suite, las sucursales de prueba viven en una zona horaria donde
// AHORA no es de 6 a 12 (las corridas de la suite pasan su propio «ahora»).
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
const { sumarDias } = await import('../src/asistenteRestaurante/reglas.js');
const P = await import('../src/asistenteRestaurante/proceso.js');
const AV = await import('../src/asistenteRestaurante/avisos.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  if (process.env.CASOS && !new RegExp(process.env.CASOS).test(nombre)) return;
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ─── La zona de las sucursales de prueba ──────────────────────────────────
const ZONAS = ['America/Matamoros', 'Asia/Tokyo', 'Europe/Madrid', 'America/Los_Angeles', 'Australia/Sydney'];
const TZ = ZONAS.find((z) => [0, 20, 40].every((m) => { const h = P.horaLocal(new Date(Date.now() + m * 60000), z); return h < 5 || h >= 13; }));
assert.ok(TZ, 'ninguna zona fuera de la ventana');
const HOY = fechaOperativaDe(new Date(), TZ);
const AYER = sumarDias(HOY, -1);
const a = (fecha, h, mi = 0) => { const [y, mo, d] = fecha.split('-').map(Number); return instanteLocal(y, mo, d, h, mi, 0, TZ); };
const SIETE = a(HOY, 7);

// ─── Negocios, usuarios y ventas inventados ───────────────────────────────
const TAG = 'AS' + (Date.now() % 1e8).toString(36).toUpperCase();
const SLUG = (l) => `${TAG.toLowerCase()}-asis-f1-${l}`;
const q = (sql, params) => pool.query(sql, params);
const uno = async (sql, params) => (await q(sql, params)).rows[0];

async function limpiar() {
  const { rows } = await q(`SELECT id FROM negocios WHERE slug LIKE '%-asis-f1-_'`);
  for (const { id } of rows) {
    const del = (sql) => q(sql, [id]).catch(() => {});
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
async function venta(neg, folio, instante, datos) {
  await q('INSERT INTO pedidos_activos (folio, estado, datos, negocio_id, created_at) VALUES ($1,$2,$3,$4,$5::timestamp)',
    [folio, 'entregado', JSON.stringify({ id: folio, canal: 'pos', modalidad: 'recoger en tienda', ...datos }), neg, instante.toISOString()]);
}
async function cfg(neg, clave, valor) {
  await q('DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2', [neg, clave]);
  if (valor !== undefined) await q('INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,$2,$3)', [neg, clave, valor]);
}
const borrarCorridas = (neg) => q('DELETE FROM asistente_restaurante_corridas WHERE negocio_id = $1', [neg]);
const corridas = async (neg) => (await q(
  'SELECT id::text, fecha::text, modo, estado, candidatos, elegidos, error FROM asistente_restaurante_corridas WHERE negocio_id = $1 ORDER BY fecha, id', [neg])).rows;
const hallazgos = async (neg) => (await q(
  `SELECT h.id::text, h.tipo, h.firma, h.impacto::float, h.titulo, h.contenido, h.elegido, h.motivo, h.mostrado, h.visto_en, c.fecha::text AS fecha
     FROM asistente_restaurante_hallazgos h JOIN asistente_restaurante_corridas c ON c.id = h.corrida_id
    WHERE h.negocio_id = $1 ORDER BY c.fecha, h.id`, [neg])).rows;

const A = await negocio('a', `${TAG} Sucursal A`);
const B = await negocio('b', `${TAG} Sucursal B`);
const ADMIN_A = await usuario(A, `${TAG} Dueño A`, 'admin');
const ADMIN2_A = await usuario(A, `${TAG} Gerente A`, 'admin');
const STAFF_A = await usuario(A, `${TAG} Cajera A`, 'staff');
const ADMIN_B = await usuario(B, `${TAG} Dueño B`, 'admin');
const NA = { id: A, nombre: `${TAG} Sucursal A`, tz: TZ };
const NB = { id: B, nombre: `${TAG} Sucursal B`, tz: TZ };

// Ayer: en A, 3 ventas sin forma de pago entre 5 normales; en B, 2 sin forma de pago.
const F = (s) => `ASF-${TAG}-${s}`;
const item = (nombre, precio) => ({ nombre, cantidad: 1, precio_unitario: precio });
for (let i = 1; i <= 5; i++) await venta(A, F(`AOK${i}`), a(AYER, 9 + i), { forma_pago: 'efectivo', subtotal: 120, total: 120, items: [item('Café', 120)] });
await venta(A, F('A1'), a(AYER, 15), { subtotal: 150, total: 150, items: [item('Molletes', 150)] });
await venta(A, F('A2'), a(AYER, 16), { subtotal: 200, total: 200, items: [item('Molletes', 200)] });
await venta(A, F('A3'), a(AYER, 17), { subtotal: 250, total: 250, items: [item('Molletes', 250)] });
await venta(B, F('B1'), a(AYER, 15), { subtotal: 310, total: 310, items: [item('Torta', 310)] });
await venta(B, F('B2'), a(AYER, 16), { subtotal: 420, total: 420, items: [item('Torta', 420)] });

const foliosDe = (h) => (h.contenido?.detalle?.tabla?.filas || []).map((f) => f[0]).sort();

try {
  // ═══ M. La migración ═══════════════════════════════════════════════════
  await t('M1. las 4 tablas existen y sus reglas rechazan valores fuera de lista y cruces entre negocios', async () => {
    for (const tabla of ['corridas', 'hallazgos', 'opiniones', 'silenciados']) {
      const { rows: [r] } = await q('SELECT to_regclass($1) IS NOT NULL AS hay', [`public.asistente_restaurante_${tabla}`]);
      assert.ok(r.hay, `falta asistente_restaurante_${tabla}: aplica scripts/predeploy-164-asistente-restaurante.mjs`);
    }
    const cA = await uno(`INSERT INTO asistente_restaurante_corridas (negocio_id, fecha, modo) VALUES ($1, '2000-01-01', 'ensayo') RETURNING id`, [A]);
    try {
      await assert.rejects(q(`INSERT INTO asistente_restaurante_corridas (negocio_id, fecha, modo) VALUES ($1, '2000-01-02', 'otro')`, [A]), /corridas_modo/);
      await assert.rejects(q(`INSERT INTO asistente_restaurante_corridas (negocio_id, fecha, modo) VALUES ($1, '2000-01-01', 'ensayo')`, [A]), /duplicate key/);
      const ins = (neg, corrida, extra = {}) => q(
        `INSERT INTO asistente_restaurante_hallazgos (negocio_id, corrida_id, tipo, firma, titulo, contenido, elegido, mostrado)
         VALUES ($1, $2, $3, 'f', 't', $4::jsonb, $5, $6) RETURNING id`,
        [neg, corrida, extra.tipo || 'producto_baja', extra.contenido || '{}', extra.elegido ?? true, extra.mostrado ?? false]);
      await assert.rejects(ins(A, cA.id, { tipo: 'Otro Tipo' }), /hallazgos_tipo/);
      await assert.rejects(ins(A, cA.id, { contenido: '[]' }), /hallazgos_contenido/);
      await assert.rejects(ins(A, cA.id, { elegido: false, mostrado: true }), /hallazgos_mostrado/);
      await assert.rejects(ins(B, cA.id), /foreign key/, 'un hallazgo de B colgó de la corrida de A');
      const hA = (await ins(A, cA.id)).rows[0];
      await assert.rejects(q(`INSERT INTO asistente_restaurante_opiniones (negocio_id, hallazgo_id, usuario_id, opinion, tipo, firma)
                               VALUES ($1, $2, $3, 'util', 'producto_baja', 'f')`, [B, hA.id, ADMIN_B]), /foreign key/, 'B opinó sobre el hallazgo de A');
      await assert.rejects(q(`INSERT INTO asistente_restaurante_opiniones (negocio_id, hallazgo_id, usuario_id, opinion, tipo, firma)
                               VALUES ($1, $2, $3, 'meh', 'producto_baja', 'f')`, [A, hA.id, ADMIN_A]), /opiniones_opinion/);
    } finally { await borrarCorridas(A); }
  });

  // ═══ C. La corrida ═════════════════════════════════════════════════════
  await t('C1. nace apagada: sin la bandera no se corre nada en ninguna sucursal', async () => {
    const r = await P.correrSucursalesPendientes({ ahora: SIETE });
    assert.strictEqual(r.fallos, 0);
    assert.deepStrictEqual(await corridas(A), []);
    assert.deepStrictEqual(await corridas(B), []);
    await cfg(A, AV.BANDERA, 'si');
    await P.correrSucursalesPendientes({ ahora: SIETE });
    assert.deepStrictEqual(await corridas(A), [], 'solo «true» la enciende');
  });

  await t('C2. ventana de 6:00 a 12:00 de la sucursal', async () => {
    await cfg(A, AV.BANDERA, 'true');
    await P.correrSucursalesPendientes({ ahora: a(HOY, 5, 59) });
    await P.correrSucursalesPendientes({ ahora: a(HOY, 12, 0) });
    assert.deepStrictEqual(await corridas(A), [], 'corrió fuera de la ventana');
    assert.strictEqual(P.enVentana(a(HOY, 6, 0), TZ), true);
    assert.strictEqual(P.enVentana(a(HOY, 11, 59), TZ), true);
  });

  await t('C3. ensayo: se calcula y se guarda TODO con su motivo, pero nada se muestra; solo con los datos de SU sucursal', async () => {
    const r = await P.correrSucursalesPendientes({ ahora: SIETE });
    assert.strictEqual(r.corridas, 1, JSON.stringify(r));
    const [c] = await corridas(A);
    assert.deepStrictEqual([c.fecha, c.modo, c.estado], [HOY, 'ensayo', 'lista']);
    const hs = await hallazgos(A);
    assert.strictEqual(c.candidatos, hs.length);
    const sinPago = hs.find((h) => h.tipo === 'ventas_sin_forma_pago');
    assert.ok(sinPago, `no salió «sin forma de pago»: ${hs.map((h) => h.tipo).join(', ')}`);
    assert.deepStrictEqual(foliosDe(sinPago), [F('A1'), F('A2'), F('A3')].sort(), 'leyó ventas de otra sucursal');
    assert.strictEqual(sinPago.impacto, 600);
    assert.strictEqual(sinPago.elegido, true);
    assert.ok(hs.every((h) => h.mostrado === false), 'en ensayo se mostró algo');
    assert.ok(hs.every((h) => typeof h.motivo === 'string' && h.motivo));
    assert.ok(sinPago.contenido.sugerencia && sinPago.contenido.revisar?.numero, 'sin acción o sin número a revisar');
    const todo = JSON.stringify(hs);
    assert.ok(!todo.includes(B) && !todo.includes(F('B1')), 'hay datos de B en A');
    assert.deepStrictEqual(await corridas(B), [], 'B corrió sin su bandera');
  });

  await t('C4. una sola corrida al día, aunque lleguen dos procesos a la vez', async () => {
    const r = await P.correrSucursalesPendientes({ ahora: SIETE });
    assert.strictEqual(r.corridas, 0);
    const dos = await Promise.all([
      P.correrSucursal({ negocio: NA, hoy: sumarDias(HOY, 30), ahora: SIETE }),
      P.correrSucursal({ negocio: NA, hoy: sumarDias(HOY, 30), ahora: SIETE }),
    ]);
    assert.strictEqual(dos.filter((x) => x.omitida).length, 1, JSON.stringify(dos));
    assert.strictEqual((await corridas(A)).filter((c) => c.fecha === sumarDias(HOY, 30)).length, 1);
    await q('DELETE FROM asistente_restaurante_corridas WHERE negocio_id = $1 AND fecha = $2', [A, sumarDias(HOY, 30)]);
  });

  await t('C5. la otra sucursal corre con SUS ventas y sin ver las de A', async () => {
    await cfg(B, AV.BANDERA, 'true');
    await P.correrSucursalesPendientes({ ahora: SIETE });
    const sinPago = (await hallazgos(B)).find((h) => h.tipo === 'ventas_sin_forma_pago');
    assert.deepStrictEqual(foliosDe(sinPago), [F('B1'), F('B2')].sort());
    assert.strictEqual(sinPago.impacto, 730);
    assert.ok(!JSON.stringify(await hallazgos(B)).includes(F('A1')));
  });

  await t('C6. la lectura es de SOLO LECTURA y cada consulta lleva el id de SU sucursal (nunca el de otra)', async () => {
    const registro = [];
    const espia = {
      connect: async () => {
        const c = await pool.connect();
        return {
          query: (text, params) => { registro.push({ sql: String(text?.text || text), params: params || [] }); return c.query(text, params); },
          release: () => c.release(),
        };
      },
    };
    const r = await P.calcularSucursal(espia, { negocio: NA, hoy: HOY, ahora: SIETE });
    assert.ok(r.todos.length > 0);
    assert.strictEqual(registro[0].sql, 'BEGIN READ ONLY');
    assert.strictEqual(registro.at(-1).sql, 'COMMIT');
    for (const { sql, params } of registro) {
      assert.ok(!/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i.test(sql), `escribe: ${sql.slice(0, 80)}`);
      if (/\b(pedidos_activos|clientes_negocio|usuarios|configuracion|restaurante_\w+|menu_\w+|pedido_lineas_\w+)\b/.test(sql) && !/to_regclass|information_schema/.test(sql)) {
        assert.ok(params.flat().includes(A), `sin el id de la sucursal: ${sql.replace(/\s+/g, ' ').slice(0, 120)}`);
      }
      assert.ok(!params.flat().includes(B), 'una consulta llevó el id de otra sucursal');
    }
    // Y la base de verdad rechaza escribir dentro de esa transacción.
    const c = await pool.connect();
    try {
      await c.query('BEGIN READ ONLY');
      await assert.rejects(c.query(`UPDATE configuracion SET valor = valor WHERE negocio_id = $1`, [A]), /read-only transaction/);
    } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  });

  await t('C7. al día siguiente no se repite lo mismo si no empeoró (también en ensayo)', async () => {
    const manana = sumarDias(HOY, 1);
    await P.correrSucursal({ negocio: NA, hoy: manana, ahora: a(manana, 7) });
    const h = (await hallazgos(A)).find((x) => x.fecha === manana && x.tipo === 'ventas_sin_forma_pago');
    assert.strictEqual(h.elegido, false);
    assert.match(h.motivo, /^ya se mostró hace 1 días y no empeoró$/);
    await q('DELETE FROM asistente_restaurante_corridas WHERE negocio_id = $1 AND fecha = $2', [A, manana]);
  });

  await t('C8. una falla queda anotada (estado fallo), no repite enseguida y se reintenta pasada una hora', async () => {
    const dia = sumarDias(HOY, 40);
    await assert.rejects(P.correrSucursal({ negocio: { ...NA, tz: 'Zona/Falsa' }, hoy: dia, ahora: SIETE }));
    let [c] = (await corridas(A)).filter((x) => x.fecha === dia);
    assert.strictEqual(c.estado, 'fallo');
    assert.ok(c.error && c.error.length <= 300);
    assert.deepStrictEqual(await P.correrSucursal({ negocio: NA, hoy: dia, ahora: SIETE }), { omitida: true });
    await q(`UPDATE asistente_restaurante_corridas SET terminada_en = now() - interval '2 hours' WHERE negocio_id = $1 AND fecha = $2`, [A, dia]);
    const r = await P.correrSucursal({ negocio: NA, hoy: dia, ahora: SIETE });
    assert.ok(r.corridaId, 'no se reintentó');
    [c] = (await corridas(A)).filter((x) => x.fecha === dia);
    assert.strictEqual(c.estado, 'lista');
    await q('DELETE FROM asistente_restaurante_corridas WHERE negocio_id = $1 AND fecha = $2', [A, dia]);
  });

  // ═══ R. Las rutas, con el servidor real ════════════════════════════════
  const { crearTokenSesion } = await import('../src/services/session.js');
  const { arrancarServidor } = await import('./lib-servidor.mjs');
  const ses = (u, n, rol) => encodeURIComponent(crearTokenSesion({ usuarioId: u, negocioId: n, rol }));
  const S = { adminA: ses(ADMIN_A, A, 'admin'), admin2A: ses(ADMIN2_A, A, 'admin'), staffA: ses(STAFF_A, A, 'staff'), adminB: ses(ADMIN_B, B, 'admin') };
  const srv = await arrancarServidor({ PORT: process.env.TEST_PORT_ASISTENTE || '4795' }, { timeoutMs: 40000 });
  const RUTA = '/api/admin/asistente-restaurante/avisos';
  async function api(ruta, sesion, metodo = 'GET', cuerpo = {}) {
    const r = await fetch(`${srv.base}${ruta}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(sesion ? { Cookie: `xabor_sesion=${sesion}` } : {}) },
      body: metodo === 'POST' ? JSON.stringify(cuerpo) : undefined,
    });
    let datos = null; try { datos = await r.json(); } catch {}
    return { status: r.status, datos, cache: r.headers.get('cache-control') };
  }
  try {
    await t('R1. en ensayo nadie lo ve, ni el destinatario', async () => {
      await cfg(A, AV.CLAVE_DESTINATARIOS, JSON.stringify([ADMIN_A]));
      const r = await api(RUTA, S.adminA);
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.datos, { activo: false, sinVer: 0, avisos: [] });
      assert.match(r.cache || '', /no-store/);
    });

    let avisoA = null;
    await t('R2. visible: lo ve SOLO el destinatario; otro administrador no; el operador 403; sin sesión 401', async () => {
      await borrarCorridas(A);
      await cfg(A, AV.CLAVE_MODO, 'visible');
      await P.correrSucursal({ negocio: NA, modo: 'visible', hoy: HOY, ahora: SIETE });
      const hs = await hallazgos(A);
      assert.ok(hs.some((h) => h.mostrado), 'visible y nada mostrado');
      assert.ok(hs.every((h) => h.mostrado === h.elegido));
      const r = await api(RUTA, S.adminA);
      assert.strictEqual(r.datos.activo, true);
      assert.strictEqual(r.datos.avisos.length, hs.filter((h) => h.mostrado).length);
      assert.strictEqual(r.datos.sinVer, r.datos.avisos.length);
      avisoA = r.datos.avisos.find((x) => x.tipo === 'ventas_sin_forma_pago');
      assert.ok(avisoA && avisoA.sugerencia && avisoA.revisar && avisoA.detalle, JSON.stringify(r.datos.avisos[0]));
      assert.ok(!JSON.stringify(r.datos).includes(F('B1')));
      assert.deepStrictEqual((await api(RUTA, S.admin2A)).datos, { activo: false, sinVer: 0, avisos: [] }, 'lo vio quien no está en la lista');
      assert.strictEqual((await api(RUTA, S.staffA)).status, 403);
      assert.strictEqual((await api(`${RUTA}/visto-todos`, S.staffA, 'POST')).status, 403);
      assert.strictEqual((await api(RUTA, null)).status, 401);
      assert.strictEqual((await api(`${RUTA}/${avisoA.id}/opinion`, S.admin2A, 'POST', { opinion: 'util' })).status, 403);
    });

    await t('R2c. la lista pone primero los de control del mismo día, aunque valgan menos', async () => {
      const dia = sumarDias(HOY, 1);
      const { rows: [c] } = await q(`INSERT INTO asistente_restaurante_corridas (negocio_id, fecha, modo, estado, candidatos, elegidos)
                                     VALUES ($1, $2, 'visible', 'lista', 2, 2) RETURNING id`, [A, dia]);
      try {
        const ins = async (tipo, impacto) => (await q(
          `INSERT INTO asistente_restaurante_hallazgos (negocio_id, corrida_id, tipo, firma, impacto, titulo, elegido, motivo, mostrado)
           VALUES ($1, $2, $3, $3, $4, $5, true, 'elegido', true) RETURNING id::text AS id`, [A, c.id, tipo, impacto, `Prueba ${tipo}`])).rows[0].id;
        const venta = await ins('producto_baja', 9000);
        const control = await ins('cortesias_altas', 600);
        const lista = (await api(RUTA, S.adminA)).datos.avisos.filter((x) => x.fecha === dia).map((x) => x.id);
        assert.deepStrictEqual(lista, [control, venta], 'el de control no va primero');
      } finally {
        await q('DELETE FROM asistente_restaurante_corridas WHERE negocio_id = $1 AND fecha = $2', [A, dia]);
      }
    });

    await t('R3. otra sucursal no ve, no marca y no opina sobre los avisos de A', async () => {
      await cfg(B, AV.CLAVE_MODO, 'visible');
      await cfg(B, AV.CLAVE_DESTINATARIOS, JSON.stringify([ADMIN_B]));
      await borrarCorridas(B);
      await P.correrSucursal({ negocio: NB, modo: 'visible', hoy: HOY, ahora: SIETE });
      const lb = await api(RUTA, S.adminB);
      assert.strictEqual(lb.datos.activo, true);
      assert.ok(lb.datos.avisos.length > 0, 'B visible sin avisos');
      assert.ok(!lb.datos.avisos.some((x) => x.id === avisoA.id), 'B ve un aviso de A');
      assert.strictEqual((await api(`${RUTA}/${avisoA.id}/visto`, S.adminB, 'POST')).datos.marcados, 0);
      assert.strictEqual((await api(`${RUTA}/${avisoA.id}/opinion`, S.adminB, 'POST', { opinion: 'no_avisar' })).status, 404);
      await api(`${RUTA}/visto-todos`, S.adminB, 'POST');
      const hA = (await hallazgos(A)).find((h) => h.id === avisoA.id);
      assert.strictEqual(hA.visto_en, null, '«todos» de B marcó el de A');
      const { rows } = await q('SELECT COUNT(*)::int AS n FROM asistente_restaurante_silenciados WHERE negocio_id = $1', [A]);
      assert.strictEqual(rows[0].n, 0);
    });

    await t('R4. Útil / No útil: una opinión por persona (la última gana); valores inválidos 400', async () => {
      assert.strictEqual((await api(`${RUTA}/${avisoA.id}/opinion`, S.adminA, 'POST', { opinion: 'meh' })).status, 400);
      assert.strictEqual((await api(`${RUTA}/abc/opinion`, S.adminA, 'POST', { opinion: 'util' })).status, 400);
      assert.strictEqual((await api(`${RUTA}/abc/visto`, S.adminA, 'POST')).status, 400);
      assert.deepStrictEqual((await api(`${RUTA}/${avisoA.id}/opinion`, S.adminA, 'POST', { opinion: 'util' })).datos, { ok: true, id: avisoA.id, opinion: 'util' });
      await api(`${RUTA}/${avisoA.id}/opinion`, S.adminA, 'POST', { opinion: 'no_util' });
      const { rows } = await q('SELECT opinion, usuario_id::text AS u FROM asistente_restaurante_opiniones WHERE negocio_id = $1', [A]);
      assert.deepStrictEqual(rows, [{ opinion: 'no_util', u: ADMIN_A }]);
      const l = await api(RUTA, S.adminA);
      assert.strictEqual(l.datos.avisos.find((x) => x.id === avisoA.id).opinion, 'no_util');
    });

    await t('R5. «Visto» y «Marcar todos» bajan el número; solo en su sucursal', async () => {
      await q('UPDATE asistente_restaurante_hallazgos SET visto_en = NULL, visto_por = NULL WHERE negocio_id = $1', [B]);
      const antes = (await api(RUTA, S.adminA)).datos.sinVer;
      assert.strictEqual((await api(`${RUTA}/${avisoA.id}/visto`, S.adminA, 'POST')).datos.marcados, 1);
      assert.strictEqual((await api(RUTA, S.adminA)).datos.sinVer, antes - 1);
      await api(`${RUTA}/visto-todos`, S.adminA, 'POST');
      assert.strictEqual((await api(RUTA, S.adminA)).datos.sinVer, 0);
      assert.ok((await api(RUTA, S.adminB)).datos.sinVer > 0, '«todos» de A marcó los de B');
    });

    await t('R6. «No avisar de esto»: sale de la lista y la corrida siguiente ya no lo elige', async () => {
      assert.strictEqual((await api(`${RUTA}/${avisoA.id}/opinion`, S.adminA, 'POST', { opinion: 'no_avisar' })).status, 200);
      assert.ok(!(await api(RUTA, S.adminA)).datos.avisos.some((x) => x.id === avisoA.id));
      // Dos días después las ventas de ayer siguen en «la semana».
      const dia = sumarDias(HOY, 2);
      await P.correrSucursal({ negocio: NA, modo: 'visible', hoy: dia, ahora: a(dia, 7) });
      const h = (await hallazgos(A)).find((x) => x.fecha === dia && x.tipo === 'ventas_sin_forma_pago');
      assert.ok(h, 'la corrida siguiente no lo encontró');
      assert.strictEqual(h.motivo, 'no avisar de esto');
      assert.strictEqual(h.mostrado, false);
      const { rows } = await q('SELECT COUNT(*)::int AS n FROM asistente_restaurante_silenciados WHERE negocio_id = $1', [B]);
      assert.strictEqual(rows[0].n, 0, 'el silencio de A calló a B');
      await q('DELETE FROM asistente_restaurante_corridas WHERE negocio_id = $1 AND fecha = $2', [A, dia]);
    });

    await t('R7b. sin el módulo POS la ruta se niega, aunque la bandera, el modo y la lista estén encendidos', async () => {
      assert.strictEqual((await api(RUTA, S.adminB)).datos.activo, true, 'B debía verlo antes de quitar el POS');
      await q(`DELETE FROM negocio_modulos WHERE negocio_id = $1 AND modulo = 'pos'`, [B]);
      try {
        const r = await api(RUTA, S.adminB);
        assert.strictEqual(r.status, 403, `sin POS respondió ${r.status}`);
        assert.strictEqual(r.datos.codigo, 'modulo_no_contratado');
        assert.strictEqual((await api(`${RUTA}/visto-todos`, S.adminB, 'POST')).status, 403);
      } finally {
        await q(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'pos','activo')`, [B]);
      }
      assert.strictEqual((await api(RUTA, S.adminB)).datos.activo, true, 'no volvió con el POS');
    });

    await t('R7. la lista de destinatarios falla cerrada; la bandera apagada esconde todo', async () => {
      for (const valor of ['no-es-json', '["x"]', '{}', '', JSON.stringify([ADMIN2_A])]) {
        await cfg(A, AV.CLAVE_DESTINATARIOS, valor);
        assert.strictEqual((await api(RUTA, S.adminA)).datos.activo, false, `con «${valor}» lo vio`);
      }
      await cfg(A, AV.CLAVE_DESTINATARIOS, JSON.stringify([ADMIN_A.toUpperCase()]));
      assert.strictEqual((await api(RUTA, S.adminA)).datos.activo, true, 'el id en mayúsculas es el mismo usuario');
      await cfg(A, AV.BANDERA, 'false');
      assert.deepStrictEqual((await api(RUTA, S.adminA)).datos, { activo: false, sinVer: 0, avisos: [] });
      assert.strictEqual((await api(`${RUTA}/visto-todos`, S.adminA, 'POST')).status, 403);
      assert.strictEqual(AV.puedeVer({ activo: true, modo: 'visible', destinatarios: [ADMIN_A] }, { usuarioId: ADMIN_A, esSoporte: true }), false, 'soporte lo vería');
    });
  } finally {
    try { srv.detener(); } catch { /* ya terminó */ }
  }

  await t('R8. registro: rutas solo de administrador con POS; el trabajo del servidor fuera del camino de los pedidos', () => {
    const SERVER = readFileSync(raiz('src/server.js'), 'utf8');
    assert.match(SERVER, /^registrarRutasAsistenteRestaurante\(app, \{ requireAdminSeguro, requireModulo \}\);$/m);
    assert.match(SERVER, /import\('\.\/asistenteRestaurante\/proceso\.js'\)\n\s+\.then\(m => m\.correrSucursalesPendientes\(\)\)\n\s+\.catch\(/);
    const RUTAS = readFileSync(raiz('src/asistenteRestaurante/rutas.js'), 'utf8');
    assert.match(RUTAS, /const guardias = \[requireAdminSeguro, requireModulo\('pos'\)\];/);
    // 4 de la campanita (Fase 1) + 3 de la configuración (Fase 2) + «Enviar
    // prueba» (Fase 3), todas con guardias.
    assert.strictEqual((RUTAS.match(/app\.(get|post|put|patch|delete)\(/g) || []).length, 8);
    assert.strictEqual((RUTAS.match(/\.\.\.guardias,/g) || []).length, 8, 'una ruta sin guardias');
    assert.match(RUTAS, /esSoporte: req\.esSoporte === true/);
  });

  // ═══ Z. La reversa y el Pre-Deploy, en esta copia desechable ═══════════
  await t('Z1. reversa: el _down quita las 4 tablas, el Pre-Deploy las vuelve a crear vacías y la segunda vez no hace nada', async () => {
    const { execFileSync } = await import('child_process');
    const correr = () => execFileSync(process.execPath, ['scripts/predeploy-164-asistente-restaurante.mjs'],
      { cwd: raiz(''), env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(correr(), /\[predeploy-164\] Ya aplicada/);
    await q(readFileSync(raiz('migrations/164_asistente_restaurante_down.sql'), 'utf8'));
    const { rows: [sin] } = await q("SELECT to_regclass('public.asistente_restaurante_hallazgos') IS NULL AS fuera");
    assert.ok(sin.fuera, 'el _down no quitó las tablas');
    // Sin las tablas, la revisión de cada minuto no falla: no hace nada.
    await cfg(A, AV.BANDERA, 'true');
    assert.deepStrictEqual(await P.correrSucursalesPendientes({ ahora: SIETE }), { revisadas: 0, corridas: 0, fallos: 0 });
    assert.match(correr(), /\[predeploy-164\] Aplicada: 4 tablas del asistente vacías/);
    assert.match(correr(), /\[predeploy-164\] Ya aplicada/);
    const { rows: [c] } = await q('SELECT COUNT(*)::int AS n FROM asistente_restaurante_hallazgos');
    assert.strictEqual(c.n, 0);
  });
} finally {
  await limpiar().catch((e) => console.error('limpieza:', e.message));
}

console.log(`\n${pasadas} OK, ${fallidas} FALLO`);
if (fallos.length) console.log(fallos.map((f) => `  - ${f}`).join('\n'));
await pool.end().catch(() => {});
process.exit(fallidas ? 1 : 0);
