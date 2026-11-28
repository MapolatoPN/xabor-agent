// ASISTENTE DEL RESTAURANTE, Fase 4: la pestaña «Asistente» de Reportes,
// contra Postgres y con el servidor real.
//
// Negocios, usuarios y ventas INVENTADOS, creados aquí y borrados al final.
// Cubre:
//   P. sin base: la tarjeta de cada tipo (título corto, cifra grande, gráfica),
//      las de antes de la Fase 4 (sin `pantalla`), lo redactado por la IA, lo
//      dañado no truena, y la venta por hora;
//   D. con base: la corrida guarda el título corto; «Cómo va el día» con las
//      ventas de ESTA sucursal hasta esta hora contra el mismo día de la semana
//      pasada (sin pedidos grandes) y en solo lectura; qué revisión se enseña
//      (la más reciente lista, de 7 días); lo callado no sale; máximo 10, los
//      de control primero; la IA y su tope (que ya no va a la campanita); si
//      una parte falla la otra sale igual;
//   R. las rutas: la misma cuenta en dos sucursales ve cada una por separado;
//      «Enviar prueba» responde 410 sin el permiso; la campanita no crea ni
//      lista nada del asistente.
//
// Las sucursales de prueba viven en una zona donde AHORA son de las 0 a las 5:
// el servidor de prueba corre cada minuto la revisión (6 a 12) y así no les
// toca. «Cómo va el día» se pide con su propio «ahora» (las 14:00 de hoy).
import assert from 'assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
void join(__dirname, '..');

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
const PA = await import('../src/asistenteRestaurante/pantalla.js');
const AP = await import('../src/services/avisosPanel.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  if (process.env.CASOS && !new RegExp(process.env.CASOS).test(nombre)) return;
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ═══ P. Sin base ══════════════════════════════════════════════════════════
const num = (etiqueta, valor, formato = 'dinero') => ({ etiqueta, valor, formato });
const fila = (tipo, contenido, extra = {}) => ({ id: 7, tipo, titulo: `Título largo de ${tipo}.`, contenido, opinion: null, ...extra });

await t('P1. control: cifra de esta semana, «lo normal» abajo y la serie de 9 semanas; sin serie, antes/ahora', () => {
  const c = PA.tarjetaDe(fila('descuentos_altos', {
    detalle: { numeros: [num('Esta semana', 4200), num('Lo normal', 1800)] }, sugerencia: 'Revisa quién los dio.',
    pantalla: { encabezado: 'Descuentos arriba de lo normal', serie: [1500, 1700, 1600, 1800, 1900, 1750, 1650, 1850, 4200] },
  }));
  assert.deepStrictEqual({ grupo: c.grupo, etiqueta: c.etiqueta, encabezado: c.encabezado, cifra: c.cifra, sub: c.sub, tono: c.tono },
    { grupo: 'control', etiqueta: 'Control', encabezado: 'Descuentos arriba de lo normal', cifra: '$4,200', sub: 'lo normal $1,800', tono: 'alerta' });
  assert.deepStrictEqual(c.grafica, { tipo: 'serie', valores: [1500, 1700, 1600, 1800, 1900, 1750, 1650, 1850, 4200], formato: 'dinero', etiqueta: 'Últimas 9 semanas' });
  const sin = PA.tarjetaDe(fila('cortesias_altas', { detalle: { numeros: [num('Esta semana', 900), num('Lo normal', 300)] }, pantalla: { serie: ['x', 1] } }));
  assert.deepStrictEqual(sin.grafica, { tipo: 'antesAhora', antes: 300, ahora: 900, formato: 'dinero', etiquetas: ['Lo normal', 'Esta semana'] }, 'una serie dañada se dibujó');
  assert.strictEqual(sin.encabezado, C.NOMBRES_TIPOS.cortesias_altas, 'sin título corto debe usar el nombre del tipo');
});

await t('P2. ventas y menú: % de cambio, lo que se movió en pesos y su tono', () => {
  const baja = PA.tarjetaDe(fila('producto_baja', { detalle: { numeros: [num('Últimas 4', 4900), num('4 semanas antes', 9800)] }, pantalla: { encabezado: '«Café» vende menos' } }));
  assert.deepStrictEqual([baja.grupo, baja.cifra, baja.sub, baja.tono], ['ventas', '−50 %', '−$4,900 en 4 semanas', 'baja']);
  assert.deepStrictEqual(baja.grafica, { tipo: 'antesAhora', antes: 9800, ahora: 4900, formato: 'dinero', etiquetas: ['4 semanas antes', 'Últimas 4'] });
  const sube = PA.tarjetaDe(fila('canal_sube', { detalle: { numeros: [num('Ahora', 66400), num('Antes', 48000)] } }));
  assert.deepStrictEqual([sube.cifra, sube.sub, sube.tono], ['+38.3 %', '+$18,400 en 4 semanas', 'sube']);
  const dia = PA.tarjetaDe(fila('dia_flojo', { detalle: { numeros: [num('Ahora', 800), num('Antes', 1000), num('x', 0), num('y', 0), num('Menos', -800)] } }));
  assert.deepStrictEqual([dia.cifra, dia.sub, dia.tono], ['−20 %', '−$800 en 4 semanas', 'baja']);
  const combo = PA.tarjetaDe(fila('combinaciones', { detalle: { numeros: [num('Tickets', 42, 'entero'), num('Del total', 12.34, 'pct')] } }));
  assert.deepStrictEqual([combo.grupo, combo.etiqueta, combo.cifra, combo.sub], ['menu', 'Menú', '42', 'tickets con las dos · 12.3 % del total']);
  const poca = PA.tarjetaDe(fila('poca_venta', { detalle: { numeros: [num('x', 0), num('Productos', 5, 'entero')] } }));
  assert.deepStrictEqual([poca.cifra, poca.sub], ['5', 'con menos de 6 piezas en 90 días']);
  const calidad = PA.tarjetaDe(fila('ventas_sin_forma_pago', { detalle: { numeros: [num('Ventas', 1, 'entero'), num('Monto', 150)] } }));
  assert.deepStrictEqual([calidad.grupo, calidad.cifra, calidad.sub, calidad.tono], ['control', '$150', '1 venta de la semana', 'alerta']);
});

await t('P3. clientes: iniciales (y «?» sin nombre), cuántos faltan y lo que dejaban', () => {
  const c = PA.tarjetaDe(fila('clientes_dejaron', {
    detalle: { numeros: [num('Clientes', 6, 'entero'), num('Al mes', 3200)], tabla: { columnas: ['Cliente'], filas: [['María López'], ['Cliente sin nombre (…12)'], ['juan'], ['Ana-Sofía Pérez Gil'], ['  '], ['Sexto']] } },
  }));
  assert.deepStrictEqual([c.grupo, c.cifra, c.sub, c.tono], ['clientes', '6', 'dejaban ~$3,200 al mes', 'baja']);
  assert.deepStrictEqual(c.grafica, { tipo: 'iniciales', iniciales: ['ML', '?', 'J', 'AP', '?'], mas: 1 });
  assert.strictEqual(PA.inicialesDe('<img src=x>'), 'IS', 'las iniciales sacan solo letras');
  const n = PA.tarjetaDe(fila('nuevos_regresan_menos', { detalle: { numeros: [num('a', 40, 'entero'), num('b', 8, 'entero'), num('c', 50, 'entero'), num('d', 20, 'entero')] } }));
  assert.deepStrictEqual([n.cifra, n.sub], ['20 %', 'el grupo anterior: 40 %']);
  assert.deepStrictEqual(n.grafica, { tipo: 'antesAhora', antes: 40, ahora: 20, formato: 'pct', etiquetas: ['Grupo anterior', 'Grupo reciente'] });
});

await t('P4. lo redactado por la IA va en el texto largo; los números siempre son los de las reglas', () => {
  const c = PA.tarjetaDe(fila('ventas_sin_forma_pago', {
    detalle: { numeros: [num('Ventas', 3, 'entero'), num('Monto', 600)], nota: 'Nota de las reglas.' }, sugerencia: 'Texto de las reglas.',
    revisar: { numero: 'Ventas sin forma de pago', valor: 3, formato: 'entero', el: '2026-12-03' },
    pantalla: { encabezado: '3 ventas sin forma de pago' },
    ia: { titulo: 'Hubo ventas sin forma de pago.', explicacion: 'Algunos cobros quedaron sin registrar.', sugerencia: 'Pide que la registren.', orden: 0 },
  }));
  assert.deepStrictEqual([c.titulo, c.sugerencia, c.explicacion, c.redactadoConIA], ['Hubo ventas sin forma de pago.', 'Pide que la registren.', 'Algunos cobros quedaron sin registrar.', true]);
  assert.strictEqual(c.encabezado, '3 ventas sin forma de pago');
  assert.deepStrictEqual(c.detalle, { numeros: [num('Ventas', 3, 'entero'), num('Monto', 600)], tabla: null, nota: 'Nota de las reglas.' });
  assert.deepStrictEqual(c.revisar, { numero: 'Ventas sin forma de pago', valor: 3, formato: 'entero', el: '2026-12-03' });
  const sinIA = PA.tarjetaDe(fila('ventas_sin_forma_pago', { sugerencia: 'Texto de las reglas.' }));
  assert.deepStrictEqual([sinIA.titulo, sinIA.sugerencia, sinIA.explicacion, sinIA.redactadoConIA, sinIA.detalle], ['Título largo de ventas_sin_forma_pago.', 'Texto de las reglas.', '', false, null]);
});

await t('P5. lo dañado o de antes de la Fase 4 no truena: sale con el nombre del tipo y sin cifra inventada', () => {
  for (const contenido of [null, [], 'texto', {}, { detalle: 'x', pantalla: 'y', ia: 'z' }, { detalle: { numeros: 'no' } }]) {
    const c = PA.tarjetaDe(fila('producto_baja', contenido));
    assert.strictEqual(c.encabezado, C.NOMBRES_TIPOS.producto_baja, JSON.stringify(contenido));
    assert.strictEqual(c.cifra, null, `inventó una cifra con ${JSON.stringify(contenido)}`);
    assert.strictEqual(c.redactadoConIA, false);
  }
  const larga = PA.tarjetaDe(fila('producto_baja', { pantalla: { encabezado: 'x'.repeat(200) } }));
  assert.strictEqual(larga.encabezado.length, 80);
  assert.strictEqual(PA.tarjetaDe(fila('tipo_que_no_existe', {})).encabezado, 'Título largo de tipo_que_no_existe.');
});

await t('P6. venta por hora: hoy hasta la hora de corte (lo que falta, vacío), el mismo día pasado completo, sin pedidos grandes', () => {
  const HOY_P = '2026-11-26';
  const v = (fecha, hora, neta, clase = 'venta') => ({ fecha, hora, neta, clase });
  const ventas = [
    v(HOY_P, '10:15', 300), v(HOY_P, '11:00', 50000), v(HOY_P, '12:30', 200), v(HOY_P, '15:00', 999), v(HOY_P, '09:00', 80, 'cancelado'),
    v('2026-11-19', '10:00', 100), v('2026-11-19', '12:59', 150), v('2026-11-19', '16:00', 400), v('2026-11-20', '08:00', 7777),
    v(HOY_P, null, 10), v(HOY_P, '1:00', 10),
  ];
  assert.deepStrictEqual(PA.ventaPorHora(ventas, { hoy: HOY_P, horaCorte: '14:00', umbralGrande: 1000 }), [
    { hora: 10, hoy: 300, antes: 100 }, { hora: 11, hoy: 0, antes: 0 }, { hora: 12, hoy: 200, antes: 150 }, { hora: 13, hoy: 0, antes: 0 },
    { hora: 14, hoy: 0, antes: 0 }, { hora: 15, hoy: null, antes: 0 }, { hora: 16, hoy: null, antes: 400 },
  ]);
  assert.deepStrictEqual(PA.ventaPorHora([], { hoy: HOY_P, horaCorte: '14:00', umbralGrande: 1000 }), []);
});

// ═══ La zona, las fechas y los datos inventados ═══════════════════════════
const ZONAS = ['Pacific/Honolulu', 'America/Los_Angeles', 'America/Matamoros', 'America/Sao_Paulo', 'Atlantic/Azores', 'Europe/Madrid',
  'Europe/Moscow', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland'];
const TZ = ZONAS.find((z) => [0, 20, 40].every((m) => P.horaLocal(new Date(Date.now() + m * 60000), z) < 5));
assert.ok(TZ, 'ninguna zona entre las 0 y las 5');
const HOY = fechaOperativaDe(new Date(), TZ);
const AYER = R.sumarDias(HOY, -1);
const PASADA = R.sumarDias(HOY, -7);
const a = (fecha, h, mi = 0) => { const [y, mo, d] = fecha.split('-').map(Number); return instanteLocal(y, mo, d, h, mi, 0, TZ); };
const CATORCE = a(HOY, 14);

const TAG = 'AV' + (Date.now() % 1e8).toString(36).toUpperCase();
const SLUG = (l) => `${TAG.toLowerCase()}-asis-f4-${l}`;
const q = (sql, params) => pool.query(sql, params);
const uno = async (sql, params) => (await q(sql, params)).rows[0];

async function limpiar() {
  const { rows } = await q(`SELECT id FROM negocios WHERE slug LIKE '%-asis-f4-_'`);
  for (const { id } of rows) {
    const del = (sql) => q(sql, [id]).catch(() => {});
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
    await q('DELETE FROM usuario_negocios WHERE usuario_id IN (SELECT id FROM usuarios WHERE negocio_id = $1)', [id]).catch(() => {});
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
async function usuario(neg, nombre, rol, otras = []) {
  const u = await uno(`INSERT INTO usuarios (negocio_id, nombre, email, password_hash, activo) VALUES ($1,$2,$3,'x',true) RETURNING id`,
    [neg, nombre, `${TAG.toLowerCase()}-${nombre.replace(/\W+/g, '').toLowerCase()}@test.local`]);
  for (const n of [neg, ...otras]) await q('INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1,$2,$3,true)', [u.id, n, rol]);
  return u.id;
}
async function cfg(neg, clave, valor) {
  await q('DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2', [neg, clave]);
  if (valor !== undefined) await q('INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,$2,$3)', [neg, clave, valor]);
}
const F = (s) => `ACV-${TAG}-${s}`;
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
const STAFF_A = await usuario(A, `${TAG} Cajera A`, 'staff');
const ADMIN_AB = await usuario(A, `${TAG} Dueña de las dos`, 'admin', [B]);
const NA = { id: A, nombre: NOMBRE_A, tz: TZ };
const NB = { id: B, nombre: NOMBRE_B, tz: TZ };
await cfg(A, AV.BANDERA, 'true');
await cfg(A, AV.CLAVE_MODO, 'visible');
await cfg(A, AV.CLAVE_DESTINATARIOS, JSON.stringify([ADMIN_A, ADMIN_AB]));
await cfg(B, AV.BANDERA, 'true');
await cfg(B, AV.CLAVE_MODO, 'visible');
await cfg(B, AV.CLAVE_DESTINATARIOS, JSON.stringify([ADMIN_AB]));
await cfg(A, 'avisos_panel_v1', 'true');

// A, hoy: dos ventas antes de las 14:00, una grande ($50,000, no entra en la
// comparación) y una después de las 14:00 (todavía no cuenta). El mismo día
// de la semana pasada: dos antes de las 14:00 y una después. Ayer: 3 sin forma
// de pago entre 5 normales (para la revisión de la mañana).
// B: cifras que no deben salir NUNCA en lo de A.
await venta(A, F('H1'), a(HOY, 10, 15), 300);
await venta(A, F('H2'), a(HOY, 11), 50000);
await venta(A, F('H3'), a(HOY, 12, 30), 200);
await venta(A, F('H4'), a(HOY, 15), 999);
await venta(A, F('P1'), a(PASADA, 10), 100);
await venta(A, F('P2'), a(PASADA, 12, 59), 150);
await venta(A, F('P3'), a(PASADA, 16), 400);
for (let i = 1; i <= 5; i++) await venta(A, F(`AOK${i}`), a(AYER, 9 + i), 120);
await venta(A, F('ASF1'), a(AYER, 15), 150, { forma_pago: undefined });
await venta(A, F('ASF2'), a(AYER, 16), 200, { forma_pago: undefined });
await venta(A, F('ASF3'), a(AYER, 17), 250, { forma_pago: undefined });
await venta(B, F('BH1'), a(HOY, 12), 7777);
await venta(B, F('BP1'), a(PASADA, 12), 5555);
await venta(B, F('BSF1'), a(AYER, 15), 3333, { forma_pago: undefined });
// Sin los id (un id de hallazgo podría contener «3333»): solo lo que se lee.
const sinIds = (x) => (typeof x === 'string' ? x : JSON.stringify(x, (k, v) => (k === 'id' ? undefined : v)));
const deB = (x) => /7,?777|5,?555|3,?333|BH1|BP1|BSF1/.test(sinIds(x));
const deA = (x) => /50,?000|ASF\d|AOK\d|-H\d\b/.test(sinIds(x));

const corridaDe = async (neg, fecha = HOY) => (await q('SELECT id::text AS id, ia FROM asistente_restaurante_corridas WHERE negocio_id = $1 AND fecha = $2', [neg, fecha])).rows[0] || null;
const hallazgosDe = async (neg) => (await q('SELECT id::text AS id, tipo, firma, elegido, contenido FROM asistente_restaurante_hallazgos WHERE negocio_id = $1 ORDER BY id', [neg])).rows;
const pantallaDe = (neg, usuarioId, ahora = CATORCE, db = pool) => PA.leerPantalla(db, { negocioId: neg, usuarioId, ahora });

try {
  // ═══ D. Con base ═══════════════════════════════════════════════════════
  await t('D1. la corrida de la mañana guarda el título corto (y la serie de control) de cada hallazgo', async () => {
    const r = await P.correrSucursal({ negocio: NA, modo: 'visible', hoy: HOY, ahora: a(HOY, 7) });
    assert.ok(r.corridaId, JSON.stringify(r));
    await P.correrSucursal({ negocio: NB, modo: 'visible', hoy: HOY, ahora: a(HOY, 7) });
    const hs = await hallazgosDe(A);
    assert.ok(hs.length > 0);
    for (const h of hs) {
      const e = h.contenido?.pantalla?.encabezado;
      assert.ok(typeof e === 'string' && e.length >= 8 && e.length <= 60, `${h.tipo} sin título corto: ${JSON.stringify(h.contenido?.pantalla)}`);
      assert.deepStrictEqual(R.faltasDeHallazgo({ ...h.contenido, tipo: h.tipo, firma: h.firma, impacto: 0, titulo: 'x' }), [], `${h.tipo}: el título corto no pasa la revisión`);
    }
    assert.strictEqual(hs.find((h) => h.tipo === 'ventas_sin_forma_pago').contenido.pantalla.encabezado, '3 ventas sin forma de pago');
    assert.ok(!deB(hs), 'la corrida de A guardó datos de B');
  });

  await t('D2. «Cómo va el día»: hoy hasta las 14:00 contra el mismo día pasado hasta las 14:00, sin el pedido grande, con la venta por hora', async () => {
    PA.olvidarUmbrales();
    const r = await pantallaDe(A, ADMIN_A);
    assert.strictEqual(r.activo, true);
    assert.strictEqual(r.sucursal, NOMBRE_A);
    const c = r.comoVa;
    assert.ok(c, '«Cómo va el día» no salió');
    assert.deepStrictEqual([c.hoy, c.horaCorte, c.dia, c.comparadoCon], [HOY, '14:00', RS.diaDeLaSemana(HOY), RS.diaDeLaSemana(PASADA)]);
    assert.deepStrictEqual(c.actual, { venta: 500, tickets: 2, grandes: 1, grandesVenta: 50000, promedio: 250 });
    assert.deepStrictEqual(c.antes, { venta: 250, tickets: 2, grandes: 0, grandesVenta: 0, promedio: 125 });
    assert.strictEqual(c.cambioPct, 100);
    assert.strictEqual(c.umbralGrande, 1000);
    assert.deepStrictEqual(c.porHora, [
      { hora: 10, hoy: 300, antes: 100 }, { hora: 11, hoy: 0, antes: 0 }, { hora: 12, hoy: 200, antes: 150 }, { hora: 13, hoy: 0, antes: 0 },
      { hora: 14, hoy: 0, antes: 0 }, { hora: 15, hoy: null, antes: 0 }, { hora: 16, hoy: null, antes: 400 },
    ]);
    assert.ok(!deB(r), 'la pestaña de A trae cifras de B');
  });

  await t('D3. la otra sucursal ve SOLO lo suyo: sus ventas, su revisión y sus tarjetas', async () => {
    const rb = await pantallaDe(B, ADMIN_AB);
    assert.strictEqual(rb.sucursal, NOMBRE_B);
    assert.strictEqual(rb.comoVa.actual.venta, 7777);
    assert.strictEqual(rb.comoVa.antes.venta, 5555);
    assert.ok(!deA(rb), 'la pestaña de B trae datos de A');
    const idsA = new Set((await hallazgosDe(A)).map((h) => h.id));
    assert.ok(!rb.tarjetas.some((x) => idsA.has(x.id)), 'B ve una tarjeta de A');
    const ra = await pantallaDe(A, ADMIN_AB);
    assert.ok(ra.tarjetas.length > 0 && ra.tarjetas.every((x) => idsA.has(x.id)), 'A con la misma cuenta ve tarjetas de otra sucursal');
  });

  await t('D4. se enseña la revisión LISTA más reciente de los últimos 7 días; ni una fallida, ni una de hace 7 días, ni una futura', async () => {
    const c = await corridaDe(A);
    const mover = (fecha) => q('UPDATE asistente_restaurante_corridas SET fecha = $2 WHERE id = $1', [c.id, fecha]);
    const hoy = await pantallaDe(A, ADMIN_A);
    assert.deepStrictEqual([hoy.revision.fecha, hoy.revision.esHoy], [HOY, true]);
    assert.match(hoy.revision.hora, /^\d{2}:\d{2}$/);
    const n = hoy.tarjetas.length;
    const fallida = await uno(`INSERT INTO asistente_restaurante_corridas (negocio_id, fecha, modo, estado) VALUES ($1, $2, 'visible', 'fallo') RETURNING id`, [A, R.sumarDias(HOY, -1)]);
    try {
      await mover(R.sumarDias(HOY, -3));
      let r = await pantallaDe(A, ADMIN_A);
      assert.deepStrictEqual([r.revision.fecha, r.revision.esHoy, r.tarjetas.length], [R.sumarDias(HOY, -3), false, n], 'la fallida tapó a la lista');
      await mover(R.sumarDias(HOY, -6));
      r = await pantallaDe(A, ADMIN_A);
      assert.strictEqual(r.revision?.fecha, R.sumarDias(HOY, -6));
      await mover(R.sumarDias(HOY, -7));
      r = await pantallaDe(A, ADMIN_A);
      assert.deepStrictEqual([r.revision, r.tarjetas], [null, []], 'enseñó una revisión de hace 7 días');
      assert.ok(r.comoVa, 'sin revisión, «Cómo va el día» debe salir igual');
      await mover(R.sumarDias(HOY, 1));
      assert.strictEqual((await pantallaDe(A, ADMIN_A)).revision, null, 'enseñó una revisión del futuro');
    } finally {
      await mover(HOY);
      await q('DELETE FROM asistente_restaurante_corridas WHERE id = $1', [fallida.id]);
    }
  });

  await t('D5. máximo 10 tarjetas: primero las de control, luego el orden de la IA, luego las que más pesan; lo callado no sale', async () => {
    const c = await corridaDe(A);
    const ins = async (tipo, impacto, firma, contenido = {}) => (await uno(
      `INSERT INTO asistente_restaurante_hallazgos (negocio_id, corrida_id, tipo, firma, impacto, titulo, contenido, elegido, motivo, mostrado)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, true, 'prueba', true) RETURNING id::text AS id`,
      [A, c.id, tipo, firma, impacto, `Prueba ${firma}`, JSON.stringify(contenido)])).id;
    const puestos = [];
    try {
      const pesos = [];
      for (let i = 1; i <= 11; i++) { const id = await ins('producto_sube', i * 100, `prueba-d5-${i}`); puestos.push(id); pesos.push([id, i * 100]); }
      const conIA = await ins('producto_baja', 1, 'prueba-d5-ia', { ia: { titulo: 'x', explicacion: 'x', sugerencia: 'x', orden: 0 } });
      const control = await ins('cortesias_altas', 1, 'prueba-d5-control');
      puestos.push(conIA, control);
      let r = await pantallaDe(A, ADMIN_A);
      assert.strictEqual(r.tarjetas.length, PA.MAXIMO_TARJETAS);
      const grupos = r.tarjetas.map((x) => x.grupo);
      const ultimoControl = grupos.lastIndexOf('control');
      assert.ok(grupos.slice(0, ultimoControl + 1).every((g) => g === 'control'), `control no va primero: ${grupos.join(', ')}`);
      assert.ok(r.tarjetas.some((x) => x.id === control), 'falta el de control');
      assert.strictEqual(r.tarjetas[ultimoControl + 1].id, conIA, 'el orden de la IA no va después de control');
      const mios = r.tarjetas.map((x) => x.id).filter((id) => pesos.some(([p]) => p === id));
      const esperado = [...pesos].sort((x, y) => y[1] - x[1]).map(([id]) => id).slice(0, mios.length);
      assert.deepStrictEqual(mios, esperado, 'no van de más a menos peso');
      // «No avisar de esto» sobre el que más pesa: sale de la pestaña.
      await q('INSERT INTO asistente_restaurante_silenciados (negocio_id, firma, usuario_id) VALUES ($1, $2, $3)', [A, 'prueba-d5-11', ADMIN_A]);
      r = await pantallaDe(A, ADMIN_A);
      assert.ok(!r.tarjetas.some((x) => x.id === pesos[10][0]), 'lo callado sigue en la pestaña');
      // Y el silencio de A no calla a B.
      assert.strictEqual((await q('SELECT COUNT(*)::int AS n FROM asistente_restaurante_silenciados WHERE negocio_id = $1', [B])).rows[0].n, 0);
    } finally {
      await q('DELETE FROM asistente_restaurante_hallazgos WHERE negocio_id = $1 AND id = ANY($2::bigint[])', [A, puestos]);
      await q(`DELETE FROM asistente_restaurante_silenciados WHERE negocio_id = $1 AND firma LIKE 'prueba-d5-%'`, [A]);
    }
  });

  await t('D6. la opinión de la tarjeta es la de ESTA persona', async () => {
    const [x] = (await pantallaDe(A, ADMIN_A)).tarjetas;
    await AV.opinarAviso(pool, A, { id: x.id, usuarioId: ADMIN_A, opinion: 'util', desdePantalla: true });
    try {
      assert.strictEqual((await pantallaDe(A, ADMIN_A)).tarjetas.find((y) => y.id === x.id).opinion, 'util');
      assert.strictEqual((await pantallaDe(A, ADMIN_AB)).tarjetas.find((y) => y.id === x.id).opinion, null, 'vio la opinión de otra persona');
      assert.strictEqual(await AV.opinarAviso(pool, B, { id: x.id, usuarioId: ADMIN_AB, opinion: 'util', desdePantalla: true }), null, 'opinó desde B sobre un aviso de A');
    } finally {
      await q('DELETE FROM asistente_restaurante_opiniones WHERE negocio_id = $1', [A]);
    }
  });

  await t('D7. la IA: apagada no dice nada; encendida dice el gasto de ESTA sucursal y avisa del tope (por gasto o por la corrida)', async () => {
    let r = await pantallaDe(A, ADMIN_A);
    assert.deepStrictEqual(r.ia, { encendida: false, topeUsd: 10, gastoMesUsd: 0, alTope: false });
    await q(`INSERT INTO asistente_restaurante_gasto_ia (negocio_id, proposito, modelo, costo_usd, resultado) VALUES ($1, 'avisos', 'm', 40, 'ok')`, [B]);
    await q(`INSERT INTO asistente_restaurante_gasto_ia (negocio_id, proposito, modelo, costo_usd, resultado) VALUES ($1, 'avisos', 'm', 2.5, 'ok')`, [A]);
    await cfg(A, C.CLAVE_RESUMEN, JSON.stringify({ ...C.RESUMEN_DE_SIEMPRE, ia: true, topeUsd: 5 }));
    try {
      r = await pantallaDe(A, ADMIN_A);
      assert.deepStrictEqual(r.ia, { encendida: true, topeUsd: 5, gastoMesUsd: 2.5, alTope: false }, 'contó el gasto de B');
      await q(`INSERT INTO asistente_restaurante_gasto_ia (negocio_id, proposito, modelo, costo_usd, resultado) VALUES ($1, 'avisos', 'm', 2.5, 'ok')`, [A]);
      assert.strictEqual((await pantallaDe(A, ADMIN_A)).ia.alTope, true, 'gastó el tope y no lo dice');
      await q(`DELETE FROM asistente_restaurante_gasto_ia WHERE negocio_id = $1`, [A]);
      await q(`UPDATE asistente_restaurante_corridas SET ia = 'tope' WHERE negocio_id = $1 AND fecha = $2`, [A, HOY]);
      assert.strictEqual((await pantallaDe(A, ADMIN_A)).ia.alTope, true, 'la corrida se quedó sin IA por el tope y no lo dice');
      await cfg(A, C.CLAVE_RESUMEN, JSON.stringify({ ...C.RESUMEN_DE_SIEMPRE, ia: false, topeUsd: 5 }));
      assert.strictEqual((await pantallaDe(A, ADMIN_A)).ia.alTope, false, 'con la IA apagada avisa del tope');
    } finally {
      await q(`UPDATE asistente_restaurante_corridas SET ia = NULL WHERE negocio_id = $1 AND fecha = $2`, [A, HOY]);
      await q('DELETE FROM asistente_restaurante_gasto_ia WHERE negocio_id = ANY($1::uuid[])', [[A, B]]);
      await cfg(A, C.CLAVE_RESUMEN, undefined);
    }
  });

  await t('D8. la revisión al tope: no llama a la IA, la corrida dice «tope» y NO crea aviso en la campanita', async () => {
    await cfg(A, C.CLAVE_RESUMEN, JSON.stringify({ ...C.RESUMEN_DE_SIEMPRE, ia: true, topeUsd: 1 }));
    await q(`INSERT INTO asistente_restaurante_gasto_ia (negocio_id, proposito, modelo, costo_usd, resultado) VALUES ($1, 'avisos', 'm', 1, 'ok')`, [A]);
    const pedidas = [];
    const nunca = { messages: { create: async (b) => { pedidas.push(b); throw new Error('no debía llamarse'); } } };
    try {
      await q('DELETE FROM asistente_restaurante_corridas WHERE negocio_id = $1 AND fecha = $2', [A, HOY]);
      const r = await P.correrSucursal({ negocio: NA, modo: 'visible', hoy: HOY, ahora: a(HOY, 7), clienteIA: nunca });
      assert.strictEqual(r.ia, 'tope', JSON.stringify(r));
      assert.strictEqual(pedidas.length, 0, 'llamó a la IA sin margen en el tope');
      assert.strictEqual((await corridaDe(A)).ia, 'tope');
      const { rows } = await q(`SELECT tipo FROM avisos_panel WHERE negocio_id = $1 AND tipo LIKE 'asistente_%'`, [A]);
      assert.deepStrictEqual(rows, [], 'el tope fue a la campanita');
      assert.strictEqual((await pantallaDe(A, ADMIN_A)).ia.alTope, true);
    } finally {
      await q('DELETE FROM asistente_restaurante_gasto_ia WHERE negocio_id = $1', [A]);
      await cfg(A, C.CLAVE_RESUMEN, undefined);
    }
  });

  await t('D9. si «Cómo va el día» no se puede leer, las tarjetas salen igual (y al revés no truena)', async () => {
    const roto = { query: (...x) => pool.query(...x), connect: async () => { throw new Error('conexión de prueba rota'); } };
    const r = await pantallaDe(A, ADMIN_A, CATORCE, roto);
    assert.strictEqual(r.comoVa, null);
    assert.ok(r.tarjetas.length > 0, 'sin «Cómo va el día» se perdieron las tarjetas');
    assert.ok(r.revision);
  });

  await t('D10. todo es de SOLO LECTURA y cada consulta lleva el id de SU sucursal (nunca el de otra)', async () => {
    PA.olvidarUmbrales();
    const registro = [];
    const anota = (text, params) => registro.push({ sql: String(text?.text || text), params: params || [] });
    const espia = {
      query: (text, params) => { anota(text, params); return pool.query(text, params); },
      connect: async () => {
        const c = await pool.connect();
        return { query: (text, params) => { anota(text, params); return c.query(text, params); }, release: () => c.release() };
      },
    };
    const r = await pantallaDe(A, ADMIN_A, CATORCE, espia);
    assert.ok(r.comoVa && r.tarjetas.length > 0);
    assert.ok(registro.some((x) => x.sql === 'BEGIN READ ONLY'), 'las ventas no se leyeron en solo lectura');
    for (const { sql, params } of registro) {
      assert.ok(!/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i.test(sql), `escribe: ${sql.slice(0, 80)}`);
      if (/\b(pedidos_activos|configuracion|negocios|asistente_restaurante_\w+)\b/.test(sql)) {
        assert.ok(params.flat().includes(A), `sin el id de la sucursal: ${sql.replace(/\s+/g, ' ').slice(0, 120)}`);
      }
      assert.ok(!params.flat().includes(B), 'una consulta llevó el id de otra sucursal');
    }
  });

  // ═══ R. Las rutas, con el servidor real ════════════════════════════════
  const { crearTokenSesion } = await import('../src/services/session.js');
  const { arrancarServidor } = await import('./lib-servidor.mjs');
  const ses = (u, n, rol) => `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: u, negocioId: n, rol }))}`;
  const S = { adminA: ses(ADMIN_A, A, 'admin'), staffA: ses(STAFF_A, A, 'staff'), dosEnA: ses(ADMIN_AB, A, 'admin'), dosEnB: ses(ADMIN_AB, B, 'admin') };
  // Sin el permiso del resumen por WhatsApp, como en producción.
  const srv = await arrancarServidor({ PORT: process.env.TEST_PORT_ASISTENTE_F4 || '4741' }, { timeoutMs: 40000, omitir: [EN.VARIABLE_PERMISO] });
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
  try {
    await t('R1. la misma cuenta en las dos sucursales: en cada una ve SOLO esa', async () => {
      const ra = await api(RUTA, S.dosEnA);
      const rb = await api(RUTA, S.dosEnB);
      assert.strictEqual(ra.status, 200);
      assert.match(ra.cache || '', /no-store/);
      assert.deepStrictEqual([ra.datos.sucursal, rb.datos.sucursal], [NOMBRE_A, NOMBRE_B]);
      const idsA = new Set((await hallazgosDe(A)).map((h) => h.id));
      assert.ok(ra.datos.tarjetas.every((x) => idsA.has(x.id)));
      assert.ok(!rb.datos.tarjetas.some((x) => idsA.has(x.id)), 'en B ve tarjetas de A');
      assert.ok(!deA(rb.datos), 'en B ve datos de A');
      assert.ok(!deB(ra.datos), 'en A ve datos de B');
      // Apagar B no apaga A para la misma persona.
      await cfg(B, AV.CLAVE_MODO, 'ensayo');
      try {
        assert.deepStrictEqual((await api(RUTA, S.dosEnB)).datos, { activo: false });
        assert.strictEqual((await api(RUTA, S.dosEnA)).datos.activo, true);
      } finally { await cfg(B, AV.CLAVE_MODO, 'visible'); }
    });

    await t('R2. el operador 403 y sin sesión 401, también para opinar', async () => {
      assert.strictEqual((await api(RUTA, S.staffA)).status, 403);
      assert.strictEqual((await api(`${RUTA}?solo=estado`, S.staffA)).status, 403);
      assert.strictEqual((await api(RUTA, null)).status, 401);
      assert.strictEqual((await api(`${RUTA}/avisos/1/opinion`, S.staffA, 'POST', { opinion: 'util' })).status, 403);
      assert.strictEqual((await api(`${RUTA}/avisos/1/opinion`, null, 'POST', { opinion: 'util' })).status, 401);
    });

    await t('R3. «Enviar prueba» del resumen por WhatsApp: 410 sin el permiso, aun para quien ve el asistente; nada queda registrado', async () => {
      const r = await api('/api/admin/asistente-restaurante/configuracion/enviar-prueba', S.adminA, 'POST', {});
      assert.strictEqual(r.status, 410, JSON.stringify(r.datos));
      assert.strictEqual(r.datos.error, EN.MENSAJE_RETIRADO);
      assert.strictEqual((await api('/api/admin/asistente-restaurante/configuracion/enviar-prueba', S.staffA, 'POST', {})).status, 403);
      assert.strictEqual((await q('SELECT COUNT(*)::int AS n FROM asistente_restaurante_resumenes WHERE negocio_id = $1', [A])).rows[0].n, 0);
    });

    await t('R4. la campanita (es para atender clientes): la lista del asistente responde «apagado» y no se crean sus avisos', async () => {
      assert.deepStrictEqual((await api('/api/admin/asistente-restaurante/avisos', S.adminA)).datos, { activo: false, sinVer: 0, avisos: [] });
      for (const tipo of AP.TIPOS_FUERA_DE_LA_CAMPANITA) assert.strictEqual(await AP.registrarAvisoPanel(A, tipo, { datos: { motivo: 'x' } }), null, `se creó ${tipo}`);
      const { rows } = await q(`SELECT tipo FROM avisos_panel WHERE negocio_id = $1 AND tipo LIKE 'asistente_%'`, [A]);
      assert.deepStrictEqual(rows, []);
      // Un aviso normal sigue funcionando.
      assert.ok(await AP.registrarAvisoPanel(A, 'fallas_bot', { datos: { errores: 3 } }));
      assert.strictEqual((await AP.listarAvisosPanel(A)).avisos.length, 1);
    });
  } finally {
    try { srv.detener(); } catch { /* ya terminó */ }
  }
} finally {
  await limpiar().catch((e) => console.error('limpieza:', e.message));
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas) console.log(fallos.map((f) => ` - ${f}`).join('\n'));
await pool.end().catch(() => {});
process.exit(fallidas ? 1 : 0);
