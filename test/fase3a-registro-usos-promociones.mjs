// ─── Fase 3A: registro multicanal de usos de promociones ───────────────────
//
// Objetivo: cada promoción REALMENTE aplicada a un pedido persistido (POS,
// WhatsApp legacy, Mesero) registra exactamente UN uso en
// `tienda_promocion_usos`, sin tocar `limite_usos`, `limite_por_cliente`,
// enforcement, ni el ciclo reserva/consumo de la tienda en línea (que queda
// intacto y se prueba aparte para demostrar que no lo tocamos).
//
// Uso: DATABASE_URL=... node test/fase3a-registro-usos-promociones.mjs
import assert from 'assert';

const { pool } = await import('../src/services/database.js');
const { registrarUsoPromocionSimple, guardarPromocion, eliminarPromocion,
  reservarUsosPromociones, registrarUsosPromociones } = await import('../src/services/tiendaPromociones.js');
const { registrarPedido, previsualizarPedido } = await import('../src/orders/orderManager.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

// ── Fixtures (mismo patrón que fase-promociones.mjs: negocio/categoría/
// producto propios, autocontenidos, sin depender del seed compartido) ──────
async function montarNegocio(slug, nombre) {
  const { rows: [n] } = await pool.query(
    `INSERT INTO negocios (nombre, slug) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET nombre=$1 RETURNING id`, [nombre, slug]);
  return n.id;
}
async function categoria(negocioId, nombre) {
  const { rows } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, orden) VALUES ($1,$2,0) ON CONFLICT DO NOTHING RETURNING id`, [negocioId, nombre]);
  if (rows[0]) return rows[0].id;
  return (await pool.query(`SELECT id FROM menu_categorias WHERE negocio_id=$1 AND nombre=$2 LIMIT 1`, [negocioId, nombre])).rows[0].id;
}
async function producto(negocioId, catId, nombre, precio) {
  const { rows } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio) VALUES ($1,$2,$3,$4) RETURNING id`,
    [negocioId, catId, nombre, precio]);
  return rows[0].id;
}
async function limpiarCatalogo(negocioId) {
  await pool.query(`DELETE FROM tienda_promocion_usos WHERE negocio_id=$1`, [negocioId]).catch(() => {});
  await pool.query(`DELETE FROM tienda_promociones WHERE negocio_id=$1`, [negocioId]).catch(() => {});
  await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1`, [negocioId]).catch(() => {});
  await pool.query(`DELETE FROM menu_productos WHERE negocio_id=$1`, [negocioId]).catch(() => {});
  await pool.query(`DELETE FROM menu_categorias WHERE negocio_id=$1`, [negocioId]).catch(() => {});
}
async function nuevaPromo(negocioId, { nombre, valor = 10, canales = ['pos', 'whatsapp'], categorias }) {
  const { id } = await guardarPromocion(negocioId, {
    nombre, tipo: 'porcentaje', automatica: true, valor, categorias, canales,
  });
  return id;
}
async function contarUsos(negocioId, folio) {
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM tienda_promocion_usos WHERE negocio_id=$1 AND pedido_folio=$2`, [negocioId, folio]);
  return r.n;
}
async function filasUso(negocioId, folio) {
  const { rows } = await pool.query(
    `SELECT * FROM tienda_promocion_usos WHERE negocio_id=$1 AND pedido_folio=$2 ORDER BY created_at`, [negocioId, folio]);
  return rows;
}
async function leerPedido(folio) {
  const { rows: [r] } = await pool.query(`SELECT datos FROM pedidos_activos WHERE folio=$1`, [folio]);
  return r?.datos;
}

const NEG_A = await montarNegocio('fase3a-neg-a', 'Fase3A Demo A');
const NEG_B = await montarNegocio('fase3a-neg-b', 'Fase3A Demo B');
await limpiarCatalogo(NEG_A); await limpiarCatalogo(NEG_B);

const cat = await categoria(NEG_A, 'FASE3A');
const pTaco = await producto(NEG_A, cat, 'Taco Fase3A', 100);
const pRefresco = await producto(NEG_A, cat, 'Refresco Fase3A', 30);
const catB = await categoria(NEG_B, 'FASE3A');
const pTacoB = await producto(NEG_B, catB, 'Taco Fase3A B', 100);

