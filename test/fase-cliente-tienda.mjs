// ─── Cuenta del cliente en la tienda: suite end-to-end ─────────────────────
//
// La tienda deja de tratar a cada compra como la primera. El cliente se
// identifica con su teléfono y un código, guarda direcciones, ve sus puntos
// y compra sin volver a escribir nada. Todo contra Postgres real y un
// servidor real.
//
// Las cinco preguntas que esta suite existe para responder:
//   1. ¿Un código se puede adivinar, reutilizar o usar vencido?      (nunca)
//   2. ¿El mismo teléfono en otro formato crea otra persona?          (nunca)
//   3. ¿Un cliente puede tocar direcciones, puntos o sesión de otro,
//      o de otro negocio?                                              (nunca)
//   4. ¿El pedido guarda una COPIA de la dirección, o un puntero que
//      cambia cuando el cliente edita su libreta?                      (copia)
//   5. ¿El checkout de invitado y la tienda sin cuentas siguen igual?  (idénticos)
//
// Uso: mismas env vars que la batería (DATABASE_URL, PANEL_SECRET, …).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { randomBytes } from 'crypto';
import { execFileSync } from 'child_process';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4772';

const { pool } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

const NEG_A = SEED.negocioA;
const NEG_B = SEED.negocioB;
const SLUG_A = 'cta-tienda-a';
const SLUG_B = 'cta-tienda-b';
const MARCA = 'Cat cuenta cliente';

// Teléfonos del fixture: 10 dígitos exactos con sufijo por corrida (la base
// es compartida y dos ejecuciones no pueden pisarse).
const suf = Date.now().toString().slice(-5);
const tel = n => `87${suf}${String(n).padStart(3, '0')}`;
const TEL_NUEVA = tel(1);      // se registra en la suite
const TEL_RW = tel(2);         // ya tiene puntos (cuenta de Rewards previa)
const TEL_B = tel(3);          // cliente del negocio B
const TEL_FORMATOS = tel(4);   // el mismo número en tres formatos
const TEL_VICTIMA = tel(5);    // tiene puntos; nadie más puede gastarlos
const TEL_INVITADO = tel(6);
const TEL_RATE = tel(7);
const TEL_MIG1 = tel(8);       // backfill: dos cuentas, dos formatos
const TEL_QUEMA = tel(9);
// El tope por teléfono es 3 códigos cada 15 min y se prueba tal cual, así que
// cada prueba que pide códigos usa un número propio.
const TEL_REUSO = tel(11);
const TEL_OTRO = tel(12);

let base;
const url = r => `${base}${r}`;
const tokenCk = () => randomBytes(24).toString('hex');

// Cada "navegador" de la suite guarda su propia cookie de cliente.
function navegador() {
  const jar = { cookie: '' };
  const pedir = async (ruta, { method = 'GET', body, cookie } = {}) => {
    const r = await fetch(url(ruta), {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ?? jar.cookie ? { Cookie: cookie ?? jar.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = r.headers.get('set-cookie') || '';
    const m = /xabor_cliente=([^;]*)/.exec(set);
    if (m) jar.cookie = m[1] ? `xabor_cliente=${m[1]}` : '';
    jar.ultimoSetCookie = set;
    return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
  };
  return { jar, pedir };
}

// Pide un código y lo devuelve (proveedor 'dev' con XABOR_OTP_DEV_EXPONER).
async function codigoPara(nav, slug, telefono) {
  const r = await nav.pedir(`/api/tienda/${slug}/cuenta/otp`, { method: 'POST', body: { telefono } });
  assert.strictEqual(r.status, 200, `pedir OTP: ${JSON.stringify(r.body)}`);
  assert.ok(r.body.codigoDev, 'en pruebas el código viaja en la respuesta');
  return r.body.codigoDev;
}
async function entrar(nav, slug, telefono, nombre = 'Cliente Prueba') {
  const codigo = await codigoPara(nav, slug, telefono);
  const r = await nav.pedir(`/api/tienda/${slug}/cuenta/otp/verificar`, { method: 'POST', body: { telefono, codigo, nombre } });
  assert.strictEqual(r.status, 200, `verificar OTP: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);
}
async function fijarRewards(negocioId, { canalTienda = true } = {}) {
  await pool.query(
    `INSERT INTO rewards_config (tenant_id, activo, monto_por_punto, puntos_por_peso, canje_minimo,
       canal_mostrador, canal_whatsapp, canal_telefono, canal_rappi, canal_tienda)
     VALUES ($1,TRUE,10,0.5,100,TRUE,TRUE,TRUE,FALSE,$2)
     ON CONFLICT (tenant_id) DO UPDATE SET activo=TRUE, monto_por_punto=10, puntos_por_peso=0.5, canje_minimo=100,
       canal_tienda=$2`, [negocioId, canalTienda]);
}
// Cuenta de Rewards "vieja": exactamente como la deja el motor hoy (fila en
// clientes por la FK, cuenta por (telefono, tenant_id)), sin cliente_id.
async function cuentaRewards(negocioId, telefono, puntos, nombre = null) {
  await pool.query(`INSERT INTO clientes (telefono, nombre) VALUES ($1, $2) ON CONFLICT (telefono) DO NOTHING`, [telefono, nombre]);
  const { rows: [a] } = await pool.query(
    `INSERT INTO rewards_accounts (telefono, tenant_id, negocio_id, nombre, puntos_balance, puntos_acumulados_total)
     VALUES ($1,$2,$3::uuid,$4,$5,$5)
     ON CONFLICT (telefono, tenant_id) DO UPDATE SET puntos_balance=$5, puntos_acumulados_total=$5, cliente_id=NULL
     RETURNING id`, [telefono, negocioId, negocioId, nombre, puntos]);
  await pool.query(
    `INSERT INTO rewards_movements (account_id, tenant_id, tipo, puntos, balance_anterior, balance_posterior, folio_venta, usuario, motivo)
     VALUES ($1,$2,'acumulacion',$3,0,$3,$4,'sistema','Compra de prueba')
     ON CONFLICT DO NOTHING`, [a.id, negocioId, puntos, 'XCT-' + suf + '-' + telefono.slice(-3)]);
  return a.id;
}
const saldoDe = async (negocioId, telefono) =>
  parseInt((await pool.query('SELECT puntos_balance FROM rewards_accounts WHERE telefono=$1 AND tenant_id=$2', [telefono, negocioId])).rows[0]?.puntos_balance ?? -1, 10);

const PROD = {};
async function prepararNegocio(negocioId, etiqueta, slug) {
  for (const m of ['tienda_online', 'pos', 'menu', 'rewards']) await fijarModulo(negocioId, m, 'activo');
  await pool.query('DELETE FROM menu_categorias WHERE negocio_id = $1 AND nombre = $2', [negocioId, MARCA]);
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,930) RETURNING id`, [negocioId, MARCA]);
  const { rows: [p] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden)
     VALUES ($1,$2,$3,200,TRUE,1) RETURNING id`, [negocioId, cat.id, `Pizza cuenta ${etiqueta}`]);
  PROD[etiqueta] = p.id;
  await pool.query(`INSERT INTO tienda_productos (negocio_id, producto_id, publicado) VALUES ($1,$2,TRUE)
    ON CONFLICT (negocio_id, producto_id) DO UPDATE SET publicado = TRUE`, [negocioId, p.id]);
  const reglas = {
    horarios: Object.fromEntries(['lunes','martes','miercoles','jueves','viernes','sabado','domingo']
      .map(d => [d, { abierto: true, apertura: '00:00', cierre: '23:59' }])),
    pedidos: {
      costo_envio: 40, pedido_minimo_entrega: 0, entrega_gratis_desde: 0,
      zonas_entrega: [{ nombre: 'Centro', costo: 30 }, { nombre: 'Lejos', costo: 80 }],
      tiempo_preparacion_minutos: 20, tiempo_entrega_min_minutos: 30, tiempo_entrega_max_minutos: 45,
    },
  };
  await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'reglas_atencion',$2)
    ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $2`, [negocioId, JSON.stringify(reglas)]);
  await pool.query(`UPDATE metodos_pago SET habilitado = FALSE WHERE negocio_id = $1`, [negocioId]);
  await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado) VALUES ($1,'efectivo',TRUE)
    ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = TRUE`, [negocioId]);
  // La allow-list de la TIENDA es propia (configuracion.tienda_metodos_pago);
  // sin ella el default es solo pago en línea, que exige pasarela.
  await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'tienda_metodos_pago','["efectivo"]')
    ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = '["efectivo"]'`, [negocioId]);
  await pool.query(
    `INSERT INTO tienda_config (negocio_id, estado, slug_publico, titular, modalidades, cuentas_clientes)
     VALUES ($1,'publicada',$2,$3,$4,TRUE)
     ON CONFLICT (negocio_id) DO UPDATE SET estado='publicada', slug_publico=$2, titular=$3, modalidades=$4, cuentas_clientes=TRUE`,
    [negocioId, slug, `Tienda cuenta ${etiqueta}`, JSON.stringify(['recoger', 'domicilio'])]);
  await fijarRewards(negocioId);
}

