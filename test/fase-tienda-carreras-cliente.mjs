// ─── Carreras por cliente en promociones ───────────────────────────────────
//
// El límite global ya lo decide la base con un UPDATE condicional. Pero
// `limite_por_cliente` y `solo_primera_compra` dependían de una lectura previa:
// dos checkouts simultáneos del MISMO teléfono leían "cero usos" y ambos
// pasaban. Esta suite existe para que eso no vuelva a ser cierto.
//
// Las cuatro preguntas, en orden:
//   A) límite por cliente = 1, dos checkouts a la vez, mismo teléfono → uno.
//   B) solo primera compra, dos primeros checkouts a la vez           → uno.
//   C) teléfonos distintos, cupo global suficiente                    → ambos.
//   D) si el ganador falla antes de crear el pedido                   → suelta.
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
const PUERTO = process.env.TEST_PORT || '4211';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG = SEED.negocioA;
const ADMIN = `xabor_sesion=${encodeURIComponent(
  crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: NEG, rol: 'admin' }))}`;
const SLUG = 'carreras-cliente';

let base, PRODUCTO = null;
const token = () => randomBytes(24).toString('hex');
const post = async (ruta, cuerpo, cookieVal) => {
  const r = await fetch(`${base}${ruta}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookieVal ? { Cookie: cookieVal } : {}) },
    body: JSON.stringify(cuerpo),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// Un checkout completo listo para lanzar en paralelo.
const comprar = (telefono, codigo, extra = {}) => post(`/api/tienda/${SLUG}/checkout`, {
  checkoutToken: token(), items: [{ productoId: PRODUCTO, cantidad: 1 }],
  modalidad: 'recoger', codigo,
  cliente: { nombre: 'Cliente carrera', telefono },
  // Regla del canal (tienda_online = solo pago en línea): el checkout nace
  // pendiente_pago y las promociones quedan RESERVADAS -- la carrera que esta
  // suite ataca es exactamente la de la RESERVA, así que su semántica no
  // cambia (usosConfirmados cuenta filas reales sin importar estado).
  metodoPago: 'enlace_pago', ...extra,
});

async function crearPromo(datos) {
  const r = await post('/api/admin/tienda/promociones', datos, ADMIN);
  assert.strictEqual(r.status, 200, `no se creó la promoción: ${JSON.stringify(r.body)}`);
  return r.body.id;
}

// Cuántas veces se OTORGÓ de verdad la promoción: filas confirmadas (con folio
// real, no reserva) en el registro de usos.
async function usosConfirmados(codigo) {
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM tienda_promocion_usos u
       JOIN tienda_promociones p ON p.id = u.promocion_id
      WHERE u.negocio_id = $1 AND p.codigo = $2 AND u.pedido_folio NOT LIKE 'reserva:%'`,
    [NEG, codigo]);
  return r.n;
}
async function contadorUsos(codigo) {
  const { rows: [r] } = await pool.query(
    `SELECT usos FROM tienda_promociones WHERE negocio_id = $1 AND codigo = $2`, [NEG, codigo]);
  return Number(r?.usos ?? -1);
}
async function reservasVivas(codigo) {
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM tienda_promocion_usos u
       JOIN tienda_promociones p ON p.id = u.promocion_id
      WHERE u.negocio_id = $1 AND p.codigo = $2 AND u.pedido_folio LIKE 'reserva:%'`,
    [NEG, codigo]);
  return r.n;
}

async function limpiar() {
  await pool.query(
    `DELETE FROM tienda_promocion_usos WHERE negocio_id = $1`, [NEG]);
  await pool.query(`DELETE FROM tienda_promociones WHERE negocio_id = $1`, [NEG]);
  await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = 'tienda_metodos_pago'`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM tienda_pedidos WHERE negocio_id = $1`, [NEG]);
  await pool.query(
    `DELETE FROM pedidos_activos WHERE negocio_id = $1 AND datos->>'canal' = 'tienda_online'`, [NEG]);
  await pool.query(`DELETE FROM pedidos WHERE negocio_id = $1 AND telefono LIKE '8997%'`, [NEG]).catch(() => {});
  // compras_reales (migracion 058) llego DESPUES de esta suite y es lo que
  // lee clienteYaComproDeVerdad para solo_primera_compra: sin esta limpieza,
  // la primera corrida verde deja al "telefono virgen" con una compra real
  // registrada y toda corrida posterior falla el caso B. Acotado a la familia
  // de telefonos propios de esta suite.
  await pool.query(
    `DELETE FROM compras_reales WHERE negocio_id = $1 AND cliente_telefono LIKE '8997000%'`,
    [NEG]).catch(() => {});
  await pool.query(`DELETE FROM tienda_productos WHERE negocio_id = $1`, [NEG]);
  await pool.query(`DELETE FROM tienda_config WHERE negocio_id = $1`, [NEG]);
  await pool.query(
    `DELETE FROM menu_productos WHERE categoria_id IN
      (SELECT id FROM menu_categorias WHERE negocio_id = $1 AND nombre = 'Carreras (test)')`, [NEG]);
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id = $1 AND nombre = 'Carreras (test)'`, [NEG]);
}