// Orden 'pos' ya canónica (como la construye server.js antes de registrarPedido):
// items ya con producto_id/precio, descuentos ya calculado.
function ordenPos(negocioId, { promociones = [], manual = null, total = 100, cliente } = {}) {
  const promoTotal = promociones.reduce((s, p) => s + (p.monto || 0), 0);
  return {
    negocioId,
    items: [{ producto_id: pTaco, nombre: 'Taco Fase3A', cantidad: 1, precio_unitario: 100 }],
    cliente: cliente ?? { telefono: '8780000001', nombre: 'Cliente POS' },
    subtotal: 100,
    total: Math.max(0, 100 - promoTotal - (manual?.monto || 0)),
    forma_pago: 'efectivo',
    modalidad: 'recoger',
    descuentos: {
      manual: manual || { monto: 0, tipo: null, motivo: null, autorizadoPor: null },
      promociones: promociones.map(p => ({ promocionId: p.id, nombre: p.nombre || 'Promo', monto: p.monto, tipo: 'porcentaje', codigo: null })),
      rewards: { monto: 0, puntos: 0 },
      total: promoTotal + (manual?.monto || 0),
    },
  };
}
// Orden 'whatsapp'/'voz'/'api' RAW (propuesta LLM): items por nombre, sin
// descuentos -- los calcula validarOrdenPropuesta dentro de registrarPedido.
function ordenLlm(negocioId, { telefono = '8780000002', cantidad = 1 } = {}) {
  return {
    negocioId,
    items: [{ nombre: 'Taco Fase3A', cantidad }],
    cliente: { telefono, nombre: 'Cliente LLM' },
    forma_pago: 'efectivo',
  };
}

// ════════════════════════════════════════════════════════════════════════
// A-B, F-H · POS (orden ya canónica, hook al final de registrarPedido)
// ════════════════════════════════════════════════════════════════════════
await t('POS', 'A. aplica 1 promoción → 1 uso registrado, monto correcto', async () => {
  const promoId = await nuevaPromo(NEG_A, { nombre: 'P1', valor: 10, categorias: [cat] });
  const pedido = await registrarPedido(ordenPos(NEG_A, { promociones: [{ id: promoId, monto: 10, nombre: 'P1' }] }), 'pos');
  assert.strictEqual(await contarUsos(NEG_A, pedido.id), 1);
  const [fila] = await filasUso(NEG_A, pedido.id);
  assert.strictEqual(Number(fila.monto_descuento), 10);
  assert.strictEqual(fila.estado, 'consumida');
  assert.strictEqual(fila.campania_id, null);
  assert.strictEqual(fila.cliente_nuevo, false, 'default, no se calcula en Fase 3A');
  await eliminarPromocion(NEG_A, promoId);
});

await t('POS', 'B. aplica 2 promociones → 2 usos correctos', async () => {
  const p1 = await nuevaPromo(NEG_A, { nombre: 'P1', valor: 10, categorias: [cat] });
  const p2 = await nuevaPromo(NEG_A, { nombre: 'P2', valor: 5, categorias: [cat] });
  const pedido = await registrarPedido(ordenPos(NEG_A, {
    promociones: [{ id: p1, monto: 10, nombre: 'P1' }, { id: p2, monto: 5, nombre: 'P2' }],
  }), 'pos');
  assert.strictEqual(await contarUsos(NEG_A, pedido.id), 2, 'L. dos promociones, mismo pedido → 2 filas');
  await eliminarPromocion(NEG_A, p1); await eliminarPromocion(NEG_A, p2);
});

await t('POS', 'F. pedido sin promoción → 0 usos', async () => {
  const pedido = await registrarPedido(ordenPos(NEG_A, { promociones: [] }), 'pos');
  assert.strictEqual(await contarUsos(NEG_A, pedido.id), 0);
});

await t('POS', 'G. descuento manual sin promoción → 0 usos', async () => {
  const pedido = await registrarPedido(ordenPos(NEG_A, { promociones: [], manual: { monto: 20, tipo: 'importe', motivo: 'cortesía', autorizadoPor: null } }), 'pos');
  assert.strictEqual(await contarUsos(NEG_A, pedido.id), 0);
});

await t('POS', 'H. Rewards sin promoción → 0 usos (POS no tiene Rewards conectado, prueba con el shape igual)', async () => {
  const orden = ordenPos(NEG_A, { promociones: [] });
  orden.descuentos.rewards = { monto: 15, puntos: 30 };
  const pedido = await registrarPedido(orden, 'pos');
  assert.strictEqual(await contarUsos(NEG_A, pedido.id), 0);
});

