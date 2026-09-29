// ─── EL PEDIDO CANÓNICO, DE PUNTA A PUNTA, CONTRA POSTGRES ────────────────
//
// Recorre el camino completo por el ADAPTADOR REAL (`atenderConAgente`):
//
//   mensaje → estado versionado → respuesta corta contra el pendiente o
//   modelo (de guion) → herramientas → ejecutor → reconciliador → commit
//   atómico (estado + operaciones + outbox + traza) → acuse del transporte →
//   … → confirmación → registrarPedido REAL → folio persistido UNA vez.
//
// De mentira: el modelo (un guion que lee los resultados reales de las
// herramientas), el transporte de WhatsApp (el acuse con un wamid inventado),
// la emisión a cocina (se registra, no imprime) y el aviso humano. De verdad:
// Postgres, la carta publicada (098), la traza y el outbox (099), el libro de
// operaciones, `registrarPedido` y `validarOrdenPropuesta`.
//
// Uso: DATABASE_URL a un Postgres LOCAL y desechable con 098/099 aplicadas.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const HOST = new URL(process.env.DATABASE_URL).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(HOST)) {
  throw new Error('Esta prueba crea pedidos: solo acepta Postgres local');
}

const { pool, actualizarConfiguracion } = await import('../src/services/database.js');
const { registrarPedido } = await import('../src/orders/orderManager.js');
const {
  atenderConAgente, registrarRespuestaEnviada, confirmarYEmitir,
} = await import('../src/mesero-agente/canalDelAgente.js');
const { despacharRespuestasPendientes } = await import('../src/mesero-agente/entregaDeRespuestas.js');
const { estadoNuevo } = await import('../src/mesero-agente/ejecutorDeHerramientas.js');
const { guardarPromocion } = await import('../src/services/tiendaPromociones.js');

const PREFIJO = 'CAN ';
const ZONA = 'America/Matamoros';
const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const hoyLocal = new Date(new Date().toLocaleString('en-US', { timeZone: ZONA }));
const diaCerrado = DIAS[(hoyLocal.getDay() + 3) % 7];
const REGLAS = {
  timezone: ZONA,
  horarios: Object.fromEntries(['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']
    .map((d) => [d, d === diaCerrado ? { abierto: false } : { abierto: true, apertura: '00:00', cierre: '23:59' }])),
  pedidos: {
    modalidades: ['recoger en tienda', 'entrega a domicilio'],
    tiempo_preparacion_minutos: 20, pedido_minimo_entrega: 0,
    costo_envio: 30, zonas_entrega: [{ nombre: 'Centro', costo: 40 }],
  },
  cierres_especiales: [], promociones: [], politicas: [],
};

let pasadas = 0;
const fallos = [];
// Lo que cada caso deja sembrado se retira aunque el caso falle: un caso roto
// no puede contaminar al siguiente (una promoción activa cambia los totales).
const despuesDeCada = [];
// CASOS=01,19b corre solo esos (para las pruebas de mordida).
const SOLO = (process.env.CASOS || '').split(',').map((s) => s.trim()).filter(Boolean);
async function t(nombre, fn) {
  if (SOLO.length && !SOLO.includes(nombre.split(' ')[0])) return;
  try { await fn(); pasadas += 1; console.log(`    OK  ${nombre}`); }
  catch (e) { fallos.push(`${nombre}: ${e.message}`); console.log(`> FALLO ${nombre}: ${e.message}`); }
  finally { for (const f of despuesDeCada) await f().catch(() => {}); }
}

// ── Montaje: dos negocios, carta con productos internos, publicación ─────
const negocios = [];
async function crearNegocio(nombre, reglas = REGLAS) {
  // Un negocio que atiende por bot tiene encendido su interruptor maestro: el
  // despachador del outbox no entrega nada de un negocio con el bot apagado.
  const { rows: [n] } = await pool.query(
    'INSERT INTO negocios (nombre, slug, bot_whatsapp_activo) VALUES ($1,$2,TRUE) RETURNING id',
    [PREFIJO + nombre, `can-${randomUUID()}`]);
  negocios.push(n.id);
  await actualizarConfiguracion({
    nombre_negocio: PREFIJO + nombre, modo_pedidos: 'transaccional', timezone: ZONA,
    pedido_requiere_pago: 'true', reglas_atencion: JSON.stringify(reglas),
  }, n.id);
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado)
    VALUES ($1,'whatsapp','activo'),($1,'pos','activo'),($1,'tienda_online','activo')
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [n.id]);
  await pool.query(`INSERT INTO tienda_config (negocio_id, estado, modalidades, acepta_programados, anticipacion_minutos, publicada_at)
    VALUES ($1,'publicada','["recoger","domicilio"]'::jsonb,TRUE,30,NOW())`, [n.id]);
  await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado, disponible_para_bot, disponible_para_operador, orden)
    VALUES ($1,'efectivo',TRUE,TRUE,TRUE,10),($1,'terminal',TRUE,TRUE,TRUE,20)`, [n.id]);
  return n.id;
}
async function crearCategoria(neg, nombre, orden) {
  const { rows: [c] } = await pool.query(
    'INSERT INTO menu_categorias (negocio_id,nombre,activa,orden) VALUES ($1,$2,TRUE,$3) RETURNING id',
    [neg, PREFIJO + nombre, orden]);
  return c.id;
}
async function crearProducto(neg, cat, nombre, precio, grupos = [], { publicar = true } = {}) {
  const { rows: [p] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio,disponible,agotado,orden)
     VALUES ($1,$2,$3,$4,TRUE,FALSE,0) RETURNING id`, [neg, cat, PREFIJO + nombre, precio]);
  let orden = 0;
  for (const g of grupos) {
    const { rows: [gr] } = await pool.query(
      `INSERT INTO menu_modificadores_grupos (negocio_id,producto_id,nombre,requerido,minimo,maximo,orden)
       VALUES ($1,$2,$3,TRUE,1,1,$4) RETURNING id`, [neg, p.id, g.nombre, orden++]);
    let o = 0;
    for (const op of g.opciones) {
      await pool.query(`INSERT INTO menu_modificadores_opciones (negocio_id,grupo_id,nombre,precio_extra,disponible,orden)
        VALUES ($1,$2,$3,0,TRUE,$4)`, [neg, gr.id, op, o++]);
    }
  }
  if (publicar) {
    await pool.query(`INSERT INTO whatsapp_productos (negocio_id, producto_id, publicado) VALUES ($1,$2,TRUE)
      ON CONFLICT (negocio_id, producto_id) DO UPDATE SET publicado=TRUE`, [neg, p.id]);
  }
  return p.id;
}
// Por el servicio del panel, con sus validaciones y valores por omisión.
const crearPromo = async (neg, { nombre, tipo, valor = 0, productos }) => (await guardarPromocion(neg, {
  nombre: PREFIJO + nombre, tipo, valor, automatica: true, canales: ['whatsapp'], productos,
  ...(tipo === '2x1' ? { cantidadRequerida: 2, cantidadBeneficiada: 1 } : {}),
})).id;
const desactivarPromos = (neg) => pool.query('UPDATE tienda_promociones SET activa=FALSE WHERE negocio_id=$1', [neg]);
despuesDeCada.push(() => Promise.all(negocios.map(desactivarPromos)));

const NEG_A = await crearNegocio('Canonico A');
const NEG_B = await crearNegocio('Canonico B');
const NEG_CERRADO = await crearNegocio('Canonico Cerrado', {
  ...REGLAS, horarios: Object.fromEntries(Object.keys(REGLAS.horarios).map((d) => [d, { abierto: false }])),
});
const CAT_A = await crearCategoria(NEG_A, 'Desayunos', 1);
const CAT_EXTRAS = await crearCategoria(NEG_A, 'EXTRAS', 2);
const ID = {
  waffle: await crearProducto(NEG_A, CAT_A, 'Waffle', 105),
  chilaquiles: await crearProducto(NEG_A, CAT_A, 'Chilaquiles', 195, [
    { nombre: 'Salsa', opciones: ['Verde', 'Roja', 'Suiza'] },
    { nombre: 'Proteína', opciones: ['Huevo', 'Pollo'] },
  ]),
  cafe: await crearProducto(NEG_A, CAT_A, 'Café Americano', 45),
  licuado: await crearProducto(NEG_A, CAT_A, 'Licuado', 60, [
    { nombre: 'Endulzante', opciones: ['Azúcar', 'Miel', 'Sin endulzante'] },
  ]),
  // Artículos INTERNOS del POS: existen en el menú, NO en la carta de WhatsApp.
  pieza: await crearProducto(NEG_A, CAT_A, 'Pieza de Hotcake', 55, [], { publicar: false }),
  extraHuevo: await crearProducto(NEG_A, CAT_EXTRAS, 'Extra Huevo', 20, [], { publicar: false }),
};
const CAT_B = await crearCategoria(NEG_B, 'Pizzas', 1);
const ID_B = { pizza: await crearProducto(NEG_B, CAT_B, 'Pizza Margarita', 180) };
await crearProducto(NEG_CERRADO, await crearCategoria(NEG_CERRADO, 'Carta', 1), 'Waffle Cerrado', 100);

