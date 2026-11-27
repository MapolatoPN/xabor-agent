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
//  11. WHATSAPP (punto 5): Xabor no envía nada. El servidor arma el texto
//      con los datos del pedido (sin los renglones que no aplican) y la página
//      solo abre wa.me con él. Los textos son por campaña y se validan; a un
//      cancelado no se le arma ni se le anota mensaje; cada apertura queda en
//      la bitácora con quién.
//  12. CANCELAR (punto 6): exige motivo y queda con quién y cuándo.
//      Restaurar devuelve el pedido con su mismo folio SOLO si su horario
//      todavía tiene cupo, medido con el mismo candado que las altas: ni con
//      varias restauraciones y pedidos a la vez se pasa el cupo.
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
import { randomUUID, createHmac } from 'node:crypto';
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
// Esta suite agenda muchos pedidos con el mismo teléfono. El tope por teléfono
// (Fase 1, bloque 1.4) se prueba en fase-bloque1-seguridad.mjs.
process.env.XABOR_TEMPORADA_MAX_POR_TELEFONO ??= '100000';

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
// Varias sucursales (todas en una lista): quien administra A y B; quien en B
// es solo cajero; quien tuvo B y se le apagó la membresía; un usuario apagado;
// un negocio C apagado donde el de A y B también es administrador; y un
// superadmin que además administra B (en soporte se queda en su negocio).
const miembro = (usuario, neg, rol, activo = true) => pool.query(
  `INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1, $2, $3, $4)`, [usuario, neg, rol, activo]);
const C = await negocio('Negocio C');
await pool.query(`UPDATE negocios SET activo = false WHERE id = $1`, [C]);
const ADMIN_AB = await persona(A, 'Admin Ambas', 'admin');
await miembro(ADMIN_AB, B, 'admin');
await miembro(ADMIN_AB, C, 'admin');
const MIXTO = await persona(A, 'Admin A Cajero B', 'admin');
await miembro(MIXTO, B, 'staff');
const SIN_B = await persona(A, 'Ex admin B', 'admin');
await miembro(SIN_B, B, 'admin', false);
const APAGADO = await persona(A, 'Usuario apagado', 'admin');
await miembro(APAGADO, B, 'admin');
await pool.query(`UPDATE usuarios SET activo = false WHERE id = $1`, [APAGADO]);
const SUPER = await persona(B, 'Soporte Xabor', 'admin');
await pool.query(`INSERT INTO administradores_plataforma (usuario_id, activo) VALUES ($1, true)
  ON CONFLICT (usuario_id) DO UPDATE SET activo = true`, [SUPER]);