// ════════════════════════════════════════════════════════════════════════
// C-D · WhatsApp legacy y Mesero (comparten literalmente registrarPedido +
// validarOrdenPropuesta -- no hay código distinto que probar por separado,
// documentado en el mapa del handoff)
// ════════════════════════════════════════════════════════════════════════
await t('WHATSAPP', 'C. aplica promoción vía validarOrdenPropuesta → 1 uso', async () => {
  const promoId = await nuevaPromo(NEG_A, { nombre: 'PW', valor: 10, categorias: [cat] });
  const pedido = await registrarPedido(ordenLlm(NEG_A), 'whatsapp');
  assert.ok(pedido.descuentos.promociones.length >= 1, 'la promo debió aplicar');
  assert.strictEqual(await contarUsos(NEG_A, pedido.id), pedido.descuentos.promociones.length);
  await eliminarPromocion(NEG_A, promoId);
});

await t('MESERO', 'D. Mesero usa el mismo canal `whatsapp` y la misma función → 1 uso (mismo código, prueba de humo)', async () => {
  const promoId = await nuevaPromo(NEG_A, { nombre: 'PM', valor: 10, categorias: [cat] });
  // canalDelAgente.js llama exactamente `registrar(orden, canal)` con canal='whatsapp'
  // (ver mapa §D del handoff) -- no existe una rama de código distinta para Mesero.
  const pedido = await registrarPedido(ordenLlm(NEG_A, { telefono: '8780000003' }), 'whatsapp');
  assert.strictEqual(await contarUsos(NEG_A, pedido.id), 1);
  await eliminarPromocion(NEG_A, promoId);
});

// ════════════════════════════════════════════════════════════════════════
// E, tienda-en-línea intacta (no pasa por el hook nuevo)
// ════════════════════════════════════════════════════════════════════════
await t('TIENDA', 'E. tienda online: reservarUsosPromociones + registrarUsosPromociones siguen igual, sin fila paralela del hook nuevo', async () => {
  const promoId = await nuevaPromo(NEG_A, { nombre: 'PT', valor: 10, categorias: [cat], canales: ['tienda_online'] });
  const token = 'tok-fase3a-' + Date.now();
  const aplicadas = [{ id: promoId, campaniaId: null, nombre: 'PT', descuento: 10 }];
  const { reservadas } = await reservarUsosPromociones(NEG_A, aplicadas, { checkoutToken: token, telefono: '8780000004' });
  assert.strictEqual(reservadas.length, 1);
  assert.strictEqual(await contarUsos(NEG_A, 'reserva:' + token), 1, 'la reserva existe con folio provisional');

  // El pedido real se crea con canal 'tienda_online' -- el hook de Fase 3A
  // debe IGNORARLO por completo (allowlist explícita pos/whatsapp).
  const orden = ordenPos(NEG_A, { promociones: [{ id: promoId, monto: 10, nombre: 'PT' }] });
  orden.canal = 'tienda_online';
  const pedido = await registrarPedido(orden, 'tienda_online');

  await registrarUsosPromociones({ negocioId: NEG_A, folio: pedido.id, aplicadas, telefono: '8780000004', montoVenta: pedido.total, checkoutToken: token });

  const filas = await filasUso(NEG_A, pedido.id);
  assert.strictEqual(filas.length, 1, 'exactamente la fila de registrarUsosPromociones -- el hook nuevo NO insertó una segunda');
  assert.strictEqual(filas[0].estado, 'consumida');
  await eliminarPromocion(NEG_A, promoId);
});

// ════════════════════════════════════════════════════════════════════════
// I, J · Idempotencia (llamadas directas a registrarUsoPromocionSimple)
// ════════════════════════════════════════════════════════════════════════
await t('IDEMPOTENCIA', 'I. misma promo + mismo folio, llamada 2 veces seguidas → 1 fila', async () => {
  const promoId = await nuevaPromo(NEG_A, { nombre: 'PI', valor: 10, categorias: [cat] });
  const folio = 'FASE3A-IDEM-1';
  const aplicadas = [{ promocionId: promoId, monto: 10, nombre: 'PI' }];
  await registrarUsoPromocionSimple({ negocioId: NEG_A, folio, aplicadas, montoVenta: 90 });
  await registrarUsoPromocionSimple({ negocioId: NEG_A, folio, aplicadas, montoVenta: 90 });
  assert.strictEqual(await contarUsos(NEG_A, folio), 1);
  await eliminarPromocion(NEG_A, promoId);
});

