// ─── Motor de promociones de Xabor ────────────────────────────────────────
//
// El navegador NUNCA decide un descuento: manda a lo sumo un código y el
// servidor decide si aplica, cuánto y en qué orden. Todo cálculo vive aquí.
//
// Multiempresa por diseño: cada promoción pertenece a un negocio y el código
// es único POR NEGOCIO (índice idx_promo_negocio_codigo). Dos restaurantes
// pueden tener "SOFIA15" con reglas distintas sin verse entre sí.
//
// Reutilizable: el motor recibe un contexto neutro (subtotal, items, canal,
// modalidad, cliente) y no sabe nada de HTTP ni de la tienda. Cuando otro
// canal quiera promociones, se le pasa `canal: 'whatsapp'` y funciona.
import { randomUUID } from 'crypto';
import { pool, calcularVersionPedidoHash } from './database.js';
import { partesEnZona } from './tiendaOnline.js';
import { cargarGruposDeProductos } from './modificadores.js';
import { resolverCuandoPromo } from './fechaPromos.js';

// Inyeccion de fallo, mismo candado de produccion que el resto del proyecto:
// inerte salvo en pruebas. Sirve para demostrar que un fallo de base en la
// atribucion NO deja el checkout dandose por terminado.
// Retardo inyectable: abre a proposito la ventana entre calcular y reclamar,
// que es donde otro cliente puede llevarse el ultimo cupo. Sin esto la carrera
// dura microsegundos y no se puede probar de verdad.
async function retardoInyectado(punto) {
  if (process.env.NODE_ENV === 'production') return;
  if (process.env.XABOR_TIENDA_RETARDO_EN !== punto) return;
  const ms = Number(process.env.XABOR_TIENDA_RETARDO_MS) || 0;
  if (ms > 0) await new Promise(r => setTimeout(r, ms));
}

function fallaInyectada(punto) {
  if (process.env.NODE_ENV === 'production') return;
  if (process.env.XABOR_TIENDA_FALLA_EN !== punto) return;
  const e = new Error(`Fallo inyectado en '${punto}' (prueba de atribucion)`);
  e.inyectado = true;
  throw e;
}

export class PromocionError extends Error {
  constructor(mensaje, codigo) { super(mensaje); this.codigo = codigo; }
}

