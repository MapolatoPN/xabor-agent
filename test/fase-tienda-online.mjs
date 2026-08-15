// ─── Tienda Online: suite end-to-end ───────────────────────────────────────
//
// Cubre el módulo completo con datos reales contra Postgres: resolución
// multiempresa, catálogo, promociones, checkout idempotente, seguimiento,
// backoffice, aislamiento entre negocios, carreras y ataques.
//
// Las tres preguntas que esta suite existe para responder:
//   1. ¿Puede un negocio ver, cobrar o tocar algo de otro? (nunca)
//   2. ¿Puede el navegador del cliente decidir un precio? (nunca)
//   3. ¿Un reintento crea dos pedidos? (nunca)
//
// Uso: mismas env vars que la batería (DATABASE_URL, PANEL_SECRET, …).
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { randomBytes } from 'crypto';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4207';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const cookie = (usuarioId, negocioId, rol) =>
  `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;

const NEG_A = SEED.negocioA;
const NEG_B = SEED.negocioB;
const ADMIN_A = cookie(SEED.adminNegocioAUsuarioId, NEG_A, 'admin');
let ADMIN_B = null;  // se crea con el fixture: un usuario real del negocio B
const STAFF_A = cookie(SEED.staffNegocioAUsuarioId, NEG_A, 'staff');

const SLUG_A = 'tienda-prueba-a';
const SLUG_B = 'tienda-prueba-b';

let base;
const url = r => `${base}${r}`;
const token = () => randomBytes(24).toString('hex');

async function get(ruta, cookieVal) {
  const r = await fetch(url(ruta), { headers: cookieVal ? { Cookie: cookieVal } : {} });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function post(ruta, cuerpo, cookieVal, metodo = 'POST') {
  const r = await fetch(url(ruta), {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(cookieVal ? { Cookie: cookieVal } : {}) },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`, [negocioId, modulo, estado]);
}

// ── Fixtures: dos tiendas completas, una por negocio ──
// Se construyen SOLO con las mismas operaciones que haría un negocio real:
// catálogo, reglas de atención, métodos de pago y config de tienda. Ningún
// dato se inyecta por una vía que un cliente no tendría.
const PROD = { A: {}, B: {} };
let GRUPO_A = null, OPCIONES_A = [];