await t('IDEMPOTENCIA', 'J. dos llamadas CONCURRENTES (simula replay/retry en carrera) → 1 fila, sin excepción', async () => {
  const promoId = await nuevaPromo(NEG_A, { nombre: 'PJ', valor: 10, categorias: [cat] });
  const folio = 'FASE3A-IDEM-2';
  const aplicadas = [{ promocionId: promoId, monto: 10, nombre: 'PJ' }];
  await Promise.all([
    registrarUsoPromocionSimple({ negocioId: NEG_A, folio, aplicadas, montoVenta: 90 }),
    registrarUsoPromocionSimple({ negocioId: NEG_A, folio, aplicadas, montoVenta: 90 }),
  ]);
  assert.strictEqual(await contarUsos(NEG_A, folio), 1);
  await eliminarPromocion(NEG_A, promoId);
});

await t('IDEMPOTENCIA', 'K. dos folios distintos, misma promoción → 2 filas', async () => {
  const promoId = await nuevaPromo(NEG_A, { nombre: 'PK', valor: 10, categorias: [cat] });
  const aplicadas = [{ promocionId: promoId, monto: 10, nombre: 'PK' }];
  await registrarUsoPromocionSimple({ negocioId: NEG_A, folio: 'FASE3A-K-1', aplicadas, montoVenta: 90 });
  await registrarUsoPromocionSimple({ negocioId: NEG_A, folio: 'FASE3A-K-2', aplicadas, montoVenta: 90 });
  assert.strictEqual(await contarUsos(NEG_A, 'FASE3A-K-1'), 1);
  assert.strictEqual(await contarUsos(NEG_A, 'FASE3A-K-2'), 1);
  await eliminarPromocion(NEG_A, promoId);
});

await t('IDEMPOTENCIA', 'M. mismo folio literal en dos negocios distintos → NO se cruzan (negocio_id forma parte de la llave)', async () => {
  const pA = await nuevaPromo(NEG_A, { nombre: 'PMA', valor: 10, categorias: [cat] });
  const pB = await nuevaPromo(NEG_B, { nombre: 'PMB', valor: 10, categorias: [catB] });
  const folioColisionado = 'FASE3A-M-COLISION';
  await registrarUsoPromocionSimple({ negocioId: NEG_A, folio: folioColisionado, aplicadas: [{ promocionId: pA, monto: 10 }], montoVenta: 90 });
  await registrarUsoPromocionSimple({ negocioId: NEG_B, folio: folioColisionado, aplicadas: [{ promocionId: pB, monto: 10 }], montoVenta: 90 });
  assert.strictEqual(await contarUsos(NEG_A, folioColisionado), 1);
  assert.strictEqual(await contarUsos(NEG_B, folioColisionado), 1);
  await eliminarPromocion(NEG_A, pA); await eliminarPromocion(NEG_B, pB);
});

await t('IDEMPOTENCIA', 'N. cliente null/anónimo no rompe el registro', async () => {
  const promoId = await nuevaPromo(NEG_A, { nombre: 'PN', valor: 10, categorias: [cat] });
  const folio = 'FASE3A-N-1';
  await registrarUsoPromocionSimple({ negocioId: NEG_A, folio, aplicadas: [{ promocionId: promoId, monto: 10 }], telefono: null, montoVenta: 90 });
  const [fila] = await filasUso(NEG_A, folio);
  assert.strictEqual(fila.cliente_telefono, null);
  await eliminarPromocion(NEG_A, promoId);
});

// ════════════════════════════════════════════════════════════════════════
// O, P · rechazado no registra, confirmado sí registra
// ════════════════════════════════════════════════════════════════════════
await t('CONFIRMACION', 'O. orden rechazada por catálogo (producto inexistente) → nunca llega a folio, 0 usos', async () => {
  const antes = (await pool.query(`SELECT COUNT(*)::int AS n FROM tienda_promocion_usos WHERE negocio_id=$1`, [NEG_A])).rows[0].n;
  await assert.rejects(
    registrarPedido({ negocioId: NEG_A, items: [{ nombre: 'Producto que no existe jamás', cantidad: 1 }], cliente: { telefono: '8780000005' } }, 'whatsapp'),
    /ORDEN_INVALIDA/,
  );
  const despues = (await pool.query(`SELECT COUNT(*)::int AS n FROM tienda_promocion_usos WHERE negocio_id=$1`, [NEG_A])).rows[0].n;
  assert.strictEqual(despues, antes, 'ningún uso nuevo -- el pedido nunca se persistió');
});

