// ASISTENTE DEL RESTAURANTE, Mejora 1: el botón de cada tarjeta, contra
// Postgres, una Graph API SIMULADA en 127.0.0.1 y el servidor real.
//
// Negocios, usuarios, clientes y ventas INVENTADOS, creados aquí y borrados al
// final. Sin red externa ni teléfonos reales. Cubre:
//   P. sin base: la forma de lo que guarda cada aviso para su botón, el botón
//      de cada tipo (y que ningún cliente viaja al navegador), que un botón
//      dañado deja el aviso sin botón (no lo tumba), que la IA no recibe nada
//      de esto y que, apagado, la tarjeta sale igual que en la Fase 4;
//   M. la 166: se aplica vacía, es repetible, se repara, tiene reversa y sus
//      reglas frenan lo que no debe entrar;
//   D. con base: la corrida guarda el botón; la bandera por sucursal; anotar
//      el botón solo en un aviso elegido de la propia sucursal; los clientes
//      del aviso solo para la propia sucursal;
//   C. Campañas desde un aviso: solo sus clientes que estén en la Lista de la
//      sucursal (y con los filtros de siempre), nunca los de otra; sin aviso
//      válido no hay público; al crearla queda anotada; nada sale solo;
//   R. las rutas reales: quién puede anotar y qué responde cada caso.
//
// Las sucursales viven en una zona donde AHORA son de las 0 a las 5: el
// servidor de prueba corre cada minuto la revisión (6 a 12) y así no les toca.
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';

// ── Guardas: solo base local de pruebas, solo red local ──────────────────────
if (!process.env.DATABASE_URL) { console.error('Falta DATABASE_URL'); process.exit(2); }
{
  const url = new URL(process.env.DATABASE_URL);
  assert(['127.0.0.1', 'localhost'].includes(url.hostname), 'solo base local');
  assert.match(url.pathname, /^\/test_botones_/, 'solo una base test_botones_*');
  assert.match(process.env.NODE_OPTIONS || '', /red-solo-local/, 'corre con NODE_OPTIONS=--import=./test/red-solo-local.mjs');
}
const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const leer = (r) => readFileSync(new URL(`../${r}`, import.meta.url), 'utf8');

