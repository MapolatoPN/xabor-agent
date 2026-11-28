// ASISTENTE DEL RESTAURANTE, Fase 2: la configuración de cada sucursal, contra
// Postgres y con el servidor real.
//
// Negocios, usuarios y ventas INVENTADOS, creados aquí y borrados al final.
// Cubre:
//   C. sin base: los grupos y nombres de los tipos, los valores de siempre
//      (los de la Fase 1), lo guardado dañado vuelve a lo de siempre, cómo se
//      traduce a la revisión, la validación de un cambio y el texto del plazo;
//   D. con base: la lectura, quién la puede cambiar, y que la revisión de la
//      mañana obedece (tipo apagado, avisos por día, pesos mínimos que no tocan
//      los de control, días sin venir) sin que otra sucursal la afecte;
//   R. las rutas: solo quien recibe los avisos (los demás administradores ni
//      la ven), el servidor rechaza valores inválidos sin cambiar nada, solo
//      administradores activos de ESTA sucursal en la lista, la bitácora, el
//      interruptor de mostrar, «Volver a avisar», una sucursal no lee ni
//      cambia otra (ni con la misma cuenta en las dos) y sin POS no hay rutas.
//
// El servidor de prueba corre la revisión de cada minuto: las sucursales de
// prueba viven en una zona donde AHORA no es de 6 a 12 (como en la Fase 1).
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
const PR = await import('../src/asistenteRestaurante/priorizar.js');
const P = await import('../src/asistenteRestaurante/proceso.js');
const AV = await import('../src/asistenteRestaurante/avisos.js');
const C = await import('../src/asistenteRestaurante/configuracion.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  if (process.env.CASOS && !new RegExp(process.env.CASOS).test(nombre)) return;
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}
const rechaza = (fn, patron, nota) => assert.throws(fn, (e) => e.code === 'CONFIGURACION_INVALIDA' && patron.test(e.message), nota);

// ═══ C. Sin base ══════════════════════════════════════════════════════════
const UUID1 = '11111111-1111-4111-8111-111111111111';
const UUID2 = '22222222-2222-4222-8222-222222222222';
const valido = (extra = {}) => ({
  modo: 'ensayo', tiposApagados: [], ajustes: { ...C.AJUSTES_DE_SIEMPRE }, destinatarios: [UUID1], ...extra,
});

await t('C1. los grupos cubren cada tipo una vez, con nombre; los valores de siempre son los de la Fase 1', () => {
  const todos = C.GRUPOS_TIPOS.flatMap((g) => g.tipos);
  assert.strictEqual(todos.length, R.TIPOS_HALLAZGO.length, 'sobra o falta un tipo en los grupos');
  assert.deepStrictEqual([...todos].sort(), [...R.TIPOS_HALLAZGO].sort());
  for (const tipo of R.TIPOS_HALLAZGO) assert.ok(C.NOMBRES_TIPOS[tipo], `${tipo} sin nombre`);
  assert.deepStrictEqual(C.GRUPOS_TIPOS[0].tipos, [...R.TIPOS_CONTROL], 'el primer grupo debe ser el de control, completo');
  assert.deepStrictEqual(C.AJUSTES_DE_SIEMPRE, {
    avisosPorDia: PR.MAXIMO_AL_DIA, minimoPesos: PR.MINIMO_IMPACTO, cambioPct: R.UMBRALES_ASISTENTE.cambioPct,
    pedidoGrandeVeces: R.UMBRALES_ASISTENTE.pedidoGrandeFactor, pedidoGrandePiso: R.UMBRALES_ASISTENTE.pedidoGrandePiso,
    diasSinVenir: R.UMBRALES_ASISTENTE.clienteAusenciaMinima,
  });
  assert.strictEqual(R.UMBRALES_ASISTENTE.caidaPct, R.UMBRALES_ASISTENTE.cambioPct, 'cambioPct maneja los dos umbrales: deben nacer iguales');
  assert.strictEqual(C.AJUSTES.avisosPorDia.max, 3, 'nunca más de 3 al día');
  for (const [k, a] of Object.entries(C.AJUSTES)) assert.ok(a.min <= a.def && a.def <= a.max, `${k}: el valor de siempre fuera de su rango`);
});

await t('C2. lo guardado dañado vuelve a lo de siempre, ajuste por ajuste', () => {
  assert.deepStrictEqual(C.ajustesDe('no es json'), C.AJUSTES_DE_SIEMPRE);
  assert.deepStrictEqual(C.ajustesDe('[1,2]'), C.AJUSTES_DE_SIEMPRE);
  assert.deepStrictEqual(C.ajustesDe(''), C.AJUSTES_DE_SIEMPRE);
  const mezcla = C.ajustesDe(JSON.stringify({ avisosPorDia: 9, cambioPct: '20', minimoPesos: 800, diasSinVenir: 30.5, pedidoGrandePiso: 99, otro: 1 }));
  assert.deepStrictEqual(mezcla, { ...C.AJUSTES_DE_SIEMPRE, minimoPesos: 800 });
  assert.deepStrictEqual(C.tiposApagadosDe('["producto_baja","inventado","producto_baja",3]'), ['producto_baja']);
  assert.deepStrictEqual(C.tiposApagadosDe('{"producto_baja":true}'), []);
  assert.deepStrictEqual(C.tiposApagadosDe('dañado'), []);
});