await t('CONFIRMACION', 'P. orden confirmada por el flujo real (registrarPedido) → sí registra', async () => {
  const promoId = await nuevaPromo(NEG_A, { nombre: 'PP', valor: 10, categorias: [cat] });
  const pedido = await registrarPedido(ordenLlm(NEG_A, { telefono: '8780000006' }), 'whatsapp');
  assert.strictEqual(await contarUsos(NEG_A, pedido.id), 1);
  await eliminarPromocion(NEG_A, promoId);
});

// ════════════════════════════════════════════════════════════════════════
// Q, R · monto coincide con Fase 2, legacy y normalizado siguen consistentes
// ════════════════════════════════════════════════════════════════════════
await t('CONSISTENCIA', 'Q. monto_descuento de la fila === datos.descuentos.promociones[].monto del pedido', async () => {
  const promoId = await nuevaPromo(NEG_A, { nombre: 'PQ', valor: 10, categorias: [cat] });
  const pedido = await registrarPedido(ordenLlm(NEG_A, { telefono: '8780000007' }), 'whatsapp');
  const datos = await leerPedido(pedido.id);
  const [fila] = await filasUso(NEG_A, pedido.id);
  assert.strictEqual(Number(fila.monto_descuento), datos.descuentos.promociones[0].monto);
  await eliminarPromocion(NEG_A, promoId);
});

await t('CONSISTENCIA', 'R. legacy `promociones[]` y `descuentos.promociones[]` siguen coincidiendo (regresión de Fase 2)', async () => {
  const promoId = await nuevaPromo(NEG_A, { nombre: 'PR', valor: 10, categorias: [cat] });
  const pedido = await registrarPedido(ordenLlm(NEG_A, { telefono: '8780000008' }), 'whatsapp');
  const datos = await leerPedido(pedido.id);
  assert.deepStrictEqual(
    datos.descuentos.promociones.map(p => p.monto),
    datos.promociones.map(p => p.descuento),
  );
  await eliminarPromocion(NEG_A, promoId);
});

// ════════════════════════════════════════════════════════════════════════
// S, T · allowlist explícita: voz/api quedan FUERA aunque apliquen promo
// ════════════════════════════════════════════════════════════════════════
await t('ALLOWLIST', 'S. canal=\'voz\' con promoción realmente aplicada → NO registra (excluido por allowlist, no por el motor)', async () => {
  const promoId = await nuevaPromo(NEG_A, { nombre: 'PS', valor: 10, categorias: [cat], canales: ['pos', 'whatsapp', 'voz'] });
  const pedido = await registrarPedido(ordenLlm(NEG_A, { telefono: '8780000009' }), 'voz');
  assert.ok(pedido.descuentos.promociones.length >= 1, 'la promo sí debía aplicar para este canal (para que la prueba sea real)');
  assert.strictEqual(await contarUsos(NEG_A, pedido.id), 0, 'voz no está en la allowlist {pos, whatsapp}');
  await eliminarPromocion(NEG_A, promoId);
});

await t('ALLOWLIST', 'T. canal=\'api\' con promoción realmente aplicada → NO registra', async () => {
  const promoId = await nuevaPromo(NEG_A, { nombre: 'PT2', valor: 10, categorias: [cat], canales: ['pos', 'whatsapp', 'api'] });
  const pedido = await registrarPedido(ordenLlm(NEG_A, { telefono: '8780000010' }), 'api');
  assert.ok(pedido.descuentos.promociones.length >= 1, 'la promo sí debía aplicar para este canal');
  assert.strictEqual(await contarUsos(NEG_A, pedido.id), 0, 'api no está en la allowlist {pos, whatsapp}');
  await eliminarPromocion(NEG_A, promoId);
});