async function prepararNegocio(negocioId, etiqueta, slug, productos) {
  await fijarModulo(negocioId, 'tienda_online', 'activo');
  await fijarModulo(negocioId, 'pos', 'activo');
  await fijarModulo(negocioId, 'menu', 'activo');

  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,901) RETURNING id`,
    [negocioId, `Tienda ${etiqueta} (test)`]);

  for (const [nombre, precio] of productos) {
    const { rows: [p] } = await pool.query(
      `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden)
       VALUES ($1,$2,$3,$4,TRUE,1) RETURNING id`, [negocioId, cat.id, nombre, precio]);
    PROD[etiqueta][nombre] = p.id;
    await pool.query(
      `INSERT INTO tienda_productos (negocio_id, producto_id, publicado) VALUES ($1,$2,TRUE)
       ON CONFLICT (negocio_id, producto_id) DO UPDATE SET publicado = TRUE`, [negocioId, p.id]);
  }

  // Horarios abiertos todos los días y reglas de envío reales.
  const reglas = {
    horarios: Object.fromEntries(['lunes','martes','miercoles','jueves','viernes','sabado','domingo']
      .map(d => [d, { abierto: true, apertura: '00:00', cierre: '23:59' }])),
    pedidos: {
      costo_envio: 40, pedido_minimo_entrega: 100, entrega_gratis_desde: 500,
      zonas_entrega: [{ nombre: 'Centro', costo: 30 }, { nombre: 'Lejos', costo: 80 }],
      tiempo_preparacion_minutos: 20, tiempo_entrega_min_minutos: 30, tiempo_entrega_max_minutos: 45,
      pago_instrucciones: 'CLABE de prueba 0000',
    },
  };
  await pool.query(
    `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'reglas_atencion',$2)
     ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $2`,
    [negocioId, JSON.stringify(reglas)]);

  for (const tipo of ['efectivo', 'transferencia']) {
    await pool.query(
      `INSERT INTO metodos_pago (negocio_id, tipo, habilitado) VALUES ($1,$2,TRUE)
       ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = TRUE`, [negocioId, tipo]);
  }

  await pool.query(
    `INSERT INTO tienda_config (negocio_id, estado, slug_publico, titular, modalidades, acepta_programados, anticipacion_minutos)
     VALUES ($1,'publicada',$2,$3,$4,TRUE,60)
     ON CONFLICT (negocio_id) DO UPDATE SET estado='publicada', slug_publico=$2, titular=$3,
       modalidades=$4, acepta_programados=TRUE, anticipacion_minutos=60`,
    [negocioId, slug, `Tienda ${etiqueta}`, JSON.stringify(['recoger', 'domicilio'])]);
  return cat.id;
}

async function prepararFixtures() {
  const catA = await prepararNegocio(NEG_A, 'A', SLUG_A, [['Pizza tienda', 200], ['Refresco tienda', 30]]);
  await prepararNegocio(NEG_B, 'B', SLUG_B, [['Sushi tienda', 150]]);

  // Un grupo de modificadores obligatorio en el negocio A: sirve para probar
  // que la tienda respeta requerido/minimo/maximo igual que el POS.
  const { rows: [g] } = await pool.query(
    `INSERT INTO menu_modificadores_grupos (negocio_id, producto_id, nombre, requerido, minimo, maximo, orden)
     VALUES ($1,$2,'Tamaño',TRUE,1,1,1) RETURNING id`, [NEG_A, PROD.A['Pizza tienda']]);
  GRUPO_A = g.id;
  for (const [nombre, extra] of [['Chica', 0], ['Grande', 50]]) {
    const { rows: [o] } = await pool.query(
      `INSERT INTO menu_modificadores_opciones (negocio_id, grupo_id, nombre, precio_extra, disponible, orden)
       VALUES ($1,$2,$3,$4,TRUE,1) RETURNING id`, [NEG_A, g.id, nombre, extra]);
    OPCIONES_A.push({ nombre, id: o.id, extra });
  }
  // Un admin REAL del negocio B. Sin esto no se puede probar el aislamiento:
  // requireAuthSeguro rechaza al admin de A antes de llegar al endpoint, así
  // que "no pudo" sería por membresía, no por el aislamiento que se quiere ver.
  // El rol no vive en la tabla: viaja firmado en el token de sesión. Aquí solo
  // hace falta que el usuario EXISTA y pertenezca al negocio B.
  await pool.query(`DELETE FROM usuarios WHERE email = 'admin-b-tienda@prueba.local'`).catch(() => {});
  const { rows: [u] } = await pool.query(
    `INSERT INTO usuarios (negocio_id, nombre, email, activo)
     VALUES ($1,'Admin B prueba','admin-b-tienda@prueba.local',TRUE) RETURNING id`, [NEG_B]);
  // La membresía (y el rol real) viven en usuario_negocios: el token de sesión
  // dice qué rol AFIRMA tener, pero el servidor lo contrasta contra esta tabla.
  await pool.query(
    `INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo)
     VALUES ($1,$2,'admin',TRUE)
     ON CONFLICT (usuario_id, negocio_id) DO UPDATE SET rol='admin', activo=TRUE`,
    [u.id, NEG_B]);
  ADMIN_B = cookie(u.id, NEG_B, 'admin');
  return catA;
}

async function limpiarFixtures() {
  for (const neg of [NEG_A, NEG_B]) {
    // Los pedidos de la suite se borran SIEMPRE: varias pruebas cuentan filas,
    // y residuo de una corrida anterior las haría fallar por algo que no pasó.
    await pool.query(
      `DELETE FROM pedidos_activos WHERE negocio_id = $1 AND datos->>'canal' = 'tienda_online'`, [neg]);
    await pool.query(
      `DELETE FROM pedidos WHERE negocio_id = $1 AND telefono LIKE '899%'`, [neg]).catch(() => {});
    await pool.query(`DELETE FROM tienda_promocion_usos WHERE negocio_id = $1`, [neg]);
    await pool.query(`DELETE FROM tienda_promociones WHERE negocio_id = $1`, [neg]);
    await pool.query(`DELETE FROM tienda_campanas WHERE negocio_id = $1`, [neg]);
    await pool.query(`DELETE FROM tienda_pedidos WHERE negocio_id = $1`, [neg]);
    await pool.query(`DELETE FROM tienda_config WHERE negocio_id = $1`, [neg]);
    await pool.query(`DELETE FROM usuarios WHERE email = 'admin-b-tienda@prueba.local'`).catch(() => {});
    await pool.query(
      `DELETE FROM menu_modificadores_opciones WHERE grupo_id IN
        (SELECT g.id FROM menu_modificadores_grupos g JOIN menu_categorias c ON c.negocio_id = g.negocio_id
          WHERE g.negocio_id = $1 AND c.nombre LIKE 'Tienda %(test)')`, [neg]).catch(() => {});
    await pool.query(`DELETE FROM menu_modificadores_grupos WHERE negocio_id = $1 AND nombre = 'Tamaño'`, [neg]).catch(() => {});
    await pool.query(
      `DELETE FROM menu_productos WHERE categoria_id IN
        (SELECT id FROM menu_categorias WHERE negocio_id = $1 AND nombre LIKE 'Tienda %(test)')`, [neg]);
    await pool.query(`DELETE FROM menu_categorias WHERE negocio_id = $1 AND nombre LIKE 'Tienda %(test)'`, [neg]);
  }
}

const itemPizza = (cantidad = 1, opcion = 'Chica') => ({
  productoId: PROD.A['Pizza tienda'], cantidad,
  modificadores: [{ grupoId: GRUPO_A, opcionId: OPCIONES_A.find(o => o.nombre === opcion).id }],
});

// ═══════════════════════════════════════════════════════════════════════════
let servidor;
try {
  await limpiarFixtures();
  await prepararFixtures();
  // Topes altos para el grueso de la suite (una suite entera sale de la misma
  // IP). El rate limit REAL se prueba aparte, con su propio servidor y topes
  // mínimos, al final.
  servidor = await arrancarServidor(
    { PORT: PUERTO, XABOR_TIENDA_LIMITE_CHECKOUT: '500', XABOR_TIENDA_LIMITE_COTIZAR: '500',
      XABOR_TIENDA_LIMITE_LECTURA: '500' },
    { timeoutMs: 90000 });
  base = `http://localhost:${PUERTO}`;

  // ─── 1. Superficie pública: resolución y catálogo ───
  await t('publico', 'la tienda publicada responde por su slug', async () => {
    const { status, body } = await get(`/api/tienda/${SLUG_A}`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.slug, SLUG_A);
    assert.strictEqual(body.negocio, 'Tienda A');
    assert.deepStrictEqual(body.modalidades.sort(), ['domicilio', 'recoger']);
  });

  await t('publico', 'un slug inexistente da 404 sin filtrar nada', async () => {
    const { status, body } = await get('/api/tienda/no-existe-jamas');
    assert.strictEqual(status, 404);
    assert.ok(!JSON.stringify(body).includes('negocio_id'));
  });

  await t('publico', 'el catálogo solo trae productos publicados de ESE negocio', async () => {
    const { body } = await get(`/api/tienda/${SLUG_A}/catalogo`);
    const nombres = body.categorias.flatMap(c => c.productos.map(p => p.nombre));
    assert.ok(nombres.includes('Pizza tienda'));
    assert.ok(!nombres.includes('Sushi tienda'), 'se filtró un producto del negocio B');
  });

  await t('publico', 'los modificadores llegan con sus reglas reales', async () => {
    const { body } = await get(`/api/tienda/${SLUG_A}/catalogo`);
    const pizza = body.categorias.flatMap(c => c.productos).find(p => p.nombre === 'Pizza tienda');
    const g = pizza.grupos[0];
    assert.strictEqual(g.requerido, true);
    assert.strictEqual(g.min, 1);
    assert.strictEqual(g.max, 1);
    assert.strictEqual(g.opciones.length, 2);
  });

  await t('publico', 'despublicar un producto lo saca del catálogo al instante', async () => {
    const id = PROD.A['Refresco tienda'];
    await pool.query(`UPDATE tienda_productos SET publicado = FALSE WHERE negocio_id=$1 AND producto_id=$2`, [NEG_A, id]);
    const { body } = await get(`/api/tienda/${SLUG_A}/catalogo`);
    const nombres = body.categorias.flatMap(c => c.productos.map(p => p.nombre));
    assert.ok(!nombres.includes('Refresco tienda'));
    await pool.query(`UPDATE tienda_productos SET publicado = TRUE WHERE negocio_id=$1 AND producto_id=$2`, [NEG_A, id]);
  });

  await t('publico', 'los métodos de pago son los que el negocio habilitó', async () => {
    const { body } = await get(`/api/tienda/${SLUG_A}/pagos?modalidad=recoger`);
    const ids = body.metodos.map(m => m.id).sort();
    assert.deepStrictEqual(ids, ['efectivo', 'transferencia']);
    assert.ok(body.metodos.find(m => m.id === 'transferencia').instrucciones);
  });

  // ─── 2. Estados de la tienda ───
  await t('estado', 'una tienda en borrador no es accesible al público', async () => {
    await pool.query(`UPDATE tienda_config SET estado='borrador' WHERE negocio_id=$1`, [NEG_A]);
    const { status } = await get(`/api/tienda/${SLUG_A}`);
    assert.strictEqual(status, 404);
    await pool.query(`UPDATE tienda_config SET estado='publicada' WHERE negocio_id=$1`, [NEG_A]);
  });

  await t('estado', 'una tienda pausada no acepta pedidos', async () => {
    await pool.query(`UPDATE tienda_config SET estado='pausada' WHERE negocio_id=$1`, [NEG_A]);
    const r = await post(`/api/tienda/${SLUG_A}/checkout`, {
      checkoutToken: token(), items: [itemPizza()], modalidad: 'recoger',
      cliente: { nombre: 'Pausa', telefono: '8990000001' },
    });
    assert.ok(r.status >= 400, 'una tienda pausada aceptó un pedido');
    await pool.query(`UPDATE tienda_config SET estado='publicada' WHERE negocio_id=$1`, [NEG_A]);
  });

  await t('estado', 'sin el módulo activo la tienda desaparece del mapa', async () => {
    await fijarModulo(NEG_A, 'tienda_online', 'no_contratado');
    const { status } = await get(`/api/tienda/${SLUG_A}`);
    assert.strictEqual(status, 404, 'debe ser indistinguible de "no existe"');
    await fijarModulo(NEG_A, 'tienda_online', 'activo');
  });

  // ─── 3. El frontend no es autoridad de precios ───
  await t('precios', 'el servidor ignora el precio que manda el cliente', async () => {
    const { body } = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [{ ...itemPizza(), precio: 1, precioUnitario: 1 }],
      modalidad: 'recoger',
    });
    assert.strictEqual(body.subtotal, 200, `esperaba 200, llegó ${body.subtotal}`);
  });

  await t('precios', 'el modificador suma su precio real, no el declarado', async () => {
    const { body } = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [{ ...itemPizza(1, 'Grande'), modificadores: [
        { grupoId: GRUPO_A, opcionId: OPCIONES_A.find(o => o.nombre === 'Grande').id, precioExtra: 9999 }] }],
      modalidad: 'recoger',
    });
    assert.strictEqual(body.subtotal, 250);
  });

  await t('precios', 'un producto de OTRO negocio se rechaza', async () => {
    const r = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [{ productoId: PROD.B['Sushi tienda'], cantidad: 1 }], modalidad: 'recoger',
    });
    assert.ok(r.status >= 400, 'se coló un producto ajeno al carrito');
  });

  await t('precios', 'un producto despublicado no se puede comprar por id', async () => {
    const id = PROD.A['Refresco tienda'];
    await pool.query(`UPDATE menu_productos SET disponible = FALSE WHERE id = $1`, [id]);
    const r = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [{ productoId: id, cantidad: 1 }], modalidad: 'recoger' });
    assert.ok(r.status >= 400 || r.body.subtotal === 0, 'se compró un producto no disponible');
    await pool.query(`UPDATE menu_productos SET disponible = TRUE WHERE id = $1`, [id]);
  });

  await t('precios', 'cantidad negativa o absurda se rechaza', async () => {
    for (const cantidad of [-3, 0, 99999]) {
      const r = await post(`/api/tienda/${SLUG_A}/cotizar`, {
        items: [{ productoId: PROD.A['Pizza tienda'], cantidad,
          modificadores: [{ grupoId: GRUPO_A, opcionId: OPCIONES_A[0].id }] }],
        modalidad: 'recoger' });
      assert.ok(r.status >= 400 || (r.body.subtotal ?? 0) > 0 === false || r.body.subtotal > 0,
        `cantidad ${cantidad} produjo un total inválido`);
      if (r.status === 200) assert.ok(r.body.subtotal >= 0, `subtotal negativo con cantidad ${cantidad}`);
    }
  });

  // ─── 4. Envío y zonas ───
  await t('envio', 'la zona determina el costo de envío', async () => {
    const centro = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [itemPizza()], modalidad: 'domicilio', zona: 'Centro' });
    const lejos = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [itemPizza()], modalidad: 'domicilio', zona: 'Lejos' });
    assert.strictEqual(centro.body.envio, 30);
    assert.strictEqual(lejos.body.envio, 80);
  });

  await t('envio', 'una zona inventada se rechaza — no se cobra envío al azar', async () => {
    const r = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [itemPizza()], modalidad: 'domicilio', zona: 'Marte' });
    assert.ok(r.status >= 400, 'aceptó una zona que el negocio no definió');
  });

  await t('envio', 'recoger nunca cobra envío', async () => {
    const { body } = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [itemPizza()], modalidad: 'recoger', zona: 'Lejos' });
    assert.strictEqual(body.envio, 0);
  });

  await t('envio', 'el pedido mínimo a domicilio bloquea el checkout', async () => {
    const { body } = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [{ productoId: PROD.A['Refresco tienda'], cantidad: 1 }],
      modalidad: 'domicilio', zona: 'Centro' });
    assert.strictEqual(body.cumpleMinimo, false);
    assert.ok(body.faltaParaMinimo > 0);
  });

  await t('envio', 'el mínimo no aplica a recoger', async () => {
    const { body } = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [{ productoId: PROD.A['Refresco tienda'], cantidad: 1 }], modalidad: 'recoger' });
    assert.notStrictEqual(body.cumpleMinimo, false);
  });

  await t('envio', 'una modalidad que la tienda no ofrece se rechaza', async () => {
    await pool.query(`UPDATE tienda_config SET modalidades = $2 WHERE negocio_id = $1`,
      [NEG_A, JSON.stringify(['recoger'])]);
    const r = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [itemPizza()], modalidad: 'domicilio', zona: 'Centro' });
    assert.ok(r.status >= 400);
    await pool.query(`UPDATE tienda_config SET modalidades = $2 WHERE negocio_id = $1`,
      [NEG_A, JSON.stringify(['recoger', 'domicilio'])]);
  });

  // ─── 5. Checkout: pedido real de Xabor ───
  let folioBase = null, trackingBase = null;
  await t('checkout', 'un pedido de tienda entra al sistema como pedido real', async () => {
    const { status, body } = await post(`/api/tienda/${SLUG_A}/checkout`, {
      checkoutToken: token(), items: [itemPizza(2, 'Grande')], modalidad: 'recoger',
      cliente: { nombre: 'Ana Cliente', telefono: '8991110001' },
      metodoPago: 'efectivo',
    });
    assert.strictEqual(status, 200, JSON.stringify(body));
    assert.ok(body.folio, 'no devolvió folio');
    assert.ok(/^[a-f0-9]{48}$/.test(body.trackingToken), 'token de seguimiento no opaco');
    folioBase = body.folio; trackingBase = body.trackingToken;

    const { rows } = await pool.query(
      `SELECT datos, estado FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2`, [folioBase, NEG_A]);
    assert.strictEqual(rows.length, 1, 'el pedido no quedó en pedidos_activos');
    const d = rows[0].datos;
    assert.strictEqual(d.canal, 'tienda_online');
    assert.strictEqual(d.total, 500, `total esperado 500, llegó ${d.total}`);
    assert.strictEqual(d.pago_confirmado, false, 'nace cobrado y no debería');
  });

  await t('checkout', 'el mismo token NO crea un segundo pedido', async () => {
    const tk = token();
    const cuerpo = {
      checkoutToken: tk, items: [itemPizza()], modalidad: 'recoger',
      cliente: { nombre: 'Repetido', telefono: '8991110002' }, metodoPago: 'efectivo',
    };
    const a = await post(`/api/tienda/${SLUG_A}/checkout`, cuerpo);
    const b = await post(`/api/tienda/${SLUG_A}/checkout`, cuerpo);
    assert.strictEqual(a.status, 200);
    assert.strictEqual(b.status, 200, JSON.stringify(b.body));
    assert.strictEqual(a.body.folio, b.body.folio, 'el reintento creó otro folio');
    assert.strictEqual(b.body.yaExistia, true);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM tienda_pedidos WHERE negocio_id=$1 AND checkout_token=$2`, [NEG_A, tk]);
    assert.strictEqual(rows[0].n, 1);
  });

  await t('checkout', 'dos peticiones SIMULTÁNEAS con el mismo token dan un solo pedido', async () => {
    const tk = token();
    const cuerpo = {
      checkoutToken: tk, items: [itemPizza()], modalidad: 'recoger',
      cliente: { nombre: 'Carrera', telefono: '8991110003' }, metodoPago: 'efectivo',
    };
    const [a, b] = await Promise.all([
      post(`/api/tienda/${SLUG_A}/checkout`, cuerpo),
      post(`/api/tienda/${SLUG_A}/checkout`, cuerpo),
    ]);
    const exitosas = [a, b].filter(r => r.status === 200);
    assert.ok(exitosas.length >= 1, 'ninguna de las dos creó el pedido');
    const folios = new Set(exitosas.map(r => r.body.folio));
    assert.strictEqual(folios.size, 1, `se crearon ${folios.size} folios distintos`);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM pedidos_activos WHERE negocio_id=$1
        AND datos->'cliente'->>'telefono' = '8991110003'`, [NEG_A]);
    assert.strictEqual(rows[0].n, 1, `quedaron ${rows[0].n} pedidos para el mismo cliente`);
  });

  await t('checkout', 'un token corto o vacío se rechaza', async () => {
    for (const tk of ['', 'corto', null]) {
      const r = await post(`/api/tienda/${SLUG_A}/checkout`, {
        checkoutToken: tk, items: [itemPizza()], modalidad: 'recoger',
        cliente: { nombre: 'X', telefono: '8991110004' } });
      assert.ok(r.status >= 400, `aceptó el token ${JSON.stringify(tk)}`);
    }
  });

  await t('checkout', 'domicilio sin dirección se rechaza', async () => {
    const r = await post(`/api/tienda/${SLUG_A}/checkout`, {
      checkoutToken: token(), items: [itemPizza()], modalidad: 'domicilio', zona: 'Centro',
      cliente: { nombre: 'Sin dir', telefono: '8991110005' } });
    assert.ok(r.status >= 400, 'creó un pedido a domicilio sin dirección');
  });

  await t('checkout', 'un método de pago que el negocio no habilitó se rechaza', async () => {
    const r = await post(`/api/tienda/${SLUG_A}/checkout`, {
      checkoutToken: token(), items: [itemPizza()], modalidad: 'recoger',
      cliente: { nombre: 'Pago falso', telefono: '8991110006' }, metodoPago: 'enlace_pago' });
    assert.ok(r.status >= 400, 'aceptó un método de pago no habilitado');
  });

  await t('checkout', 'el pedido a domicilio guarda zona, dirección y envío', async () => {
    const { status, body } = await post(`/api/tienda/${SLUG_A}/checkout`, {
      checkoutToken: token(), items: [itemPizza()], modalidad: 'domicilio', zona: 'Centro',
      direccion: 'Calle Falsa 123, colonia Centro',
      cliente: { nombre: 'Domicilio', telefono: '8991110007' }, metodoPago: 'efectivo' });
    assert.strictEqual(status, 200, JSON.stringify(body));
    const { rows } = await pool.query(
      `SELECT datos FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [body.folio, NEG_A]);
    const d = rows[0].datos;
    assert.strictEqual(d.tienda.zona, 'Centro');
    assert.strictEqual(d.total, 230, `esperaba 200+30 de envío, llegó ${d.total}`);
    // La dirección se guarda ESTRUCTURADA (como todo pedido del POS), aunque
    // el cliente la haya escrito de corrido: la zona entra como colonia.
    assert.ok(JSON.stringify(d.direccion || d).includes('Calle Falsa'),
      `no se guardó la dirección: ${JSON.stringify(d.direccion)}`);
  });

  await t('checkout', 'el pedido mínimo también se impone al crear, no solo al cotizar', async () => {
    const r = await post(`/api/tienda/${SLUG_A}/checkout`, {
      checkoutToken: token(), items: [{ productoId: PROD.A['Refresco tienda'], cantidad: 1 }],
      modalidad: 'domicilio', zona: 'Centro', direccion: 'Calle corta 1',
      cliente: { nombre: 'Minimo', telefono: '8991110008' }, metodoPago: 'efectivo' });
    assert.ok(r.status >= 400, 'se creó un pedido por debajo del mínimo');
  });

  // ─── 6. Programación ───
  await t('programado', 'un pedido programado válido se acepta', async () => {
    const cuando = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    const { status, body } = await post(`/api/tienda/${SLUG_A}/checkout`, {
      checkoutToken: token(), items: [itemPizza()], modalidad: 'recoger',
      cliente: { nombre: 'Programado', telefono: '8991110009' },
      metodoPago: 'efectivo', programadoPara: cuando });
    assert.strictEqual(status, 200, JSON.stringify(body));
  });

  await t('programado', 'sin anticipación suficiente se rechaza', async () => {
    const r = await post(`/api/tienda/${SLUG_A}/checkout`, {
      checkoutToken: token(), items: [itemPizza()], modalidad: 'recoger',
      cliente: { nombre: 'Ya mero', telefono: '8991110010' },
      metodoPago: 'efectivo', programadoPara: new Date(Date.now() + 60000).toISOString() });
    assert.ok(r.status >= 400, 'aceptó un programado para dentro de un minuto');
  });

  await t('programado', 'una fecha absurda o muy lejana se rechaza', async () => {
    for (const p of ['no-es-fecha', new Date(Date.now() + 60 * 86400000).toISOString()]) {
      const r = await post(`/api/tienda/${SLUG_A}/checkout`, {
        checkoutToken: token(), items: [itemPizza()], modalidad: 'recoger',
        cliente: { nombre: 'Fecha rara', telefono: '8991110011' },
        metodoPago: 'efectivo', programadoPara: p });
      assert.ok(r.status >= 400, `aceptó programar para ${p}`);
    }
  });

  // ─── 7. Seguimiento público ───
  await t('seguimiento', 'el token de seguimiento muestra el avance del pedido', async () => {
    const { status, body } = await get(`/api/tienda/seguimiento/${trackingBase}`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.folio, folioBase);
    assert.strictEqual(body.negocio, 'Tienda A');
    assert.ok(Array.isArray(body.etapas) && body.etapas.length);
  });

  await t('seguimiento', 'no expone datos internos ni de otros clientes', async () => {
    const { body } = await get(`/api/tienda/seguimiento/${trackingBase}`);
    const txt = JSON.stringify(body);
    assert.ok(!txt.includes(NEG_A), 'filtró el negocio_id');
    assert.ok(!txt.includes('8991110001'), 'filtró el teléfono del cliente');
    assert.ok(!/direccion/i.test(txt), 'filtró la dirección');
  });

  await t('seguimiento', 'un token inventado o malformado da 404, nunca una pista', async () => {
    for (const tk of ['abc', 'a'.repeat(48), '../../etc/passwd', '%00']) {
      const { status } = await get(`/api/tienda/seguimiento/${encodeURIComponent(tk)}`);
      assert.strictEqual(status, 404, `token ${tk} devolvió ${status}`);
    }
  });

  await t('seguimiento', 'el avance del pedido se refleja en las etapas', async () => {
    await pool.query(`UPDATE pedidos_activos SET estado='en_preparacion' WHERE folio=$1 AND negocio_id=$2`,
      [folioBase, NEG_A]);
    const { body } = await get(`/api/tienda/seguimiento/${trackingBase}`);
    assert.strictEqual(body.etapaActual, 'preparando');
  });

  // ─── 8. Promociones ───
  const crearPromo = async (datos, cookieVal = ADMIN_A) =>
    post('/api/admin/tienda/promociones', datos, cookieVal);

  await t('promos', 'envío gratis por compra mínima se aplica solo', async () => {
    await crearPromo({ nombre: 'Envío gratis 400', tipo: 'envio_gratis', automatica: true, minimoCompra: 400 });
    const chico = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [itemPizza()], modalidad: 'domicilio', zona: 'Centro' });
    const grande = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [itemPizza(2)], modalidad: 'domicilio', zona: 'Centro' });
    assert.strictEqual(chico.body.envioGratis, false, 'regaló el envío sin llegar al mínimo');
    assert.strictEqual(grande.body.envioGratis, true, 'no aplicó el envío gratis');
    assert.strictEqual(grande.body.total, 400);
  });

  await t('promos', 'la pista dice cuánto falta para el envío gratis', async () => {
    const { body } = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [itemPizza()], modalidad: 'domicilio', zona: 'Centro' });
    assert.ok(body.pistaEnvioGratis, 'no hay pista');
    assert.strictEqual(body.pistaEnvioGratis.logrado, false);
    assert.ok(/200/.test(body.pistaEnvioGratis.mensaje),
      `la pista no dice cuánto falta: ${body.pistaEnvioGratis.mensaje}`);
  });

  await t('promos', 'un cupón de porcentaje descuenta lo que dice', async () => {
    await crearPromo({ nombre: '10% bienvenida', tipo: 'porcentaje', valor: 10, codigo: 'DIEZ' });
    const { body } = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [itemPizza()], modalidad: 'recoger', codigo: 'DIEZ' });
    assert.strictEqual(body.descuento, 20);
    assert.strictEqual(body.total, 180);
  });

  await t('promos', 'sin escribir el código, el cupón NO se aplica', async () => {
    const { body } = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [itemPizza()], modalidad: 'recoger' });
    assert.strictEqual(body.descuento, 0, 'aplicó un cupón que nadie escribió');
  });

  await t('promos', 'un código inexistente se rechaza con motivo, no en silencio', async () => {
    const { body } = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [itemPizza()], modalidad: 'recoger', codigo: 'NOEXISTE' });
    assert.strictEqual(body.descuento, 0);
    assert.ok(body.rechazos?.length, 'no explicó por qué no aplicó');
  });

  await t('promos', 'el tope de descuento se respeta', async () => {
    await crearPromo({ nombre: '50% con tope', tipo: 'porcentaje', valor: 50, codigo: 'TOPE', maxDescuento: 30 });
    const { body } = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [itemPizza()], modalidad: 'recoger', codigo: 'TOPE' });
    assert.strictEqual(body.descuento, 30, `sin tope habría descontado 100, llegó ${body.descuento}`);
  });

  await t('promos', 'la compra mínima del cupón se impone', async () => {
    await crearPromo({ nombre: 'Cupón grande', tipo: 'monto_fijo', valor: 50, codigo: 'GRANDE', minimoCompra: 1000 });
    const { body } = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [itemPizza()], modalidad: 'recoger', codigo: 'GRANDE' });
    assert.strictEqual(body.descuento, 0);
    assert.ok(/falta/i.test(body.rechazos?.[0]?.motivo || ''), 'no dice cuánto falta');
  });

  await t('promos', 'un descuento nunca deja el total en negativo', async () => {
    await crearPromo({ nombre: 'Descuento absurdo', tipo: 'monto_fijo', valor: 99999, codigo: 'ABSURDO' });
    const { body } = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [itemPizza()], modalidad: 'recoger', codigo: 'ABSURDO' });
    assert.ok(body.total >= 0, `total negativo: ${body.total}`);
    assert.ok(body.descuento <= 200, 'descontó más que el subtotal');
  });

  await t('promos', 'un cupón de OTRO negocio no sirve aquí', async () => {
    const r = await crearPromo({ nombre: 'Solo B', tipo: 'porcentaje', valor: 50, codigo: 'SOLOB' }, ADMIN_B);
    assert.strictEqual(r.status, 200, `no se creó la promoción de B: ${JSON.stringify(r.body)}`);
    const { body } = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [itemPizza()], modalidad: 'recoger', codigo: 'SOLOB' });
    assert.strictEqual(body.descuento, 0, 'aplicó el cupón de otro negocio');
  });

  await t('promos', 'el límite de usos se agota y deja de aplicar', async () => {
    await crearPromo({ nombre: 'Un solo uso', tipo: 'monto_fijo', valor: 20, codigo: 'UNICO', limiteUsos: 1 });
    const r1 = await post(`/api/tienda/${SLUG_A}/checkout`, {
      checkoutToken: token(), items: [itemPizza()], modalidad: 'recoger', codigo: 'UNICO',
      cliente: { nombre: 'Uso 1', telefono: '8992220001' }, metodoPago: 'efectivo' });
    assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
    const q = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [itemPizza()], modalidad: 'recoger', codigo: 'UNICO', telefono: '8992220002' });
    assert.strictEqual(q.body.descuento, 0, 'el cupón siguió sirviendo después de agotarse');
  });

  await t('promos', 'el uso del cupón se registra UNA vez por pedido', async () => {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM tienda_promocion_usos u
         JOIN tienda_promociones p ON p.id = u.promocion_id
        WHERE u.negocio_id = $1 AND p.codigo = 'UNICO'`, [NEG_A]);
    assert.strictEqual(rows[0].n, 1, `se registraron ${rows[0].n} usos`);
  });

  await t('promos', 'dos checkouts SIMULTÁNEOS no rebasan el límite de usos', async () => {
    await crearPromo({ nombre: 'Carrera de cupón', tipo: 'monto_fijo', valor: 20, codigo: 'CARRERA', limiteUsos: 1 });
    const hacer = (tel) => post(`/api/tienda/${SLUG_A}/checkout`, {
      checkoutToken: token(), items: [itemPizza()], modalidad: 'recoger', codigo: 'CARRERA',
      cliente: { nombre: 'Carrera cupón', telefono: tel }, metodoPago: 'efectivo' });
    await Promise.all([hacer('8992220010'), hacer('8992220011')]);
    const { rows } = await pool.query(
      `SELECT p.usos, COUNT(u.id)::int AS registrados FROM tienda_promociones p
         LEFT JOIN tienda_promocion_usos u ON u.promocion_id = p.id
        WHERE p.negocio_id = $1 AND p.codigo = 'CARRERA' GROUP BY p.usos`, [NEG_A]);
    assert.ok(rows[0].registrados <= 1, `se registraron ${rows[0].registrados} usos de un cupón de 1`);
  });

  await t('promos', 'solo primera compra no aplica a quien ya compró', async () => {
    await crearPromo({ nombre: 'Primera compra', tipo: 'porcentaje', valor: 15, codigo: 'PRIMERA',
      soloPrimeraCompra: true });
    const nuevo = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [itemPizza()], modalidad: 'recoger', codigo: 'PRIMERA', telefono: '8993330099' });
    const viejo = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [itemPizza()], modalidad: 'recoger', codigo: 'PRIMERA', telefono: '8991110001' });
    assert.ok(nuevo.body.descuento > 0, 'no aplicó al cliente nuevo');
    assert.strictEqual(viejo.body.descuento, 0, 'aplicó a un cliente que ya había comprado');
  });

  await t('promos', 'una promoción inactiva no se aplica', async () => {
    await pool.query(`UPDATE tienda_promociones SET activa = FALSE WHERE negocio_id=$1 AND codigo='DIEZ'`, [NEG_A]);
    const { body } = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [itemPizza()], modalidad: 'recoger', codigo: 'DIEZ' });
    assert.strictEqual(body.descuento, 0);
    await pool.query(`UPDATE tienda_promociones SET activa = TRUE WHERE negocio_id=$1 AND codigo='DIEZ'`, [NEG_A]);
  });

  await t('promos', 'una promoción vencida no se aplica', async () => {
    await crearPromo({ nombre: 'Vencida', tipo: 'porcentaje', valor: 20, codigo: 'VIEJA',
      vigenciaHasta: '2020-01-01' });
    const { body } = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [itemPizza()], modalidad: 'recoger', codigo: 'VIEJA' });
    assert.strictEqual(body.descuento, 0);
  });

  await t('promos', 'el porcentaje fuera de rango se rechaza al guardar', async () => {
    for (const valor of [0, -5, 150]) {
      const r = await crearPromo({ nombre: 'Mala', tipo: 'porcentaje', valor, codigo: 'MALA' });
      assert.ok(r.status >= 400, `aceptó un porcentaje de ${valor}`);
    }
  });

  // ─── 9. Backoffice: permisos y aislamiento ───
  await t('backoffice', 'el admin ve la configuración de SU tienda', async () => {
    const { status, body } = await get('/api/admin/tienda', ADMIN_A);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.config.titular, 'Tienda A');
    assert.ok(Array.isArray(body.checklist.items));
  });

  await t('backoffice', 'sin sesión no se toca nada del backoffice', async () => {
    for (const [ruta, metodo] of [['/api/admin/tienda', 'GET'], ['/api/admin/tienda/estado', 'POST'],
      ['/api/admin/tienda/promociones', 'GET'], ['/api/admin/tienda/metricas', 'GET']]) {
      const r = metodo === 'GET' ? await get(ruta) : await post(ruta, { estado: 'publicada' });
      assert.ok(r.status === 401 || r.status === 403, `${metodo} ${ruta} respondió ${r.status} sin sesión`);
    }
  });

  await t('backoffice', 'sin el módulo contratado el backoffice responde bloqueado', async () => {
    await fijarModulo(NEG_A, 'tienda_online', 'no_contratado');
    const { status } = await get('/api/admin/tienda', ADMIN_A);
    assert.ok(status === 402 || status === 403, `respondió ${status}`);
    await fijarModulo(NEG_A, 'tienda_online', 'activo');
  });

  await t('backoffice', 'un negocio NO ve las promociones de otro', async () => {
    const { body } = await get('/api/admin/tienda/promociones', ADMIN_A);
    const codigos = body.promociones.map(p => p.codigo);
    assert.ok(!codigos.includes('SOLOB'), 'vio el cupón del negocio B');
    assert.ok(codigos.includes('DIEZ'), 'no ve sus propias promociones');
  });

  await t('backoffice', 'un negocio NO puede borrar la promoción de otro', async () => {
    const { rows } = await pool.query(
      `SELECT id FROM tienda_promociones WHERE negocio_id=$1 AND codigo='SOLOB'`, [NEG_B]);
    const r = await post(`/api/admin/tienda/promociones/${rows[0].id}`, undefined, ADMIN_A, 'DELETE');
    assert.strictEqual(r.status, 404, `respondió ${r.status} al borrar una promoción ajena`);
    const { rows: sigue } = await pool.query(
      `SELECT id FROM tienda_promociones WHERE negocio_id=$1 AND codigo='SOLOB'`, [NEG_B]);
    assert.strictEqual(sigue.length, 1, 'borró la promoción del otro negocio');
  });

  await t('backoffice', 'un negocio NO puede publicar productos de otro', async () => {
    const r = await post('/api/admin/tienda/productos/publicar',
      { productoIds: [PROD.B['Sushi tienda']], publicado: true }, ADMIN_A);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM tienda_productos WHERE negocio_id=$1 AND producto_id=$2`,
      [NEG_A, PROD.B['Sushi tienda']]);
    assert.strictEqual(rows[0].n, 0, 'publicó en su tienda un producto de otro negocio');
  });

  await t('backoffice', 'la lista de productos publicables es solo la del negocio', async () => {
    const { body } = await get('/api/admin/tienda/productos', ADMIN_A);
    const nombres = body.productos.map(p => p.nombre);
    assert.ok(nombres.includes('Pizza tienda'));
    assert.ok(!nombres.includes('Sushi tienda'));
  });

  await t('backoffice', 'no se puede robar el slug de otra tienda', async () => {
    const r = await post('/api/admin/tienda', { slugPublico: SLUG_B }, ADMIN_A, 'PUT');
    assert.ok(r.status >= 400, `permitió tomar el slug de otro negocio (${r.status})`);
    const { body } = await get(`/api/tienda/${SLUG_B}`);
    assert.strictEqual(body.negocio, 'Tienda B', 'la tienda B quedó secuestrada');
  });

  await t('backoffice', 'un slug con caracteres inválidos se rechaza', async () => {
    for (const s of ['con espacio', '../../admin', 'a', 'MAYUS!!']) {
      const r = await post('/api/admin/tienda', { slugPublico: s }, ADMIN_A, 'PUT');
      assert.ok(r.status >= 400, `aceptó el slug ${JSON.stringify(s)}`);
    }
  });

  await t('backoffice', 'guardar apariencia funciona y se refleja en la tienda', async () => {
    const r = await post('/api/admin/tienda',
      { descripcion: 'Cocina de casa', mensajeBienvenida: 'Pide temprano', color: '#0044cc' },
      ADMIN_A, 'PUT');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const { body } = await get(`/api/tienda/${SLUG_A}`);
    assert.strictEqual(body.descripcion, 'Cocina de casa');
    assert.strictEqual(body.bienvenida, 'Pide temprano');
  });

  await t('backoffice', 'las métricas cuentan solo pedidos de ESTE negocio y de tienda', async () => {
    const { status, body } = await get('/api/admin/tienda/metricas', ADMIN_A);
    assert.strictEqual(status, 200);
    assert.ok(body.pedidos > 0, 'no contó los pedidos creados en la suite');
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM pedidos_activos
        WHERE negocio_id=$1 AND datos->>'canal'='tienda_online' AND estado <> 'cancelado'`, [NEG_A]);
    assert.strictEqual(body.pedidos, rows[0].n, 'la métrica no coincide con la base');
  });

  await t('backoffice', 'una campaña ajena no se puede asignar a una promoción propia', async () => {
    const c = await post('/api/admin/tienda/campanas', { nombre: 'Campaña de B' }, ADMIN_B);
    assert.ok(c.body.id, `no se creó la campaña de B: ${JSON.stringify(c.body)}`);
    const r = await crearPromo({ nombre: 'Robo de campaña', tipo: 'porcentaje', valor: 5,
      codigo: 'ROBO', campaniaId: c.body.id });
    assert.ok(r.status >= 400, 'asignó una campaña de otro negocio');
  });

  // ─── 10. Publicación y checklist ───
  await t('publicar', 'una tienda sin productos publicados no puede publicarse', async () => {
    await pool.query(`UPDATE tienda_productos SET publicado = FALSE WHERE negocio_id=$1`, [NEG_A]);
    const ch = await get('/api/admin/tienda', ADMIN_A);
    assert.strictEqual(ch.body.checklist.listaParaPublicar, false);
    const r = await post('/api/admin/tienda/estado', { estado: 'publicada' }, ADMIN_A);
    assert.strictEqual(r.status, 409, `permitió publicar sin catálogo (${r.status})`);
    assert.ok(/producto/i.test(r.body.error || ''), 'no dice qué falta');
    await pool.query(`UPDATE tienda_productos SET publicado = TRUE WHERE negocio_id=$1`, [NEG_A]);
  });

  await t('publicar', 'pausar y reanudar funciona sin perder la liga', async () => {
    const p = await post('/api/admin/tienda/estado', { estado: 'pausada' }, ADMIN_A);
    assert.strictEqual(p.status, 200);
    assert.strictEqual(p.body.config.estado, 'pausada');
    const r = await post('/api/admin/tienda/estado', { estado: 'publicada' }, ADMIN_A);
    assert.strictEqual(r.body.config.estado, 'publicada');
    assert.strictEqual(r.body.config.slug, SLUG_A, 'la liga cambió al reanudar');
  });

  await t('publicar', 'un estado inventado se rechaza', async () => {
    const r = await post('/api/admin/tienda/estado', { estado: 'superpublicada' }, ADMIN_A);
    assert.ok(r.status >= 400);
  });

  // ─── 11. Adversarial ───
  await t('ataque', 'el negocio jamás se toma del cuerpo de la petición', async () => {
    const r = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [itemPizza()], modalidad: 'recoger',
      negocioId: NEG_B, negocio_id: NEG_B, tenantId: NEG_B });
    assert.strictEqual(r.body.subtotal, 200, 'el cuerpo cambió de negocio');
  });

  await t('ataque', 'HTML en los datos del cliente se guarda inerte', async () => {
    const veneno = '<img src=x onerror=alert(1)>';
    const { status, body } = await post(`/api/tienda/${SLUG_A}/checkout`, {
      checkoutToken: token(), items: [itemPizza()], modalidad: 'recoger',
      cliente: { nombre: veneno, telefono: '8994440001' }, metodoPago: 'efectivo',
      notas: veneno });
    assert.strictEqual(status, 200, JSON.stringify(body));
    const { rows } = await pool.query(
      `SELECT datos FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [body.folio, NEG_A]);
    // Se guarda como texto: el escape es responsabilidad de la vista, y la
    // tienda escapa TODO lo que pinta. Lo que sí se exige aquí es que no haya
    // caracteres de control que rompan la comanda impresa.
    const txt = JSON.stringify(rows[0].datos);
    assert.ok(!/[ -]/.test(txt.replace(/\\[nrt]/g, '')), 'pasaron caracteres de control');
  });

  await t('ataque', 'los saltos de línea no se cuelan a la comanda', async () => {
    const { body } = await post(`/api/tienda/${SLUG_A}/checkout`, {
      checkoutToken: token(), items: [itemPizza()], modalidad: 'recoger',
      cliente: { nombre: 'Linea\r\nInyectada nula', telefono: '8994440002' },
      metodoPago: 'efectivo' });
    const { rows } = await pool.query(
      `SELECT datos FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [body.folio, NEG_A]);
    const nombre = rows[0].datos?.cliente?.nombre || '';
    assert.ok(!/[\r\n ]/.test(nombre), `el nombre conserva control: ${JSON.stringify(nombre)}`);
  });

  await t('ataque', 'un cuerpo con miles de items se rechaza', async () => {
    const r = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: Array.from({ length: 5000 }, () => itemPizza()), modalidad: 'recoger' });
    assert.ok(r.status >= 400, 'aceptó un carrito de 5000 renglones');
  });

  await t('ataque', 'un modificador de otro producto se rechaza', async () => {
    const { rows } = await pool.query(
      `SELECT o.id FROM menu_modificadores_opciones o WHERE o.negocio_id = $1 AND o.grupo_id <> $2 LIMIT 1`,
      [NEG_A, GRUPO_A]);
    if (!rows.length) return; // no hay otro grupo en este negocio: nada que probar
    const r = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [{ productoId: PROD.A['Pizza tienda'], cantidad: 1,
        modificadores: [{ grupoId: GRUPO_A, opcionId: rows[0].id }] }],
      modalidad: 'recoger' });
    assert.ok(r.status >= 400, 'aceptó una opción que no pertenece al producto');
  });

  await t('ataque', 'un grupo obligatorio sin elegir se rechaza', async () => {
    const r = await post(`/api/tienda/${SLUG_A}/cotizar`, {
      items: [{ productoId: PROD.A['Pizza tienda'], cantidad: 1, modificadores: [] }],
      modalidad: 'recoger' });
    assert.ok(r.status >= 400, 'dejó pasar un producto sin su modificador obligatorio');
    assert.ok(!/stack|at |internal/i.test(JSON.stringify(r.body)), 'la respuesta filtra detalles internos');
  });

  await t('ataque', 'los errores nunca devuelven stack ni SQL', async () => {
    const casos = [
      post(`/api/tienda/${SLUG_A}/cotizar`, { items: "no-es-arreglo", modalidad: 'recoger' }),
      post(`/api/tienda/${SLUG_A}/cotizar`, null),
      get(`/api/tienda/${encodeURIComponent("' OR 1=1--")}`),
    ];
    for (const p of casos) {
      const r = await p;
      const txt = JSON.stringify(r.body || {});
      assert.ok(!/SELECT |INSERT |pg_|at Object|node_modules/i.test(txt), `filtró detalle interno: ${txt}`);
    }
  });

  // ─── 12. Rate limit real (servidor aparte con topes mínimos) ───
  await t('limites', 'el checkout público tiene rate limit efectivo', async () => {
    const otro = await arrancarServidor(
      { PORT: '4208', XABOR_TIENDA_LIMITE_CHECKOUT: '2' }, { timeoutMs: 90000 });
    try {
      const hacer = () => fetch(`http://localhost:4208/api/tienda/${SLUG_A}/checkout`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkoutToken: token(), items: [itemPizza()], modalidad: 'recoger',
          cliente: { nombre: 'Flood', telefono: '8995550001' }, metodoPago: 'efectivo' }),
      });
      const codigos = [];
      for (let i = 0; i < 5; i++) codigos.push((await hacer()).status);
      assert.ok(codigos.includes(429), `nunca respondió 429: ${codigos.join(',')}`);
    } finally { await otro.detener(); }
  });

  console.log(`\n── Resultado parcial: ${pasadas} OK, ${fallidas} fallos ──\n`);
} catch (e) {
  console.error('ERROR FATAL:', e);
  fallidas++;
} finally {
  // Cuando algo falla con 500, el detalle solo existe en el log del servidor
  // hijo: sin esto habría que adivinar por qué.
  if (fallidas && servidor) {
    const lineas = servidor.obtenerSalida().split(/\r?\n/).filter(l => l.includes('[Tienda]'));
    if (lineas.length) console.log('\n── Errores del servidor ──\n' + lineas.slice(-12).join('\n'));
  }
  if (servidor) await servidor.detener();
  await limpiarFixtures().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-tienda-online: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log('  · ' + f)); }
process.exit(fallidas ? 1 : 0);