const dinero = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── ¿Este cliente YA COMPRO de verdad? ────────────────────────────────────
//
// "Primera compra" es primera COMPRA, no primer intento. Antes esto preguntaba
// si existia cualquier fila en `pedidos_activos` con ese telefono, y eso hacia
// viejo a un cliente que solo habia llegado al checkout: pedia el cupon, no
// pagaba, el pedido vencia, la reserva se liberaba correctamente... y al
// volver Xabor le decia "esta promocion es solo para la primera compra".
// Devolviamos el cupo pero no la elegibilidad.
//
// LA FUENTE: `compras_reales`, el ledger de la 058.
//
// Deducirlo de `pedidos` menos lo que `pedidos_activos` desmiente tenia un
// agujero real: en cuanto un pedido cancelado por falta de pago se PURGA del
// tablero, su fila historica vuelve a parecer una compra y el cliente pierde
// su promocion sin haber comprado nunca. La correlacion solo funcionaba
// mientras la fila viviera en el tablero -- justo la parte efimera.
//
// El ledger no correlaciona nada: la marca se escribe en el momento en que la
// compra ocurre, dentro de la misma transaccion que el dinero (pago en linea /
// transferencia) o al entrar la comanda a operacion (efectivo / terminal /
// pago al recibir). Sobrevive al archivado, a la purga y al reinicio.
//
// PAGO REAL != COMPRA REAL: un cobro tardio sobre un pedido vencido, o de una
// version vieja, se asienta como dinero pero nunca llega a marcarse aqui.
//
// Tenant-scoped siempre: el mismo telefono en otro negocio es otro cliente.
export async function clienteYaComproDeVerdad(negocioId, telefono) {
  if (!negocioId || !telefono) return false;
  const { rows: [r] } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM compras_reales
        WHERE negocio_id = $1 AND cliente_telefono = $2
     ) AS ya`,
    [negocioId, telefono]);
  return r?.ya === true;
}

// ── Elegibilidad de UNA promoción ─────────────────────────────────────────
// Devuelve null si aplica, o un motivo legible si no. El motivo solo se le
// muestra al cliente cuando escribió un código explícitamente; las
// automáticas fallan en silencio.
function motivoNoAplica(promo, ctx) {
  if (!promo.activa) return 'Esta promoción ya no está disponible';

  const canales = Array.isArray(promo.canales) ? promo.canales : ['tienda_online'];
  if (!canales.includes(ctx.canal)) return 'Este código no aplica en esta tienda';

  if (Array.isArray(promo.modalidades) && promo.modalidades.length &&
      !promo.modalidades.includes(ctx.modalidad)) {
    return promo.modalidades.includes('domicilio')
      ? 'Este código solo aplica en pedidos a domicilio'
      : 'Este código solo aplica en pedidos para recoger';
  }

  const ahora = ctx.ahora || new Date();
  if (promo.vigencia_desde && ahora < new Date(promo.vigencia_desde)) return 'Esta promoción aún no comienza';
  if (promo.vigencia_hasta && ahora > new Date(promo.vigencia_hasta)) return 'Esta promoción ya venció';

  // Día y hora se evalúan en la zona horaria del negocio, no del navegador.
  const { diaSemana, minutos } = partesEnZona(ahora, ctx.timezone);
  if (Array.isArray(promo.dias_semana) && promo.dias_semana.length &&
      !promo.dias_semana.map(Number).includes(diaSemana)) {
    return 'Esta promoción no aplica hoy';
  }
  const aMin = (t) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const ini = aMin(promo.hora_inicio), fin = aMin(promo.hora_fin);
  if (ini !== null && fin !== null && (minutos < ini || minutos >= fin)) {
    return `Esta promoción aplica de ${promo.hora_inicio} a ${promo.hora_fin}`;
  }

  const baseAplicable = baseParaPromo(promo, ctx);
  if (Number(promo.minimo_compra) > 0 && ctx.subtotal < Number(promo.minimo_compra)) {
    const faltan = dinero(Number(promo.minimo_compra) - ctx.subtotal);
    return `Te faltan $${faltan} para usar esta promoción`;
  }
  if (baseAplicable <= 0) return 'Tu pedido no tiene productos que apliquen a esta promoción';

  // Un cupo que ESTE MISMO pedido ya tiene apartado no lo hace inelegible: al
  // recalcular para su propia version nueva, su reserva viva ya esta contada en
  // `usos` y en `usosDelCliente`, y sin descontarla la promocion se rechazaria
  // a si misma. El cupo real se sigue reclamando atomicamente despues.
  const yaApartado = ctx.cuposYaApartados instanceof Set && ctx.cuposYaApartados.has(String(promo.id));
  const propios = yaApartado ? 1 : 0;

  if (!yaApartado && promo.limite_usos != null && Number(promo.usos) >= Number(promo.limite_usos)) {
    return 'Esta promoción alcanzó su límite de usos';
  }
  if (promo.solo_primera_compra && ctx.clienteTienePedidos) {
    return 'Esta promoción es solo para la primera compra';
  }
  if (promo.limite_por_cliente != null && ctx.usosDelCliente != null &&
      (Number(ctx.usosDelCliente[promo.id] || 0) - propios) >= Number(promo.limite_por_cliente)) {
    return 'Ya usaste esta promoción el máximo de veces';
  }
  return null;
}

// ── Condiciones por MODIFICADORES (promociones condicionadas) ───────────────
// Evalúa un item CANÓNICO (con item.modificadores = [{grupo_id, opcion_id,…}])
// contra las condiciones de una promoción. Todas las condiciones son AND. Los
// IDs son reales (grupo/opción del propio negocio, resueltos por el backend);
// la IA nunca decide esto. Operadores V1:
//   'una_de'   — toda opción elegida en el grupo debe estar en option_ids (y ≥1).
//   'incluye'  — todos los option_ids requeridos deben estar seleccionados.
//   'cantidad' — nº de opciones seleccionadas del grupo dentro de [min, max].
// Devuelve { eligible, failedConditions }. Fail-closed: operador desconocido
// o condición sin datos → no elegible.
export function cumpleCondicionesModificadores(item, condiciones) {
  const mods = Array.isArray(item?.modificadores) ? item.modificadores : [];
  const failedConditions = [];
  for (const c of (Array.isArray(condiciones) ? condiciones : [])) {
    const grupoId = Number(c?.grupo_id);
    if (!Number.isInteger(grupoId)) { failedConditions.push({ ...c, motivo: 'grupo_invalido' }); continue; }
    const seleccion = mods.filter(m => Number(m.grupo_id) === grupoId).map(m => Number(m.opcion_id));
    const permitidas = Array.isArray(c.option_ids) ? c.option_ids.map(Number) : [];
    let ok;
    switch (c.operador) {
      case 'una_de':
        ok = seleccion.length > 0 && seleccion.every(id => permitidas.includes(id));
        break;
      case 'incluye':
        ok = permitidas.length > 0 && permitidas.every(id => seleccion.includes(id));
        break;
      case 'cantidad': {
        const min = c.min != null ? Number(c.min) : 0;
        const max = c.max != null ? Number(c.max) : Infinity;
        ok = seleccion.length >= min && seleccion.length <= max;
        break;
      }
      default:
        ok = false; // fail-closed
    }
    if (!ok) failedConditions.push({ grupo_id: grupoId, operador: c.operador });
  }
  return { eligible: failedConditions.length === 0, failedConditions };
}

// Condiciones de la promo que aplican a un producto dado (producto_id null =
// aplica a cualquier participante).
function condicionesDeProducto(promo, productoId) {
  const todas = Array.isArray(promo.condiciones_modificadores) ? promo.condiciones_modificadores : [];
  return todas.filter(c => c.producto_id == null || Number(c.producto_id) === Number(productoId));
}

// ¿Esta LÍNEA del carrito participa en la promo? Producto/categoría incluidos Y
// (si hay) condiciones de modificadores cumplidas. Fuente única de "participa"
// para %/fijo (baseParaPromo) y per-unit (unidadesElegiblesOrdenadas).
function lineaParticipa(promo, it) {
  const prods = Array.isArray(promo.productos) ? promo.productos.map(Number) : null;
  const cats = Array.isArray(promo.categorias) ? promo.categorias.map(Number) : null;
  const todo = (!prods || !prods.length) && (!cats || !cats.length);
  const incluido = todo
    || (prods && prods.includes(Number(it.producto_id)))
    || (cats && cats.includes(Number(it.categoria_id)));
  if (!incluido) return false;
  const cond = condicionesDeProducto(promo, it.producto_id);
  if (cond.length && !cumpleCondicionesModificadores(it, cond).eligible) return false;
  return true;
}

// Base sobre la que se calcula: todo el subtotal, o solo los productos/
// categorías incluidos si la promoción está acotada.
function baseParaPromo(promo, ctx) {
  const prods = Array.isArray(promo.productos) ? promo.productos.map(Number) : null;
  const cats = Array.isArray(promo.categorias) ? promo.categorias.map(Number) : null;
  const condiciones = Array.isArray(promo.condiciones_modificadores) ? promo.condiciones_modificadores : [];
  if ((!prods || !prods.length) && (!cats || !cats.length) && !condiciones.length) return ctx.subtotal;
  return dinero((ctx.items || []).reduce((s, it) => {
    return lineaParticipa(promo, it) ? s + (Number(it.precio_unitario) || 0) * (Number(it.cantidad) || 1) : s;
  }, 0));
}

// ── Promociones POR UNIDAD (2x1 / segundo producto con %) ──────────────────
// Unidades elegibles expandidas por cantidad y ordenadas de MENOR a MAYOR
// precio BASE (sin modificadores). El beneficio cae SIEMPRE sobre las más
// baratas, así el resultado es determinístico e independiente del orden en que
// el cliente agregó los productos. La IA nunca decide cuál queda gratis.
function unidadesElegiblesOrdenadas(promo, ctx) {
  const unidades = [];
  for (const it of (ctx.items || [])) {
    // Participación POR UNIDAD: producto/categoría + condiciones de modificadores
    // (salsa/proteína/guarniciones). Todas las unidades de una línea comparten
    // sus modificadores, así que la línea entera es elegible o no.
    if (!lineaParticipa(promo, it)) continue;
    // Precio BASE del producto participante, nunca el inflado por extras: el
    // beneficio aplica sobre el precio elegible, no sobre los modificadores.
    const precio = Number(it.precio_base != null ? it.precio_base : it.precio_unitario) || 0;
    const n = Math.max(0, Math.floor(Number(it.cantidad) || 0));
    for (let i = 0; i < n; i++) unidades.push(precio);
  }
  return unidades.sort((a, b) => a - b);
}

// Cuántas unidades elegibles faltan para completar el SIGUIENTE grupo (para la
// pista comercial "agrega 1 más y aprovecha el 2x1"). 0 si no hay elegibles.
function unidadesParaSiguienteGrupo(promo, ctx) {
  const n = unidadesElegiblesOrdenadas(promo, ctx).length;
  if (n <= 0) return 0;
  const X = Number(promo.cantidad_requerida) >= 1 ? Number(promo.cantidad_requerida) : 2;
  return (X - (n % X)) % X;
}

function calcularBeneficioPorUnidad(promo, ctx) {
  const unidades = unidadesElegiblesOrdenadas(promo, ctx);
  const X = Number(promo.cantidad_requerida) >= 1 ? Number(promo.cantidad_requerida) : 2;
  const Y = Number(promo.cantidad_beneficiada) >= 1 ? Number(promo.cantidad_beneficiada) : 1;
  let grupos = Math.floor(unidades.length / X);
  if (promo.max_aplicaciones != null) grupos = Math.min(grupos, Math.max(0, Number(promo.max_aplicaciones)));
  const beneficiadas = Math.min(grupos * Y, unidades.length);
  if (beneficiadas <= 0) return { descuento: 0, envioGratis: false, unidadesBeneficiadas: 0 };
  const baratas = unidades.slice(0, beneficiadas); // las N más baratas
  // 2x1 → 100% de descuento; segundo_descuento → `valor`% sobre la unidad.
  const factor = promo.tipo === 'segundo_descuento' ? (Number(promo.valor) / 100) : 1;
  let d = dinero(baratas.reduce((s, p) => s + p * factor, 0));
  if (promo.max_descuento != null) d = Math.min(d, dinero(promo.max_descuento));
  return { descuento: d, envioGratis: false, unidadesBeneficiadas: beneficiadas };
}

function calcularDescuento(promo, ctx) {
  if (promo.tipo === 'envio_gratis') {
    return { descuento: 0, envioGratis: true };
  }
  if (promo.tipo === '2x1' || promo.tipo === 'segundo_descuento') {
    return calcularBeneficioPorUnidad(promo, ctx);
  }
  const base = baseParaPromo(promo, ctx);
  let d = promo.tipo === 'porcentaje'
    ? dinero(base * (Number(promo.valor) / 100))
    : dinero(Number(promo.valor));
  if (promo.max_descuento != null) d = Math.min(d, dinero(promo.max_descuento));
  d = Math.min(d, base); // nunca descuenta más de lo que cuesta
  return { descuento: d, envioGratis: false };
}

// ── Motor: aplica automáticas + código, resuelve acumulación ──────────────
// Reglas de acumulación:
//   · Se ordenan por prioridad (menor primero) y se aplican en ese orden.
//   · Una promoción no acumulable descarta a las demás del mismo tipo de
//     beneficio: se queda la que más le conviene al cliente.
//   · Envío gratis y descuento sí conviven (son beneficios distintos).
export async function calcularPromociones({
  negocioId, subtotal, items = [], costoEnvio = 0, modalidad = 'recoger',
  codigo = null, telefono = null, canal = 'tienda_online', timezone = 'America/Matamoros',
  ahora = new Date(), cuposYaApartados = [],
}) {
  const sub = dinero(subtotal);
  const { rows } = await pool.query(
    `SELECT * FROM tienda_promociones
      WHERE negocio_id = $1 AND activa = TRUE
        AND (automatica = TRUE OR ($2::text IS NOT NULL AND lower(codigo) = lower($2)))
      ORDER BY prioridad ASC, created_at ASC`,
    [negocioId, codigo || null]
  );

  // Historial del cliente: solo si hay teléfono (invitado sin teléfono no
  // puede reclamar promociones de primera compra ni límites por cliente).
  let clienteTienePedidos = false;
  let usosDelCliente = {};
  if (telefono) {
    const [yaCompro, { rows: usos }] = await Promise.all([
      clienteYaComproDeVerdad(negocioId, telefono),
      pool.query(
        `SELECT promocion_id, COUNT(*)::int AS n FROM tienda_promocion_usos
          WHERE negocio_id = $1 AND cliente_telefono = $2 GROUP BY promocion_id`,
        [negocioId, telefono]
      ),
    ]);
    clienteTienePedidos = yaCompro;
    usosDelCliente = Object.fromEntries(usos.map(u => [u.promocion_id, u.n]));
  }

  const ctx = {
    subtotal: sub, items, modalidad, canal, timezone, ahora, clienteTienePedidos, usosDelCliente,
    cuposYaApartados: new Set((cuposYaApartados || []).map(String)),
  };

  const aplicadas = [];
  const rechazos = [];
  let envioGratis = false;
  let bloqueadoPorNoAcumulable = false;

  for (const promo of rows) {
    const motivo = motivoNoAplica(promo, ctx);
    if (motivo) {
      // Solo se le explica al cliente el código que él escribió.
      if (codigo && promo.codigo && promo.codigo.toLowerCase() === codigo.toLowerCase()) {
        rechazos.push({ codigo: promo.codigo, motivo });
      }
      continue;
    }
    if (bloqueadoPorNoAcumulable && promo.tipo !== 'envio_gratis') continue;

    const { descuento, envioGratis: gratis, unidadesBeneficiadas } = calcularDescuento(promo, ctx);
    if (gratis) {
      if (modalidad !== 'domicilio') continue; // envío gratis no significa nada al recoger
      envioGratis = true;
    } else if (descuento <= 0) {
      continue;
    }
    aplicadas.push({
      id: promo.id,
      campaniaId: promo.campania_id || null,
      nombre: promo.nombre,
      codigo: promo.codigo || null,
      tipo: promo.tipo,
      descuento,
      envioGratis: gratis,
      automatica: promo.automatica === true,
      unidadesBeneficiadas: unidadesBeneficiadas || 0,
    });
    if (!promo.acumulable && promo.tipo !== 'envio_gratis') bloqueadoPorNoAcumulable = true;
  }

  // ── OPORTUNIDADES ─────────────────────────────────────────────────────────
  // El backend detecta cuándo el cliente está a pocas unidades de un beneficio
  // per-unit (2x1 / segundo producto) y lo reporta para que el agente lo
  // VERBALICE — nunca para que lo calcule. Solo para promos vigentes (ventana,
  // canal, modalidad, vigencia OK) con al menos una unidad elegible ya en el
  // carrito y que aún no completan su próximo grupo.
  const oportunidades = [];
  for (const promo of rows) {
    if (promo.tipo !== '2x1' && promo.tipo !== 'segundo_descuento') continue;
    if (motivoNoAplica(promo, ctx)) continue;
    const faltan = unidadesParaSiguienteGrupo(promo, ctx);
    if (faltan <= 0) continue;
    oportunidades.push({
      promocionId: promo.id,
      nombre: promo.nombre,
      tipo: promo.tipo,
      codigo: 'ADD_ONE_MORE_ELIGIBLE_ITEM',
      unidadesFaltantes: faltan,
    });
  }

  // Si escribió un código y no quedó aplicado ni rechazado con motivo, no existe.
  if (codigo && !aplicadas.some(a => a.codigo && a.codigo.toLowerCase() === codigo.toLowerCase()) &&
      !rechazos.length) {
    rechazos.push({ codigo, motivo: 'Ese código no existe o ya no está disponible' });
  }

  const descuentoTotal = dinero(aplicadas.reduce((s, a) => s + a.descuento, 0));
  const envioBase = modalidad === 'domicilio' ? dinero(costoEnvio) : 0;
  const envioFinal = envioGratis ? 0 : envioBase;
  const total = Math.max(0, dinero(sub - descuentoTotal + envioFinal));

  return {
    subtotal: sub,
    descuento: descuentoTotal,
    envio: envioFinal,
    envioBase,
    envioGratis,
    total,
    ahorro: dinero(descuentoTotal + (envioGratis ? envioBase : 0)),
    aplicadas,
    rechazos,
    oportunidades,
  };
}

// ── Pista comercial: "te faltan $X para envío gratis" ─────────────────────
// Se calcula con las MISMAS reglas del motor, no con un número inventado en
// el frontend.
export async function pistaEnvioGratis({ negocioId, subtotal, modalidad, canal = 'tienda_online' }) {
  if (modalidad !== 'domicilio') return null;
  const { rows } = await pool.query(
    `SELECT nombre, minimo_compra FROM tienda_promociones
      WHERE negocio_id = $1 AND activa = TRUE AND tipo = 'envio_gratis' AND automatica = TRUE
        AND canales @> $2::jsonb
      ORDER BY minimo_compra ASC`,
    [negocioId, JSON.stringify([canal])]
  );
  if (!rows.length) return null;
  const sub = dinero(subtotal);
  const alcanzada = rows.find(r => sub >= Number(r.minimo_compra));
  if (alcanzada) return { logrado: true, mensaje: '🎉 ¡Ya tienes envío gratis!' };
  const siguiente = rows[0];
  const faltan = dinero(Number(siguiente.minimo_compra) - sub);
  return { logrado: false, faltan, mensaje: `Te faltan $${faltan} para obtener envío gratis` };
}

// ── Reclamo atómico del cupo de una promoción ─────────────────────────────
//
// Ningún límite se puede hacer valer leyendo y decidiendo después: dos
// checkouts simultáneos leen el mismo valor y ambos pasan. Aquí hay TRES
// límites y cada uno necesita que decida la base, no la aplicación:
//
//   límite global     → UPDATE condicional sobre el contador `usos`.
//   límite por cliente→ contar las filas de ese cliente y decidir, todo
//   primera compra      dentro de una transacción serializada por
//                       (promoción, teléfono) con un advisory lock.
//
// La fila de reserva se escribe en tienda_promocion_usos con un folio
// provisional (`reserva:<checkoutToken>`). Esa fila es lo que hace visible el
// reclamo a las otras transacciones: sin ella, el segundo checkout contaría
// cero usos aunque el primero ya haya ganado.
//
// Se llama ANTES de crear el pedido: descubrir que el cupón se agotó cuando
// el cliente ya tiene folio es descubrirlo demasiado tarde.

const PREFIJO_RESERVA = 'reserva:';
// Una reserva que nunca se convirtió en pedido (proceso caído entre reservar y
// crear) no puede quemar el cupón para siempre. Pasado este tiempo se ignora y
// se recicla.
const RESERVA_VENCE_MIN = (() => {
  const n = parseInt(process.env.XABOR_TIENDA_RESERVA_VENCE_MIN, 10);
  return Number.isFinite(n) && n >= 0 ? n : 15;
})();

// Suelta reservas huérfanas de ESTA promoción antes de contar. Devuelve el
// cupo global de cada una: si no, un reinicio del proceso dejaría el contador
// inflado sin ningún pedido detrás.
async function reciclarReservasVencidas(client, negocioId, promocionId) {
  const { rows: vencidas } = await client.query(
    `SELECT id, pedido_folio FROM tienda_promocion_usos
      WHERE negocio_id = $1 AND promocion_id = $2
        AND pedido_folio LIKE $3
        AND created_at < NOW() - ($4 || ' minutes')::interval
      FOR UPDATE`,
    [negocioId, promocionId, PREFIJO_RESERVA + '%', String(RESERVA_VENCE_MIN)]
  );
  if (!vencidas.length) return 0;

  let liberadas = 0;
  for (const v of vencidas) {
    const token = v.pedido_folio.slice(PREFIJO_RESERVA.length);

    // ANTES de devolver el cupo hay que saber si ese checkout llegó a producir
    // un pedido. Si lo produjo, el cliente YA tiene su descuento: devolver el
    // cupón dejaría un pedido con descuento y una promoción como si nadie la
    // hubiera usado. En ese caso la reserva no se recicla — se confirma contra
    // el pedido real, que es lo que debió pasar y no alcanzó a pasar.
    const { rows: [pedido] } = await client.query(
      `SELECT folio, datos FROM pedidos_activos
        WHERE negocio_id = $1 AND datos->'tienda'->>'checkout_token' = $2
        LIMIT 1`,
      [negocioId, token]
    );

    if (pedido) {
      const promo = (pedido.datos?.tienda?.promociones || [])
        .find(x => String(x.id) === String(promocionId));
      await client.query(
        `UPDATE tienda_promocion_usos
            SET pedido_folio = $3, monto_descuento = $4, monto_venta = $5
          WHERE id = $2 AND negocio_id = $1`,
        [negocioId, v.id, pedido.folio,
         Number(promo?.descuento) || 0, Number(pedido.datos?.total) || 0]
      ).catch(async (e) => {
        // Si ya existía la fila confirmada de ese folio (el reintento llegó
        // primero), la reserva sobra: se borra sin devolver cupo, porque el
        // uso real ya está contado en la otra fila.
        if (e.code === '23505') {
          await client.query(`DELETE FROM tienda_promocion_usos WHERE id = $1`, [v.id]);
        } else { throw e; }
      });
      console.warn(
        `[Tienda] Reserva vencida reconciliada contra el pedido ${pedido.folio}: NO se devuelve el cupo`);
      continue;
    }

    // Sin pedido: el checkout de verdad murió antes de crear nada. Ahora sí se
    // recicla, para que el cupón no quede quemado por un intento fallido.
    await client.query(`DELETE FROM tienda_promocion_usos WHERE id = $1`, [v.id]);
    liberadas++;
  }

  if (liberadas > 0) {
    await client.query(
      `UPDATE tienda_promociones SET usos = GREATEST(usos - $3, 0)
        WHERE id = $2 AND negocio_id = $1`,
      [negocioId, promocionId, liberadas]);
  }
  return liberadas;
}

// Reconciliación fuera del camino del checkout: recorre las reservas vencidas
// de un negocio y las resuelve una por una con la misma regla de arriba. La
// usa la suite de recuperación y sirve como herramienta de operación si
// hiciera falta reparar a mano.
export async function reconciliarReservasVencidas(negocioId, { minutos } = {}) {
  const antes = RESERVA_VENCE_MIN;
  const client = await pool.connect();
  const resumen = { revisadas: 0, liberadas: 0, reconciliadas: 0 };
  try {
    const { rows: promos } = await client.query(
      `SELECT DISTINCT promocion_id FROM tienda_promocion_usos
        WHERE negocio_id = $1 AND pedido_folio LIKE $2`,
      [negocioId, PREFIJO_RESERVA + '%']);
    for (const { promocion_id } of promos) {
      await client.query('BEGIN');
      const { rows: [previas] } = await client.query(
        `SELECT COUNT(*)::int AS n FROM tienda_promocion_usos
          WHERE negocio_id = $1 AND promocion_id = $2 AND pedido_folio LIKE $3`,
        [negocioId, promocion_id, PREFIJO_RESERVA + '%']);
      const liberadas = await reciclarReservasVencidas(client, negocioId, promocion_id);
      const { rows: [quedan] } = await client.query(
        `SELECT COUNT(*)::int AS n FROM tienda_promocion_usos
          WHERE negocio_id = $1 AND promocion_id = $2 AND pedido_folio LIKE $3`,
        [negocioId, promocion_id, PREFIJO_RESERVA + '%']);
      await client.query('COMMIT');
      resumen.revisadas += previas.n;
      resumen.liberadas += liberadas;
      resumen.reconciliadas += (previas.n - quedan.n) - liberadas;
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Tienda] Error reconciliando reservas:', e.message);
  } finally {
    client.release();
  }
  return resumen;
}

export async function reservarUsosPromociones(negocioId, aplicadas = [], contexto = {}) {
  const telefono = contexto.telefono || null;
  const token = contexto.checkoutToken || null;
  const reservadas = [], agotadas = [];

  for (const a of aplicadas) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Serializa a los checkouts del MISMO cliente para la MISMA promoción.
      // Sin esto, contar-y-decidir sigue siendo una carrera aunque haya fila
      // de reserva: ambos contarían antes de que el otro inserte.
      if (telefono) {
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
          [String(a.id), telefono]);
      }

      await reciclarReservasVencidas(client, negocioId, a.id);

      // 1) Cupo global: gana quien logre incrementar dentro del límite.
      const { rowCount: global } = await client.query(
        `UPDATE tienda_promociones
            SET usos = usos + 1, updated_at = NOW()
          WHERE id = $1 AND negocio_id = $2
            AND (limite_usos IS NULL OR usos < limite_usos)`,
        [a.id, negocioId]
      );
      if (!global) { await client.query('ROLLBACK'); agotadas.push(a); continue; }

      // 2) Cupo por cliente. Los topes se releen de la base dentro de la
      //    transacción: son la fuente de verdad, no lo que trajo el llamador.
      if (telefono) {
        const { rows: [reglas] } = await client.query(
          `SELECT limite_por_cliente, solo_primera_compra FROM tienda_promociones
            WHERE id = $1 AND negocio_id = $2`, [a.id, negocioId]);

        // "Solo primera compra" es, en la práctica, un tope de uno por cliente
        // para esta promoción: quien ya la reclamó no es primerizo otra vez.
        // Pero el tope se cuenta sobre las filas VIVAS de este cliente, y una
        // reserva liberada ya no existe -- por eso el que vencio sin pagar
        // vuelve a ser elegible, que es justo lo que P0-2 vino a arreglar.
        const tope = reglas?.solo_primera_compra
          ? 1
          : (reglas?.limite_por_cliente == null ? null : Number(reglas.limite_por_cliente));

        if (tope != null) {
          const { rows: [c] } = await client.query(
            `SELECT COUNT(*)::int AS n FROM tienda_promocion_usos
              WHERE negocio_id = $1 AND promocion_id = $2 AND cliente_telefono = $3`,
            [negocioId, a.id, telefono]);
          if (c.n >= tope) { await client.query('ROLLBACK'); agotadas.push(a); continue; }
        }
      }

      // 3) La fila de reserva: esto es lo que ve el checkout de al lado. Nace
      //    'reservada' explicitamente -- el DEFAULT de la columna es
      //    'consumida' porque todo lo historico si era un uso real, pero esto
      //    todavia no lo es.
      await client.query(
        `INSERT INTO tienda_promocion_usos
           (negocio_id, promocion_id, campania_id, pedido_folio, cliente_telefono, estado)
         VALUES ($1,$2,$3,$4,$5,'reservada')`,
        [negocioId, a.id, a.campaniaId, PREFIJO_RESERVA + (token || randomUUID()), telefono]);

      await client.query('COMMIT');
      reservadas.push(a);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[Tienda] Error reservando promoción:', e.message);
      agotadas.push(a);
    } finally {
      client.release();
    }
  }
  return { reservadas, agotadas };
}

// Devuelve el cupo cuando el pedido no llegó a crearse: sin esto, un fallo
// posterior quemaría un uso que nadie aprovechó — y, con límite por cliente,
// dejaría al cliente sin poder reintentar.
export async function liberarUsosPromociones(negocioId, aplicadas = [], contexto = {}) {
  const token = contexto.checkoutToken || null;
  for (const a of aplicadas) {
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM tienda_promocion_usos
          WHERE negocio_id = $1 AND promocion_id = $2 AND pedido_folio = $3`,
        [negocioId, a.id, PREFIJO_RESERVA + token]);
      // El contador solo baja si de verdad había una reserva que soltar.
      if (rowCount > 0 || !token) {
        await pool.query(
          `UPDATE tienda_promociones SET usos = GREATEST(usos - 1, 0), updated_at = NOW()
            WHERE id = $1 AND negocio_id = $2`, [a.id, negocioId]);
      }
    } catch (e) {
      console.error('[Tienda] Error liberando promoción:', e.message);
    }
  }
}

