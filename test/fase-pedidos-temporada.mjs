// Pedidos de temporada (Thanksgiving) por ventana de entrega (migración 135).
//
// Lo que protege, en orden de lo que más caro sale:
//
//   1. El CUPO de cada ventana: nunca más platillos que cupo_platillos
//      (recoger + domicilio juntos) ni más pedidos a domicilio que
//      cupo_domicilio, ni siquiera con muchos clientes pidiendo a la vez el
//      último lugar.
//   2. Reenviar el mismo formulario (doble clic, red caída) no aparta otro
//      cupo ni crea otro folio.
//   3. Se cierra solo: después de cierra_en, de que empieza una ventana o de
//      que termina el día, no entra nada. Una campaña apagada no existe desde
//      fuera.
//   4. El negocio A no ve, no cambia y no cancela lo del negocio B. La
//      administración es solo del administrador con sesión real.
//   5. La API pública solo responde CORS a los orígenes permitidos.
//   6. Cancelar libera el cupo y el folio no se reutiliza.
//   7. PAGOS (139): el saldo nunca queda negativo ni se cobra dos veces (ni
//      con dos cajeros a la vez); un pago no se borra ni se corrige, solo se
//      anula con motivo, y lo anulado no cuenta. El precio queda congelado
//      en el pedido: cambiar el de la campaña no mueve lo ya agendado.
//   8. Quién y cuándo: cada pago, anulación y cancelación deja su renglón en
//      la bitácora, que la base no deja cambiar ni borrar.
//   9. CAPTURA Y EDICIÓN (punto 3): lo capturado en el panel comparte cupo y
//      folios con la página; pasar un cupo exige «exceder» y queda anotado.
//      Editar vuelve a medir el cupo sin contarse a sí mismo, no pisa lo que
//      otra tableta cambió, y cada cambio queda con su valor anterior.
//  10. TOTALES (punto 4): venta de confirmados, cobrado sin anulados, por
//      cobrar y por devolver los calcula el servidor en centavos y siempre
//      cuadran; un cancelado no debe nada. La página y el Excel no suman dinero.
//
// Corre contra una base LOCAL desechable (nombre test_*), nunca contra
// Railway. Levanta su propio servidor hijo para la parte C.
//
// Uso:
//   DATABASE_URL=postgresql://...@127.0.0.1:55453/test_botones_x \
//   SESSION_SECRET=... PANEL_SECRET=... ADMIN_PASSWORD=... PANEL_PASSWORD=... \
//   NODE_OPTIONS=--import=./test/red-solo-local.mjs \
//   node test/fase-pedidos-temporada.mjs
//
// Variables opcionales: TEST_PORT_TEMPORADA (4791), CASOS=A,B,C,D (partes).
import assert from 'assert';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Barrera: solo bases locales y desechables ───────────────────────────────
const URL_DB = new URL(process.env.DATABASE_URL || 'postgresql://x@nadie/nada');
if (!['localhost', '127.0.0.1', '::1'].includes(URL_DB.hostname) || !URL_DB.pathname.slice(1).startsWith('test')) {
  console.error('ABORTO: esta suite solo corre contra una base local cuyo nombre empiece con "test".');
  process.exit(2);
}

const PUERTO = process.env.TEST_PORT_TEMPORADA || '4791';
const PARTES = new Set((process.env.CASOS || 'A,B,C,D').split(',').map((s) => s.trim().toUpperCase()));

const { pool } = await import('../src/services/database.js');
const T = await import('../src/services/pedidosTemporada.js');
const { origenesPermitidos } = await import('../src/services/pedidosTemporadaRutas.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const { desdeHoraLocal } = await import('../src/services/zonaHoraria.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}
const lanza = async (codigo, fn) => {
  try { await fn(); }
  catch (e) {
    assert.strictEqual(e.codigo, codigo, `esperaba ${codigo} y vino ${e.codigo || e.code}: ${e.message}`);
    return e;
  }
  assert.fail(`no lanzó ${codigo}`);
};

// ── Fixture: negocios propios en cada corrida ───────────────────────────────
const q1 = async (sql, p) => (await pool.query(sql, p)).rows[0];
const SUF = randomUUID().slice(0, 8);
const negocio = async (nombre) => (await q1(
  `INSERT INTO negocios (nombre, slug, activo, estado) VALUES ($1, $2, true, 'activo') RETURNING id`,
  [nombre, `temporada-${nombre.toLowerCase().replace(/[^a-z]+/g, '-')}-${SUF}`])).id;