// Solo lectura y CEDIS (20-nov-2026): dos sucursales aparte para no mover lo
// de A y B. O prepara (CEDIS) lo de K. Admin y encargada (staff) de cada una,
// y quien administra las dos (el único que puede decir «K se prepara en O»).
const O = await negocio('Cedis Obispado');
const K = await negocio('Cedis Acuña');
const ADMIN_O = await persona(O, 'Admin Obispado', 'admin');
const STAFF_O = await persona(O, 'Encargada Obispado', 'staff');
const ADMIN_K = await persona(K, 'Admin Acuña', 'admin');
const STAFF_K = await persona(K, 'Encargada Acuña', 'staff');
const ADMIN_OK = await persona(K, 'Admin de las dos', 'admin');
await miembro(ADMIN_OK, O, 'admin');
const COOKIES = {
  adminA: crearTokenSesion({ usuarioId: ADMIN_A, negocioId: A, rol: 'admin' }),
  staffA: crearTokenSesion({ usuarioId: STAFF_A, negocioId: A, rol: 'staff' }),
  adminB: crearTokenSesion({ usuarioId: ADMIN_B, negocioId: B, rol: 'admin' }),
  adminAB: crearTokenSesion({ usuarioId: ADMIN_AB, negocioId: A, rol: 'admin' }),
  mixto: crearTokenSesion({ usuarioId: MIXTO, negocioId: A, rol: 'admin' }),
  adminO: crearTokenSesion({ usuarioId: ADMIN_O, negocioId: O, rol: 'admin' }),
  staffO: crearTokenSesion({ usuarioId: STAFF_O, negocioId: O, rol: 'staff' }),
  adminK: crearTokenSesion({ usuarioId: ADMIN_K, negocioId: K, rol: 'admin' }),
  staffK: crearTokenSesion({ usuarioId: STAFF_K, negocioId: K, rol: 'staff' }),
  adminOK: crearTokenSesion({ usuarioId: ADMIN_OK, negocioId: K, rol: 'admin' }),
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

  await t('A8. mensajes de WhatsApp: fecha y horario en palabras, número con lada, renglones que no aplican fuera y valores sin volver a leer', async () => {
    assert.strictEqual(T.fechaTexto('2026-11-26'), 'jueves 26 de noviembre');
    assert.strictEqual(T.fechaTexto('nada'), '');
    assert.strictEqual(T.horarioTexto('09:00', '10:00'), 'de 9:00 a 10:00 a. m.');
    assert.strictEqual(T.horarioTexto('11:00', '12:00'), 'de 11:00 a. m. a 12:00 p. m.');
    assert.strictEqual(T.horarioTexto('12:30', '13:30'), 'de 12:30 a 1:30 p. m.');
    // wa.me pide solo dígitos con lada de país; 10 dígitos son de México.
    assert.strictEqual(T.numeroWhatsApp('878 123 4567'), '528781234567');
    assert.strictEqual(T.numeroWhatsApp('+52 1 878 123 4567'), '528781234567');
    assert.strictEqual(T.numeroWhatsApp('+52 (878) 123-4567'), '528781234567');
    assert.strictEqual(T.numeroWhatsApp('+1 956 555 0123'), '19565550123');
    for (const malo of ['123', '', null, undefined, '55 1234 567', '+44 20 7946 0958']) {
      assert.strictEqual(T.numeroWhatsApp(malo), null, String(malo));
    }
    // Un renglón con un dato vacío se quita entero; lo que trae un valor no se vuelve a leer.
    const pl = 'Hola {nombre}, folio {folio}\n• Dirección: {direccion}\n• Notas: {notas}\nTotal {total}';
    assert.strictEqual(T.armarMensaje(pl, { nombre: 'Ana {folio}', folio: 'TG-002', direccion: '', notas: null, total: '$458' }),
      'Hola Ana {folio}, folio TG-002\nTotal $458');
    assert.strictEqual(T.armarMensaje('Hola\n\n{notas}\n\nAdiós', { notas: '  ' }), 'Hola\n\nAdiós');
    assert.strictEqual(T.armarMensaje('{platillos} × pavo', { platillos: 3 }), '3 × pavo');
    // Un texto propio con «{horario}.» no deja «p. m..»; un dato sin punto sí lo recibe.
    assert.strictEqual(T.armarMensaje('Llega {horario}. Notas: {notas}.', { horario: T.horarioTexto('12:00', '13:00'), notas: 'Sin chile' }),
      'Llega de 12:00 a 1:00 p. m. Notas: Sin chile.');
    // Los textos de Xabor solo usan datos conocidos y ninguno deja «m..».
    for (const tipo of ['confirmacion', 'recordatorio']) {
      assert.strictEqual(T.validarMensaje(T.MENSAJES_OMISION[tipo], tipo), null, `${tipo}: el de Xabor se guarda como null`);
      const todo = Object.fromEntries(T.CAMPOS_MENSAJE.map((k) => [k, k === 'horario' ? T.horarioTexto('11:00', '12:00') : `<${k}>`]));
      assert.ok(!/\.\./.test(T.armarMensaje(T.MENSAJES_OMISION[tipo], todo)), `${tipo}: doble punto`);
    }
    // Guardar: vacío y el de Xabor son null (sigue el de Xabor); undefined conserva el que había.
    assert.strictEqual(T.validarMensaje(undefined, 'confirmacion'), undefined);
    assert.strictEqual(T.validarMensaje('  \n ', 'confirmacion'), null);
    assert.strictEqual(T.validarMensaje(T.MENSAJES_OMISION.recordatorio.replace(/\n/g, '\r\n') + '  \r\n', 'recordatorio'), null);
    assert.strictEqual(T.validarMensaje('Hola {nombre}  \r\n\r\n\r\n\r\nTu folio {folio}\t', 'confirmacion'), 'Hola {nombre}\n\nTu folio {folio}');
    assert.strictEqual(T.validarMensaje('x'.repeat(1500), 'recordatorio'), 'x'.repeat(1500));
    const raro = await lanza('MENSAJE_INVALIDO', () => T.validarMensaje('Hola {nombre} {Folio} { total }', 'confirmacion'));
    assert.match(raro.message, /no conozco \{Folio\}, \{ total \}/);
    assert.strictEqual(raro.extra.campo, 'mensaje_confirmacion');
    for (const malo of ['Hola {nombre', 'Hola nombre}', 'Hola {{nombre}}', 'x'.repeat(1501)]) {
      const e = await lanza('MENSAJE_INVALIDO', () => T.validarMensaje(malo, 'recordatorio'));
      assert.strictEqual(e.extra.campo, 'mensaje_recordatorio');
    }
  });

  await t('A9. etiqueta de sucursal: sin las palabras que comparten todas al inicio; nunca queda vacía', async () => {
    assert.deepStrictEqual(T.etiquetasSucursal(['Mapolato Obispado', 'Mapolato Acuña']), ['Obispado', 'Acuña']);
    assert.deepStrictEqual(T.etiquetasSucursal(['MAPOLATO  Obispado ', 'Mapolato Acuña']), ['Obispado', 'Acuña']);
    assert.deepStrictEqual(T.etiquetasSucursal(['Tacos El Güero Centro', 'Tacos El Güero Norte']), ['Centro', 'Norte']);
    assert.deepStrictEqual(T.etiquetasSucursal(['Mapolato', 'Mapolato Acuña']), ['Mapolato', 'Mapolato Acuña']);
    assert.deepStrictEqual(T.etiquetasSucursal(['Mapolato Obispado']), ['Mapolato Obispado']);
    assert.deepStrictEqual(T.etiquetasSucursal(['Negocio A', 'Negocio B', 'Otro C']), ['Negocio A', 'Negocio B', 'Otro C']);
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
    await T.cancelarPedidoTemporada(A, delNueve.id, { motivo: 'Lo pidió el cliente' }, { actorId: ADMIN_A });
    await lanza('YA_CANCELADO', () => T.cancelarPedidoTemporada(A, delNueve.id, { motivo: 'Otra vez' }, { actorId: ADMIN_A }));
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
    await lanza('NO_ENCONTRADO', () => T.cancelarPedidoTemporada(B, uno.id, { motivo: 'No es suyo' }, { actorId: ADMIN_B }));
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
    await T.cancelarPedidoTemporada(A, p.id, { motivo: 'Lo pidió el cliente' }, { actorId: ADMIN_A });
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
    await T.cancelarPedidoTemporada(A, po.id, { motivo: 'Lo pidió el cliente' }, { actorId: ADMIN_A });
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
    await T.cancelarPedidoTemporada(A, e3.id, { motivo: 'Lo pidió el cliente' }, { actorId: ADMIN_A });
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
    await T.cancelarPedidoTemporada(A, p, { motivo: 'Lo pidió el cliente' }, { actorId: ADMIN_A });
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
    await T.cancelarPedidoTemporada(A, p5, { motivo: 'Lo pidió el cliente' }, { actorId: ADMIN_A });
    await T.cancelarPedidoTemporada(A, p6, { motivo: 'Lo pidió el cliente' }, { actorId: ADMIN_A });
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

  // ── WhatsApp al cliente (punto 5) ──
  let C31 = null; const W = {};
  await t('B31. mensajes de WhatsApp: cada pedido trae los suyos armados; el texto propio de la campaña se guarda, se conserva y vuelve al de Xabor', async () => {
    const k31 = clave('whatsapp');
    C31 = await T.guardarCampana(A, null, base({ clave: k31, precio: 229, anticipo_tipo: 'porcentaje', anticipo_valor: 50 }));
    assert.deepStrictEqual([C31.mensaje_confirmacion, C31.mensaje_recordatorio], [null, null], 'nace con el texto de Xabor');
    const lista = await T.listarCampanas(A);
    assert.deepStrictEqual(lista.mensajesOmision, T.MENSAJES_OMISION);
    assert.deepStrictEqual(lista.camposMensaje, [...T.CAMPOS_MENSAJE]);
    W.rec = (await crearP(C31.id, { platillos: 2 })).pedido.id;
    W.dom = (await crearP(C31.id, { platillos: 3, modalidad: 'domicilio', ventana: '11:00', direccion: 'Calle Morelos 100, Centro',
      referencias: 'Portón negro', notas: 'Sin gravy' })).pedido.id;
    W.can = (await crearP(C31.id, { platillos: 1 })).pedido.id;
    await T.registrarPagoTemporada(A, W.dom, { monto: '343.50', metodo: 'transferencia' }, { actorId: ADMIN_A });
    await T.cancelarPedidoTemporada(A, W.can, { motivo: 'Lo pidió el cliente' }, { actorId: ADMIN_A });
    const fecha = T.fechaTexto(FECHA);
    const de = async (id) => (await T.pedidosDeCampana(A, C31.id)).pedidos.find((p) => p.id === id).whatsapp;
    const rec = await de(W.rec), dom = await de(W.dom);
    assert.strictEqual(rec.numero, '528781112233');
    assert.strictEqual(rec.confirmacion, [
      'Hola Pedro Teléfono, te confirmamos tu pedido TG-001:', '• 2 × Platillo de pavo',
      `• ${fecha}, de 9:00 a 10:00 a. m.`, '• Pasas a recoger', 'Total $458: $458 por pagar.', '¡Gracias por tu pedido!'].join('\n'));
    assert.strictEqual(dom.confirmacion, [
      'Hola Pedro Teléfono, te confirmamos tu pedido TG-002:', '• 3 × Platillo de pavo',
      `• ${fecha}, de 11:00 a. m. a 12:00 p. m.`, '• Entrega a domicilio', '• Dirección: Calle Morelos 100, Centro',
      '• Referencias: Portón negro', '• Notas: Sin gravy', 'Total $687: pagaste $343.50, quedan $343.50 por pagar.',
      '¡Gracias por tu pedido!'].join('\n'));
    assert.strictEqual(dom.recordatorio, [
      'Hola Pedro Teléfono, te recordamos tu pedido TG-002:', `• ${fecha}, de 11:00 a. m. a 12:00 p. m.`,
      '• 3 × Platillo de pavo', '• Entrega a domicilio', '• Dirección: Calle Morelos 100, Centro',
      'Total $687: pagaste $343.50, quedan $343.50 por pagar.', '¡Gracias!'].join('\n'));
    assert.deepStrictEqual(dom.enviado, { confirmacion: null, recordatorio: null });
    assert.strictEqual(await de(W.can), null, 'a un cancelado no se le arma mensaje');
    // Liquidado: el mensaje lo dice y ya no pide dinero.
    await T.registrarPagoTemporada(A, W.dom, { monto: '343.50', metodo: 'efectivo' }, { actorId: ADMIN_A });
    assert.match((await de(W.dom)).confirmacion, /\nTotal \$687: ya está pagado\.\n/);
    // Texto propio: se guarda y cada pedido lo recibe con sus datos (sin el renglón de notas si no tiene).
    const propio = 'Hola {nombre}: tu {folio} es el {fecha}.\n{notas}\nCualquier duda, aquí estamos.';
    const c2 = await T.guardarCampana(A, C31.id, { ...base({ clave: k31, precio: 229, anticipo_tipo: 'porcentaje', anticipo_valor: 50 }),
      mensaje_confirmacion: propio });
    assert.deepStrictEqual([c2.mensaje_confirmacion, c2.mensaje_recordatorio], [propio, null]);
    assert.strictEqual((await de(W.rec)).confirmacion, `Hola Pedro Teléfono: tu TG-001 es el ${fecha}.\nCualquier duda, aquí estamos.`);
    assert.strictEqual((await de(W.dom)).confirmacion, `Hola Pedro Teléfono: tu TG-002 es el ${fecha}.\nSin gravy\nCualquier duda, aquí estamos.`);
    assert.ok((await de(W.dom)).recordatorio.startsWith('Hola Pedro Teléfono, te recordamos'), 'el recordatorio sigue el de Xabor');
    // Una página que no manda los mensajes (anterior) no los borra.
    const c3 = await T.guardarCampana(A, C31.id, base({ clave: k31, precio: 229, anticipo_tipo: 'porcentaje', anticipo_valor: 50 }));
    assert.strictEqual(c3.mensaje_confirmacion, propio);
    // Uno con un dato que no existe no se guarda y no cambia nada.
    const malo = await lanza('MENSAJE_INVALIDO', () => T.guardarCampana(A, C31.id,
      { ...base({ clave: k31, precio: 229, anticipo_tipo: 'porcentaje', anticipo_valor: 50 }), mensaje_recordatorio: 'Hola {cliente}' }));
    assert.strictEqual(malo.extra.campo, 'mensaje_recordatorio');
    assert.strictEqual((await q1(`SELECT mensaje_confirmacion FROM temporada_campanas WHERE id = $1`, [C31.id])).mensaje_confirmacion, propio);
    // Vacío o igual al de Xabor: vuelve a null.
    for (const vuelta of ['', T.MENSAJES_OMISION.confirmacion]) {
      await T.guardarCampana(A, C31.id, { ...base({ clave: k31, precio: 229, anticipo_tipo: 'porcentaje', anticipo_valor: 50 }),
        mensaje_confirmacion: propio });
      const c4 = await T.guardarCampana(A, C31.id, { ...base({ clave: k31, precio: 229, anticipo_tipo: 'porcentaje', anticipo_valor: 50 }),
        mensaje_confirmacion: vuelta });
      assert.strictEqual(c4.mensaje_confirmacion, null, JSON.stringify(vuelta.slice(0, 20)));
    }
    // Una campaña nueva con su texto lo guarda desde el alta.
    const nueva = await T.guardarCampana(A, null, { ...base({ clave: clave('whatsapp-alta'), activa: false }), mensaje_recordatorio: 'Mañana: {folio}' });
    assert.deepStrictEqual([nueva.mensaje_confirmacion, nueva.mensaje_recordatorio], [null, 'Mañana: {folio}']);
    // Sin precio: no hay renglón de total.
    const kSin = clave('whatsapp-sin');
    const cSin = await T.guardarCampana(A, null, base({ clave: kSin, precio: null }));
    const pSin = (await crearP(cSin.id, {})).pedido.id;
    const wSin = (await T.pedidosDeCampana(A, cSin.id)).pedidos.find((p) => p.id === pSin).whatsapp;
    assert.ok(!/Total|\$/.test(wSin.confirmacion) && !/Total|\$/.test(wSin.recordatorio), wSin.confirmacion);
    assert.match(wSin.confirmacion, /\n• Pasas a recoger\n¡Gracias por tu pedido!$/);
  });

  await t('B32. «Enviar» por WhatsApp: se anota quién y cuándo, solo del negocio y nunca a un cancelado', async () => {
    assert.ok(C31 && W.rec, 'preparación: B31');
    await lanza('NO_ENCONTRADO', () => T.anotarWhatsAppTemporada(A, 'x', { tipo: 'confirmacion' }, { actorId: ADMIN_A }));
    await lanza('NO_ENCONTRADO', () => T.anotarWhatsAppTemporada(B, W.rec, { tipo: 'confirmacion' }, { actorId: ADMIN_B }));
    for (const cuerpo of [{ tipo: 'otro' }, {}, null, { tipo: ['confirmacion'] }]) {
      await lanza('TIPO_INVALIDO', () => T.anotarWhatsAppTemporada(A, W.rec, cuerpo, { actorId: ADMIN_A }));
    }
    const sin = await lanza('SIN_USUARIO', () => T.anotarWhatsAppTemporada(A, W.rec, { tipo: 'confirmacion' }, {}));
    assert.strictEqual(sin.http, 403);
    const can = await lanza('PEDIDO_CANCELADO', () => T.anotarWhatsAppTemporada(A, W.can, { tipo: 'recordatorio' }, { actorId: ADMIN_A }));
    assert.strictEqual(can.http, 409);
    const cuenta = async () => (await q1(`SELECT COUNT(*)::int AS n FROM temporada_bitacora WHERE pedido_id = ANY($1::bigint[]) AND accion LIKE 'whatsapp_%'`,
      [[W.rec, W.can]])).n;
    assert.strictEqual(await cuenta(), 0, 'un intento rechazado anotó algo');
    assert.deepStrictEqual(await T.anotarWhatsAppTemporada(A, W.rec, { tipo: 'confirmacion' }, { actorId: ADMIN_A }), { ok: true, tipo: 'confirmacion' });
    const env = async () => (await T.pedidosDeCampana(A, C31.id)).pedidos.find((p) => p.id === W.rec).whatsapp.enviado;
    let e = await env();
    assert.strictEqual(e.confirmacion.por, 'Admin A');
    assert.ok(e.confirmacion.en, 'sin hora');
    assert.strictEqual(e.recordatorio, null);
    // Reenviarlo: queda el último, con quién.
    await T.anotarWhatsAppTemporada(A, W.rec, { tipo: 'confirmacion' }, { actorId: STAFF_A });
    await T.anotarWhatsAppTemporada(A, W.rec, { tipo: 'recordatorio' }, { actorId: ADMIN_A });
    e = await env();
    assert.deepStrictEqual([e.confirmacion.por, e.recordatorio.por], ['Cajero A', 'Admin A']);
    // El historial del pedido lo trae, en orden.
    const h = await T.historialPedidoTemporada(A, W.rec);
    assert.deepStrictEqual(h.eventos.filter((x) => x.accion.startsWith('whatsapp_')).map((x) => [x.accion, x.por]),
      [['whatsapp_confirmacion', 'Admin A'], ['whatsapp_confirmacion', 'Cajero A'], ['whatsapp_recordatorio', 'Admin A']]);
    assert.strictEqual(await cuenta(), 3);
    // Lo anotado no cambia el pedido: ni estado, ni entrega, ni pagos.
    const fila = await q1(`SELECT estado, estado_entrega FROM temporada_pedidos WHERE id = $1`, [W.rec]);
    assert.deepStrictEqual([fila.estado, fila.estado_entrega], ['confirmado', 'agendado']);
  });

  // ── Cancelar más seguro (punto 6) ──
  const cancelarCon = (id, motivo = 'Lo pidió el cliente') => T.cancelarPedidoTemporada(A, id, { motivo }, { actorId: ADMIN_A });
  await t('B33. cancelar exige motivo; queda en el pedido y en la bitácora con quién y cuándo', async () => {
    const C33 = await T.guardarCampana(A, null, base({ clave: clave('cancelar'), precio: 229 }));
    const { pedido: { id } } = await crearP(C33.id, { platillos: 2 });
    for (const malo of [undefined, null, {}, { motivo: '' }, { motivo: '  a  ' }, { motivo: 7 }, { motivo: 'x'.repeat(301) }]) {
      const e = await lanza('MOTIVO_REQUERIDO', () => T.cancelarPedidoTemporada(A, id, malo, { actorId: ADMIN_A }));
      assert.strictEqual(e.extra.campo, 'motivo', JSON.stringify(malo));
    }
    await lanza('SIN_USUARIO', () => T.cancelarPedidoTemporada(A, id, { motivo: 'Lo pidió el cliente' }, {}));
    await lanza('NO_ENCONTRADO', () => T.cancelarPedidoTemporada(A, 'abc', { motivo: 'Lo pidió el cliente' }, { actorId: ADMIN_A }));
    assert.strictEqual((await q1(`SELECT estado FROM temporada_pedidos WHERE id = $1`, [id])).estado, 'confirmado', 'un intento rechazado lo canceló');
    await T.cancelarPedidoTemporada(A, id, { motivo: '  Pidió\n\tcambiar de fecha  ' }, { actorId: ADMIN_A });
    const fila = await q1(`SELECT estado, motivo_cancelacion, cancelado_por FROM temporada_pedidos WHERE id = $1`, [id]);
    assert.deepStrictEqual([fila.estado, fila.motivo_cancelacion, fila.cancelado_por], ['cancelado', 'Pidió cambiar de fecha', String(ADMIN_A)]);
    const p = (await T.pedidosDeCampana(A, C33.id)).pedidos.find((x) => x.id === id);
    assert.deepStrictEqual([p.cancelacion.por, p.cancelacion.motivo], ['Admin A', 'Pidió cambiar de fecha']);
    assert.ok(p.cancelacion.en, 'sin hora de cancelación');
    const ev = (await T.historialPedidoTemporada(A, id)).eventos.find((x) => x.accion === 'cancelado');
    assert.deepStrictEqual([ev.por, ev.detalle.motivo], ['Admin A', 'Pidió cambiar de fecha']);
    // Un confirmado no trae «cancelacion», y la base no le deja un motivo.
    const { pedido: { id: otro } } = await crearP(C33.id, { platillos: 1 });
    assert.strictEqual((await T.pedidosDeCampana(A, C33.id)).pedidos.find((x) => x.id === otro).cancelacion, null);
    await assert.rejects(pool.query(`UPDATE temporada_pedidos SET motivo_cancelacion = 'x' WHERE id = $1`, [otro]), /temporada_pedidos_motivo/);
  });

  await t('B34. restaurar: vuelve con su mismo folio y sus pagos si su horario tiene lugar; sin lugar no entra', async () => {
    const k34 = clave('restaurar');
    const conf34 = (extra = {}) => base({ clave: k34, precio: 229, cupo_platillos: 10, cupo_domicilio: 1, max_platillos_pedido: 10, ...extra });
    const C34 = await T.guardarCampana(A, null, conf34());
    const { pedido: { id: x, folio } } = await crearP(C34.id, { platillos: 4 });
    await T.registrarPagoTemporada(A, x, { monto: 229, metodo: 'efectivo' }, { actorId: ADMIN_A });
    await cancelarCon(x);
    await lanza('SIN_USUARIO', () => T.restaurarPedidoTemporada(A, x, {}));
    await lanza('NO_ENCONTRADO', () => T.restaurarPedidoTemporada(B, x, { actorId: ADMIN_B }));
    await lanza('NO_ENCONTRADO', () => T.restaurarPedidoTemporada(A, '1; drop', { actorId: ADMIN_A }));
    // Mientras estaba cancelado entró otro: quedan 3 y él lleva 4 → no cabe y sigue cancelado.
    const { pedido: { id: y } } = await crearP(C34.id, { platillos: 7 });
    const sin = await lanza('SIN_CUPO', () => T.restaurarPedidoTemporada(A, x, { actorId: ADMIN_A }));
    assert.strictEqual(sin.http, 409);
    assert.ok(sin.message.startsWith(`No hay lugar para restaurar ${folio}. En ese horario quedan 3 de 10 platillos`), sin.message);
    assert.strictEqual(sin.extra.libres, 3);
    assert.strictEqual((await q1(`SELECT estado FROM temporada_pedidos WHERE id = $1`, [x])).estado, 'cancelado');
    // Se libera el lugar: entra con su folio, sin rastro de la cancelación, y su pago vuelve a contar.
    await cancelarCon(y, 'Pedido repetido');
    assert.deepStrictEqual(await T.restaurarPedidoTemporada(A, x, { actorId: ADMIN_A }), { ok: true, folio });
    const fila = await q1(`SELECT estado, cancelado_en, cancelado_por, motivo_cancelacion FROM temporada_pedidos WHERE id = $1`, [x]);
    assert.deepStrictEqual([fila.estado, fila.cancelado_en, fila.cancelado_por, fila.motivo_cancelacion], ['confirmado', null, null, null]);
    const p = (await T.pedidosDeCampana(A, C34.id)).pedidos.find((q) => q.id === x);
    assert.deepStrictEqual([p.folio, p.cancelacion, p.pago.pagado, p.pago.saldo], [folio, null, 229, 687]);
    assert.strictEqual((await usoVentana(C34.id, '09:00')).platillos, 4);
    const evs = (await T.historialPedidoTemporada(A, x)).eventos;
    assert.deepStrictEqual(evs.slice(-2).map((e) => [e.accion, e.por]), [['cancelado', 'Admin A'], ['restaurado', 'Admin A']]);
    assert.strictEqual(evs.at(-1).detalle.motivo_cancelacion, 'Lo pidió el cliente');
    await lanza('NO_CANCELADO', () => T.restaurarPedidoTemporada(A, x, { actorId: ADMIN_A }));
    // Domicilio: el cupo de entregas también cuenta.
    const { pedido: { id: d1 } } = await crearP(C34.id, { platillos: 1, ventana: '10:00', modalidad: 'domicilio', direccion: 'Calle 1 #2, Centro' });
    await cancelarCon(d1);
    await crearP(C34.id, { platillos: 1, ventana: '10:00', modalidad: 'domicilio', direccion: 'Calle 3 #4, Centro' });
    const dom = await lanza('SIN_CUPO', () => T.restaurarPedidoTemporada(A, d1, { actorId: ADMIN_A }));
    assert.deepStrictEqual(dom.extra.excesos.map((e) => e.codigo), ['DOMICILIO_LLENO']);
    // El máximo por pedido no aplica a uno que ya se había aceptado.
    const { pedido: { id: grande } } = await crearP(C34.id, { platillos: 6, ventana: '11:00' });
    await cancelarCon(grande);
    await T.guardarCampana(A, C34.id, conf34({ max_platillos_pedido: 5 }));
    assert.strictEqual((await T.restaurarPedidoTemporada(A, grande, { actorId: ADMIN_A })).ok, true);
    // Un horario que ya no existe en la campaña: no se restaura.
    const { pedido: { id: tarde } } = await crearP(C34.id, { platillos: 1, ventana: '15:00' });
    await cancelarCon(tarde);
    await pool.query(`UPDATE temporada_campanas SET hora_fin = '15:00' WHERE id = $1`, [C34.id]);
    try {
      await lanza('VENTANA_INVALIDA', () => T.restaurarPedidoTemporada(A, tarde, { actorId: ADMIN_A }));
    } finally {
      await pool.query(`UPDATE temporada_campanas SET hora_fin = '16:00' WHERE id = $1`, [C34.id]);
    }
    // Ni uno a domicilio si la campaña ya no los acepta.
    const { pedido: { id: d2 } } = await crearP(C34.id, { platillos: 1, ventana: '12:00', modalidad: 'domicilio', direccion: 'Calle 5 #6, Centro' });
    await cancelarCon(d2);
    await T.guardarCampana(A, C34.id, conf34({ max_platillos_pedido: 5, acepta_domicilio: false }));
    await lanza('MODALIDAD_NO_DISPONIBLE', () => T.restaurarPedidoTemporada(A, d2, { actorId: ADMIN_A }));
  });

  await t('B35. a la vez: 4 restauraciones y 2 pedidos de la página por un horario con lugar para 3 → entran 3 y nunca se pasa', async () => {
    const k35 = clave('restaurar-carrera');
    const C35 = await T.guardarCampana(A, null, base({ clave: k35, cupo_platillos: 10, max_platillos_pedido: 10 }));
    const ids = [];
    // Uno por uno (los 4 juntos no caben): cada uno se agenda y se cancela.
    for (let i = 0; i < 4; i++) {
      const { pedido: { id } } = await crearP(C35.id, { platillos: 3, ventana: '14:00' });
      await cancelarCon(id);
      ids.push(id);
    }
    assert.strictEqual((await usoVentana(C35.id, '14:00')).platillos, 0);
    const reten = await pool.connect(); let intentos;
    try {
      // Se retiene la campaña: todos llegan a medir el cupo a la vez si nada los ordena.
      await reten.query('BEGIN');
      await reten.query('SELECT 1 FROM temporada_campanas WHERE id = $1 FOR UPDATE', [C35.id]);
      intentos = [
        ...ids.map((id) => T.restaurarPedidoTemporada(A, id, { actorId: ADMIN_A })),
        ...[1, 2].map(() => T.crearPedidoTemporada(k35, pedido({ ventana: '14:00', platillos: 3 }))),
      ];
      await new Promise((ok) => setTimeout(ok, 500));
      await reten.query('COMMIT');
    } finally {
      reten.release();
    }
    const r = await Promise.allSettled(intentos);
    assert.strictEqual(r.filter((x) => x.status === 'fulfilled').length, 3, r.map((x) => x.reason?.codigo || x.reason?.code || 'ok').join(','));
    assert.ok(r.filter((x) => x.status === 'rejected').every((x) => ['SIN_CUPO', 'VENTANA_LLENA'].includes(x.reason.codigo)));
    assert.strictEqual((await usoVentana(C35.id, '14:00')).platillos, 9);
  });

  // ── Todas las sucursales en una lista ──
  // El día FJ: A de 9 a 12 (cupo 40/10) y B de 10 a 13 (cupo 20/5), con
  // precios que en pesos no suman exacto (100.10 y 200.20). C (apagado) también
  // tiene campaña ese día y nunca aparece. FSOLO: campaña solo en A.
  const FJ = await enDias(30), FSOLO = await enDias(32), FDOS = await enDias(33), FVACIA = await enDias(34);
  const J = {};
  const sucursalesDe = async (usuario, actual, opc = {}) =>
    (await T.sucursalesDelAdmin(usuario, actual, opc)).map((s) => [s.id, s.etiqueta]);
  await t('B36. sucursales del administrador: solo donde es admin con membresía, usuario y negocio activos; la de la sesión primero', async () => {
    assert.deepStrictEqual(await T.sucursalesDelAdmin(ADMIN_AB, A),
      [{ id: A, nombre: 'Negocio A', etiqueta: 'A' }, { id: B, nombre: 'Negocio B', etiqueta: 'B' }]);
    assert.deepStrictEqual(await sucursalesDe(ADMIN_AB, B), [[B, 'B'], [A, 'A']]);
    // Cajero en B, membresía apagada, usuario apagado, sin usuario: solo la de la sesión.
    for (const [u, quien] of [[MIXTO, 'cajero en B'], [SIN_B, 'membresía apagada'], [APAGADO, 'usuario apagado'], [null, 'sin usuario'], [ADMIN_A, 'solo A']]) {
      assert.deepStrictEqual(await sucursalesDe(u, A), [[A, 'Negocio A']], quien);
    }
    // Soporte: se queda en su negocio aunque el usuario administre otro.
    assert.deepStrictEqual(await sucursalesDe(ADMIN_AB, A, { soporte: true }), [[A, 'Negocio A']]);
    assert.deepStrictEqual(await sucursalesDe(SUPER, A, { soporte: true }), [[A, 'Negocio A']]);
    assert.deepStrictEqual(await sucursalesDe(SUPER, A), [[A, 'A'], [B, 'B']], 'sin la marca de soporte sí vería B');
  });

  await t('B37. el negocio de un recurso: el suyo solo si el usuario administra esa sucursal; si no, el de la sesión (y ahí no existe)', async () => {
    J.A = await T.guardarCampana(A, null, base({ clave: clave('juntas-a'), fecha: FJ, hora_inicio: '09:00', hora_fin: '12:00', precio: 100.10 }));
    J.B = await T.guardarCampana(B, null, base({ clave: clave('juntas-b'), fecha: FJ, hora_inicio: '10:00', hora_fin: '13:00', precio: 200.20,
      cupo_platillos: 20, cupo_domicilio: 5, max_platillos_pedido: 20 }));
    J.C = await T.guardarCampana(C, null, base({ clave: clave('juntas-c'), fecha: FJ }));
    J.a1 = (await crearP(J.A.id, { platillos: 2, ventana: '10:00' })).pedido;
    J.a2 = (await crearP(J.A.id, { platillos: 1, ventana: '09:00', modalidad: 'domicilio', direccion: 'Calle 1 #2, Centro' })).pedido;
    J.b1 = (await crearP(J.B.id, { platillos: 3, ventana: '10:00' }, ADMIN_B, B)).pedido;
    J.b2 = (await crearP(J.B.id, { platillos: 1, ventana: '12:00' }, ADMIN_B, B)).pedido;
    J.pago = (await T.registrarPagoTemporada(B, J.b1.id, { monto: 300, metodo: 'efectivo' }, { actorId: ADMIN_B })).pagoId;
    await T.registrarPagoTemporada(B, J.b2.id, { monto: 100, metodo: 'efectivo' }, { actorId: ADMIN_B });
    await T.cancelarPedidoTemporada(B, J.b2.id, { motivo: 'Lo pidió el cliente' }, { actorId: ADMIN_B });
    const de = (u, actual, tipo, id, opc) => T.negocioDeRecursoTemporada(u, actual, tipo, id, opc);
    for (const [tipo, id] of [['campana', J.B.id], ['pedido', J.b1.id], ['pago', J.pago]]) {
      assert.strictEqual(await de(ADMIN_AB, A, tipo, id), B, `${tipo}: el admin de las dos`);
      for (const [u, quien] of [[ADMIN_A, 'solo A'], [MIXTO, 'cajero en B'], [SIN_B, 'membresía apagada'], [APAGADO, 'usuario apagado'], [null, 'sin usuario']]) {
        assert.strictEqual(await de(u, A, tipo, id), A, `${tipo}: ${quien}`);
      }
      assert.strictEqual(await de(ADMIN_AB, A, tipo, id, { soporte: true }), A, `${tipo}: soporte`);
    }
    assert.strictEqual(await de(ADMIN_AB, B, 'campana', J.A.id), A);
    assert.strictEqual(await de(ADMIN_B, B, 'campana', J.A.id), B, 'el de B no llega a A');
    assert.strictEqual(await de(ADMIN_AB, A, 'campana', J.C.id), A, 'C está apagado');
    for (const raro of ['999999999999', 'abc', '1 OR 1=1', '', null, undefined, '1'.repeat(19)]) {
      assert.strictEqual(await de(ADMIN_AB, A, 'pedido', raro), A, String(raro));
    }
    await assert.rejects(de(ADMIN_AB, A, 'negocio', J.B.id), /desconocido/);
    // Con el negocio que le toca, el admin de solo A no toca lo de B.
    await lanza('NO_ENCONTRADO', async () => T.cancelarPedidoTemporada(await de(MIXTO, A, 'pedido', J.b1.id), J.b1.id,
      { motivo: 'No es suyo' }, { actorId: MIXTO }));
    assert.strictEqual((await q1(`SELECT estado FROM temporada_pedidos WHERE id = $1`, [J.b1.id])).estado, 'confirmado');
  });

  await t('B38. lista de campañas: con varias sucursales, cada campaña con la suya y los días con dos o más para verlos juntos', async () => {
    await T.guardarCampana(A, null, base({ clave: clave('juntas-solo-a'), fecha: FSOLO }));
    const sola = await T.listarCampanasAdmin(A, { usuarioId: ADMIN_A });
    assert.deepStrictEqual([sola.juntas, sola.sucursales], [[], []]);
    assert.ok(sola.campanas.some((c) => c.id === J.A.id) && !sola.campanas.some((c) => c.id === J.B.id));
    assert.ok(sola.campanas.every((c) => !('sucursal' in c)), 'con una sola sucursal la lista queda como siempre');
    for (const [u, opc, quien] of [[MIXTO, {}, 'cajero en B'], [SIN_B, {}, 'membresía apagada'], [ADMIN_AB, { soporte: true }, 'soporte']]) {
      const r = await T.listarCampanasAdmin(A, { usuarioId: u, ...opc });
      assert.deepStrictEqual([r.juntas, r.sucursales, r.campanas.some((c) => c.id === J.B.id)], [[], [], false], quien);
    }
    const r = await T.listarCampanasAdmin(A, { usuarioId: ADMIN_AB });
    assert.deepStrictEqual(r.sucursales, [{ id: A, etiqueta: 'A', administra: true }, { id: B, etiqueta: 'B', administra: true }]);
    assert.ok(r.puedeCrear && sola.puedeCrear && r.campanas.every((c) => c.soloLectura === false), 'el administrador atiende todo lo suyo');
    assert.deepStrictEqual(r.campanas.find((c) => c.id === J.A.id).sucursal, { id: A, etiqueta: 'A' });
    assert.deepStrictEqual(r.campanas.find((c) => c.id === J.B.id).sucursal, { id: B, etiqueta: 'B' });
    assert.ok(!r.campanas.some((c) => c.id === J.C.id), 'la campaña del negocio apagado');
    for (let i = 1; i < r.campanas.length; i++) assert.ok(r.campanas[i - 1].fecha >= r.campanas[i].fecha, 'la más reciente primero');
    // El día con las dos sucursales: confirmados y platillos de las dos (b2 está cancelado).
    assert.deepStrictEqual(r.juntas.find((j) => j.fecha === FJ),
      { id: `juntas:${FJ}`, fecha: FJ, titulo: 'Thanksgiving prueba', sucursales: ['A', 'B'], pedidos: 3, platillos: 6 });
    assert.ok(!r.juntas.some((j) => j.fecha === FSOLO), 'un día con una sola sucursal no se junta');
    assert.ok(r.juntas.every((j) => j.sucursales.length > 1));
    // Lo de siempre sigue viniendo: la clave sugerida es la de la sucursal de la sesión.
    assert.strictEqual(r.claveSugerida, sola.claveSugerida);
    assert.ok(r.mensajesOmision && r.zona);
    assert.deepStrictEqual((await T.listarCampanasAdmin(B, { usuarioId: ADMIN_AB })).sucursales.map((s) => s.etiqueta), ['B', 'A']);
  });

  await t('B39. un día con todas: horarios con el uso de cada sucursal contra SU cupo, cada pedido con su sucursal y totales exactos', async () => {
    const d = await T.pedidosJuntos(A, FJ, { usuarioId: ADMIN_AB });
    assert.strictEqual(d.juntas, true);
    assert.deepStrictEqual(d.campana, { id: `juntas:${FJ}`, clave: `todas-las-sucursales-${FJ}`, fecha: FJ, titulo: 'Thanksgiving prueba', activa: true });
    assert.deepStrictEqual(d.sucursales.map((s) => [s.id, s.etiqueta, s.campana.id]), [[A, 'A', J.A.id], [B, 'B', J.B.id]]);
    assert.deepStrictEqual(d.ventanas.map((v) => `${v.inicio}-${v.fin}`), ['09:00-10:00', '10:00-11:00', '11:00-12:00', '12:00-13:00']);
    const v10 = d.ventanas[1];
    assert.deepStrictEqual(v10.porSucursal, [
      { etiqueta: 'A', campana_id: J.A.id, platillos: 2, cupoPlatillos: 40, domicilios: 0, cupoDomicilio: 10 },
      { etiqueta: 'B', campana_id: J.B.id, platillos: 3, cupoPlatillos: 20, domicilios: 0, cupoDomicilio: 5 }]);
    assert.deepStrictEqual([v10.platillos, v10.pedidos, v10.entrega.pendientes, v10.entrega.entregados], [5, 2, 2, 0]);
    assert.ok(!('cupoPlatillos' in v10), 'los cupos de dos cocinas no se suman');
    assert.deepStrictEqual(d.ventanas[0].porSucursal.map((s) => [s.etiqueta, s.domicilios]), [['A', 1]]);
    assert.deepStrictEqual(d.ventanas[3].porSucursal.map((s) => [s.etiqueta, s.platillos]), [['B', 0]], 'el cancelado no ocupa');
    // Por horario y, dentro del horario, por sucursal. Los folios se repiten entre sucursales: la sucursal los distingue.
    assert.deepStrictEqual(d.pedidos.map((p) => [p.id, p.folio, p.sucursal.etiqueta, p.campana_id, p.estado]), [
      [J.a2.id, J.a2.folio, 'A', J.A.id, 'confirmado'], [J.a1.id, J.a1.folio, 'A', J.A.id, 'confirmado'],
      [J.b1.id, J.b1.folio, 'B', J.B.id, 'confirmado'], [J.b2.id, J.b2.folio, 'B', J.B.id, 'cancelado']]);
    assert.strictEqual(J.a1.folio, J.b1.folio);
    assert.ok(d.pedidos.every((p) => p.sucursal.id === (p.campana_id === J.A.id ? A : B)));
    // Cada pedido igual que en su campaña (pago, WhatsApp, cancelación), más su sucursal.
    const sueltoB = (await T.pedidosDeCampana(B, J.B.id)).pedidos.find((p) => p.id === J.b1.id);
    const { sucursal, campana_id, ...resto } = d.pedidos[2];
    assert.deepStrictEqual(resto, sueltoB);
    // Totales: los de cada sucursal tal cual, y los de todas en centavos (en pesos, 300.30 + 600.60 no da 900.90).
    const tA = (await T.pedidosDeCampana(A, J.A.id)).totales, tB = (await T.pedidosDeCampana(B, J.B.id)).totales;
    assert.deepStrictEqual([d.sucursales[0].totales, d.sucursales[1].totales], [tA, tB]);
    assert.deepStrictEqual(d.totales, { venta: 900.9, cobrado: 400, porCobrar: 600.9, porDevolver: 100, conSaldo: 3, sinPrecio: 0 });
    for (const k of ['venta', 'cobrado', 'porCobrar', 'porDevolver']) {
      assert.strictEqual(Math.round(d.totales[k] * 100), Math.round(tA[k] * 100) + Math.round(tB[k] * 100), k);
    }
    // Quien solo administra A (o soporte) ve ese día solo lo de A.
    for (const [u, opc] of [[ADMIN_A, {}], [MIXTO, {}], [ADMIN_AB, { soporte: true }]]) {
      const s = await T.pedidosJuntos(A, FJ, { usuarioId: u, ...opc });
      assert.deepStrictEqual(s.sucursales.map((x) => x.id), [A]);
      assert.deepStrictEqual(s.pedidos.map((p) => p.id), [J.a2.id, J.a1.id]);
    }
    assert.deepStrictEqual((await T.pedidosJuntos(B, FJ, { usuarioId: ADMIN_AB })).sucursales.map((s) => s.etiqueta), ['B', 'A']);
    // Fechas inventadas o sin campañas: no existe.
    for (const f of ['2026-02-30', 'abc', `${FJ}'; --`, '', FVACIA]) {
      await lanza('NO_ENCONTRADA', () => T.pedidosJuntos(A, f, { usuarioId: ADMIN_AB }));
    }
    await lanza('NO_ENCONTRADA', () => T.pedidosJuntos(A, FJ.replace(/-\d\d$/, '-32'), { usuarioId: ADMIN_AB }));
  });

  await t('B40. dos campañas de una sucursal el mismo día se distinguen por su producto', async () => {
    const pavo = await T.guardarCampana(A, null, base({ clave: clave('juntas-pavo'), fecha: FDOS, producto: 'Pavo' }));
    const pierna = await T.guardarCampana(A, null, base({ clave: clave('juntas-pierna'), fecha: FDOS, producto: 'Pierna' }));
    await T.guardarCampana(B, null, base({ clave: clave('juntas-pavo-b'), fecha: FDOS, producto: 'Pavo', titulo: 'Thanksgiving B' }));
    await crearP(pierna.id, { platillos: 4 });
    const d = await T.pedidosJuntos(A, FDOS, { usuarioId: ADMIN_AB });
    assert.deepStrictEqual(d.sucursales.map((s) => s.etiqueta), ['A · Pavo', 'A · Pierna', 'B']);
    assert.deepStrictEqual(d.ventanas[0].porSucursal.map((s) => [s.etiqueta, s.platillos, s.cupoPlatillos]),
      [['A · Pavo', 0, 40], ['A · Pierna', 4, 40], ['B', 0, 40]]);
    assert.deepStrictEqual(d.pedidos.map((p) => [p.sucursal.etiqueta, p.campana_id]), [['A · Pierna', pierna.id]]);
    assert.strictEqual(d.campana.titulo, 'Pedidos de temporada', 'títulos distintos');
    const j = (await T.listarCampanasAdmin(A, { usuarioId: ADMIN_AB })).juntas.find((x) => x.fecha === FDOS);
    assert.deepStrictEqual([j.sucursales, j.titulo, j.pedidos, j.platillos], [['A', 'B'], 'Pedidos de temporada', 1, 4]);
    assert.ok(pavo.id !== pierna.id);
  });

  // ── Solo lectura y CEDIS (sucursales O y K, aparte de A y B) ──
  const FCEDIS = await enDias(40), FCEDIS2 = await enDias(41);
  const CDS = {};
  // Lo que viaja en solo lectura: el pedido completo, menos WhatsApp y los movimientos de pago.
  const enLectura = (p) => ({ ...p, whatsapp: null, pago: { ...p.pago, movimientos: [] } });
  await t('B41. la encargada (staff) ve su sucursal en solo lectura: no crea, sin totales en pesos, sin movimientos de pago ni WhatsApp', async () => {
    CDS.K = await T.guardarCampana(K, null, base({ clave: clave('cedis-k'), fecha: FCEDIS, precio: 229 }));
    CDS.k1 = (await crearP(CDS.K.id, { platillos: 12, ventana: '10:00' }, ADMIN_K, K)).pedido;
    CDS.k2 = (await crearP(CDS.K.id, { platillos: 2, ventana: '11:00', modalidad: 'domicilio', direccion: 'Hidalgo 300, Centro' }, ADMIN_K, K)).pedido;
    await T.registrarPagoTemporada(K, CDS.k1.id, { monto: 500, metodo: 'transferencia', referencia: 'SPEI 123' }, { actorId: ADMIN_K });
    await T.anotarWhatsAppTemporada(K, CDS.k1.id, { tipo: 'confirmacion' }, { actorId: ADMIN_K });
    CDS.k3 = (await crearP(CDS.K.id, { platillos: 1, ventana: '12:00' }, ADMIN_K, K)).pedido;
    await T.cancelarPedidoTemporada(K, CDS.k3.id, { motivo: 'Lo pidió el cliente' }, { actorId: ADMIN_K });
    // La lista: no crea campañas y cada una va en solo lectura; el admin sí.
    const l = await T.listarCampanasAdmin(K, { usuarioId: STAFF_K, rol: 'staff' });
    assert.deepStrictEqual([l.puedeCrear, l.juntas, l.sucursales], [false, [], []]);
    assert.deepStrictEqual(l.campanas.map((c) => [c.id, c.soloLectura]), [[CDS.K.id, true]]);
    const la = await T.listarCampanasAdmin(K, { usuarioId: ADMIN_K, rol: 'admin' });
    assert.deepStrictEqual([la.puedeCrear, la.campanas.map((c) => c.soloLectura)], [true, [false]]);
    // La campaña: los pedidos iguales que los ve el admin (saldo incluido), sin montos totales, WhatsApp ni movimientos.
    const completo = await T.pedidosDeCampana(K, CDS.K.id);
    const v = await T.verCampanaTemporada(K, CDS.K.id, { usuarioId: STAFF_K, rol: 'staff' });
    assert.deepStrictEqual([v.soloLectura, v.totales], [true, null]);
    assert.deepStrictEqual(v.pedidos, completo.pedidos.map(enLectura));
    assert.strictEqual(v.pedidos.find((p) => p.id === CDS.k1.id).pago.saldo, 12 * 229 - 500, 'el saldo por cobrar sí viaja');
    assert.ok(!JSON.stringify(v).includes('SPEI 123') && v.pedidos.every((p) => p.whatsapp === null), 'se coló un movimiento o un WhatsApp');
    // Con qué morder: el administrador sí los tiene.
    const k1Admin = completo.pedidos.find((p) => p.id === CDS.k1.id);
    assert.ok(JSON.stringify(completo).includes('SPEI 123') && k1Admin.whatsapp && k1Admin.whatsapp.confirmacion && completo.totales);
    assert.deepStrictEqual([v.campana, v.ventanas], [completo.campana, completo.ventanas]);
    const va = await T.verCampanaTemporada(K, CDS.K.id, { usuarioId: ADMIN_K, rol: 'admin' });
    assert.deepStrictEqual(va, { ...completo, soloLectura: false });
    // El día junto de la encargada: solo su sucursal, en solo lectura y sin totales.
    const j = await T.pedidosJuntos(K, FCEDIS, { usuarioId: STAFF_K, rol: 'staff' });
    assert.deepStrictEqual(j.sucursales.map((s) => [s.id, s.soloLectura, s.totales]), [[K, true, null]]);
    assert.deepStrictEqual([j.soloLectura, j.totales], [true, null]);
    assert.ok(j.pedidos.every((p) => p.whatsapp === null && p.pago.movimientos.length === 0));
    const ja = await T.pedidosJuntos(K, FCEDIS, { usuarioId: ADMIN_K, rol: 'admin' });
    assert.deepStrictEqual([ja.soloLectura, ja.sucursales[0].soloLectura, ja.totales], [false, false, completo.totales]);
    // Sin rol (como llaman las rutas de administración) es admin: lo de antes no cambia.
    assert.deepStrictEqual((await T.verCampanaTemporada(K, CDS.K.id, { usuarioId: ADMIN_K })).soloLectura, false);
    // Otra sucursal no la ve nadie de O mientras no se prepare allá.
    for (const [u, rol] of [[STAFF_O, 'staff'], [ADMIN_O, 'admin']]) {
      await lanza('NO_ENCONTRADA', () => T.verCampanaTemporada(O, CDS.K.id, { usuarioId: u, rol }));
      assert.ok(!(await T.listarCampanasAdmin(O, { usuarioId: u, rol })).campanas.some((c) => c.id === CDS.K.id), rol);
    }
    for (const raro of ['abc', '', null, '1 OR 1=1', '9'.repeat(19), '999999999']) {
      await lanza('NO_ENCONTRADA', () => T.verCampanaTemporada(K, raro, { usuarioId: STAFF_K, rol: 'staff' }));
    }
  });

  await t('B42. «se prepara en»: lo fija quien administra las dos; la que prepara ve esas campañas en solo lectura y sin montos; la dueña sigue igual; se quita con null', async () => {
    CDS.O = await T.guardarCampana(O, null, base({ clave: clave('cedis-o'), fecha: FCEDIS }));
    const o1 = (await crearP(CDS.O.id, { platillos: 3, ventana: '10:00' }, ADMIN_O, O)).pedido;
    const otraK = await T.guardarCampana(K, null, base({ clave: clave('cedis-k-otra'), fecha: FCEDIS2 }));
    const fijar = (cuerpo, usuarioId, extra = {}) => T.fijarPreparacionTemporada(K, CDS.K.id, cuerpo, { usuarioId, negocioActual: K, ...extra });
    const bitacora = async () => (await pool.query(
      `SELECT usuario_id::text AS u, detalle FROM temporada_bitacora WHERE campana_id = $1 AND accion = 'preparacion_cambiada' ORDER BY id`,
      [CDS.K.id])).rows;
    // Lo que no se deja: quien no administra la de destino, la misma sucursal, basura, sin el campo, una ajena, soporte.
    await lanza('SUCURSAL_INVALIDA', () => fijar({ preparada_en: O }, ADMIN_K));
    await lanza('SUCURSAL_INVALIDA', () => fijar({ preparada_en: K }, ADMIN_OK));
    await lanza('SUCURSAL_INVALIDA', () => fijar({ preparada_en: K.toUpperCase() }, ADMIN_OK));
    await lanza('SUCURSAL_INVALIDA', () => fijar({ preparada_en: A }, ADMIN_OK));
    for (const malo of ['abc', 42, true, { id: O }, `${O}'`]) await lanza('SUCURSAL_INVALIDA', () => fijar({ preparada_en: malo }, ADMIN_OK));
    await lanza('SUCURSAL_INVALIDA', () => fijar({}, ADMIN_OK));
    await lanza('SUCURSAL_INVALIDA', () => fijar(null, ADMIN_OK));
    await lanza('SUCURSAL_INVALIDA', () => fijar({ preparada_en: O }, ADMIN_OK, { soporte: true }));
    await lanza('NO_ENCONTRADA', () => T.fijarPreparacionTemporada(O, CDS.K.id, { preparada_en: null }, { usuarioId: ADMIN_OK, negocioActual: O }));
    await lanza('NO_ENCONTRADA', () => T.fijarPreparacionTemporada(K, 'abc', { preparada_en: O }, { usuarioId: ADMIN_OK, negocioActual: K }));
    assert.strictEqual((await q1(`SELECT preparada_en FROM temporada_campanas WHERE id = $1`, [CDS.K.id])).preparada_en, null);
    assert.deepStrictEqual(await bitacora(), [], 'lo rechazado no deja rastro');
    // Quien administra las dos: queda, con quién (en mayúsculas también es la misma).
    const r = await fijar({ preparada_en: O.toUpperCase() }, ADMIN_OK);
    assert.strictEqual(r.preparada_en, O);
    assert.deepStrictEqual(await bitacora(), [{ u: String(ADMIN_OK), detalle: { antes: null, despues: O } }]);
    await fijar({ preparada_en: O }, ADMIN_OK);
    assert.strictEqual((await bitacora()).length, 1, 'lo mismo otra vez no es un cambio');
    // Guardar la configuración no la borra.
    await T.guardarCampana(K, CDS.K.id, base({ clave: clave('cedis-k'), fecha: FCEDIS, precio: 229, descripcion: 'Cambio de texto' }));
    assert.strictEqual((await q1(`SELECT preparada_en FROM temporada_campanas WHERE id = $1`, [CDS.K.id])).preparada_en, O);
    // O (encargada y admin de solo O) ve la de K en solo lectura; la otra campaña de K, no.
    const completoK = await T.pedidosDeCampana(K, CDS.K.id);
    for (const [u, rol] of [[STAFF_O, 'staff'], [ADMIN_O, 'admin']]) {
      const l = await T.listarCampanasAdmin(O, { usuarioId: u, rol });
      assert.deepStrictEqual(l.sucursales, [{ id: O, etiqueta: 'Obispado', administra: rol === 'admin' }, { id: K, etiqueta: 'Acuña', administra: false }], rol);
      assert.deepStrictEqual(l.campanas.filter((c) => c.fecha === FCEDIS || c.fecha === FCEDIS2).map((c) => [c.id, c.sucursal.etiqueta, c.soloLectura]),
        [[CDS.O.id, 'Obispado', rol !== 'admin'], [CDS.K.id, 'Acuña', true]], rol);
      assert.strictEqual(l.puedeCrear, rol === 'admin');
      assert.deepStrictEqual(l.juntas.find((x) => x.fecha === FCEDIS).sucursales, ['Obispado', 'Acuña'], rol);
      assert.ok(!l.juntas.some((x) => x.fecha === FCEDIS2), rol);
      const v = await T.verCampanaTemporada(O, CDS.K.id, { usuarioId: u, rol });
      assert.deepStrictEqual([v.soloLectura, v.totales, v.pedidos], [true, null, completoK.pedidos.map(enLectura)], rol);
      await lanza('NO_ENCONTRADA', () => T.verCampanaTemporada(O, otraK.id, { usuarioId: u, rol }));
      const j = await T.pedidosJuntos(O, FCEDIS, { usuarioId: u, rol });
      assert.deepStrictEqual(j.sucursales.map((s) => [s.etiqueta, s.soloLectura]), [['Obispado', rol !== 'admin'], ['Acuña', true]], rol);
      // Con una en solo lectura no hay totales de todas; los de O solo para su admin.
      assert.deepStrictEqual([j.totales, j.sucursales[1].totales], [null, null], rol);
      assert.deepStrictEqual(j.sucursales[0].totales, rol === 'admin' ? (await T.pedidosDeCampana(O, CDS.O.id)).totales : null, rol);
      assert.strictEqual(j.soloLectura, rol !== 'admin', rol);
      assert.deepStrictEqual(j.pedidos.map((p) => [p.id, p.sucursal.etiqueta]),
        [[o1.id, 'Obispado'], [CDS.k1.id, 'Acuña'], [CDS.k2.id, 'Acuña'], [CDS.k3.id, 'Acuña']], rol);
      assert.ok(j.pedidos.filter((p) => p.sucursal.id === K).every((p) => p.whatsapp === null && p.pago.movimientos.length === 0), rol);
      // Los cupos de K siguen siendo de K.
      assert.deepStrictEqual(j.ventanas.find((x) => x.inicio === '10:00').porSucursal.map((s) => [s.etiqueta, s.platillos, s.cupoPlatillos]),
        [['Obispado', 3, 40], ['Acuña', 12, 40]], rol);
      // Ver no es atender: lo de K, desde O, va a la sucursal de la sesión y ahí no existe.
      for (const [tipo, id] of [['campana', CDS.K.id], ['pedido', CDS.k1.id]]) {
        assert.strictEqual(await T.negocioDeRecursoTemporada(u, O, tipo, id), O, `${rol} ${tipo}`);
      }
      await lanza('NO_ENCONTRADO', () => T.cancelarPedidoTemporada(O, CDS.k1.id, { motivo: 'No es suyo' }, { actorId: u }));
    }
    // K sigue viendo solo lo suyo.
    for (const [u, rol] of [[STAFF_K, 'staff'], [ADMIN_K, 'admin']]) {
      const l = await T.listarCampanasAdmin(K, { usuarioId: u, rol });
      assert.deepStrictEqual([l.sucursales, l.juntas, l.campanas.some((c) => c.id === CDS.O.id)], [[], [], false], rol);
      await lanza('NO_ENCONTRADA', () => T.verCampanaTemporada(K, CDS.O.id, { usuarioId: u, rol }));
      assert.deepStrictEqual((await T.pedidosJuntos(K, FCEDIS, { usuarioId: u, rol })).sucursales.map((s) => s.id), [K], rol);
    }
    // Quien administra las dos lo ve todo para atenderlo, con los totales de todas.
    const ok = await T.pedidosJuntos(O, FCEDIS, { usuarioId: ADMIN_OK, rol: 'admin' });
    assert.deepStrictEqual([ok.soloLectura, ok.sucursales.map((s) => s.soloLectura)], [false, [false, false]]);
    assert.notStrictEqual(ok.totales, null);
    // Una sucursal apagada deja de verse aunque se prepare en O.
    await pool.query(`UPDATE negocios SET activo = false WHERE id = $1`, [K]);
    try {
      assert.ok(!(await T.listarCampanasAdmin(O, { usuarioId: STAFF_O, rol: 'staff' })).campanas.some((c) => c.id === CDS.K.id));
      await lanza('NO_ENCONTRADA', () => T.verCampanaTemporada(O, CDS.K.id, { usuarioId: STAFF_O, rol: 'staff' }));
      assert.deepStrictEqual((await T.pedidosJuntos(O, FCEDIS, { usuarioId: STAFF_O, rol: 'staff' })).sucursales.map((s) => s.id), [O]);
    } finally {
      await pool.query(`UPDATE negocios SET activo = true WHERE id = $1`, [K]);
    }
    // Quitarlo: O deja de verla.
    assert.strictEqual((await fijar({ preparada_en: null }, ADMIN_OK)).preparada_en, null);
    assert.deepStrictEqual((await bitacora()).map((b) => b.detalle), [{ antes: null, despues: O }, { antes: O, despues: null }]);
    assert.ok(!(await T.listarCampanasAdmin(O, { usuarioId: STAFF_O, rol: 'staff' })).campanas.some((c) => c.id === CDS.K.id));
    await lanza('NO_ENCONTRADA', () => T.verCampanaTemporada(O, CDS.K.id, { usuarioId: STAFF_O, rol: 'staff' }));
    // La base tampoco deja «se prepara en» su propia sucursal ni una que no existe.
    await assert.rejects(pool.query(`UPDATE temporada_campanas SET preparada_en = negocio_id WHERE id = $1`, [CDS.K.id]), /preparada_en_otra/);
    await assert.rejects(pool.query(`UPDATE temporada_campanas SET preparada_en = $2 WHERE id = $1`, [CDS.K.id, randomUUID()]), /preparada_en_fkey/);
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

    await t('C4. administración: sin sesión 401; la encargada (staff) solo lee, sin montos y sin crear; admin de B no ve la campaña de A', async () => {
      const lista = await http('GET', '/api/admin/temporada/campanas');
      assert.strictEqual(lista.status, 401);
      // La contraseña compartida (token del panel viejo, sin usuario) no entra ni a leer.
      const legado = (clave) => createHmac('sha256', process.env.PANEL_SECRET || 'xabor-secret-key').update(clave).digest('hex');
      for (const tk of [legado(process.env.PANEL_PASSWORD || 'xabor2024'), legado(process.env.ADMIN_PASSWORD || 'xabor-admin')]) {
        for (const ruta of ['/api/admin/temporada/campanas', `/api/admin/temporada/juntas/${FECHA}`]) {
          const r = await http('GET', ruta, { cabeceras: { Authorization: `Bearer ${tk}` } });
          assert.deepStrictEqual([r.status, /contraseña compartida/.test(r.datos && r.datos.error)], [403, true], `${ruta}: ${r.texto}`);
        }
      }
      const staff = await http('GET', '/api/admin/temporada/campanas', { cookie: COOKIES.staffA });
      assert.strictEqual(staff.status, 200, staff.texto);
      assert.strictEqual(staff.datos.puedeCrear, false);
      assert.ok(staff.datos.campanas.some((c) => c.clave === k) && staff.datos.campanas.every((c) => c.soloLectura === true));
      const admin = await http('GET', '/api/admin/temporada/campanas', { cookie: COOKIES.adminA });
      assert.strictEqual(admin.status, 200);
      assert.strictEqual(admin.datos.puedeCrear, true);
      const mia = admin.datos.campanas.find((c) => c.clave === k);
      assert.ok(mia && mia.soloLectura === false, 'el admin de A ve su campaña');
      const ajena = await http('GET', `/api/admin/temporada/campanas/${mia.id}/pedidos`, { cookie: COOKIES.adminB });
      assert.strictEqual(ajena.status, 404);
      const det = await http('GET', `/api/admin/temporada/campanas/${mia.id}/pedidos`, { cookie: COOKIES.adminA });
      assert.strictEqual(det.status, 200);
      assert.strictEqual(det.datos.soloLectura, false);
      const detStaff = await http('GET', `/api/admin/temporada/campanas/${mia.id}/pedidos`, { cookie: COOKIES.staffA });
      assert.deepStrictEqual([detStaff.status, detStaff.datos.soloLectura, detStaff.datos.totales], [200, true, null], detStaff.texto);
      assert.ok(det.datos.pedidos.length && det.datos.totales);
      assert.deepStrictEqual(detStaff.datos.pedidos.map((x) => [x.id, x.folio, x.whatsapp, x.pago.movimientos]),
        det.datos.pedidos.map((x) => [x.id, x.folio, null, []]));
      const p = det.datos.pedidos[0];
      const canB = await http('POST', `/api/admin/temporada/pedidos/${p.id}/cancelar`, { cookie: COOKIES.adminB, cuerpo: { motivo: 'Prueba de permisos' } });
      assert.strictEqual(canB.status, 404);
      const canStaff = await http('POST', `/api/admin/temporada/pedidos/${p.id}/cancelar`, { cookie: COOKIES.staffA, cuerpo: { motivo: 'Prueba de permisos' } });
      assert.strictEqual(canStaff.status, 403);
      const crearStaff = await http('POST', '/api/admin/temporada/campanas', { cookie: COOKIES.staffA, cuerpo: base({ clave: clave('staff') }) });
      assert.strictEqual(crearStaff.status, 403);
      const canA = await http('POST', `/api/admin/temporada/pedidos/${p.id}/cancelar`, { cookie: COOKIES.adminA, cuerpo: { motivo: 'Prueba de permisos' } });
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

    await t('C10. WhatsApp por HTTP: el admin recibe los textos y anota; sin sesión 401, staff 403, otro negocio 404; lo público no trae nada de esto', async () => {
      const lista = await http('GET', '/api/admin/temporada/campanas', { cookie: COOKIES.adminA });
      assert.deepStrictEqual(lista.datos.mensajesOmision, T.MENSAJES_OMISION);
      const mia = lista.datos.campanas.find((c) => c.clave === k);
      const alta = await http('POST', `/api/admin/temporada/campanas/${mia.id}/pedidos`, { cookie: COOKIES.adminA,
        cuerpo: { nombre: 'Lupe WhatsApp', telefono: '878 222 3344', platillos: 1, modalidad: 'recoger', ventana: '13:00', claveEnvio: randomUUID() } });
      assert.strictEqual(alta.status, 201, alta.texto);
      const ruta = `/api/admin/temporada/pedidos/${alta.datos.pedido.id}/whatsapp`;
      assert.strictEqual((await http('POST', ruta, { cuerpo: { tipo: 'confirmacion' } })).status, 401);
      assert.strictEqual((await http('POST', ruta, { cookie: COOKIES.staffA, cuerpo: { tipo: 'confirmacion' } })).status, 403);
      assert.strictEqual((await http('POST', ruta, { cookie: COOKIES.adminB, cuerpo: { tipo: 'confirmacion' } })).status, 404);
      const malo = await http('POST', ruta, { cookie: COOKIES.adminA, cuerpo: { tipo: 'saludo' } });
      assert.deepStrictEqual([malo.status, malo.datos.codigo], [400, 'TIPO_INVALIDO']);
      const ok = await http('POST', ruta, { cookie: COOKIES.adminA, cuerpo: { tipo: 'confirmacion' } });
      assert.deepStrictEqual([ok.status, ok.datos], [200, { ok: true, tipo: 'confirmacion' }]);
      const det = await http('GET', `/api/admin/temporada/campanas/${mia.id}/pedidos`, { cookie: COOKIES.adminA });
      const w = det.datos.pedidos.find((p) => p.id === alta.datos.pedido.id).whatsapp;
      assert.strictEqual(w.numero, '528782223344');
      assert.match(w.confirmacion, /^Hola Lupe WhatsApp, te confirmamos tu pedido TG-\d{3}:\n/);
      assert.strictEqual(w.enviado.confirmacion.por, 'Admin A');
      assert.ok(det.datos.pedidos.filter((p) => p.estado === 'cancelado').every((p) => p.whatsapp === null));
      // Un texto con un dato desconocido: 400 con el campo, para marcarlo en el formulario.
      const camp = await http('PUT', `/api/admin/temporada/campanas/${mia.id}`, { cookie: COOKIES.adminA,
        cuerpo: { ...base({ clave: k }), mensaje_confirmacion: 'Hola {cliente}' } });
      assert.deepStrictEqual([camp.status, camp.datos.codigo, camp.datos.campo], [400, 'MENSAJE_INVALIDO', 'mensaje_confirmacion']);
      assert.match(camp.datos.error, /\{cliente\}/);
      const pub = await http('GET', `/api/temporada/${k}`);
      assert.strictEqual(pub.status, 200);
      for (const prohibido of ['mensaje_', 'whatsapp', 'wa.me', 'enviado', 'Lupe', '528782223344']) {
        assert.ok(!pub.texto.includes(prohibido), `expone ${prohibido}`);
      }
    });

    await t('C11. cancelar y restaurar por HTTP: sin motivo 400; sin sesión 401, staff 403, otro negocio 404; restaurar sin lugar 409', async () => {
      const mia = (await http('GET', '/api/admin/temporada/campanas', { cookie: COOKIES.adminA })).datos.campanas.find((c) => c.clave === k);
      const alta = await http('POST', `/api/admin/temporada/campanas/${mia.id}/pedidos`, { cookie: COOKIES.adminA,
        cuerpo: { nombre: 'Rita Cancela', telefono: '878 333 4455', platillos: 1, modalidad: 'recoger', ventana: '15:00', claveEnvio: randomUUID() } });
      assert.strictEqual(alta.status, 201, alta.texto);
      const id = alta.datos.pedido.id;
      const can = `/api/admin/temporada/pedidos/${id}/cancelar`, res = `/api/admin/temporada/pedidos/${id}/restaurar`;
      const motivo = { motivo: 'Lo pidió el cliente' };
      const sinMotivo = await http('POST', can, { cookie: COOKIES.adminA, cuerpo: {} });
      assert.deepStrictEqual([sinMotivo.status, sinMotivo.datos.codigo, sinMotivo.datos.campo], [400, 'MOTIVO_REQUERIDO', 'motivo']);
      assert.strictEqual((await http('POST', can, { cuerpo: motivo })).status, 401);
      assert.strictEqual((await http('POST', can, { cookie: COOKIES.staffA, cuerpo: motivo })).status, 403);
      assert.strictEqual((await http('POST', can, { cookie: COOKIES.adminB, cuerpo: motivo })).status, 404);
      assert.strictEqual((await http('POST', can, { cookie: COOKIES.adminA, cuerpo: motivo })).status, 200);
      const det = await http('GET', `/api/admin/temporada/campanas/${mia.id}/pedidos`, { cookie: COOKIES.adminA });
      const x = det.datos.pedidos.find((p) => p.id === id).cancelacion;
      assert.deepStrictEqual([x.motivo, x.por], ['Lo pidió el cliente', 'Admin A']);
      assert.strictEqual((await http('POST', res, {})).status, 401);
      assert.strictEqual((await http('POST', res, { cookie: COOKIES.staffA, cuerpo: {} })).status, 403);
      assert.strictEqual((await http('POST', res, { cookie: COOKIES.adminB, cuerpo: {} })).status, 404);
      const ok = await http('POST', res, { cookie: COOKIES.adminA, cuerpo: {} });
      assert.deepStrictEqual([ok.status, ok.datos], [200, { ok: true, folio: alta.datos.pedido.folio }]);
      const otra = await http('POST', res, { cookie: COOKIES.adminA, cuerpo: {} });
      assert.deepStrictEqual([otra.status, otra.datos.codigo], [409, 'NO_CANCELADO']);
      // Sin lugar: 409 con lo que queda libre, y el pedido sigue cancelado.
      const chica = await http('POST', '/api/admin/temporada/campanas', { cookie: COOKIES.adminA,
        cuerpo: base({ clave: clave('http-restaurar'), cupo_platillos: 2, max_platillos_pedido: 2 }) });
      assert.strictEqual(chica.status, 201, chica.texto);
      const capt = (n) => http('POST', `/api/admin/temporada/campanas/${chica.datos.campana.id}/pedidos`, { cookie: COOKIES.adminA,
        cuerpo: { nombre: `Cliente ${n}`, telefono: '878 333 4455', platillos: 2, modalidad: 'recoger', ventana: '09:00', claveEnvio: randomUUID() } });
      const primero = (await capt(1)).datos.pedido.id;
      assert.strictEqual((await http('POST', `/api/admin/temporada/pedidos/${primero}/cancelar`, { cookie: COOKIES.adminA, cuerpo: motivo })).status, 200);
      assert.strictEqual((await capt(2)).status, 201);
      const lleno = await http('POST', `/api/admin/temporada/pedidos/${primero}/restaurar`, { cookie: COOKIES.adminA, cuerpo: {} });
      assert.deepStrictEqual([lleno.status, lleno.datos.codigo, lleno.datos.libres], [409, 'SIN_CUPO', 0]);
      // Lo público no trae quién canceló ni por qué.
      const pub = await http('GET', `/api/temporada/${k}`);
      for (const prohibido of ['cancelacion', 'Lo pidió el cliente', 'Rita', 'restaur']) assert.ok(!pub.texto.includes(prohibido), `expone ${prohibido}`);
    });

    await t('C12. todas las sucursales por HTTP: el admin de las dos ve y atiende lo de B desde A; el de solo A, el cajero de B y soporte no; sin sesión 401; la encargada solo lee lo suyo', async () => {
      const FJC = await enDias(31);
      const kJA = clave('http-juntas-a'), kJB = clave('http-juntas-b');
      const CJA = await T.guardarCampana(A, null, base({ clave: kJA, fecha: FJC }));
      const CJB = await T.guardarCampana(B, null, base({ clave: kJB, fecha: FJC, precio: 300 }));
      const { crearSesionSoporte } = await import('../src/services/centralOperaciones.js');
      const soporte = (await crearSesionSoporte(SUPER, A, 'prueba de temporada')).token;
      const ck = { ab: COOKIES.adminAB, a: COOKIES.adminA, mixto: COOKIES.mixto, soporte };
      const juntas = `/api/admin/temporada/juntas/${FJC}`;
      // La lista: B con su etiqueta y el día para verlas juntas.
      const lista = await http('GET', '/api/admin/temporada/campanas', { cookie: ck.ab });
      assert.strictEqual(lista.status, 200, lista.texto);
      assert.deepStrictEqual(lista.datos.sucursales.map((s) => s.etiqueta), ['A', 'B']);
      assert.ok(lista.datos.juntas.some((j) => j.id === `juntas:${FJC}`));
      assert.deepStrictEqual(lista.datos.campanas.find((c) => c.clave === kJB).sucursal, { id: B, etiqueta: 'B' });
      // Agenda en B desde la sesión de A: el pedido queda en B, con quién.
      const alta = await http('POST', `/api/admin/temporada/campanas/${CJB.id}/pedidos`, { cookie: ck.ab,
        cuerpo: { nombre: 'Lola Sucursal', telefono: '878 444 5566', platillos: 1, modalidad: 'recoger', ventana: '10:00', claveEnvio: randomUUID() } });
      assert.strictEqual(alta.status, 201, alta.texto);
      const bp = alta.datos.pedido.id;
      const fila = await q1(`SELECT negocio_id, creado_por FROM temporada_pedidos WHERE id = $1`, [bp]);
      assert.deepStrictEqual([fila.negocio_id, String(fila.creado_por)], [B, String(ADMIN_AB)]);
      const j = await http('GET', juntas, { cookie: ck.ab });
      assert.strictEqual(j.status, 200, j.texto);
      assert.deepStrictEqual(j.datos.sucursales.map((s) => [s.etiqueta, s.campana.id]), [['A', CJA.id], ['B', CJB.id]]);
      const enJuntas = j.datos.pedidos.find((p) => p.id === bp);
      assert.deepStrictEqual([enJuntas.sucursal, enJuntas.campana_id, enJuntas.creado_por], [{ id: B, etiqueta: 'B' }, CJB.id, 'Admin Ambas']);
      // Todo lo de un pedido de B, desde A.
      const ped = `/api/admin/temporada/pedidos/${bp}`;
      const det = await http('GET', `/api/admin/temporada/campanas/${CJB.id}/pedidos`, { cookie: ck.ab });
      assert.strictEqual(det.status, 200, det.texto);
      const visto = det.datos.pedidos.find((p) => p.id === bp);
      const antes = { nombre: visto.nombre, telefono: visto.telefono, platillos: visto.platillos, ventana: visto.ventana.inicio,
        modalidad: visto.modalidad, direccion: visto.direccion, referencias: visto.referencias, notas: visto.notas };
      const conf = base({ clave: kJB, fecha: FJC, precio: 300, descripcion: 'Cambiada desde la sesión de A' });
      const pasos = [
        ['PUT', `/api/admin/temporada/campanas/${CJB.id}`, conf, 200],
        ['POST', `${ped}/pagos`, { monto: 100, metodo: 'efectivo' }, 201],
        ['POST', `${ped}/entrega`, { estado: 'en_preparacion', desde: 'agendado' }, 200],
        ['POST', `${ped}/editar`, { ...antes, platillos: 2, antes }, 200],
        ['POST', `${ped}/whatsapp`, { tipo: 'confirmacion' }, 200],
        ['GET', `${ped}/historial`, undefined, 200],
      ];
      // Antes, el de solo A, el cajero de B y soporte (admin de B) no llegan a nada de esto.
      for (const quien of ['a', 'mixto', 'soporte']) {
        for (const [m, ruta, cuerpo] of pasos) {
          const r = await http(m, ruta, { cookie: ck[quien], cuerpo });
          assert.strictEqual(r.status, 404, `${quien} ${m} ${ruta}: ${r.status} ${r.texto}`);
        }
        for (const ruta of [`/api/admin/temporada/campanas/${CJB.id}/pedidos`, `${ped}/cancelar`]) {
          const r = await http(ruta.endsWith('/pedidos') ? 'GET' : 'POST', ruta, { cookie: ck[quien], cuerpo: ruta.endsWith('/pedidos') ? undefined : { motivo: 'No es suyo' } });
          assert.strictEqual(r.status, 404, `${quien} ${ruta}`);
        }
        const l = await http('GET', '/api/admin/temporada/campanas', { cookie: ck[quien] });
        assert.strictEqual(l.status, 200, `${quien}: ${l.texto}`);
        assert.deepStrictEqual([l.datos.juntas, l.datos.sucursales, l.datos.campanas.some((c) => c.clave === kJB)], [[], [], false], quien);
        const s = await http('GET', juntas, { cookie: ck[quien] });
        assert.strictEqual(s.status, 200, `${quien}: ${s.texto}`);
        assert.deepStrictEqual(s.datos.sucursales.map((x) => x.id), [A], quien);
        assert.ok(s.datos.pedidos.every((p) => p.sucursal.id === A), quien);
      }
      let pagoId = null;
      for (const [m, ruta, cuerpo, esperado] of pasos) {
        const r = await http(m, ruta, { cookie: ck.ab, cuerpo });
        assert.strictEqual(r.status, esperado, `${m} ${ruta}: ${r.texto}`);
        if (ruta.endsWith('/pagos')) pagoId = r.datos.pagoId;
      }
      assert.strictEqual((await q1(`SELECT descripcion FROM temporada_campanas WHERE id = $1`, [CJB.id])).descripcion, 'Cambiada desde la sesión de A');
      const anular = `/api/admin/temporada/pagos/${pagoId}/anular`;
      for (const quien of ['a', 'mixto', 'soporte']) {
        assert.strictEqual((await http('POST', anular, { cookie: ck[quien], cuerpo: { motivo: 'No es suyo' } })).status, 404, quien);
      }
      assert.strictEqual((await http('POST', anular, { cookie: ck.ab, cuerpo: { motivo: 'Me equivoqué de pedido' } })).status, 200);
      assert.strictEqual((await http('POST', `${ped}/cancelar`, { cookie: ck.ab, cuerpo: { motivo: 'Lo pidió el cliente' } })).status, 200);
      for (const quien of ['a', 'mixto', 'soporte']) {
        assert.strictEqual((await http('POST', `${ped}/restaurar`, { cookie: ck[quien], cuerpo: {} })).status, 404, quien);
      }
      assert.strictEqual((await http('POST', `${ped}/restaurar`, { cookie: ck.ab, cuerpo: {} })).status, 200);
      // Todo quedó en B, con quién lo hizo.
      const bit = (await pool.query(`SELECT DISTINCT negocio_id, usuario_id::text AS u FROM temporada_bitacora WHERE pedido_id = $1`, [bp])).rows;
      assert.deepStrictEqual(bit, [{ negocio_id: B, u: String(ADMIN_AB) }]);
      assert.strictEqual((await q1(`SELECT negocio_id FROM temporada_pagos WHERE id = $1`, [pagoId])).negocio_id, B);
      const final = await q1(`SELECT estado, platillos, estado_entrega FROM temporada_pedidos WHERE id = $1`, [bp]);
      assert.deepStrictEqual([final.estado, final.platillos, final.estado_entrega], ['confirmado', 2, 'en_preparacion']);
      // Una campaña nueva nace en la sucursal de la sesión.
      const nueva = await http('POST', '/api/admin/temporada/campanas', { cookie: ck.ab, cuerpo: base({ clave: clave('http-juntas-nueva'), fecha: FJC }) });
      assert.strictEqual(nueva.status, 201, nueva.texto);
      assert.strictEqual((await q1(`SELECT negocio_id FROM temporada_campanas WHERE id = $1`, [nueva.datos.campana.id])).negocio_id, A);
      // Permisos y fechas raras.
      assert.strictEqual((await http('GET', juntas)).status, 401);
      const sj = await http('GET', juntas, { cookie: COOKIES.staffA });
      assert.strictEqual(sj.status, 200, sj.texto);
      assert.ok(sj.datos.sucursales.length && sj.datos.sucursales.every((x) => x.id === A && x.soloLectura === true && x.totales === null));
      assert.deepStrictEqual([sj.datos.soloLectura, sj.datos.totales], [true, null]);
      assert.ok(!sj.datos.pedidos.some((p) => p.sucursal.id === B));
      for (const f of ['2026-02-30', 'abc', await enDias(35)]) {
        const r = await http('GET', `/api/admin/temporada/juntas/${encodeURIComponent(f)}`, { cookie: ck.ab });
        assert.deepStrictEqual([r.status, r.datos && r.datos.codigo], [404, 'NO_ENCONTRADA'], f);
      }
      // Lo público de B sigue igual: sin sucursales ni negocios.
      const pub = await http('GET', `/api/temporada/${kJB}`);
      assert.strictEqual(pub.status, 200);
      // (La clave pública de la prueba dice «juntas»: se buscan las llaves, no la palabra.)
      for (const prohibido of ['sucursal', '"juntas"', 'porSucursal', A, B, 'Admin Ambas', 'Lola']) assert.ok(!pub.texto.includes(prohibido), `expone ${prohibido}`);
    });

    await t('C13. CEDIS por HTTP: «se prepara en» lo fija solo quien administra las dos; Obispado ve lo de Acuña sin montos y sin atenderlo; Acuña ve solo lo suyo; se quita', async () => {
      const FC = await enDias(42);
      const kK = clave('http-cedis-k'), kO = clave('http-cedis-o');
      const CK = await T.guardarCampana(K, null, base({ clave: kK, fecha: FC, precio: 229 }));
      await T.guardarCampana(O, null, base({ clave: kO, fecha: FC }));
      const kp = (await T.crearPedidoPanel(K, CK.id, { nombre: 'Marta Cedis', telefono: '878 555 6677', platillos: 11,
        modalidad: 'recoger', ventana: '10:00', claveEnvio: randomUUID() }, { actorId: ADMIN_K })).pedido;
      await T.registrarPagoTemporada(K, kp.id, { monto: 300, metodo: 'efectivo' }, { actorId: ADMIN_K });
      const prep = `/api/admin/temporada/campanas/${CK.id}/preparacion`;
      const detK = `/api/admin/temporada/campanas/${CK.id}/pedidos`;
      // Quién no lo fija: sin sesión, las encargadas, el admin de solo Acuña (400) y el de solo Obispado (no es suya: 404).
      assert.strictEqual((await http('PUT', prep, { cuerpo: { preparada_en: O } })).status, 401);
      for (const q of ['staffK', 'staffO']) assert.strictEqual((await http('PUT', prep, { cookie: COOKIES[q], cuerpo: { preparada_en: O } })).status, 403, q);
      const soloK = await http('PUT', prep, { cookie: COOKIES.adminK, cuerpo: { preparada_en: O } });
      assert.deepStrictEqual([soloK.status, soloK.datos.codigo], [400, 'SUCURSAL_INVALIDA']);
      for (const cuerpo of [{ preparada_en: O }, { preparada_en: 'abc' }, {}]) {
        const r = await http('PUT', prep, { cookie: COOKIES.adminO, cuerpo });
        assert.deepStrictEqual([r.status, r.datos.codigo], [404, 'NO_ENCONTRADA'], JSON.stringify(cuerpo));
      }
      for (const cuerpo of [{ preparada_en: 'abc' }, {}, { preparada_en: K }]) {
        const r = await http('PUT', prep, { cookie: COOKIES.adminOK, cuerpo });
        assert.deepStrictEqual([r.status, r.datos.codigo], [400, 'SUCURSAL_INVALIDA'], JSON.stringify(cuerpo));
      }
      // Antes de fijarlo, Obispado no ve nada de Acuña.
      for (const q of ['staffO', 'adminO']) assert.strictEqual((await http('GET', detK, { cookie: COOKIES[q] })).status, 404, q);
      const ok = await http('PUT', prep, { cookie: COOKIES.adminOK, cuerpo: { preparada_en: O } });
      assert.deepStrictEqual([ok.status, ok.datos.campana.preparada_en], [200, O], ok.texto);
      // Obispado (encargada y admin) la ve: lista, detalle y el día junto, sin montos totales, movimientos ni WhatsApp.
      for (const q of ['staffO', 'adminO']) {
        const l = await http('GET', '/api/admin/temporada/campanas', { cookie: COOKIES[q] });
        assert.strictEqual(l.status, 200, l.texto);
        const c = l.datos.campanas.find((x) => x.id === CK.id);
        assert.deepStrictEqual([c && c.soloLectura, c && c.sucursal.etiqueta], [true, 'Acuña'], q);
        assert.ok(l.datos.juntas.some((j) => j.fecha === FC), q);
        const d = await http('GET', detK, { cookie: COOKIES[q] });
        assert.deepStrictEqual([d.status, d.datos.soloLectura, d.datos.totales], [200, true, null], q);
        const vp = d.datos.pedidos.find((x) => x.id === kp.id);
        assert.deepStrictEqual([vp.nombre, vp.platillos, vp.pago.saldo, vp.whatsapp, vp.pago.movimientos],
          ['Marta Cedis', 11, 11 * 229 - 300, null, []], q);
        const j = await http('GET', `/api/admin/temporada/juntas/${FC}`, { cookie: COOKIES[q] });
        assert.deepStrictEqual([j.status, j.datos.totales, j.datos.sucursales.map((s) => [s.etiqueta, s.soloLectura])],
          [200, null, [['Obispado', q === 'staffO'], ['Acuña', true]]], q);
        // Ver no es atender: nada de lo de Acuña se escribe desde Obispado.
        const ped = `/api/admin/temporada/pedidos/${kp.id}`;
        const intentos = [
          ['POST', `${ped}/cancelar`, { motivo: 'No es suyo' }], ['POST', `${ped}/pagos`, { monto: 100, metodo: 'efectivo' }],
          ['POST', `${ped}/entrega`, { estado: 'en_preparacion', desde: 'agendado' }], ['POST', `${ped}/whatsapp`, { tipo: 'confirmacion' }],
          ['GET', `${ped}/historial`, undefined], ['PUT', `/api/admin/temporada/campanas/${CK.id}`, base({ clave: kK, fecha: FC })],
          ['POST', `/api/admin/temporada/campanas/${CK.id}/pedidos`, { nombre: 'Intruso', telefono: '878 000 1122', platillos: 1,
            modalidad: 'recoger', ventana: '10:00', claveEnvio: randomUUID() }],
          ['PUT', prep, { preparada_en: null }],
        ];
        for (const [m, ruta, cuerpo] of intentos) {
          const r = await http(m, ruta, { cookie: COOKIES[q], cuerpo });
          assert.strictEqual(r.status, q === 'staffO' ? 403 : 404, `${q} ${m} ${ruta}: ${r.status} ${r.texto}`);
        }
      }
      const fila = await q1(`SELECT estado, estado_entrega, platillos, preparada_en FROM temporada_pedidos p
        JOIN temporada_campanas c ON c.id = p.campana_id WHERE p.id = $1`, [kp.id]);
      assert.deepStrictEqual([fila.estado, fila.estado_entrega, fila.platillos, fila.preparada_en], ['confirmado', 'agendado', 11, O]);
      assert.strictEqual((await q1(`SELECT COUNT(*)::int AS n FROM temporada_pagos WHERE pedido_id = $1`, [kp.id])).n, 1);
      // Acuña ve solo lo suyo; quien administra las dos lo atiende todo.
      for (const q of ['staffK', 'adminK']) {
        const l = await http('GET', '/api/admin/temporada/campanas', { cookie: COOKIES[q] });
        assert.deepStrictEqual([l.status, l.datos.sucursales, l.datos.campanas.some((c) => c.clave === kO)], [200, [], false], q);
        const j = await http('GET', `/api/admin/temporada/juntas/${FC}`, { cookie: COOKIES[q] });
        assert.deepStrictEqual([j.status, j.datos.sucursales.map((s) => s.id)], [200, [K]], q);
      }
      const todo = await http('GET', `/api/admin/temporada/juntas/${FC}`, { cookie: COOKIES.adminOK });
      assert.deepStrictEqual([todo.status, todo.datos.soloLectura, todo.datos.sucursales.map((s) => s.soloLectura)], [200, false, [false, false]]);
      assert.notStrictEqual(todo.datos.totales, null);
      // Lo público no trae «se prepara en».
      const pub = await http('GET', `/api/temporada/${kK}`);
      assert.strictEqual(pub.status, 200);
      for (const prohibido of ['preparada', O, K, 'Obispado', 'soloLectura']) assert.ok(!pub.texto.includes(prohibido), `expone ${prohibido}`);
      // Quitarlo: Obispado deja de verla.
      const quitar = await http('PUT', prep, { cookie: COOKIES.adminOK, cuerpo: { preparada_en: null } });
      assert.deepStrictEqual([quitar.status, quitar.datos.campana.preparada_en], [200, null], quitar.texto);
      assert.strictEqual((await http('GET', detK, { cookie: COOKIES.staffO })).status, 404);
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
  const panelHtml = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');

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
    // La única mención: dentro del marco del panel, la ventana de arriba (que
    // ya es /app) va al login y regresa a /app#temporada; no se abre otro
    // panel. Abierta sola (la liga de la tableta), regresa a /temporada.
    const login = "encodeURIComponent(enPanel ? '/app#temporada' : '/temporada');\n    (enPanel ? window.top.location : location).href = destino;";
    assert.strictEqual(admin.split(login).length, 2, 'cambió el regreso del login');
    assert.ok(!/['"]\/app['"#]/.test(admin.replace(login, '')), 'la página abre /app');
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

  await t('D5c. la 141 («se prepara en») va en el predeploy una vez, después de la 140, sola con su número y con reversa', async () => {
    const runner = readFileSync(join(__dirname, '..', 'scripts', 'predeploy-run-032-033.mjs'), 'utf8');
    const lista = runner.slice(runner.indexOf('const SCRIPTS = ['), runner.indexOf('];', runner.indexOf('const SCRIPTS = [')));
    const i140 = lista.indexOf("'140-restaurante-candado-precuenta'");
    const i141 = lista.indexOf("'141-temporada-preparada-en'");
    assert.ok(i140 > 0 && i141 > i140, 'la 141 no está en SCRIPTS o va antes de la 140');
    assert.strictEqual(lista.split("'141-temporada-preparada-en'").length, 2, 'una sola vez');
    assert.ok(readdirSync(join(__dirname, '..', 'scripts')).includes('predeploy-141-temporada-preparada-en.mjs'));
    const mismas = readdirSync(join(__dirname, '..', 'migrations')).filter((f) => /^141_/.test(f));
    assert.deepStrictEqual(mismas.sort(), ['141_temporada_preparada_en.sql', '141_temporada_preparada_en_down.sql']);
    const sube = readFileSync(join(__dirname, '..', 'migrations', '141_temporada_preparada_en.sql'), 'utf8');
    assert.match(sube, /ADD COLUMN IF NOT EXISTS preparada_en uuid NULL/);
    assert.match(sube, /REFERENCES negocios\s*\(id\) ON DELETE RESTRICT/);
    assert.match(sube, /preparada_en IS NULL OR preparada_en <> negocio_id/);
    const reversa = readFileSync(join(__dirname, '..', 'migrations', '141_temporada_preparada_en_down.sql'), 'utf8');
    assert.match(reversa, /^\\set ON_ERROR_STOP on$/m);
    assert.match(reversa, /ANTES DE CORRERLA: revertir primero el código/);
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
    // Y cada pedido con precio trae su pago: a la vista si no ha pagado, o en el menú ⋯.
    assert.match(admin, /opcion\(can \|\| liquidado \? 'Ver pagos' : 'Registrar pago', \(\) => abrirPago\(p\.id\)\)/);
    assert.match(admin, /if \(paso === 'agendado' && conTotal\(p\) && p\.pago\.estado === 'sin_pago'\) \{\s*const b = el\('button', \{ class: 'chico accion', type: 'button', text: 'Registrar pago' \}\);/);
  });

  await t('D7. entrega en la página: manda el paso que veía, avisa si entrega con saldo, «solo pendientes» y contador', async () => {
    const mover = admin.slice(admin.indexOf('async function moverEntrega('), admin.indexOf('async function moverEntrega(') + 1800);
    // El servidor decide con el paso que se veía (dos tabletas no se pisan).
    assert.match(mover, /body: JSON\.stringify\(\{ estado: a, desde \}\)/);
    assert.match(mover, /const desde = pasoDe\(p\);/);
    // Entregar con saldo pide confirmación, y la negativa lleva a cobrar.
    assert.match(mover, /a === 'entregado' && conTotal\(p\) && p\.pago\.saldo > 0 &&\s*!confirm\(/);
    assert.match(mover, /abrirPago\(p\.id\);\s*return;/);
    // Un cancelado no tiene botón de avance: su acción es «Restaurar» y el menú
    // solo avanza o regresa confirmados.
    const accion = admin.slice(admin.indexOf('function accionPrincipal('), admin.indexOf('// ── Menú ⋯'));
    assert.match(accion, /if \(p\.estado === 'cancelado'\) \{[\s\S]{0,220}?return \{ tipo: 'restaurar', nodo: r \};\s*\}/);
    assert.ok(accion.indexOf('moverEntrega(') > accion.indexOf("tipo: 'restaurar'"), 'avance antes de descartar cancelados');
    const menu = admin.slice(admin.indexOf('function menuPedido('), admin.indexOf('// Lo que se ve al abrir la fila.'));
    assert.ok(menu.length > 500 && menu.indexOf('moverEntrega(') > menu.indexOf('if (!can) {'), 'el menú avanza un cancelado');
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
    assert.match(admin, /if \(\$\('dlgPago'\)\.open \|\| \$\('dlgPedido'\)\.open \|\| \$\('dlgCancelar'\)\.open\) return;/);
    // Ni con un menú ⋯ abierto (se borraría al volver a pintar).
    assert.match(admin, /if \(menuAbierto\) return;\s*cargarCampanas\(estado\.actual\.id\)\.catch/);
    // «Editar» solo en confirmados.
    const menu = admin.slice(admin.indexOf('function menuPedido('), admin.indexOf('// Lo que se ve al abrir la fila.'));
    assert.ok(menu.indexOf("opcion('Editar', () => abrirPedido(p.id))") > menu.indexOf('if (!can) {'), '«Editar» fuera de los confirmados');
    assert.match(admin, /if \(id && \(!p \|\| p\.estado !== 'confirmado'\)\) return;/);
  });

  await t('D9. totales en la página: los escribe tal como llegan, sin sumar; el Excel trae los montos y un cancelado sin total ni saldo', async () => {
    // Arriba: lo que manda el servidor, sin cuentas aquí.
    assert.match(admin, /pintarPesos\(estado\.detalle\.totales\);/);
    const pesos = admin.slice(admin.indexOf('function pintarPesos('), admin.indexOf('function pintarSucursales('));
    assert.ok(pesos.length > 200, 'no está pintarPesos');
    for (const campo of ['t.venta', 't.cobrado', 't.porCobrar', 't.porDevolver']) assert.ok(pesos.includes(campo), `no muestra ${campo}`);
    assert.match(pesos, /if \(!t \|\| \(t\.venta === null && !\(t\.cobrado > 0\)\)\) \{ caja\.classList\.add\('oculto'\);/, 'sin precio debe ocultarse');
    // «Cobrado $X de $Y» en un solo dato, y «por devolver» solo si hay.
    assert.match(pesos, /`cobrado \$\{dinero\(t\.cobrado\)\} de \$\{dinero\(t\.venta\)\}`/);
    assert.match(pesos, /if \(t\.porDevolver > 0\) notas\.push\(/, '«por devolver» solo si hay');
    assert.ok(!/reduce\(|[+\-]\s*t\.|t\.\w+\s*[+\-*/]/.test(pesos), 'la página hace cuentas con los totales');
    // La tabla por sucursal escribe los montos del servidor; solo cuenta platillos.
    const sucs = admin.slice(admin.indexOf('function pintarSucursales('), admin.indexOf('function medidor('));
    assert.ok(sucs.length > 300, 'no está pintarSucursales');
    assert.ok(!/[+\-]\s*t\.|t\.\w+\s*[+\-*/]/.test(sucs), 'la tabla por sucursal hace cuentas con los montos');
    assert.deepStrictEqual(sucs.match(/reduce\([^;]*/g), ['reduce((n, p) => n + p.platillos, 0), conPrecio = !!t && t.venta !== null'], 'la tabla suma algo que no son platillos');
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

  await t('D10. WhatsApp en la página: el enlace sale solo de lo que armó el servidor, abre wa.me aparte y se anota; los textos se editan en la campaña', async () => {
    const wa = admin.slice(admin.indexOf('function itemsWhatsApp('), admin.indexOf('function anotarWhatsApp('));
    assert.ok(wa.length > 300, 'no está itemsWhatsApp');
    // Nada para un cancelado (el servidor manda null) y el enlace con el número y el texto tal como llegan.
    assert.match(wa, /const w = p\.whatsapp;\s*if \(!w\) return \[\];/);
    assert.match(wa, /href: `https:\/\/wa\.me\/\$\{w\.numero\}\?text=\$\{encodeURIComponent\(w\[tipo\] \|\| ''\)\}`/);
    assert.match(wa, /target: '_blank', rel: 'noopener noreferrer'/);
    assert.match(wa, /if \(!w\.numero\) \{/, 'sin número no hay enlace');
    // Van en el menú ⋯, que no sale en papel.
    assert.match(wa, /class: 'm-item wa noimprimir'/, 'los botones no salen en papel');
    assert.match(admin, /\.p-accion, \.p-menu, \.menu \{ display:none !important; \}/);
    assert.ok(!/window\.open|location\.href/.test(wa), 'abre WhatsApp sin enlace');
    // La página no arma mensajes: ningún reemplazo de {campo} en todo el archivo.
    assert.ok(!/replace\(\s*\/\\\{/.test(admin) && !/replaceAll\(\s*['"`]\{/.test(admin), 'la página reemplaza plantillas');
    // Al abrirlo se anota (keepalive: el celular se va a WhatsApp) y un fallo solo avisa.
    const anota = admin.slice(admin.indexOf('function anotarWhatsApp('), admin.indexOf('// ── Entrega'));
    assert.match(anota, /api\(`\$\{API\}\/pedidos\/\$\{encodeURIComponent\(p\.id\)\}\/whatsapp`, \{ method: 'POST', body: JSON\.stringify\(\{ tipo \}\), keepalive: true \}\)/);
    assert.match(wa, /a\.addEventListener\('click', \(\) => anotarWhatsApp\(p, tipo\)\);/);
    assert.ok(!/preventDefault/.test(wa), 'el clic debe seguir abriendo el enlace');
    // En el menú, solo para confirmados.
    const menu = admin.slice(admin.indexOf('function menuPedido('), admin.indexOf('// Lo que se ve al abrir la fila.'));
    assert.ok(menu.indexOf('items.push(...itemsWhatsApp(p));') > menu.indexOf('if (!can) {'), 'WhatsApp fuera de los confirmados');
    // Configuración: los dos textos van al guardar, con el tope de la base, y el botón para volver al de Xabor.
    for (const tipo of ['confirmacion', 'recordatorio']) {
      assert.match(admin, new RegExp(`<textarea name="mensaje_${tipo}" maxlength="1500"`));
      assert.match(admin, new RegExp(`mensaje_${tipo}: f\\.elements\\.mensaje_${tipo}\\.value,`));
    }
    assert.match(admin, /f\.elements\['mensaje_' \+ t\]\.value = v\['mensaje_' \+ t\] \|\| estado\.mensajesOmision\[t\] \|\| '';/);
    assert.match(admin, /\$\('btnMensajesOmision'\)\.addEventListener\('click'/);
    // El historial nombra lo anotado.
    assert.match(admin, /ev\.accion === 'whatsapp_confirmacion'/);
    assert.match(admin, /ev\.accion === 'whatsapp_recordatorio'/);
  });

  await t('D11. cancelar en la página: al final del menú ⋯ y en rojo, ventana con folio y cliente, motivo obligatorio; «Restaurar» solo en cancelados y lo decide el servidor', async () => {
    // La fila no lleva nada rojo ni cancela directo: «Cancelar» está en el menú ⋯.
    const fila = admin.slice(admin.indexOf('function filaPedido('), admin.indexOf('function celdaSaldo('));
    assert.ok(fila.length > 500, 'no está filaPedido');
    assert.ok(!/peligro|abrirCancelar|\/cancelar/.test(fila), 'cancelar quedó a la vista en la fila');
    // En el menú: separado, en rojo, lo último, y abre la ventana que pide el motivo.
    const menu = admin.slice(admin.indexOf('function menuPedido('), admin.indexOf('// Lo que se ve al abrir la fila.'));
    assert.match(menu, /items\.push\(el\('div', \{ class: 'm-sep', role: 'separator' \}\), opcion\(`Cancelar \$\{p\.folio\}…`, \(\) => abrirCancelar\(p\), 'peligro'\)\);/);
    assert.ok(!menu.slice(menu.indexOf("abrirCancelar(p), 'peligro'")).includes('items.push'), '«Cancelar» no es lo último del menú');
    assert.strictEqual((admin.match(/(?<!function )abrirCancelar\(/g) || []).length, 1, 'otro camino abre Cancelar');
    assert.ok(!/api\(`\$\{API\}\/pedidos\/\$\{encodeURIComponent\(p\.id\)\}\/cancelar`/.test(menu), 'el menú cancela sin la ventana');
    // (en rojo: el tono oscuro del rojo de marca, para leerse sobre blanco)
    assert.match(admin, /\.menu \.m-item\.peligro \{ color:var\(--rojo-tx\); \}/);
    assert.match(admin, /--rojo:#ef4444; --rojo-bg:#fef2f2; --rojo-tx:#b91c1c;/);
    // «Restaurar» es la acción a la vista de un cancelado.
    assert.match(admin, /if \(p\.estado === 'cancelado'\) \{\s*const r = el\('button', \{ class: 'chico', type: 'button', text: 'Restaurar' \}\);/);
    const can = admin.slice(admin.indexOf('// ── Cancelar y restaurar'), admin.indexOf('async function restaurar('));
    // La ventana dice folio y cliente, y no se manda sin motivo.
    assert.match(can, /\$\('dlgCancelarTitulo'\)\.textContent = `¿Cancelar \$\{p\.folio\} de \$\{p\.nombre\}\?`;/);
    assert.match(can, /\$\('btnConfirmarCancelar'\)\.textContent = `Sí, cancelar \$\{p\.folio\}`;/);
    assert.match(can, /\$\('btnConfirmarCancelar'\)\.disabled = true;/);
    assert.match(can, /if \(!p \|\| largoMotivo\(\) < 3\) return;/);
    assert.match(can, /body: JSON\.stringify\(\{ motivo: \$\('formCancelar'\)\.elements\.motivo\.value \}\)/);
    assert.match(admin, /<textarea name="motivo" maxlength="300"/);
    assert.ok(!/confirm\(`¿Cancelar/.test(admin), 'quedó la confirmación vieja');
    // Un cancelado dice quién, cuándo y por qué.
    assert.match(can, /x\.motivo \? `\\nMotivo: \$\{x\.motivo\}` : ''/);
    // Restaurar pregunta antes y no mide el cupo aquí: lo decide el servidor.
    const res = admin.slice(admin.indexOf('async function restaurar('), admin.indexOf('// ── WhatsApp al cliente'));
    assert.ok(res.length > 200, 'no está restaurar');
    assert.match(res, /if \(!confirm\(`¿Restaurar \$\{p\.folio\} de \$\{p\.nombre\}\?/);
    assert.match(res, /api\(`\$\{API\}\/pedidos\/\$\{encodeURIComponent\(p\.id\)\}\/restaurar`, \{ method: 'POST', body: '\{\}' \}\)/);
    assert.ok(!/cupo|libres|usoSinPropio/.test(res), 'la página mide el cupo');
    // «No hay lugar» en alerta: escrito arriba de la lista no lo vería quien pulsó abajo.
    assert.match(res, /if \(e\.message !== 'sesion'\) alert\(e\.message\);/);
    assert.ok(!/avisar\('avisos', e\.message\)/.test(res), 'el error de restaurar va al aviso de arriba');
  });

  await t('D12. todas las sucursales en la página: cada pedido con su sucursal, el día junto primero, sin configuración ni hojas de cocina, y nunca manda un negocio', async () => {
    // La página nunca dice de qué negocio es lo que manda: eso lo decide el servidor.
    assert.ok(!/negocio_?id/i.test(admin), 'la página manda un negocio');
    // La opción del día con todas va primero; las campañas sueltas dicen su sucursal.
    const carga = admin.slice(admin.indexOf('const opciones = ['), admin.indexOf("const sel = $('selCampana');"));
    assert.ok(carga.indexOf('...(r.juntas || []).map(') > 0 && carga.indexOf('...(r.juntas || []).map(') < carga.indexOf('...r.campanas.map('), 'el día junto no va primero');
    assert.match(carga, /todas las sucursales \(\$\{enLista\(j\.sucursales\)\}\)/);
    assert.match(carga, /\$\{c\.sucursal \? ' · ' \+ c\.sucursal\.etiqueta : ''\}/);
    // El día junto se pide a su ruta; ahí no hay configuración ni hojas de cocina (van por sucursal).
    assert.match(admin, /const esJuntas = \(id\) => String\(id \|\| ''\)\.startsWith\('juntas:'\);/);
    assert.match(admin, /api\(`\$\{API\}\/juntas\/\$\{encodeURIComponent\(String\(id\)\.slice\('juntas:'\.length\)\)\}`\)/);
    assert.match(admin, /\$\('config'\)\.classList\.toggle\('oculto', juntas \|\| lectura\);\s*\$\('barCocina'\)\.classList\.toggle\('oculto', juntas\);/);
    assert.match(admin, /<div class="barra cocina noimprimir" id="barCocina">/);
    assert.match(admin, /if \(!estado\.nueva && esJuntas\(estado\.actual && estado\.actual\.id\)\) return;/);
    // Cada pedido con su sucursal, primero en el renglón (los folios se repiten entre sucursales).
    const fila = admin.slice(admin.indexOf('function filaPedido('), admin.indexOf('// ── Cancelar y restaurar'));
    assert.match(fila, /p\.sucursal \? el\('span', \{ class: 'chip suc', text: p\.sucursal\.etiqueta \}\) : null,/);
    // Cada horario con el cupo de cada sucursal, nunca sumados (solo de las que ya lo ocupan).
    assert.match(admin, /const barras = \(s, de\) => \[medidor\(`Platillos\$\{de\}`, s\.platillos, s\.cupoPlatillos\),\s*s\.cupoDomicilio > 0 \|\| s\.domicilios > 0 \? medidor\(`Domicilios\$\{de\}`, s\.domicilios, s\.cupoDomicilio\) : null\];/);
    assert.match(admin, /v\.porSucursal\s*\? v\.porSucursal\.filter\(ocupa\)\.flatMap\(\(s\) => barras\(s, ` \$\{s\.etiqueta\}`\)\)/);
    assert.match(admin, /p\.ventana\.inicio === v\.inicio && \(!v\.porSucursal \|\| p\.ventana\.fin === v\.fin\)/);
    // Lo que se mide y se agenda va con la campaña de SU sucursal.
    assert.match(admin, /const s = d\.sucursales\.find\(\(x\) => x\.campana\.id === \(p && p\.campana_id\)\) \|\| d\.sucursales\.find\(\(x\) => !x\.soloLectura\) \|\| d\.sucursales\[0\];/);
    assert.strictEqual((admin.match(/\{ c, ventanas \} = pedidoAbierto\.ctx;/g) || []).length, 2, 'horarios y cupo sin la sucursal del pedido');
    const guardar = admin.slice(admin.indexOf('async function guardarPedido('), admin.indexOf("$('formPedido').addEventListener('submit'"));
    assert.match(guardar, /api\(`\$\{API\}\/campanas\/\$\{encodeURIComponent\(ab\.ctx\.c\.id\)\}\/pedidos`, \{ method: 'POST'/);
    assert.ok(!/estado\.actual\.id\)\}\/pedidos/.test(guardar), 'el alta va a la campaña de la vista');
    assert.match(admin, /\$\('pedidoSucursalCampo'\)\.classList\.toggle\('oculto', !\(juntas && !p\)\);/);
    assert.match(admin, /el\('option', \{ value: s\.campana\.id, text: s\.etiqueta \}\)/);
    // Cada nota impresa con la campaña de su pedido.
    const notas = admin.slice(admin.indexOf('function imprimirNotas('), admin.indexOf('function imprimirRepartidor('));
    assert.match(notas, /\{ c \} = contextoDe\(p\), cabecera = cabeceraDe\(c\);/);
    // El Excel del día junto lleva la sucursal en la primera columna.
    const csv = admin.slice(admin.indexOf("$('btnCsv').addEventListener"), admin.indexOf('cargarCampanas().catch('));
    assert.match(csv, /if \(d\.juntas\) \{\s*filas\[0\]\.unshift\('Sucursal'\);\s*d\.pedidos\.forEach\(\(p, i\) => filas\[i \+ 1\]\.unshift\(p\.sucursal \? p\.sucursal\.etiqueta : ''\)\);/);
    // Arriba, cuánto lleva cada sucursal con los montos del servidor.
    assert.match(admin, /const ps = conf\.filter\(\(p\) => p\.campana_id === s\.campana\.id\), t = s\.totales;/);
    // Los avisos de agendar, cancelar y restaurar dicen la sucursal (el folio solo no basta).
    assert.match(guardar, /const de = ab\.ctx\.etiqueta \? ` de \$\{ab\.ctx\.etiqueta\}` : '';/);
    assert.match(guardar, /`\$\{r\.pedido\.folio\}\$\{de\} agendado\$\{pasando\}\.`/);
    for (const que of ['cancelado\\. Si fue un error', 'restaurado con su mismo folio']) {
      assert.match(admin, new RegExp(`\\$\\{p\\.folio\\}\\$\\{p\\.sucursal \\? \` de \\$\\{p\\.sucursal\\.etiqueta\\}\` : ''\\} ${que}`), que);
    }
  });

  await t('D13. la lista rediseñada: solo colores de la paleta, una acción a la vista, saldo naranja, barras con umbral, horarios vacíos en una línea', async () => {
    // Ningún color fuera de la paleta del panel (/app) y de los grises del
    // papel (20-nov-2026, Mario: «la sección de temporada está negra, dista de
    // nuestro sistema»). Los tonos oscuros de antes no vuelven.
    const PANEL = ['#f8f9fa', '#fff', '#f1f3f5', '#e9ecef', '#dee2e6', '#1a1d23', '#6b7280', '#9ca3af', '#4b5563',
      '#ff6b35', '#fff4ef', '#c2410c', '#10b981', '#ecfdf5', '#047857', '#ef4444', '#fef2f2', '#b91c1c',
      '#f59e0b', '#fffbeb', '#92400e', '#1d4ed8'];
    const PAPEL = ['#000', '#333', '#888', '#999', '#bbb', '#eee', '#fff'];
    const PALETA = new Set([...PANEL, ...PAPEL]);
    const nuevos = [...new Set((admin.match(/#[0-9a-f]{3,6}\b/gi) || []).map((x) => x.toLowerCase()))].filter((x) => !PALETA.has(x));
    assert.deepStrictEqual(nuevos, [], `colores fuera de la paleta: ${nuevos.join(' ')}`);
    // En pantalla (antes de @media print) solo colores del panel: el gris del papel no tiñe la vista.
    const pantalla = admin.slice(admin.indexOf('<style>'), admin.indexOf('@media print'));
    const ajenos = [...new Set((pantalla.match(/#[0-9a-f]{3,6}\b/gi) || []).map((x) => x.toLowerCase()))].filter((x) => !PANEL.includes(x));
    assert.deepStrictEqual(ajenos, [], `en pantalla, colores que no son del panel: ${ajenos.join(' ')}`);
    // Fondo, superficie, texto y naranja: los mismos valores que el :root de /app.
    const raiz = (panelHtml.match(/:root \{([\s\S]*?)\n\}/) || [])[1] || '';
    // #fff y #FFFFFF son el mismo color.
    const largo = (h) => (h.length === 4 ? '#' + [...h.slice(1)].map((c) => c + c).join('') : h).toLowerCase();
    for (const [propio, delPanel] of [['bg', 'color-bg'], ['sup', 'color-surface'], ['card', 'color-surface-2'], ['line', 'color-border'],
      ['texto', 'color-text-primary'], ['sub', 'color-text-secondary'], ['accent', 'color-brand'], ['ok', 'color-success'], ['rojo', 'color-danger']]) {
      const suyo = (pantalla.match(new RegExp(`--${propio}:(#[0-9a-f]+);`, 'i')) || [])[1];
      const panel = (raiz.match(new RegExp(`--${delPanel}:\\s*(#[0-9a-f]+);`, 'i')) || [])[1];
      assert.ok(suyo && panel, `falta --${propio} o --${delPanel}`);
      assert.strictEqual(largo(suyo), largo(panel), `--${propio} no es el --${delPanel} del panel`);
    }
    assert.match(pantalla, /body \{ background:var\(--bg\); color:var\(--texto\);/);
    assert.match(pantalla, /\* \{[^}]*font-family:'Inter',system-ui/);
    const definidos = new Set([...admin.matchAll(/(--[a-z][a-z0-9-]*)\s*:/g)].map((m) => m[1]));
    const sinDefinir = [...new Set([...admin.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))].filter((v) => !definidos.has(v));
    assert.deepStrictEqual(sinDefinir, [], 'usa variables de color que no existen');
    assert.ok(!/\.e-en_preparacion[^{]*\{[^}]*background/.test(admin), '«En preparación» volvió a tener fondo');
    // Etiquetas: gris neutro; verde = pagado o entregado; rojo = cancelado o atrasado.
    assert.match(admin, /\.chip \{[^}]*background:var\(--card\); color:var\(--gris-tx\); \}/);
    assert.match(admin, /\.chip\.ok \{ background:var\(--ok-bg\); color:var\(--ok-tx\); \}/);
    assert.match(admin, /\.chip\.rojo \{ background:var\(--rojo-bg\); color:var\(--rojo-tx\); \}/);
    assert.ok(!/\.chip\.(suc|domicilio|recoge|tipo)\s*\{/.test(admin), 'la sucursal o el tipo tienen color propio');
    assert.match(admin, /if \(p\.estado === 'cancelado'\) return el\('span', \{ class: 'chip rojo', text: 'Cancelado' \}\);/);
    assert.match(admin, /if \(paso === 'entregado'\) return el\('span', \{ class: 'chip ok', text: nombre \}\);/);
    assert.match(admin, /if \(`\$\{c\.fecha\} \$\{p\.ventana\.fin\}` <= ahoraEnZona\(\)\) \{\s*\/\/[^\n]*\n\s*return el\('span', \{ class: 'chip rojo'/);
    // Saldo y acción principal en naranja; «+ Nuevo pedido» es el único botón naranja de la barra.
    // (el texto naranja usa el tono oscuro del naranja de marca, para leerse sobre blanco)
    assert.match(admin, /\.p-saldo b \{ color:var\(--accent-tx\);/);
    assert.match(admin, /button\.accion \{ border-color:var\(--accent\); color:var\(--accent-tx\); background:transparent; \}/);
    assert.match(admin, /button\.primario \{ background:var\(--accent\); border-color:var\(--accent\); color:#fff; \}/);
    const barra = admin.slice(admin.lastIndexOf('<div class="barra', admin.indexOf('id="btnNuevoPedido"')), admin.indexOf('<div class="barra cocina noimprimir"'));
    assert.ok(barra.includes('id="btnCsv"') && barra.includes('id="soloPendientes"'), 'no se encontró la barra de la lista');
    assert.deepStrictEqual(barra.match(/<button class="primario"[^>]*>[^<]*/g), ['<button class="primario" id="btnNuevoPedido">+ Nuevo pedido']);
    // Una sola acción a la vista: la fila no arma botones propios, lleva la de accionPrincipal y el ⋯.
    const fila = admin.slice(admin.indexOf('function filaPedido('), admin.indexOf('function celdaSaldo('));
    assert.ok(!/el\('button'/.test(fila), 'la fila arma botones además de la acción principal');
    assert.match(fila, /el\('div', \{ class: 'p-accion' \}, \[principal\.nodo\]\),\s*menuPedido\(p, paso, principal\.tipo\),/);
    // Pedidos de 10 platillos o más: la cantidad en negritas.
    assert.match(fila, /class: 'n' \+ \(p\.platillos >= 10 \? ' grande' : ''\)/);
    assert.match(admin, /\.p-plat \.n\.grande \{ font-weight:800;/);
    // Barras: gris; naranja arriba de 75 %; roja arriba de 90 %.
    assert.match(admin, /class: 'medidor' \+ \(uso > 0\.9 \? ' lleno' : uso > 0\.75 \? ' casi' : ''\)/);
    assert.match(admin, /\.medidor\.casi \.barra-uso i \{ background:var\(--accent\); \}/);
    assert.match(admin, /\.medidor\.lleno \.barra-uso i \{ background:var\(--rojo\); \}/);
    // Un horario sin pedidos que mostrar: una línea gris, sin barras.
    assert.match(admin, /if \(!lista\.length\) \{[\s\S]{0,200}?class: 'ventana vacia'[\s\S]{0,140}?`\$\{rango\} · sin pedidos`/);
    // Los datos del pedido (teléfono, dirección, notas) salen en papel aunque la fila esté cerrada.
    assert.match(admin, /\.p-detalle \{ display:grid !important;/);
  });

  await t('D14. solo lectura en la página: lo decide el servidor; sin botones de atender ni configuración, solo «Imprimir nota»; «se prepara en» solo manda la sucursal', async () => {
    // Crear campaña: solo si el servidor dice que puede.
    assert.match(admin, /estado\.puedeCrear = r\.puedeCrear !== false;\s*\$\('btnNueva'\)\.classList\.toggle\('oculto', !estado\.puedeCrear\);\s*\$\('btnCrear'\)\.classList\.toggle\('oculto', !estado\.puedeCrear\);/);
    // La vista entera en solo lectura: sin configuración ni «Nuevo pedido», con el aviso.
    const iLectura = admin.indexOf('const lectura = !!d.soloLectura;');
    const carga = admin.slice(iLectura, admin.indexOf('pintarPreparacion();', iLectura));
    assert.ok(iLectura > 0 && carga.length > 50, 'no encontré la carga en solo lectura');
    assert.match(carga, /\$\('btnNuevoPedido'\)\.classList\.toggle\('oculto', lectura\);/);
    assert.match(carga, /\$\('tLectura'\)\.classList\.toggle\('oculto', !\$\('tLectura'\)\.textContent\);/);
    // Cada pedido de solo lectura: sin acción a la vista y con un menú que solo imprime.
    const principal = admin.slice(admin.indexOf('function accionPrincipal('), admin.indexOf('// ── Menú ⋯'));
    assert.match(principal, /^function accionPrincipal\(p, paso\) \{\s*\/\/[^\n]*\n\s*if \(contextoDe\(p\)\.soloLectura\) return \{ tipo: null, nodo: null \};/);
    const menu = admin.slice(admin.indexOf('function menuPedido('), admin.indexOf('function cajaMenu('));
    const ramaLectura = menu.slice(menu.indexOf('if (contextoDe(p).soloLectura) {'), menu.indexOf('const can = p.estado'));
    assert.ok(ramaLectura.length > 0 && menu.indexOf('if (contextoDe(p).soloLectura) {') < menu.indexOf('items.push('), 'la rama de solo lectura no va primero');
    assert.deepStrictEqual(ramaLectura.match(/opcionMenu\('([^']+)'/g), ["opcionMenu('Imprimir nota'"]);
    assert.ok(!/abrirPago|moverEntrega|abrirPedido|abrirCancelar|itemsWhatsApp|restaurar/.test(ramaLectura), 'la rama de solo lectura atiende algo');
    // El contexto de cada pedido trae su solo lectura (de la vista o de su sucursal).
    assert.match(admin, /return \{ c: estado\.actual, ventanas: d \? d\.ventanas : \[\], etiqueta: null, soloLectura: !!\(d && d\.soloLectura\) \};/);
    assert.match(admin, /return \{ c: s\.campana, ventanas: s\.ventanas, etiqueta: s\.etiqueta, soloLectura: !!s\.soloLectura \};/);
    // Agendar en el día junto: solo en las sucursales que atiende.
    assert.match(admin, /f\.elements\.sucursal\.replaceChildren\(\.\.\.estado\.detalle\.sucursales\.filter\(\(s\) => !s\.soloLectura\)/);
    // «Se prepara en»: oculto en el día junto, en solo lectura y en una campaña nueva; manda solo la sucursal.
    assert.match(admin, /const ver = !!d && !d\.juntas && !d\.soloLectura && !estado\.nueva && otras\.length > 0;/);
    assert.match(admin, /api\(`\$\{API\}\/campanas\/\$\{encodeURIComponent\(c\.id\)\}\/preparacion`,\s*\{ method: 'PUT', body: JSON\.stringify\(\{ preparada_en: \$\('selPreparacion'\)\.value \|\| null \}\) \}\)/);
    assert.ok(admin.indexOf('id="preparacion"') > admin.indexOf('<details') && admin.indexOf('id="preparacion"') < admin.indexOf('</details>'), '«se prepara en» fuera de la configuración');
  });

  await t('D15. la entrada del menú se retiró al terminar la temporada (26-nov); la página sola sigue igual: sin encabezado en un marco, login a ventana completa, sin consultar oculta; el papel no cambia', async () => {
    // Mario (26-nov-2026): «ya no es necesario tener la sección de thanksgiving».
    // El panel ya no trae botón, vista, marco, dirección ni ícono de temporada;
    // /temporada sigue abriendo por su liga directa. La entrada se recupera
    // del commit 78fe3f9b para la próxima temporada.
    const sinComentarios = panelHtml.replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(!/id="tab-temporada"|mostrarTab\('temporada'\)/.test(sinComentarios), 'el menú todavía trae Pedidos de temporada');
    assert.ok(!/id="vista-temporada"|id="marco-temporada"|'marco-temporada'/.test(sinComentarios), 'el panel todavía trae el marco de temporada');
    const mostrar = panelHtml.slice(panelHtml.indexOf('function mostrarTab('), panelHtml.indexOf('function mostrarTab(') + 6000);
    assert.ok(!/'temporada'/.test(mostrar), 'mostrarTab todavía conoce la vista de temporada');
    assert.ok(!/\btemporada: 'temporada'/.test(panelHtml), 'la dirección #temporada todavía abre una pantalla');
    assert.ok(!/'tab-temporada':/.test(panelHtml), 'el ícono de temporada sigue en el menú');
    assert.ok(!/href="\/temporada"|window\.open\('\/temporada/.test(panelHtml), 'el panel abre /temporada por otro camino');
    // La página: en el marco esconde su encabezado; sola, no cambia.
    assert.match(admin, /<script>if \(window\.self !== window\.top\) document\.documentElement\.classList\.add\('en-panel'\);<\/script>/);
    assert.match(admin, /html\.en-panel header\.xb \{ display:none; \}/);
    // Sesión vencida dentro del marco: el login a ventana completa y de regreso al panel.
    assert.match(admin, /if \(r\.status === 401\) \{ irAlLogin\(\); throw new Error\('sesion'\); \}/);
    assert.match(admin, /encodeURIComponent\(enPanel \? '\/app#temporada' : '\/temporada'\);\s*\(enPanel \? window\.top\.location : location\)\.href = destino;/);
    assert.ok(!/location\.href = '\/app/.test(admin), 'la página redirige a /app');
    // Con el marco oculto no consulta; el panel la pone al día al volver.
    assert.match(admin, /const oculta = \(\) => document\.hidden \|\| \(!!window\.frameElement && window\.frameElement\.offsetParent === null\);/);
    assert.match(admin, /window\.refrescarDesdePanel = refrescar;\s*setInterval\(\(\) => \{ if \(!oculta\(\)\) refrescar\(\); \}, 30000\);/);
    // El papel queda como antes del tema claro: letra del sistema, sin sombras, en blanco y negro.
    const papel = admin.slice(admin.indexOf('@media print'), admin.indexOf('</style>'));
    assert.match(papel, /\* \{ font-family:system-ui,-apple-system,sans-serif; \}/);
    assert.match(papel, /\.card, \.ventana, \.cocina \{ box-shadow:none; \}/);
    assert.match(papel, /body \{ background:#fff; color:#000; \}/);
  });
}

await pool.end().catch(() => {});
console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) console.log('Fallos:\n  ' + fallos.join('\n  '));
process.exit(fallidas ? 1 : 0);