// ── Confirmación del uso ──────────────────────────────────────────────────
// La fila YA existe: la escribió la reserva con un folio provisional. Aquí se
// le pone el folio real y los montos. Insertar una segunda fila contaría dos
// usos del mismo cliente y volvería a romper el límite por cliente.
//
// `estadoFinal` decide si esto CONSUME o solo RE-ANCLA la reserva:
//
//   'consumida'  el pedido ya vale por sí mismo (efectivo, terminal, POS): el
//                dinero se cobra en persona y la comanda sale de inmediato.
//   'reservada'  el pedido nace `pendiente_pago`: el cupo sigue apartado -- y
//                sigue contando contra el límite -- pero NO está gastado. Lo
//                consume `consumirDeudaDeDerivacion` cuando entre el dinero, y
//                lo libera `vencerEsperaDePago` si la espera se acaba.
//
// Antes esto consumía siempre, y por eso llegar al checkout gastaba la
// promoción aunque no entrara un peso.
//
// Sigue siendo idempotente: si el UPDATE no encuentra la reserva (porque un
// reintento ya la confirmó), el INSERT de respaldo choca contra el UNIQUE
// (negocio, promoción, folio) y no duplica nada.
export async function registrarUsosPromociones({
  negocioId, folio, aplicadas = [], telefono = null, montoVenta = 0, clienteNuevo = false,
  checkoutToken = null, estadoFinal = 'consumida', pedidoVersion = null,
}) {
  if (!aplicadas.length) return { registrados: 0 };
  // Solo dos estados posibles: cualquier otra cosa seria vocabulario inventado
  // y el CHECK de la base la rechazaria a mitad de la transaccion.
  const estado = estadoFinal === 'reservada' ? 'reservada' : 'consumida';
  const client = await pool.connect();
  let registrados = 0;
  try {
    await client.query('BEGIN');
    fallaInyectada('atribucion_tras_begin');
    for (const a of aplicadas) {
      // El UPDATE NO puede pisar el estado de una fila que ya se consumio: un
      // reintento tardio del checkout volveria a dejarla 'reservada' y el
      // expirador podria devolver un cupo que ya tiene dinero detras.
      const { rowCount: confirmados } = await client.query(
        `UPDATE tienda_promocion_usos
            SET pedido_folio = $4, monto_descuento = $5, monto_venta = $6,
                cliente_nuevo = $7, cliente_telefono = COALESCE(cliente_telefono, $8),
                estado = $9, pedido_version = COALESCE($10, pedido_version),
                consumida_at = CASE WHEN $9 = 'consumida' THEN COALESCE(consumida_at, NOW()) END
          WHERE negocio_id = $1 AND promocion_id = $2 AND pedido_folio = $3
            AND estado <> 'consumida'`,
        [negocioId, a.id, PREFIJO_RESERVA + checkoutToken, folio,
         a.descuento || 0, montoVenta, !!clienteNuevo, telefono, estado, pedidoVersion]
      );
      if (confirmados > 0) {
        fallaInyectada('atribucion_tras_convertir');
        registrados++; continue;
      }

      // ── SIN RESERVA PROVISIONAL QUE CONFIRMAR ───────────────────────────
      //
      // Pasa cuando la llamada viene de otro canal, o cuando la fila de reserva
      // se perdio entre reservar y llegar aqui. El respaldo INSERTA la fila --
      // pero antes tiene que RECLAMAR el cupo.
      //
      // El fallback anterior insertaba directamente, y con `estado='reservada'`
      // eso creaba una reserva que NO habia pasado por el UPDATE condicional
      // `usos < limite_usos`. Es decir: una reserva que no contaba contra el
      // limite, y con ella dejaba de ser cierto que
      // `reservas + consumidas = usos`. Un cupon de 1 uso podia entregarse dos
      // veces por ese hueco.
      //
      // Orden: primero el INSERT (el UNIQUE decide si de verdad hay fila nueva)
      // y SOLO si hubo fila nueva se reclama el cupo. Al reves, un reintento ya
      // confirmado inflaria el contador sin insertar nada.
      const { rowCount } = await client.query(
        `INSERT INTO tienda_promocion_usos
           (negocio_id, promocion_id, campania_id, pedido_folio, cliente_telefono,
            monto_descuento, monto_venta, cliente_nuevo, estado, pedido_version, consumida_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                 CASE WHEN $9 = 'consumida' THEN NOW() END)
         ON CONFLICT (negocio_id, promocion_id, pedido_folio) DO NOTHING`,
        [negocioId, a.id, a.campaniaId, folio, telefono,
         a.descuento || 0, montoVenta, !!clienteNuevo, estado, pedidoVersion]
      );
      if (rowCount > 0) {
        fallaInyectada('atribucion_tras_insert');
        const { rowCount: reclamado } = await client.query(
          `UPDATE tienda_promociones
              SET usos = usos + 1, updated_at = NOW()
            WHERE id = $1 AND negocio_id = $2
              AND (limite_usos IS NULL OR usos < limite_usos)`,
          [a.id, negocioId]);
        if (!reclamado) {
          // FAIL CLOSED. No queda otra: insertar sin contar seria regalar un
          // cupo, y contar por encima del limite seria regalarselo a otro. La
          // transaccion entera se deshace y el llamador se entera.
          throw new PromocionError(
            `La promocion "${a.nombre || a.id}" ya no tiene cupo disponible`, 'CUPO_AGOTADO');
        }
        fallaInyectada('atribucion_tras_reclamar');
        registrados++;
        continue;
      }

      // ── LA FILA YA EXISTE PARA ESTE FOLIO ───────────────────────────────
      //
      // El ON CONFLICT no inserto nada: alguien mas ya ato esta promocion a
      // este pedido. Tipicamente el reciclador de reservas, que al encontrar el
      // pedido convierte `reserva:<token>` en el folio real -- pero sin decidir
      // si el pedido ya vale por si mismo o sigue esperando dinero.
      //
      // Ignorarla (que es lo que hacia un DO NOTHING a secas) dejaba una
      // promocion de un pedido de EFECTIVO eternamente 'reservada': nadie la
      // consumiria nunca, porque el consumo vive en la transicion financiera y
      // ese pedido no tiene ninguna.
      //
      // Se reconcilia. El cupo NO se vuelve a reclamar -- esa fila ya estaba
      // contada -- y 'consumida' jamas retrocede a 'reservada': detras de una
      // consumida hay dinero.
      const { rowCount: reconciliados } = await client.query(
        `UPDATE tienda_promocion_usos
            SET monto_descuento = $4, monto_venta = $5,
                cliente_nuevo = $6, cliente_telefono = COALESCE(cliente_telefono, $7),
                pedido_version = COALESCE($9, pedido_version),
                estado = CASE WHEN estado = 'consumida' THEN 'consumida' ELSE $8 END,
                consumida_at = CASE
                  WHEN estado = 'consumida' THEN consumida_at
                  WHEN $8 = 'consumida' THEN NOW()
                  ELSE consumida_at END
          WHERE negocio_id = $1 AND promocion_id = $2 AND pedido_folio = $3`,
        [negocioId, a.id, folio, a.descuento || 0, montoVenta, !!clienteNuevo,
         telefono, estado, pedidoVersion]);
      if (reconciliados > 0) registrados++;
    }
    fallaInyectada('atribucion_antes_de_commit');
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Tienda] Error registrando usos de promoción:', e.message);
    // NADA se traga. Antes solo se relanzaba PromocionError, asi que un timeout
    // o una conexion rota hacian ROLLBACK y esta funcion volvia como si hubiera
    // funcionado -- y `derivacionCritica` marcaba la atribucion COMO HECHA. La
    // promocion quedaba sin vincular y ningun reintento volvia a mirarla.
    //
    // Si la transaccion no hizo COMMIT, el llamador tiene que enterarse.
    throw e;
  } finally {
    client.release();
  }
  return { registrados };
}