// ════════════════════════════════════════════════════════════════════════
// Preview vs persistencia (§6) -- calcularPromociones corre en ambos, solo
// la persistencia real debe registrar.
// ════════════════════════════════════════════════════════════════════════
await t('PREVIEW', 'preview con promoción → 0 filas; repetir preview varias veces → sigue 0; persistir → exactamente 1', async () => {
  const promoId = await nuevaPromo(NEG_A, { nombre: 'PPrev', valor: 10, categorias: [cat] });
  const orden = ordenLlm(NEG_A, { telefono: '8780000011' });

  const antesTotal = (await pool.query(`SELECT COUNT(*)::int AS n FROM tienda_promocion_usos WHERE negocio_id=$1`, [NEG_A])).rows[0].n;

  for (let i = 0; i < 3; i++) {
    const prev = await previsualizarPedido(orden, NEG_A, { canal: 'whatsapp' });
    assert.ok(prev.ok, JSON.stringify(prev.rechazos));
    assert.ok(prev.preview.descuento_total > 0, 'el preview debe mostrar la promo aplicada');
  }
  const despuesPreviews = (await pool.query(`SELECT COUNT(*)::int AS n FROM tienda_promocion_usos WHERE negocio_id=$1`, [NEG_A])).rows[0].n;
  assert.strictEqual(despuesPreviews, antesTotal, '3 previews → 0 filas nuevas');

  const pedido = await registrarPedido(orden, 'whatsapp');
  assert.strictEqual(await contarUsos(NEG_A, pedido.id), 1, 'la persistencia real sí registra, exactamente 1');
  await eliminarPromocion(NEG_A, promoId);
});

// ════════════════════════════════════════════════════════════════════════
// Fail-safe real: el INSERT de auditoría falla (FK a una promoción
// inexistente), el pedido debe seguir existiendo y registrarPedido debe
// seguir retornando normalmente.
// ════════════════════════════════════════════════════════════════════════
await t('FAIL-SAFE', 'INSERT de uso falla (promocionId fantasma, viola FK) → registrarPedido NO lanza, pedido sigue persistido, error queda solo logueado', async () => {
  const promocionFantasma = '00000000-0000-0000-0000-000000000000';
  const orden = ordenPos(NEG_A, {
    promociones: [{ id: promocionFantasma, monto: 15, nombre: 'Fantasma' }],
  });
  const t0 = Date.now();
  const pedido = await registrarPedido(orden, 'pos'); // NO debe lanzar
  const ms = Date.now() - t0;
  console.log(`  [FAIL-SAFE] registrarPedido con INSERT de uso fallido tardó ${ms}ms`);

  // El pedido existe, tal cual, con su total financiero intacto.
  const datos = await leerPedido(pedido.id);
  assert.ok(datos, 'el pedido sigue en pedidos_activos');
  assert.strictEqual(datos.total, pedido.total);
  assert.strictEqual(datos.estado ?? pedido.estado, pedido.estado);

  // Y el registro de uso, efectivamente, no quedó (el INSERT violó la FK).
  assert.strictEqual(await contarUsos(NEG_A, pedido.id), 0);
});

// ════════════════════════════════════════════════════════════════════════
// CANAL (migración 090) -- se persiste en la fila misma, es la única forma
// durable: pedidos_activos y pedidos mueren juntos al cancelar.
// ════════════════════════════════════════════════════════════════════════
await t('CANAL', 'POS registra canal=\'pos\'', async () => {
  const promoId = await nuevaPromo(NEG_A, { nombre: 'PCanalPos', valor: 10, categorias: [cat] });
  const pedido = await registrarPedido(ordenPos(NEG_A, { promociones: [{ id: promoId, monto: 10, nombre: 'PCanalPos' }] }), 'pos');
  const [fila] = await filasUso(NEG_A, pedido.id);
  assert.strictEqual(fila.canal, 'pos');
  await eliminarPromocion(NEG_A, promoId);
});

await t('CANAL', 'WhatsApp legacy registra canal=\'whatsapp\'', async () => {
  const promoId = await nuevaPromo(NEG_A, { nombre: 'PCanalWa', valor: 10, categorias: [cat] });
  const pedido = await registrarPedido(ordenLlm(NEG_A, { telefono: '8780000012' }), 'whatsapp');
  const [fila] = await filasUso(NEG_A, pedido.id);
  assert.strictEqual(fila.canal, 'whatsapp');
  await eliminarPromocion(NEG_A, promoId);
});

await t('CANAL', 'Mesero registra canal=\'whatsapp\' (mismo código que WhatsApp legacy)', async () => {
  const promoId = await nuevaPromo(NEG_A, { nombre: 'PCanalMesero', valor: 10, categorias: [cat] });
  const pedido = await registrarPedido(ordenLlm(NEG_A, { telefono: '8780000013' }), 'whatsapp');
  const [fila] = await filasUso(NEG_A, pedido.id);
  assert.strictEqual(fila.canal, 'whatsapp');
  await eliminarPromocion(NEG_A, promoId);
});