// ── El modelo de guion ────────────────────────────────────────────────────
let nTool = 0;
const tu = (name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tu_can_${++nTool}`, name, input }] });
const tx = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
function ultimoResultado(payload) {
  const msgs = payload?.messages || [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const c = msgs[i]?.content;
    if (!Array.isArray(c)) continue;
    for (let j = c.length - 1; j >= 0; j -= 1) {
      if (c[j]?.type === 'tool_result') { try { return JSON.parse(c[j].content); } catch { return null; } }
    }
  }
  return null;
}
function guion(pasos) {
  let i = 0;
  const fn = async (payload) => {
    const p = pasos[i]; i += 1;
    if (!p) return tx('(guion agotado)');
    return typeof p === 'function' ? p(payload) : p;
  };
  fn.llamadas = () => i;
  return fn;
}
const sinModelo = async () => { throw Object.assign(new Error('este turno no debía llegar al modelo'), { sinModelo: true }); };
// Varias llamadas en una sola respuesta, como hace el modelo real: el bucle
// tiene un presupuesto de 6 vueltas por turno.
const tus = (...llamadas) => ({ stop_reason: 'tool_use',
  content: llamadas.map(([name, input]) => ({ type: 'tool_use', id: `tu_can_${++nTool}`, name, input })) });
function resultados(payload) {
  const ultimo = (payload?.messages || []).at(-1)?.content;
  return (Array.isArray(ultimo) ? ultimo : []).filter((c) => c?.type === 'tool_result')
    .map((c) => { try { return JSON.parse(c.content); } catch { return null; } });
}
// Busca y agrega el primer candidato con las opciones dadas (lee el id REAL
// del resultado de buscar_producto, como el modelo real).
const buscarYAgregar = (texto, { cantidad = 1, opciones } = {}) => [
  tu('buscar_producto', { texto }),
  (payload) => {
    const r = ultimoResultado(payload);
    const id = r?.encontrados?.[0]?.producto_id;
    if (!id) return tx('No lo encontré.');
    return tu('agregar_producto', { producto_id: String(id), cantidad, ...(opciones ? { opciones } : {}) });
  },
];
// Lo mismo para varios productos: una respuesta con todas las búsquedas y otra
// con todos los agregados.
const buscarYAgregarVarios = (pedidos) => [
  tus(...pedidos.map((p) => ['buscar_producto', { texto: p.texto }])),
  (payload) => {
    const rs = resultados(payload);
    return tus(...pedidos.map((p, i) => ['agregar_producto', {
      producto_id: String(rs[i]?.encontrados?.[0]?.producto_id ?? 'sin-id'), cantidad: p.cantidad ?? 1,
      ...(p.opciones ? { opciones: p.opciones } : {}),
    }]));
  },
];
const entregaYPago = (entrega, forma_pago) => tus(['definir_entrega', entrega], ['definir_pago', { forma_pago }]);

// ── El canal, simulado: turno + acuse del transporte ─────────────────────
const handoffs = [];
const emitidos = [];
let nWamid = 0;
const wamid = () => `wamid.CAN.${Date.now()}.${++nWamid}`;
async function turno(tel, mensaje, modelo = sinModelo, {
  negocio = NEG_A, w = wamid(), enviar = true, db = undefined, toleraAcuseViejo = false,
} = {}) {
  const r = await atenderConAgente({
    negocioId: negocio, telefono: tel, mensaje, nombre: 'Cliente Canonico', canal: 'whatsapp',
    llamarModelo: Array.isArray(modelo) ? guion(modelo) : modelo, wamids: [w],
    registrar: registrarPedido,
    emitir: async (p) => { emitidos.push(p?.id); },
    guardar: async () => {},
    escalarAHumano: async (n, telefono, motivo) => { handoffs.push({ n, telefono, motivo }); return true; },
    enviarMenu: async () => ({ ok: false, motivo: 'sin menú en la prueba' }),
    ...(db ? { db } : {}),
  });
  r._wamid = w;
  if (enviar && r.ok && r.texto && !(r.repetido && r.yaEntregado)) {
    try {
      await registrarRespuestaEnviada(negocio, tel, r, mensaje, `wamid.out.${++nWamid}`);
    } catch (e) {
      // En paralelo, la respuesta de un turno ya superado por otro no se acusa
      // (el despachador la descarta por vieja): es lo esperado, no un fallo.
      if (!(toleraAcuseViejo && e.message === 'acuse_no_corresponde_al_turno')) throw e;
      r._acuseViejo = true;
    }
  }
  return r;
}

// ── Lecturas de la base ──────────────────────────────────────────────────
const estadoDe = async (tel, negocio = NEG_A) => (await pool.query(
  `SELECT estado, revision FROM conversacion_estado WHERE negocio_id=$1 AND session_id=$2`,
  [negocio, `agente:${tel}`])).rows[0] || null;
const pedidosDe = async (tel, negocio = NEG_A) => (await pool.query(
  `SELECT folio, estado, datos FROM pedidos_activos WHERE negocio_id=$1 AND datos->'cliente'->>'telefono'=$2
    UNION ALL SELECT folio, 'programado', datos FROM pedidos_programados
     WHERE negocio_id=$1 AND datos->'cliente'->>'telefono'=$2`, [negocio, tel])).rows;
const outboxDe = async (tel, negocio = NEG_A) => (await pool.query(
  `SELECT tipo, estado, carga, intentos FROM agente_outbox WHERE negocio_id=$1 AND conversacion_id=$2 ORDER BY created_at, tipo`,
  [negocio, `agente:${tel}`])).rows;
const turnosDe = async (tel, negocio = NEG_A) => (await pool.query(
  `SELECT turno_clave, wamids, fase_antes, fase_despues, version_antes, version_despues, acciones, rechazos,
          folio, outbox_claves, motivo_handoff, cierre, recuperacion
     FROM agente_turnos WHERE negocio_id=$1 AND conversacion_id LIKE $2 ORDER BY id`,
  [negocio, `agente:${tel}%`])).rows;
const operacionesDe = async (tel, negocio = NEG_A) => (await pool.query(
  `SELECT herramienta, estado, aplicada, turno_id FROM agente_operaciones
    WHERE negocio_id=$1 AND conversacion_id LIKE $2 ORDER BY created_at`,
  [negocio, `agente:${tel}%`])).rows;
const lineasDe = (estado) => (estado?.carrito?.items || []).map((i) => `${i.cantidad}x${i.nombre}`).sort();
// Para los mensajes de error: qué propuso cada turno y qué decidió Xabor.
const explicar = async (tel, negocio = NEG_A) => (await turnosDe(tel, negocio))
  .map((t, i) => `T${i + 1}[${t.fase_despues}] ${(t.acciones || [])
    .map((a) => `${a.herramienta}:${a.aplicada ? 'ok' : `NO(${String(a.motivo || a.estado).slice(0, 70)})`}`).join(', ')}`)
  .join(' | ');

let nTel = 0;
const tel = () => `52819911${String(++nTel).padStart(2, '0')}`;

try {
  // ═══ 1 · PEDIDO SENCILLO PARA RECOGER + 28 · ASERCIONES EN BASE ═════════
  await t('01 pickup: resumen → «sí» → UN folio persistido, sin modelo en la confirmación', async () => {
    const T = tel();
    const r1 = await turno(T, 'quiero un waffle para recoger, pago en efectivo', [
      ...buscarYAgregar('waffle'),
      tu('definir_entrega', { modalidad: 'recoger en tienda' }),
      tu('definir_pago', { forma_pago: 'efectivo' }),
      tx('Te resumo tu pedido, ¿lo confirmo?'),
    ]);
    assert.equal(r1.ok, true, r1.motivo);
    assert.match(r1.texto, /¿Confirmas este pedido\?$/, 'la respuesta no es el resumen canónico');
    let fila = await estadoDe(T);
    assert.equal(fila.estado.fase, 'esperando_confirmacion');
    assert.equal(fila.estado.pendiente?.tipo, 'confirmar_resumen');
    assert.equal(fila.estado.version, Number(fila.revision), 'la versión del JSON no acompaña a la fila');
    assert.equal((await pedidosDe(T)).length, 0, 'un resumen no es un pedido');
    const r2 = await turno(T, 'sí');
    assert.equal(r2.llamadasAlModelo, 0, 'la confirmación pasó por el modelo');
    const pedidos = await pedidosDe(T);
    assert.equal(pedidos.length, 1, `folios: ${JSON.stringify(pedidos.map((p) => p.folio))}`);
    assert.match(pedidos[0].folio, /^XAB-\d+$/);
    assert.equal(Number(pedidos[0].datos.total), 105);
    assert.equal(pedidos[0].datos.catalogo_publicado, 'whatsapp');
    assert.ok(pedidos[0].datos.origen_agente?.conversacion_id, 'el pedido no lleva la identidad de la conversación');
    assert.match(r2.texto, new RegExp(pedidos[0].folio), 'el cliente no recibió el folio real');
    fila = await estadoDe(T);
    assert.equal(fila.estado.fase, 'confirmado');
    assert.equal(fila.estado.folio, pedidos[0].folio);
    assert.equal(fila.estado.pendiente, null);
    assert.ok(emitidos.includes(pedidos[0].folio), 'el pedido no se emitió a la operación');
    const salidas = (await outboxDe(T)).filter((o) => o.tipo === 'respuesta_cliente');
    assert.equal(salidas.length, 2);
    assert.ok(salidas.every((o) => o.estado === 'entregado' && o.carga.wamid_salida), 'respuesta sin acuse en el outbox');
    const trazas = await turnosDe(T);
    assert.equal(trazas.length, 2);
    assert.equal(trazas[1].folio, pedidos[0].folio);
    // Conversación nueva: sin versión previa, en la fase inicial.
    assert.equal(trazas[0].version_antes, null);
    assert.deepEqual([trazas[0].fase_antes, trazas[0].fase_despues, trazas[1].fase_despues],
      ['seleccionando_productos', 'esperando_confirmacion', 'confirmado']);
    assert.ok(Number(trazas[1].version_antes) > Number(trazas[0].version_despues),
      'el acuse del transporte no dejó rastro de versión entre turnos');
    const confirmaciones = (await operacionesDe(T)).filter((o) => o.herramienta === 'confirmar_pedido');
    assert.equal(confirmaciones.length, 1);
    assert.equal(confirmaciones[0].estado, 'ok');
  });

  // ═══ 1b · EL «SÍ» QUE DUPLICABA EL CAFÉ ════════════════════════════════
  // Producción, 24-sep (b969959): «un café americano» → el modelo lo AGREGA y
  // pregunta «¿Lo confirmo?» sin entrega ni pago; el «sí» entraba como
  // aceptación de la «oferta» y metía un SEGUNDO café. Ahora el «sí» solo puede
  // contestar la pregunta pendiente que hizo el backend: no agrega nada, y al
  // cerrar el pedido se cobra UN café.
  await t('01b el «sí» a «¿Lo confirmo?» no agrega un segundo producto', async () => {
    const T = tel();
    const r1 = await turno(T, 'un café americano', [
      ...buscarYAgregar('café americano'),
      tx(`Listo, un ${PREFIJO}Café Americano. ¿Lo confirmo?`),
    ]);
    assert.equal(r1.ok, true, r1.motivo);
    assert.deepEqual(lineasDe((await estadoDe(T)).estado), [`1x${PREFIJO}Café Americano`]);
    const r2 = await turno(T, 'sí', [tx('¿Lo quieres para recoger o a domicilio?')]);
    assert.equal(r2.ok, true, r2.motivo);
    assert.deepEqual(lineasDe((await estadoDe(T)).estado), [`1x${PREFIJO}Café Americano`],
      `el «sí» agregó otro café: ${await explicar(T)}`);
    assert.equal((await pedidosDe(T)).length, 0, 'un «sí» sin entrega ni pago registró un pedido');
    await turno(T, 'para recoger, en efectivo', [
      entregaYPago({ modalidad: 'recoger en tienda' }, 'efectivo'), tx('Resumen'),
    ]);
    assert.equal((await estadoDe(T)).estado.pendiente?.tipo, 'confirmar_resumen');
    await turno(T, 'sí');
    const pedidos = await pedidosDe(T);
    assert.equal(pedidos.length, 1, `folios: ${JSON.stringify(pedidos.map((p) => p.folio))}`);
    assert.equal(Number(pedidos[0].datos.total), 45, 'se cobró más de un café');
    assert.deepEqual(pedidos[0].datos.items.map((i) => Number(i.cantidad)), [1]);
  });

  await t('01c un «ok» escrito ANTES de que llegara el resumen no confirma; el «sí» de después sí', async () => {
    // Revisión adversarial del candidato: el «sí» solo exigía que el resumen
    // estuviera acusado al procesar, no que el cliente lo hubiera recibido
    // ANTES de escribir. Un «ok» en cola mientras el resumen se armaba
    // confirmaba el pedido que el cliente todavía no leía.
    const T = tel();
    const entrada = async (w) => {
      await pool.query('INSERT INTO whatsapp_conversaciones (negocio_id, telefono) VALUES ($1,$2) ON CONFLICT DO NOTHING', [NEG_A, T]);
      await pool.query(`INSERT INTO whatsapp_entradas (negocio_id, telefono, wamid, payload) VALUES ($1,$2,$3,'{}'::jsonb)`, [NEG_A, T, w]);
    };
    const msgResumen = 'un café americano para recoger, en efectivo';
    const r1 = await turno(T, msgResumen, [
      ...buscarYAgregar('café americano'), entregaYPago({ modalidad: 'recoger en tienda' }, 'efectivo'), tx('Resumen'),
    ], { enviar: false });
    assert.equal((await estadoDe(T)).estado.pendiente?.tipo, 'confirmar_resumen', r1.texto);
    // El cliente escribe «ok» mientras el resumen todavía no le llega...
    const wOk = wamid();
    await entrada(wOk);
    await new Promise((ok) => setTimeout(ok, 20));
    // ...y DESPUÉS Meta entrega el resumen.
    await registrarRespuestaEnviada(NEG_A, T, r1, msgResumen, `wamid.out.${++nWamid}`);
    assert.equal((await estadoDe(T)).estado.dialogo?.enviado, true);
    assert.ok((await estadoDe(T)).estado.dialogo?.acusadoAt, 'el acuse no guardó su hora');
    const r2 = await turno(T, 'ok', sinModelo, { w: wOk });
    assert.equal((await pedidosDe(T)).length, 0, `un «ok» escrito antes del resumen registró el pedido: ${r2.texto}`);
    assert.match(r2.texto, /¿Confirmas este pedido\?$/, `no se volvió a mostrar el resumen: ${r2.texto}`);
    assert.ok(!r2.escalado && r2.handoffPendiente !== true, 'volver a mostrar el resumen no es pasar a una persona');
    // Ahora sí lo leyó (turno() acusó el resumen reenviado) y contesta después.
    const wSi = wamid();
    await new Promise((ok) => setTimeout(ok, 20));
    await entrada(wSi);
    await turno(T, 'sí', sinModelo, { w: wSi });
    const pedidos = await pedidosDe(T);
    assert.equal(pedidos.length, 1, `folios: ${JSON.stringify(pedidos.map((p) => p.folio))}`);
    assert.equal(Number(pedidos[0].datos.total), 45);
  });

  await t('01d un «sí» escrito ANTES de que llegara la oferta de un producto no lo agrega', async () => {
    const T = tel();
    const entrada = async (w) => {
      await pool.query('INSERT INTO whatsapp_conversaciones (negocio_id, telefono) VALUES ($1,$2) ON CONFLICT DO NOTHING', [NEG_A, T]);
      await pool.query(`INSERT INTO whatsapp_entradas (negocio_id, telefono, wamid, payload) VALUES ($1,$2,$3,'{}'::jsonb)`, [NEG_A, T, w]);
    };
    const msgOferta = '¿tienen café?';
    const r1 = await turno(T, msgOferta, [tu('buscar_producto', { texto: 'café' }),
      tx(`Sí, tenemos ${PREFIJO}Café Americano a $45. ¿Te lo agrego?`)], { enviar: false });
    assert.equal((await estadoDe(T)).estado.pendiente?.tipo, 'aceptar_producto', r1.texto);
    // «sí» (a otra cosa) escrito mientras la oferta todavía no le llegaba...
    const wSi = wamid();
    await entrada(wSi);
    await new Promise((ok) => setTimeout(ok, 20));
    await registrarRespuestaEnviada(NEG_A, T, r1, msgOferta, `wamid.out.${++nWamid}`);
    const r2 = await turno(T, 'sí', sinModelo, { w: wSi });
    assert.deepEqual(lineasDe((await estadoDe(T)).estado), [],
      `un «sí» previo a la oferta agregó el producto: ${r2.texto}`);
    // Ya con la oferta a la vista (acusada por turno()), el «sí» de después sí la acepta.
    const wSi2 = wamid();
    await new Promise((ok) => setTimeout(ok, 20));
    await entrada(wSi2);
    await turno(T, 'sí', sinModelo, { w: wSi2 });
    assert.deepEqual(lineasDe((await estadoDe(T)).estado), [`1x${PREFIJO}Café Americano`]);
  });

  await t('01e «claro, y un licuado» escrito ANTES de la oferta: el licuado entra, el café ofrecido no', async () => {
    // El camino del modelo (mensaje no corto): la evidencia de la oferta sale
    // del pendiente, y un «sí» escrito antes de verla no la vale.
    const T = tel();
    const entrada = async (w) => {
      await pool.query('INSERT INTO whatsapp_conversaciones (negocio_id, telefono) VALUES ($1,$2) ON CONFLICT DO NOTHING', [NEG_A, T]);
      await pool.query(`INSERT INTO whatsapp_entradas (negocio_id, telefono, wamid, payload) VALUES ($1,$2,$3,'{}'::jsonb)`, [NEG_A, T, w]);
    };
    const msgOferta = '¿tienen café?';
    const r1 = await turno(T, msgOferta, [tu('buscar_producto', { texto: 'café' }),
      tx(`Sí, tenemos ${PREFIJO}Café Americano a $45. ¿Te lo agrego?`)], { enviar: false });
    assert.equal((await estadoDe(T)).estado.pendiente?.tipo, 'aceptar_producto', r1.texto);
    const w = wamid();
    await entrada(w);
    await new Promise((ok) => setTimeout(ok, 20));
    await registrarRespuestaEnviada(NEG_A, T, r1, msgOferta, `wamid.out.${++nWamid}`);
    // «claro, …» es una afirmación al inicio que el ejecutor reconoce (su
    // expresión no ve frontera de palabra después de «í», así que «sí, …» no
    // llega a esa capa).
    await turno(T, 'claro, y un licuado', [
      tus(['agregar_producto', { producto_id: String(ID.cafe), cantidad: 1 }]),
      ...buscarYAgregar('licuado'), tx('Va'),
    ], { w });
    const lineas = lineasDe((await estadoDe(T)).estado);
    assert.ok(!lineas.some((l) => l.includes('Café Americano')), `un «sí» previo a la oferta metió el café: ${lineas}`);
    assert.ok(lineas.some((l) => l.includes('Licuado')), `el licuado que sí nombró no entró: ${lineas}`);
  });

  // ═══ 2 · A DOMICILIO CON ZONA ═══════════════════════════════════════════
  await t('02 domicilio: dirección con respaldo, tarifa de zona y total registrado = total mostrado', async () => {
    const T = tel();
    const r1 = await turno(T, 'quiero unos chilaquiles verdes con pollo a domicilio en Hidalgo 340 colonia Centro, pago con tarjeta', [
      ...buscarYAgregar('chilaquiles', { opciones: [{ grupo: 'Salsa', opcion: 'Verde' }, { grupo: 'Proteína', opcion: 'Pollo' }] }),
      tu('definir_entrega', { modalidad: 'entrega a domicilio', direccion: 'Hidalgo 340 colonia Centro', zona_entrega: 'Centro' }),
      tu('definir_pago', { forma_pago: 'tarjeta' }),
      tx('¿Lo confirmo?'),
    ]);
    assert.match(r1.texto, /Envío: \$40/);
    assert.match(r1.texto, /Total: \$235/);
    const r2 = await turno(T, 'confirmo');
    const [p] = await pedidosDe(T);
    assert.ok(p, r2.texto);
    assert.equal(Number(p.datos.costo_envio), 40, 'el registro no conservó la tarifa de la zona');
    assert.equal(Number(p.datos.total), 235);
    assert.equal(p.datos.cliente.direccion, 'Hidalgo 340 colonia Centro');
  });

  // ═══ 3 + 4 · VARIOS PRODUCTOS Y CANTIDADES ══════════════════════════════
  await t('03-04 varios productos y cantidades mayores a uno', async () => {
    const T = tel();
    const r1 = await turno(T, 'dos cafés americanos y un waffle para recoger, efectivo', [
      ...buscarYAgregarVarios([{ texto: 'café americano', cantidad: 2 }, { texto: 'waffle' }]),
      entregaYPago({ modalidad: 'recoger en tienda' }, 'efectivo'),
      tx('Listo el resumen'),
    ]);
    assert.match(r1.texto, /¿Confirmas este pedido\?$/, await explicar(T));
    await turno(T, 'sí, confírmalo');
    const [p] = await pedidosDe(T);
    assert.ok(p, await explicar(T));
    assert.equal(Number(p.datos.total), 195);
    const cantidades = Object.fromEntries(p.datos.items.map((i) => [i.nombre, i.cantidad]));
    assert.deepEqual(cantidades, { [`${PREFIJO}Café Americano`]: 2, [`${PREFIJO}Waffle`]: 1 });
  });

  // ═══ 5 + 6 · OPCIONES OBLIGATORIAS Y RESPUESTAS CORTAS ══════════════════
  await t('05-06 opciones obligatorias: «la segunda», «pollo», «para recoger», «efectivo», «no», «sí»', async () => {
    const T = tel();
    const r1 = await turno(T, 'quiero unos chilaquiles', [...buscarYAgregar('chilaquiles'), tx('¿Qué salsa?')]);
    assert.match(r1.texto, /Salsa/);
    assert.equal((await estadoDe(T)).estado.pendiente?.tipo, 'elegir_opcion');
    const r2 = await turno(T, 'la segunda');
    assert.equal(r2.llamadasAlModelo, 0);
    let e = (await estadoDe(T)).estado;
    assert.ok(JSON.stringify(e.carrito.items[0].modificadores).includes('Roja'), 'la posición no eligió «Roja»');
    assert.equal(e.pendiente?.grupo, 'Proteína');
    await turno(T, 'pollo');
    e = (await estadoDe(T)).estado;
    assert.equal(e.pendiente?.tipo, 'modalidad');
    const r4 = await turno(T, 'para recoger');
    assert.equal(r4.llamadasAlModelo, 0);
    e = (await estadoDe(T)).estado;
    assert.equal(e.pendiente?.tipo, 'pago');
    assert.deepEqual(e.pendiente?.opciones, ['efectivo', 'terminal']);
    const r5 = await turno(T, 'efectivo');
    assert.equal(r5.llamadasAlModelo, 0);
    e = (await estadoDe(T)).estado;
    assert.equal(e.pendiente?.tipo, 'confirmar_resumen');
    const r6 = await turno(T, 'no');
    assert.equal(r6.llamadasAlModelo, 0);
    assert.match(r6.texto, /cambiar/);
    assert.equal((await pedidosDe(T)).length, 0, 'un «no» confirmó el pedido');
    e = (await estadoDe(T)).estado;
    assert.equal(e.pendiente, null);
    // Sin pregunta pendiente, un «sí» lo interpreta el modelo y no confirma solo.
    await turno(T, 'sí', [tx('¿Deseas confirmar tu pedido?')]);
    assert.equal((await pedidosDe(T)).length, 0);
    assert.equal((await estadoDe(T)).estado.pendiente?.tipo, 'confirmar_resumen');
    await turno(T, 'sí');
    assert.equal((await pedidosDe(T)).length, 1);
  });

  await t('06b respuestas cortas: «dos» y «esa» a un producto ofrecido, «sin eso» a una opción', async () => {
    const T = tel();
    const r1 = await turno(T, '¿tienen café?', [tu('buscar_producto', { texto: 'café' }),
      tx(`Sí, tenemos ${PREFIJO}Café Americano a $45. ¿Te lo agrego?`)]);
    assert.equal(r1.ok, true);
    assert.equal((await estadoDe(T)).estado.pendiente?.tipo, 'aceptar_producto');
    const r2 = await turno(T, 'dos');
    assert.equal(r2.llamadasAlModelo, 0);
    let e = (await estadoDe(T)).estado;
    assert.deepEqual(lineasDe(e), [`2x${PREFIJO}Café Americano`]);
    const T2 = tel();
    await turno(T2, '¿tienen licuado?', [tu('buscar_producto', { texto: 'licuado' }),
      tx(`Tenemos ${PREFIJO}Licuado a $60. ¿Lo quieres?`)]);
    await turno(T2, 'esa');
    e = (await estadoDe(T2)).estado;
    assert.deepEqual(lineasDe(e), [`1x${PREFIJO}Licuado`]);
    assert.equal(e.pendiente?.tipo, 'elegir_opcion');
    const r3 = await turno(T2, 'sin eso');
    assert.equal(r3.llamadasAlModelo, 0);
    e = (await estadoDe(T2)).estado;
    assert.ok(JSON.stringify(e.carrito.items[0].modificadores).includes('Sin endulzante'));
  });

  // ═══ 7 · CAMBIAR Y QUITAR ANTES DE CONFIRMAR ════════════════════════════
  await t('07 quitar y cambiar cantidad antes de confirmar: se confirma lo último que se mostró', async () => {
    const T = tel();
    await turno(T, 'un waffle y un café para recoger, efectivo', [
      ...buscarYAgregarVarios([{ texto: 'waffle' }, { texto: 'café' }]),
      entregaYPago({ modalidad: 'recoger en tienda' }, 'efectivo'),
      tx('Resumen'),
    ]);
    assert.equal((await estadoDe(T)).estado.pendiente?.tipo, 'confirmar_resumen', await explicar(T));
    const lid = (nombre) => async () => (await estadoDe(T)).estado.carrito.items.find((i) => i.nombre.includes(nombre)).lid;
    const lidCafe = await lid('Café')();
    await turno(T, 'quita el café', [tu('quitar_linea', { linea_id: lidCafe }), tx('Listo')]);
    const lidWaffle = await lid('Waffle')();
    await turno(T, 'mejor que sean dos waffles', [tu('modificar_linea', { linea_id: lidWaffle, cantidad: 2 }), tx('Hecho')]);
    const e = (await estadoDe(T)).estado;
    assert.deepEqual(lineasDe(e), [`2x${PREFIJO}Waffle`]);
    assert.equal(e.pendiente?.tipo, 'confirmar_resumen');
    await turno(T, 'sí');
    const [p] = await pedidosDe(T);
    assert.equal(Number(p.datos.total), 210);
    assert.equal(p.datos.items.length, 1);
  });

  // ═══ 8 + 27 · PROMOCIÓN → ACEPTACIÓN → OPCIONES → ENTREGA → PAGO → CONFIRMAR
  await t('08-27 promoción aceptada: 2 unidades por su tipo, opciones, domicilio, pago y folio con descuento', async () => {
    await desactivarPromos(NEG_A);
    await crearPromo(NEG_A, { nombre: '2x1 Chilaquiles', tipo: '2x1', productos: [ID.chilaquiles], cantidad: 2 });
    const T = tel();
    const r1 = await turno(T, '¿qué promociones tienen hoy?');
    assert.equal(r1.llamadasAlModelo, 0, 'las promociones no las contesta el modelo');
    assert.match(r1.texto, /2x1 Chilaquiles/);
    let e = (await estadoDe(T)).estado;
    assert.equal(e.pendiente?.tipo, 'aceptar_promocion');
    assert.equal(e.pendiente?.cantidad, 2);
    assert.equal(e.pendiente?.producto_id, String(ID.chilaquiles));
    await turno(T, 'sí');
    e = (await estadoDe(T)).estado;
    assert.deepEqual(lineasDe(e), [`2x${PREFIJO}Chilaquiles`], 'la aceptación no agregó la cantidad de la promoción');
    assert.equal(e.pendiente?.grupo, 'Salsa');
    await turno(T, 'verde');
    await turno(T, 'huevo');
    assert.equal((await estadoDe(T)).estado.pendiente?.tipo, 'modalidad');
    await turno(T, 'a domicilio');
    assert.equal((await estadoDe(T)).estado.pendiente?.tipo, 'direccion');
    await turno(T, 'Hidalgo 340 colonia Centro', [tu('definir_entrega', { direccion: 'Hidalgo 340 colonia Centro' }), tx('ok')]);
    assert.equal((await estadoDe(T)).estado.pendiente?.tipo, 'pago');
    const rR = await turno(T, 'efectivo');
    assert.equal((await estadoDe(T)).estado.pendiente?.tipo, 'confirmar_resumen');
    // El resumen que lee el cliente trae el total del MISMO motor que registra.
    assert.match(rR.texto, /Promoción CAN 2x1 Chilaquiles: -\$195\n/, rR.texto);
    assert.match(rR.texto, /\*Total: \$225\*\n¿Confirmas este pedido\?$/, rR.texto);
    const rF = await turno(T, 'sí');
    const [p] = await pedidosDe(T);
    assert.ok(p, rF.texto);
    assert.equal(Number(p.datos.subtotal), 390);
    assert.equal(Number(p.datos.descuento), 195, 'el 2x1 no se aplicó en el registro');
    assert.equal(Number(p.datos.total), 225);
    assert.ok((p.datos.promociones || []).some((x) => /2x1 Chilaquiles/.test(x.nombre)));
    assert.match(rF.texto, /\$225/);
    await desactivarPromos(NEG_A);
  });

  await t('08b la promoción expira entre el resumen y el «sí»: no se cobra más de lo mostrado', async () => {
    await crearPromo(NEG_A, { nombre: 'Waffle 50%', tipo: 'porcentaje', valor: 50, productos: [ID.waffle] });
    const T = tel();
    const r1 = await turno(T, 'un waffle para recoger, efectivo', [
      ...buscarYAgregar('waffle'), entregaYPago({ modalidad: 'recoger en tienda' }, 'efectivo'), tx('Resumen'),
    ]);
    assert.match(r1.texto, /\*Total: \$52\.5\*/, r1.texto);
    await desactivarPromos(NEG_A);
    const r2 = await turno(T, 'sí');
    assert.equal((await pedidosDe(T)).length, 0, 'se registró por más de lo que el cliente leyó');
    assert.match(r2.texto, /\*Total: \$105\*\n¿Confirmas este pedido\?$/, `no se volvió a mostrar el total real: ${r2.texto}`);
    await turno(T, 'sí');
    const [p] = await pedidosDe(T);
    assert.equal(Number(p?.datos?.total), 105, 'tras reconfirmar se registra el total que ahora sí leyó');
  });

  // ═══ 9 · RECHAZAR O IGNORAR UNA PROMOCIÓN ═══════════════════════════════
  await t('09 rechazar o ignorar la promoción no agrega nada de ella', async () => {
    await crearPromo(NEG_A, { nombre: 'Waffle 10%', tipo: 'porcentaje', valor: 10, productos: [ID.waffle] });
    const T = tel();
    await turno(T, '¿hay promociones?');
    let e = (await estadoDe(T)).estado;
    assert.equal(e.pendiente?.tipo, 'aceptar_promocion');
    assert.equal(e.pendiente?.cantidad, 1, 'un porcentaje no exige dos unidades');
    const r2 = await turno(T, 'no gracias');
    assert.equal(r2.llamadasAlModelo, 0);
    e = (await estadoDe(T)).estado;
    assert.equal(e.carrito.items.length, 0);
    assert.notEqual(e.pendiente?.tipo, 'aceptar_promocion');
    const T2 = tel();
    await turno(T2, '¿hay promociones?');
    await turno(T2, 'quiero un café', [...buscarYAgregar('café'), tx('Va')]);
    assert.deepEqual(lineasDe((await estadoDe(T2)).estado), [`1x${PREFIJO}Café Americano`]);
    await desactivarPromos(NEG_A);
  });

  await t('09c tres consultas de promociones seguidas no prometen una persona que nadie recibe', async () => {
    // Revisión adversarial del candidato: la oferta del atajo contaba como
    // repregunta sin avance y a la tercera salía «te paso con alguien»
    // desde un turno sin efectos (nadie avisado, nada durable).
    await desactivarPromos(NEG_A);
    await crearPromo(NEG_A, { nombre: 'Café 10%', tipo: 'porcentaje', valor: 10, productos: [ID.cafe] });
    const T = tel();
    for (let i = 1; i <= 4; i += 1) {
      const r = await turno(T, '¿qué promociones tienen?');
      assert.equal(r.llamadasAlModelo, 0, `consulta ${i}: la contestó el modelo`);
      assert.match(r.texto, /Café 10%/, `consulta ${i}: ${r.texto}`);
      assert.doesNotMatch(r.texto, /te paso con alguien|equipo/i, `consulta ${i} prometió una persona: ${r.texto}`);
      assert.ok(!r.escalado, `consulta ${i} marcó escalado`);
      assert.notEqual(r.handoffPendiente, true, `consulta ${i} dejó un handoff pendiente`);
    }
    const e = (await estadoDe(T)).estado;
    assert.equal(e.pendiente?.tipo, 'aceptar_promocion');
    assert.equal(e.pendiente?.intentos, 1, 'una respuesta de sistema no cuenta como repregunta');
    assert.ok(!e.hechos?.escalado);
    assert.equal(handoffs.filter((h) => h.telefono === T).length, 0);
    await desactivarPromos(NEG_A);
  });

  await t('09b una promoción de mañana se informa, pero un «sí» de hoy no la aplica', async () => {
    const manana = (hoyLocal.getDay() + 1) % 7;
    await guardarPromocion(NEG_A, { nombre: `${PREFIJO}Waffle de Mañana`, tipo: 'porcentaje', valor: 15,
      automatica: true, canales: ['whatsapp'], productos: [ID.waffle], diasSemana: [manana] });
    const T = tel();
    const r = await turno(T, '¿qué promociones tienen mañana?');
    assert.equal(r.llamadasAlModelo, 0);
    assert.match(r.texto, /Waffle de Mañana/, r.texto);
    assert.notEqual((await estadoDe(T)).estado.pendiente?.tipo, 'aceptar_promocion', 'se ofreció hoy una promoción de mañana');
    await turno(T, 'sí', [tx('¿Qué te gustaría pedir?')]);
    assert.equal((await estadoDe(T)).estado.carrito.items.length, 0, 'un «sí» metió hoy la promoción de mañana');
  });

  // ═══ 10 · 11 · 12 · PRODUCTOS INTERNOS Y CATEGORÍAS VACÍAS ══════════════
  await t('10-12 internos: no se listan, no entran por nombre ni por id, EXTRAS no aparece', async () => {
    const T = tel();
    let busqueda = null;
    let categorias = null;
    await turno(T, 'quiero ver el menú', [
      tu('buscar_producto', { texto: '' }),
      (p) => { categorias = ultimoResultado(p); return tu('buscar_producto', { texto: 'pieza de hotcake' }); },
      (p) => { busqueda = ultimoResultado(p); return tu('agregar_producto', { producto_id: String(ID.pieza), cantidad: 1 }); },
      tu('agregar_producto', { producto_id: String(ID.extraHuevo), cantidad: 1 }),
      tx('Tenemos varias opciones'),
    ]);
    const nombresCat = JSON.stringify(categorias);
    assert.match(nombresCat, /Desayunos/);
    assert.doesNotMatch(nombresCat, /EXTRAS/, 'una categoría sin publicados apareció');
    assert.doesNotMatch(JSON.stringify(busqueda), /Pieza de Hotcake/, 'la búsqueda devolvió un artículo interno');
    const e = (await estadoDe(T)).estado;
    assert.equal(e.carrito.items.length, 0, 'un artículo interno entró al carrito por id');
    const rechazos = (await turnosDe(T))[0].rechazos.map((r) => r.herramienta);
    assert.ok(rechazos.filter((h) => h === 'agregar_producto').length === 2, 'los dos intentos no quedaron trazados como rechazo');
    // Y la prosa del modelo que nombra un artículo interno no sale.
    const T2 = tel();
    const r = await turno(T2, '¿qué más venden?', [tx(`También tenemos ${PREFIJO}Pieza de Hotcake a $55.`)]);
    assert.doesNotMatch(r.texto, /Pieza de Hotcake/);
    assert.match(String(r.recuperacion), /redaccion_sustituida:producto_no_publicado/);
    // La puerta final: una orden del agente con el artículo interno se rechaza.
    const estado = estadoNuevo({ negocioId: NEG_A, conversacionId: 'agente:puerta-interna' });
    estado.carrito = { items: [{ lid: 'x', nombre: `${PREFIJO}Pieza de Hotcake`, cantidad: 1, modificadores: [] }],
      datos: { modalidad: 'recoger en tienda', forma_pago: 'efectivo', cliente: { telefono: '5281991199' } } };
    const puerta = await confirmarYEmitir({ negocioId: NEG_A, telefono: '5281991199', nombre: 'X', canal: 'whatsapp',
      estado, pedido: { total: 55 }, registrar: registrarPedido, emitir: async () => {}, guardar: async () => {} });
    assert.equal(puerta.ok, false, 'la puerta final registró un artículo interno');
  });

  // ═══ 13 · PROMOCIÓN SOBRE PRODUCTOS OCULTOS ═════════════════════════════
  await t('13 una promoción que apunta a un producto oculto no se informa ni se ofrece', async () => {
    await crearPromo(NEG_A, { nombre: 'Promo Pieza', tipo: '2x1', productos: [ID.pieza], cantidad: 2 });
    const T = tel();
    const r = await turno(T, '¿qué promociones tienen?');
    assert.doesNotMatch(r.texto, /Promo Pieza|Pieza de Hotcake/);
    assert.equal((await estadoDe(T)).estado.pendiente, null);
    await desactivarPromos(NEG_A);
  });

  // ═══ 14 · FUERA DE HORARIO ══════════════════════════════════════════════
  await t('14 fuera de horario: aviso del backend, sin modelo y sin pedido', async () => {
    const T = tel();
    const r = await turno(T, 'quiero un waffle', sinModelo, { negocio: NEG_CERRADO });
    assert.equal(r.ok, true);
    assert.equal(r.fueraHorario, true);
    assert.equal(r.llamadasAlModelo, 0);
    assert.equal((await pedidosDe(T, NEG_CERRADO)).length, 0);
    assert.equal((await estadoDe(T, NEG_CERRADO)).estado.carrito.items.length, 0);
  });

  // ═══ 15 · PEDIDO FUTURO VÁLIDO E INVÁLIDO ═══════════════════════════════
  const fechaLocal = (dias) => {
    const d = new Date(hoyLocal); d.setDate(d.getDate() + dias);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  await t('15 futuro válido: fecha y hora validadas y persistidas → reserva programada, no pedido de hoy', async () => {
    const T = tel();
    const r1 = await turno(T, 'quiero un waffle para mañana a las 10 de la mañana, para recoger, efectivo', [
      ...buscarYAgregar('waffle'),
      tus(['programar_para', { fecha: fechaLocal(1), hora: '10:00' }],
        ['definir_entrega', { modalidad: 'recoger en tienda' }], ['definir_pago', { forma_pago: 'efectivo' }]),
      tx('Resumen'),
    ]);
    const e = (await estadoDe(T)).estado;
    assert.ok(e.carrito.datos.programado_para, `la fecha validada no quedó persistida: ${await explicar(T)}`);
    assert.match(r1.texto, /¿Confirmas este pedido\?$/, r1.texto);
    await turno(T, 'sí');
    const pedidos = await pedidosDe(T);
    assert.equal(pedidos.length, 1, await explicar(T));
    assert.equal(pedidos[0].estado, 'programado', 'el pedido de mañana entró como pedido de hoy');
    assert.equal(new Date(pedidos[0].datos.programado_para).getTime(), new Date(e.carrito.datos.programado_para).getTime(),
      'la reserva no es la fecha que Xabor validó');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM pedidos_activos WHERE negocio_id=$1
      AND datos->'cliente'->>'telefono'=$2`, [NEG_A, T])).rows[0].n, 0, 'la reserva también entró a la cocina de hoy');
  });
  await t('15b futuro inválido (día cerrado): Xabor lo rechaza por el horario y no se confirma', async () => {
    const T = tel();
    const dia = DIAS.indexOf(diaCerrado);
    const dentro = ((dia - hoyLocal.getDay()) + 7) % 7 || 7;
    await turno(T, `quiero un waffle para el ${diaCerrado} a las 10 de la mañana, para recoger, efectivo`, [
      ...buscarYAgregar('waffle'),
      tus(['programar_para', { fecha: fechaLocal(dentro), hora: '10:00' }],
        ['definir_entrega', { modalidad: 'recoger en tienda' }], ['definir_pago', { forma_pago: 'efectivo' }]),
      tx('Ese día estamos cerrados'),
    ]);
    const [traza] = await turnosDe(T);
    const rechazo = traza.rechazos.find((r) => r.herramienta === 'programar_para');
    assert.match(String(rechazo?.motivo), /^cerrado_ese_dia/, `rechazada por otra razón: ${await explicar(T)}`);
    const e = (await estadoDe(T)).estado;
    assert.equal(e.carrito.datos.programado_para ?? null, null, 'se programó un día cerrado');
    assert.equal(e.fase, 'definiendo_entrega');
    await turno(T, 'sí', [tx('¿Para qué día lo quieres?')]);
    assert.equal((await pedidosDe(T)).length, 0, 'se confirmó un pedido futuro sin fecha válida');
  });

  // ═══ 16 · CATERING → PERSONA ════════════════════════════════════════════
  await t('16 catering: recopila los datos en dos turnos y entrega a una persona, sin pedido', async () => {
    const T = tel();
    const antes = handoffs.length;
    await turno(T, 'quiero cotizar un catering para 50 personas', [
      tu('registrar_solicitud_evento', { personas: 50 }), tx('¿A nombre de quién, dónde y cuándo es el evento?'),
    ]);
    let e = (await estadoDe(T)).estado;
    assert.equal(e.fase, 'capturando_evento', await explicar(T));
    assert.equal(handoffs.length, antes, 'se entregó el caso con la ficha incompleta');
    // La ficha se llena de a un dato por respuesta (varios datos juntos se
    // repreguntan: evidenciaCatering.js). El nombre llega del perfil del canal.
    let resultado = null;
    await turno(T, 'en el Salón Jardín', [
      tu('registrar_solicitud_evento', { lugar: 'Salón Jardín' }),
      (p) => { resultado = ultimoResultado(p); return tx('¿Qué día y a qué hora?'); },
    ]);
    assert.deepEqual(resultado?.faltan, ['fecha_hora'], JSON.stringify(resultado));
    assert.equal(handoffs.length, antes, 'se entregó el caso con la ficha incompleta');
    await turno(T, 'el sábado 10 de octubre a las 2 de la tarde', [
      tu('registrar_solicitud_evento', { fecha_hora: 'sábado 10 de octubre a las 2 de la tarde' }),
      (p) => { resultado = ultimoResultado(p); return tx('Listo'); },
    ]);
    e = (await estadoDe(T)).estado;
    assert.equal(e.fase, 'requiere_humano', JSON.stringify(resultado));
    assert.ok(handoffs.slice(antes).some((h) => h.motivo === 'SOLICITUD_EVENTO'), 'no se avisó a una persona');
    assert.equal(e.handoff?.evento?.personas, 50, 'la transferencia no conservó los datos recopilados');
    assert.equal((await pedidosDe(T)).length, 0);
    const tipos = (await outboxDe(T)).map((o) => o.tipo);
    assert.ok(tipos.includes('solicitud_evento'), 'el evento no quedó en el outbox');
    assert.ok(tipos.includes('handoff'), 'la transferencia no quedó en el outbox');
  });
  await t('16b catering: un intento de cotizar no sale; la captura sigue y no se entrega a medias', async () => {
    const T = tel();
    const antes = handoffs.length;
    const r = await turno(T, 'quiero un catering para 30 personas', [
      tu('registrar_solicitud_evento', { personas: 30 }), tx('Para 30 personas te sale en $4500, ¿te lo aparto?'),
    ]);
    assert.equal(r.ok, true, r.motivo);
    assert.doesNotMatch(r.texto, /4500|aparto/, 'la cotización del modelo salió al cliente');
    assert.equal((await estadoDe(T)).estado.fase, 'capturando_evento', await explicar(T));
    assert.equal(handoffs.length, antes, 'la captura se cortó y se entregó incompleta');
    const todo = (await outboxDe(T)).map((o) => JSON.stringify(o.carga)).join(' ');
    assert.doesNotMatch(todo, /4500/, 'la cotización quedó en el outbox');
    assert.equal((await pedidosDe(T)).length, 0);
  });

  // ═══ 17 · EL MISMO WAMID DOS VECES ══════════════════════════════════════
  await t('17 mismo wamid: el lote aplicado no se re-ejecuta ni duplica el producto', async () => {
    const T = tel();
    const w = wamid();
    const r1 = await turno(T, 'un café para recoger', [...buscarYAgregar('café'), tx('Va')], { w });
    const v1 = Number((await estadoDe(T)).revision);
    const r2 = await turno(T, 'un café para recoger', [...buscarYAgregar('café'), tx('Va')], { w });
    assert.equal(r2.repetido, true);
    assert.equal(r2.yaEntregado, true);
    assert.equal(r2.texto, r1.texto);
    const fila = await estadoDe(T);
    assert.equal(Number(fila.revision), v1, 'la reentrega escribió el estado');
    assert.deepEqual(lineasDe(fila.estado), [`1x${PREFIJO}Café Americano`]);
    assert.equal((await turnosDe(T)).length, 1);
    assert.equal((await outboxDe(T)).filter((o) => o.tipo === 'respuesta_cliente').length, 1);
  });

  // ═══ 18 · MENSAJES CONCURRENTES SOBRE LA MISMA CONVERSACIÓN ═════════════
  await t('18 dos turnos a la vez: conflicto de versión detectado, sin pérdida ni duplicado', async () => {
    const T = tel();
    const agregaTras = (texto, esperaMs) => async (payload) => {
      const r = ultimoResultado(payload);
      if (!r) { await new Promise((ok) => setTimeout(ok, esperaMs)); return tu('buscar_producto', { texto }); }
      if (r.encontrados) return tu('agregar_producto', { producto_id: String(r.encontrados[0].producto_id), cantidad: 1 });
      return tx('Agregado');
    };
    // Los dos turnos van SIN el acuse simulado del transporte: ese acuse también
    // sube la versión, y si cae entre la relectura y el commit del reintento del
    // otro turno, este choca dos veces (carrera del arnés: en el canal real los
    // turnos de una conversación van en fila bajo el candado de continuidad y
    // el acuse ocurre dentro de él). Lo que se prueba aquí es el conflicto de
    // versión entre los dos TURNOS: sin pérdida ni duplicado.
    // (a) La conversación NACE en paralelo: el INSERT de uno gana y el otro repite.
    const [a, b] = await Promise.all([
      turno(T, 'un waffle', agregaTras('waffle', 150), { enviar: false }),
      turno(T, 'un café', agregaTras('café', 150), { enviar: false }),
    ]);
    assert.equal(a.ok && b.ok, true, `${a.motivo || ''} ${b.motivo || ''}`);
    let fila = await estadoDe(T);
    assert.deepEqual(lineasDe(fila.estado), [`1x${PREFIJO}Café Americano`, `1x${PREFIJO}Waffle`],
      `se perdió o duplicó un renglón: ${JSON.stringify(lineasDe(fila.estado))}`);
    assert.equal((await turnosDe(T)).length, 2);
    // (b) Conversación YA existente: los dos leen la misma revisión y el
    // UPDATE del segundo tiene que detectar que la fila cambió.
    const T2 = tel();
    await turno(T2, 'un waffle', [...buscarYAgregar('waffle'), tx('Va')]);
    const [c, d] = await Promise.all([
      turno(T2, 'y un café', agregaTras('café', 150), { enviar: false }),
      turno(T2, 'y unos chilaquiles', agregaTras('chilaquiles', 150), { enviar: false }),
    ]);
    assert.equal(c.ok && d.ok, true, `${c.motivo || ''} ${d.motivo || ''}`);
    fila = await estadoDe(T2);
    assert.deepEqual(lineasDe(fila.estado),
      [`1x${PREFIJO}Café Americano`, `1x${PREFIJO}Chilaquiles`, `1x${PREFIJO}Waffle`],
      `una escritura concurrente pisó a la otra: ${JSON.stringify(lineasDe(fila.estado))}`);
    assert.equal((await turnosDe(T2)).length, 3);
  });

  // ═══ 19 · REINTENTO DEL OUTBOX ══════════════════════════════════════════
  await t('19 outbox: respuesta comprometida sin enviar se entrega UNA vez y habilita la confirmación', async () => {
    const T = tel();
    await turno(T, 'un waffle para recoger, efectivo', [
      ...buscarYAgregar('waffle'), tu('definir_entrega', { modalidad: 'recoger en tienda' }),
      tu('definir_pago', { forma_pago: 'efectivo' }), tx('Resumen'),
    ], { enviar: false });
    let [salida] = (await outboxDe(T)).filter((o) => o.tipo === 'respuesta_cliente');
    assert.equal(salida.estado, 'pendiente');
    assert.equal((await estadoDe(T)).estado.dialogo.enviado, false);
    await pool.query(`UPDATE agente_outbox SET disponible_at = now() WHERE negocio_id=$1 AND conversacion_id=$2`,
      [NEG_A, `agente:${T}`]);
    const enviados = [];
    let falla = true;
    const enviar = async ({ telefono, texto }) => {
      if (telefono !== T) return `wamid.otro.${enviados.length}`;
      // Un rechazo CONFIRMADO de Meta (así lanza `enviarMensaje` ante un HTTP
      // de error): se puede reintentar. Un error de resultado incierto no.
      if (falla) { falla = false; throw new Error('Meta API: {"error":{"code":503,"message":"Service Unavailable"}}'); }
      enviados.push(texto);
      return `wamid.despacho.${enviados.length}`;
    };
    await despacharRespuestasPendientes({ enviar });
    [salida] = (await outboxDe(T)).filter((o) => o.tipo === 'respuesta_cliente');
    assert.equal(salida.estado, 'pendiente', 'un rechazo confirmado de Meta descartó la respuesta');
    assert.equal(Number(salida.intentos), 1);
    await pool.query(`UPDATE agente_outbox SET disponible_at = now() WHERE negocio_id=$1 AND conversacion_id=$2`,
      [NEG_A, `agente:${T}`]);
    await despacharRespuestasPendientes({ enviar });
    await pool.query(`UPDATE agente_outbox SET disponible_at = now() WHERE negocio_id=$1 AND conversacion_id=$2`,
      [NEG_A, `agente:${T}`]);
    await despacharRespuestasPendientes({ enviar });
    assert.equal(enviados.length, 1, `se envió ${enviados.length} veces`);
    [salida] = (await outboxDe(T)).filter((o) => o.tipo === 'respuesta_cliente');
    assert.equal(salida.estado, 'entregado');
    assert.equal((await estadoDe(T)).estado.dialogo.enviado, true, 'el despacho no acusó el diálogo');
    await turno(T, 'sí');
    assert.equal((await pedidosDe(T)).length, 1);
  });
  await t('19b un «sí» a un resumen que Meta nunca aceptó no confirma nada', async () => {
    const T = tel();
    await turno(T, 'un waffle para recoger, efectivo', [
      ...buscarYAgregar('waffle'), entregaYPago({ modalidad: 'recoger en tienda' }, 'efectivo'), tx('Resumen'),
    ], { enviar: false });
    assert.equal((await estadoDe(T)).estado.pendiente?.tipo, 'confirmar_resumen');
    await turno(T, 'sí', [tx('Te muestro otra vez tu pedido')]);
    assert.equal((await pedidosDe(T)).length, 0, 'se confirmó un resumen que el cliente no recibió');
    const confirmadas = (await operacionesDe(T)).filter((o) => o.herramienta === 'confirmar_pedido' && o.aplicada);
    assert.equal(confirmadas.length, 0);
  });

  // ═══ 20 · REINICIO / CAÍDA A MITAD DEL TURNO ════════════════════════════
  await t('20 caída antes del commit: nada queda a medias; el reintento aplica UNA vez', async () => {
    const T = tel();
    await turno(T, 'un waffle', [...buscarYAgregar('waffle'), tx('Va')]);
    const antes = await estadoDe(T);
    const opsAntes = (await operacionesDe(T)).length;
    const w = wamid();
    const dbQueCae = { query: (...a) => pool.query(...a), connect: async () => { throw new Error('proceso reiniciado'); } };
    const caido = await turno(T, 'y un café', [...buscarYAgregar('café'), tx('Va')], { w, db: dbQueCae, enviar: false });
    assert.equal(caido.ok, false);
    const despues = await estadoDe(T);
    assert.equal(Number(despues.revision), Number(antes.revision), 'la caída escribió el estado');
    assert.deepEqual(lineasDe(despues.estado), [`1x${PREFIJO}Waffle`]);
    assert.equal((await operacionesDe(T)).length, opsAntes, 'quedaron operaciones internas sin estado');
    assert.equal((await turnosDe(T)).length, 1);
    // El mismo lote, ya con el proceso sano, se aplica una sola vez.
    await turno(T, 'y un café', [...buscarYAgregar('café'), tx('Va')], { w });
    await turno(T, 'y un café', [...buscarYAgregar('café'), tx('Va')], { w });
    assert.deepEqual(lineasDe((await estadoDe(T)).estado), [`1x${PREFIJO}Café Americano`, `1x${PREFIJO}Waffle`]);
  });

  // ═══ 21 · CONFIRMACIÓN REPETIDA ═════════════════════════════════════════
  await t('21 confirmación repetida (otro «sí», la misma reentrega): un solo folio', async () => {
    const T = tel();
    await turno(T, 'un café para recoger, efectivo', [
      ...buscarYAgregar('café'), tu('definir_entrega', { modalidad: 'recoger en tienda' }),
      tu('definir_pago', { forma_pago: 'efectivo' }), tx('Resumen'),
    ]);
    const w = wamid();
    await turno(T, 'sí', sinModelo, { w });
    await turno(T, 'sí', sinModelo, { w });
    await turno(T, 'sí, confírmalo', [tx('Tu pedido ya está confirmado')]);
    assert.equal((await pedidosDe(T)).length, 1);
  });

  // ═══ 22 · CANCELAR ANTES DE CONFIRMAR ═══════════════════════════════════
  await t('22 cancelar antes de confirmar: sin pedido, fase cancelado', async () => {
    const T = tel();
    await turno(T, 'un waffle para recoger, efectivo', [
      ...buscarYAgregar('waffle'), tu('definir_entrega', { modalidad: 'recoger en tienda' }),
      tu('definir_pago', { forma_pago: 'efectivo' }), tx('Resumen'),
    ]);
    await turno(T, 'mejor ya no, cancélalo todo', [tu('cancelar_pedido', { motivo: 'ya no lo quiere' }), tx('Cancelado')]);
    const e = (await estadoDe(T)).estado;
    assert.equal(e.fase, 'cancelado');
    assert.equal(e.carrito.items.length, 0);
    assert.equal((await pedidosDe(T)).length, 0);
  });

  // ═══ 23 · MODIFICACIÓN DESPUÉS DE PEDIR CONFIRMACIÓN ════════════════════
  await t('23 cambio tras el resumen: la huella vieja ya no confirma; se confirma lo nuevo', async () => {
    const T = tel();
    await turno(T, 'un waffle para recoger, efectivo', [
      ...buscarYAgregar('waffle'), tu('definir_entrega', { modalidad: 'recoger en tienda' }),
      tu('definir_pago', { forma_pago: 'efectivo' }), tx('Resumen'),
    ]);
    const huellaVieja = (await estadoDe(T)).estado.pendiente.huella;
    await turno(T, 'agrégale un café', [...buscarYAgregar('café'), tx('Listo')]);
    const e = (await estadoDe(T)).estado;
    assert.notEqual(e.pendiente.huella, huellaVieja);
    const r = await turno(T, 'sí', [tu('confirmar_pedido', { huella_resumen: huellaVieja })]);
    assert.equal(r.llamadasAlModelo, 0, 'el «sí» debía resolverse contra el resumen nuevo');
    const [p] = await pedidosDe(T);
    assert.equal(p.datos.items.length, 2, 'se confirmó el resumen viejo');
    assert.equal(Number(p.datos.total), 150);
  });

  await t('23b «agrégale un café y confírmalo»: se agrega, pero no se confirma un resumen que no vio', async () => {
    const T = tel();
    await turno(T, 'un waffle para recoger, efectivo', [
      ...buscarYAgregar('waffle'), entregaYPago({ modalidad: 'recoger en tienda' }, 'efectivo'), tx('Resumen'),
    ]);
    const huellaVista = (await estadoDe(T)).estado.pendiente.huella;
    const r = await turno(T, 'agrégale un café y confírmalo', [
      ...buscarYAgregar('café'), tu('confirmar_pedido', { huella_resumen: huellaVista }), tx('¡Listo, confirmado!'),
    ]);
    assert.equal((await pedidosDe(T)).length, 0, 'se confirmó un pedido cuyo resumen el cliente no vio');
    const e = (await estadoDe(T)).estado;
    assert.deepEqual(lineasDe(e), [`1xCAN Café Americano`, `1xCAN Waffle`]);
    assert.equal(e.pendiente?.tipo, 'confirmar_resumen');
    assert.notEqual(e.pendiente.huella, huellaVista);
    assert.doesNotMatch(r.texto, /confirmado/i, 'el cliente leyó «confirmado» sin pedido');
    assert.match(r.texto, /¿Confirmas este pedido\?$/);
  });

  // ═══ 24 · SALIDA TRUNCADA O CON NOMBRES DE HERRAMIENTAS ═════════════════
  await t('24 salida truncada y con nombres de herramientas: se sustituye, el carrito no cambia', async () => {
    const T = tel();
    await turno(T, 'un waffle', [...buscarYAgregar('waffle'), tx('Va')]);
    const r1 = await turno(T, 'y qué más tienen', [
      { stop_reason: 'max_tokens', content: [{ type: 'text', text: '<ORDEN_PREVIEW>{"total":' }] },
      { stop_reason: 'max_tokens', content: [{ type: 'text', text: '<ORDEN_PREVIEW>{"total":' }] },
    ]);
    assert.doesNotMatch(r1.texto, /ORDEN_PREVIEW|total"/);
    assert.equal(r1.recuperacion, 'fallo_proveedor_sin_efectos');
    const r2 = await turno(T, 'algo para tomar', [tx('Usa buscar_producto y agregar_producto para eso.')]);
    assert.doesNotMatch(r2.texto, /buscar_producto|agregar_producto/);
    assert.deepEqual(lineasDe((await estadoDe(T)).estado), [`1x${PREFIJO}Waffle`]);
    assert.equal((await estadoDe(T)).estado.hechos.fallido, false);
    // Sin pedido en curso la prosa del modelo SÍ saldría: aquí la única
    // barrera es la emisión segura.
    const T2 = tel();
    const r3 = await turno(T2, '¿qué me recomiendas?', [tx('Usa buscar_producto para ver el menú.')]);
    assert.doesNotMatch(r3.texto, /buscar_producto/, 'salió el nombre de una herramienta');
    assert.match(String(r3.recuperacion), /^redaccion_sustituida:/);
    const T3 = tel();
    const r4 = await turno(T3, '¿cuánto cuesta el waffle?', [tx('El CAN Waffle cuesta $99.')]);
    assert.doesNotMatch(r4.texto, /\$99/, 'salió un precio inventado');
    assert.match(String(r4.recuperacion), /^redaccion_sustituida:/);
  });

  // ═══ 25 · ERROR DEL PROVEEDOR DE IA ═════════════════════════════════════
  await t('25 error del proveedor: carrito íntegro, sin «fallido», contador se reinicia al sanar', async () => {
    const T = tel();
    await turno(T, 'un waffle', [...buscarYAgregar('waffle'), tx('Va')]);
    const r = await turno(T, 'y un café', async () => { throw Object.assign(new Error('Overloaded'), { status: 529 }); });
    assert.equal(r.ok, true);
    let e = (await estadoDe(T)).estado;
    assert.deepEqual(lineasDe(e), [`1x${PREFIJO}Waffle`]);
    assert.equal(e.hechos.fallido, false);
    assert.equal(e.fallosProveedor, 1);
    await turno(T, 'y un café', [...buscarYAgregar('café'), tx('Va')]);
    e = (await estadoDe(T)).estado;
    assert.equal(e.fallosProveedor, 0);
    assert.deepEqual(lineasDe(e), [`1x${PREFIJO}Café Americano`, `1x${PREFIJO}Waffle`]);
  });

  // ═══ 26 · AISLAMIENTO ENTRE NEGOCIOS ════════════════════════════════════
  await t('26 aislamiento: el mismo teléfono en dos negocios; un id del otro negocio no existe', async () => {
    const T = tel();
    await turno(T, 'quiero una pizza', [tu('agregar_producto', { producto_id: String(ID_B.pizza), cantidad: 1 }), tx('?')]);
    assert.equal((await estadoDe(T)).estado.carrito.items.length, 0, 'entró un producto de otro negocio');
    await turno(T, 'quiero una pizza margarita', [...buscarYAgregar('pizza margarita'), tx('Va')], { negocio: NEG_B });
    assert.deepEqual(lineasDe((await estadoDe(T, NEG_B)).estado), [`1x${PREFIJO}Pizza Margarita`]);
    assert.equal((await estadoDe(T)).estado.carrito.items.length, 0, 'el estado de un negocio contaminó al otro');
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM whatsapp_productos wp JOIN menu_productos p
      ON p.id = wp.producto_id WHERE p.negocio_id IS DISTINCT FROM wp.negocio_id`);
    assert.equal(rows[0].n, 0);
  });
} finally {
  // ── Limpieza de lo que ESTA ejecución creó ──────────────────────────────
  for (const n of negocios) {
    for (const sql of [
      'DELETE FROM agente_turnos WHERE negocio_id=$1', 'DELETE FROM agente_outbox WHERE negocio_id=$1',
      'DELETE FROM agente_operaciones WHERE negocio_id=$1', 'DELETE FROM conversacion_estado WHERE negocio_id=$1',
      'DELETE FROM pedidos_programados WHERE negocio_id=$1', 'DELETE FROM pedido_emisiones WHERE negocio_id=$1',
      'DELETE FROM pedidos_activos WHERE negocio_id=$1', 'DELETE FROM whatsapp_productos WHERE negocio_id=$1',
      'DELETE FROM tienda_promociones WHERE negocio_id=$1', 'DELETE FROM tienda_config WHERE negocio_id=$1',
      'DELETE FROM whatsapp_entradas WHERE negocio_id=$1', 'DELETE FROM whatsapp_conversaciones WHERE negocio_id=$1',
      'DELETE FROM metodos_pago WHERE negocio_id=$1', 'DELETE FROM menu_modificadores_opciones WHERE negocio_id=$1',
      'DELETE FROM menu_modificadores_grupos WHERE negocio_id=$1', 'DELETE FROM menu_productos WHERE negocio_id=$1',
      'DELETE FROM menu_categorias WHERE negocio_id=$1', 'DELETE FROM configuracion WHERE negocio_id=$1',
      'DELETE FROM negocio_modulos WHERE negocio_id=$1',
    ]) await pool.query(sql, [n]).catch(() => {});
  }
  await pool.end().catch(() => {});
}

console.log(`\n${'─'.repeat(70)}`);
console.log(`${pasadas} pasadas, ${fallos.length} fallidas de ${pasadas + fallos.length}`);
for (const f of fallos) console.log(`  · ${f}`);
process.exit(fallos.length ? 1 : 0);