// ── CAMBIO DE VERSION DEL PEDIDO ──────────────────────────────────────────
//
// Una reserva justifica UN precio. Si el pedido cambia -- otro total, otra
// modalidad --, la reserva de la version vieja ya no representa el descuento
// que ese pedido lleva ahora, y el checkout nuevo no puede salir apoyado en
// ella. Se resincroniza antes de crear el cobro:
//
//   · la version no cambio          -> no se toca nada;
//   · cambio y la promo sigue
//     aplicando y hay cupo          -> se supersede la reserva vieja y se
//                                      reserva para la version nueva, todo en
//                                      una transaccion (si el reclamo falla, la
//                                      vieja NO se pierde);
//   · cambio y la promo ya no
//     aplica (o no hay cupo)        -> se suelta la reserva vieja y se falla
//                                      cerrado. El pedido lleva un total con un
//                                      descuento que ya no le corresponde:
//                                      cobrarlo seria regalar la diferencia.
//
// Devuelve { ok, accion } o { ok:false, razon, promociones } para que el
// llamador decida -- aqui no se cocina ni se cobra nada.
export async function resincronizarReservasPorVersion({
  negocioId, folio, datosPedido, versionActual, timezone = 'America/Matamoros',
}) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    return { ok: false, razon: 'sin_negocio' };
  }
  const nid = negocioId.trim();

  const { rows: reservas } = await pool.query(
    `SELECT id, promocion_id, campania_id, pedido_version, cliente_telefono
       FROM tienda_promocion_usos
      WHERE negocio_id = $1 AND pedido_folio = $2 AND estado = 'reservada'`,
    [nid, folio]);
  if (!reservas.length) return { ok: true, accion: 'sin_reservas' };

  const desfasadas = reservas.filter(
    r => r.pedido_version && versionActual && r.pedido_version !== versionActual);
  if (!desfasadas.length) return { ok: true, accion: 'vigente' };

  // ¿Que promociones aplicarian HOY, con el carrito que el pedido tiene ahora?
  // Se recalcula server-side: el descuento nunca se hereda de la version vieja.
  const telefono = datosPedido?.cliente?.telefono || desfasadas[0].cliente_telefono || null;
  const items = Array.isArray(datosPedido?.items) ? datosPedido.items : [];
  // Mismo criterio que el recalculo: el envio BASE, no el ya descontado.
  const envio = resolverEnvioBase(datosPedido) ?? 0;
  const descuentoViejo = Number(datosPedido?.descuento || 0) || 0;
  const envioEfectivoViejo = Number(datosPedido?.costo_envio ?? datosPedido?.envio ?? 0) || 0;
  const subtotal = Number(datosPedido?.subtotal);
  const base = Number.isFinite(subtotal) && subtotal > 0
    ? subtotal
    : Math.max(0, Number(datosPedido?.total || 0) + descuentoViejo - envioEfectivoViejo);
  const modalidad = modalidadCanonica(datosPedido);

  // El codigo se recupera de lo que el pedido trae guardado: sin esto una
  // promocion de codigo nunca volveria a aplicar, porque el motor solo mira las
  // automaticas cuando no se le pasa ninguno.
  const guardadas = Array.isArray(datosPedido?.tienda?.promociones)
    ? datosPedido.tienda.promociones : [];
  const codigo = guardadas.map(p => p.codigo).find(Boolean) || null;

  const recalculo = await calcularPromociones({
    negocioId: nid, subtotal: base, items, costoEnvio: envio,
    modalidad, codigo, telefono, canal: datosPedido?.canal || 'tienda_online', timezone,
    // Las reservas que este pedido va a superseder no cuentan contra si mismo.
    cuposYaApartados: desfasadas.map(r => r.promocion_id),
  });
  const aplicanAhora = new Map(recalculo.aplicadas.map(x => [String(x.id), x]));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Se suelta lo viejo SIEMPRE: esa reserva ya no justifica nada.
    const { rows: sueltas } = await client.query(
      `DELETE FROM tienda_promocion_usos
        WHERE negocio_id = $1 AND id = ANY($2::uuid[]) AND estado = 'reservada'
        RETURNING promocion_id`,
      [nid, desfasadas.map(r => r.id)]);
    for (const s2 of sueltas) {
      await client.query(
        `UPDATE tienda_promociones SET usos = GREATEST(usos - 1, 0), updated_at = NOW()
          WHERE id = $1 AND negocio_id = $2`, [s2.promocion_id, nid]);
    }

    // ¿Siguen aplicando TODAS las que el pedido traia? Si alguna se cayo, el
    // total del pedido esta mal y no hay checkout que valga.
    const perdidas = desfasadas.filter(r => !aplicanAhora.has(String(r.promocion_id)));
    if (perdidas.length) {
      // BARRERA DURABLE, en la MISMA transaccion que suelta el cupo.
      //
      // Soltar la reserva y solo devolver un error dejaba un agujero: al
      // segundo intento ya no habia reserva, `resincronizar` respondia
      // 'sin_reservas' y el cobro salia adelante -- con el total viejo, que
      // todavia lleva el descuento. Liberar el cupo borraba la unica evidencia
      // de que ese precio ya no valia.
      //
      // La AUSENCIA de reserva no significa que el precio sea valido. Solo un
      // recalculo server-side real puede volver a afirmarlo, y es lo unico que
      // limpia esta marca.
      await client.query(
        `UPDATE pedidos_activos
            SET datos = jsonb_set(
                  COALESCE(datos, '{}'::jsonb), '{tienda}',
                  COALESCE(datos->'tienda', '{}'::jsonb) || $3::jsonb, true),
                updated_at = NOW()
          WHERE folio = $1 AND negocio_id = $2`,
        [folio, nid, JSON.stringify({
          promocion_recalculo_pendiente: true,
          promocion_recalculo_motivo: 'la promocion dejo de aplicar al cambiar el pedido',
          promocion_recalculo_version: versionActual,
          promocion_recalculo_promociones: perdidas.map(r => r.promocion_id),
          promocion_recalculo_at: new Date().toISOString(),
        })]);
      await client.query('COMMIT');   // el cupo si vuelve al pozo
      return {
        ok: false, razon: 'promocion_no_aplica_a_la_version_nueva',
        promociones: perdidas.map(r => r.promocion_id),
      };
    }

    // Reservar para la version nueva, con la misma barrera de siempre.
    const rereservadas = [];
    for (const r of desfasadas) {
      const promo = aplicanAhora.get(String(r.promocion_id));
      const { rowCount: reclamado } = await client.query(
        `UPDATE tienda_promociones
            SET usos = usos + 1, updated_at = NOW()
          WHERE id = $1 AND negocio_id = $2
            AND (limite_usos IS NULL OR usos < limite_usos)`,
        [r.promocion_id, nid]);
      if (!reclamado) {
        // Otro cliente se llevo el cupo entre medias. Se deshace TODO: la
        // reserva vieja se conserva y el llamador falla cerrado, en vez de
        // quedarse sin ninguna de las dos.
        await client.query('ROLLBACK');
        return { ok: false, razon: 'sin_cupo_para_la_version_nueva', promociones: [r.promocion_id] };
      }
      await client.query(
        `INSERT INTO tienda_promocion_usos
           (negocio_id, promocion_id, campania_id, pedido_folio, cliente_telefono,
            monto_descuento, estado, pedido_version)
         VALUES ($1,$2,$3,$4,$5,$6,'reservada',$7)`,
        [nid, r.promocion_id, r.campania_id, folio, r.cliente_telefono,
         promo?.descuento || 0, versionActual]);
      rereservadas.push(r.promocion_id);
    }

    // El precio volvio a afirmarse server-side para esta version: si habia
    // barrera, aqui deja de tener sentido.
    await client.query(
      `UPDATE pedidos_activos
          SET datos = jsonb_set(datos, '{tienda}',
                (datos->'tienda') - 'promocion_recalculo_pendiente'
                                  - 'promocion_recalculo_motivo'
                                  - 'promocion_recalculo_version'
                                  - 'promocion_recalculo_promociones'
                                  - 'promocion_recalculo_at', true),
              updated_at = NOW()
        WHERE folio = $1 AND negocio_id = $2 AND datos->'tienda' IS NOT NULL`,
      [folio, nid]);

    await client.query('COMMIT');
    console.log(`[Promos] ${rereservadas.length} reserva(s) del pedido ${folio} pasaron a la version ${versionActual}`);
    return { ok: true, accion: 'resincronizada', promociones: rereservadas, descuento: recalculo.descuento };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Promos] Error resincronizando reservas:', e.message);
    return { ok: false, razon: 'error_resincronizando' };
  } finally {
    client.release();
  }
}