await t('CANAL', 'tienda en línea registra canal=\'tienda_online\' vía registrarUsosPromociones', async () => {
  const promoId = await nuevaPromo(NEG_A, { nombre: 'PCanalTienda', valor: 10, categorias: [cat], canales: ['tienda_online'] });
  const folio = 'FASE3A-CANAL-TIENDA';
  await registrarUsosPromociones({
    negocioId: NEG_A, folio, aplicadas: [{ id: promoId, campaniaId: null, nombre: 'PCanalTienda', descuento: 10 }],
    telefono: '8780000014', montoVenta: 90, canal: 'tienda_online',
  });
  const [fila] = await filasUso(NEG_A, folio);
  assert.strictEqual(fila.canal, 'tienda_online');
  await eliminarPromocion(NEG_A, promoId);
});

await t('CANAL', 'retry conserva UNA sola fila y el canal correcto', async () => {
  const promoId = await nuevaPromo(NEG_A, { nombre: 'PCanalRetry', valor: 10, categorias: [cat] });
  const folio = 'FASE3A-CANAL-RETRY';
  const aplicadas = [{ promocionId: promoId, monto: 10, nombre: 'PCanalRetry' }];
  await registrarUsoPromocionSimple({ negocioId: NEG_A, folio, aplicadas, montoVenta: 90, canal: 'whatsapp' });
  await registrarUsoPromocionSimple({ negocioId: NEG_A, folio, aplicadas, montoVenta: 90, canal: 'whatsapp' });
  assert.strictEqual(await contarUsos(NEG_A, folio), 1);
  const [fila] = await filasUso(NEG_A, folio);
  assert.strictEqual(fila.canal, 'whatsapp');
  await eliminarPromocion(NEG_A, promoId);
});

await t('CANAL', 'dos negocios no se cruzan (canal incluido)', async () => {
  const pA = await nuevaPromo(NEG_A, { nombre: 'PCanalCruceA', valor: 10, categorias: [cat] });
  const pB = await nuevaPromo(NEG_B, { nombre: 'PCanalCruceB', valor: 10, categorias: [catB] });
  const folioColisionado = 'FASE3A-CANAL-CRUCE';
  await registrarUsoPromocionSimple({ negocioId: NEG_A, folio: folioColisionado, aplicadas: [{ promocionId: pA, monto: 10 }], montoVenta: 90, canal: 'pos' });
  await registrarUsoPromocionSimple({ negocioId: NEG_B, folio: folioColisionado, aplicadas: [{ promocionId: pB, monto: 10 }], montoVenta: 90, canal: 'whatsapp' });
  const [filaA] = await filasUso(NEG_A, folioColisionado);
  const [filaB] = await filasUso(NEG_B, folioColisionado);
  assert.strictEqual(filaA.canal, 'pos');
  assert.strictEqual(filaB.canal, 'whatsapp');
  await eliminarPromocion(NEG_A, pA); await eliminarPromocion(NEG_B, pB);
});

await t('CANAL', 'backfill: una fila histórica sin canal (simulada) queda tienda_online tras el UPDATE de la 090', async () => {
  const promoId = await nuevaPromo(NEG_A, { nombre: 'PBackfill', valor: 10, categorias: [cat], canales: ['tienda_online'] });
  const folio = 'FASE3A-BACKFILL-HIST';
  // Simula una fila PRE-090: inserta directo con canal NULL (como habría
  // quedado cualquier fila escrita por tienda antes de esta migración).
  await pool.query(
    `INSERT INTO tienda_promocion_usos (negocio_id, promocion_id, pedido_folio, monto_descuento, monto_venta, estado, canal)
     VALUES ($1,$2,$3,10,90,'consumida',NULL)`, [NEG_A, promoId, folio]);
  const [antes] = await filasUso(NEG_A, folio);
  assert.strictEqual(antes.canal, null, 'fixture: debía nacer sin canal, simulando pre-090');
  // Mismo UPDATE exacto que trae la migración 090.
  await pool.query(`UPDATE tienda_promocion_usos SET canal = 'tienda_online' WHERE canal IS NULL AND negocio_id = $1`, [NEG_A]);
  const [despues] = await filasUso(NEG_A, folio);
  assert.strictEqual(despues.canal, 'tienda_online');
  await eliminarPromocion(NEG_A, promoId);
});