// ── Graph API simulada (antes de importar los módulos) ───────────────────────
const META = { plantillas: [], envios: [] };
const servidorMeta = http.createServer(async (req, res) => {
  let cuerpo = '';
  for await (const c of req) cuerpo += c;
  const json = (s, d) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  const m = new URL(req.url, 'http://x').pathname.match(/^\/v\d+\.\d+\/([^/]+)(\/[a-z_]+)?$/);
  if (!m) return json(404, { error: { code: 100 } });
  if (m[2] === '/message_templates') return json(200, { data: META.plantillas });
  if (m[2] === '/messages' && req.method === 'POST') {
    META.envios.push(JSON.parse(cuerpo));
    return json(200, { messages: [{ id: `wamid.prueba.${randomUUID()}` }] });
  }
  if (!m[2]) return json(200, { quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K' });
  return json(404, {});
});
await new Promise((ok) => servidorMeta.listen(0, '127.0.0.1', ok));
process.env.META_GRAPH_BASE_URL = `http://127.0.0.1:${servidorMeta.address().port}`;

const { pool, actualizarConfiguracion } = await import('../src/services/database.js');
const { instanteLocal, fechaOperativaDe } = await import('../src/services/cortesCaja.js');
const R = await import('../src/asistenteRestaurante/reglas.js');
const P = await import('../src/asistenteRestaurante/proceso.js');
const AV = await import('../src/asistenteRestaurante/avisos.js');
const PA = await import('../src/asistenteRestaurante/pantalla.js');
const AC = await import('../src/asistenteRestaurante/acciones.js');
const RD = await import('../src/asistenteRestaurante/redaccion.js');
const svc = await import('../src/services/campanasWa.js');
const PL = await import('../src/services/campanasWaPlantillas.js');
const { registrarRutasCampanasWa } = await import('../src/services/campanasWaRutas.js');
const { ErrorCampana } = svc;

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  if (process.env.CASOS && !new RegExp(process.env.CASOS).test(nombre)) return;
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}
async function rechaza(promesa, codigo, clase = null) {
  let e = null;
  try { await promesa; } catch (x) { e = x; }
  assert.ok(e, `debía rechazar con ${codigo}: no rechazó`);
  if (clase) assert.ok(e instanceof clase, `debía ser ${clase.name}: ${e.message}`);
  assert.equal(e.codigo || e.code, codigo, e.message);
  return e;
}

const U1 = '0b1f6c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
const U2 = '1c2d3e4f-5a6b-4c7d-9e8f-a0b1c2d3e4f5';

// ═══ P. Sin base ══════════════════════════════════════════════════════════
await t('P1. la forma de lo que guarda un aviso para su botón: solo números internos, fechas y id de clientes', () => {
  assert.deepEqual(R.faltasDeAccion(null), []);
  assert.deepEqual(R.faltasDeAccion(undefined), []);
  for (const bien of [{ producto: 12 }, { categoria: 'c:7', desde: '2026-10-01', hasta: '2026-10-28' }, { canal: 'tienda_online', desde: '2026-10-01', hasta: '2026-10-28' },
    { dia: 0 }, { dia: 6 }, { franja: '13-15' }, { clientes: [U1, U2.toUpperCase()] }, { categorias: ['c:1', 'c:2'] }, { desde: '2026-11-01', hasta: '2026-11-07' }]) {
    assert.deepEqual(R.faltasDeAccion(bien), [], JSON.stringify(bien));
  }
  const mal = [
    'texto', [1], { producto: 0 }, { producto: '12' }, { producto: 1.5 }, { categoria: 'p:7' }, { categoria: 'sin' }, { canal: 'Tienda' },
    { canal: 'uber-eats' }, { dia: 7 }, { dia: -1 }, { franja: 'otras' }, { desde: '1/11/2026' }, { clientes: [] }, { clientes: ['5288123'] },
    { clientes: Array.from({ length: R.MAXIMO_CLIENTES_ACCION + 1 }, () => U1) }, { categorias: ['c:1', 'p:2'] }, { telefono: '8781234567' }, { nombre: 'Ana' },
  ];
  for (const x of mal) assert.ok(R.faltasDeAccion(x).length > 0, `dejó pasar ${JSON.stringify(x).slice(0, 80)}`);
  // Y la revisión de cada hallazgo lo exige.
  const h = { tipo: 'producto_baja', firma: 'producto_baja:p:1', impacto: 10, titulo: 'x', sugerencia: 'y', detalle: { numeros: [] } };
  assert.deepEqual(R.faltasDeHallazgo({ ...h, accion: { producto: 1 } }), R.faltasDeHallazgo(h));
  assert.ok(R.faltasDeHallazgo({ ...h, accion: { telefono: '8781234567' } }).length > R.faltasDeHallazgo(h).length);
});

await t('P2. el botón de cada tipo abre su pantalla con sus datos; de los clientes solo va cuántos son', () => {
  const de = (tipo, accion) => AC.accionDe(tipo, accion === undefined ? {} : { accion });
  const clientes = de('clientes_dejaron', { clientes: [U1, U2] });
  assert.deepEqual(clientes, { clave: 'campana_clientes', etiqueta: 'Preparar campaña', destino: 'campanas',
    datos: { cuantos: 2, nombre: 'Clientes frecuentes que no han vuelto', sugerencia: AC.MENSAJES_SUGERIDOS.clientes_dejaron } });
  assert.ok(!JSON.stringify(clientes).includes(U1), 'el botón lleva los id de los clientes');
  assert.deepEqual(de('nuevos_regresan_menos').datos.segmento, 'nuevo');
  assert.deepEqual(de('producto_baja', { producto: 12 }), { clave: 'menu_producto', etiqueta: 'Abrir en Menú', destino: 'menu', datos: { producto: 12 } });
  assert.deepEqual(de('producto_sube', { producto: 3 }).datos, { producto: 3 });
  assert.deepEqual(de('categoria_baja', { categoria: 'c:7', desde: '2026-10-01', hasta: '2026-10-28' }).datos,
    { vista: 'categorias', categoria: 'c:7', desde: '2026-10-01', hasta: '2026-10-28' });
  assert.deepEqual(de('canal_sube', { canal: 'rappi', desde: '2026-10-01', hasta: '2026-10-28' }).datos,
    { vista: 'productos', canal: 'rappi', desde: '2026-10-01', hasta: '2026-10-28' });
  assert.deepEqual(de('dia_flojo', { dia: 2 }), { clave: 'promocion', etiqueta: 'Crear promoción', destino: 'tienda', datos: { dias: [2] } });
  assert.deepEqual(de('franja_floja', { franja: '13-15' }).datos, { horaInicio: '13:00', horaFin: '15:00' });
  assert.deepEqual(de('franja_floja', { franja: '7-9' }).datos, { horaInicio: '07:00', horaFin: '09:00' });
  assert.deepEqual(de('franja_floja').datos, {}, 'sin franja con horas, la promoción abre vacía');
  assert.deepEqual(de('combinaciones', { categorias: ['c:4', 'c:9'] }).datos, { categorias: [4, 9] });
  assert.deepEqual(de('descuentos_altos', { desde: '2026-11-17', hasta: '2026-11-23' }), { clave: 'correcciones', etiqueta: 'Ver correcciones', destino: 'ajustes', datos: { fecha: '2026-11-23' } });
  assert.deepEqual(de('cortesias_altas', { desde: '2026-11-17', hasta: '2026-11-23' }).destino, 'ajustes');
  assert.deepEqual(de('cancelaciones_altas', { desde: '2026-11-17', hasta: '2026-11-23' }).datos, { desde: '2026-11-17', hasta: '2026-11-23', filtro: 'no_venta' });
  for (const tipo of ['ventas_sin_forma_pago', 'ventas_fuera_horario', 'ventas_incompletas', 'pedidos_grandes']) {
    assert.deepEqual(de(tipo, { desde: '2026-11-17', hasta: '2026-11-23' }), { clave: 'historial', etiqueta: 'Ver en Historial', destino: 'historial',
      datos: { desde: '2026-11-17', hasta: '2026-11-23', filtro: 'todas' } }, tipo);
  }
  assert.deepEqual(de('poca_venta'), { clave: 'menu', etiqueta: 'Abrir Menú', destino: 'menu', datos: {} });
  // Sin acción real, sin botón.
  assert.equal(de('clientes_cambiaron'), null);
  assert.equal(de('tipo_que_no_existe', { producto: 1 }), null);
  // Lo que no tiene sus datos no da botón (nunca se adivina).
  for (const [tipo, accion] of [['clientes_dejaron', undefined], ['producto_baja', undefined], ['categoria_baja', { categoria: 'c:7' }],
    ['historial', undefined], ['ventas_sin_forma_pago', undefined], ['descuentos_altos', undefined], ['dia_flojo', undefined]]) {
    assert.equal(de(tipo, accion), null, `${tipo} dio botón sin sus datos`);
  }
  // Uno guardado con forma inválida tampoco.
  assert.equal(de('producto_baja', { producto: 'DROP TABLE' }), null);
  assert.equal(de('clientes_dejaron', { clientes: ['no-es-un-id'] }), null);
  // Todos los tipos del asistente, salvo clientes_cambiaron, tienen botón.
  assert.deepEqual(R.TIPOS_HALLAZGO.filter((x) => !AC.ACCIONES[x]), ['clientes_cambiaron']);
});

await t('P3. un botón con datos que no pasan la revisión deja el aviso SIN botón; no lo tumba', () => {
  const h = { tipo: 'franja_floja', firma: 'franja_floja:otras', accion: { franja: 'otras' }, titulo: 'x' };
  assert.deepEqual(R.conAccionValida(h), { ...h, accion: null });
  const bien = { tipo: 'franja_floja', accion: { franja: '9-11' } };
  assert.equal(R.conAccionValida(bien), bien);
  const sin = { tipo: 'producto_baja', accion: null };
  assert.equal(R.conAccionValida(sin), sin);
  // Por la entrada de las reglas: la franja «Otras horas» vende un tercio. Sale
  // el aviso completo (pasa la revisión), pero sin botón: «otras» no es un horario.
  const ayer = '2026-11-24';
  const { P, A } = R.periodosDe(ayer);
  const tks = { actual: [], anterior: [] };
  for (const [per, lista, netaOtras] of [[P, tks.actual, 10000], [A, tks.anterior, 30000]]) {
    for (let f = per.desde; f <= per.hasta; f = R.sumarDias(f, 1)) {
      const dia = new Date(`${f}T12:00:00Z`).getUTCDay();
      for (let k = 0; k < 10; k++) {
        lista.push({ neta: 30000, fecha: f, dia, franja: '9-11', desglose: true, lineas: [['p1', 'c1', 1, 30000]] });
        lista.push({ neta: netaOtras, fecha: f, dia, franja: 'otras', desglose: true, lineas: [['p1', 'c1', 1, netaOtras]] });
      }
    }
  }
  const HORARIO = { horarios: Object.fromEntries(['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']
    .map((d) => [d, { abierto: true, apertura: '08:00', cierre: '22:00' }])) };
  const r = R.buscarHallazgos({ negocio: { id: 'n1', nombre: 'Sucursal de prueba' }, tz: 'America/Matamoros', hoy: '2026-11-25', ayer,
    ventas: [], eventosMesa: [], menu90: null, reglasAtencion: HORARIO,
    productos: { ...tks, nombres: { productos: { p1: 'Chilaquiles' }, categorias: { c1: 'Desayunos' } } } });
  const otras = r.hallazgos.find((x) => x.firma === 'franja_floja:otras');
  assert.ok(otras, 'la franja «otras» que vende menos no salió como aviso');
  assert.strictEqual(otras.accion, null, 'la franja «otras» salió con botón');
  assert.deepStrictEqual(R.faltasDeHallazgo(otras), []);
});

await t('P4. la IA no recibe el botón: ni la palabra «accion» ni el id de ningún cliente', () => {
  const h = { tipo: 'clientes_dejaron', firma: 'clientes_dejaron', motivo: 'elegido', elegido: true, impacto: 900, titulo: '2 clientes no han vuelto.',
    sugerencia: 'Escríbeles.', detalle: { numeros: [{ etiqueta: 'Clientes', valor: 2, formato: 'entero' }] }, accion: { clientes: [U1, U2] } };
  const e = RD.entradaAvisos({ negocio: { nombre: 'Sucursal de prueba' }, hoy: '2026-11-28', todos: [h], maximo: 3 });
  const texto = JSON.stringify(e.datos);
  assert.ok(!texto.includes(U1) && !texto.includes(U2), 'a la IA le llegan los id de los clientes');
  assert.ok(!/"accion"/.test(texto), 'a la IA le llega el botón');
});

await t('P5. apagada la bandera, la tarjeta sale exactamente como en la Fase 4; encendida, con su botón', () => {
  const fila = { id: 9, tipo: 'clientes_dejaron', titulo: 'x', opinion: null,
    contenido: { detalle: { numeros: [{ etiqueta: 'Clientes', valor: 2, formato: 'entero' }] }, accion: { clientes: [U1, U2] } } };
  const apagada = PA.tarjetaDe(fila);
  assert.ok(!('accion' in apagada), 'apagada trae `accion`');
  assert.deepEqual(PA.tarjetaDe(fila, { acciones: false }), apagada);
  const encendida = PA.tarjetaDe(fila, { acciones: true });
  assert.deepEqual({ ...encendida, accion: undefined }, { ...apagada, accion: undefined });
  assert.equal(encendida.accion.clave, 'campana_clientes');
  assert.ok(!JSON.stringify(encendida).includes(U1), 'la tarjeta lleva los id de los clientes al navegador');
  assert.equal(PA.tarjetaDe({ ...fila, tipo: 'clientes_cambiaron' }, { acciones: true }).accion, null);
  // Solo `true` enciende (nunca el índice de un .map).
  assert.ok(!('accion' in PA.tarjetaDe(fila, 0)) && !('accion' in PA.tarjetaDe(fila, 1)));
});

// ═══ La zona, las fechas y los datos inventados ═══════════════════════════
const ZONAS = ['Pacific/Honolulu', 'America/Los_Angeles', 'America/Matamoros', 'America/Sao_Paulo', 'Atlantic/Azores', 'Europe/Madrid',
  'Europe/Moscow', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland'];
const TZ = ZONAS.find((z) => [0, 20, 40].every((m) => P.horaLocal(new Date(Date.now() + m * 60000), z) < 5));
assert.ok(TZ, 'ninguna zona entre las 0 y las 5');
const HOY = fechaOperativaDe(new Date(), TZ);
const AYER = R.sumarDias(HOY, -1);
const a = (fecha, h, mi = 0) => { const [y, mo, d] = fecha.split('-').map(Number); return instanteLocal(y, mo, d, h, mi, 0, TZ); };

const TAG = 'AM' + (Date.now() % 1e8).toString(36).toUpperCase();
const SLUG = (l) => `${TAG.toLowerCase()}-asis-m1-${l}`;
const q = (sql, params) => pool.query(sql, params);
const uno = async (sql, params) => (await q(sql, params)).rows[0];
const ACC = 'asistente_restaurante_acciones';

async function limpiar() {
  const { rows } = await q(`SELECT id FROM negocios WHERE slug LIKE '%-asis-m1-_'`);
  for (const { id } of rows) {
    const del = (sql) => q(sql, [id]).catch(() => {});
    await del(`DELETE FROM ${ACC} WHERE negocio_id = $1`);
    await del('DELETE FROM campana_envios WHERE campana_id IN (SELECT id FROM campanas WHERE negocio_id = $1)');
    await del('DELETE FROM campanas WHERE negocio_id = $1');
    await del('DELETE FROM cliente_consentimientos WHERE negocio_id = $1');
    await del('DELETE FROM clientes_negocio WHERE negocio_id = $1');
    await del('DELETE FROM integraciones_canal WHERE negocio_id = $1');
    await del('DELETE FROM auditoria_plataforma WHERE negocio_id = $1');
    await del('DELETE FROM avisos_panel WHERE negocio_id = $1');
    await del('DELETE FROM asistente_restaurante_gasto_ia WHERE negocio_id = $1');
    await del('DELETE FROM asistente_restaurante_silenciados WHERE negocio_id = $1');
    await del('DELETE FROM asistente_restaurante_corridas WHERE negocio_id = $1');
    await del('DELETE FROM pedidos_activos WHERE negocio_id = $1');
    await del('DELETE FROM configuracion WHERE negocio_id = $1');
    await del('DELETE FROM negocio_modulos WHERE negocio_id = $1');
    await del('DELETE FROM usuario_negocios WHERE negocio_id = $1');
  }
  for (const { id } of rows) {
    await q('DELETE FROM usuario_negocios WHERE usuario_id IN (SELECT id FROM usuarios WHERE negocio_id = $1)', [id]).catch(() => {});
    await q('DELETE FROM usuarios WHERE negocio_id = $1', [id]).catch(() => {});
    await q('DELETE FROM negocios WHERE id = $1', [id]).catch(() => {});
  }
}

const predeploy = () => spawnSync(process.execPath, ['scripts/predeploy-166-asistente-acciones.mjs'], { cwd: RAIZ, env: process.env, encoding: 'utf8' });
const salida = (r) => `${r.stdout || ''}${r.stderr || ''}`;
const hayTabla = async () => (await uno('SELECT to_regclass($1) IS NOT NULL AS hay', [`public.${ACC}`])).hay;

try {
  // ═══ M. La 166 ═════════════════════════════════════════════════════════
  await t('M1. la 166 se aplica vacía, se repite sin hacer nada, se repara y tiene reversa; va en el runner después de la 165', async () => {
    const huella = async () => (await uno(`SELECT (SELECT COUNT(*) FROM campanas)::int AS c, (SELECT COUNT(*) FROM asistente_restaurante_hallazgos)::int AS h,
      (SELECT COUNT(*) FROM configuracion)::int AS k`));
    const antes = await huella();
    await q(leer('migrations/166_asistente_acciones_down.sql'));
    assert.equal(await hayTabla(), false);
    let r = predeploy();
    assert.equal(r.status, 0, salida(r));
    assert.match(salida(r), /\[predeploy-166\] Aplicada/);
    assert.equal((await uno(`SELECT COUNT(*)::int AS n FROM ${ACC}`)).n, 0);
    r = predeploy();
    assert.equal(r.status, 0, salida(r));
    assert.match(salida(r), /\[predeploy-166\] Ya aplicada/);
    await q('DROP INDEX asistente_restaurante_acciones_hallazgo');
    r = predeploy();
    assert.equal(r.status, 0, salida(r));
    assert.match(salida(r), /\[predeploy-166\] Reparada \(faltaba: índice asistente_restaurante_acciones_hallazgo\)/);
    assert.deepEqual(await huella(), antes, 'la 166 cambió campañas, hallazgos o configuración');
    const runner = leer('scripts/predeploy-run-032-033.mjs');
    const i165 = runner.indexOf("'165-asistente-ia-resumen'");
    const i166 = runner.indexOf("'166-asistente-acciones'");
    assert.ok(i165 > 0 && i166 > i165, 'la 166 no va en el runner después de la 165');
  });

  await limpiar();
  async function negocio(l, nombre) {
    const n = await uno('INSERT INTO negocios (nombre, slug, bot_whatsapp_activo) VALUES ($1, $2, true) RETURNING id', [nombre, SLUG(l)]);
    for (const m of ['pos', 'caja', 'whatsapp']) await q(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')`, [n.id, m]);
    const marca = randomUUID();
    const phoneId = `pn-${marca}`;
    await q(`INSERT INTO integraciones_canal(negocio_id,canal,proveedor,identificador,estado,activo,waba_id)
      VALUES($1,'whatsapp','meta',$2,'activo',true,$3)`, [n.id, phoneId, `waba-${marca}`]);
    await actualizarConfiguracion({ timezone: TZ, int_wa_phone_id: phoneId, int_wa_token: `token-${marca}`, whatsapp_trazabilidad_formularios_v1: 'true' }, n.id);
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
  const tel10 = () => `00${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`;
  async function cliente(neg, nombre, { interno = false } = {}) {
    const t = tel10();
    return (await uno('INSERT INTO clientes_negocio(negocio_id,telefono,nombre,es_interno) VALUES($1,$2,$3,$4) RETURNING id::text AS id, telefono',
      [neg, t, nombre, interno]));
  }
  const F = (s) => `ACM-${TAG}-${s}`;
  async function venta(neg, folio, instante, total, extra = {}) {
    await q('INSERT INTO pedidos_activos (folio, estado, datos, negocio_id, created_at) VALUES ($1,$2,$3,$4,$5::timestamp)',
      [folio, 'entregado', JSON.stringify({ id: folio, canal: 'pos', modalidad: 'recoger en tienda', forma_pago: 'efectivo', subtotal: total, total,
        items: [{ nombre: 'Café', cantidad: 1, precio_unitario: total }], ...extra }), neg, instante.toISOString()]);
  }

  const NOMBRE_A = `${TAG} Sucursal A`;
  const A = await negocio('a', NOMBRE_A);
  const B = await negocio('b', `${TAG} Sucursal B`);
  const NA = { id: A, nombre: NOMBRE_A, tz: TZ };
  const ADMIN_A = await usuario(A, `${TAG} Dueño A`, 'admin');
  const ADMIN_A2 = await usuario(A, `${TAG} Gerente A`, 'admin');
  const STAFF_A = await usuario(A, `${TAG} Cajera A`, 'staff');
  const ADMIN_B = await usuario(B, `${TAG} Dueño B`, 'admin');
  for (const [n, quienes] of [[A, [ADMIN_A]], [B, [ADMIN_B]]]) {
    await cfg(n, AV.BANDERA, 'true');
    await cfg(n, AV.CLAVE_MODO, 'visible');
    await cfg(n, AV.CLAVE_DESTINATARIOS, JSON.stringify(quienes));
  }
  // Ayer: 5 ventas normales y 3 sin forma de pago (el aviso de control con botón a Historial).
  for (let i = 1; i <= 5; i++) await venta(A, F(`AOK${i}`), a(AYER, 9 + i), 120);
  for (let i = 1; i <= 3; i++) await venta(A, F(`ASF${i}`), a(AYER, 15 + i), 100 + i * 50, { forma_pago: undefined });

  // Clientes: en A dos de siempre, una interna y uno que no está en el aviso; en B uno.
  const cA1 = await cliente(A, 'Ana Prueba');
  const cA2 = await cliente(A, 'Beto Prueba');
  const cAint = await cliente(A, 'Interna Prueba', { interno: true });
  const cA3 = await cliente(A, 'Carla Prueba');
  const cB1 = await cliente(B, 'Dora Prueba');

  const ins = async (neg, corrida, tipo, firma, contenido, elegido = true) => (await uno(
    `INSERT INTO asistente_restaurante_hallazgos (negocio_id, corrida_id, tipo, firma, impacto, titulo, contenido, elegido, motivo, mostrado)
     VALUES ($1, $2, $3, $4, 100, $5, $6::jsonb, $7, $8, $7) RETURNING id::text AS id`,
    [neg, corrida, tipo, firma, `Prueba ${firma}`, JSON.stringify(contenido), elegido, elegido ? 'elegido' : 'no_paso_minimo'])).id;
  const numeros = { detalle: { numeros: [{ etiqueta: 'Clientes', valor: 2, formato: 'entero' }] } };

  let H = {};
  await t('D1. la corrida de la mañana guarda el botón de cada aviso y todos pasan la revisión; el de control apunta a la semana revisada', async () => {
    const r = await P.correrSucursal({ negocio: NA, modo: 'visible', hoy: HOY, ahora: a(HOY, 7) });
    assert.ok(r.corridaId, JSON.stringify(r));
    const { rows } = await q('SELECT id::text AS id, tipo, elegido, contenido FROM asistente_restaurante_hallazgos WHERE negocio_id = $1 ORDER BY id', [A]);
    assert.ok(rows.length > 0);
    for (const h of rows) assert.deepEqual(R.faltasDeAccion(h.contenido.accion ?? null), [], `${h.tipo}: ${JSON.stringify(h.contenido.accion)}`);
    const sinPago = rows.find((h) => h.tipo === 'ventas_sin_forma_pago');
    assert.ok(sinPago && sinPago.elegido, 'no salió el aviso de ventas sin forma de pago');
    assert.deepEqual(sinPago.contenido.accion, { desde: R.sumarDias(AYER, -6), hasta: AYER });
    H.sinPago = sinPago.id;
    // Los avisos de prueba (en la misma revisión de A y en una de B).
    const cA = (await uno('SELECT id FROM asistente_restaurante_corridas WHERE negocio_id = $1 AND fecha = $2', [A, HOY])).id;
    const cB = (await uno(`INSERT INTO asistente_restaurante_corridas (negocio_id, fecha, modo, estado, candidatos, elegidos, terminada_en)
                           VALUES ($1, $2, 'visible', 'lista', 1, 1, now()) RETURNING id`, [B, HOY])).id;
    H.dejaron = await ins(A, cA, 'clientes_dejaron', 'clientes_dejaron',
      { ...numeros, accion: { clientes: [cA1.id, cA2.id, cAint.id, cB1.id, randomUUID()] } });
    H.dejaronNoElegido = await ins(A, cA, 'clientes_dejaron', 'clientes_dejaron:viejo', { ...numeros, accion: { clientes: [cA3.id] } }, false);
    H.cambiaron = await ins(A, cA, 'clientes_cambiaron', 'clientes_cambiaron', numeros);
    H.producto = await ins(A, cA, 'producto_baja', 'producto_baja:p:12', { ...numeros, accion: { producto: 12 } });
    H.dejaronB = await ins(B, cB, 'clientes_dejaron', 'clientes_dejaron', { ...numeros, accion: { clientes: [cB1.id] } });
  });

  await t('M2. las reglas de la 166: solo pasos conocidos, la campaña siempre con su número, y un aviso de OTRA sucursal no entra', async () => {
    const intenta = (neg, h, paso, campana = null, accion = 'historial') => q(
      `INSERT INTO ${ACC} (negocio_id, hallazgo_id, accion, paso, campana_id) VALUES ($1, $2, $3, $4, $5)`, [neg, h, accion, paso, campana]);
    for (const [args, regla] of [
      [[A, H.sinPago, 'otro'], /_paso/], [[A, H.sinPago, 'creo_campana'], /_campana/], [[A, H.sinPago, 'abrio', 5], /_campana/],
      [[A, H.sinPago, 'abrio', null, 'Hola Mundo!'], /_accion/], [[A, H.dejaronB, 'abrio'], /fkey/],
    ]) {
      let e = null;
      try { await intenta(...args); } catch (x) { e = x; }
      assert.ok(e, `entró ${JSON.stringify(args)}`);
      assert.match(`${e.constraint || ''} ${e.message}`, regla);
    }
    assert.equal((await uno(`SELECT COUNT(*)::int AS n FROM ${ACC}`)).n, 0);
  });

  await t('D2. la bandera es por sucursal: apagada, las tarjetas salen sin botón; encendida, cada una con el suyo y sin clientes', async () => {
    let r = await PA.leerPantalla(pool, { negocioId: A, usuarioId: ADMIN_A, ahora: a(HOY, 14) });
    assert.ok(r.tarjetas.length >= 3);
    assert.ok(r.tarjetas.every((x) => !('accion' in x)), 'con la bandera apagada salió un botón');
    await cfg(A, AC.BANDERA_ACCIONES, 'true');
    r = await PA.leerPantalla(pool, { negocioId: A, usuarioId: ADMIN_A, ahora: a(HOY, 14) });
    const por = Object.fromEntries(r.tarjetas.map((x) => [x.id, x]));
    assert.deepEqual(por[H.sinPago].accion, { clave: 'historial', etiqueta: 'Ver en Historial', destino: 'historial',
      datos: { desde: R.sumarDias(AYER, -6), hasta: AYER, filtro: 'todas' } });
    assert.equal(por[H.dejaron].accion.clave, 'campana_clientes');
    assert.equal(por[H.dejaron].accion.datos.cuantos, 5);
    assert.equal(por[H.producto].accion.datos.producto, 12);
    assert.equal(por[H.cambiaron].accion, null);
    const texto = JSON.stringify(r);
    for (const c of [cA1, cA2, cAint, cB1]) assert.ok(!texto.includes(c.id) && !texto.includes(c.telefono), 'la pestaña lleva clientes al navegador');
    // B no se enciende por encender A.
    const rb = await PA.leerPantalla(pool, { negocioId: B, usuarioId: ADMIN_B, ahora: a(HOY, 14) });
    assert.ok(rb.tarjetas.length === 1 && !('accion' in rb.tarjetas[0]), 'encender A encendió B');
    assert.equal(await AC.accionesEncendidas(pool, B), false);
    for (const v of ['1', 'si', 'TRUE ', 'false']) { await cfg(B, AC.BANDERA_ACCIONES, v); assert.equal(await AC.accionesEncendidas(pool, B), false, v); }
    await cfg(B, AC.BANDERA_ACCIONES, undefined);
  });

  await t('D3. anotar el botón: solo un aviso elegido de la PROPIA sucursal, con la acción de su tipo y la bandera encendida', async () => {
    const reg = (neg, hallazgoId, clave, usuarioId = ADMIN_A) => AC.registrarAccion(pool, neg, { hallazgoId, clave, usuarioId });
    assert.deepEqual(await reg(A, H.sinPago, 'historial'), { ok: true });
    const { rows } = await q(`SELECT negocio_id::text AS n, hallazgo_id::text AS h, usuario_id::text AS u, accion, paso, campana_id FROM ${ACC}`);
    assert.deepEqual(rows, [{ n: A, h: H.sinPago, u: ADMIN_A, accion: 'historial', paso: 'abrio', campana_id: null }]);
    await rechaza(reg(A, H.sinPago, 'menu'), 'ACCION_INVALIDA');
    await rechaza(reg(A, H.sinPago, 'borrar_todo'), 'ACCION_INVALIDA');
    await rechaza(reg(A, H.cambiaron, 'campana_clientes'), 'ACCION_INVALIDA');
    await rechaza(reg(A, 'abc', 'historial'), 'ACCION_INVALIDA');
    await rechaza(reg(A, H.dejaronB, 'campana_clientes'), 'SIN_AVISO');
    await rechaza(reg(A, H.dejaronNoElegido, 'campana_clientes'), 'SIN_AVISO');
    await rechaza(reg(B, H.sinPago, 'historial', ADMIN_B), 'APAGADO');
    await cfg(B, AC.BANDERA_ACCIONES, 'true');
    await rechaza(reg(B, H.sinPago, 'historial', ADMIN_B), 'SIN_AVISO');
    await cfg(B, AC.BANDERA_ACCIONES, undefined);
    await rechaza(AC.registrarAccion(pool, 'no-es-uuid', { hallazgoId: H.sinPago, clave: 'historial' }), 'TENANT_CONTEXT_REQUIRED');
    // Un usuario que no es un id se anota sin usuario (sesión legada).
    assert.deepEqual(await reg(A, H.producto, 'menu_producto', 'token-legado'), { ok: true });
    assert.equal((await uno(`SELECT usuario_id FROM ${ACC} WHERE hallazgo_id = $1`, [H.producto])).usuario_id, null);
    assert.equal((await uno(`SELECT COUNT(*)::int AS n FROM ${ACC}`)).n, 2);
  });

  await t('D4. los clientes del aviso, solo para su sucursal, de un aviso elegido de «no han vuelto», con la bandera encendida', async () => {
    const ids = await AC.clientesDelAviso(pool, A, H.dejaron);
    assert.ok(ids instanceof Set && ids.size === 5 && ids.has(cA1.id) && ids.has(cB1.id));
    await rechaza(AC.clientesDelAviso(pool, B, H.dejaron), 'APAGADO');
    await cfg(B, AC.BANDERA_ACCIONES, 'true');
    await rechaza(AC.clientesDelAviso(pool, B, H.dejaron), 'SIN_AVISO');
    await cfg(B, AC.BANDERA_ACCIONES, undefined);
    await rechaza(AC.clientesDelAviso(pool, A, H.dejaronB), 'SIN_AVISO');
    await rechaza(AC.clientesDelAviso(pool, A, H.dejaronNoElegido), 'SIN_AVISO');
    await rechaza(AC.clientesDelAviso(pool, A, H.cambiaron), 'SIN_AVISO');
    await rechaza(AC.clientesDelAviso(pool, A, H.sinPago), 'SIN_AVISO');
    await rechaza(AC.clientesDelAviso(pool, A, null), 'SIN_AVISO');
  });

  // ═══ C. Campañas desde un aviso ════════════════════════════════════════
  META.plantillas = [{
    id: '111', name: 'regresa_m1', status: 'APPROVED', category: 'MARKETING', language: 'es_MX',
    components: [
      { type: 'BODY', text: 'Hola {{1}}, {{2}}', example: { body_text: [['Ana', 'te esperamos']] } },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Pedir en línea', url: 'https://tienda.example/pedir' },
        { type: 'QUICK_REPLY', text: 'Detener promociones' }] },
    ],
  }];
  const DATOS = { nombre: 'Clientes frecuentes que no han vuelto', plantilla: 'regresa_m1', idioma: 'es_MX',
    variables: { 'cuerpo:1': { fuente: 'nombre' }, 'cuerpo:2': { fuente: 'fijo', texto: AC.MENSAJES_SUGERIDOS.clientes_dejaron } },
    respaldoNombre: 'cliente', segmento: svc.SEGMENTO_AVISO, avisoAsistente: null, excluirRecientes: true };

  await t('C1. del aviso: solo sus clientes que están en la Lista de ESTA sucursal, sin la interna; nada sale todavía', async () => {
    const p = await svc.prepararCampana(A, { ...DATOS, avisoAsistente: H.dejaron });
    assert.deepEqual(p.lista.map((d) => d.clienteId).sort(), [cA1.id, cA2.id].sort());
    assert.equal(p.resumen.total, 2);
    assert.equal(p.resumen.excluidos.internos, 1);
    assert.equal(p.avisoAsistente, H.dejaron);
    assert.ok(!p.lista.some((d) => d.clienteId === cB1.id), 'entró un cliente de otra sucursal');
    assert.equal(META.envios.length, 0);
    // Los demás públicos no cambian: «todos» son los 3 de la Lista (sin la interna).
    const todos = await svc.prepararCampana(A, { ...DATOS, segmento: 'todos' });
    assert.equal(todos.resumen.total, 3);
    assert.equal(todos.avisoAsistente, null);
    assert.equal(PL.segmentoValido(svc.SEGMENTO_AVISO), false, '«asistente» se volvió un segmento normal');
    assert.ok(!PL.SEGMENTOS.some(([s]) => s === svc.SEGMENTO_AVISO));
  });

  await t('C2. sin un aviso válido de esta sucursal no hay público: sin número, de otra, no elegido, de otro tipo o apagado', async () => {
    for (const aviso of [null, '', 'abc', H.dejaronB, H.dejaronNoElegido, H.cambiaron, H.sinPago, '999999999']) {
      await rechaza(svc.prepararCampana(A, { ...DATOS, avisoAsistente: aviso }), 'AVISO_NO_DISPONIBLE', ErrorCampana);
    }
    await rechaza(svc.prepararCampana(B, { ...DATOS, avisoAsistente: H.dejaron }), 'AVISO_NO_DISPONIBLE', ErrorCampana);
    await cfg(A, AC.BANDERA_ACCIONES, undefined);
    try {
      await rechaza(svc.prepararCampana(A, { ...DATOS, avisoAsistente: H.dejaron }), 'AVISO_NO_DISPONIBLE', ErrorCampana);
    } finally { await cfg(A, AC.BANDERA_ACCIONES, 'true'); }
    // Un aviso con segmento normal se ignora: el público es el del segmento.
    assert.equal((await svc.prepararCampana(A, { ...DATOS, segmento: 'todos', avisoAsistente: H.dejaron })).resumen.total, 3);
  });

  await t('C3. al crearla: la campaña guarda de qué aviso salió, su cola es solo esa gente y queda anotada; Meta no recibe nada todavía', async () => {
    const r = await svc.crearCampanaPlantilla(A, { ...DATOS, avisoAsistente: H.dejaron, totalVisto: 2 }, { usuarioId: ADMIN_A });
    assert.equal(r.total, 2);
    const c = await uno(`SELECT segmento, negocio_id::text AS n, plantilla->>'avisoAsistente' AS aviso FROM campanas WHERE id = $1`, [r.campanaId]);
    assert.deepEqual(c, { segmento: svc.SEGMENTO_AVISO, n: A, aviso: H.dejaron });
    const { rows: envios } = await q('SELECT cliente_id::text AS c FROM campana_envios WHERE campana_id = $1 ORDER BY 1', [r.campanaId]);
    assert.deepEqual(envios.map((e) => e.c), [cA1.id, cA2.id].sort());
    const fila = await uno(`SELECT usuario_id::text AS u, accion, paso, campana_id FROM ${ACC} WHERE hallazgo_id = $1`, [H.dejaron]);
    assert.deepEqual(fila, { u: ADMIN_A, accion: 'campana_clientes', paso: 'creo_campana', campana_id: r.campanaId });
    assert.equal(META.envios.length, 0, 'crear la campaña mandó mensajes');
    // Detenerla (no la mande el trabajo de fondo en el servidor de prueba).
    await svc.detenerCampana(A, r.campanaId);
  });

  await t('C4. anotar la campaña es mejor esfuerzo: con un aviso ajeno o inventado no anota y no truena', async () => {
    const antes = (await uno(`SELECT COUNT(*)::int AS n FROM ${ACC}`)).n;
    assert.equal(await AC.anotarCampanaDelAviso(pool, A, { hallazgoId: H.dejaronB, campanaId: 1 }), false);
    assert.equal(await AC.anotarCampanaDelAviso(pool, A, { hallazgoId: 'abc', campanaId: 1 }), false);
    assert.equal(await AC.anotarCampanaDelAviso(pool, 'x', { hallazgoId: H.dejaron, campanaId: 1 }), false);
    const roto = { query: async () => { throw new Error('base caída'); } };
    const error = console.error; console.error = () => {};
    try { assert.equal(await AC.anotarCampanaDelAviso(roto, A, { hallazgoId: H.dejaron, campanaId: 1 }), false); } finally { console.error = error; }
    assert.equal((await uno(`SELECT COUNT(*)::int AS n FROM ${ACC}`)).n, antes);
  });

  await t('C5. la ruta de Campañas deja pasar el número del aviso, y el negocio sale de la sesión', async () => {
    const app = express();
    app.use(express.json());
    let sesion = A;
    const requireAdminSeguro = (req, _res, next) => { req.negocioId = sesion; req.usuarioId = ADMIN_A; next(); };
    registrarRutasCampanasWa(app, { requireAdminSeguro, requireModulo: () => (_req, _res, next) => next() });
    const srvC = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
    const base = `http://127.0.0.1:${srvC.address().port}`;
    const post = async (cuerpo) => { const r = await fetch(`${base}/api/admin/campanas-wa/vista-previa`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) }); return { status: r.status, d: await r.json() }; };
    try {
      // La campaña de C3 ya les llegó a los dos: sin «no repetir» vuelven a contar.
      const ok = await post({ ...DATOS, avisoAsistente: H.dejaron, excluirRecientes: false, negocioId: B });
      assert.equal(ok.status, 200, JSON.stringify(ok.d));
      assert.equal(ok.d.total, 2);
      sesion = B;
      const ajena = await post({ ...DATOS, avisoAsistente: H.dejaron, excluirRecientes: false });
      assert.equal(ajena.status, 400);
      assert.equal(ajena.d.codigo, 'AVISO_NO_DISPONIBLE');
      assert.ok(!JSON.stringify(ajena.d).includes(cA1.id));
    } finally { srvC.close(); }
  });

  // ═══ R. Las rutas, con el servidor real ════════════════════════════════
  const { crearTokenSesion } = await import('../src/services/session.js');
  const { arrancarServidor } = await import('./lib-servidor.mjs');
  const ses = (u, n, rol) => `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: u, negocioId: n, rol }))}`;
  const S = { adminA: ses(ADMIN_A, A, 'admin'), otroA: ses(ADMIN_A2, A, 'admin'), staffA: ses(STAFF_A, A, 'staff'), adminB: ses(ADMIN_B, B, 'admin') };
  const srv = await arrancarServidor({ PORT: process.env.TEST_PORT_ASISTENTE_M1 || '4751' }, { timeoutMs: 40000, omitir: ['XABOR_ASISTENTE_RESUMEN_WA'] });
  const RUTA = '/api/admin/asistente-restaurante/pantalla';
  async function api(ruta, cookie, metodo = 'GET', cuerpo = undefined) {
    const r = await fetch(`${srv.base}${ruta}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    let datos = null; try { datos = await r.json(); } catch {}
    return { status: r.status, datos, cache: r.headers.get('cache-control') };
  }
  const anotar = (id, accion, cookie = S.adminA) => api(`${RUTA}/avisos/${id}/accion`, cookie, 'POST', { accion });
  try {
    await t('R1. anotar el botón: 401 sin sesión, 403 al operador y a quien no ve el asistente, 409 apagado, 404 lo ajeno, 400 lo inválido', async () => {
      await q(`DELETE FROM ${ACC} WHERE negocio_id = $1 AND paso = 'abrio'`, [A]);
      assert.equal((await anotar(H.sinPago, 'historial', null)).status, 401);
      assert.equal((await anotar(H.sinPago, 'historial', S.staffA)).status, 403);
      assert.equal((await anotar(H.sinPago, 'historial', S.otroA)).status, 403);
      assert.equal((await anotar(H.sinPago, 'historial', S.adminB)).status, 409, 'B no tiene la bandera');
      await cfg(B, AC.BANDERA_ACCIONES, 'true');
      try {
        const ajeno = await anotar(H.sinPago, 'historial', S.adminB);
        assert.equal(ajeno.status, 404, 'desde B se anotó un aviso de A');
      } finally { await cfg(B, AC.BANDERA_ACCIONES, undefined); }
      for (const [id, accion] of [[H.sinPago, 'menu'], [H.sinPago, 'x'.repeat(41)], [H.sinPago, 7], ['abc', 'historial'], [H.cambiaron, 'campana_clientes']]) {
        assert.equal((await anotar(id, accion)).status, 400, `${id} ${accion}`);
      }
      assert.equal((await anotar(H.dejaronNoElegido, 'campana_clientes')).status, 404);
      const ok = await anotar(H.sinPago, 'historial');
      assert.equal(ok.status, 200, JSON.stringify(ok.datos));
      assert.deepEqual(ok.datos, { ok: true });
      assert.match(ok.cache || '', /no-store/);
      const { rows } = await q(`SELECT usuario_id::text AS u, accion FROM ${ACC} WHERE negocio_id = $1 AND paso = 'abrio'`, [A]);
      assert.deepEqual(rows, [{ u: ADMIN_A, accion: 'historial' }]);
      assert.equal((await uno(`SELECT COUNT(*)::int AS n FROM ${ACC} WHERE negocio_id = $1`, [B])).n, 0);
      await cfg(A, AC.BANDERA_ACCIONES, undefined);
      try { assert.equal((await anotar(H.sinPago, 'historial')).status, 409); } finally { await cfg(A, AC.BANDERA_ACCIONES, 'true'); }
    });

    await t('R2. la pestaña por la ruta: el botón sale solo con la bandera, y sin clientes', async () => {
      const r = await api(RUTA, S.adminA);
      assert.equal(r.status, 200);
      const por = Object.fromEntries(r.datos.tarjetas.map((x) => [x.id, x]));
      assert.equal(por[H.dejaron].accion.destino, 'campanas');
      assert.ok(!JSON.stringify(r.datos).includes(cA1.id));
      await cfg(A, AC.BANDERA_ACCIONES, undefined);
      try {
        const sin = await api(RUTA, S.adminA);
        assert.ok(sin.datos.tarjetas.every((x) => !('accion' in x)));
      } finally { await cfg(A, AC.BANDERA_ACCIONES, 'true'); }
    });
  } finally {
    try { srv.detener(); } catch { /* ya terminó */ }
  }
} finally {
  await limpiar().catch((e) => console.error('limpieza:', e.message));
  servidorMeta.close();
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas) console.log(fallos.map((f) => ` - ${f}`).join('\n'));
await pool.end().catch(() => {});
process.exit(fallidas ? 1 : 0);