const A = await negocio('Negocio A');
const B = await negocio('Negocio B');
const persona = async (neg, nombre, rol) => {
  const id = (await q1(
    `INSERT INTO usuarios (negocio_id, nombre, email, activo) VALUES ($1, $2, $3, true) RETURNING id`,
    [neg, nombre, `${rol}-${randomUUID().slice(0, 8)}@temporada.test.local`])).id;
  await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1, $2, $3, true)`, [id, neg, rol]);
  return id;
};
const ADMIN_A = await persona(A, 'Admin A', 'admin');
const STAFF_A = await persona(A, 'Cajero A', 'staff');
const ADMIN_B = await persona(B, 'Admin B', 'admin');
const COOKIES = {
  adminA: crearTokenSesion({ usuarioId: ADMIN_A, negocioId: A, rol: 'admin' }),
  staffA: crearTokenSesion({ usuarioId: STAFF_A, negocioId: A, rol: 'staff' }),
  adminB: crearTokenSesion({ usuarioId: ADMIN_B, negocioId: B, rol: 'admin' }),
};

const ZONA = 'America/Matamoros';
const enDias = async (dias) => (await q1(
  `SELECT to_char((NOW() AT TIME ZONE $2)::date + $1::int, 'YYYY-MM-DD') AS d`, [dias, ZONA])).d;
const FECHA = await enDias(7);

const base = (extra = {}) => ({
  titulo: 'Thanksgiving prueba', producto: 'Platillo de pavo', precio: 250, descripcion: 'Pavo con puré.',
  fecha: FECHA, hora_inicio: '09:00', hora_fin: '16:00', minutos_ventana: 60,
  cupo_platillos: 40, cupo_domicilio: 10, max_platillos_pedido: 40, cierra_en: null,
  prefijo: 'TG', acepta_recoger: true, acepta_domicilio: true, activa: true, ...extra,
});
const clave = (s) => `prueba-${s}-${SUF}`;
const pedido = (extra = {}) => ({
  nombre: 'Ana López', telefono: '878 123 4567', platillos: 2, modalidad: 'recoger', ventana: '09:00',
  claveEnvio: randomUUID(), ...extra,
});
const usoVentana = async (campanaId, v) => (await q1(
  `SELECT COALESCE(SUM(platillos),0)::int AS platillos,
          (COUNT(*) FILTER (WHERE modalidad='domicilio'))::int AS domicilios, COUNT(*)::int AS pedidos
     FROM temporada_pedidos WHERE campana_id = $1 AND ventana_inicio = $2::time AND estado = 'confirmado'`, [campanaId, v]));

// ═══ A. Piezas puras ════════════════════════════════════════════════════════
if (PARTES.has('A')) {
  console.log('\n── A. Ventanas, teléfono y estado (sin base)');

  await t('A1. 9:00–16:00 en ventanas de 60 min son 7 ventanas y la última termina a las 16:00', async () => {
    const v = T.ventanasDe({ hora_inicio: '09:00', hora_fin: '16:00', minutos_ventana: 60 });
    assert.strictEqual(v.length, 7);
    assert.deepStrictEqual(v[0], { inicio: '09:00', fin: '10:00' });
    assert.deepStrictEqual(v[6], { inicio: '15:00', fin: '16:00' });
    assert.strictEqual(T.ventanasDe({ hora_inicio: '09:00', hora_fin: '16:00', minutos_ventana: 30 }).length, 14);
  });

  await t('A2. teléfono: 10 dígitos o con lada de país; lo demás se rechaza', async () => {
    assert.strictEqual(T.normalizarTelefono('(878) 123-4567'), '8781234567');
    assert.strictEqual(T.normalizarTelefono('+52 878 123 4567'), '528781234567');
    assert.strictEqual(T.normalizarTelefono('+1 830 555 0101'), '18305550101');
    for (const malo of ['', '12345', '878123456', '87812345678', 'abc', '99 878 123 4567']) {
      await lanza('TELEFONO_INVALIDO', async () => T.normalizarTelefono(malo));
    }
  });

  await t('A3. estado: abre y cierra con cierra_en, con el inicio de cada ventana y con el fin del día', async () => {
    const c = { activa: true, fecha: '2026-11-26', hora_inicio: '09:00', hora_fin: '16:00', minutos_ventana: 60,
      cupo_platillos: 40, cupo_domicilio: 10, max_platillos_pedido: 40, acepta_recoger: true, acepta_domicilio: true,
      cierra_en: desdeHoraLocal('2026-11-25T20:00', ZONA) };
    const antes = T.estadoCampana(c, ZONA, desdeHoraLocal('2026-11-25T19:59', ZONA));
    assert.strictEqual(antes.abierta, true);
    assert.ok(antes.ventanas.every((v) => v.maxRecoger === 40 && v.maxDomicilio === 40));
    assert.strictEqual(T.estadoCampana(c, ZONA, desdeHoraLocal('2026-11-25T20:00', ZONA)).motivo, 'cerrada');
    const sinCierre = { ...c, cierra_en: null };
    const dia = T.estadoCampana(sinCierre, ZONA, desdeHoraLocal('2026-11-26T10:30', ZONA));
    assert.strictEqual(dia.abierta, true);
    assert.deepStrictEqual(dia.ventanas.filter((v) => v.pasada).map((v) => v.inicio), ['09:00', '10:00']);
    assert.strictEqual(T.estadoCampana(sinCierre, ZONA, desdeHoraLocal('2026-11-26T16:00', ZONA)).motivo, 'terminada');
    assert.strictEqual(T.estadoCampana({ ...c, activa: false }, ZONA, desdeHoraLocal('2026-11-20T10:00', ZONA)).motivo, 'inactiva');
  });

  await t('A4. estado: el tope por ventana mira platillos libres y domicilios libres', async () => {
    const c = { activa: true, fecha: '2026-11-26', hora_inicio: '09:00', hora_fin: '11:00', minutos_ventana: 60,
      cupo_platillos: 40, cupo_domicilio: 10, max_platillos_pedido: 25, acepta_recoger: true, acepta_domicilio: true, cierra_en: null };
    const e = T.estadoCampana(c, ZONA, desdeHoraLocal('2026-11-20T10:00', ZONA),
      { '09:00': { platillos: 30, domicilios: 3 }, '10:00': { platillos: 5, domicilios: 10 } });
    assert.deepStrictEqual(e.ventanas.map((v) => [v.maxRecoger, v.maxDomicilio]), [[10, 10], [25, 0]]);
  });

  await t('A5. orígenes CORS: los de mapolato.com por omisión; la variable los reemplaza; basura se ignora', async () => {
    assert.deepStrictEqual([...origenesPermitidos(undefined)], ['https://www.mapolato.com', 'https://mapolato.com']);
    assert.deepStrictEqual([...origenesPermitidos('https://otro.mx/, javascript:alert(1), *')], ['https://otro.mx']);
  });

  await t('A6. estado de pago: sin pago → anticipo → pagado; lo anulado no cuenta; anticipo por % o monto', async () => {
    const r = (pagos, anticipo) => T.resumenPago({ precio: 22900, platillos: 2, pagos, anticipo });
    const sin = r([]);
    assert.deepStrictEqual([sin.total, sin.pagado, sin.saldo, sin.estado], [458, 0, 458, 'sin_pago']);
    const ant = r([{ monto: 20000, metodo: 'efectivo' }]);
    assert.deepStrictEqual([ant.pagado, ant.saldo, ant.estado, ant.metodos], [200, 258, 'anticipo', ['efectivo']]);
    const pag = r([{ monto: 20000, metodo: 'efectivo' }, { monto: 25800, metodo: 'tarjeta' }]);
    assert.deepStrictEqual([pag.saldo, pag.estado, pag.metodos], [0, 'pagado', ['efectivo', 'tarjeta']]);
    const anul = r([{ monto: 45800, metodo: 'efectivo', anulado: true }, { monto: 10000, metodo: 'transferencia' }]);
    assert.deepStrictEqual([anul.pagado, anul.saldo, anul.estado, anul.metodos], [100, 358, 'anticipo', ['transferencia']]);
    const pct = r([{ monto: 20000, metodo: 'efectivo' }], { tipo: 'porcentaje', valor: 50 });
    assert.deepStrictEqual([pct.anticipoRequerido, pct.faltaAnticipo], [229, 29]);
    // Un monto fijo mayor que el total pide el total, no más.
    assert.strictEqual(r([], { tipo: 'monto', valor: 50000 }).anticipoRequerido, 458);
    assert.strictEqual(r([{ monto: 50000, metodo: 'efectivo' }]).excedente, 42);
    const sinPrecio = T.resumenPago({ precio: null, platillos: 3, pagos: [] });
    assert.deepStrictEqual([sinPrecio.total, sinPrecio.saldo, sinPrecio.estado], [null, null, 'sin_pago']);
    // En centavos: 0.1 + 0.2 no deja saldo de fracciones.
    const dec = T.resumenPago({ precio: T.aCentavos('0.30'), platillos: 1, pagos: [{ monto: T.aCentavos(0.1) }, { monto: T.aCentavos(0.2) }] });
    assert.deepStrictEqual([dec.saldo, dec.estado], [0, 'pagado']);
  });

  await t('A7. totales: venta de confirmados, cobrado de todo, por cobrar y por devolver; en centavos y siempre cuadran', async () => {
    const C = (pesos) => T.aCentavos(pesos);
    // Diez pedidos de $0.10 con pagos de $0.10 y $0.20 repartidos: sumados en pesos dejarían fracciones.
    const finos = Array.from({ length: 10 }, (_, i) => ({ estado: 'confirmado', total: C(0.3), pagado: i % 2 ? C(0.1) : C(0.2) }));
    const tf = T.totalesTemporada(finos);
    assert.deepStrictEqual([tf.venta, tf.cobrado, tf.porCobrar, tf.porDevolver, tf.conSaldo], [3, 1.5, 1.5, 0, 10]);
    // $0.10 + $0.20 en pesos es 0.30000000000000004.
    const par = T.totalesTemporada([{ estado: 'confirmado', total: C(0.1), pagado: C(0.1) }, { estado: 'confirmado', total: C(0.2), pagado: C(0.2) }]);
    assert.deepStrictEqual([par.venta, par.cobrado, par.porCobrar], [0.3, 0.3, 0]);
    const lista = [
      { estado: 'confirmado', total: C(458), pagado: C(458) },     // liquidado
      { estado: 'confirmado', total: C(687), pagado: C(114.5) },   // con anticipo
      { estado: 'confirmado', total: C(229), pagado: 0 },          // sin pago
      { estado: 'confirmado', total: C(229), pagado: C(687) },     // bajaron los platillos: $458 de más
      { estado: 'cancelado', total: C(229), pagado: C(100) },      // canceló sin que se le devolviera
      { estado: 'cancelado', total: C(458), pagado: 0 },
    ];
    const t7 = T.totalesTemporada(lista);
    assert.deepStrictEqual(t7, { venta: 1603, cobrado: 1359.5, porCobrar: 801.5, porDevolver: 558, conSaldo: 2, sinPrecio: 0 });
    assert.strictEqual(T.aCentavos(t7.venta) - T.aCentavos(t7.cobrado) + T.aCentavos(t7.porDevolver), T.aCentavos(t7.porCobrar));
    // Sin precio no hay venta (null, no $0); con pedidos sin precio en una campaña con precio, se cuentan aparte.
    assert.deepStrictEqual(T.totalesTemporada([{ estado: 'confirmado', total: null, pagado: 0 }]),
      { venta: null, cobrado: 0, porCobrar: 0, porDevolver: 0, conSaldo: 0, sinPrecio: 0 });
    assert.strictEqual(T.totalesTemporada([...lista, { estado: 'confirmado', total: null, pagado: 0 }]).sinPrecio, 1);
    assert.strictEqual(T.totalesTemporada([]).venta, null);
    assert.strictEqual(T.totalesTemporada([], { campanaConPrecio: true }).venta, 0, 'con precio y sin pedidos la venta es $0');
  });
}

// ═══ B. Servicio y base ═════════════════════════════════════════════════════
let CAMP = null;
if (PARTES.has('B')) {
  console.log('\n── B. Servicio y base de datos');

  await t('B1. una campaña nace apagada y apagada no existe desde fuera', async () => {
    const c = await T.guardarCampana(A, null, base({ clave: clave('apagada'), activa: false }));
    assert.strictEqual(c.activa, false);
    await lanza('NO_DISPONIBLE', () => T.campanaPublica(clave('apagada')));
    await lanza('NO_DISPONIBLE', () => T.crearPedidoTemporada(clave('apagada'), pedido()));
    await lanza('NO_DISPONIBLE', () => T.campanaPublica('no-existe-' + SUF));
  });

  await t('B2. encendida: 7 horarios con tope 40 y folios TG-001, TG-002', async () => {
    CAMP = await T.guardarCampana(A, null, base({ clave: clave('principal') }));
    const pub = await T.campanaPublica(clave('principal'));
    assert.strictEqual(pub.abierta, true);
    assert.strictEqual(pub.ventanas.length, 7);
    assert.ok(pub.ventanas.every((v) => v.maxRecoger === 40 && v.maxDomicilio === 40 && !v.pasada));
    assert.strictEqual(pub.negocio, 'Negocio A');
    assert.strictEqual(pub.precio, 250);
    const r1 = await T.crearPedidoTemporada(clave('principal'), pedido({ ventana: '15:00' }));
    const r2 = await T.crearPedidoTemporada(clave('principal'), pedido({ ventana: '15:00', modalidad: 'domicilio', direccion: 'Calle 1 #2, Centro' }));
    assert.strictEqual(r1.pedido.folio, 'TG-001');
    assert.strictEqual(r2.pedido.folio, 'TG-002');
    assert.strictEqual(r1.pedido.total, 500);
    assert.strictEqual(r1.negocioId, A);
  });

  await t('B3. cupo de platillos: 40 por ventana, recoger y domicilio juntos', async () => {
    const k = clave('principal');
    await T.crearPedidoTemporada(k, pedido({ ventana: '09:00', platillos: 30 }));
    await T.crearPedidoTemporada(k, pedido({ ventana: '09:00', platillos: 9, modalidad: 'domicilio', direccion: 'Calle 2 #3, Centro' }));
    const e = await lanza('VENTANA_LLENA', () => T.crearPedidoTemporada(k, pedido({ ventana: '09:00', platillos: 2 })));
    assert.strictEqual(e.extra.libres, 1);
    await T.crearPedidoTemporada(k, pedido({ ventana: '09:00', platillos: 1 }));
    await lanza('VENTANA_LLENA', () => T.crearPedidoTemporada(k, pedido({ ventana: '09:00', platillos: 1 })));
    assert.strictEqual((await usoVentana(CAMP.id, '09:00')).platillos, 40);
    const v = (await T.campanaPublica(k)).ventanas.find((x) => x.inicio === '09:00');
    assert.deepStrictEqual([v.maxRecoger, v.maxDomicilio], [0, 0]);
  });

  await t('B4. cupo de domicilio: 10 entregas por ventana; recoger sigue abierto', async () => {
    const k = clave('principal');
    for (let i = 0; i < 10; i++) {
      await T.crearPedidoTemporada(k, pedido({ ventana: '10:00', platillos: 1, modalidad: 'domicilio', direccion: `Calle ${i} #1, Centro` }));
    }
    await lanza('DOMICILIO_LLENO', () => T.crearPedidoTemporada(k,
      pedido({ ventana: '10:00', platillos: 1, modalidad: 'domicilio', direccion: 'Calle 99, Centro' })));
    await T.crearPedidoTemporada(k, pedido({ ventana: '10:00', platillos: 5, modalidad: 'recoger' }));
    const u = await usoVentana(CAMP.id, '10:00');
    assert.deepStrictEqual([u.domicilios, u.platillos], [10, 15]);
    const v = (await T.campanaPublica(k)).ventanas.find((x) => x.inicio === '10:00');
    assert.deepStrictEqual([v.maxRecoger, v.maxDomicilio], [25, 0]);
  });

  await t('B5. a la vez: 20 clientes por 3 platillos en la ventana de 40 → entran 13 y nunca se pasa', async () => {
    const k = clave('principal');
    const r = await Promise.allSettled(Array.from({ length: 20 }, () =>
      T.crearPedidoTemporada(k, pedido({ ventana: '11:00', platillos: 3 }))));
    const ok = r.filter((x) => x.status === 'fulfilled').length;
    const llenos = r.filter((x) => x.status === 'rejected' && x.reason.codigo === 'VENTANA_LLENA').length;
    assert.strictEqual(ok, 13, `entraron ${ok}`);
    assert.strictEqual(llenos, 7, `rechazos por cupo ${llenos}: ${r.filter((x) => x.status === 'rejected').map((x) => x.reason.message).join(' | ')}`);
    assert.strictEqual((await usoVentana(CAMP.id, '11:00')).platillos, 39);
    const folios = r.filter((x) => x.status === 'fulfilled').map((x) => x.value.pedido.folio);
    assert.strictEqual(new Set(folios).size, 13, 'folios repetidos');
  });

  await t('B6. a la vez: 15 entregas a domicilio en una ventana con cupo 10 → entran 10', async () => {
    const k = clave('principal');
    const r = await Promise.allSettled(Array.from({ length: 15 }, (_, i) =>
      T.crearPedidoTemporada(k, pedido({ ventana: '12:00', platillos: 1, modalidad: 'domicilio', direccion: `Av. ${i} #10, Centro` }))));
    assert.strictEqual(r.filter((x) => x.status === 'fulfilled').length, 10);
    assert.ok(r.filter((x) => x.status === 'rejected').every((x) => x.reason.codigo === 'DOMICILIO_LLENO'));
    assert.strictEqual((await usoVentana(CAMP.id, '12:00')).domicilios, 10);
  });

  await t('B7. el mismo envío dos veces (y a la vez) es UN pedido con el mismo folio', async () => {
    const k = clave('principal');
    const p = pedido({ ventana: '13:00', platillos: 4 });
    const [a, b] = await Promise.all([T.crearPedidoTemporada(k, p), T.crearPedidoTemporada(k, p)]);
    assert.strictEqual(a.pedido.folio, b.pedido.folio);
    assert.deepStrictEqual([a.repetido, b.repetido].sort(), [false, true]);
    const c = await T.crearPedidoTemporada(k, p);
    assert.strictEqual(c.repetido, true);
    assert.strictEqual((await usoVentana(CAMP.id, '13:00')).pedidos, 1);
  });

  await t('B8. cerrada: después de cierra_en, de que empieza la ventana o de que termina el día', async () => {
    const k = clave('cierre');
    await T.guardarCampana(A, null, base({ clave: k, fecha: '2026-11-26', cierra_en: '2026-11-25T20:00' }));
    const ahora = (h) => ({ ahora: desdeHoraLocal(h, ZONA) });
    await T.crearPedidoTemporada(k, pedido({ ventana: '09:00' }), ahora('2026-11-25T19:59'));
    await lanza('CERRADA', () => T.crearPedidoTemporada(k, pedido(), ahora('2026-11-25T20:00')));
    const sinCierre = clave('sin-cierre');
    await T.guardarCampana(A, null, base({ clave: sinCierre, fecha: '2026-11-26' }));
    await lanza('VENTANA_PASADA', () => T.crearPedidoTemporada(sinCierre, pedido({ ventana: '10:00' }), ahora('2026-11-26T10:00')));
    await T.crearPedidoTemporada(sinCierre, pedido({ ventana: '11:00' }), ahora('2026-11-26T10:00'));
    await lanza('CERRADA', () => T.crearPedidoTemporada(sinCierre, pedido({ ventana: '15:00' }), ahora('2026-11-26T16:00')));
  });

  await t('B9. lo que manda el formulario se valida en el servidor', async () => {
    const k = clave('principal');
    await lanza('TELEFONO_INVALIDO', () => T.crearPedidoTemporada(k, pedido({ telefono: '12345' })));
    await lanza('NOMBRE_INVALIDO', () => T.crearPedidoTemporada(k, pedido({ nombre: ' ' })));
    await lanza('DIRECCION_INVALIDA', () => T.crearPedidoTemporada(k, pedido({ modalidad: 'domicilio' })));
    await lanza('MODALIDAD_INVALIDA', () => T.crearPedidoTemporada(k, pedido({ modalidad: 'dron' })));
    await lanza('VENTANA_INVALIDA', () => T.crearPedidoTemporada(k, pedido({ ventana: '09:30' })));
    await lanza('VENTANA_INVALIDA', () => T.crearPedidoTemporada(k, pedido({ ventana: '16:00' })));
    await lanza('VENTANA_INVALIDA', () => T.crearPedidoTemporada(k, pedido({ ventana: 'ayer' })));
    await lanza('PLATILLOS_INVALIDOS', () => T.crearPedidoTemporada(k, pedido({ platillos: 0 })));
    await lanza('PLATILLOS_INVALIDOS', () => T.crearPedidoTemporada(k, pedido({ platillos: 2.5 })));
    await lanza('ENVIO_INVALIDO', () => T.crearPedidoTemporada(k, pedido({ claveEnvio: 'x' })));
    const soloRecoger = clave('solo-recoger');
    await T.guardarCampana(A, null, base({ clave: soloRecoger, acepta_domicilio: false, max_platillos_pedido: 8 }));
    await lanza('MODALIDAD_NO_DISPONIBLE', () => T.crearPedidoTemporada(soloRecoger,
      pedido({ modalidad: 'domicilio', direccion: 'Calle 1, Centro' })));
    await lanza('DEMASIADOS_PLATILLOS', () => T.crearPedidoTemporada(soloRecoger, pedido({ platillos: 9 })));
    // Un nombre con etiquetas se guarda como texto: la página lo pinta con textContent.
    const r = await T.crearPedidoTemporada(soloRecoger, pedido({ nombre: '<img src=x onerror=alert(1)>' }));
    assert.strictEqual(r.pedido.nombre, '<img src=x onerror=alert(1)>');
  });

  await t('B10. cancelar libera el cupo y el folio siguiente no reutiliza el cancelado', async () => {
    const k = clave('principal');
    const lleno = await lanza('VENTANA_LLENA', () => T.crearPedidoTemporada(k, pedido({ ventana: '09:00', platillos: 5 })));
    assert.ok(lleno);
    const det = await T.pedidosDeCampana(A, CAMP.id);
    const delNueve = det.pedidos.find((p) => p.ventana.inicio === '09:00' && p.platillos === 30);
    const maxNumero = Math.max(...det.pedidos.map((p) => Number(p.folio.slice(3))));
    await T.cancelarPedidoTemporada(A, delNueve.id, { actorId: ADMIN_A });
    await lanza('YA_CANCELADO', () => T.cancelarPedidoTemporada(A, delNueve.id));
    const r = await T.crearPedidoTemporada(k, pedido({ ventana: '09:00', platillos: 5 }));
    assert.strictEqual(Number(r.pedido.folio.slice(3)), maxNumero + 1);
    assert.strictEqual((await usoVentana(CAMP.id, '09:00')).platillos, 15);
    const fila = await q1(`SELECT estado, cancelado_por FROM temporada_pedidos WHERE id = $1`, [delNueve.id]);
    assert.deepStrictEqual([fila.estado, fila.cancelado_por], ['cancelado', String(ADMIN_A)]);
  });

  await t('B11. el negocio B no ve, no cambia y no cancela lo de A', async () => {
    const det = await T.pedidosDeCampana(A, CAMP.id);
    const uno = det.pedidos.find((p) => p.estado === 'confirmado');
    await lanza('NO_ENCONTRADA', () => T.pedidosDeCampana(B, CAMP.id));
    await lanza('NO_ENCONTRADA', () => T.guardarCampana(B, CAMP.id, base({ clave: clave('principal') })));
    await lanza('NO_ENCONTRADO', () => T.cancelarPedidoTemporada(B, uno.id));
    assert.strictEqual((await q1(`SELECT estado FROM temporada_pedidos WHERE id = $1`, [uno.id])).estado, 'confirmado');
    const lista = await T.listarCampanas(B);
    assert.deepStrictEqual(lista.campanas, []);
  });

  await t('B12. con pedidos, la fecha y el horario no cambian; los cupos y el texto sí', async () => {
    const k = clave('principal');
    const otraFecha = await enDias(8);
    await lanza('CAMPANA_CON_PEDIDOS', () => T.guardarCampana(A, CAMP.id, base({ clave: k, fecha: otraFecha })));
    await lanza('CAMPANA_CON_PEDIDOS', () => T.guardarCampana(A, CAMP.id, base({ clave: k, hora_fin: '17:00' })));
    await lanza('CAMPANA_CON_PEDIDOS', () => T.guardarCampana(A, CAMP.id, base({ clave: k + '-x' })));
    const c = await T.guardarCampana(A, CAMP.id, base({ clave: k, cupo_platillos: 45, titulo: 'Thanksgiving 2026' }));
    assert.strictEqual(c.cupo_platillos, 45);
    assert.strictEqual(c.titulo, 'Thanksgiving 2026');
    const v = (await T.campanaPublica(k)).ventanas.find((x) => x.inicio === '11:00');
    assert.strictEqual(v.maxRecoger, 6, 'con cupo 45 quedan 6 en la ventana de 39');
    await T.guardarCampana(A, CAMP.id, base({ clave: k }));
  });

  await t('B13. la configuración se valida: clave repetida, horario que no se divide, cupos imposibles', async () => {
    await lanza('CLAVE_OCUPADA', () => T.guardarCampana(B, null, base({ clave: clave('principal') })));
    await lanza('CLAVE_INVALIDA', () => T.guardarCampana(A, null, base({ clave: 'Con Espacios' })));
    await lanza('HORARIO_INVALIDO', () => T.guardarCampana(A, null, base({ clave: clave('h1'), hora_fin: '16:30' })));
    await lanza('HORARIO_INVALIDO', () => T.guardarCampana(A, null, base({ clave: clave('h2'), hora_fin: '08:00' })));
    await lanza('CUPO_INVALIDO', () => T.guardarCampana(A, null, base({ clave: clave('h3'), max_platillos_pedido: 41 })));
    await lanza('CUPO_INVALIDO', () => T.guardarCampana(A, null, base({ clave: clave('h4'), cupo_domicilio: 0 })));
    await lanza('MODALIDAD_INVALIDA', () => T.guardarCampana(A, null, base({ clave: clave('h5'), acepta_recoger: false, acepta_domicilio: false })));
    await lanza('FECHA_INVALIDA', () => T.guardarCampana(A, null, base({ clave: clave('h6'), fecha: '2026-02-30' })));
    const sinDom = await T.guardarCampana(A, null, base({ clave: clave('h7'), cupo_domicilio: 0, acepta_domicilio: false }));
    assert.strictEqual(sinDom.acepta_domicilio, false);
  });

  await t('B14. la base rechaza por su cuenta un domicilio sin dirección y un teléfono con letras', async () => {
    const intento = (campos) => pool.query(
      `INSERT INTO temporada_pedidos (campana_id, negocio_id, numero, nombre, telefono, platillos, modalidad, direccion,
                                      ventana_inicio, ventana_fin, clave_envio)
       VALUES ($1, $2, 9999, 'Prueba', $3, 1, $4, $5, '09:00', '10:00', $6)`,
      [CAMP.id, A, campos.telefono, campos.modalidad, campos.direccion, randomUUID()]);
    await assert.rejects(intento({ telefono: '8781234567', modalidad: 'domicilio', direccion: null }), (e) => e.code === '23514');
    await assert.rejects(intento({ telefono: '878-123-45', modalidad: 'recoger', direccion: null }), (e) => e.code === '23514');
  });

  await t('B15. la lista de administración agrupa por ventana con su uso contra el cupo', async () => {
    const d = await T.pedidosDeCampana(A, CAMP.id);
    assert.strictEqual(d.ventanas.length, 7);
    const diez = d.ventanas.find((v) => v.inicio === '10:00');
    assert.deepStrictEqual([diez.platillos, diez.domicilios, diez.cupoPlatillos, diez.cupoDomicilio], [15, 10, 40, 10]);
    assert.ok(d.pedidos.every((p) => /^TG-\d{3,}$/.test(p.folio)));
    const l = await T.listarCampanas(A);
    assert.match(l.claveSugerida, /^temporada-negocio-a-[0-9a-f]{8}-thanksgiving-\d{4}$/);
  });

  // ── Pagos (139) ──
  const kPagos = clave('pagos');
  let CPAGOS = null;
  const detPedido = async (folio) => (await T.pedidosDeCampana(A, CPAGOS.id)).pedidos.find((p) => p.folio === folio);
  const bitacora = async (pedidoId) => (await pool.query(
    `SELECT accion, usuario_id, detalle FROM temporada_bitacora WHERE pedido_id = $1 ORDER BY id`, [pedidoId])).rows;

  await t('B16. registrar pago: anticipo y liquidación con quién y cuándo; nunca más que el saldo', async () => {
    CPAGOS = await T.guardarCampana(A, null, base({ clave: kPagos, precio: 229, anticipo_tipo: 'porcentaje', anticipo_valor: 50 }));
    assert.deepStrictEqual([CPAGOS.anticipo_tipo, CPAGOS.anticipo_valor], ['porcentaje', 50]);
    const { pedido: agendado } = await T.crearPedidoTemporada(kPagos, pedido({ platillos: 2 }));
    assert.strictEqual(agendado.total, 458);
    let p = await detPedido(agendado.folio);
    assert.deepStrictEqual([p.precio, p.pago.total, p.pago.estado, p.pago.anticipoRequerido, p.pago.faltaAnticipo], [229, 458, 'sin_pago', 229, 229]);
    for (const malo of [0, '0', '-5', '1.234', 'abc', '', null]) {
      await lanza('MONTO_INVALIDO', () => T.registrarPagoTemporada(A, p.id, { monto: malo, metodo: 'efectivo' }, { actorId: ADMIN_A }));
    }
    await lanza('METODO_INVALIDO', () => T.registrarPagoTemporada(A, p.id, { monto: 100, metodo: 'cheque' }, { actorId: ADMIN_A }));
    await lanza('SIN_USUARIO', () => T.registrarPagoTemporada(A, p.id, { monto: 100, metodo: 'efectivo' }));
    await lanza('NO_ENCONTRADO', () => T.registrarPagoTemporada(B, p.id, { monto: 100, metodo: 'efectivo' }, { actorId: ADMIN_B }));
    const r1 = await T.registrarPagoTemporada(A, p.id, { monto: '229', metodo: 'efectivo' }, { actorId: ADMIN_A });
    assert.deepStrictEqual([r1.pago.estado, r1.pago.saldo, r1.pago.faltaAnticipo], ['anticipo', 229, 0]);
    const excede = await lanza('PAGO_EXCEDE', () => T.registrarPagoTemporada(A, p.id, { monto: 229.01, metodo: 'tarjeta' }, { actorId: ADMIN_A }));
    assert.strictEqual(excede.extra.saldo, 229);
    const r2 = await T.registrarPagoTemporada(A, p.id, { monto: '$229.00', metodo: 'transferencia', referencia: 'SPEI 4821' }, { actorId: ADMIN_A });
    assert.deepStrictEqual([r2.pago.estado, r2.pago.saldo], ['pagado', 0]);
    await lanza('YA_PAGADO', () => T.registrarPagoTemporada(A, p.id, { monto: 1, metodo: 'efectivo' }, { actorId: ADMIN_A }));
    p = await detPedido(agendado.folio);
    assert.deepStrictEqual([p.pago.pagado, p.pago.metodos], [458, ['efectivo', 'transferencia']]);
    assert.strictEqual(p.pago.movimientos.length, 2);
    assert.deepStrictEqual(p.pago.movimientos.map((m) => [m.monto, m.metodo, m.registrado_por]),
      [[229, 'efectivo', 'Admin A'], [229, 'transferencia', 'Admin A']]);
    assert.strictEqual(p.pago.movimientos[1].referencia, 'SPEI 4821');
    const b = await bitacora(p.id);
    assert.deepStrictEqual(b.map((x) => [x.accion, x.usuario_id]), [['pago_registrado', ADMIN_A], ['pago_registrado', ADMIN_A]]);
    assert.strictEqual(b[1].detalle.estado, 'pagado');
  });

  await t('B17. a la vez: 6 cobros del saldo completo del mismo pedido → entra uno solo', async () => {
    const { pedido: nuevo } = await T.crearPedidoTemporada(kPagos, pedido({ platillos: 1 }));
    const p = await detPedido(nuevo.folio);
    const r = await Promise.allSettled(Array.from({ length: 6 }, () =>
      T.registrarPagoTemporada(A, p.id, { monto: 229, metodo: 'efectivo' }, { actorId: ADMIN_A })));
    assert.strictEqual(r.filter((x) => x.status === 'fulfilled').length, 1, r.map((x) => x.reason?.codigo || 'ok').join(','));
    assert.ok(r.filter((x) => x.status === 'rejected').every((x) => x.reason.codigo === 'YA_PAGADO'));
    const suma = await q1(`SELECT SUM(monto)::numeric AS s, COUNT(*)::int AS n FROM temporada_pagos WHERE pedido_id = $1`, [p.id]);
    assert.deepStrictEqual([Number(suma.s), suma.n], [229, 1]);
  });

  await t('B18. anular: con motivo, una vez, y deja de contar; la base no deja borrar ni corregir pagos ni bitácora', async () => {
    const { pedido: nuevo } = await T.crearPedidoTemporada(kPagos, pedido({ platillos: 3 }));
    let p = await detPedido(nuevo.folio);
    const { pagoId } = await T.registrarPagoTemporada(A, p.id, { monto: 300, metodo: 'tarjeta' }, { actorId: ADMIN_A });
    await lanza('MOTIVO_REQUERIDO', () => T.anularPagoTemporada(A, pagoId, { motivo: ' ' }, { actorId: ADMIN_A }));
    await lanza('NO_ENCONTRADO', () => T.anularPagoTemporada(B, pagoId, { motivo: 'no es mío' }, { actorId: ADMIN_B }));
    await T.anularPagoTemporada(A, pagoId, { motivo: 'Capturado dos veces' }, { actorId: ADMIN_A });
    await lanza('YA_ANULADO', () => T.anularPagoTemporada(A, pagoId, { motivo: 'otra vez' }, { actorId: ADMIN_A }));
    p = await detPedido(nuevo.folio);
    assert.deepStrictEqual([p.pago.pagado, p.pago.saldo, p.pago.estado], [0, 687, 'sin_pago']);
    const m = p.pago.movimientos[0];
    assert.deepStrictEqual([m.anulado, m.anulado_por, m.motivo_anulacion], [true, 'Admin A', 'Capturado dos veces']);
    assert.deepStrictEqual((await bitacora(p.id)).map((x) => x.accion), ['pago_registrado', 'pago_anulado']);
    // La base, por su cuenta: un pago no se borra, no cambia su monto y no se «des-anula».
    await assert.rejects(pool.query(`DELETE FROM temporada_pagos WHERE id = $1`, [pagoId]), (e) => e.code === 'P0001');
    await assert.rejects(pool.query(`UPDATE temporada_pagos SET monto = 1 WHERE id = $1`, [pagoId]), (e) => e.code === 'P0001');
    await assert.rejects(pool.query(`UPDATE temporada_pagos SET anulado_en = NULL, anulado_por = NULL, motivo_anulacion = NULL WHERE id = $1`, [pagoId]),
      (e) => e.code === 'P0001');
    await assert.rejects(pool.query(`DELETE FROM temporada_bitacora WHERE pedido_id = $1`, [p.id]), (e) => e.code === 'P0001');
    await assert.rejects(pool.query(`UPDATE temporada_bitacora SET accion = 'otra' WHERE pedido_id = $1`, [p.id]), (e) => e.code === 'P0001');
    // Y no se registra un pago anulado sin motivo ni con un método inventado.
    await assert.rejects(pool.query(
      `INSERT INTO temporada_pagos (pedido_id, negocio_id, monto, metodo, registrado_por, anulado_en, anulado_por)
       VALUES ($1, $2, 10, 'efectivo', $3, now(), $3)`, [p.id, A, ADMIN_A]), (e) => e.code === '23514');
    await assert.rejects(pool.query(
      `INSERT INTO temporada_pagos (pedido_id, negocio_id, monto, metodo, registrado_por) VALUES ($1, $2, 10, 'vales', $3)`,
      [p.id, A, ADMIN_A]), (e) => e.code === '23514');
  });

  await t('B19. cancelado: no recibe pagos y la cancelación queda en la bitácora con quién', async () => {
    const { pedido: nuevo } = await T.crearPedidoTemporada(kPagos, pedido({ platillos: 1 }));
    const p = await detPedido(nuevo.folio);
    await T.cancelarPedidoTemporada(A, p.id, { actorId: ADMIN_A });
    await lanza('PEDIDO_CANCELADO', () => T.registrarPagoTemporada(A, p.id, { monto: 100, metodo: 'efectivo' }, { actorId: ADMIN_A }));
    assert.deepStrictEqual((await bitacora(p.id)).map((x) => [x.accion, x.usuario_id]), [['cancelado', ADMIN_A]]);
  });

  await t('B20. el precio queda congelado en el pedido; sin congelar (código anterior) toma el de la campaña', async () => {
    const { pedido: viejo } = await T.crearPedidoTemporada(kPagos, pedido({ platillos: 2 }));
    await T.guardarCampana(A, CPAGOS.id, base({ clave: kPagos, precio: 300, anticipo_tipo: 'porcentaje', anticipo_valor: 50 }));
    const p = await detPedido(viejo.folio);
    assert.deepStrictEqual([p.precio, p.pago.total], [229, 458], 'el precio nuevo movió un pedido ya agendado');
    const { pedido: nuevo } = await T.crearPedidoTemporada(kPagos, pedido({ platillos: 1 }));
    assert.strictEqual(nuevo.total, 300);
    // Un pedido que entró con el binario anterior a la 139 no trae precio congelado.
    await pool.query(`UPDATE temporada_pedidos SET precio_unitario = NULL WHERE id = $1`, [p.id]);
    assert.deepStrictEqual([(await detPedido(viejo.folio)).pago.total], [600]);
    await T.guardarCampana(A, CPAGOS.id, base({ clave: kPagos, precio: 229, anticipo_tipo: 'porcentaje', anticipo_valor: 50 }));
  });

  await t('B21. anticipo: necesita precio, se valida, y una página anterior (sin el campo) no lo borra', async () => {
    await lanza('ANTICIPO_SIN_PRECIO', () => T.guardarCampana(A, null, base({ clave: clave('ant1'), precio: null, anticipo_tipo: 'monto', anticipo_valor: 100 })));
    await lanza('ANTICIPO_INVALIDO', () => T.guardarCampana(A, null, base({ clave: clave('ant2'), anticipo_tipo: 'porcentaje', anticipo_valor: 150 })));
    await lanza('ANTICIPO_INVALIDO', () => T.guardarCampana(A, null, base({ clave: clave('ant3'), anticipo_tipo: 'monto', anticipo_valor: 0 })));
    await lanza('ANTICIPO_INVALIDO', () => T.guardarCampana(A, null, base({ clave: clave('ant4'), anticipo_tipo: 'casi' })));
    const fijo = await T.guardarCampana(A, null, base({ clave: clave('ant5'), anticipo_tipo: 'monto', anticipo_valor: 114.5 }));
    assert.deepStrictEqual([fijo.anticipo_tipo, fijo.anticipo_valor], ['monto', 114.5]);
    // base() no trae anticipo_*: así guarda la página de antes de la 139.
    const igual = await T.guardarCampana(A, fijo.id, base({ clave: clave('ant5'), titulo: 'Otro título' }));
    assert.deepStrictEqual([igual.titulo, igual.anticipo_tipo, igual.anticipo_valor], ['Otro título', 'monto', 114.5]);
    // Quitar el precio con anticipo pedido: se rechaza con su mensaje, no con un 500.
    await lanza('ANTICIPO_SIN_PRECIO', () => T.guardarCampana(A, fijo.id, base({ clave: clave('ant5'), precio: null })));
    const ninguno = await T.guardarCampana(A, fijo.id, base({ clave: clave('ant5'), anticipo_tipo: 'ninguno', anticipo_valor: 50 }));
    assert.deepStrictEqual([ninguno.anticipo_tipo, ninguno.anticipo_valor], ['ninguno', null]);
    // Sin precio no hay a qué cobrarle.
    const kSin = clave('sin-precio');
    const cSin = await T.guardarCampana(A, null, base({ clave: kSin, precio: null }));
    const { pedido: ps } = await T.crearPedidoTemporada(kSin, pedido());
    assert.strictEqual(ps.total, null);
    const p = (await T.pedidosDeCampana(A, cSin.id)).pedidos[0];
    assert.deepStrictEqual([p.precio, p.pago.total, p.pago.estado], [null, null, 'sin_pago']);
    await lanza('SIN_PRECIO', () => T.registrarPagoTemporada(A, p.id, { monto: 100, metodo: 'efectivo' }, { actorId: ADMIN_A }));
    await assert.rejects(pool.query(`UPDATE temporada_campanas SET anticipo_tipo = 'monto', anticipo_valor = 10 WHERE id = $1`, [cSin.id]),
      (e) => e.code === '23514');
  });

  // ── Entrega (punto 2) ──
  const kEnt = clave('entrega');
  let CENT = null;
  const detEnt = async (folio) => (await T.pedidosDeCampana(A, CENT.id)).pedidos.find((p) => p.folio === folio);
  const mover = (p, desde, estado, actor = ADMIN_A, neg = A) =>
    T.cambiarEntregaTemporada(neg, p.id, { desde, estado }, { actorId: actor });

  await t('B22. entrega: un paso a la vez con quién y cuándo; regresar deshace; nunca se salta ni se mueve un cancelado', async () => {
    CENT = await T.guardarCampana(A, null, base({ clave: kEnt, precio: 229 }));
    const { pedido: alta } = await T.crearPedidoTemporada(kEnt, pedido({ platillos: 2, ventana: '11:00' }));
    let p = await detEnt(alta.folio);
    assert.deepStrictEqual([p.entrega.estado, p.entrega.cambiada_en, p.entrega.por], ['agendado', null, null], 'un pedido nuevo nace Agendado');
    for (const malo of [{ desde: 'agendado', estado: 'cocinando' }, { desde: 'x', estado: 'listo' }, {}]) {
      await lanza('ENTREGA_INVALIDA', () => T.cambiarEntregaTemporada(A, p.id, malo, { actorId: ADMIN_A }));
    }
    await lanza('ENTREGA_SALTO', () => mover(p, 'agendado', 'listo'));
    await lanza('ENTREGA_SALTO', () => mover(p, 'agendado', 'entregado'));
    await lanza('ENTREGA_SALTO', () => mover(p, 'agendado', 'agendado'));
    await lanza('SIN_USUARIO', () => T.cambiarEntregaTemporada(A, p.id, { desde: 'agendado', estado: 'en_preparacion' }));
    await lanza('NO_ENCONTRADO', () => mover(p, 'agendado', 'en_preparacion', ADMIN_B, B));
    const r = await mover(p, 'agendado', 'en_preparacion');
    assert.strictEqual(r.estado_entrega, 'en_preparacion');
    // Quien veía «Agendado» (otra tableta) no lo pisa: se le dice en qué paso va.
    const viejo = await lanza('ENTREGA_CAMBIO', () => mover(p, 'agendado', 'en_preparacion'));
    assert.strictEqual(viejo.extra.estado_entrega, 'en_preparacion');
    assert.match(viejo.message, /En preparación/);
    await mover(p, 'en_preparacion', 'listo');
    await mover(p, 'listo', 'entregado');
    await lanza('ENTREGA_INVALIDA', () => mover(p, 'entregado', 'devuelto'));
    // Regresar un paso (toque equivocado) y volver a avanzar.
    await mover(p, 'entregado', 'listo');
    await mover(p, 'listo', 'entregado');
    p = await detEnt(alta.folio);
    assert.deepStrictEqual([p.entrega.estado, p.entrega.por], ['entregado', 'Admin A']);
    assert.ok(p.entrega.cambiada_en, 'sin hora del cambio');
    const b = await bitacora(p.id);
    assert.deepStrictEqual(b.map((x) => [x.accion, x.usuario_id, x.detalle.de, x.detalle.a]), [
      ['entrega_cambiada', ADMIN_A, 'agendado', 'en_preparacion'], ['entrega_cambiada', ADMIN_A, 'en_preparacion', 'listo'],
      ['entrega_cambiada', ADMIN_A, 'listo', 'entregado'], ['entrega_cambiada', ADMIN_A, 'entregado', 'listo'],
      ['entrega_cambiada', ADMIN_A, 'listo', 'entregado']]);
    // Entregado sigue recibiendo su cobro (se paga al entregar).
    const cobro = await T.registrarPagoTemporada(A, p.id, { monto: 458, metodo: 'efectivo' }, { actorId: ADMIN_A });
    assert.strictEqual(cobro.pago.estado, 'pagado');
    // Cancelado: no se le mueve la entrega.
    const { pedido: otro } = await T.crearPedidoTemporada(kEnt, pedido({ platillos: 1, ventana: '11:00' }));
    const po = await detEnt(otro.folio);
    await T.cancelarPedidoTemporada(A, po.id, { actorId: ADMIN_A });
    await lanza('PEDIDO_CANCELADO', () => mover(po, 'agendado', 'en_preparacion'));
  });

  await t('B23. a la vez: 5 tabletas avanzan el mismo pedido → entra un solo cambio y una sola línea de bitácora', async () => {
    const { pedido: alta } = await T.crearPedidoTemporada(kEnt, pedido({ platillos: 1, ventana: '12:00' }));
    const p = await detEnt(alta.folio);
    // Se retiene el pedido mientras llegan las 5: así las cinco leen antes de
    // que ninguna escriba, que es la carrera de verdad (sin esto se forman
    // solas en fila y la prueba pasaría aunque el cambio no bloqueara nada).
    const reten = await pool.connect();
    let intentos;
    try {
      await reten.query('BEGIN');
      await reten.query('SELECT 1 FROM temporada_pedidos WHERE id = $1 FOR UPDATE', [p.id]);
      intentos = Array.from({ length: 5 }, () => mover(p, 'agendado', 'en_preparacion'));
      await new Promise((ok) => setTimeout(ok, 400));
      await reten.query('COMMIT');
    } finally {
      reten.release();
    }
    const r = await Promise.allSettled(intentos);
    assert.strictEqual(r.filter((x) => x.status === 'fulfilled').length, 1, r.map((x) => x.reason?.codigo || 'ok').join(','));
    assert.ok(r.filter((x) => x.status === 'rejected').every((x) => x.reason.codigo === 'ENTREGA_CAMBIO'));
    assert.strictEqual((await bitacora(p.id)).length, 1);
  });

  await t('B24. contador por ventana: entregados contra pendientes, sin contar cancelados; la base rechaza un paso inventado', async () => {
    // Ventana de las 13:00: 3 pedidos; uno entregado, uno listo, uno cancelado.
    const alta = async () => detEnt((await T.crearPedidoTemporada(kEnt, pedido({ platillos: 1, ventana: '13:00' }))).pedido.folio);
    const [e1, e2, e3] = [await alta(), await alta(), await alta()];
    for (const [de, a] of [['agendado', 'en_preparacion'], ['en_preparacion', 'listo'], ['listo', 'entregado']]) await mover(e1, de, a);
    for (const [de, a] of [['agendado', 'en_preparacion'], ['en_preparacion', 'listo']]) await mover(e2, de, a);
    await T.cancelarPedidoTemporada(A, e3.id, { actorId: ADMIN_A });
    const d = await T.pedidosDeCampana(A, CENT.id);
    const trece = d.ventanas.find((v) => v.inicio === '13:00');
    assert.deepStrictEqual(trece.entrega, { agendado: 0, en_preparacion: 0, listo: 1, entregado: 1, entregados: 1, pendientes: 1 });
    const nueve = d.ventanas.find((v) => v.inicio === '09:00');
    assert.deepStrictEqual([nueve.entrega.entregados, nueve.entrega.pendientes], [0, 0]);
    await assert.rejects(pool.query(`UPDATE temporada_pedidos SET estado_entrega = 'perdido' WHERE id = $1`, [e2.id]),
      (e) => e.code === '23514');
  });

  // ── Captura y edición desde el panel (punto 3) ──
  const porTel = (extra = {}) => ({
    nombre: 'Pedro Teléfono', telefono: '878 111 2233', platillos: 2, modalidad: 'recoger', ventana: '09:00',
    claveEnvio: randomUUID(), ...extra,
  });
  const crearP = (campanaId, extra = {}, actor = ADMIN_A, neg = A) => T.crearPedidoPanel(neg, campanaId, porTel(extra), { actorId: actor });
  const filaDe = async (campanaId, id) => (await T.pedidosDeCampana(A, campanaId)).pedidos.find((p) => p.id === id);
  // Lo que ve la página al abrir «Editar»: así manda `antes`.
  const visto = (p) => ({ nombre: p.nombre, telefono: p.telefono, platillos: p.platillos, ventana: p.ventana.inicio,
    modalidad: p.modalidad, direccion: p.direccion, referencias: p.referencias, notas: p.notas });
  const editar = async (campanaId, id, cambios, { exceder, excedente, actor = ADMIN_A, neg = A, antes } = {}) => {
    const p = await filaDe(campanaId, id);
    const v = visto(p);
    return T.editarPedidoTemporada(neg, id, { ...v, ...cambios, antes: antes || v, exceder, excedente }, { actorId: actor });
  };

  await t('B25. nuevo pedido desde el panel: respeta el cupo, pasarlo exige «exceder» y queda anotado; folio seguido y sin duplicar', async () => {
    // Apagada y ya cerrada: el administrador captura igual (la llamada llegó tarde).
    const kCap = clave('captura');
    const CCAP = await T.guardarCampana(A, null, base({ clave: kCap, precio: 229, cupo_platillos: 10, cupo_domicilio: 1,
      max_platillos_pedido: 6, activa: false, cierra_en: `${await enDias(-1)}T20:00` }));
    const envio = randomUUID();
    const r1 = await crearP(CCAP.id, { platillos: 4, modalidad: 'domicilio', direccion: 'Calle Hidalgo 12, Centro', claveEnvio: envio });
    assert.deepStrictEqual([r1.repetido, r1.pedido.folio, r1.excedio], [false, 'TG-001', []]);
    // Doble clic / red caída: el mismo envío devuelve el mismo pedido y no aparta otro cupo.
    const r1b = await crearP(CCAP.id, { platillos: 4, modalidad: 'domicilio', direccion: 'Calle Hidalgo 12, Centro', claveEnvio: envio });
    assert.deepStrictEqual([r1b.repetido, r1b.pedido.id], [true, r1.pedido.id]);
    assert.strictEqual((await usoVentana(CCAP.id, '09:00')).pedidos, 1);
    // Segundo domicilio de las 9: el horario ya tiene su único domicilio.
    const dom = await lanza('CUPO_EXCEDIDO', () => crearP(CCAP.id, { modalidad: 'domicilio', direccion: 'Calle Juárez 5, Centro' }));
    assert.deepStrictEqual(dom.extra.excesos.map((x) => x.codigo), ['DOMICILIO_LLENO']);
    assert.strictEqual(dom.extra.domiciliosLibres, 0);
    // 7 para recoger: más que el máximo por pedido (6) y que lo libre (10 − 4 = 6).
    const siete = await lanza('CUPO_EXCEDIDO', () => crearP(CCAP.id, { platillos: 7 }));
    assert.deepStrictEqual(siete.extra.excesos.map((x) => x.codigo), ['DEMASIADOS_PLATILLOS', 'VENTANA_LLENA']);
    assert.strictEqual(siete.extra.libres, 6);
    assert.match(siete.message, /quedan 6 de 10 platillos/);
    assert.strictEqual((await usoVentana(CCAP.id, '09:00')).pedidos, 1, 'un 409 no debe dejar nada agendado');
    // Con «exceder» entra, y la bitácora dice quién lo pasó y qué cupo.
    const r2 = await crearP(CCAP.id, { platillos: 7, exceder: true });
    assert.deepStrictEqual([r2.pedido.folio, r2.excedio], ['TG-002', ['DEMASIADOS_PLATILLOS', 'VENTANA_LLENA']]);
    assert.strictEqual((await usoVentana(CCAP.id, '09:00')).platillos, 11);
    const p2 = await filaDe(CCAP.id, r2.pedido.id);
    assert.deepStrictEqual([p2.origen, p2.creado_por, p2.precio, p2.entrega.estado, p2.pago.estado], ['panel', 'Admin A', 229, 'agendado', 'sin_pago']);
    assert.deepStrictEqual((await bitacora(r2.pedido.id)).map((x) => [x.accion, x.usuario_id, x.detalle.excedio]),
      [['creado_panel', ADMIN_A, ['DEMASIADOS_PLATILLOS', 'VENTANA_LLENA']]]);
    // Lo de la página sigue diciendo «formulario» y sin quién.
    const kPub = clave('captura-pub');
    const CPUB = await T.guardarCampana(A, null, base({ clave: kPub }));
    const { pedido: pub } = await T.crearPedidoTemporada(kPub, pedido());
    const r3 = await crearP(CPUB.id, {});
    const { pedido: pub2 } = await T.crearPedidoTemporada(kPub, pedido());
    assert.deepStrictEqual([pub.folio, r3.pedido.folio, pub2.folio], ['TG-001', 'TG-002', 'TG-003'], 'la página y el panel comparten la secuencia');
    const lista = (await T.pedidosDeCampana(A, CPUB.id)).pedidos;
    assert.deepStrictEqual(lista.map((p) => [p.folio, p.origen, p.creado_por]),
      [['TG-001', 'formulario', null], ['TG-002', 'panel', 'Admin A'], ['TG-003', 'formulario', null]]);
    // Lo que no se deja.
    await lanza('NO_ENCONTRADA', () => crearP(CCAP.id, {}, ADMIN_B, B));
    await lanza('SIN_USUARIO', () => T.crearPedidoPanel(A, CCAP.id, porTel()));
    await lanza('VENTANA_INVALIDA', () => crearP(CCAP.id, { ventana: '09:30' }));
    await lanza('VENTANA_INVALIDA', () => crearP(CCAP.id, { ventana: '16:00' }));
    await lanza('ENVIO_INVALIDO', () => crearP(CCAP.id, { claveEnvio: 'corta' }));
    const sinNombre = await lanza('NOMBRE_INVALIDO', () => crearP(CCAP.id, { nombre: 'x' }));
    assert.match(sinNombre.message, /nombre del cliente/, 'el panel le habla a quien captura');
    await lanza('DIRECCION_INVALIDA', () => crearP(CCAP.id, { modalidad: 'domicilio', direccion: '' }));
    const soloRecoger = await T.guardarCampana(A, null, base({ clave: clave('captura-rec'), acepta_domicilio: false, cupo_domicilio: 0 }));
    await lanza('MODALIDAD_NO_DISPONIBLE', () => crearP(soloRecoger.id, { modalidad: 'domicilio', direccion: 'Calle Hidalgo 12, Centro', exceder: true }));
    // Y la página pública no cambió: sigue sin dejar pasar el cupo.
    await lanza('NO_DISPONIBLE', () => T.crearPedidoTemporada(kCap, pedido()));
  });

  await t('B26. a la vez: la página y tres tabletas piden el último lugar → entra uno solo', async () => {
    const kCarrera = clave('captura-carrera');
    const CC = await T.guardarCampana(A, null, base({ clave: kCarrera, cupo_platillos: 10, max_platillos_pedido: 10 }));
    await crearP(CC.id, { platillos: 8, ventana: '11:00' });
    const reten = await pool.connect();
    let intentos;
    try {
      // Se retiene la campaña: todos los intentos esperan y miden después.
      await reten.query('BEGIN');
      await reten.query('SELECT 1 FROM temporada_campanas WHERE id = $1 FOR UPDATE', [CC.id]);
      intentos = [
        T.crearPedidoTemporada(kCarrera, pedido({ platillos: 2, ventana: '11:00' })),
        ...Array.from({ length: 3 }, () => crearP(CC.id, { platillos: 2, ventana: '11:00' })),
      ];
      await new Promise((ok) => setTimeout(ok, 400));
      await reten.query('COMMIT');
    } finally {
      reten.release();
    }
    const r = await Promise.allSettled(intentos);
    assert.strictEqual(r.filter((x) => x.status === 'fulfilled').length, 1, r.map((x) => x.reason?.codigo || x.reason?.code || 'ok').join(','));
    assert.ok(r.filter((x) => x.status === 'rejected').every((x) => ['VENTANA_LLENA', 'CUPO_EXCEDIDO'].includes(x.reason.codigo)),
      r.map((x) => x.reason?.codigo || x.reason?.code || 'ok').join(','));
    assert.strictEqual((await usoVentana(CC.id, '11:00')).platillos, 10);
  });

  let CED = null;
  await t('B27. editar: cantidad, horario, tipo, dirección y notas sin cancelar; el cupo se mide sin contarse a sí mismo', async () => {
    CED = await T.guardarCampana(A, null, base({ clave: clave('editar'), precio: 229, cupo_platillos: 10, cupo_domicilio: 1, max_platillos_pedido: 8 }));
    const { pedido: { id: p1 } } = await crearP(CED.id, { platillos: 4, ventana: '09:00' });
    const { pedido: { id: p2 } } = await crearP(CED.id, { platillos: 5, ventana: '10:00', nombre: 'Lucía Llamada' });
    // Subir en su mismo horario: lo propio no cuenta dos veces (quedan 10, no 6).
    let r = await editar(CED.id, p1, { platillos: 7 });
    assert.deepStrictEqual([r.cambios, r.excedio], [{ platillos: { de: 4, a: 7 } }, []]);
    // Moverlo a las 10 con 8: allá quedan 5 → advierte; con «exceder», pasa y se anota.
    const lleno = await lanza('CUPO_EXCEDIDO', () => editar(CED.id, p1, { ventana: '10:00', platillos: 8 }));
    assert.deepStrictEqual(lleno.extra.excesos.map((x) => x.codigo), ['VENTANA_LLENA']);
    assert.strictEqual((await filaDe(CED.id, p1)).ventana.inicio, '09:00', 'un 409 no debe mover el pedido');
    r = await editar(CED.id, p1, { ventana: '10:00', platillos: 8 }, { exceder: true });
    assert.deepStrictEqual([r.cambios.ventana, r.excedio], [{ de: '09:00', a: '10:00' }, ['VENTANA_LLENA']]);
    let d = await T.pedidosDeCampana(A, CED.id);
    const ventana = (h) => d.ventanas.find((v) => v.inicio === h);
    assert.deepStrictEqual([ventana('09:00').platillos, ventana('10:00').platillos], [0, 13], 'las barras se recalculan');
    assert.strictEqual(d.pedidos.find((x) => x.id === p1).ventana.fin, '11:00');
    // Las 10 quedaron con 13 de 10. Bajar p2 de 5 a 3 no advierte aunque solo «queden» 2; subirlo a 4 sí.
    r = await editar(CED.id, p2, { platillos: 3 });
    assert.deepStrictEqual(r.excedio, []);
    await lanza('CUPO_EXCEDIDO', () => editar(CED.id, p2, { platillos: 4 }));
    r = await editar(CED.id, p2, { notas: 'Sin cebolla' });
    assert.deepStrictEqual(r.cambios, { notas: { de: null, a: 'Sin cebolla' } });
    // A domicilio con dirección; el único domicilio del horario lo ocupa p1…
    r = await editar(CED.id, p1, { modalidad: 'domicilio', direccion: 'Av. Carranza 300, Centro', referencias: 'Portón negro' });
    assert.deepStrictEqual(Object.keys(r.cambios).sort(), ['direccion', 'modalidad', 'referencias']);
    const dom = await lanza('CUPO_EXCEDIDO', () => editar(CED.id, p2, { modalidad: 'domicilio', direccion: 'Calle Allende 8, Centro' }));
    assert.deepStrictEqual(dom.extra.excesos.map((x) => x.codigo), ['DOMICILIO_LLENO']);
    // …y p1 no choca consigo mismo al corregir su dirección o su cantidad.
    r = await editar(CED.id, p1, { direccion: 'Av. Carranza 302, Centro', platillos: 5 });
    assert.deepStrictEqual(r.excedio, []);
    // Más que el máximo por pedido: advierte solo si sube.
    await lanza('CUPO_EXCEDIDO', () => editar(CED.id, p1, { platillos: 9 }, { exceder: false }));
    // Pasa a recoger: la dirección y las referencias se borran (y queda de qué a qué).
    r = await editar(CED.id, p1, { modalidad: 'recoger' });
    assert.deepStrictEqual(r.cambios.direccion, { de: 'Av. Carranza 302, Centro', a: null });
    assert.deepStrictEqual(r.cambios.referencias, { de: 'Portón negro', a: null });
    d = await T.pedidosDeCampana(A, CED.id);
    const f1 = d.pedidos.find((x) => x.id === p1);
    assert.deepStrictEqual([f1.modalidad, f1.direccion, f1.referencias, f1.platillos, f1.pago.total], ['recoger', null, null, 5, 1145]);
    assert.strictEqual(f1.editado.por, 'Admin A');
    assert.ok(f1.editado.en, 'sin hora de la edición');
    // Guardar sin cambiar nada no anota nada.
    const antes = (await bitacora(p1)).length;
    r = await editar(CED.id, p1, { telefono: '(878) 111-2233' });
    assert.deepStrictEqual(r.cambios, {}, 'el mismo teléfono con otro formato no es un cambio');
    assert.strictEqual((await bitacora(p1)).length, antes);
    // La bitácora guarda cada cambio con su valor anterior y quién.
    const eds = (await bitacora(p1)).filter((x) => x.accion === 'editado');
    assert.strictEqual(eds.length, 5);
    assert.ok(eds.every((x) => x.usuario_id === ADMIN_A));
    assert.deepStrictEqual(eds[1].detalle.cambios, { platillos: { de: 7, a: 8 }, ventana: { de: '09:00', a: '10:00' } });
    assert.deepStrictEqual(eds[1].detalle.excedio, ['VENTANA_LLENA']);
    const h = await T.historialPedidoTemporada(A, p1);
    assert.deepStrictEqual(h.eventos.map((e) => e.accion), ['creado_panel', 'editado', 'editado', 'editado', 'editado', 'editado']);
    assert.ok(h.eventos.every((e) => e.por === 'Admin A' && e.en));
    assert.deepStrictEqual([h.origen, h.creado_por], ['panel', 'Admin A']);
    await lanza('NO_ENCONTRADO', () => T.historialPedidoTemporada(B, p1));
  });

  await t('B28. editar: lo que no se deja (otro lo cambió, cancelado, otro negocio, horario inventado) y pagado de más pide confirmar', async () => {
    const { pedido: { id: p } } = await crearP(CED.id, { platillos: 3, ventana: '12:00' });
    const fila = await filaDe(CED.id, p);
    // Otra tableta cambió las notas mientras este lo tenía abierto: no se pisa.
    await editar(CED.id, p, { notas: 'Lo cambió la otra tableta' });
    const otro = await lanza('EDITADO_POR_OTRO', () => editar(CED.id, p, { platillos: 2 }, { antes: visto(fila) }));
    assert.match(otro.message, /Alguien más cambió/);
    assert.strictEqual((await filaDe(CED.id, p)).platillos, 3);
    await lanza('EDICION_INVALIDA', () => T.editarPedidoTemporada(A, p, { ...visto(fila), platillos: 2 }, { actorId: ADMIN_A }));
    await lanza('SIN_USUARIO', () => editar(CED.id, p, { platillos: 2 }, { actor: null }));
    await lanza('NO_ENCONTRADO', () => editar(CED.id, p, { platillos: 2 }, { actor: ADMIN_B, neg: B }));
    await lanza('VENTANA_INVALIDA', () => editar(CED.id, p, { ventana: '12:30' }));
    await lanza('PLATILLOS_INVALIDOS', () => editar(CED.id, p, { platillos: 0 }));
    await lanza('DIRECCION_INVALIDA', () => editar(CED.id, p, { modalidad: 'domicilio', direccion: 'x' }));
    // Pagó 3 × 229 = 687; bajar a 2 (458) deja 229 de más: el servidor hace la cuenta y pide confirmarlo.
    await T.registrarPagoTemporada(A, p, { monto: 687, metodo: 'efectivo' }, { actorId: ADMIN_A });
    const mas = await lanza('QUEDA_PAGADO_DE_MAS', () => editar(CED.id, p, { platillos: 2 }));
    assert.deepStrictEqual([mas.extra.pagado, mas.extra.total, mas.extra.excedente], [687, 458, 229]);
    assert.match(mas.message, /ya pagó \$687\. Con 2 platillos el total baja a \$458: quedarían \$229 pagados de más/);
    const r = await editar(CED.id, p, { platillos: 2 }, { excedente: true });
    assert.deepStrictEqual(r.cambios, { platillos: { de: 3, a: 2 } });
    const pago = (await filaDe(CED.id, p)).pago;
    assert.deepStrictEqual([pago.total, pago.pagado, pago.excedente, pago.estado], [458, 687, 229, 'pagado']);
    // Subir no pide nada de eso.
    await editar(CED.id, p, { platillos: 3 });
    // Cancelado: ya no se edita.
    await T.cancelarPedidoTemporada(A, p, { actorId: ADMIN_A });
    await lanza('PEDIDO_CANCELADO', () => editar(CED.id, p, { platillos: 1 }));
  });

  await t('B29. a la vez: dos tabletas editan el mismo pedido → entra una; dos pedidos al último lugar → entra uno', async () => {
    const k29 = clave('editar-carrera');
    const C29 = await T.guardarCampana(A, null, base({ clave: k29, cupo_platillos: 10, max_platillos_pedido: 10 }));
    // Mismo pedido, mismo `antes`: la segunda ve que ya cambió.
    const { pedido: { id: p } } = await crearP(C29.id, { platillos: 2, ventana: '09:00' });
    const v = visto(await filaDe(C29.id, p));
    let reten = await pool.connect(), intentos;
    try {
      await reten.query('BEGIN');
      await reten.query('SELECT 1 FROM temporada_pedidos WHERE id = $1 FOR UPDATE', [p]);
      intentos = [3, 4].map((n) => T.editarPedidoTemporada(A, p, { ...v, platillos: n, antes: v }, { actorId: ADMIN_A }));
      await new Promise((ok) => setTimeout(ok, 400));
      await reten.query('COMMIT');
    } finally {
      reten.release();
    }
    let r = await Promise.allSettled(intentos);
    assert.strictEqual(r.filter((x) => x.status === 'fulfilled').length, 1, r.map((x) => x.reason?.codigo || 'ok').join(','));
    assert.ok(r.filter((x) => x.status === 'rejected').every((x) => x.reason.codigo === 'EDITADO_POR_OTRO'));
    assert.strictEqual((await bitacora(p)).filter((x) => x.accion === 'editado').length, 1);
    // Dos pedidos de las 10 se mueven a la vez al único lugar de las 9 (quedan 7 libres y cada uno lleva 4).
    await crearP(C29.id, { platillos: 1, ventana: '09:00' });
    const { pedido: { id: a } } = await crearP(C29.id, { platillos: 4, ventana: '10:00' });
    const { pedido: { id: b } } = await crearP(C29.id, { platillos: 4, ventana: '10:00' });
    const [va, vb] = [visto(await filaDe(C29.id, a)), visto(await filaDe(C29.id, b))];
    const libresAntes = 10 - (await usoVentana(C29.id, '09:00')).platillos;
    assert.ok(libresAntes >= 4 && libresAntes < 8, `preparación: quedan ${libresAntes}`);
    reten = await pool.connect();
    try {
      // Se retienen los dos pedidos: las dos ediciones miden el cupo al mismo tiempo si nada las ordena.
      await reten.query('BEGIN');
      await reten.query('SELECT 1 FROM temporada_pedidos WHERE id = ANY($1::bigint[]) FOR UPDATE', [[a, b]]);
      intentos = [[a, va], [b, vb]].map(([id, x]) => T.editarPedidoTemporada(A, id, { ...x, ventana: '09:00', antes: x }, { actorId: ADMIN_A }));
      await new Promise((ok) => setTimeout(ok, 400));
      await reten.query('COMMIT');
    } finally {
      reten.release();
    }
    r = await Promise.allSettled(intentos);
    assert.strictEqual(r.filter((x) => x.status === 'fulfilled').length, 1, r.map((x) => x.reason?.codigo || x.reason?.code || 'ok').join(','));
    assert.ok(r.filter((x) => x.status === 'rejected').every((x) => x.reason.codigo === 'CUPO_EXCEDIDO'));
    assert.ok((await usoVentana(C29.id, '09:00')).platillos <= 10, 'se pasó el cupo sin «exceder»');
  });

  // ── Totales en pesos (punto 4) ──
  await t('B30. totales: venta de confirmados, cobrado sin anulados, por cobrar y por devolver; un cancelado no debe nada', async () => {
    const C30 = await T.guardarCampana(A, null, base({ clave: clave('totales'), precio: 229 }));
    const tot = async (id = C30.id) => (await T.pedidosDeCampana(A, id)).totales;
    assert.deepStrictEqual(await tot(), { venta: 0, cobrado: 0, porCobrar: 0, porDevolver: 0, conSaldo: 0, sinPrecio: 0 });
    const pagar = (id, monto, metodo = 'efectivo') => T.registrarPagoTemporada(A, id, { monto, metodo }, { actorId: ADMIN_A });
    const alta = async (platillos) => (await crearP(C30.id, { platillos })).pedido.id;
    const [p1, p2, p3, p4, p5, p6] = [await alta(2), await alta(3), await alta(1), await alta(3), await alta(1), await alta(2)];
    await pagar(p1, 458);
    await pagar(p2, '114.50', 'transferencia');
    const { pagoId: mal } = await pagar(p3, 229, 'tarjeta');
    await T.anularPagoTemporada(A, mal, { motivo: 'Se cobró en otro pedido' }, { actorId: ADMIN_A });
    await pagar(p3, '0.10'); await pagar(p3, '0.20');
    await pagar(p4, 687);
    await editar(C30.id, p4, { platillos: 1 }, { excedente: true });
    const { pagoId: delCancelado } = await pagar(p5, 100);
    await T.cancelarPedidoTemporada(A, p5, { actorId: ADMIN_A });
    await T.cancelarPedidoTemporada(A, p6, { actorId: ADMIN_A });
    assert.deepStrictEqual(await tot(), { venta: 1603, cobrado: 1359.8, porCobrar: 801.2, porDevolver: 558, conSaldo: 2, sinPrecio: 0 });
    // Cada pedido trae lo suyo, para la lista y el Excel.
    const d = await T.pedidosDeCampana(A, C30.id);
    const de = (id) => d.pedidos.find((p) => p.id === id).pago;
    assert.deepStrictEqual([de(p3).pagado, de(p3).saldo, de(p3).porDevolver], [0.3, 228.7, 0]);
    assert.deepStrictEqual([de(p4).total, de(p4).saldo, de(p4).porDevolver], [229, 0, 458]);
    assert.deepStrictEqual([de(p5).saldo, de(p5).faltaAnticipo, de(p5).porDevolver, de(p5).pagado], [0, 0, 100, 100], 'un cancelado no debe nada');
    assert.deepStrictEqual([de(p6).saldo, de(p6).porDevolver], [0, 0]);
    // Devolverle al cancelado (anular su pago) lo saca de lo cobrado y de lo por devolver.
    await T.anularPagoTemporada(A, delCancelado, { motivo: 'Se le devolvió' }, { actorId: ADMIN_A });
    assert.deepStrictEqual(await tot(), { venta: 1603, cobrado: 1259.8, porCobrar: 801.2, porDevolver: 458, conSaldo: 2, sinPrecio: 0 });
    // Subir el precio de la campaña no mueve la venta ya agendada (precio congelado).
    await T.guardarCampana(A, C30.id, base({ clave: clave('totales'), precio: 300 }));
    assert.strictEqual((await tot()).venta, 1603);
    // Sin precio no hay venta que mostrar.
    const kSin = clave('totales-sin');
    const cSin = await T.guardarCampana(A, null, base({ clave: kSin, precio: null }));
    await T.crearPedidoTemporada(kSin, pedido());
    assert.deepStrictEqual(await tot(cSin.id), { venta: null, cobrado: 0, porCobrar: 0, porDevolver: 0, conSaldo: 0, sinPrecio: 0 });
  });
}