await t('CANAL', 'canal sigue disponible aunque el pedido se elimine después (cancelación/purga)', async () => {
  const promoId = await nuevaPromo(NEG_A, { nombre: 'PCanalSobrevive', valor: 10, categorias: [cat] });
  const pedido = await registrarPedido(ordenPos(NEG_A, { promociones: [{ id: promoId, monto: 10, nombre: 'PCanalSobrevive' }] }), 'pos');
  const { eliminarPedido } = await import('../src/orders/orderManager.js');
  const borrado = await eliminarPedido(pedido.id, NEG_A);
  assert.ok(borrado, 'el pedido debía eliminarse para que la prueba sea real');
  assert.strictEqual((await pool.query(`SELECT 1 FROM pedidos_activos WHERE folio=$1`, [pedido.id])).rowCount, 0,
    'fixture: el pedido debía desaparecer de pedidos_activos');
  const [fila] = await filasUso(NEG_A, pedido.id);
  assert.ok(fila, 'la fila de uso sigue existiendo pese a que el pedido ya no existe');
  assert.strictEqual(fila.canal, 'pos', 'el canal se conserva aunque el pedido ya no se pueda consultar');
  await eliminarPromocion(NEG_A, promoId);
});

await t('CANAL', 'monto_venta: misma semántica (total del pedido en el momento del registro) en POS y WhatsApp', async () => {
  const promoPos = await nuevaPromo(NEG_A, { nombre: 'PMontoPos', valor: 10, categorias: [cat] });
  const pedidoPos = await registrarPedido(ordenPos(NEG_A, { promociones: [{ id: promoPos, monto: 10, nombre: 'PMontoPos' }] }), 'pos');
  const [filaPos] = await filasUso(NEG_A, pedidoPos.id);
  assert.strictEqual(Number(filaPos.monto_venta), pedidoPos.total, 'POS: monto_venta === pedido.total (subtotal - descuento + envío)');

  const promoWa = await nuevaPromo(NEG_A, { nombre: 'PMontoWa', valor: 10, categorias: [cat] });
  const pedidoWa = await registrarPedido(ordenLlm(NEG_A, { telefono: '8780000015' }), 'whatsapp');
  const [filaWa] = await filasUso(NEG_A, pedidoWa.id);
  assert.strictEqual(Number(filaWa.monto_venta), pedidoWa.total, 'WhatsApp: monto_venta === pedido.total, misma fórmula');
  await eliminarPromocion(NEG_A, promoPos); await eliminarPromocion(NEG_A, promoWa);
});

// ════════════════════════════════════════════════════════════════════════
// Costo aproximado del INSERT adicional (informativo, no assertion dura)
// ════════════════════════════════════════════════════════════════════════
await t('COSTO', 'medir costo aproximado del registro de uso dentro de registrarPedido', async () => {
  const promoId = await nuevaPromo(NEG_A, { nombre: 'PCosto', valor: 10, categorias: [cat] });
  const N = 20;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    await registrarPedido(ordenPos(NEG_A, { promociones: [{ id: promoId, monto: 10, nombre: 'PCosto' }], cliente: { telefono: '878' + i } }), 'pos');
  }
  const conPromo = (Date.now() - t0) / N;
  const t1 = Date.now();
  for (let i = 0; i < N; i++) {
    await registrarPedido(ordenPos(NEG_A, { promociones: [], cliente: { telefono: '879' + i } }), 'pos');
  }
  const sinPromo = (Date.now() - t1) / N;
  console.log(`  [COSTO] registrarPedido promedio CON promo (incluye INSERT de uso): ${conPromo.toFixed(1)}ms`);
  console.log(`  [COSTO] registrarPedido promedio SIN promo (sin el hook): ${sinPromo.toFixed(1)}ms`);
  console.log(`  [COSTO] costo marginal aproximado del INSERT de uso: ${(conPromo - sinPromo).toFixed(1)}ms`);
  await eliminarPromocion(NEG_A, promoId);
});

// ── Limpieza final ──────────────────────────────────────────────────────
await limpiarCatalogo(NEG_A); await limpiarCatalogo(NEG_B);

console.log(`\n${pasadas} OK · ${fallidas} fallos`);
if (fallidas) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
await pool.end();
process.exit(fallidas ? 1 : 0);