await t('C3. a la revisión: umbrales de las reglas; el mínimo en pesos no toca control ni informativos; y priorizar obedece', () => {
  const cfg = { tiposApagados: ['producto_sube'], ajustes: { ...C.AJUSTES_DE_SIEMPRE, avisosPorDia: 2, minimoPesos: 2000, cambioPct: 25, pedidoGrandeVeces: 6, pedidoGrandePiso: 3000, diasSinVenir: 30 } };
  const r = C.paraLaRevision(cfg);
  assert.deepStrictEqual(r.umbrales, { cambioPct: 25, caidaPct: 25, pedidoGrandeFactor: 6, pedidoGrandePiso: 3000, clienteAusenciaMinima: 30 });
  assert.strictEqual(r.maximo, 2);
  assert.deepStrictEqual(r.tiposApagados, ['producto_sube']);
  for (const tipo of R.TIPOS_CONTROL) assert.ok(!(tipo in r.minimos), `${tipo} (control) recibió el mínimo en pesos`);
  for (const tipo of R.TIPOS_INFORMATIVOS) assert.ok(!(tipo in r.minimos), `${tipo} (informativo) recibió el mínimo en pesos`);
  assert.strictEqual(r.minimos.producto_baja, 2000);
  assert.strictEqual(r.minimos.clientes_dejaron, 2000);
  // Con priorizar: un hallazgo con todo lo que exige la forma.
  const h = (tipo, impacto) => ({
    tipo, firma: `${tipo}:x`, impacto, titulo: `Prueba ${tipo} (−$${impacto}).`,
    detalle: { numeros: [{ etiqueta: 'Venta', valor: impacto, formato: 'dinero' }], nota: 'n' },
    sugerencia: 'Revisa el menú.', revisar: { numero: 'Venta semanal', valor: 1, formato: 'dinero', el: '2026-12-10' }, frecuencia: 'diaria',
  });
  const cand = [h('cortesias_altas', 600), h('producto_baja', 1500), h('producto_baja', 2500), h('producto_sube', 9000), h('canal_baja', 3000)];
  cand[2].firma = 'producto_baja:y';
  for (const x of cand) assert.deepStrictEqual(R.faltasDeHallazgo(x), [], `el hallazgo de prueba ${x.tipo} no tiene la forma completa`);
  const { todos } = PR.priorizar(cand, { hoy: '2026-12-01', tiposApagados: r.tiposApagados, minimos: r.minimos, maximo: r.maximo });
  const motivo = (tipo, impacto) => todos.find((x) => x.tipo === tipo && x.impacto === impacto).motivo;
  assert.strictEqual(motivo('cortesias_altas', 600), 'elegido', 'el de control lo frenó el mínimo en pesos');
  assert.strictEqual(motivo('producto_baja', 1500), 'menos de $2000 en juego');
  assert.strictEqual(motivo('producto_sube', 9000), 'tipo apagado');
  assert.strictEqual(motivo('canal_baja', 3000), 'elegido');
  assert.strictEqual(motivo('producto_baja', 2500), 'no cupo (máximo 2 al día)');
  // Aunque llegue un máximo mayor (dato dañado o futuro), nunca más de 3 al día.
  assert.strictEqual(PR.priorizar(cand, { hoy: '2026-12-01', maximo: 9 }).elegidos.length, 3, 'con 9 al día salieron más de 3');
});

