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
}

await pool.end().catch(() => {});
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) console.log('Fallos:\n  ' + fallos.join('\n  '));
process.exit(fallidas ? 1 : 0);