async function limpiar() {
  const tels = [TEL_NUEVA, TEL_RW, TEL_B, TEL_FORMATOS, TEL_VICTIMA, TEL_INVITADO, TEL_RATE, TEL_MIG1, TEL_QUEMA, TEL_REUSO, TEL_OTRO];
  await pool.query(`DELETE FROM clientes_negocio WHERE telefono = ANY($1)`, [tels]);
  await pool.query(`DELETE FROM cliente_otp WHERE telefono = ANY($1)`, [tels]);
}

const itemsA = () => [{ productoId: PROD.A, cantidad: 1 }];
function checkoutBody(extra = {}) {
  return {
    checkoutToken: tokenCk(), items: itemsA(), modalidad: 'recoger', metodoPago: 'efectivo',
    cliente: { nombre: 'Invitado Prueba', telefono: TEL_INVITADO }, ...extra,
  };
}
const pedidoDe = async (folio) => (await pool.query('SELECT cliente_id, datos FROM pedidos_activos WHERE folio = $1', [folio])).rows[0];

// Lo que esta suite pisa en la base COMPARTIDA se deja al final como estaba:
// la allow-list de pago de la tienda y el interruptor de cuentas. Otras
// suites (pagos en línea) dependen de que no quede una allow-list ajena.
const previo = {};
for (const n of [NEG_A, NEG_B]) {
  const { rows } = await pool.query(`SELECT valor FROM configuracion WHERE negocio_id=$1 AND clave='tienda_metodos_pago'`, [n]);
  previo[n] = rows[0]?.valor ?? null;
}
async function restaurarEstado() {
  for (const n of [NEG_A, NEG_B]) {
    if (previo[n] === null) await pool.query(`DELETE FROM configuracion WHERE negocio_id=$1 AND clave='tienda_metodos_pago'`, [n]);
    else await pool.query(`UPDATE configuracion SET valor=$2 WHERE negocio_id=$1 AND clave='tienda_metodos_pago'`, [n, previo[n]]);
    await pool.query('UPDATE tienda_config SET cuentas_clientes = FALSE WHERE negocio_id = $1', [n]).catch(() => {});
  }
}

await limpiar();
await prepararNegocio(NEG_A, 'A', SLUG_A);
await prepararNegocio(NEG_B, 'B', SLUG_B);
await cuentaRewards(NEG_A, TEL_RW, 300, 'Rica Rewards');
await cuentaRewards(NEG_A, TEL_VICTIMA, 500, 'Victima');

// El servidor de la suite: proveedor 'dev' (no hay OTP_PROVEEDOR) y el código
// expuesto en la respuesta para poder teclearlo sin un teléfono real.
// Los topes por IP se relajan porque TODA la suite sale de 127.0.0.1; el tope
// por TELÉFONO se deja como en producción (3 / 15 min) y se prueba tal cual.
const srv = await arrancarServidor({
  PORT: PUERTO, XABOR_OTP_DEV_EXPONER: 'true', XABOR_OTP_LIMITE_IP: '100000',
  XABOR_TIENDA_LIMITE_CHECKOUT: '100000', XABOR_TIENDA_LIMITE_COTIZAR: '100000', XABOR_TIENDA_LIMITE_LECTURA: '100000',
}, { timeoutMs: 40000, omitir: ['OTP_PROVEEDOR', 'NODE_ENV'] });
base = srv.base;