// ═══ C. Servidor real: CORS, rutas y permisos ═══════════════════════════════
if (PARTES.has('C')) {
  console.log('\n── C. Servidor real');
  const k = clave('http');
  await T.guardarCampana(A, null, base({ clave: k }));
  const servidor = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 120000 });
  const http = async (metodo, ruta, { cookie, cuerpo, origen, cabeceras = {} } = {}) => {
    const headers = { ...cabeceras };
    if (cookie) headers.Cookie = `xabor_sesion=${encodeURIComponent(cookie)}`;
    if (origen) headers.Origin = origen;
    if (cuerpo !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(servidor.base + ruta, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
    const texto = await r.text();
    let datos = null; try { datos = JSON.parse(texto); } catch { /* HTML */ }
    return { status: r.status, datos, texto, h: r.headers };
  };
  try {
    await t('C1. CORS: www.mapolato.com pasa la verificación previa; otro sitio no recibe permiso', async () => {
      const pre = await http('OPTIONS', `/api/temporada/${k}/pedidos`, { origen: 'https://www.mapolato.com',
        cabeceras: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
      assert.strictEqual(pre.status, 204);
      assert.strictEqual(pre.h.get('access-control-allow-origin'), 'https://www.mapolato.com');
      assert.match(pre.h.get('access-control-allow-headers') || '', /content-type/i);
      const ajeno = await http('OPTIONS', `/api/temporada/${k}/pedidos`, { origen: 'https://sitio-ajeno.example' });
      assert.strictEqual(ajeno.h.get('access-control-allow-origin'), null);
      const get = await http('GET', `/api/temporada/${k}`, { origen: 'https://mapolato.com' });
      assert.strictEqual(get.status, 200);
      assert.strictEqual(get.h.get('access-control-allow-origin'), 'https://mapolato.com');
      assert.strictEqual(get.h.get('cache-control'), 'no-store');
      assert.strictEqual(get.h.get('access-control-allow-credentials'), null, 'nunca con credenciales');
    });

    await t('C2. GET público: horarios sin datos internos (sin ids, cupos ni negocio_id)', async () => {
      const r = await http('GET', `/api/temporada/${k}`);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.datos.ventanas.length, 7);
      for (const prohibido of ['negocio_id', 'negocioId', 'cupo_platillos', 'cupo_domicilio', '"id"']) {
        assert.ok(!r.texto.includes(prohibido), `expone ${prohibido}`);
      }
      assert.strictEqual((await http('GET', `/api/temporada/${clave('apagada')}`)).status, 404);
      assert.strictEqual((await http('GET', `/api/temporada/..%2F..%2Fetc`)).status, 404);
    });

    await t('C3. POST público: 201 con folio; el mismo envío otra vez es 200 y el mismo folio', async () => {
      const p = pedido({ ventana: '14:00', platillos: 3, modalidad: 'domicilio', direccion: 'Calle Morelos 100, Centro' });
      const r1 = await http('POST', `/api/temporada/${k}/pedidos`, { cuerpo: p, origen: 'https://www.mapolato.com' });
      assert.strictEqual(r1.status, 201, r1.texto);
      assert.strictEqual(r1.datos.pedido.folio, 'TG-001');
      assert.strictEqual(r1.h.get('access-control-allow-origin'), 'https://www.mapolato.com');
      const r2 = await http('POST', `/api/temporada/${k}/pedidos`, { cuerpo: p });
      assert.strictEqual(r2.status, 200);
      assert.deepStrictEqual([r2.datos.pedido.folio, r2.datos.repetido], ['TG-001', true]);
      const malo = await http('POST', `/api/temporada/${k}/pedidos`, { cuerpo: { ...p, claveEnvio: randomUUID(), telefono: '1' } });
      assert.deepStrictEqual([malo.status, malo.datos.codigo], [400, 'TELEFONO_INVALIDO']);
      assert.ok(!/at |\.js:/.test(malo.texto), 'sin stack en la respuesta');
    });

    await t('C4. administración: sin sesión 401, staff 403, admin de B no ve la campaña de A', async () => {
      const lista = await http('GET', '/api/admin/temporada/campanas');
      assert.strictEqual(lista.status, 401);
      const staff = await http('GET', '/api/admin/temporada/campanas', { cookie: COOKIES.staffA });
      assert.strictEqual(staff.status, 403);
      const admin = await http('GET', '/api/admin/temporada/campanas', { cookie: COOKIES.adminA });
      assert.strictEqual(admin.status, 200);
      const mia = admin.datos.campanas.find((c) => c.clave === k);
      assert.ok(mia, 'el admin de A ve su campaña');
      const ajena = await http('GET', `/api/admin/temporada/campanas/${mia.id}/pedidos`, { cookie: COOKIES.adminB });
      assert.strictEqual(ajena.status, 404);
      const det = await http('GET', `/api/admin/temporada/campanas/${mia.id}/pedidos`, { cookie: COOKIES.adminA });
      assert.strictEqual(det.status, 200);
      const p = det.datos.pedidos[0];
      const canB = await http('POST', `/api/admin/temporada/pedidos/${p.id}/cancelar`, { cookie: COOKIES.adminB, cuerpo: {} });
      assert.strictEqual(canB.status, 404);
      const canStaff = await http('POST', `/api/admin/temporada/pedidos/${p.id}/cancelar`, { cookie: COOKIES.staffA, cuerpo: {} });
      assert.strictEqual(canStaff.status, 403);
      const crearStaff = await http('POST', '/api/admin/temporada/campanas', { cookie: COOKIES.staffA, cuerpo: base({ clave: clave('staff') }) });
      assert.strictEqual(crearStaff.status, 403);
      const canA = await http('POST', `/api/admin/temporada/pedidos/${p.id}/cancelar`, { cookie: COOKIES.adminA, cuerpo: {} });
      assert.strictEqual(canA.status, 200);
      // El negocio sale de la sesión: un negocio_id en el cuerpo no cambia nada.
      const conIntruso = await http('POST', '/api/admin/temporada/campanas',
        { cookie: COOKIES.adminA, cuerpo: { ...base({ clave: clave('intruso') }), negocio_id: B } });
      assert.strictEqual(conIntruso.status, 201);
      const dueno = await q1(`SELECT negocio_id FROM temporada_campanas WHERE clave = $1`, [clave('intruso')]);
      assert.strictEqual(dueno.negocio_id, A);
    });

    await t('C5. /temporada sirve la página de administración sin datos', async () => {
      const r = await http('GET', '/temporada');
      assert.strictEqual(r.status, 200);
      assert.match(r.texto, /Pedidos de temporada/);
      assert.ok(!r.texto.includes(k), 'la página no trae datos del negocio');
    });

    await t('C6. pagos por HTTP: sin sesión 401, staff 403, admin de B 404; el de A registra y anula', async () => {
      const p = pedido({ ventana: '15:00', platillos: 2, claveEnvio: randomUUID() });
      const alta = await http('POST', `/api/temporada/${k}/pedidos`, { cuerpo: p });
      assert.strictEqual(alta.status, 201, alta.texto);
      const mia = (await http('GET', '/api/admin/temporada/campanas', { cookie: COOKIES.adminA })).datos.campanas.find((c) => c.clave === k);
      const det = await http('GET', `/api/admin/temporada/campanas/${mia.id}/pedidos`, { cookie: COOKIES.adminA });
      const ped = det.datos.pedidos.find((x) => x.folio === alta.datos.pedido.folio);
      assert.deepStrictEqual([ped.pago.total, ped.pago.estado], [500, 'sin_pago']);
      const ruta = `/api/admin/temporada/pedidos/${ped.id}/pagos`;
      const cuerpo = { monto: 200, metodo: 'efectivo' };
      assert.strictEqual((await http('POST', ruta, { cuerpo })).status, 401);
      assert.strictEqual((await http('POST', ruta, { cookie: COOKIES.staffA, cuerpo })).status, 403);
      assert.strictEqual((await http('POST', ruta, { cookie: COOKIES.adminB, cuerpo })).status, 404);
      const ok = await http('POST', ruta, { cookie: COOKIES.adminA, cuerpo });
      assert.strictEqual(ok.status, 201, ok.texto);
      assert.deepStrictEqual([ok.datos.pago.estado, ok.datos.pago.saldo], ['anticipo', 300]);
      const excede = await http('POST', ruta, { cookie: COOKIES.adminA, cuerpo: { monto: 301, metodo: 'tarjeta' } });
      assert.deepStrictEqual([excede.status, excede.datos.codigo], [409, 'PAGO_EXCEDE']);
      const anular = `/api/admin/temporada/pagos/${ok.datos.pagoId}/anular`;
      assert.strictEqual((await http('POST', anular, { cookie: COOKIES.staffA, cuerpo: { motivo: 'prueba' } })).status, 403);
      assert.strictEqual((await http('POST', anular, { cookie: COOKIES.adminB, cuerpo: { motivo: 'prueba' } })).status, 404);
      assert.strictEqual((await http('POST', anular, { cookie: COOKIES.adminA, cuerpo: { motivo: 'prueba de anulación' } })).status, 200);
      // Lo público no cambió de forma: sin pagos ni montos internos.
      const pub = await http('GET', `/api/temporada/${k}`);
      for (const prohibido of ['pago', 'anticipo', 'precio_unitario']) assert.ok(!pub.texto.includes(prohibido), `expone ${prohibido}`);
    });

    await t('C7. entrega por HTTP: sin sesión 401, staff 403, admin de B 404; el de A avanza y otro paso viejo es 409', async () => {
      const alta = await http('POST', `/api/temporada/${k}/pedidos`, { cuerpo: pedido({ ventana: '14:00', platillos: 1, claveEnvio: randomUUID() }) });
      assert.strictEqual(alta.status, 201, alta.texto);
      for (const prohibido of ['entrega', 'estado_entrega']) assert.ok(!alta.texto.includes(prohibido), `el alta pública expone ${prohibido}`);
      const mia = (await http('GET', '/api/admin/temporada/campanas', { cookie: COOKIES.adminA })).datos.campanas.find((c) => c.clave === k);
      const det = await http('GET', `/api/admin/temporada/campanas/${mia.id}/pedidos`, { cookie: COOKIES.adminA });
      const ped = det.datos.pedidos.find((x) => x.folio === alta.datos.pedido.folio);
      assert.strictEqual(ped.entrega.estado, 'agendado');
      const ruta = `/api/admin/temporada/pedidos/${ped.id}/entrega`;
      const cuerpo = { desde: 'agendado', estado: 'en_preparacion' };
      assert.strictEqual((await http('POST', ruta, { cuerpo })).status, 401);
      assert.strictEqual((await http('POST', ruta, { cookie: COOKIES.staffA, cuerpo })).status, 403);
      assert.strictEqual((await http('POST', ruta, { cookie: COOKIES.adminB, cuerpo })).status, 404);
      const ok = await http('POST', ruta, { cookie: COOKIES.adminA, cuerpo });
      assert.deepStrictEqual([ok.status, ok.datos.estado_entrega], [200, 'en_preparacion'], ok.texto);
      const repetido = await http('POST', ruta, { cookie: COOKIES.adminA, cuerpo });
      assert.deepStrictEqual([repetido.status, repetido.datos.codigo, repetido.datos.estado_entrega], [409, 'ENTREGA_CAMBIO', 'en_preparacion']);
      const pub = await http('GET', `/api/temporada/${k}`);
      assert.ok(!/entrega|en_preparacion/.test(pub.texto), 'lo público expone la entrega');
    });

    await t('C8. captura y edición por HTTP: sin sesión 401, staff 403, admin de B 404; el de A agenda, edita y ve el historial', async () => {
      const mia = (await http('GET', '/api/admin/temporada/campanas', { cookie: COOKIES.adminA })).datos.campanas.find((c) => c.clave === k);
      const ruta = `/api/admin/temporada/campanas/${mia.id}/pedidos`;
      const cuerpo = { nombre: 'Rosa Llamada', telefono: '8782223344', platillos: 2, modalidad: 'recoger', ventana: '13:00', claveEnvio: randomUUID() };
      assert.strictEqual((await http('POST', ruta, { cuerpo })).status, 401);
      assert.strictEqual((await http('POST', ruta, { cookie: COOKIES.staffA, cuerpo })).status, 403);
      assert.strictEqual((await http('POST', ruta, { cookie: COOKIES.adminB, cuerpo })).status, 404);
      const alta = await http('POST', ruta, { cookie: COOKIES.adminA, cuerpo });
      assert.strictEqual(alta.status, 201, alta.texto);
      const otra = await http('POST', ruta, { cookie: COOKIES.adminA, cuerpo });
      assert.deepStrictEqual([otra.status, otra.datos.repetido, otra.datos.pedido.folio], [200, true, alta.datos.pedido.folio]);
      const lleno = await http('POST', ruta, { cookie: COOKIES.adminA, cuerpo: { ...cuerpo, claveEnvio: randomUUID(), platillos: 41 } });
      assert.deepStrictEqual([lleno.status, lleno.datos.codigo], [409, 'CUPO_EXCEDIDO'], lleno.texto);
      assert.deepStrictEqual(lleno.datos.excesos.map((x) => x.codigo), ['DEMASIADOS_PLATILLOS', 'VENTANA_LLENA']);
      const det = await http('GET', `/api/admin/temporada/campanas/${mia.id}/pedidos`, { cookie: COOKIES.adminA });
      const ped = det.datos.pedidos.find((x) => x.folio === alta.datos.pedido.folio);
      assert.deepStrictEqual([ped.origen, ped.creado_por, ped.editado], ['panel', 'Admin A', null]);
      const antes = { nombre: ped.nombre, telefono: ped.telefono, platillos: ped.platillos, ventana: ped.ventana.inicio,
        modalidad: ped.modalidad, direccion: ped.direccion, referencias: ped.referencias, notas: ped.notas };
      const editar = `/api/admin/temporada/pedidos/${ped.id}/editar`;
      const cambio = { ...antes, platillos: 3, notas: 'Llamó para pedir uno más', antes };
      assert.strictEqual((await http('POST', editar, { cuerpo: cambio })).status, 401);
      assert.strictEqual((await http('POST', editar, { cookie: COOKIES.staffA, cuerpo: cambio })).status, 403);
      assert.strictEqual((await http('POST', editar, { cookie: COOKIES.adminB, cuerpo: cambio })).status, 404);
      const ok = await http('POST', editar, { cookie: COOKIES.adminA, cuerpo: cambio });
      assert.strictEqual(ok.status, 200, ok.texto);
      assert.deepStrictEqual(Object.keys(ok.datos.cambios).sort(), ['notas', 'platillos']);
      const viejo = await http('POST', editar, { cookie: COOKIES.adminA, cuerpo: { ...cambio, platillos: 4 } });
      assert.deepStrictEqual([viejo.status, viejo.datos.codigo], [409, 'EDITADO_POR_OTRO']);
      const hist = `/api/admin/temporada/pedidos/${ped.id}/historial`;
      assert.strictEqual((await http('GET', hist)).status, 401);
      assert.strictEqual((await http('GET', hist, { cookie: COOKIES.staffA })).status, 403);
      assert.strictEqual((await http('GET', hist, { cookie: COOKIES.adminB })).status, 404);
      const h = await http('GET', hist, { cookie: COOKIES.adminA });
      assert.strictEqual(h.status, 200, h.texto);
      assert.deepStrictEqual(h.datos.eventos.map((e) => [e.accion, e.por]), [['creado_panel', 'Admin A'], ['editado', 'Admin A']]);
      assert.deepStrictEqual(h.datos.eventos[1].detalle.cambios.platillos, { de: 2, a: 3 });
      // Lo público no cambió: ni de dónde vino, ni quién, ni el nombre del cliente.
      const pub = await http('GET', `/api/temporada/${k}`);
      for (const prohibido of ['origen', 'creado_por', 'Rosa', 'editado']) assert.ok(!pub.texto.includes(prohibido), `expone ${prohibido}`);
    });

    await t('C9. totales por HTTP: el administrador los recibe hechos y cuadran con sus pedidos; lo público no los trae', async () => {
      const mia = (await http('GET', '/api/admin/temporada/campanas', { cookie: COOKIES.adminA })).datos.campanas.find((c) => c.clave === k);
      const det = await http('GET', `/api/admin/temporada/campanas/${mia.id}/pedidos`, { cookie: COOKIES.adminA });
      assert.strictEqual(det.status, 200, det.texto);
      const tt = det.datos.totales, conf = det.datos.pedidos.filter((p) => p.estado === 'confirmado');
      assert.ok(conf.length > 0, 'preparación: sin pedidos');
      const suma = (f) => conf.reduce((s, p) => s + T.aCentavos(f(p)), 0) / 100;
      assert.deepStrictEqual([tt.venta, tt.porCobrar, tt.conSaldo], [suma((p) => p.pago.total), suma((p) => p.pago.saldo), conf.filter((p) => p.pago.saldo > 0).length]);
      const pub = await http('GET', `/api/temporada/${k}`);
      assert.strictEqual(pub.status, 200);
      // Las llaves con comillas: «ventana» lleva «venta» adentro.
      for (const prohibido of ['"totales"', '"cobrado"', '"porCobrar"', '"porDevolver"', '"venta"', '"pagado"', '"saldo"']) {
        assert.ok(!pub.texto.includes(prohibido), `expone ${prohibido}`);
      }
    });
  } finally {
    servidor.detener();
  }
}

// ═══ D. Las páginas ═════════════════════════════════════════════════════════
if (PARTES.has('D')) {
  console.log('\n── D. Páginas (estático)');
  const sitio = readFileSync(join(__dirname, '..', 'sitio-mapolato', 'thanksgiving', 'index.html'), 'utf8');
  const admin = readFileSync(join(__dirname, '..', 'panel', 'temporada.html'), 'utf8');

  await t('D1. ninguna de las dos páginas inserta HTML con datos (sin innerHTML)', async () => {
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(sitio), 'sitio');
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(admin), 'admin');
    // Las hojas para la cocina se arman en otra ventana: tampoco con
    // document.write, se llame como se llame la variable del documento.
    assert.ok(!/\.write(?:ln)?\s*\(/.test(admin), 'admin: .write()');
  });

  await t('D1b. las hojas para la cocina imprimen solo pedidos confirmados', async () => {
    // Un solo filtro decide qué se imprime, y exige «confirmado».
    assert.match(admin, /function confirmadosDe\(horario\) \{[\s\S]{0,160}?p\.estado === 'confirmado' && \(!horario \|\| p\.ventana\.inicio === horario\)/);
    // Las tres hojas salen de ese filtro (la nota suelta lo vuelve a aplicar).
    for (const f of ['imprimirHojaCocina', 'imprimirRepartidor', 'imprimirNotas']) {
      const cuerpo = admin.slice(admin.indexOf(`function ${f}(`), admin.indexOf('mandarAImprimir(w', admin.indexOf(`function ${f}(`)));
      assert.ok(cuerpo.length > 0 && /confirmadosDe\(horario\)/.test(cuerpo), `${f} no usa confirmadosDe`);
    }
    assert.match(admin, /\(lista \|\| confirmadosDe\(horario\)\)\.filter\(\(p\) => p\.estado === 'confirmado'\)/);
    // La hoja del repartidor: solo domicilio.
    assert.match(admin, /confirmadosDe\(horario\)\.filter\(\(p\) => p\.modalidad === 'domicilio'\)/);
  });

  await t('D2. el sitio manda los datos solo a xabor.mx; ?api= vale únicamente en localhost', async () => {
    assert.match(sitio, /var API = 'https:\/\/xabor\.mx';/);
    assert.match(sitio, /if \(\/\^\(localhost\|127\\\.0\\\.0\\\.1\)\$\/\.test\(location\.hostname\)\)/);
  });

  await t('D3. las claves de SUCURSALES tienen el formato de la base', async () => {
    const claves = [...sitio.matchAll(/clave: '([^']+)'/g)].map((m) => m[1]);
    assert.ok(claves.length >= 1);
    for (const c of claves) assert.match(c, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  await t('D3b. la ciudad la elige el cliente: la página nunca la escoge sola y muestra todas', async () => {
    // Solo dos asignaciones: el arranque (null) y el clic del cliente. Una
    // tercera (p. ej. «la primera abierta») volvería a mandar pedidos de Acuña
    // a Piedras Negras sin que el cliente lo note.
    const asignaciones = [...sitio.matchAll(/\bsucursal\s*=(?!=)\s*([^;]+);/g)].map((m) => m[1].replace(/\s*\/\/.*$/, '').trim());
    assert.deepStrictEqual(asignaciones, ['null', 's.clave']);
    // Las tarjetas salen de SUCURSALES completas, no solo de las abiertas.
    assert.match(sitio, /SUCURSALES\.forEach\(function \(s\) \{\s*var est = estados\[s\.clave\];/);
    // Sin ciudad abierta elegida no hay botón de agendar a la vista.
    assert.match(sitio, /\$\('resto'\)\.hidden = est !== 'abierta';/);
  });

  await t('D4. la administración no abre /app (cada /app abierto imprime comandas)', async () => {
    assert.ok(!/['"]\/app['"#]/.test(admin));
  });

  await t('D5. el predeploy aplica la 135 una vez, después de la 133, y la reversa existe', async () => {
    const runner = readFileSync(join(__dirname, '..', 'scripts', 'predeploy-run-032-033.mjs'), 'utf8');
    const lista = runner.slice(runner.indexOf('const SCRIPTS = ['), runner.indexOf('];', runner.indexOf('const SCRIPTS = [')));
    const i133 = lista.indexOf("'133-xecador-revisiones-secuencia'");
    const i135 = lista.indexOf("'135-pedidos-temporada'");
    assert.ok(i133 > 0 && i135 > i133, 'la 135 no está en SCRIPTS o va antes de la 133');
    assert.strictEqual(lista.split("'135-pedidos-temporada'").length, 2, 'una sola vez');
    // Ninguna otra migración puede compartir el número.
    const mismas = readdirSync(join(__dirname, '..', 'migrations')).filter((f) => /^135_/.test(f));
    assert.deepStrictEqual(mismas.sort(), ['135_pedidos_temporada.sql', '135_pedidos_temporada_down.sql']);
    const reversa = readFileSync(join(__dirname, '..', 'migrations', '135_pedidos_temporada_down.sql'), 'utf8');
    assert.match(reversa, /^\\set ON_ERROR_STOP on$/m);
    assert.match(reversa, /ANTES DE CORRERLA: revertir primero el código/);
  });

  await t('D5b. la 139 va en el predeploy una vez, después de la 138, sola con su número y con reversa que no pierde pagos', async () => {
    const runner = readFileSync(join(__dirname, '..', 'scripts', 'predeploy-run-032-033.mjs'), 'utf8');
    const lista = runner.slice(runner.indexOf('const SCRIPTS = ['), runner.indexOf('];', runner.indexOf('const SCRIPTS = [')));
    const i138 = lista.indexOf("'138-xecador-ajustes-dia'");
    const i139 = lista.indexOf("'139-temporada-pagos-entrega'");
    assert.ok(i138 > 0 && i139 > i138, 'la 139 no está en SCRIPTS o va antes de la 138');
    assert.strictEqual(lista.split("'139-temporada-pagos-entrega'").length, 2, 'una sola vez');
    const mismas = readdirSync(join(__dirname, '..', 'migrations')).filter((f) => /^139_/.test(f));
    assert.deepStrictEqual(mismas.sort(), ['139_temporada_pagos_entrega.sql', '139_temporada_pagos_entrega_down.sql']);
    const reversa = readFileSync(join(__dirname, '..', 'migrations', '139_temporada_pagos_entrega_down.sql'), 'utf8');
    assert.match(reversa, /^\\set ON_ERROR_STOP on$/m);
    assert.match(reversa, /ANTES DE CORRERLA: revertir primero el código/);
    assert.match(reversa, /EXISTS \(SELECT 1 FROM temporada_pagos\)/, 'la reversa debe negarse si hay pagos');
  });

  await t('D6. la nota y la hoja del repartidor cobran el SALDO que calcula el servidor, no precio × platillos', async () => {
    // El dinero sale de p.pago (servidor, en centavos): la página no multiplica precios.
    assert.ok(!/precio\s*\*\s*p\.platillos|\.precio\s*\*/.test(admin), 'la página calcula totales por su cuenta');
    assert.match(admin, /const textoCobro = \(p\) => \(p\.pago\.saldo > 0 \? `COBRAR: \$\{dinero\(p\.pago\.saldo\)\}` : 'PAGADO'\);/);
    const notas = admin.slice(admin.indexOf('function imprimirNotas('), admin.indexOf('function imprimirRepartidor('));
    assert.match(notas, /textoCobro\(p\)/, 'la nota no dice cuánto cobrar');
    const rep = admin.slice(admin.indexOf('function imprimirRepartidor('), admin.indexOf("$('btnHojaCocina')"));
    assert.match(rep, /celda\('th', 'Cobrar'/);
    assert.match(rep, /p\.pago\.saldo > 0 \? dinero\(p\.pago\.saldo\) : 'PAGADO'/);
    // La hoja de cocina no lleva dinero.
    const cocina = admin.slice(admin.indexOf('function imprimirHojaCocina('), admin.indexOf('function imprimirNotas('));
    assert.ok(!/pago|dinero\(/.test(cocina), 'la hoja de cocina muestra dinero');
    // Y cada pedido con precio trae su botón de pago.
    assert.match(admin, /text: can \|\| liquidado \? 'Ver pagos' : 'Registrar pago'/);
  });

  await t('D7. entrega en la página: manda el paso que veía, avisa si entrega con saldo, «solo pendientes» y contador', async () => {
    const mover = admin.slice(admin.indexOf('async function moverEntrega('), admin.indexOf('async function moverEntrega(') + 1800);
    // El servidor decide con el paso que se veía (dos tabletas no se pisan).
    assert.match(mover, /body: JSON\.stringify\(\{ estado: a, desde \}\)/);
    assert.match(mover, /const desde = pasoDe\(p\);/);
    // Entregar con saldo pide confirmación, y la negativa lleva a cobrar.
    assert.match(mover, /a === 'entregado' && conTotal\(p\) && p\.pago\.saldo > 0 &&\s*!confirm\(/);
    assert.match(mover, /abrirPago\(p\.id\);\s*return;/);
    // Un cancelado no tiene botón de avance.
    assert.match(admin, /lineaDinero\(p\), lineaOrigen\(p\), acc, can \? null : filaAvance\(p\),/);
    // «Solo pendientes» deja fuera entregados y cancelados.
    assert.match(admin, /const pendiente = \(p\) => p\.estado === 'confirmado' && pasoDe\(p\) !== 'entregado';/);
    assert.match(admin, /\(soloPend \? pendiente\(p\) : verCan \|\| p\.estado === 'confirmado'\)/);
    // El contador por ventana sale de lo que cuenta el servidor.
    assert.match(admin, /function contadorEntrega\(v\) \{\s*const e = v\.entrega, total = e\.entregados \+ e\.pendientes;/);
    // localStorage puede no existir (privado, bloqueado): siempre dentro de try.
    const conStorage = admin.split('\n').filter((l) => l.includes('localStorage.'));
    assert.ok(conStorage.length >= 2, 'no se guarda «solo pendientes»');
    for (const l of conStorage) assert.match(l, /try \{.*localStorage\./, `localStorage sin try: ${l.trim()}`);
  });

  await t('D8. captura y edición en la página: manda lo que veía, pasar el cupo es otro botón y la lista no se refresca encima', async () => {
    const guardar = admin.slice(admin.indexOf('async function guardarPedido('), admin.indexOf("$('formPedido').addEventListener('submit'"));
    assert.ok(guardar.length > 200, 'no está guardarPedido');
    // Editar manda lo que veía (dos tabletas no se pisan); el alta, su clave de envío (doble clic).
    assert.match(guardar, /JSON\.stringify\(\{ \.\.\.cuerpo, antes: ab\.antes \}\)/);
    assert.match(guardar, /JSON\.stringify\(\{ \.\.\.cuerpo, claveEnvio: ab\.clave \}\)/);
    assert.match(admin, /: \{ id: null, clave: claveNueva\(\) \};/, 'la clave se genera al abrir «Nuevo pedido»');
    // Pasar el cupo solo con el botón aparte; Guardar nunca lo manda.
    assert.match(admin, /\$\('formPedido'\)\.addEventListener\('submit', \(ev\) => \{ ev\.preventDefault\(\); guardarPedido\(false\); \}\);/);
    assert.match(admin, /\$\('btnExcederPedido'\)\.addEventListener\('click', \(\) => guardarPedido\(true\)\);/);
    assert.strictEqual((admin.match(/guardarPedido\(true/g) || []).length, 1, 'otro camino manda «exceder»');
    // Cambiar lo escrito esconde el «de todos modos» (la advertencia era de lo anterior).
    assert.match(admin, /\$\('formPedido'\)\.addEventListener\('input', \(ev\) => \{\s*if \(ev\.target && ev\.target\.name\) \{ medirPedido\(\); mostrarExceder\(false\); \}/);
    // Lo pagado de más lo calcula el servidor; la página solo pregunta.
    assert.match(guardar, /e\.codigo === 'QUEDA_PAGADO_DE_MAS'/);
    // La lista no se refresca sola con un diálogo abierto.
    assert.match(admin, /if \(\$\('dlgPago'\)\.open \|\| \$\('dlgPedido'\)\.open\) return;/);
    // «Editar» solo en confirmados.
    assert.match(admin, /if \(!can\) \{\s*const ed = el\('button', \{ class: 'chico', type: 'button', text: 'Editar' \}\);/);
  });

  await t('D9. totales en la página: los escribe tal como llegan, sin sumar; el Excel trae los montos y un cancelado sin total ni saldo', async () => {
    // Arriba: lo que manda el servidor, sin cuentas aquí.
    assert.match(admin, /pintarPesos\(estado\.detalle\.totales\);/);
    const pesos = admin.slice(admin.indexOf('function pintarPesos('), admin.indexOf('function medidor('));
    assert.ok(pesos.length > 200, 'no está pintarPesos');
    for (const campo of ['t.venta', 't.cobrado', 't.porCobrar', 't.porDevolver']) assert.ok(pesos.includes(campo), `no muestra ${campo}`);
    assert.match(pesos, /if \(!t \|\| \(t\.venta === null && !\(t\.cobrado > 0\)\)\) \{ caja\.classList\.add\('oculto'\);/, 'sin precio debe ocultarse');
    assert.match(pesos, /t\.porDevolver > 0 \? tarjeta\('devolver'/, '«por devolver» solo si hay');
    assert.ok(!/reduce\(|[+\-]\s*t\.|t\.\w+\s*[+\-*/]/.test(pesos), 'la página hace cuentas con los totales');
    // Ningún reduce de la página suma dinero (los platillos sí se cuentan aquí).
    assert.ok(!/reduce\(\(\w+, \w+\) => \w+ \+ [^)]*\b(total|pagado|saldo|porDevolver|excedente|monto|precio)\b/.test(admin), 'la página suma dinero');
    // El Excel: las columnas nuevas, montos del servidor como número y un cancelado sin total ni saldo.
    const csv = admin.slice(admin.indexOf("$('btnCsv').addEventListener"), admin.indexOf('cargarCampanas().catch('));
    assert.match(csv, /'Notas', 'Estado',\s*'Precio', 'Total', 'Pagado', 'Saldo', 'Por devolver', 'Estado de pago', 'Estado de entrega', 'Agendado'\]\]/);
    assert.match(csv, /pesos\(p\.precio\), conf && hay \? pesos\(g\.total\) : '', pesos\(g\.pagado\), conf && hay \? pesos\(g\.saldo\) : '', pesos\(g\.porDevolver\),/);
    assert.match(csv, /const pesos = \(n\) => \(n === null \|\| n === undefined \? '' : Number\(n\)\.toFixed\(2\)\);/);
    assert.ok(!/dinero\(/.test(csv), 'el Excel lleva «$» y Excel no lo suma');
    assert.match(csv, /conf \? nombrePaso\(pasoDe\(p\), p\) : ''/);
    // En la lista, un cancelado no dice «por cobrar»: solo lo que hay que devolver.
    const linea = admin.slice(admin.indexOf('function lineaDinero('), admin.indexOf('function filaPedido('));
    assert.match(linea, /if \(p\.estado !== 'confirmado'\) \{\s*return p\.pago\.porDevolver > 0 \?/);
  });
}

await pool.end().catch(() => {});
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) console.log('Fallos:\n  ' + fallos.join('\n  '));
process.exit(fallidas ? 1 : 0);