await t('C4. un cambio se valida completo: nada desconocido, todo en rango y sin quitarte a ti mismo', () => {
  const ok = C.validarCambio(valido({ tiposApagados: ['producto_baja', 'producto_baja'], destinatarios: [UUID1.toUpperCase(), UUID2, UUID1] }), { usuarioId: UUID1 });
  assert.deepStrictEqual(ok.tiposApagados, ['producto_baja']);
  assert.deepStrictEqual(ok.destinatarios, [UUID1, UUID2]);
  const yo = { usuarioId: UUID1 };
  rechaza(() => C.validarCambio(null, yo), /inválida/);
  rechaza(() => C.validarCambio([], yo), /inválida/);
  rechaza(() => C.validarCambio(valido({ negocioId: UUID2 }), yo), /No se reconoce «negocioId»/, 'aceptó elegir la sucursal desde el cuerpo');
  rechaza(() => C.validarCambio(valido({ modo: 'todos' }), yo), /visible/);
  rechaza(() => C.validarCambio(valido({ tiposApagados: 'producto_baja' }), yo), /tipos de aviso/);
  rechaza(() => C.validarCambio(valido({ tiposApagados: ['inventado'] }), yo), /desconocido: «inventado»/);
  rechaza(() => C.validarCambio(valido({ ajustes: null }), yo), /ajustes/);
  rechaza(() => C.validarCambio(valido({ ajustes: { ...C.AJUSTES_DE_SIEMPRE, ticketsProducto: 10 } }), yo), /desconocido: «ticketsProducto»/, 'dejó bajar el mínimo de 100 tickets');
  for (const [k, a] of Object.entries(C.AJUSTES)) {
    for (const malo of [a.min - 1, a.max + 1, a.def + 0.5, String(a.def), null]) {
      rechaza(() => C.validarCambio(valido({ ajustes: { ...C.AJUSTES_DE_SIEMPRE, [k]: malo } }), yo), new RegExp(a.titulo.slice(0, 12)), `${k}=${JSON.stringify(malo)} pasó`);
    }
    const { [k]: _, ...sinEste } = C.AJUSTES_DE_SIEMPRE;
    rechaza(() => C.validarCambio(valido({ ajustes: sinEste }), yo), new RegExp(a.titulo.slice(0, 12)), `faltó ${k} y pasó`);
  }
  rechaza(() => C.validarCambio(valido({ ajustes: { ...C.AJUSTES_DE_SIEMPRE, avisosPorDia: 4 } }), yo), /Avisos por día/, 'dejó poner 4 avisos al día');
  rechaza(() => C.validarCambio(valido({ destinatarios: [] }), yo), /al menos a una persona/);
  rechaza(() => C.validarCambio(valido({ destinatarios: ['no-es-uuid', UUID1] }), yo), /inválida/);
  rechaza(() => C.validarCambio(valido({ destinatarios: Array.from({ length: 21 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`) }), yo), /Máximo 20/);
  rechaza(() => C.validarCambio(valido({ destinatarios: [UUID2] }), yo), /No te puedes quitar/);
  rechaza(() => C.validarCambio(valido(), { usuarioId: null }), /No te puedes quitar/);
});

await t('C5. el plazo del aviso de clientes se escribe en semanas o días', () => {
  assert.strictEqual(R.plazoDias(21), '3 semanas');
  assert.strictEqual(R.plazoDias(7), '1 semana');
  assert.strictEqual(R.plazoDias(25), '25 días');
});

// ═══ Base de prueba ═══════════════════════════════════════════════════════
const ZONAS = ['America/Matamoros', 'Asia/Tokyo', 'Europe/Madrid', 'America/Los_Angeles', 'Australia/Sydney'];
const TZ = ZONAS.find((z) => [0, 20, 40].every((m) => { const h = P.horaLocal(new Date(Date.now() + m * 60000), z); return h < 5 || h >= 13; }));
assert.ok(TZ, 'ninguna zona fuera de la ventana');
const HOY = fechaOperativaDe(new Date(), TZ);
const AYER = R.sumarDias(HOY, -1);
const a = (fecha, h, mi = 0) => { const [y, mo, d] = fecha.split('-').map(Number); return instanteLocal(y, mo, d, h, mi, 0, TZ); };
const SIETE = a(HOY, 7);

const TAG = 'AC' + (Date.now() % 1e8).toString(36).toUpperCase();
const SLUG = (l) => `${TAG.toLowerCase()}-asis-f2-${l}`;
const q = (sql, params) => pool.query(sql, params);
const uno = async (sql, params) => (await q(sql, params)).rows[0];

async function limpiar() {
  const { rows } = await q(`SELECT id FROM negocios WHERE slug LIKE '%-asis-f2-_'`);
  for (const { id } of rows) {
    const del = (sql) => q(sql, [id]).catch(() => {});
    await del('DELETE FROM auditoria_plataforma WHERE negocio_id = $1');
    await del('DELETE FROM asistente_restaurante_silenciados WHERE negocio_id = $1');
    await del('DELETE FROM asistente_restaurante_corridas WHERE negocio_id = $1');
    await del('DELETE FROM pedidos_activos WHERE negocio_id = $1');
    await del('DELETE FROM clientes_negocio WHERE negocio_id = $1');
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
async function usuario(neg, nombre, rol, { activo = true } = {}) {
  const u = await uno(`INSERT INTO usuarios (negocio_id, nombre, email, password_hash, activo) VALUES ($1,$2,$3,'x',true) RETURNING id`,
    [neg, nombre, `${TAG.toLowerCase()}-${nombre.replace(/\W+/g, '').toLowerCase()}@test.local`]);
  await q('INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1,$2,$3,$4)', [u.id, neg, rol, activo]);
  return u.id;
}
async function cfg(neg, clave, valor) {
  await q('DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2', [neg, clave]);
  if (valor !== undefined) await q('INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,$2,$3)', [neg, clave, valor]);
}
const claves = async (neg) => Object.fromEntries((await q(
  `SELECT clave, valor FROM configuracion WHERE negocio_id = $1 AND clave LIKE 'asistente_restaurante_%' ORDER BY clave`, [neg])).rows.map((r) => [r.clave, r.valor]));
const borrarCorridas = (neg) => q('DELETE FROM asistente_restaurante_corridas WHERE negocio_id = $1', [neg]);
const hallazgos = async (neg) => (await q(
  `SELECT h.tipo, h.firma, h.impacto::float AS impacto, h.titulo, h.elegido, h.motivo FROM asistente_restaurante_hallazgos h
    WHERE h.negocio_id = $1 ORDER BY h.id`, [neg])).rows;

const A = await negocio('a', `${TAG} Sucursal A`);
const B = await negocio('b', `${TAG} Sucursal B`);
const ADMIN_A = await usuario(A, `${TAG} Dueño A`, 'admin');
const ADMIN2_A = await usuario(A, `${TAG} Gerente A`, 'admin');
const STAFF_A = await usuario(A, `${TAG} Cajera A`, 'staff');
const BAJA_A = await usuario(A, `${TAG} Exgerente A`, 'admin', { activo: false });
const ADMIN_B = await usuario(B, `${TAG} Dueño B`, 'admin');
// La misma cuenta, administradora de las dos sucursales (como la del dueño).
const DOS = await usuario(A, `${TAG} Dueño de las dos`, 'admin');
await q(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1,$2,'admin',true)`, [DOS, B]);
const NA = { id: A, nombre: `${TAG} Sucursal A`, tz: TZ };
const NB = { id: B, nombre: `${TAG} Sucursal B`, tz: TZ };

// Ventas inventadas. En A: 3 ventas sin forma de pago ayer (control, $600) y
// un cliente frecuente que dejó de venir hace 25 días (4 visitas, cada 5 días,
// $1,200 al mes). En B: 2 sin forma de pago.
const F = (s) => `ACF-${TAG}-${s}`;
const item = (nombre, precio) => ({ nombre, cantidad: 1, precio_unitario: precio });
async function venta(neg, folio, instante, datos) {
  await q('INSERT INTO pedidos_activos (folio, estado, datos, negocio_id, created_at) VALUES ($1,$2,$3,$4,$5::timestamp)',
    [folio, 'entregado', JSON.stringify({ id: folio, canal: 'pos', modalidad: 'recoger en tienda', ...datos }), neg, instante.toISOString()]);
}
for (let i = 1; i <= 5; i++) await venta(A, F(`AOK${i}`), a(AYER, 9 + i), { forma_pago: 'efectivo', subtotal: 120, total: 120, items: [item('Café', 120)] });
await venta(A, F('A1'), a(AYER, 15), { subtotal: 150, total: 150, items: [item('Molletes', 150)] });
await venta(A, F('A2'), a(AYER, 16), { subtotal: 200, total: 200, items: [item('Molletes', 200)] });
await venta(A, F('A3'), a(AYER, 17), { subtotal: 250, total: 250, items: [item('Molletes', 250)] });
const TEL = '8119990001';
await q(`INSERT INTO clientes_negocio (negocio_id, telefono, nombre, origen) VALUES ($1, $2, $3, 'tienda')`, [A, TEL, `${TAG} Cliente frecuente`]);
for (const [i, dias] of [40, 35, 30, 25].entries()) {
  await venta(A, F(`CLI${i}`), a(R.sumarDias(AYER, -dias), 11), {
    forma_pago: 'efectivo', subtotal: 300, total: 300, items: [item('Chilaquiles', 300)], cliente: { nombre: 'Cliente frecuente', telefono: TEL },
  });
}
await venta(B, F('B1'), a(AYER, 15), { subtotal: 310, total: 310, items: [item('Torta', 310)] });
await venta(B, F('B2'), a(AYER, 16), { subtotal: 420, total: 420, items: [item('Torta', 420)] });

async function revisarA(ajustes = {}, apagados = []) {
  await borrarCorridas(A);
  await cfg(A, C.CLAVE_UMBRALES, JSON.stringify({ ...C.AJUSTES_DE_SIEMPRE, ...ajustes }));
  await cfg(A, C.CLAVE_TIPOS_APAGADOS, JSON.stringify(apagados));
  const r = await P.correrSucursal({ negocio: NA, modo: 'ensayo', hoy: HOY, ahora: SIETE });
  assert.ok(r.corridaId, 'la corrida no corrió');
  const hs = await hallazgos(A);
  return { hs, de: (tipo) => hs.find((h) => h.tipo === tipo) };
}

try {
  // ═══ D. Con base ═══════════════════════════════════════════════════════
  await t('D1. sin nada guardado, valores de siempre; con basura guardada, también (y «quién ve» = nadie)', async () => {
    const vacia = await C.leerConfiguracion(pool, A);
    // Fase 3: también el resumen, todo apagado.
    assert.deepStrictEqual(vacia, { activo: false, modo: 'ensayo', destinatarios: [], tiposApagados: [], ajustes: C.AJUSTES_DE_SIEMPRE, resumen: C.RESUMEN_DE_SIEMPRE });
    await cfg(A, AV.BANDERA, 'true');
    await cfg(A, AV.CLAVE_DESTINATARIOS, '{dañado');
    await cfg(A, C.CLAVE_TIPOS_APAGADOS, 'tampoco');
    await cfg(A, C.CLAVE_UMBRALES, '{"avisosPorDia": 0}');
    const sucia = await C.leerConfiguracion(pool, A);
    assert.deepStrictEqual(sucia, { activo: true, modo: 'ensayo', destinatarios: [], tiposApagados: [], ajustes: C.AJUSTES_DE_SIEMPRE, resumen: C.RESUMEN_DE_SIEMPRE });
    await assert.rejects(C.leerConfiguracion(pool, 'no-uuid'), (e) => e.code === 'TENANT_CONTEXT_REQUIRED');
  });

  await t('D2. la cambia solo quien recibe los avisos, con el asistente encendido; nunca soporte', () => {
    const cfgOn = { activo: true, modo: 'ensayo', destinatarios: [ADMIN_A.toLowerCase()] };
    assert.strictEqual(C.puedeEditar(cfgOn, { usuarioId: ADMIN_A }), true, 'en ensayo el destinatario debe poder configurarla');
    assert.strictEqual(C.puedeEditar({ ...cfgOn, modo: 'visible' }, { usuarioId: ADMIN_A.toUpperCase() }), true);
    assert.strictEqual(C.puedeEditar(cfgOn, { usuarioId: ADMIN2_A }), false, 'otro administrador la puede cambiar');
    assert.strictEqual(C.puedeEditar(cfgOn, { usuarioId: ADMIN_A, esSoporte: true }), false, 'soporte la puede cambiar');
    assert.strictEqual(C.puedeEditar({ ...cfgOn, activo: false }, { usuarioId: ADMIN_A }), false, 'con el asistente apagado');
    assert.strictEqual(C.puedeEditar(cfgOn, { usuarioId: null }), false);
    assert.strictEqual(C.puedeEditar(null, { usuarioId: ADMIN_A }), false);
  });

  await t('D3. la revisión de la mañana obedece la configuración de SU sucursal', async () => {
    // B apaga todo: no debe afectar a A.
    await cfg(B, C.CLAVE_TIPOS_APAGADOS, JSON.stringify(R.TIPOS_HALLAZGO));
    await cfg(B, C.CLAVE_UMBRALES, JSON.stringify({ ...C.AJUSTES_DE_SIEMPRE, avisosPorDia: 1, diasSinVenir: 90 }));

    let r = await revisarA();
    assert.strictEqual(r.de('ventas_sin_forma_pago')?.elegido, true, `sin forma de pago no salió: ${JSON.stringify(r.hs)}`);
    const cli = r.de('clientes_dejaron');
    assert.ok(cli, `no salió el cliente que dejó de venir: ${JSON.stringify(r.hs.map((h) => h.tipo))}`);
    assert.strictEqual(cli.elegido, true);
    assert.match(cli.titulo, /^1 cliente frecuente lleva 3 semanas o más sin pedir/);

    r = await revisarA({}, ['ventas_sin_forma_pago']);
    assert.strictEqual(r.de('ventas_sin_forma_pago').motivo, 'tipo apagado');
    assert.strictEqual(r.de('ventas_sin_forma_pago').elegido, false);
    assert.strictEqual(r.de('clientes_dejaron').elegido, true);

    r = await revisarA({ avisosPorDia: 1 });
    assert.deepStrictEqual(r.hs.filter((h) => h.elegido).map((h) => h.tipo), ['ventas_sin_forma_pago'], 'con 1 al día debe quedar solo el de control');
    assert.strictEqual(r.de('clientes_dejaron').motivo, 'no cupo (máximo 1 al día)');

    r = await revisarA({ minimoPesos: 2000 });
    assert.strictEqual(r.de('clientes_dejaron').motivo, 'menos de $2000 en juego');
    assert.strictEqual(r.de('ventas_sin_forma_pago').elegido, true, 'el mínimo en pesos frenó un aviso de control ($600)');

    r = await revisarA({ diasSinVenir: 25 });
    assert.match(r.de('clientes_dejaron')?.titulo || '', /lleva 25 días o más sin pedir/, 'los días sin venir no llegaron a las reglas');
    r = await revisarA({ diasSinVenir: 28 });
    assert.strictEqual(r.de('clientes_dejaron'), undefined, 'con 28 días el cliente (25 días sin venir) no debe salir');
    await borrarCorridas(A);
    await cfg(A, C.CLAVE_UMBRALES, undefined);
    await cfg(A, C.CLAVE_TIPOS_APAGADOS, undefined);
    await cfg(B, C.CLAVE_TIPOS_APAGADOS, undefined);
    await cfg(B, C.CLAVE_UMBRALES, undefined);
  });

  await t('D4. calcularSucursal recibe los umbrales (pedido grande) y sin ellos usa los de siempre', async () => {
    const memoria = { hoy: HOY, mostrados: [], noUtilPorTipo: {}, silenciados: [] };
    const conPiso = await P.calcularSucursal(pool, { negocio: NA, hoy: HOY, ahora: SIETE, memoria, umbrales: { pedidoGrandePiso: 7777 } });
    assert.strictEqual(conPiso.umbralGrande, 7777);
    const normal = await P.calcularSucursal(pool, { negocio: NA, hoy: HOY, ahora: SIETE, memoria });
    assert.strictEqual(normal.umbralGrande, R.UMBRALES_ASISTENTE.pedidoGrandePiso);
  });

  // ═══ R. Las rutas, con el servidor real ════════════════════════════════
  const { crearTokenSesion } = await import('../src/services/session.js');
  const { arrancarServidor } = await import('./lib-servidor.mjs');
  const ses = (u, n, rol) => encodeURIComponent(crearTokenSesion({ usuarioId: u, negocioId: n, rol }));
  const S = {
    adminA: ses(ADMIN_A, A, 'admin'), admin2A: ses(ADMIN2_A, A, 'admin'), staffA: ses(STAFF_A, A, 'staff'),
    adminB: ses(ADMIN_B, B, 'admin'), dosEnA: ses(DOS, A, 'admin'), dosEnB: ses(DOS, B, 'admin'),
  };
  const srv = await arrancarServidor({ PORT: process.env.TEST_PORT_ASISTENTE_CFG || '4797' }, { timeoutMs: 40000 });
  const RUTA = '/api/admin/asistente-restaurante/configuracion';
  async function api(ruta, sesion, metodo = 'GET', cuerpo = undefined) {
    const r = await fetch(`${srv.base}${ruta}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(sesion ? { Cookie: `xabor_sesion=${sesion}` } : {}) },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    let datos = null; try { datos = await r.json(); } catch {}
    return { status: r.status, datos, cache: r.headers.get('cache-control') };
  }
  const cambio = (extra = {}) => ({ modo: 'ensayo', tiposApagados: [], ajustes: { ...C.AJUSTES_DE_SIEMPRE }, destinatarios: [ADMIN_A], ...extra });
  const bitacora = async (neg) => (await q(
    `SELECT accion, actor_usuario_id::text AS actor, estado_anterior, estado_nuevo FROM auditoria_plataforma
      WHERE negocio_id = $1 AND accion LIKE 'asistente_restaurante_%' ORDER BY created_at, id`, [neg])).rows;
  try {
    await cfg(A, AV.BANDERA, 'true');
    await cfg(A, AV.CLAVE_DESTINATARIOS, JSON.stringify([ADMIN_A]));
    await cfg(A, AV.CLAVE_MODO, undefined);
    await cfg(A, C.CLAVE_TIPOS_APAGADOS, undefined);
    await cfg(A, C.CLAVE_UMBRALES, undefined);

    await t('R1. solo quien recibe los avisos la ve; a los demás administradores ni aparece (sin 403 que asuste al panel)', async () => {
      const yo = await api(RUTA, S.adminA);
      assert.strictEqual(yo.status, 200);
      assert.strictEqual(yo.datos.disponible, true, 'el destinatario no la ve en ensayo');
      assert.match(yo.cache || '', /no-store/);
      const otro = await api(RUTA, S.admin2A);
      assert.strictEqual(otro.status, 200);
      assert.deepStrictEqual(otro.datos, { disponible: false }, 'otro administrador la ve');
      assert.strictEqual((await api(RUTA, S.admin2A, 'PUT', cambio({ destinatarios: [ADMIN2_A] }))).status, 403, 'otro administrador la cambió');
      assert.strictEqual((await api(`${RUTA}/volver-a-avisar`, S.admin2A, 'POST', { firma: 'x' })).status, 403);
      assert.strictEqual((await api(RUTA, S.staffA)).status, 403);
      assert.strictEqual((await api(RUTA, S.staffA, 'PUT', cambio())).status, 403);
      assert.strictEqual((await api(RUTA, null)).status, 401);
      await cfg(A, AV.BANDERA, undefined);
      try {
        assert.deepStrictEqual((await api(RUTA, S.adminA)).datos, { disponible: false }, 'con el asistente apagado la ve');
        assert.strictEqual((await api(RUTA, S.adminA, 'PUT', cambio())).status, 403);
      } finally { await cfg(A, AV.BANDERA, 'true'); }
      assert.deepStrictEqual(await claves(A), { [AV.BANDERA]: 'true', [AV.CLAVE_DESTINATARIOS]: JSON.stringify([ADMIN_A]) }, 'algún intento rechazado escribió');
    });

    await t('R2. lo que pinta la tarjeta: los 5 grupos, los ajustes y SOLO los administradores activos de esta sucursal', async () => {
      const hA = await uno(`INSERT INTO asistente_restaurante_corridas (negocio_id, fecha, modo, estado) VALUES ($1, '2000-01-03', 'ensayo', 'lista') RETURNING id`, [A]);
      await q(`INSERT INTO asistente_restaurante_hallazgos (negocio_id, corrida_id, tipo, firma, impacto, titulo, elegido, motivo)
               VALUES ($1, $2, 'producto_baja', 'producto_baja:molletes', 900, '«Molletes» vendió 20 % menos (−$900).', true, 'elegido')`, [A, hA.id]);
      await q(`INSERT INTO asistente_restaurante_silenciados (negocio_id, firma, usuario_id) VALUES ($1, 'producto_baja:molletes', $2)`, [A, ADMIN_A]);
      const d = (await api(RUTA, S.adminA)).datos;
      assert.strictEqual(d.yo, ADMIN_A);
      assert.strictEqual(d.modo, 'ensayo');
      assert.deepStrictEqual(d.grupos.map((g) => g.id), ['control', 'bajan', 'suben', 'clientes', 'lunes']);
      assert.strictEqual(d.grupos.flatMap((g) => g.tipos).length, R.TIPOS_HALLAZGO.length);
      assert.ok(d.grupos.flatMap((g) => g.tipos).every((x) => x.encendido && x.nombre));
      assert.deepStrictEqual(d.ajustes, C.AJUSTES_DE_SIEMPRE);
      assert.deepStrictEqual(Object.keys(d.limites), Object.keys(C.AJUSTES));
      const ids = d.administradores.map((x) => x.id).sort();
      assert.deepStrictEqual(ids, [ADMIN_A, ADMIN2_A, DOS].sort(), 'la lista debe tener solo los administradores ACTIVOS de A (sin personal, sin bajas, sin los de B)');
      assert.deepStrictEqual(d.administradores.filter((x) => x.recibe).map((x) => x.id), [ADMIN_A]);
      assert.strictEqual(d.silenciados.length, 1);
      assert.deepStrictEqual({ ...d.silenciados[0], creado_en: undefined }, {
        firma: 'producto_baja:molletes', tipo: 'producto_baja', titulo: '«Molletes» vendió 20 % menos (−$900).', por: `${TAG} Dueño A`, creado_en: undefined,
      });
    });

    await t('R3. el servidor rechaza lo inválido y no cambia nada', async () => {
      const antes = await claves(A);
      const casos = [
        [cambio({ ajustes: { ...C.AJUSTES_DE_SIEMPRE, avisosPorDia: 5 } }), /Avisos por día/],
        [cambio({ ajustes: { ...C.AJUSTES_DE_SIEMPRE, cambioPct: 5 } }), /Cambio mínimo/],
        [cambio({ tiposApagados: ['borrar_todo'] }), /desconocido/],
        [cambio({ destinatarios: [ADMIN2_A] }), /No te puedes quitar/],
        [cambio({ destinatarios: [ADMIN_A, ADMIN_B] }), /administradores activos de esta sucursal/],
        [cambio({ destinatarios: [ADMIN_A, STAFF_A] }), /administradores activos de esta sucursal/],
        [cambio({ destinatarios: [ADMIN_A, BAJA_A] }), /administradores activos de esta sucursal/],
        [{ ...cambio(), negocioId: B }, /No se reconoce/],
      ];
      for (const [cuerpo, patron] of casos) {
        const r = await api(RUTA, S.adminA, 'PUT', cuerpo);
        assert.strictEqual(r.status, 400, `${JSON.stringify(cuerpo).slice(0, 120)} → ${r.status}`);
        assert.match(r.datos?.error || '', patron);
      }
      assert.deepStrictEqual(await claves(A), antes, 'un cambio rechazado escribió algo');
      assert.deepStrictEqual(await bitacora(A), [], 'un cambio rechazado quedó en la bitácora');
    });

    await t('R4. un cambio válido se guarda entero, queda en la bitácora y el nuevo destinatario ya puede entrar', async () => {
      const nuevo = cambio({
        tiposApagados: ['producto_sube', 'combinaciones'],
        ajustes: { ...C.AJUSTES_DE_SIEMPRE, avisosPorDia: 2, minimoPesos: 1500, diasSinVenir: 30 },
        destinatarios: [ADMIN_A, ADMIN2_A],
      });
      const r = await api(RUTA, S.adminA, 'PUT', nuevo);
      assert.strictEqual(r.status, 200, JSON.stringify(r.datos));
      assert.deepStrictEqual(r.datos.ajustes, nuevo.ajustes);
      assert.deepStrictEqual(r.datos.grupos.flatMap((g) => g.tipos).filter((x) => !x.encendido).map((x) => x.tipo).sort(), ['combinaciones', 'producto_sube']);
      const k = await claves(A);
      assert.deepStrictEqual(JSON.parse(k[C.CLAVE_UMBRALES]), nuevo.ajustes);
      assert.deepStrictEqual(JSON.parse(k[C.CLAVE_TIPOS_APAGADOS]), ['producto_sube', 'combinaciones']);
      assert.deepStrictEqual(JSON.parse(k[AV.CLAVE_DESTINATARIOS]), [ADMIN_A, ADMIN2_A]);
      assert.strictEqual(k[AV.CLAVE_MODO], 'ensayo');
      assert.strictEqual(k[AV.BANDERA], 'true', 'la bandera de encendido no se toca desde la tarjeta');
      const b = await bitacora(A);
      assert.strictEqual(b.length, 1);
      assert.strictEqual(b[0].accion, 'asistente_restaurante_configuracion');
      assert.strictEqual(b[0].actor, ADMIN_A);
      assert.deepStrictEqual(b[0].estado_anterior.destinatarios, [ADMIN_A.toLowerCase()]);
      assert.deepStrictEqual(b[0].estado_anterior.ajustes, C.AJUSTES_DE_SIEMPRE);
      assert.deepStrictEqual(b[0].estado_nuevo.ajustes, nuevo.ajustes);
      assert.strictEqual((await api(RUTA, S.admin2A)).datos.disponible, true, 'el nuevo destinatario no la ve');
      // Lo leído por la revisión es lo guardado.
      const leida = C.paraLaRevision(await C.leerConfiguracion(pool, A));
      assert.strictEqual(leida.maximo, 2);
      assert.strictEqual(leida.umbrales.clienteAusenciaMinima, 30);
    });

    await t('R5. «Mostrar el asistente en Reportes»: el interruptor pasa a visible y la pestaña ya se deja ver (la campanita no, Fase 4)', async () => {
      const pestana = '/api/admin/asistente-restaurante/pantalla?solo=estado';
      const campanita = '/api/admin/asistente-restaurante/avisos';
      const r = await api(RUTA, S.adminA, 'PUT', cambio({ modo: 'visible' }));
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.datos.modo, 'visible');
      assert.strictEqual((await claves(A))[AV.CLAVE_MODO], 'visible');
      assert.strictEqual(AV.puedeVer(await AV.configuracionAsistente(pool, A), { usuarioId: ADMIN_A }), true);
      assert.deepStrictEqual((await api(pestana, S.adminA)).datos, { activo: true }, 'la pestaña no se deja ver en visible');
      assert.deepStrictEqual((await api(campanita, S.adminA)).datos, { activo: false, sinVer: 0, avisos: [] }, 'la campanita enseña al asistente');
      const vuelta = await api(RUTA, S.adminA, 'PUT', cambio({ modo: 'ensayo' }));
      assert.strictEqual(vuelta.datos.modo, 'ensayo');
      assert.deepStrictEqual((await api(pestana, S.adminA)).datos, { activo: false });
    });

    await t('R6. «Volver a avisar» quita la marca, queda en la bitácora y una segunda vez responde 404', async () => {
      const r = await api(`${RUTA}/volver-a-avisar`, S.adminA, 'POST', { firma: 'producto_baja:molletes' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.datos));
      assert.deepStrictEqual(r.datos.silenciados, []);
      assert.strictEqual((await q('SELECT 1 FROM asistente_restaurante_silenciados WHERE negocio_id = $1', [A])).rowCount, 0);
      const b = (await bitacora(A)).filter((x) => x.accion === 'asistente_restaurante_volver_a_avisar');
      assert.strictEqual(b.length, 1);
      assert.strictEqual(b[0].estado_anterior.firma, 'producto_baja:molletes');
      assert.strictEqual(b[0].estado_anterior.callado_por, ADMIN_A);
      assert.strictEqual((await api(`${RUTA}/volver-a-avisar`, S.adminA, 'POST', { firma: 'producto_baja:molletes' })).status, 404);
      assert.strictEqual((await api(`${RUTA}/volver-a-avisar`, S.adminA, 'POST', { firma: '' })).status, 400);
      assert.strictEqual((await api(`${RUTA}/volver-a-avisar`, S.adminA, 'POST', { firma: 'x'.repeat(301) })).status, 400);
    });

    await t('R7. una sucursal no lee ni cambia la de otra, ni con la misma cuenta en las dos', async () => {
      await cfg(B, AV.BANDERA, 'true');
      await cfg(B, AV.CLAVE_DESTINATARIOS, JSON.stringify([ADMIN_B, DOS]));
      await q(`INSERT INTO asistente_restaurante_silenciados (negocio_id, firma, usuario_id) VALUES ($1, 'producto_baja:molletes', $2)`, [A, ADMIN_A]);
      const antesA = await claves(A);
      const dB = (await api(RUTA, S.adminB)).datos;
      assert.strictEqual(dB.disponible, true);
      assert.deepStrictEqual(dB.administradores.map((x) => x.id).sort(), [ADMIN_B, DOS].sort(), 'B ve administradores de A');
      assert.deepStrictEqual(dB.silenciados, [], 'B ve los avisos callados de A');
      const r = await api(RUTA, S.adminB, 'PUT', { modo: 'visible', tiposApagados: ['producto_baja'], ajustes: { ...C.AJUSTES_DE_SIEMPRE, avisosPorDia: 1 }, destinatarios: [ADMIN_B] });
      assert.strictEqual(r.status, 200, JSON.stringify(r.datos));
      assert.strictEqual((await api(`${RUTA}/volver-a-avisar`, S.adminB, 'POST', { firma: 'producto_baja:molletes' })).status, 404, 'B quitó un aviso callado de A');
      assert.strictEqual((await q('SELECT 1 FROM asistente_restaurante_silenciados WHERE negocio_id = $1', [A])).rowCount, 1);
      // La cuenta de las dos: con la sesión en A no la ve (no está en la lista de A); en B ya no (B la quitó).
      assert.deepStrictEqual((await api(RUTA, S.dosEnA)).datos, { disponible: false });
      assert.deepStrictEqual((await api(RUTA, S.dosEnB)).datos, { disponible: false });
      await cfg(B, AV.CLAVE_DESTINATARIOS, JSON.stringify([ADMIN_B, DOS]));
      const r2 = await api(RUTA, S.dosEnB, 'PUT', { modo: 'ensayo', tiposApagados: [], ajustes: { ...C.AJUSTES_DE_SIEMPRE, diasSinVenir: 60 }, destinatarios: [DOS, ADMIN_B] });
      assert.strictEqual(r2.status, 200, JSON.stringify(r2.datos));
      assert.strictEqual(JSON.parse((await claves(B))[C.CLAVE_UMBRALES]).diasSinVenir, 60);
      assert.deepStrictEqual(await claves(A), antesA, 'un cambio hecho desde B tocó la configuración de A');
      assert.deepStrictEqual((await bitacora(B)).map((x) => x.actor), [ADMIN_B, DOS]);
    });

    await t('R8. sin el módulo POS no hay rutas de configuración', async () => {
      await q(`DELETE FROM negocio_modulos WHERE negocio_id = $1 AND modulo = 'pos'`, [A]);
      try {
        const r = await api(RUTA, S.adminA);
        assert.strictEqual(r.status, 403);
        assert.strictEqual(r.datos?.codigo, 'modulo_no_contratado');
        assert.strictEqual((await api(RUTA, S.adminA, 'PUT', cambio())).status, 403);
      } finally {
        await q(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1, 'pos', 'activo')`, [A]);
      }
    });
  } finally {
    try { srv.detener(); } catch { /* ya terminó */ }
  }

  await t('Z1. las rutas viven en el módulo del asistente: server.js no cambia y el orden de las guardias es el de la Fase 1', () => {
    const RUTAS = readFileSync(raiz('src/asistenteRestaurante/rutas.js'), 'utf8');
    const SERVER = readFileSync(raiz('src/server.js'), 'utf8');
    assert.strictEqual(SERVER.split('registrarRutasAsistenteRestaurante(app,').length - 1, 1);
    assert.ok(!SERVER.includes('asistente-restaurante/configuracion'), 'server.js registra rutas de configuración por su cuenta');
    for (const r of ['app.get(baseCfg, ...guardias,', 'app.put(baseCfg, ...guardias,', 'app.post(`${baseCfg}/volver-a-avisar`, ...guardias,']) {
      assert.ok(RUTAS.includes(r), `falta ${r}`);
    }
    assert.match(RUTAS, /const guardias = \[requireAdminSeguro, requireModulo\('pos'\)\];/);
    assert.match(RUTAS, /esSoporte: req\.esSoporte === true/);
  });
} finally {
  await limpiar().catch((e) => console.error('limpieza:', e.message));
  await pool.end().catch(() => {});
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas) { console.log(fallos.map((f) => ` - ${f}`).join('\n')); process.exit(1); }