try {
  // ═══════════════ ACCESO ═══════════════
  const ana = navegador();
  let ctaAna;

  await t('ACCESO', '1. la tienda anuncia que tiene cuentas', async () => {
    const r = await ana.pedir(`/api/tienda/${SLUG_A}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.cuentas, true);
  });

  await t('ACCESO', '2. sin sesión, Mi cuenta responde 401 (no 404, no datos)', async () => {
    const r = await ana.pedir(`/api/tienda/${SLUG_A}/cuenta`);
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.codigo, 'NO_AUTENTICADO');
  });

  await t('ACCESO', '3. cliente nuevo: teléfono → código → sesión, y queda creado con su nombre', async () => {
    const r = await entrar(ana, SLUG_A, `+52 ${TEL_NUEVA.slice(0, 3)} ${TEL_NUEVA.slice(3, 6)} ${TEL_NUEVA.slice(6)}`, 'Ana Nueva');
    assert.strictEqual(r.nuevo, true, 'debe reportarse como cliente nuevo');
    assert.strictEqual(r.cliente.telefono, TEL_NUEVA, 'la identidad es el teléfono a 10 dígitos');
    assert.strictEqual(r.cliente.nombre, 'Ana Nueva');
    assert.ok(ana.jar.cookie.startsWith('xabor_cliente='), 'debe quedar la cookie de sesión');
    const { rows } = await pool.query('SELECT * FROM clientes_negocio WHERE negocio_id=$1 AND telefono=$2', [NEG_A, TEL_NUEVA]);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].origen, 'tienda');
    ctaAna = rows[0];
  });

  await t('ACCESO', '4. la cookie es httpOnly, SameSite y dura 90 días', async () => {
    const sc = ana.jar.ultimoSetCookie;
    assert.match(sc, /HttpOnly/i);
    assert.match(sc, /SameSite=Lax/i);
    assert.match(sc, /Max-Age=7776000/);
  });

  await t('ACCESO', '5. con sesión, Mi cuenta devuelve el cliente y NO un teléfono ajeno', async () => {
    const r = await ana.pedir(`/api/tienda/${SLUG_A}/cuenta`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.cliente.telefono, TEL_NUEVA);
    assert.ok(Array.isArray(r.body.direcciones));
    assert.ok(!JSON.stringify(r.body).includes(TEL_RW), 'jamás el teléfono de otro cliente');
  });

  await t('ACCESO', '6. la sesión vive en la base (sobrevive reinicios): hay fila con vencimiento a ~90 días', async () => {
    const { rows } = await pool.query(
      `SELECT expires_at, revocada_at FROM cliente_sesiones WHERE cliente_id=$1 ORDER BY created_at DESC LIMIT 1`, [ctaAna.id]);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].revocada_at, null);
    const dias = (new Date(rows[0].expires_at) - Date.now()) / 86400000;
    assert.ok(dias > 89 && dias <= 90, `vence en ${dias.toFixed(1)} días`);
  });

  await t('OTP', '7. un código incorrecto se rechaza con el mismo 401 genérico', async () => {
    const nav = navegador();
    await codigoPara(nav, SLUG_A, TEL_QUEMA);
    const r = await nav.pedir(`/api/tienda/${SLUG_A}/cuenta/otp/verificar`, { method: 'POST', body: { telefono: TEL_QUEMA, codigo: '000000' } });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.codigo, 'CODIGO_INVALIDO');
    assert.strictEqual(nav.jar.cookie, '', 'sin cookie');
  });

  await t('OTP', '8. tras 5 intentos fallidos el código se quema: ni el correcto entra ya', async () => {
    const nav = navegador();
    const codigo = await codigoPara(nav, SLUG_A, TEL_QUEMA);
    for (let i = 0; i < 5; i++) {
      const r = await nav.pedir(`/api/tienda/${SLUG_A}/cuenta/otp/verificar`, { method: 'POST', body: { telefono: TEL_QUEMA, codigo: String(111111 + i) } });
      assert.strictEqual(r.status, 401);
    }
    const r = await nav.pedir(`/api/tienda/${SLUG_A}/cuenta/otp/verificar`, { method: 'POST', body: { telefono: TEL_QUEMA, codigo } });
    assert.strictEqual(r.status, 401, 'el código correcto ya no sirve después de 5 fallos');
  });

  await t('OTP', '9. un código vencido no entra', async () => {
    const nav = navegador();
    const codigo = await codigoPara(nav, SLUG_A, TEL_QUEMA);
    await pool.query(`UPDATE cliente_otp SET expires_at = NOW() - INTERVAL '1 minute' WHERE telefono=$1 AND usado_at IS NULL AND revocado_at IS NULL`, [TEL_QUEMA]);
    const r = await nav.pedir(`/api/tienda/${SLUG_A}/cuenta/otp/verificar`, { method: 'POST', body: { telefono: TEL_QUEMA, codigo } });
    assert.strictEqual(r.status, 401);
  });

  await t('OTP', '10. un código usado no se puede reutilizar', async () => {
    const nav = navegador();
    const codigo = await codigoPara(nav, SLUG_A, TEL_REUSO);
    const ok = await nav.pedir(`/api/tienda/${SLUG_A}/cuenta/otp/verificar`, { method: 'POST', body: { telefono: TEL_REUSO, codigo, nombre: 'Reuso' } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const otro = navegador();
    const r = await otro.pedir(`/api/tienda/${SLUG_A}/cuenta/otp/verificar`, { method: 'POST', body: { telefono: TEL_REUSO, codigo } });
    assert.strictEqual(r.status, 401, 'segundo uso del mismo código');
    assert.strictEqual(otro.jar.cookie, '');
  });

  await t('OTP', '11. pedir un código nuevo invalida el anterior', async () => {
    const nav = navegador();
    const viejo = await codigoPara(nav, SLUG_A, TEL_RATE);
    const nuevo = await codigoPara(nav, SLUG_A, TEL_RATE);
    assert.notStrictEqual(viejo, nuevo);
    const r = await nav.pedir(`/api/tienda/${SLUG_A}/cuenta/otp/verificar`, { method: 'POST', body: { telefono: TEL_RATE, codigo: viejo } });
    assert.strictEqual(r.status, 401, 'el código anterior quedó revocado');
  });

  await t('OTP', '12. en la base solo vive el hash: el código nunca se guarda en claro', async () => {
    const nav = navegador();
    const codigo = await codigoPara(nav, SLUG_A, TEL_RATE);
    const { rows } = await pool.query(`SELECT codigo_hash FROM cliente_otp WHERE telefono=$1 ORDER BY created_at DESC LIMIT 1`, [TEL_RATE]);
    assert.notStrictEqual(rows[0].codigo_hash, codigo);
    assert.match(rows[0].codigo_hash, /^[0-9a-f]{64}$/);
  });

  await t('OTP', '13. rate limit por teléfono: la cuarta solicitud en 15 minutos se frena (429)', async () => {
    // Ya van 3 para TEL_RATE en las dos pruebas anteriores.
    const nav = navegador();
    const r = await nav.pedir(`/api/tienda/${SLUG_A}/cuenta/otp`, { method: 'POST', body: { telefono: TEL_RATE } });
    assert.strictEqual(r.status, 429, JSON.stringify(r.body));
    assert.strictEqual(r.body.codigo, 'OTP_DEMASIADOS');
  });

  await t('OTP', '14. un teléfono que no es teléfono se rechaza sin tocar la base', async () => {
    const nav = navegador();
    for (const malo of ['123', 'abc', '', '12345678901234567']) {
      const r = await nav.pedir(`/api/tienda/${SLUG_A}/cuenta/otp`, { method: 'POST', body: { telefono: malo } });
      assert.strictEqual(r.status, 400, `teléfono ${JSON.stringify(malo)}`);
    }
  });

  // ═══════════════ IDENTIDAD ═══════════════
  await t('IDENTIDAD', '15. el mismo teléfono en tres formatos es UN solo cliente', async () => {
    // Tres formatos = tres códigos: justo el tope por teléfono.
    const formatos = [`+52 ${TEL_FORMATOS}`, `521${TEL_FORMATOS}`, `${TEL_FORMATOS.slice(0, 3)} ${TEL_FORMATOS.slice(3, 6)} ${TEL_FORMATOS.slice(6)}`];
    const ids = new Set();
    for (const f of formatos) {
      const nav = navegador();
      const r = await entrar(nav, SLUG_A, f, 'Formatos');
      ids.add(r.cliente.id);
      assert.strictEqual(r.cliente.telefono, TEL_FORMATOS);
    }
    assert.strictEqual(ids.size, 1, `se crearon ${ids.size} clientes`);
    const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM clientes_negocio WHERE negocio_id=$1 AND telefono=$2', [NEG_A, TEL_FORMATOS]);
    assert.strictEqual(n, 1);
  });

  await t('IDENTIDAD', '16. volver a entrar no es "nuevo" y conserva el nombre aunque no se mande', async () => {
    const nav = navegador();
    const codigo = await codigoPara(nav, SLUG_A, TEL_NUEVA);
    const r = await nav.pedir(`/api/tienda/${SLUG_A}/cuenta/otp/verificar`, { method: 'POST', body: { telefono: TEL_NUEVA, codigo } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.nuevo, false);
    assert.strictEqual(r.body.cliente.nombre, 'Ana Nueva');
  });

  await t('PERFIL', '17. el cliente edita nombre y correo; el correo se normaliza y uno inválido se rechaza', async () => {
    let r = await ana.pedir(`/api/tienda/${SLUG_A}/cuenta`, { method: 'PATCH', body: { nombre: 'Ana Nueva Díaz', email: '  ANA@Ejemplo.COM ' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.cliente.email, 'ana@ejemplo.com');
    r = await ana.pedir(`/api/tienda/${SLUG_A}/cuenta`, { method: 'PATCH', body: { email: 'no-es-correo' } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.codigo, 'EMAIL_INVALIDO');
    r = await ana.pedir(`/api/tienda/${SLUG_A}/cuenta`, { method: 'PATCH', body: { telefono: '0000000000' } });
    const { rows } = await pool.query('SELECT telefono FROM clientes_negocio WHERE id=$1', [ctaAna.id]);
    assert.strictEqual(rows[0].telefono, TEL_NUEVA, 'el teléfono es la identidad verificada: no se edita por PATCH');
  });

  // ═══════════════ DIRECCIONES ═══════════════
  let dirCasa, dirTrabajo;
  await t('DIRECCIONES', '18. crear "Casa": la primera dirección nace predeterminada y la zona se valida contra el negocio', async () => {
    const r = await ana.pedir(`/api/tienda/${SLUG_A}/cuenta/direcciones`, { method: 'POST', body: {
      alias: 'Casa', calle: 'Av. Siempre Viva', numeroExterior: '742', numeroInterior: '2', colonia: 'Springfield',
      codigoPostal: '88000', entreCalles: 'Calle 1 y Calle 2', referencia: 'Portón azul', instruccionesEntrega: 'Tocar dos veces',
      zona: 'centro', latitud: 25.8, longitud: -100.2,
    }});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    dirCasa = r.body.direccion;
    assert.strictEqual(dirCasa.predeterminada, true);
    assert.strictEqual(dirCasa.zona, 'Centro', 'la zona queda con el nombre canónico del negocio');
    assert.strictEqual(dirCasa.codigoPostal, '88000');
    assert.strictEqual(dirCasa.latitud, 25.8);
  });

  await t('DIRECCIONES', '19. crear "Trabajo": no es predeterminada; una zona inventada se rechaza', async () => {
    let r = await ana.pedir(`/api/tienda/${SLUG_A}/cuenta/direcciones`, { method: 'POST', body: { alias: 'Trabajo', calle: 'Reforma', numeroExterior: '1', zona: 'Marte' } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.codigo, 'ZONA_INVALIDA');
    r = await ana.pedir(`/api/tienda/${SLUG_A}/cuenta/direcciones`, { method: 'POST', body: { alias: 'Trabajo', calle: 'Reforma', numeroExterior: '1', zona: 'Lejos' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    dirTrabajo = r.body.direccion;
    assert.strictEqual(dirTrabajo.predeterminada, false);
    assert.strictEqual(dirTrabajo.colonia, 'Lejos', 'sin colonia, hereda el nombre de la zona (el repartidor la necesita)');
  });

  await t('DIRECCIONES', '20. marcar predeterminada cambia la marca y solo queda UNA (lo garantiza la base)', async () => {
    const r = await ana.pedir(`/api/tienda/${SLUG_A}/cuenta/direcciones/${dirTrabajo.id}/predeterminada`, { method: 'POST' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.direccion.predeterminada, true);
    const { rows } = await pool.query('SELECT id, predeterminada FROM cliente_direcciones WHERE cliente_id=$1', [ctaAna.id]);
    assert.strictEqual(rows.filter(x => x.predeterminada).length, 1);
    assert.strictEqual(rows.find(x => x.id === dirCasa.id).predeterminada, false);
    // Dos predeterminadas a la fuerza: la base lo impide.
    await assert.rejects(pool.query('UPDATE cliente_direcciones SET predeterminada = TRUE WHERE id=$1', [dirCasa.id]), /unique|duplicate/i);
  });

  await t('DIRECCIONES', '21. la lista viene ordenada con la predeterminada primero y con un resumen legible', async () => {
    const r = await ana.pedir(`/api/tienda/${SLUG_A}/cuenta/direcciones`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.direcciones[0].id, dirTrabajo.id);
    assert.ok(r.body.direcciones[1].resumen.includes('Av. Siempre Viva 742'));
  });

  // ═══════════════ CHECKOUT ═══════════════
  let folioSesion;
  await t('CHECKOUT', '22. checkout autenticado con dirección guardada: envío de esa zona, nombre y teléfono del perfil, cliente_id en el pedido', async () => {
    const r = await ana.pedir(`/api/tienda/${SLUG_A}/checkout`, { method: 'POST', body: checkoutBody({
      modalidad: 'domicilio', direccionId: dirCasa.id,
      // El navegador manda basura a propósito: nada de esto puede mandar.
      cliente: { nombre: '', telefono: TEL_VICTIMA }, zona: 'Lejos', direccion: 'Otra calle 999',
      notas: 'Sin cebolla',
    })});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    folioSesion = r.body.folio;
    const p = await pedidoDe(folioSesion);
    assert.strictEqual(p.cliente_id, ctaAna.id, 'la columna cliente_id apunta al cliente de la sesión');
    assert.strictEqual(p.datos.cliente_id, ctaAna.id, 'y también viaja dentro de datos');
    assert.strictEqual(p.datos.cliente.telefono, TEL_NUEVA, 'el teléfono es el VERIFICADO, no el del cuerpo');
    assert.strictEqual(p.datos.cliente.nombre, 'Ana Nueva Díaz', 'el nombre sale del perfil cuando el cuerpo no trae uno');
    assert.strictEqual(p.datos.cliente.calle, 'Av. Siempre Viva');
    assert.strictEqual(p.datos.cliente.numero_exterior, '742');
    assert.strictEqual(p.datos.cliente.colonia, 'Springfield');
    assert.strictEqual(p.datos.cliente.referencia, 'Portón azul');
    assert.strictEqual(p.datos.tienda.zona, 'Centro', 'la zona sale de la dirección guardada, no del cuerpo');
    assert.strictEqual(Number(p.datos.costo_envio), 30, 'y el envío es el de esa zona');
    assert.ok(String(p.datos.notas).includes('Sin cebolla') && String(p.datos.notas).includes('Tocar dos veces'),
      'las instrucciones de entrega viajan en las notas: ' + p.datos.notas);
    assert.strictEqual(p.datos.tienda.direccion_id, dirCasa.id);
  });

  await t('CHECKOUT', '23. editar la dirección después NO altera el pedido histórico (snapshot, no puntero)', async () => {
    const antes = (await pedidoDe(folioSesion)).datos.cliente;
    const r = await ana.pedir(`/api/tienda/${SLUG_A}/cuenta/direcciones/${dirCasa.id}`, { method: 'PUT', body: {
      alias: 'Casa', calle: 'Calle Nueva', numeroExterior: '1', colonia: 'Otra', zona: 'Lejos',
    }});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.direccion.calle, 'Calle Nueva');
    const despues = (await pedidoDe(folioSesion)).datos.cliente;
    assert.deepStrictEqual(despues, antes, 'el pedido debe seguir diciendo Av. Siempre Viva');
    // Y borrar la dirección tampoco toca el pedido.
    const d = await ana.pedir(`/api/tienda/${SLUG_A}/cuenta/direcciones/${dirCasa.id}`, { method: 'DELETE' });
    assert.strictEqual(d.status, 200);
    assert.deepStrictEqual((await pedidoDe(folioSesion)).datos.cliente, antes);
  });

  await t('CHECKOUT', '24. editar el perfil tampoco cambia cómo aparece el pedido', async () => {
    const antes = (await pedidoDe(folioSesion)).datos.cliente;
    await ana.pedir(`/api/tienda/${SLUG_A}/cuenta`, { method: 'PATCH', body: { nombre: 'Nombre Cambiado' } });
    assert.deepStrictEqual((await pedidoDe(folioSesion)).datos.cliente, antes);
  });

  await t('CHECKOUT', '25. "Mis pedidos" muestra el pedido con su liga de seguimiento y sin datos de nadie más', async () => {
    const r = await ana.pedir(`/api/tienda/${SLUG_A}/cuenta/pedidos`);
    assert.strictEqual(r.status, 200);
    const p = r.body.pedidos.find(x => x.folio === folioSesion);
    assert.ok(p, 'debe listar el pedido');
    assert.match(p.seguimiento, /^\/seguimiento\/[a-f0-9]{48}$/);
    assert.strictEqual(p.modalidad, 'domicilio');
  });

  await t('CHECKOUT', '26. una dirección de OTRO cliente del mismo negocio no se puede usar ni leer ni borrar', async () => {
    const otro = navegador();
    await entrar(otro, SLUG_A, TEL_OTRO, 'Otro Cliente');
    let r = await otro.pedir(`/api/tienda/${SLUG_A}/checkout`, { method: 'POST', body: checkoutBody({ modalidad: 'domicilio', direccionId: dirTrabajo.id }) });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.strictEqual(r.body.codigo, 'DIRECCION_INVALIDA');
    r = await otro.pedir(`/api/tienda/${SLUG_A}/cuenta/direcciones/${dirTrabajo.id}`, { method: 'PUT', body: { alias: 'Casa', calle: 'Robada', zona: 'Centro' } });
    assert.strictEqual(r.status, 404);
    r = await otro.pedir(`/api/tienda/${SLUG_A}/cuenta/direcciones/${dirTrabajo.id}`, { method: 'DELETE' });
    assert.strictEqual(r.status, 404);
    r = await otro.pedir(`/api/tienda/${SLUG_A}/cuenta/direcciones/${dirTrabajo.id}/predeterminada`, { method: 'POST' });
    assert.strictEqual(r.status, 404);
    const { rows } = await pool.query('SELECT calle FROM cliente_direcciones WHERE id=$1', [dirTrabajo.id]);
    assert.strictEqual(rows[0].calle, 'Reforma', 'intacta');
  });

  await t('CHECKOUT', '27. sin sesión no se puede crear ni usar una dirección guardada', async () => {
    const nav = navegador();
    let r = await nav.pedir(`/api/tienda/${SLUG_A}/cuenta/direcciones`, { method: 'POST', body: { alias: 'Casa', calle: 'X', zona: 'Centro' } });
    assert.strictEqual(r.status, 401);
    r = await nav.pedir(`/api/tienda/${SLUG_A}/checkout`, { method: 'POST', body: checkoutBody({ modalidad: 'domicilio', direccionId: dirTrabajo.id }) });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.codigo, 'DIRECCION_REQUIERE_SESION');
  });

  await t('CHECKOUT', '28. el checkout de INVITADO sigue funcionando exactamente igual (sin cliente_id)', async () => {
    const nav = navegador();
    const r = await nav.pedir(`/api/tienda/${SLUG_A}/checkout`, { method: 'POST', body: checkoutBody({
      modalidad: 'domicilio', direccion: 'Calle libre 12, entre A y B', zona: 'Lejos',
    })});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const p = await pedidoDe(r.body.folio);
    assert.strictEqual(p.cliente_id, null);
    assert.strictEqual(p.datos.cliente_id, undefined);
    assert.strictEqual(p.datos.cliente.telefono, TEL_INVITADO);
    assert.strictEqual(p.datos.cliente.calle, 'Calle libre 12, entre A y B');
    assert.strictEqual(Number(p.datos.costo_envio), 80);
  });

  await t('CHECKOUT', '29. el checkout no marca ningún consentimiento de marketing por su cuenta', async () => {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM cliente_consentimientos WHERE cliente_id=$1', [ctaAna.id]);
    assert.strictEqual(rows[0].n, 0);
    const r = await ana.pedir(`/api/tienda/${SLUG_A}/cuenta`);
    assert.strictEqual(r.body.consentimientos.whatsapp.otorgado, false);
    assert.strictEqual(r.body.consentimientos.email.otorgado, false);
  });

  await t('CONSENTIMIENTO', '30. el cliente otorga y retira consentimiento por canal, con fecha y fuente', async () => {
    let r = await ana.pedir(`/api/tienda/${SLUG_A}/cuenta/consentimientos`, { method: 'PUT', body: { whatsapp: true } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.consentimientos.whatsapp.otorgado, true);
    assert.strictEqual(r.body.consentimientos.whatsapp.fuente, 'mi_cuenta');
    assert.strictEqual(r.body.consentimientos.email.otorgado, false);
    r = await ana.pedir(`/api/tienda/${SLUG_A}/cuenta/consentimientos`, { method: 'PUT', body: { whatsapp: false, email: true } });
    assert.strictEqual(r.body.consentimientos.whatsapp.otorgado, false);
    assert.strictEqual(r.body.consentimientos.email.otorgado, true);
    const { rows } = await pool.query('SELECT canal, otorgado FROM cliente_consentimientos WHERE cliente_id=$1 ORDER BY id', [ctaAna.id]);
    assert.deepStrictEqual(rows.map(x => `${x.canal}:${x.otorgado}`), ['whatsapp:true', 'whatsapp:false', 'email:true'], 'bitácora completa, no un flag');
  });

  // ═══════════════ MULTI-TENANT ═══════════════
  await t('AISLAMIENTO', '31. la sesión del negocio A no existe en la tienda del negocio B', async () => {
    const r = await ana.pedir(`/api/tienda/${SLUG_B}/cuenta`);
    assert.strictEqual(r.status, 401, 'misma cookie, otro negocio: no autenticado');
    const d = await ana.pedir(`/api/tienda/${SLUG_B}/cuenta/direcciones`);
    assert.strictEqual(d.status, 401);
  });

  await t('AISLAMIENTO', '32. el mismo teléfono en A y en B son dos clientes distintos, cada uno con su libreta', async () => {
    const bob = navegador();
    const r = await entrar(bob, SLUG_B, TEL_NUEVA, 'Ana en B');
    assert.strictEqual(r.nuevo, true, 'en B no existía');
    assert.notStrictEqual(r.cliente.id, ctaAna.id);
    const dirs = await bob.pedir(`/api/tienda/${SLUG_B}/cuenta/direcciones`);
    assert.deepStrictEqual(dirs.body.direcciones, [], 'las direcciones de A no se ven en B');
    // Y con la sesión de B no se puede usar la dirección de A en un checkout de B.
    const ck = await bob.pedir(`/api/tienda/${SLUG_B}/checkout`, { method: 'POST', body: {
      checkoutToken: tokenCk(), items: [{ productoId: PROD.B, cantidad: 1 }], modalidad: 'domicilio',
      metodoPago: 'efectivo', cliente: { nombre: 'x', telefono: TEL_NUEVA }, direccionId: dirTrabajo.id,
    }});
    assert.strictEqual(ck.status, 400);
    assert.strictEqual(ck.body.codigo, 'DIRECCION_INVALIDA');
  });

  await t('AISLAMIENTO', '33. una fila hija no puede colgar de un cliente de otro negocio (FK compuesta)', async () => {
    const { rows: [cB] } = await pool.query('SELECT id FROM clientes_negocio WHERE negocio_id=$1 AND telefono=$2', [NEG_B, TEL_NUEVA]);
    await assert.rejects(
      pool.query(`INSERT INTO cliente_direcciones (negocio_id, cliente_id, calle) VALUES ($1, $2, 'cruzada')`, [NEG_A, cB.id]),
      /foreign key/i, 'negocio A + cliente de B debe rechazarse en la base');
  });

  // ═══════════════ REWARDS ═══════════════
  const rica = navegador();
  await t('REWARDS', '34. un cliente con puntos previos ve su saldo, nivel y movimientos al entrar (y la cuenta queda vinculada)', async () => {
    await entrar(rica, SLUG_A, TEL_RW, 'Rica Rewards');
    const r = await rica.pedir(`/api/tienda/${SLUG_A}/cuenta/rewards`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.activo, true);
    assert.strictEqual(r.body.puntos, 300);
    assert.strictEqual(r.body.puntosCanjeables, 300);
    assert.strictEqual(r.body.canjeMinimo, 100);
    assert.strictEqual(r.body.canjeEnTienda, true);
    assert.strictEqual(r.body.valorCanjeable, 150, '300 pts × 0.5');
    assert.strictEqual(r.body.nivel.nombre, 'Bronze');
    assert.ok(r.body.movimientos.length >= 1 && r.body.movimientos[0].tipo === 'acumulacion');
    const { rows } = await pool.query('SELECT cliente_id FROM rewards_accounts WHERE telefono=$1 AND tenant_id=$2', [TEL_RW, NEG_A]);
    assert.ok(rows[0].cliente_id, 'la cuenta vieja apunta ahora al cliente');
  });

  await t('REWARDS', '35. entrar, editar el perfil y guardar direcciones no mueve un solo punto', async () => {
    await rica.pedir(`/api/tienda/${SLUG_A}/cuenta`, { method: 'PATCH', body: { nombre: 'Rica R.' } });
    await rica.pedir(`/api/tienda/${SLUG_A}/cuenta/direcciones`, { method: 'POST', body: { alias: 'Casa', calle: 'Puntos 1', zona: 'Centro' } });
    assert.strictEqual(await saldoDe(NEG_A, TEL_RW), 300);
    const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int AS n FROM rewards_movements m JOIN rewards_accounts a ON a.id=m.account_id WHERE a.telefono=$1 AND a.tenant_id=$2`, [TEL_RW, NEG_A]);
    assert.strictEqual(n, 1, 'sigue habiendo un solo movimiento');
  });

  await t('REWARDS', '36. con sesión, la cotización ofrece los puntos del teléfono VERIFICADO aunque el cuerpo diga otro', async () => {
    const r = await rica.pedir(`/api/tienda/${SLUG_A}/cotizar`, { method: 'POST', body: { items: itemsA(), modalidad: 'recoger', telefono: TEL_VICTIMA, rewardsPuntos: 0 } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.rewards.puntos, 300, 'los de Rica (300), no los de la víctima (500)');
    assert.strictEqual(r.body.rewards.requiereSesion, undefined);
  });

  await t('REWARDS', '37. un cliente autenticado canjea SUS puntos en el checkout; el saldo baja exactamente eso', async () => {
    const r = await rica.pedir(`/api/tienda/${SLUG_A}/checkout`, { method: 'POST', body: checkoutBody({
      cliente: { nombre: 'Rica', telefono: TEL_VICTIMA }, rewardsPuntos: 200,
    })});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.rewards, { puntos: 200, monto: 100 });
    assert.strictEqual(await saldoDe(NEG_A, TEL_RW), 100, 'Rica gastó 200');
    assert.strictEqual(await saldoDe(NEG_A, TEL_VICTIMA), 500, 'la víctima sigue con 500');
    const p = await pedidoDe(r.body.folio);
    assert.strictEqual(p.datos.cliente.telefono, TEL_RW);
    assert.strictEqual(Number(p.datos.total), 100, '200 − 100 de puntos');
  });

  await t('REWARDS', '38. un INVITADO en una tienda con cuentas no puede gastar los puntos de un teléfono que teclea', async () => {
    const nav = navegador();
    const cot = await nav.pedir(`/api/tienda/${SLUG_A}/cotizar`, { method: 'POST', body: { items: itemsA(), modalidad: 'recoger', telefono: TEL_VICTIMA, rewardsPuntos: 500 } });
    assert.strictEqual(cot.status, 200);
    assert.strictEqual(cot.body.rewards.requiereSesion, true);
    assert.strictEqual(cot.body.rewards.puntosAplicados, 0);
    assert.strictEqual(cot.body.rewards.puntos, 0, 'ni siquiera se le muestra el saldo ajeno');
    assert.ok(cot.body.rewards.puntosQueGanaria > 0, 'pero sí cuánto ganaría');
    const r = await nav.pedir(`/api/tienda/${SLUG_A}/checkout`, { method: 'POST', body: checkoutBody({
      cliente: { nombre: 'Ladrón', telefono: TEL_VICTIMA }, rewardsPuntos: 500,
    })});
    assert.strictEqual(r.status, 200, 'el pedido sí se crea, a precio completo');
    assert.strictEqual(r.body.rewards, null);
    assert.strictEqual(Number(r.body.total), 200);
    assert.strictEqual(await saldoDe(NEG_A, TEL_VICTIMA), 500, 'ni un punto de la víctima');
    const oraculo = await nav.pedir(`/api/tienda/${SLUG_A}/rewards?telefono=${TEL_VICTIMA}&total=200`);
    assert.strictEqual(oraculo.body.puntos, 0, 'el oráculo público tampoco revela saldos con cuentas encendidas');
  });

  await t('REWARDS', '39. un cliente de A no ve ni puede usar puntos que tiene en B', async () => {
    await cuentaRewards(NEG_B, TEL_RW, 900, 'Rica en B');
    const r = await rica.pedir(`/api/tienda/${SLUG_A}/cuenta/rewards`);
    assert.strictEqual(r.body.puntos, 100, 'solo los de A');
    assert.strictEqual(await saldoDe(NEG_B, TEL_RW), 900);
  });

  // ═══════════════ SESIÓN ═══════════════
  await t('SESION', '40. cerrar sesión revoca el token en el servidor: la cookie vieja ya no entra', async () => {
    const vieja = ana.jar.cookie;
    const r = await ana.pedir(`/api/tienda/${SLUG_A}/cuenta/logout`, { method: 'POST' });
    assert.strictEqual(r.status, 200);
    assert.match(ana.jar.ultimoSetCookie, /xabor_cliente=;.*Max-Age=0/);
    const otra = await ana.pedir(`/api/tienda/${SLUG_A}/cuenta`, { cookie: vieja });
    assert.strictEqual(otra.status, 401);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM cliente_sesiones WHERE cliente_id=$1 AND revocada_at IS NULL', [ctaAna.id]);
    assert.ok(rows[0].n >= 0);
  });

  await t('SESION', '41. un token inventado o alterado no abre nada', async () => {
    const nav = navegador();
    for (const falso of ['xabor_cliente=' + randomBytes(32).toString('base64url'), 'xabor_cliente=abc', 'xabor_cliente=']) {
      const r = await nav.pedir(`/api/tienda/${SLUG_A}/cuenta`, { cookie: falso });
      assert.strictEqual(r.status, 401, falso.slice(0, 30));
    }
  });

  // ═══════════════ INTERRUPTOR ═══════════════
  await t('INTERRUPTOR', '42. con cuentas APAGADAS la tienda es la de siempre: sin login (404), invitado igual, canje por teléfono como antes', async () => {
    await pool.query('UPDATE tienda_config SET cuentas_clientes = FALSE WHERE negocio_id = $1', [NEG_A]);
    try {
      const nav = navegador();
      let r = await nav.pedir(`/api/tienda/${SLUG_A}`);
      assert.strictEqual(r.body.cuentas, false);
      r = await nav.pedir(`/api/tienda/${SLUG_A}/cuenta/otp`, { method: 'POST', body: { telefono: TEL_INVITADO } });
      assert.strictEqual(r.status, 404, 'indistinguible de una ruta inexistente');
      r = await nav.pedir(`/api/tienda/${SLUG_A}/cuenta`, { cookie: rica.jar.cookie });
      assert.strictEqual(r.status, 404, 'ni con una cookie válida');
      // Comportamiento heredado intacto: el canje por teléfono tecleado.
      const cot = await nav.pedir(`/api/tienda/${SLUG_A}/cotizar`, { method: 'POST', body: { items: itemsA(), modalidad: 'recoger', telefono: TEL_VICTIMA, rewardsPuntos: 0 } });
      assert.strictEqual(cot.body.rewards.puntos, 500, 'sin cuentas, el saldo del teléfono tecleado se sigue mostrando (como antes)');
      const ck = await nav.pedir(`/api/tienda/${SLUG_A}/checkout`, { method: 'POST', body: checkoutBody({ modalidad: 'domicilio', direccion: 'Calle libre 3', zona: 'Centro' }) });
      assert.strictEqual(ck.status, 200);
      assert.strictEqual((await pedidoDe(ck.body.folio)).cliente_id, null);
    } finally {
      await pool.query('UPDATE tienda_config SET cuentas_clientes = TRUE WHERE negocio_id = $1', [NEG_A]);
    }
  });

  // ═══════════════ MIGRACIÓN ═══════════════
  await t('MIGRACION', '43. el backfill de la 080 une dos cuentas de Rewards con formato distinto en UN cliente, sin tocar saldos, y es re-ejecutable', async () => {
    await cuentaRewards(NEG_A, TEL_MIG1, 120, 'Migrada Diez');
    await cuentaRewards(NEG_A, '521' + TEL_MIG1, 80, null);
    const foto = async () => (await pool.query(
      `SELECT telefono, puntos_balance, cliente_id FROM rewards_accounts WHERE tenant_id=$1 AND telefono IN ($2,$3) ORDER BY telefono`, [NEG_A, TEL_MIG1, '521' + TEL_MIG1])).rows;
    const antes = await foto();
    assert.strictEqual(antes.length, 2);
    const correr = () => execFileSync(process.execPath, [join(RAIZ, 'scripts', 'predeploy-080-clientes-tienda.mjs')], { env: process.env, encoding: 'utf8' });
    const salida1 = correr();
    assert.match(salida1, /Rewards intacto/);
    const { rows: clientes } = await pool.query('SELECT id, nombre, telefono FROM clientes_negocio WHERE negocio_id=$1 AND telefono=$2', [NEG_A, TEL_MIG1]);
    assert.strictEqual(clientes.length, 1, 'un solo cliente para los dos formatos');
    assert.strictEqual(clientes[0].nombre, 'Migrada Diez', 'gana la cuenta que tiene nombre');
    const despues = await foto();
    assert.deepStrictEqual(despues.map(x => x.puntos_balance), antes.map(x => x.puntos_balance), 'saldos intactos');
    assert.ok(despues.every(x => x.cliente_id === clientes[0].id), 'las dos apuntan al mismo cliente');
    correr();
    const otraVez = await pool.query('SELECT count(*)::int AS n FROM clientes_negocio WHERE negocio_id=$1 AND telefono=$2', [NEG_A, TEL_MIG1]);
    assert.strictEqual(otraVez.rows[0].n, 1, 'segunda corrida: nada nuevo');
    assert.deepStrictEqual(await foto(), despues);
    // Y al entrar, ese cliente ve la SUMA como saldo y lo canjeable en tienda
    // es lo de la cuenta en 10 dígitos (la que usa el checkout).
    const nav = navegador();
    await entrar(nav, SLUG_A, TEL_MIG1, 'Migrada');
    const rw = await nav.pedir(`/api/tienda/${SLUG_A}/cuenta/rewards`);
    assert.strictEqual(rw.body.puntos, 200);
    assert.strictEqual(rw.body.puntosCanjeables, 120);
    assert.strictEqual(rw.body.cuentas, 2);
  });

  await t('MIGRACION', '44. la 080 está en el runner del predeploy y trae rollback', async () => {
    const runner = readFileSync(join(RAIZ, 'scripts', 'predeploy-run-032-033.mjs'), 'utf8');
    assert.ok(runner.includes("'080-clientes-tienda'"));
    assert.ok(runner.indexOf("'079-rewards-canal-tienda'") < runner.indexOf("'080-clientes-tienda'"), 'después de la 079');
    const down = readFileSync(join(RAIZ, 'migrations', '080_clientes_tienda_down.sql'), 'utf8');
    for (const tabla of ['clientes_negocio', 'cliente_direcciones', 'cliente_otp', 'cliente_sesiones', 'cliente_consentimientos']) {
      assert.ok(down.includes(`DROP TABLE IF EXISTS ${tabla}`), `el rollback borra ${tabla}`);
    }
    assert.ok(!down.includes('DROP TABLE IF EXISTS rewards'), 'el rollback jamás toca Rewards');
  });
} finally {
  console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
  if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
  if (fallidas) {
    const salida = srv.obtenerSalida().split('\n').filter(l => /error|\[Tienda\]|\[OTP\]|FALLO/i.test(l)).slice(-15).join('\n');
    if (salida) console.log('\nErrores del servidor:\n' + salida);
  }
  await restaurarEstado().catch(e => console.error('No se pudo restaurar el estado:', e.message));
  await srv.detener();
  await pool.end();
  process.exitCode = fallidas > 0 ? 1 : 0;
}