/**
 * ¿Este pedido esta esperando un recalculo de promociones?
 *
 * Mientras lo este, su total lleva un descuento que ya nadie justifica y no
 * puede salir ningun cobro. Se lee de `pedidos_activos.datos.tienda`, que es
 * durable: sobrevive al reinicio, al retry y al proceso que la escribio.
 */
export function pedidoEsperaRecalculoDePromocion(datosPedido) {
  return datosPedido?.tienda?.promocion_recalculo_pendiente === true;
}

/**
 * La modalidad CANONICA del pedido, tal y como la entiende el motor.
 *
 * `pedidos_activos.datos.modalidad` guarda la etiqueta del POS -- "entrega a
 * domicilio", "recoger en tienda" --, mientras que las promociones se acotan
 * con las claves cortas: "domicilio", "recoger". Compararlas crudas hacia que
 * un pedido REAL a domicilio no calificara para ninguna promocion acotada a
 * domicilio, ni para el envio gratis. El fixture sintetico no lo veia porque
 * escribia ya la clave corta.
 *
 * La version del pedido NO usa esto: `calcularVersionPedidoHash` recibe la
 * modalidad CRUDA, que es la que tiene la fila y con la que la comparan el
 * asiento y la deuda de derivacion.
 */
function modalidadCanonica(datos) {
  const cruda = String(datos?.modalidad || datos?.tipo || '').toLowerCase();
  if (!cruda) return 'recoger';
  if (cruda.includes('domicilio')) return 'domicilio';
  if (cruda.includes('recoger')) return 'recoger';
  return cruda;
}

/**
 * El costo de envio ANTES de cualquier promocion.
 *
 *   · Si no es a domicilio, no hay envio y punto.
 *   · `datos.tienda.envio_base` es la fuente durable: lo escribe el checkout
 *     con lo que resolvio contra la zona del negocio, antes de descontar nada.
 *   · Historicos sin `envio_base`: si el pedido NUNCA tuvo envio gratis, su
 *     `costo_envio` no fue tocado por ninguna promocion y sirve de base.
 *   · Historico CON envio gratis y SIN `envio_base`: no hay forma de saber
 *     cuanto costaba el envio. Devuelve null y el recalculo falla cerrado --
 *     inventar un 0 seria regalar el envio; inventar otra cifra, cobrarla sin
 *     fundamento.
 *
 * Devuelve un numero, o null si no se puede afirmar.
 */
function resolverEnvioBase(datos) {
  if (modalidadCanonica(datos) !== 'domicilio') return 0;

  const guardado = Number(datos?.tienda?.envio_base);
  if (Number.isFinite(guardado) && guardado >= 0) return guardado;

  const tuvoEnvioGratis = datos?.tienda?.envio_gratis === true
    || (Array.isArray(datos?.tienda?.promociones)
        && datos.tienda.promociones.some(p => p?.envio_gratis === true || p?.tipo === 'envio_gratis'));
  if (tuvoEnvioGratis) return null;

  const efectivo = Number(datos?.costo_envio ?? datos?.envio);
  return Number.isFinite(efectivo) && efectivo >= 0 ? efectivo : 0;
}

/**
 * RECALCULO SERVER-SIDE REAL. Es lo UNICO que limpia la barrera.
 *
 * Vuelve a calcular las promociones con el carrito que el pedido tiene ahora,
 * reserva las que sigan aplicando (con la barrera de cupo de siempre), reescribe
 * el descuento y el total del pedido con lo que el servidor acaba de decidir --
 * nunca con lo que traia -- y solo entonces borra la marca.
 *
 * Volver a llamar a `crearEnlacePago` NO la limpia: ese camino solo lee.
 */
export async function recalcularPromocionesDelPedido(negocioId, folio, { timezone = 'America/Matamoros' } = {}) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return { ok: false, razon: 'sin_negocio' };
  const nid = negocioId.trim();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [pedido] } = await client.query(
      `SELECT datos FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2 FOR UPDATE`,
      [folio, nid]);
    if (!pedido) { await client.query('ROLLBACK'); return { ok: false, razon: 'pedido_no_encontrado' }; }

    const datos = pedido.datos || {};

    // ── ENVIO BASE vs ENVIO EFECTIVO ────────────────────────────────────
    //
    // `datos.costo_envio` es el envio EFECTIVO: el checkout lo escribe con
    // `promo.envio`, asi que un pedido con envio gratis lo tiene en 0. Usarlo
    // como base al recalcular regalaba el envio incluso despues de perder la
    // promocion que lo daba: 0 - nada = 0.
    //
    // La base durable es `datos.tienda.envio_base`, que el checkout guarda con
    // el costo ANTES de promociones, calculado server-side contra la zona.
    const envioBase = resolverEnvioBase(datos);
    if (envioBase === null) {
      await client.query('ROLLBACK');
      return { ok: false, razon: 'sin_envio_base' };
    }
    const envio = envioBase;
    const descuentoViejo = Number(datos?.descuento || 0) || 0;
    const sub = Number(datos?.subtotal);
    // El subtotal es la base real de los productos. Solo si falta se
    // reconstruye, y entonces con el envio EFECTIVO que el total llevaba --
    // no con la base -- porque es lo que de verdad se sumo a ese total.
    const envioEfectivoViejo = Number(datos?.costo_envio ?? datos?.envio ?? 0) || 0;
    const base = Number.isFinite(sub) && sub > 0
      ? sub : Math.max(0, Number(datos?.total || 0) + descuentoViejo - envioEfectivoViejo);
    const guardadas = Array.isArray(datos?.tienda?.promociones) ? datos.tienda.promociones : [];
    const codigo = guardadas.map(p => p.codigo).find(Boolean) || null;

    // Las reservas vivas de este pedido no lo descalifican a si mismo.
    const { rows: vivas } = await client.query(
      `SELECT promocion_id FROM tienda_promocion_usos
        WHERE negocio_id = $1 AND pedido_folio = $2 AND estado = 'reservada'`,
      [nid, folio]);

    const promo = await calcularPromociones({
      negocioId: nid, subtotal: base, items: Array.isArray(datos?.items) ? datos.items : [],
      costoEnvio: envio, modalidad: modalidadCanonica(datos),
      codigo, telefono: datos?.cliente?.telefono || null,
      canal: datos?.canal || 'tienda_online', timezone,
      cuposYaApartados: vivas.map(v => v.promocion_id),
    });

    // Se sueltan TODAS las reservas vivas del pedido y se vuelven a tomar solo
    // las que siguen aplicando. Asi el resultado no depende de lo que hubiera.
    const { rows: sueltas } = await client.query(
      `DELETE FROM tienda_promocion_usos
        WHERE negocio_id = $1 AND pedido_folio = $2 AND estado = 'reservada'
        RETURNING promocion_id`, [nid, folio]);
    for (const x of sueltas) {
      await client.query(
        `UPDATE tienda_promociones SET usos = GREATEST(usos - 1, 0), updated_at = NOW()
          WHERE id = $1 AND negocio_id = $2`, [x.promocion_id, nid]);
    }

    // ── RECLAMAR PRIMERO, DECIDIR EL PRECIO DESPUES ─────────────────────
    //
    // `calcularPromociones` dice cuales SERIAN aplicables; el cupo lo decide la
    // base, promocion por promocion, y cualquiera puede perderse aqui mismo si
    // otro cliente se lleva el ultimo justo antes. Por eso NADA del precio
    // puede salir del calculo previo: el total, el envio, el ahorro y la
    // version se derivan del conjunto REALMENTE reservado.
    //
    // El caso que lo hace obvio: una promocion automatica de envio gratis con
    // un solo cupo. A la ve disponible, B se la lleva, A falla al reclamarla --
    // y con `promo.envioGratis` A se iba sin cobrar el envio de todos modos.
    //
    // La version tampoco puede calcularse antes: se escribe en las reservas
    // DESPUES de saber el total final, en esta misma transaccion. Una reserva
    // con la version de un total que nunca se escribio no justifica nada.
    await retardoInyectado('recalculo_antes_de_reclamar');

    const reservadas = [];
    for (const ap of promo.aplicadas) {
      const { rowCount: reclamado } = await client.query(
        `UPDATE tienda_promociones
            SET usos = usos + 1, updated_at = NOW()
          WHERE id = $1 AND negocio_id = $2
            AND (limite_usos IS NULL OR usos < limite_usos)`,
        [ap.id, nid]);
      if (!reclamado) continue;   // se agoto entre medias: el pedido va sin ella
      await client.query(
        `INSERT INTO tienda_promocion_usos
           (negocio_id, promocion_id, campania_id, pedido_folio, cliente_telefono,
            monto_descuento, estado)
         VALUES ($1,$2,$3,$4,$5,$6,'reservada')
         ON CONFLICT (negocio_id, promocion_id, pedido_folio) DO NOTHING`,
        [nid, ap.id, ap.campaniaId || null, folio, datos?.cliente?.telefono || null,
         ap.descuento || 0]);
      reservadas.push(ap);
    }

    // ── EL RESULTADO EFECTIVO, solo con lo que quedo reservado ──────────
    const descuentoFinal = Math.round(
      reservadas.reduce((n, x) => n + (Number(x.descuento) || 0), 0) * 100) / 100;
    // Envio gratis solo si la promocion que lo daba sobrevivio al reclamo.
    const envioGratisFinal = reservadas.some(x => x.envioGratis === true);
    const envioFinal = envioGratisFinal ? 0 : envio;
    const ahorroFinal = Math.round((descuentoFinal + (envioGratisFinal ? envio : 0)) * 100) / 100;
    const totalNuevo = Math.max(0, Math.round((base - descuentoFinal + envioFinal) * 100) / 100);

    // Y AHORA la version, sobre el total que de verdad se va a escribir. Se
    // estampa en todas las reservas que sobrevivieron, dentro de la misma
    // transaccion: o todas llevan la version del precio final, o ninguna.
    const versionFinal = calcularVersionPedidoHash({ total: totalNuevo, modalidad: datos?.modalidad });
    if (reservadas.length) {
      await client.query(
        `UPDATE tienda_promocion_usos SET pedido_version = $3
          WHERE negocio_id = $1 AND pedido_folio = $2 AND estado = 'reservada'`,
        [nid, folio, versionFinal]);
    }

    await client.query(
      `UPDATE pedidos_activos
          SET datos = (datos || $3::jsonb)
                      || jsonb_build_object('tienda',
                           ((datos->'tienda') - 'promocion_recalculo_pendiente'
                                              - 'promocion_recalculo_motivo'
                                              - 'promocion_recalculo_version'
                                              - 'promocion_recalculo_promociones'
                                              - 'promocion_recalculo_at')
                           || $4::jsonb),
              updated_at = NOW()
        WHERE folio = $1 AND negocio_id = $2`,
      [folio, nid,
       JSON.stringify({
         subtotal: base,
         descuento: descuentoFinal,
         costo_envio: envioFinal,
         total: totalNuevo,
       }),
       JSON.stringify({
         promociones: reservadas.map(x => ({
           id: x.id, nombre: x.nombre, codigo: x.codigo, tipo: x.tipo,
           descuento: x.descuento, envio_gratis: x.envioGratis, campania_id: x.campaniaId,
         })),
         ahorro: ahorroFinal,
         envio_gratis: envioGratisFinal,
         envio_base: envio,
       })]);

    await client.query('COMMIT');
    console.log(`[Promos] Pedido ${folio} recalculado: total ${totalNuevo} con ${reservadas.length} promocion(es)`);
    return {
      ok: true, total: totalNuevo, descuento: descuentoFinal, envio: envioFinal,
      envioGratis: envioGratisFinal, ahorro: ahorroFinal, version: versionFinal,
      promociones: reservadas.map(x => x.id),
      perdidas: promo.aplicadas.filter(x => !reservadas.includes(x)).map(x => x.id),
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Promos] Error recalculando el pedido:', e.message);
    return { ok: false, razon: 'error_recalculando' };
  } finally {
    client.release();
  }
}

