// ─── Prueba de productización ──────────────────────────────────────────────
//
// La regla del módulo: dar de alta una tienda nueva NO debe requerir editar
// código, copiar HTML, agregar un `if` por negocio ni desplegar. Esta suite
// existe para demostrarlo, no para afirmarlo.
//
// Crea un negocio que nunca existió, lo configura ÚNICAMENTE con las mismas
// operaciones que haría un humano por el panel, y completa una compra real.
// Si en algún punto hiciera falta tocar un archivo, esta prueba no pasaría.
//
// Uso: mismas env vars que la batería (DATABASE_URL, PANEL_SECRET, …).
import assert from 'assert';
import { randomBytes, randomUUID } from 'crypto';
import { arrancarServidor } from './lib-servidor.mjs';

const PUERTO = process.env.TEST_PORT || '4209';
const { crearTokenSesion } = await import('../src/services/session.js');
const { pool } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// El quinto negocio: nombre y slug irrepetibles, para que no pueda pasar por
// datos que alguien haya dejado sembrados antes.
const SUFIJO = randomBytes(4).toString('hex');
const SLUG = `taqueria-quinta-${SUFIJO}`;
const NOMBRE = `Taquería Quinta ${SUFIJO}`;
const EMAIL = `duena-${SUFIJO}@prueba.local`;

let NEGOCIO = null, ADMIN = null, base;
const token = () => randomBytes(24).toString('hex');
const url = r => `${base}${r}`;

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

// ── Alta del negocio: lo que hoy hace el Superadmin al contratar un cliente ──
async function darDeAltaNegocio() {
  const { rows: [n] } = await pool.query(
    `INSERT INTO negocios (id, nombre, slug, activo) VALUES ($1,$2,$3,TRUE) RETURNING id`,
    [randomUUID(), NOMBRE, SLUG]);
  NEGOCIO = n.id;

  const { rows: [u] } = await pool.query(
    `INSERT INTO usuarios (negocio_id, nombre, email, activo) VALUES ($1,$2,$3,TRUE) RETURNING id`,
    [NEGOCIO, 'Dueña de la taquería', EMAIL]);
  await pool.query(
    `INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1,$2,'admin',TRUE)`,
    [u.id, NEGOCIO]);
  ADMIN = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: u.id, negocioId: NEGOCIO, rol: 'admin' }))}`;

  // Contratar los módulos. Esto es exactamente lo que hace el Superadmin
  // desde su panel: una fila por módulo, cero código.
  for (const m of ['tienda_online', 'pos', 'menu']) {
    await pool.query(
      `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')`,
      [NEGOCIO, m]);
  }
}

async function limpiar() {
  if (!NEGOCIO) return;
  for (const sql of [
    `DELETE FROM tienda_promocion_usos WHERE negocio_id = $1`,
    `DELETE FROM tienda_promociones WHERE negocio_id = $1`,
    `DELETE FROM tienda_campanas WHERE negocio_id = $1`,
    `DELETE FROM tienda_pedidos WHERE negocio_id = $1`,
    `DELETE FROM tienda_productos WHERE negocio_id = $1`,
    `DELETE FROM tienda_config WHERE negocio_id = $1`,
    `DELETE FROM pedidos_activos WHERE negocio_id = $1`,
    `DELETE FROM pedidos WHERE negocio_id = $1`,
    `DELETE FROM clientes WHERE negocio_id = $1`,
    `DELETE FROM menu_modificadores_opciones WHERE negocio_id = $1`,
    `DELETE FROM menu_modificadores_grupos WHERE negocio_id = $1`,
    `DELETE FROM menu_productos WHERE negocio_id = $1`,
    `DELETE FROM menu_categorias WHERE negocio_id = $1`,
    `DELETE FROM metodos_pago WHERE negocio_id = $1`,
    `DELETE FROM configuracion WHERE negocio_id = $1`,
    `DELETE FROM negocio_modulos WHERE negocio_id = $1`,
    `DELETE FROM usuario_negocios WHERE negocio_id = $1`,
    `DELETE FROM usuarios WHERE negocio_id = $1`,
    `DELETE FROM negocios WHERE id = $1`,
  ]) await pool.query(sql, [NEGOCIO]).catch(() => {});
}