async function preparar() {
  await limpiar();
  for (const m of ['tienda_online', 'pos', 'menu']) {
    await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')
      ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [NEG, m]);
  }
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,'Carreras (test)',TRUE,950) RETURNING id`,
    [NEG]);
  const { rows: [p] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, orden)
     VALUES ($1,$2,'Producto carrera',100,TRUE,1) RETURNING id`, [NEG, cat.id]);
  PRODUCTO = p.id;
  await pool.query(
    `INSERT INTO tienda_productos (negocio_id, producto_id, publicado) VALUES ($1,$2,TRUE)`, [NEG, PRODUCTO]);

  const reglas = {
    horarios: Object.fromEntries(['lunes','martes','miercoles','jueves','viernes','sabado','domingo']
      .map(d => [d, { abierto: true, apertura: '00:00', cierre: '23:59' }])),
    pedidos: { costo_envio: 0, pedido_minimo_entrega: 0, tiempo_preparacion_minutos: 10 },
  };
  await pool.query(
    `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,'reglas_atencion',$2)
     ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $2`, [NEG, JSON.stringify(reglas)]);
  await pool.query(`UPDATE metodos_pago SET habilitado = FALSE WHERE negocio_id = $1`, [NEG]);
  await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado) VALUES ($1,'enlace_pago',TRUE)
    ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = TRUE`, [NEG]);
  // Proveedor en línea de FORMA válida: testConnection de Clip solo valida
  // forma (cero red, cero cobros); es lo que exige metodosPagoTienda.
  const { guardarIntegracionPago, marcarProveedorPrincipal } =
    await import('../src/services/integracionesService.js');
  await guardarIntegracionPago(NEG, 'clip',
    { apiKey: 'test-api-key-no-real', apiSecret: 'test-api-secret-no-real' },
    { actualizadoPor: SEED.superadminUsuarioId });
  await marcarProveedorPrincipal(NEG, 'clip', SEED.superadminUsuarioId);
  await pool.query(
    `INSERT INTO tienda_config (negocio_id, estado, slug_publico, titular, modalidades)
     VALUES ($1,'publicada',$2,'Carreras',$3)
     ON CONFLICT (negocio_id) DO UPDATE SET estado='publicada', slug_publico=$2, modalidades=$3`,
    [NEG, SLUG, JSON.stringify(['recoger'])]);
}

let servidor;
try {
  await preparar();
  servidor = await arrancarServidor(
    { PORT: PUERTO, XABOR_TIENDA_LIMITE_CHECKOUT: '500', XABOR_TIENDA_LIMITE_COTIZAR: '500' },
    { timeoutMs: 90000 });
  base = `http://localhost:${PUERTO}`;

  // ─── A) límite por cliente = 1 ───
  await t('A. limite_por_cliente=1: dos checkouts simultáneos del MISMO teléfono → solo uno la obtiene', async () => {
    await crearPromo({ nombre: 'Una por cliente', tipo: 'monto_fijo', valor: 20,
      codigo: 'UNAPORCLI', limitePorCliente: 1 });
    const TEL = '8997000001';
    const [a, b] = await Promise.all([comprar(TEL, 'UNAPORCLI'), comprar(TEL, 'UNAPORCLI')]);

    const exitosas = [a, b].filter(r => r.status === 200);
    assert.ok(exitosas.length >= 1, `ninguna prosperó: ${JSON.stringify([a.body, b.body])}`);
    const conDescuento = exitosas.filter(r => (r.body.ahorro || 0) > 0).length;
    assert.strictEqual(conDescuento, 1,
      `${conDescuento} pedidos obtuvieron el descuento; el límite por cliente es 1`);
    assert.strictEqual(await usosConfirmados('UNAPORCLI'), 1,
      'el registro de usos no coincide con "una vez por cliente"');
    assert.strictEqual(await contadorUsos('UNAPORCLI'), 1, 'el contador global quedó descuadrado');
  });

  await t('A2. el mismo cliente tampoco la obtiene en un intento POSTERIOR', async () => {
    const r = await comprar('8997000001', 'UNAPORCLI');
    assert.ok(r.status >= 400 || (r.body.ahorro || 0) === 0,
      'el cliente volvió a obtener una promoción de un solo uso');
    assert.strictEqual(await usosConfirmados('UNAPORCLI'), 1);
  });

  // ─── B) solo primera compra ───
  await t('B. solo_primera_compra: dos primeros checkouts simultáneos del MISMO teléfono → solo uno', async () => {
    await crearPromo({ nombre: 'Solo primera', tipo: 'porcentaje', valor: 25,
      codigo: 'PRIMERAVEZ', soloPrimeraCompra: true });
    const TEL = '8997000002';  // teléfono virgen: nunca ha pedido
    const [a, b] = await Promise.all([comprar(TEL, 'PRIMERAVEZ'), comprar(TEL, 'PRIMERAVEZ')]);

    const conDescuento = [a, b].filter(r => r.status === 200 && (r.body.ahorro || 0) > 0).length;
    assert.strictEqual(conDescuento, 1,
      `${conDescuento} pedidos se llevaron el descuento de primera compra`);
    assert.strictEqual(await usosConfirmados('PRIMERAVEZ'), 1);
    assert.strictEqual(await contadorUsos('PRIMERAVEZ'), 1, 'el contador global quedó descuadrado');
  });

  // ─── C) clientes distintos ───
  await t('C. teléfonos DISTINTOS: ambos la obtienen si el cupo global alcanza', async () => {
    await crearPromo({ nombre: 'Dos clientes', tipo: 'monto_fijo', valor: 10,
      codigo: 'DOSCLIENTES', limitePorCliente: 1, limiteUsos: 5 });
    const [a, b] = await Promise.all([
      comprar('8997000010', 'DOSCLIENTES'),
      comprar('8997000011', 'DOSCLIENTES'),
    ]);
    const conDescuento = [a, b].filter(r => r.status === 200 && (r.body.ahorro || 0) > 0).length;
    assert.strictEqual(conDescuento, 2,
      `solo ${conDescuento} de 2 clientes distintos la obtuvo — el límite por cliente se está aplicando de más`);
    assert.strictEqual(await usosConfirmados('DOSCLIENTES'), 2);
    assert.strictEqual(await contadorUsos('DOSCLIENTES'), 2);
  });

  await t('C2. el límite GLOBAL sigue mandando por encima del de cliente', async () => {
    await crearPromo({ nombre: 'Global corto', tipo: 'monto_fijo', valor: 10,
      codigo: 'GLOBALCORTO', limitePorCliente: 5, limiteUsos: 1 });
    const [a, b] = await Promise.all([
      comprar('8997000020', 'GLOBALCORTO'),
      comprar('8997000021', 'GLOBALCORTO'),
    ]);
    const conDescuento = [a, b].filter(r => r.status === 200 && (r.body.ahorro || 0) > 0).length;
    assert.strictEqual(conDescuento, 1, `${conDescuento} pedidos pasaron un cupo global de 1`);
    assert.strictEqual(await contadorUsos('GLOBALCORTO'), 1);
  });

  // ─── D) liberación cuando el pedido no llega a crearse ───
  await t('D. si el checkout falla DESPUÉS de reservar, el cupo se devuelve', async () => {
    await crearPromo({ nombre: 'Liberable', tipo: 'monto_fijo', valor: 10,
      codigo: 'LIBERABLE', limitePorCliente: 1, limiteUsos: 3 });
    const TEL = '8997000030';

    // Se fuerza un fallo posterior a la reserva: el producto se vuelve no
    // disponible entre la cotización y la creación del pedido. El checkout
    // reserva la promoción y luego revienta al validar el carrito... no:
    // la validación ocurre ANTES. Se usa una dirección faltante en domicilio,
    // que sí falla después de calcular promociones.
    await pool.query(`UPDATE tienda_config SET modalidades = $2 WHERE negocio_id = $1`,
      [NEG, JSON.stringify(['recoger', 'domicilio'])]);
    const r = await post(`/api/tienda/${SLUG}/checkout`, {
      checkoutToken: token(), items: [{ productoId: PRODUCTO, cantidad: 1 }],
      modalidad: 'domicilio', codigo: 'LIBERABLE',
      cliente: { nombre: 'Falla', telefono: TEL },
      metodoPago: 'efectivo',   // sin dirección: revienta en construirOrdenPOS
    });
    assert.ok(r.status >= 400, 'el pedido inválido se creó de todas formas');

    assert.strictEqual(await reservasVivas('LIBERABLE'), 0,
      'quedó una reserva colgada tras el fallo');
    assert.strictEqual(await contadorUsos('LIBERABLE'), 0,
      'el contador global quedó inflado por un pedido que nunca existió');

    // Y lo que de verdad importa: el cliente puede reintentar y SÍ la obtiene.
    const ok = await comprar(TEL, 'LIBERABLE');
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.ok((ok.body.ahorro || 0) > 0,
      'el cliente perdió la promoción por un intento fallido que no era su culpa');
    await pool.query(`UPDATE tienda_config SET modalidades = $2 WHERE negocio_id = $1`,
      [NEG, JSON.stringify(['recoger'])]);
  });

  // ─── Extra: la reserva no deja basura ni descuadra las métricas ───
  await t('E. ninguna reserva sobrevive a un checkout exitoso', async () => {
    const { rows: [r] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM tienda_promocion_usos
        WHERE negocio_id = $1 AND pedido_folio LIKE 'reserva:%'`, [NEG]);
    assert.strictEqual(r.n, 0, `quedaron ${r.n} reservas sin confirmar ni liberar`);
  });

  await t('F. cada uso confirmado apunta a un pedido que existe de verdad', async () => {
    const { rows } = await pool.query(
      `SELECT u.pedido_folio FROM tienda_promocion_usos u
        WHERE u.negocio_id = $1 AND u.pedido_folio NOT LIKE 'reserva:%'
          AND NOT EXISTS (
            SELECT 1 FROM pedidos_activos p
             WHERE p.negocio_id = u.negocio_id AND p.folio = u.pedido_folio)`, [NEG]);
    assert.deepStrictEqual(rows.map(r => r.pedido_folio), [],
      'hay usos atribuidos a folios inexistentes');
  });

  await t('G. el contador global coincide con los usos reales de cada promoción', async () => {
    const { rows } = await pool.query(
      `SELECT p.codigo, p.usos,
              (SELECT COUNT(*)::int FROM tienda_promocion_usos u
                WHERE u.promocion_id = p.id) AS filas
         FROM tienda_promociones p WHERE p.negocio_id = $1`, [NEG]);
    const desfasadas = rows.filter(r => Number(r.usos) !== Number(r.filas));
    assert.deepStrictEqual(desfasadas, [],
      `contadores descuadrados: ${JSON.stringify(desfasadas)}`);
  });

  // ─── Presión: diez checkouts simultáneos del mismo cliente ───
  await t('H. diez checkouts simultáneos del mismo teléfono con límite 2 → exactamente 2', async () => {
    await crearPromo({ nombre: 'Dos por cliente', tipo: 'monto_fijo', valor: 5,
      codigo: 'DOSPORCLI', limitePorCliente: 2, limiteUsos: 50 });
    const TEL = '8997000040';
    const rs = await Promise.all(Array.from({ length: 10 }, () => comprar(TEL, 'DOSPORCLI')));
    const conDescuento = rs.filter(r => r.status === 200 && (r.body.ahorro || 0) > 0).length;
    assert.strictEqual(conDescuento, 2,
      `${conDescuento} de 10 obtuvieron el descuento; el tope por cliente es 2`);
    assert.strictEqual(await usosConfirmados('DOSPORCLI'), 2);
    assert.strictEqual(await contadorUsos('DOSPORCLI'), 2);
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++;
} finally {
  if (fallidas && servidor) {
    const lineas = servidor.obtenerSalida().split(/\r?\n/).filter(l => l.includes('[Tienda]'));
    if (lineas.length) console.log('\n── Errores del servidor ──\n' + lineas.slice(-12).join('\n'));
  }
  if (servidor) await servidor.detener();
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-tienda-carreras-cliente: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log('  · ' + f)); }
process.exit(fallidas ? 1 : 0);