// ── CRUD de promociones (backoffice) ──────────────────────────────────────
const TIPOS = ['envio_gratis', 'porcentaje', 'monto_fijo', '2x1', 'segundo_descuento'];
const TIPOS_POR_UNIDAD = new Set(['2x1', 'segundo_descuento']);

export async function listarPromociones(negocioId) {
  const { rows } = await pool.query(
    `SELECT p.*, c.nombre AS campania_nombre, c.influencer,
            COALESCE(u.ventas, 0) AS ventas_generadas,
            COALESCE(u.descuento, 0) AS descuento_otorgado,
            COALESCE(u.n, 0) AS usos_reales,
            COALESCE(u.nuevos, 0) AS clientes_nuevos,
            COALESCE(rsv.n, 0) AS reservas_activas
       FROM tienda_promociones p
       LEFT JOIN tienda_campanas c ON c.id = p.campania_id
       -- Solo cuentan los usos CONSUMIDOS. Una reserva es un cupo apartado por
       -- un checkout que todavia puede no pagarse nunca: contarla como venta
       -- inflaba los ingresos del negocio con dinero que no entro. Las
       -- reservas vivas se reportan aparte, como lo que son.
       LEFT JOIN (
         SELECT promocion_id, COUNT(*)::int AS n,
                SUM(monto_venta)::numeric AS ventas,
                SUM(monto_descuento)::numeric AS descuento,
                COUNT(*) FILTER (WHERE cliente_nuevo)::int AS nuevos
           FROM tienda_promocion_usos
          WHERE negocio_id = $1 AND estado = 'consumida'
          GROUP BY promocion_id
       ) u ON u.promocion_id = p.id
       LEFT JOIN (
         SELECT promocion_id, COUNT(*)::int AS n
           FROM tienda_promocion_usos
          WHERE negocio_id = $1 AND estado = 'reservada'
          GROUP BY promocion_id
       ) rsv ON rsv.promocion_id = p.id
      WHERE p.negocio_id = $1
      ORDER BY p.activa DESC, p.created_at DESC`,
    [negocioId]
  );
  return rows.map(r => ({
    id: r.id, nombre: r.nombre, tipo: r.tipo, codigo: r.codigo,
    automatica: r.automatica, valor: Number(r.valor),
    cantidadRequerida: r.cantidad_requerida == null ? null : Number(r.cantidad_requerida),
    cantidadBeneficiada: r.cantidad_beneficiada == null ? null : Number(r.cantidad_beneficiada),
    maxAplicaciones: r.max_aplicaciones == null ? null : Number(r.max_aplicaciones),
    canales: Array.isArray(r.canales) ? r.canales : (r.canales ? JSON.parse(r.canales) : ['tienda_online']),
    categorias: Array.isArray(r.categorias) ? r.categorias : (r.categorias ? JSON.parse(r.categorias) : null),
    productos: Array.isArray(r.productos) ? r.productos : (r.productos ? JSON.parse(r.productos) : null),
    condicionesModificadores: Array.isArray(r.condiciones_modificadores) ? r.condiciones_modificadores : (r.condiciones_modificadores ? JSON.parse(r.condiciones_modificadores) : null),
    diasSemana: Array.isArray(r.dias_semana) ? r.dias_semana : (r.dias_semana ? JSON.parse(r.dias_semana) : null),
    horaInicio: r.hora_inicio || null, horaFin: r.hora_fin || null,
    minimoCompra: Number(r.minimo_compra), maxDescuento: r.max_descuento == null ? null : Number(r.max_descuento),
    vigenciaDesde: r.vigencia_desde, vigenciaHasta: r.vigencia_hasta,
    limiteUsos: r.limite_usos, limitePorCliente: r.limite_por_cliente,
    soloPrimeraCompra: r.solo_primera_compra, acumulable: r.acumulable, prioridad: r.prioridad,
    activa: r.activa,
    campania: r.campania_id ? { id: r.campania_id, nombre: r.campania_nombre, influencer: r.influencer } : null,
    metricas: {
      usos: Number(r.usos_reales),
      // Cupos apartados por un checkout todavia sin pagar. Cuentan contra el
      // limite disponible, pero NO son ventas.
      reservasActivas: Number(r.reservas_activas),
      ventas: Number(r.ventas_generadas),
      descuento: Number(r.descuento_otorgado),
      clientesNuevos: Number(r.clientes_nuevos),
      ticketPromedio: Number(r.usos_reales) ? dinero(Number(r.ventas_generadas) / Number(r.usos_reales)) : 0,
    },
  }));
}