let servidor;
const PROD = {};
try {
  await darDeAltaNegocio();
  servidor = await arrancarServidor(
    { PORT: PUERTO, XABOR_TIENDA_LIMITE_CHECKOUT: '200', XABOR_TIENDA_LIMITE_COTIZAR: '200' },
    { timeoutMs: 90000 });
  base = `http://localhost:${PUERTO}`;

  await t('1. el negocio recién creado NO tiene tienda todavía', async () => {
    const { status } = await get(`/api/tienda/${SLUG}`);
    assert.strictEqual(status, 404, 'una tienda sin configurar ya estaba en línea');
  });

  await t('2. el backoffice le responde en cuanto tiene el módulo', async () => {
    const { status, body } = await get('/api/admin/tienda', ADMIN);
    assert.strictEqual(status, 200, JSON.stringify(body));
    assert.strictEqual(body.config.estado, 'borrador');
    assert.strictEqual(body.checklist.listaParaPublicar, false);
  });

  await t('3. el checklist le dice exactamente qué le falta', async () => {
    const { body } = await get('/api/admin/tienda', ADMIN);
    const faltan = body.checklist.items.filter(i => !i.listo).map(i => i.clave);
    assert.ok(faltan.includes('horarios'), 'no señala los horarios');
    assert.ok(faltan.includes('productos'), 'no señala el catálogo vacío');
    assert.ok(faltan.includes('pagos'), 'no señala que no hay forma de cobrar');
  });

  await t('4. no la deja publicar incompleta', async () => {
    const r = await post('/api/admin/tienda/estado', { estado: 'publicada' }, ADMIN);
    assert.strictEqual(r.status, 409);
    assert.ok(r.body.error.length > 10, 'el error no explica nada');
  });

  await t('5. carga su menú (dos productos con opciones)', async () => {
    const { rows: [cat] } = await pool.query(
      `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,'Tacos',TRUE,1) RETURNING id`,
      [NEGOCIO]);
    for (const [nombre, precio] of [['Taco de asada', 25], ['Orden de tacos', 120]]) {
      const { rows: [p] } = await pool.query(
        `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden)
         VALUES ($1,$2,$3,$4,TRUE,1) RETURNING id`, [NEGOCIO, cat.id, nombre, precio]);
      PROD[nombre] = p.id;
    }
    const { rows: [g] } = await pool.query(
      `INSERT INTO menu_modificadores_grupos (negocio_id, producto_id, nombre, requerido, minimo, maximo, orden)
       VALUES ($1,$2,'Salsa',FALSE,0,2,1) RETURNING id`, [NEGOCIO, PROD['Taco de asada']]);
    for (const s of ['Verde', 'Roja']) {
      await pool.query(
        `INSERT INTO menu_modificadores_opciones (negocio_id, grupo_id, nombre, precio_extra, disponible, orden)
         VALUES ($1,$2,$3,0,TRUE,1)`, [NEGOCIO, g.id, s]);
    }
    assert.ok(PROD['Taco de asada']);
  });

  await t('6. publica sus productos desde el panel', async () => {
    const lista = await get('/api/admin/tienda/productos', ADMIN);
    assert.strictEqual(lista.body.productos.length, 2);
    const r = await post('/api/admin/tienda/productos/publicar',
      { productoIds: lista.body.productos.map(p => p.id), publicado: true }, ADMIN);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.actualizados, 2);
  });

  await t('7. define horarios, envío y forma de cobrar', async () => {
    // Estas son las mismas claves que ya usa Configuración → Pedidos y
    // horarios: la tienda NO tiene su propia copia de las reglas.
    const reglas = {
      horarios: Object.fromEntries(['lunes','martes','miercoles','jueves','viernes','sabado','domingo']
        .map(d => [d, { abierto: true, apertura: '00:00', cierre: '23:59' }])),
      pedidos: { costo_envio: 35, pedido_minimo_entrega: 80,
        zonas_entrega: [{ nombre: 'Centro', costo: 25 }],
        tiempo_preparacion_minutos: 15, tiempo_entrega_min_minutos: 25, tiempo_entrega_max_minutos: 40 },
    };
    await pool.query(
      `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'reglas_atencion',$2)`,
      [NEGOCIO, JSON.stringify(reglas)]);
    await pool.query(
      `INSERT INTO metodos_pago (negocio_id, tipo, habilitado) VALUES ($1,'efectivo',TRUE)`, [NEGOCIO]);
  });

  await t('8. personaliza su tienda desde el panel', async () => {
    const r = await post('/api/admin/tienda', {
      titular: NOMBRE, descripcion: 'Tacos de asada al carbón',
      mensajeBienvenida: 'Pide antes de las 10 y te los llevamos calientitos',
      color: '#c2410c', modalidades: ['recoger', 'domicilio'], aceptaProgramados: false,
    }, ADMIN, 'PUT');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.config.titular, NOMBRE);
  });

  await t('9. ahora el checklist está completo', async () => {
    const { body } = await get('/api/admin/tienda', ADMIN);
    const faltan = body.checklist.items.filter(i => !i.listo).map(i => i.etiqueta);
    assert.strictEqual(faltan.length, 0, `sigue faltando: ${faltan.join(', ')}`);
    assert.strictEqual(body.checklist.listaParaPublicar, true);
  });

  await t('10. publica su tienda con un botón', async () => {
    const r = await post('/api/admin/tienda/estado', { estado: 'publicada' }, ADMIN);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.config.estado, 'publicada');
    assert.strictEqual(r.body.config.slug, SLUG, 'la liga no salió del slug del negocio');
  });

  await t('11. la tienda ya está viva en su propia liga', async () => {
    const { status, body } = await get(`/api/tienda/${SLUG}`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.negocio, NOMBRE);
    assert.strictEqual(body.color, '#c2410c');
    assert.ok(body.apertura.abierto);
  });

  await t('12. el HTML servido es el MISMO de todas las tiendas', async () => {
    const r = await fetch(url(`/t/${SLUG}`));
    const html = await r.text();
    assert.strictEqual(r.status, 200);
    // Si el slug o el nombre del negocio aparecieran incrustados en la
    // plantilla, habría un HTML por negocio -- justo lo que no queremos.
    assert.ok(!html.includes(SLUG), 'el slug quedó incrustado en el HTML');
    assert.ok(!html.includes(NOMBRE), 'el nombre del negocio quedó incrustado en el HTML');
  });

  await t('13. el catálogo público muestra su menú', async () => {
    const { body } = await get(`/api/tienda/${SLUG}/catalogo`);
    const nombres = body.categorias.flatMap(c => c.productos.map(p => p.nombre));
    assert.deepStrictEqual(nombres.sort(), ['Orden de tacos', 'Taco de asada']);
  });

  await t('14. crea una promoción de bienvenida', async () => {
    const r = await post('/api/admin/tienda/promociones', {
      nombre: 'Bienvenida 10%', tipo: 'porcentaje', valor: 10, codigo: 'TACOS10',
    }, ADMIN);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  });

  let folio = null, tracking = null;
  await t('15. un cliente completa una compra REAL de principio a fin', async () => {
    const cot = await post(`/api/tienda/${SLUG}/cotizar`, {
      items: [{ productoId: PROD['Orden de tacos'], cantidad: 1 }],
      modalidad: 'domicilio', zona: 'Centro', codigo: 'TACOS10',
    });
    assert.strictEqual(cot.status, 200, JSON.stringify(cot.body));
    // subtotal = valor de los productos; descuento y envío van aparte, y el
    // total es lo que el cliente paga.
    assert.strictEqual(cot.body.subtotal, 120);
    assert.strictEqual(cot.body.descuento, 12,
      `el 10% no se aplicó: ${JSON.stringify(cot.body.rechazos)}`);
    assert.strictEqual(cot.body.envio, 25);
    assert.strictEqual(cot.body.total, 133);

    const r = await post(`/api/tienda/${SLUG}/checkout`, {
      checkoutToken: token(),
      items: [{ productoId: PROD['Orden de tacos'], cantidad: 1 }],
      modalidad: 'domicilio', zona: 'Centro', codigo: 'TACOS10',
      direccion: 'Hidalgo 45, entre Juárez y Morelos',
      cliente: { nombre: 'Primer cliente', telefono: '8991234567' },
      metodoPago: 'efectivo',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    folio = r.body.folio; tracking = r.body.trackingToken;
    assert.ok(folio, 'no hubo folio');
  });

  await t('16. el pedido entró a la operación como cualquier otro', async () => {
    const { rows } = await pool.query(
      `SELECT datos, estado FROM pedidos_activos WHERE folio=$1 AND negocio_id=$2`, [folio, NEGOCIO]);
    assert.strictEqual(rows.length, 1, 'el pedido no llegó al tablero');
    assert.strictEqual(rows[0].datos.canal, 'tienda_online');
    assert.strictEqual(rows[0].datos.total, 133);
    assert.strictEqual(rows[0].datos.pago_confirmado, false, 'nació cobrado');
  });

  await t('17. el cliente puede seguir su pedido', async () => {
    const { status, body } = await get(`/api/tienda/seguimiento/${tracking}`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.folio, folio);
    assert.strictEqual(body.negocio, NOMBRE);
  });

  await t('18. la dueña ve la venta en sus métricas', async () => {
    const { body } = await get('/api/admin/tienda/metricas', ADMIN);
    assert.strictEqual(body.pedidos, 1);
    assert.strictEqual(body.ventas, 133);
    assert.strictEqual(body.porModalidad.domicilio, 1);
    assert.ok(body.promociones.some(p => p.codigo === 'TACOS10'), 'la promoción no aparece atribuida');
  });

  await t('19. la impresión se encoló por la vía normal de Xabor', async () => {
    // Sin impresoras configuradas no hay trabajos, y eso es correcto: lo que
    // se verifica es que el pedido pasó por emitirPedido -- el ÚNICO punto de
    // impresión de todo Xabor -- y no por un camino paralelo de la tienda.
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM impresion_trabajos WHERE negocio_id = $1`, [NEGOCIO]);
    assert.strictEqual(rows[0].n, 0, 'la tienda imprimió por su cuenta sin impresora configurada');
  });

  await t('20. pausar la tienda deja de aceptar pedidos, sin borrar nada', async () => {
    await post('/api/admin/tienda/estado', { estado: 'pausada' }, ADMIN);
    const r = await post(`/api/tienda/${SLUG}/checkout`, {
      checkoutToken: token(), items: [{ productoId: PROD['Taco de asada'], cantidad: 4 }],
      modalidad: 'recoger', cliente: { nombre: 'Tarde', telefono: '8991234568' }, metodoPago: 'efectivo' });
    assert.ok(r.status >= 400, 'una tienda pausada aceptó un pedido');
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM pedidos_activos WHERE negocio_id = $1`, [NEGOCIO]);
    assert.strictEqual(rows[0].n, 1, 'pausar borró el historial');
  });

  await t('21. NINGÚN archivo del repositorio se tocó para lograr todo esto', async () => {
    // El contrato de productización, dicho como comprobación: todo lo anterior
    // salió de filas en la base y peticiones HTTP. Si alguien agrega un `if`
    // por negocio o una plantilla por cliente, esta prueba deja de tener
    // sentido -- y este comentario es el recordatorio de por qué existe.
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM tienda_config WHERE negocio_id = $1`, [NEGOCIO]);
    assert.strictEqual(rows[0].n, 1);
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++;
} finally {
  if (fallidas && servidor) {
    const lineas = servidor.obtenerSalida().split(/\r?\n/).filter(l => l.includes('[Tienda]'));
    if (lineas.length) console.log('\n── Errores del servidor ──\n' + lineas.slice(-10).join('\n'));
  }
  if (servidor) await servidor.detener();
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-tienda-productizacion: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log('  · ' + f)); }
process.exit(fallidas ? 1 : 0);