export async function guardarPromocion(negocioId, datos = {}, promocionId = null) {
  const tipo = String(datos.tipo || '').trim();
  if (!TIPOS.includes(tipo)) throw new PromocionError('Tipo de promoción inválido', 'TIPO_INVALIDO');
  const nombre = String(datos.nombre || '').trim();
  if (!nombre) throw new PromocionError('La promoción necesita un nombre', 'SIN_NOMBRE');

  const automatica = !!datos.automatica;
  let codigo = String(datos.codigo || '').trim().toUpperCase() || null;
  if (!automatica && !codigo) throw new PromocionError('Una promoción con código necesita el código', 'SIN_CODIGO');
  if (codigo && !/^[A-Z0-9][A-Z0-9._-]{1,29}$/.test(codigo)) {
    throw new PromocionError('El código solo admite letras, números, punto, guion y guion bajo', 'CODIGO_INVALIDO');
  }
  if (automatica) codigo = codigo || null;

  const valor = Number(datos.valor) || 0;
  if (tipo === 'porcentaje' && (valor <= 0 || valor > 100)) {
    throw new PromocionError('El porcentaje debe estar entre 1 y 100', 'VALOR_INVALIDO');
  }
  if (tipo === 'monto_fijo' && valor <= 0) {
    throw new PromocionError('El descuento debe ser mayor a cero', 'VALOR_INVALIDO');
  }
  if (tipo === 'segundo_descuento' && (valor <= 0 || valor > 100)) {
    throw new PromocionError('El porcentaje del segundo producto debe estar entre 1 y 100', 'VALOR_INVALIDO');
  }

  // Cardinalidad de los tipos per-unit (2x1 / segundo producto). Defaults
  // sensatos: comprar 2, beneficiar 1. Nunca beneficiar más de lo requerido.
  let cantidadRequerida = null, cantidadBeneficiada = null, maxAplicaciones = null;
  if (TIPOS_POR_UNIDAD.has(tipo)) {
    cantidadRequerida = Number.isInteger(Number(datos.cantidadRequerida)) && Number(datos.cantidadRequerida) >= 1
      ? Number(datos.cantidadRequerida) : 2;
    cantidadBeneficiada = Number.isInteger(Number(datos.cantidadBeneficiada)) && Number(datos.cantidadBeneficiada) >= 1
      ? Number(datos.cantidadBeneficiada) : 1;
    if (cantidadBeneficiada > cantidadRequerida) {
      throw new PromocionError('La cantidad beneficiada no puede exceder la requerida', 'CARDINALIDAD_INVALIDA');
    }
    if (datos.maxAplicaciones != null && datos.maxAplicaciones !== '') {
      const m = parseInt(datos.maxAplicaciones, 10);
      if (!Number.isInteger(m) || m < 1) throw new PromocionError('El máximo de aplicaciones debe ser un entero ≥ 1', 'CARDINALIDAD_INVALIDA');
      maxAplicaciones = m;
    }
  }

  const campos = {
    nombre, tipo, codigo, automatica, valor,
    cantidad_requerida: cantidadRequerida,
    cantidad_beneficiada: cantidadBeneficiada,
    max_aplicaciones: maxAplicaciones,
    minimo_compra: Math.max(0, Number(datos.minimoCompra) || 0),
    max_descuento: datos.maxDescuento == null || datos.maxDescuento === '' ? null : Number(datos.maxDescuento),
    vigencia_desde: datos.vigenciaDesde || null,
    vigencia_hasta: datos.vigenciaHasta || null,
    dias_semana: datos.diasSemana ? JSON.stringify(datos.diasSemana.map(Number)) : null,
    hora_inicio: datos.horaInicio || null,
    hora_fin: datos.horaFin || null,
    limite_usos: datos.limiteUsos == null || datos.limiteUsos === '' ? null : parseInt(datos.limiteUsos, 10),
    limite_por_cliente: datos.limitePorCliente == null || datos.limitePorCliente === '' ? null : parseInt(datos.limitePorCliente, 10),
    solo_primera_compra: !!datos.soloPrimeraCompra,
    canales: JSON.stringify(Array.isArray(datos.canales) && datos.canales.length ? datos.canales : ['tienda_online']),
    modalidades: datos.modalidades ? JSON.stringify(datos.modalidades) : null,
    productos: datos.productos ? JSON.stringify(datos.productos.map(Number)) : null,
    categorias: datos.categorias ? JSON.stringify(datos.categorias.map(Number)) : null,
    acumulable: datos.acumulable !== false,
    prioridad: Number.isFinite(Number(datos.prioridad)) ? Number(datos.prioridad) : 100,
    activa: datos.activa !== false,
    campania_id: datos.campaniaId || null,
  };

  // La campaña debe ser del MISMO negocio: nunca se atribuye a la campaña de otro.
  if (campos.campania_id) {
    const { rows } = await pool.query(
      `SELECT 1 FROM tienda_campanas WHERE id = $1 AND negocio_id = $2`,
      [campos.campania_id, negocioId]);
    if (!rows.length) throw new PromocionError('La campaña no pertenece a este negocio', 'CAMPANIA_AJENA');
  }

  // Los productos participantes deben ser del MISMO negocio: nunca se asocia el
  // producto de otro. La UI solo ofrece los propios; esto lo hace fail-closed
  // también ante una petición manipulada (aislamiento estricto por negocio).
  if (Array.isArray(datos.productos) && datos.productos.length) {
    const ids = [...new Set(datos.productos.map(Number).filter(Number.isInteger))];
    if (ids.length) {
      const { rows } = await pool.query(
        `SELECT id FROM menu_productos WHERE id = ANY($1) AND negocio_id = $2`,
        [ids, negocioId]);
      if (rows.length !== ids.length) {
        throw new PromocionError('Uno o más productos no pertenecen a este negocio', 'PRODUCTO_AJENO');
      }
    }
  }

  // Condiciones por MODIFICADORES: validación fail-closed y aislamiento estricto.
  // Cada condición referencia IDs REALES del propio negocio; una petición
  // manipulada nunca puede crear condiciones cross-tenant ni sobre un producto
  // que no participa.
  campos.condiciones_modificadores = null;
  if (Array.isArray(datos.condicionesModificadores) && datos.condicionesModificadores.length) {
    const OPERADORES = new Set(['una_de', 'incluye', 'cantidad']);
    const participantes = new Set((Array.isArray(datos.productos) ? datos.productos : []).map(Number));
    if (!participantes.size) throw new PromocionError('Las condiciones requieren productos participantes', 'CONDICION_SIN_PRODUCTO');
    const gruposPorProd = await cargarGruposDeProductos(negocioId, [...participantes]);
    const norm = [];
    for (const c of datos.condicionesModificadores) {
      const productoId = Number(c?.productoId ?? c?.producto_id);
      const grupoId = Number(c?.grupoId ?? c?.grupo_id);
      const operador = String(c?.operador || '');
      if (!OPERADORES.has(operador)) throw new PromocionError('Operador de condición inválido', 'CONDICION_INVALIDA');
      if (!participantes.has(productoId)) throw new PromocionError('La condición referencia un producto que no participa', 'CONDICION_PRODUCTO_AJENO');
      const grupo = (gruposPorProd.get(productoId) || []).find(g => Number(g.id) === grupoId);
      if (!grupo) throw new PromocionError('El grupo de modificadores no pertenece al producto', 'CONDICION_GRUPO_AJENO');
      const opcionesValidas = new Set((grupo.opciones || []).map(o => Number(o.id)));
      const optionIds = [...new Set((Array.isArray(c.optionIds ?? c.option_ids) ? (c.optionIds ?? c.option_ids) : []).map(Number).filter(Number.isInteger))];
      for (const id of optionIds) {
        if (!opcionesValidas.has(id)) throw new PromocionError('Una opción no pertenece al grupo del producto', 'CONDICION_OPCION_AJENA');
      }
      let min = c.min != null && c.min !== '' ? parseInt(c.min, 10) : null;
      let max = c.max != null && c.max !== '' ? parseInt(c.max, 10) : null;
      if (operador === 'cantidad') {
        if (min == null && max == null) throw new PromocionError('La condición de cantidad necesita min o max', 'CONDICION_INVALIDA');
        if (min != null && (!Number.isInteger(min) || min < 0)) throw new PromocionError('El mínimo de la condición es inválido', 'CONDICION_INVALIDA');
        if (max != null && (!Number.isInteger(max) || max < 0)) throw new PromocionError('El máximo de la condición es inválido', 'CONDICION_INVALIDA');
        if (min != null && max != null && min > max) throw new PromocionError('El mínimo no puede exceder el máximo', 'CONDICION_INVALIDA');
      } else {
        if (!optionIds.length) throw new PromocionError('La condición necesita al menos una opción', 'CONDICION_INVALIDA');
        min = null; max = null;
      }
      norm.push({ producto_id: productoId, grupo_id: grupoId, operador, option_ids: optionIds, min, max });
    }
    campos.condiciones_modificadores = JSON.stringify(norm);
  }

  const cols = Object.keys(campos);
  const vals = cols.map(c => campos[c]);
  try {
    if (promocionId) {
      const { rowCount } = await pool.query(
        `UPDATE tienda_promociones SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}, updated_at = NOW()
          WHERE id = $1 AND negocio_id = $2`,
        [promocionId, negocioId, ...vals]
      );
      if (!rowCount) throw new PromocionError('Promoción no encontrada', 'NO_ENCONTRADA');
      return { id: promocionId };
    }
    const { rows } = await pool.query(
      `INSERT INTO tienda_promociones (negocio_id, ${cols.join(', ')})
       VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
      [negocioId, ...vals]
    );
    return { id: rows[0].id };
  } catch (e) {
    if (e.code === '23505') throw new PromocionError('Ya existe una promoción con ese código en este negocio', 'CODIGO_DUPLICADO');
    throw e;
  }
}

// Descripción HUMANA de las promociones automáticas de un negocio para una
// FECHA objetivo (`ahora`) y canal, pensada para informar al agente (nunca para
// calcular). El backend decide qué aplica; el agente solo lo verbaliza. Devuelve
//   [{ nombre, tipo, descripcion, participacion, participantesTexto, condicionesTexto, horaInicio, horaFin }].
// `minutos` (0-1439) activa el filtro por HORA del día: cuando es null se listan
// TODAS las promos de ese día (consulta "¿qué hay el miércoles?") informando su
// horario aparte; cuando trae una hora concreta se filtra por esa hora
// ("¿qué hay mañana a las 16:00?"). Aislamiento estricto por negocio; nunca IDs
// al LLM; el cálculo del descuento sigue 100% independiente (calcularPromociones).
export async function describirPromocionesParaFecha(negocioId, { canal = 'whatsapp', ahora = new Date(), timezone = 'America/Matamoros', minutos = null } = {}) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return [];
  // Normalización SOLO de forma: mayúsculas/espacios ('WhatsApp', ' WHATSAPP '
  // ⇒ 'whatsapp'). `undefined` ya tomó el default 'whatsapp' (compatibilidad).
  // Un canal null, '' o no-string es FAIL-CLOSED (devuelve vacío): NUNCA se
  // asume un canal — informar promos de un canal equivocado es peor que no
  // informar. El fix real es que cada caller pase su canal explícito
  // (whatsapp-meta ⇒ 'whatsapp'); ver procesarMensaje/webhook.
  if (typeof canal !== 'string') return [];
  const canalNorm = canal.trim().toLowerCase();
  if (!canalNorm) return [];
  const { rows } = await pool.query(
    `SELECT * FROM tienda_promociones WHERE negocio_id = $1 AND activa = TRUE AND automatica = TRUE
      ORDER BY prioridad ASC, created_at ASC`, [negocioId]);

  // 1) Filtrar a las vigentes AHORA para este canal (criterio idéntico al previo).
  const vigentes = [];
  for (const p of rows) {
    const canales = Array.isArray(p.canales) ? p.canales : ['tienda_online'];
    if (!canales.includes(canalNorm)) continue;
    // Solo el filtro temporal/estructural, no el de carrito (aquí no hay carrito).
    if (p.vigencia_desde && ahora < new Date(p.vigencia_desde)) continue;
    if (p.vigencia_hasta && ahora > new Date(p.vigencia_hasta)) continue;
    const { diaSemana } = partesEnZona(ahora, timezone);
    if (Array.isArray(p.dias_semana) && p.dias_semana.length && !p.dias_semana.map(Number).includes(diaSemana)) continue;
    // Filtro por HORA solo cuando se consulta una hora concreta (minutos != null).
    // En una consulta por DÍA (minutos == null) se listan todas las del día y su
    // horario se informa aparte — así "¿qué hay mañana?" a las 16:42 no descarta
    // una promo de 00:00–15:00 (pero "¿mañana a las 16:00?" sí la excluiría).
    if (minutos != null) {
      const aMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
      const ini = aMin(p.hora_inicio), fin = aMin(p.hora_fin);
      if (ini !== null && fin !== null && (minutos < ini || minutos >= fin)) continue;
    }
    vigentes.push(p);
  }
  if (!vigentes.length) return [];

  // 2) Resolver NOMBRES de participantes en 2 queries batch, SIEMPRE acotadas a
  // este negocio (aislamiento estricto: jamás nombres de otro business_id).
  const numeros = (v) => (Array.isArray(v) ? v : []).map(Number).filter(Number.isInteger);
  const prodIds = [...new Set(vigentes.flatMap((p) => numeros(p.productos)))];
  const catIds = [...new Set(vigentes.flatMap((p) => numeros(p.categorias)))];
  const prodNombre = new Map(), catNombre = new Map();
  if (prodIds.length) {
    const { rows: pr } = await pool.query(
      `SELECT id, nombre FROM menu_productos WHERE negocio_id = $1 AND id = ANY($2)`, [negocioId, prodIds]);
    for (const r of pr) prodNombre.set(Number(r.id), r.nombre);
  }
  if (catIds.length) {
    const { rows: cr } = await pool.query(
      `SELECT id, nombre FROM menu_categorias WHERE negocio_id = $1 AND id = ANY($2)`, [negocioId, catIds]);
    for (const r of cr) catNombre.set(Number(r.id), r.nombre);
  }

  // 2b) Grupos+opciones de los productos que tienen CONDICIONES, para describir
  // las restricciones legibles (Salsa Roja o Verde, Pollo, 2 guarniciones…).
  // Acotado por negocio: nunca nombres de otro tenant.
  const condProdIds = [...new Set(vigentes.flatMap((p) =>
    (Array.isArray(p.condiciones_modificadores) ? p.condiciones_modificadores : [])
      .map((c) => Number(c?.producto_id)).filter(Number.isInteger)))];
  let gruposPorProd = new Map();
  if (condProdIds.length) {
    try { gruposPorProd = await cargarGruposDeProductos(negocioId, condProdIds); }
    catch { gruposPorProd = new Map(); }
  }

  // 3) Construir la salida. Un ID que ya no existe se IGNORA (no se inventa
  // nombre) y se deja rastro; la promo NO desaparece por ello.
  const out = [];
  for (const p of vigentes) {
    const ids = numeros(p.productos), cats = numeros(p.categorias);
    let participacion;
    if (ids.length) {
      const nombres = [];
      for (const id of ids) {
        if (prodNombre.has(id)) nombres.push(prodNombre.get(id));
        else console.warn(`[Promos] producto participante ${id} (promo ${p.id}, negocio ${negocioId}) no existe en el menú — se ignora`);
      }
      participacion = { modo: 'productos', nombres };
    } else if (cats.length) {
      const nombres = [];
      for (const id of cats) {
        if (catNombre.has(id)) nombres.push(catNombre.get(id));
        else console.warn(`[Promos] categoría participante ${id} (promo ${p.id}, negocio ${negocioId}) no existe — se ignora`);
      }
      participacion = { modo: 'categorias', nombres };
    } else {
      participacion = { modo: 'todo', nombres: [] };
    }
    const condicionesTexto = fraseCondiciones(p.condiciones_modificadores, gruposPorProd);
    const participantesTexto = [fraseParticipantes(participacion), condicionesTexto].filter(Boolean).join(' ');
    out.push({
      nombre: p.nombre, tipo: p.tipo, descripcion: descripcionLegiblePromo(p),
      participacion, participantesTexto, condicionesTexto,
      horaInicio: p.hora_inicio || null, horaFin: p.hora_fin || null,
    });
  }
  return out;
}

// AHORA: promociones vigentes en este instante (aplica el filtro de la hora
// actual). Es el caso que ya se inyecta en el prompt del agente; mantiene el
// comportamiento previo intacto (regresión). Delega en describirPromocionesParaFecha.
export async function describirPromocionesVigentes(negocioId, opts = {}) {
  const timezone = opts.timezone || 'America/Matamoros';
  const ahora = opts.ahora || new Date();
  let minutos = null;
  try { minutos = partesEnZona(ahora, timezone).minutos; } catch { minutos = null; }
  return describirPromocionesParaFecha(negocioId, { ...opts, ahora, timezone, minutos });
}

// Respuesta HUMANA (redactada por CÓDIGO, no por el modelo) a una consulta de
// promociones para una fecha/día: "¿qué hay mañana?", "¿el miércoles?", "¿esta
// semana?". Resuelve la expresión temporal en la TZ del negocio y consulta el
// módulo estructurado (describirPromocionesParaFecha), reutilizando la misma
// descripción de participantes/condiciones. Devuelve el texto, o null si la
// expresión no se pudo resolver (el caller pedirá aclaración). Solo informa lo
// que Xabor realmente tiene; jamás inventa ni usa memoria del modelo.
export async function responderConsultaPromos(negocioId, cuando, { canal = 'whatsapp', ahora = new Date(), timezone = 'America/Matamoros' } = {}) {
  const r = resolverCuandoPromo(cuando, { ahora, timezone });
  if (!r.ok) return null;
  const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  const hhmm = (t) => String(t || '').slice(0, 5);

  if (r.esSemana) {
    const vistos = new Set();
    const bloques = [];
    for (const d of r.dias) {
      const promos = await describirPromocionesParaFecha(negocioId, { canal, ahora: d.ahora, timezone, minutos: null });
      const nuevos = promos.filter((p) => !vistos.has(p.nombre));
      nuevos.forEach((p) => vistos.add(p.nombre));
      if (nuevos.length) bloques.push(`${cap(d.diaNombre)}: ${nuevos.map((p) => p.nombre).join(', ')}`);
    }
    if (!bloques.length) return 'Esta semana no tenemos promociones programadas.';
    return 'Promociones de esta semana:\n' + bloques.join('\n');
  }

  const d = r.dias[0];
  const promos = await describirPromocionesParaFecha(negocioId, { canal, ahora: d.ahora, timezone, minutos: r.minutos });
  const cuandoTxt = d.etiqueta ? `${d.etiqueta} ${d.diaNombre}` : `el ${d.diaNombre}`;
  if (!promos.length) {
    return r.minutos != null
      ? `Para ${cuandoTxt} a esa hora no tenemos una promoción disponible.`
      : `Para ${cuandoTxt} no tenemos promociones programadas.`;
  }
  const lineas = [`Para ${cuandoTxt} tenemos:`];
  for (const p of promos) {
    let l = `🔥 ${p.nombre}: ${p.descripcion}`;
    if (p.participantesTexto) l += ` ${p.participantesTexto}`;
    if (r.minutos == null && p.horaInicio && p.horaFin) l += ` (horario ${hhmm(p.horaInicio)}–${hhmm(p.horaFin)})`;
    lineas.push(l);
  }
  return lineas.join('\n');
}

// Frase legible de las condiciones por modificadores de una promo, resolviendo
// grupo/opción a NOMBRES (nunca IDs). Ej: "Participan los preparados con: Salsa
// Roja o Verde; Proteína Pollo; 2 en Guarniciones sencillas."
function fraseCondiciones(condiciones, gruposPorProd) {
  const cond = Array.isArray(condiciones) ? condiciones : [];
  const partes = [];
  for (const c of cond) {
    const grupos = gruposPorProd.get(Number(c?.producto_id)) || [];
    const grupo = grupos.find((g) => Number(g.id) === Number(c?.grupo_id));
    if (!grupo) continue;
    const nombreOp = (id) => (grupo.opciones || []).find((o) => Number(o.id) === Number(id))?.nombre;
    const opts = (Array.isArray(c.option_ids) ? c.option_ids : []).map(nombreOp).filter(Boolean);
    if (c.operador === 'una_de' && opts.length) {
      partes.push(`${grupo.nombre} ${opts.length === 1 ? opts[0] : opts.slice(0, -1).join(', ') + ' o ' + opts[opts.length - 1]}`);
    } else if (c.operador === 'incluye' && opts.length) {
      partes.push(`${grupo.nombre} ${listaLegible(opts)}`);
    } else if (c.operador === 'cantidad') {
      const min = c.min != null ? Number(c.min) : null, max = c.max != null ? Number(c.max) : null;
      let q = '';
      if (min != null && max != null) q = min === max ? `${min}` : `entre ${min} y ${max}`;
      else if (min != null) q = `al menos ${min}`;
      else if (max != null) q = `hasta ${max}`;
      if (q) partes.push(`${q} en ${grupo.nombre}`);
    }
  }
  return partes.length ? `Participan los preparados con: ${partes.join('; ')}.` : '';
}

// Une nombres en lenguaje natural: "A", "A y B", "A, B y C".
function listaLegible(arr) {
  if (!arr.length) return '';
  if (arr.length === 1) return String(arr[0]);
  return arr.slice(0, -1).join(', ') + ' y ' + arr[arr.length - 1];
}

// Frase de participantes para el prompt (solo nombres, nunca IDs).
export function fraseParticipantes({ modo, nombres } = {}) {
  if (modo === 'todo') return 'Aplica a todo el menú.';
  if (modo === 'categorias') {
    return nombres && nombres.length ? `Categorías participantes: ${listaLegible(nombres)}.` : 'Aplica a categorías específicas.';
  }
  // 'productos' (default)
  return nombres && nombres.length ? `Productos participantes: ${listaLegible(nombres)}.` : 'Aplica a productos específicos.';
}

// Frase legible por tipo (sin jerga técnica). No calcula nada: solo describe.
export function descripcionLegiblePromo(p) {
  const X = Number(p.cantidad_requerida) >= 1 ? Number(p.cantidad_requerida) : 2;
  switch (p.tipo) {
    case '2x1': return `Compra ${X} productos participantes y el de menor precio va gratis.`;
    case 'segundo_descuento': return `Compra ${X} productos participantes y el de menor precio lleva ${Number(p.valor)}% de descuento.`;
    case 'porcentaje': return `${Number(p.valor)}% de descuento en los productos participantes.`;
    case 'monto_fijo': return `$${Number(p.valor)} de descuento cuando aplica.`;
    case 'envio_gratis': return 'Envío gratis cuando se cumplen las condiciones.';
    default: return p.nombre;
  }
}

export async function eliminarPromocion(negocioId, promocionId) {
  const { rowCount } = await pool.query(
    `UPDATE tienda_promociones SET activa = FALSE, updated_at = NOW()
      WHERE id = $1 AND negocio_id = $2`,
    [promocionId, negocioId]
  );
  return rowCount > 0;
}

// ── Campañas / influencers ────────────────────────────────────────────────
export async function listarCampanas(negocioId) {
  const { rows } = await pool.query(
    `SELECT c.*,
            COALESCE(u.n, 0) AS usos, COALESCE(u.ventas, 0) AS ventas,
            COALESCE(u.descuento, 0) AS descuento, COALESCE(u.nuevos, 0) AS clientes_nuevos
       FROM tienda_campanas c
       LEFT JOIN (
         SELECT campania_id, COUNT(*)::int AS n, SUM(monto_venta)::numeric AS ventas,
                SUM(monto_descuento)::numeric AS descuento,
                COUNT(*) FILTER (WHERE cliente_nuevo)::int AS nuevos
           FROM tienda_promocion_usos
          WHERE negocio_id = $1 AND campania_id IS NOT NULL AND estado = 'consumida'
          GROUP BY campania_id
       ) u ON u.campania_id = c.id
      WHERE c.negocio_id = $1
      ORDER BY c.activa DESC, c.created_at DESC`,
    [negocioId]
  );
  return rows.map(c => ({
    id: c.id, nombre: c.nombre, influencer: c.influencer, contacto: c.contacto,
    notas: c.notas, activa: c.activa,
    metricas: {
      usos: Number(c.usos), ventas: Number(c.ventas), descuento: Number(c.descuento),
      clientesNuevos: Number(c.clientes_nuevos),
      clientesRecurrentes: Number(c.usos) - Number(c.clientes_nuevos),
      ticketPromedio: Number(c.usos) ? dinero(Number(c.ventas) / Number(c.usos)) : 0,
    },
  }));
}

export async function guardarCampana(negocioId, datos = {}, campaniaId = null) {
  const nombre = String(datos.nombre || '').trim();
  if (!nombre) throw new PromocionError('La campaña necesita un nombre', 'SIN_NOMBRE');
  const campos = {
    nombre,
    influencer: String(datos.influencer || '').trim() || null,
    contacto: String(datos.contacto || '').trim() || null,
    notas: String(datos.notas || '').trim() || null,
    activa: datos.activa !== false,
  };
  const cols = Object.keys(campos);
  const vals = cols.map(c => campos[c]);
  try {
    if (campaniaId) {
      const { rowCount } = await pool.query(
        `UPDATE tienda_campanas SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}, updated_at = NOW()
          WHERE id = $1 AND negocio_id = $2`,
        [campaniaId, negocioId, ...vals]);
      if (!rowCount) throw new PromocionError('Campaña no encontrada', 'NO_ENCONTRADA');
      return { id: campaniaId };
    }
    const { rows } = await pool.query(
      `INSERT INTO tienda_campanas (negocio_id, ${cols.join(', ')})
       VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
      [negocioId, ...vals]);
    return { id: rows[0].id };
  } catch (e) {
    if (e.code === '23505') throw new PromocionError('Ya existe una campaña con ese nombre', 'NOMBRE_DUPLICADO');
    throw e;
  }
}
