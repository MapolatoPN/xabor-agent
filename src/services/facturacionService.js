import { pool, guardarClienteFiscal, registrarFacturaEmitida } from './database.js';
import { validarDatosFiscales } from './autofacturaFiscal.js';
import {
  crearRecibo, obtenerRecibo, obtenerFactura, facturarRecibo,
  enviarFacturaPorEmail, puedeFacturar, verificarAccesoFacturapi, FacturapiNoConfiguradoError,
} from './facturapi.js';
import { enBarridoFacturapi, puedeLlamarFacturapi, FacturapiRitmoError } from './facturapiRitmo.js';
import {
  configPlazo, plazoDeVenta, sqlLimitePlazo, mensajePlazoVencido, MENSAJE_EN_GLOBAL, GLOBAL_DESDE_POR_OMISION,
} from './plazoFacturacion.js';
import { completarUuidsPendientes, respaldoRecibosPorLista } from './facturapiWebhook.js';

export class FacturacionError extends Error {
  constructor(message, codigo, status = 400) {
    super(message);
    this.name = 'FacturacionError';
    this.codigo = codigo;
    this.status = status;
  }
}

export function normalizarFolioFactura(valor) {
  const v = String(valor || '').trim().toUpperCase().replace(/\s+/g, '-');
  // Solo normaliza si TODA la entrada es un folio numérico XAB. Antes la
  // expresión aceptaba cualquier texto terminado en dígitos, por ejemplo
  // `VENTA-ABC-207`, y lo convertía silenciosamente en `XAB-0207`.
  const m = v.match(/^(?:(?:XAB|FOLIO|PEDIDO)[- ]?)?(\d{1,8})$/);
  if (m && !v.startsWith('RM-')) return `XAB-${m[1].padStart(4, '0')}`;
  return v.replace(/[^A-Z0-9-]/g, '');
}

// Una venta pagada puede vivir temporalmente en `pedidos_programados`: la
// reserva sale de `pedidos_activos` al confirmarse y solo vuelve a entrar una
// hora antes de su entrega. Facturacion no puede confundir esa ausencia del
// tablero operativo con una venta inexistente. La prioridad evita elegir dos
// fotografias durante la breve ventana de activacion en que ambas filas pueden
// coexistir; la activa es la proyeccion mas reciente y por tanto gana.
const CANDIDATOS_FACTURACION_SQL = `
  SELECT folio, estado, datos, created_at, updated_at, entregado_at,
         'activo'::text AS origen, 0::int AS prioridad
    FROM pedidos_activos
   WHERE negocio_id=$1
  UNION ALL
  SELECT folio, COALESCE(NULLIF(datos->>'estado',''),'nuevo') AS estado,
         datos, created_at, NULL::timestamp AS updated_at,
         NULL::timestamptz AS entregado_at,
         'programado'::text AS origen, 1::int AS prioridad
    FROM pedidos_programados
   WHERE negocio_id=$1 AND activado=FALSE
`;

export async function obtenerConfiguracionFacturacion(negocioId) {
  const { rows } = await pool.query(
    `SELECT negocio_id, iva_tasa, autoemitir_recibo, clave_producto_restaurante,
            clave_producto_para_llevar, serie, plazo_tipo, plazo_dias,
            to_char(global_desde, 'YYYY-MM-DD') AS global_desde
       FROM facturacion_configuracion WHERE negocio_id = $1`, [negocioId]);
  return rows[0] || {
    negocio_id: negocioId, iva_tasa: null, autoemitir_recibo: true,
    clave_producto_restaurante: '90101501', clave_producto_para_llevar: '90101800', serie: null,
    plazo_tipo: 'fin_de_mes', plazo_dias: null, global_desde: GLOBAL_DESDE_POR_OMISION,
  };
}

export async function guardarConfiguracionFacturacion(negocioId, { ivaTasa, autoemitirRecibo, serie = null, plazoTipo, plazoDias } = {}) {
  const tasa = ivaTasa === null || ivaTasa === '' ? null : Number(ivaTasa);
  if (tasa !== null && ![0, 0.08, 0.16].includes(tasa)) {
    throw new FacturacionError('La tasa de IVA debe ser 0 %, 8 % o 16 %.', 'IVA_INVALIDO');
  }
  // Plazo: sin dato se conserva el que había (o el de fin de mes).
  let tipo = null, dias = null;
  if (plazoTipo !== undefined && plazoTipo !== null && plazoTipo !== '') {
    tipo = String(plazoTipo);
    if (!['fin_de_mes', 'dias'].includes(tipo)) throw new FacturacionError('El plazo debe ser fin de mes o un número de días.', 'PLAZO_INVALIDO');
    if (tipo === 'dias') {
      dias = Number.parseInt(plazoDias, 10);
      if (!(dias >= 1 && dias <= 365)) throw new FacturacionError('El plazo en días debe ser de 1 a 365.', 'PLAZO_INVALIDO');
    }
  }
  const { rows } = await pool.query(
    `INSERT INTO facturacion_configuracion (negocio_id, iva_tasa, autoemitir_recibo, serie, plazo_tipo, plazo_dias)
     VALUES ($1,$2,$3,$4,COALESCE($5,'fin_de_mes'),$6)
     ON CONFLICT (negocio_id) DO UPDATE SET
       iva_tasa=EXCLUDED.iva_tasa,
       autoemitir_recibo=EXCLUDED.autoemitir_recibo,
       serie=EXCLUDED.serie,
       plazo_tipo=COALESCE($5, facturacion_configuracion.plazo_tipo),
       plazo_dias=CASE WHEN $5 IS NULL THEN facturacion_configuracion.plazo_dias ELSE $6 END,
       updated_at=NOW()
     RETURNING *, to_char(global_desde, 'YYYY-MM-DD') AS global_desde`,
    [negocioId, tasa, autoemitirRecibo !== false, String(serie || '').trim() || null, tipo, dias]);
  return rows[0];
}

export async function obtenerPedidoFacturable(negocioId, folioEntrada) {
  const folio = normalizarFolioFactura(folioEntrada);
  const { rows } = await pool.query(
    `WITH candidatos AS (${CANDIDATOS_FACTURACION_SQL})
     SELECT folio, estado, datos, created_at, entregado_at, origen
       FROM candidatos
      WHERE upper(folio)=upper($2)
      ORDER BY prioridad ASC
      LIMIT 1`, [negocioId, folio]);
  const row = rows[0];
  if (!row) throw new FacturacionError('No encontré una venta con ese folio.', 'PEDIDO_NO_ENCONTRADO', 404);
  if (row.estado === 'cancelado') throw new FacturacionError('Un pedido cancelado no se puede facturar.', 'PEDIDO_CANCELADO', 409);
  const pedido = {
    folio: row.folio, ...(row.datos || {}),
    _estado: row.estado, _created_at: row.created_at, _origen: row.origen,
  };
  const pagado = pedido.origen === 'restaurante'
    || pedido.pago_confirmado === true
    || row.estado === 'entregado' && pedido.forma_pago !== 'por_cobrar';
  if (!pagado) throw new FacturacionError('El pedido todavía no aparece pagado.', 'PEDIDO_NO_PAGADO', 409);
  if (!Number.isFinite(Number(pedido.total)) || Number(pedido.total) <= 0) {
    throw new FacturacionError('La venta no tiene un total facturable.', 'TOTAL_NO_FACTURABLE', 409);
  }
  return pedido;
}

export async function obtenerUltimoPedidoFacturablePorTelefono(negocioId, telefono) {
  const tel = String(telefono || '').replace(/\D/g, '').slice(-10);
  if (!tel) return null;
  const { rows } = await pool.query(
    `WITH candidatos AS (${CANDIDATOS_FACTURACION_SQL})
     SELECT folio FROM candidatos
      WHERE estado <> 'cancelado'
        AND (
          right(regexp_replace(COALESCE(datos->>'telefono_conversacion',''), '\\D', '', 'g'),10)=$2
          OR right(regexp_replace(COALESCE(datos->'cliente'->>'telefono',''), '\\D', '', 'g'),10)=$2
        )
        AND (
          datos->>'origen'='restaurante'
          OR datos->>'pago_confirmado' = 'true'
          OR (estado='entregado' AND COALESCE(datos->>'forma_pago','') <> 'por_cobrar')
        )
      ORDER BY COALESCE(entregado_at, updated_at, created_at) DESC, prioridad ASC
      LIMIT 1`, [negocioId, tel]);
  return rows[0] ? obtenerPedidoFacturable(negocioId, rows[0].folio) : null;
}

export function pedidoPerteneceATelefono(pedido, telefono) {
  const ultimos10 = v => String(v || '').replace(/\D/g, '').slice(-10);
  const buscado = ultimos10(telefono);
  if (!buscado) return false;
  return [pedido?.telefono_conversacion, pedido?.cliente?.telefono, pedido?.telefono]
    .some(v => ultimos10(v) === buscado);
}

function configProveedor(c) {
  if (c.iva_tasa === null || c.iva_tasa === undefined) {
    throw new FacturacionError('Configura la tasa de IVA del negocio antes de emitir.', 'IVA_NO_CONFIGURADO', 409);
  }
  return {
    ivaTasa: Number(c.iva_tasa),
    claveRestaurante: c.clave_producto_restaurante,
    claveParaLlevar: c.clave_producto_para_llevar,
  };
}

function estadoLocalFacturapi(status) {
  return ({ open: 'abierto', invoiced_to_customer: 'facturado', invoiced_globally: 'global', canceled: 'cancelado' })[status] || 'abierto';
}

async function guardarRespuestaRecibo(negocioId, folio, remoto) {
  const totalRemoto = Number(remoto.total);
  const { rows: [local] } = await pool.query(
    `SELECT total FROM facturacion_recibos WHERE negocio_id=$1 AND folio=$2`, [negocioId, folio]);
  if (!local || !Number.isFinite(totalRemoto) || Math.abs(Number(local.total) - totalRemoto) > 0.01) {
    await pool.query(
      `UPDATE facturacion_recibos SET estado='error', error_codigo='TOTAL_DIVERGENTE',
        error_detalle=$3, updated_at=NOW() WHERE negocio_id=$1 AND folio=$2`,
      [negocioId, folio, `local=${local?.total ?? 'n/a'} remoto=${remoto.total ?? 'n/a'}`]);
    throw new FacturacionError('El total calculado por facturación no coincide con la venta. Se detuvo la emisión.', 'TOTAL_DIVERGENTE', 409);
  }
  const facturaId = typeof remoto.invoice === 'string' ? remoto.invoice : remoto.invoice?.id || null;
  // Un recibo que se canceló porque la venta se facturó por el portal de
  // Xabor (reciboTrasAutofactura.js) sigue `facturado` con ese CFDI.
  const { rows } = await pool.query(
    `UPDATE facturacion_recibos SET recibo_id=$3, clave=$4, url_autofactura=$5,
       expires_at=$6,
       estado=CASE WHEN $7='cancelado' AND estado='facturado' AND factura_id IS NOT NULL THEN 'facturado' ELSE $7 END,
       factura_id=COALESCE($8,factura_id),
       error_codigo=NULL, error_detalle=NULL, updated_at=NOW()
     WHERE negocio_id=$1 AND folio=$2 RETURNING *`,
    [negocioId, folio, remoto.id, remoto.key || null, remoto.self_invoice_url || null,
      remoto.expires_at || null, estadoLocalFacturapi(remoto.status), facturaId]);
  return rows[0];
}

export async function asegurarReciboPedido(negocioId, folioEntrada) {
  if (!(await puedeFacturar(negocioId))) throw new FacturapiNoConfiguradoError();
  const pedido = await obtenerPedidoFacturable(negocioId, folioEntrada);
  const config = await obtenerConfiguracionFacturacion(negocioId);
  const providerConfig = configProveedor(config);
  const folio = pedido.folio;
  const idempotencyKey = `xabor:${negocioId}:${folio}`;
  await pool.query(
    `INSERT INTO facturacion_recibos (negocio_id, folio, total, idempotency_key)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (negocio_id, folio) DO NOTHING`,
    [negocioId, folio, Number(pedido.total), idempotencyKey]);
  const { rows: [existente] } = await pool.query(
    `SELECT * FROM facturacion_recibos WHERE negocio_id=$1 AND folio=$2`, [negocioId, folio]);
  if (Number(existente.total) !== Number(pedido.total)) {
    throw new FacturacionError('La venta cambió después de preparar su recibo; requiere revisión.', 'TOTAL_CAMBIO', 409);
  }
  if (existente.recibo_id && ['abierto', 'facturado', 'global'].includes(existente.estado)) return existente;
  // Venta ya facturada por otro camino (el portal de Xabor timbra sin recibo):
  // crear el recibo ahora lo dejaría abierto para una segunda factura. Si el
  // recibo ya existe en Facturapi no se marca aquí: lo cancela el barrido de
  // reciboTrasAutofactura.js.
  const { rows: [previa] } = existente.recibo_id ? { rows: [] } : await pool.query(
    `SELECT factura_id, uuid FROM facturas_pedido
      WHERE negocio_id=$1 AND upper(folio)=upper($2) AND factura_id IS NOT NULL
      ORDER BY emitida_at DESC LIMIT 1`, [negocioId, folio]);
  if (previa) {
    const { rows: [marcado] } = await pool.query(
      `UPDATE facturacion_recibos SET estado='facturado', factura_id=$3, uuid=$4,
         error_codigo=NULL, error_detalle=NULL, updated_at=NOW()
       WHERE negocio_id=$1 AND folio=$2 RETURNING *`, [negocioId, folio, previa.factura_id, previa.uuid]);
    return marcado;
  }
  try {
    const remoto = await crearRecibo(negocioId, pedido, providerConfig);
    return await guardarRespuestaRecibo(negocioId, folio, remoto);
  } catch (e) {
    await pool.query(
      `UPDATE facturacion_recibos SET estado='error', error_codigo=$3, error_detalle=$4, updated_at=NOW()
       WHERE negocio_id=$1 AND folio=$2`,
      [negocioId, folio, e.codigo || 'FACTURAPI_ERROR', String(e.message || e).slice(0, 500)]).catch(() => {});
    throw e;
  }
}

export async function emitirFacturaPedido(negocioId, folioEntrada, datosEntrada, { fuente = 'panel' } = {}) {
  // Mismo validador que el portal (formato de RFC, catálogo SAT, régimen y
  // uso aplicables al tipo de persona y compatibles entre sí, CP): el navegador
  // del panel o de Mesas no es autoridad. El correo es opcional aquí.
  const v = validarDatosFiscales({ ...datosEntrada, nombre: datosEntrada?.nombre_fiscal ?? datosEntrada?.nombre }, { emailObligatorio: false });
  if (!v.ok) {
    throw Object.assign(
      new FacturacionError(`Datos fiscales inválidos: ${Object.values(v.errores).join(' ')}`, 'DATOS_FISCALES_INVALIDOS', 422),
      { errores: v.errores });
  }
  const datos = {
    ...datosEntrada, rfc: v.datos.rfc, nombre_fiscal: v.datos.nombre, regimen: v.datos.regimen,
    uso_cfdi: v.datos.uso_cfdi, cp: v.datos.cp, email: v.datos.email || null,
  };
  const pedido = await obtenerPedidoFacturable(negocioId, folioEntrada);
  // Antes de tocar Facturapi: una venta en una global o fuera de plazo ya no
  // se factura por separado (fase 2). Una ya facturada sigue devolviendo su
  // CFDI, como siempre.
  const { rows: [previo] } = await pool.query(
    `SELECT estado, factura_id FROM facturacion_recibos WHERE negocio_id=$1 AND folio=$2`, [negocioId, pedido.folio]);
  if (!(previo?.estado === 'facturado' && previo.factura_id)) {
    if (previo?.estado === 'global') throw new FacturacionError(MENSAJE_EN_GLOBAL, 'VENTA_EN_FACTURA_GLOBAL', 409);
    const plazo = await plazoDeVenta(negocioId, pedido.folio);
    if (plazo?.vencido) throw new FacturacionError(mensajePlazoVencido(plazo.ultimoDia), 'FUERA_DE_PLAZO', 409);
  }
  const recibo = await asegurarReciboPedido(negocioId, pedido.folio);
  if (recibo.estado === 'facturado' && recibo.factura_id) {
    return { yaEmitida: true, factura_id: recibo.factura_id, uuid: recibo.uuid, recibo };
  }
  if (recibo.estado !== 'abierto') {
    throw new FacturacionError(`El recibo está ${recibo.estado} y ya no admite esta emisión.`, 'RECIBO_NO_ABIERTO', 409);
  }
  const config = await obtenerConfiguracionFacturacion(negocioId);
  const factura = await facturarRecibo(negocioId, recibo.recibo_id, datos, { serie: config.serie });
  const facturaId = factura.id || factura.invoice?.id;
  const uuid = factura.uuid || factura.folio_fiscal || null;
  await pool.query(
    `UPDATE facturacion_recibos SET estado='facturado', factura_id=$3, uuid=$4,
       error_codigo=NULL, error_detalle=NULL, updated_at=NOW()
     WHERE negocio_id=$1 AND folio=$2`, [negocioId, pedido.folio, facturaId, uuid]);
  await registrarFacturaEmitida({ negocioId, folio: pedido.folio, facturaId, uuid, total: pedido.total, fuente });
  // El CFDI ya está timbrado en este punto. Un fallo posterior al guardar la
  // ficha fiscal no puede presentarse como si la emisión hubiera fallado.
  let ficha = null;
  try {
    ficha = await guardarClienteFiscal({
      negocioId, rfc: datos.rfc, razonSocial: datos.nombre_fiscal,
      regimen: datos.regimen, usoCfdi: datos.uso_cfdi, cp: datos.cp,
      email: datos.email, telefono: datos.telefono || pedido?.cliente?.telefono || pedido.telefono_conversacion,
    });
  } catch (e) {
    console.error(`[Facturacion] la factura ${facturaId} se emitio pero guardarClienteFiscal lanzo:`, e.message);
    throw Object.assign(
      new FacturacionError(`La factura se emitió, pero la ficha fiscal no se guardó: ${e.message}`, 'FICHA_NO_GUARDADA', 207),
      { facturaId, uuid },
    );
  }
  if (ficha?.error) {
    throw Object.assign(
      new FacturacionError(`La factura se emitió, pero la ficha fiscal no se guardó: ${ficha.error}`, 'FICHA_NO_GUARDADA', 207),
      { facturaId, uuid },
    );
  }
  if (datos.email && facturaId) await enviarFacturaPorEmail(negocioId, facturaId, datos.email).catch(() => {});
  return { yaEmitida: false, factura_id: facturaId, uuid, recibo, factura };
}

export async function sincronizarRecibo(negocioId, folioEntrada) {
  const folio = normalizarFolioFactura(folioEntrada);
  const { rows: [local] } = await pool.query(
    `SELECT * FROM facturacion_recibos WHERE negocio_id=$1 AND folio=$2`, [negocioId, folio]);
  // Un error de creación no siempre alcanza a guardar recibo_id (por
  // ejemplo, feature_not_available). La acción "Reintentar" vuelve a pasar
  // por el mismo camino idempotente y conserva el esquema existente.
  if (!local?.recibo_id) return local?.estado === 'error' ? asegurarReciboPedido(negocioId, folio) : (local || null);
  const remoto = await obtenerRecibo(negocioId, local.recibo_id);
  const actualizado = await guardarRespuestaRecibo(negocioId, folio, remoto);
  if (actualizado.estado === 'facturado' && actualizado.factura_id && !actualizado.uuid) {
    const factura = await obtenerFactura(negocioId, actualizado.factura_id);
    await pool.query(`UPDATE facturacion_recibos SET uuid=$3, updated_at=NOW() WHERE negocio_id=$1 AND folio=$2`,
      [negocioId, folio, factura.uuid || null]);
    await registrarFacturaEmitida({ negocioId, folio, facturaId: actualizado.factura_id, uuid: factura.uuid || null, total: local.total, fuente: 'autofactura' });
    actualizado.uuid = factura.uuid || null;
  }
  return actualizado;
}

// Una emisión registrada prevalece sobre un recibo pendiente desactualizado.
// Se conservan cancelaciones y globales; consultar no modifica documentos.
const RECIBOS_VISIBLES_SQL = `
 SELECT r.*,
   CASE WHEN f.factura_id IS NOT NULL THEN 'facturado' ELSE r.estado END AS estado_visible,
   COALESCE(f.factura_id,r.factura_id) AS factura_visible,
   COALESCE(f.uuid,r.uuid) AS uuid_visible
 FROM facturacion_recibos r
 LEFT JOIN LATERAL (
   SELECT factura_id,uuid FROM facturas_pedido f
   WHERE f.negocio_id=r.negocio_id AND upper(f.folio)=upper(r.folio)
     AND r.estado IN ('creando','abierto','error')
     AND f.factura_id IS NOT NULL AND f.uuid IS NOT NULL AND f.cancelada_at IS NULL
   ORDER BY f.emitida_at DESC,f.id DESC LIMIT 1
 ) f ON true WHERE r.negocio_id=$1
`;
const ESTADOS_RECIBO = new Set(['creando', 'abierto', 'facturado', 'global', 'cancelado', 'error']);

// Límite del plazo en el listado: $6 zona, $7 tipo, $8 días.
const LIMITE_PLAZO_LISTADO = sqlLimitePlazo(
  "COALESCE(p.created_at, pp.created_at) AT TIME ZONE 'UTC'", { tz: '$6', tipo: '$7', dias: '$8' });

/**
 * El estado que ve el administrador (fase 2), en lugar del «Pendiente»
 * genérico. Se calcula al leer: cambia solo cuando cambia el plazo, llega un
 * aviso de Facturapi o el cliente pide su factura.
 *   timbrada · cancelada · en_global · requiere_atencion · solicitada ·
 *   fuera_de_plazo · global_contador (fuera de plazo y anterior a la global
 *   de Xabor: la declara el contador) · sin_facturar
 */
export function estadoRealVenta(r) {
  if (r.estado === 'facturado') return 'timbrada';
  if (r.estado === 'cancelado') return 'cancelada';
  if (r.estado === 'global') return 'en_global';
  if (r.estado === 'error') return 'requiere_atencion';
  if (['emitiendo', 'error'].includes(r.autofactura_estado)
    || (r.autofactura_estado === 'vigente' && r.autofactura_intentada)) return 'solicitada';
  if (r.plazo_vencido) return r.antes_global_xabor ? 'global_contador' : 'fuera_de_plazo';
  return 'sin_facturar';
}

/**
 * Centro operativo de facturación.
 *
 * Es deliberadamente una lectura local: abrir el panel no llama a Facturapi
 * ni cambia estados. El operador puede pedir una sincronización puntual desde
 * una acción separada. Todas las consultas incluyen negocio_id para que una
 * sesión jamás vea recibos o CFDI de otro contribuyente.
 */
export async function listarRecibosFacturacion(negocioId, {
  busqueda = '', estado = '', limite = 50, offset = 0,
} = {}) {
  if (!negocioId) {
    throw new FacturacionError('Falta el contexto del negocio.', 'NEGOCIO_REQUERIDO', 400);
  }

  const estadoNormalizado = String(estado || '').trim().toLowerCase();
  if (estadoNormalizado && !ESTADOS_RECIBO.has(estadoNormalizado)) {
    throw new FacturacionError('El estado solicitado no es válido.', 'ESTADO_INVALIDO', 400);
  }
  const texto = String(busqueda || '').trim().slice(0, 100);
  const maximo = Math.min(Math.max(Number.parseInt(limite, 10) || 50, 1), 100);
  const salto = Math.min(Math.max(Number.parseInt(offset, 10) || 0, 0), 100000);
  const plazo = await configPlazo(negocioId);

  const [lista, resumen] = await Promise.all([
    pool.query(
      `WITH recibos_visibles AS (${RECIBOS_VISIBLES_SQL}), documentos AS (
         SELECT r.folio, r.estado_visible AS estado, r.total,
                CASE WHEN r.estado_visible='facturado' THEN NULL ELSE r.url_autofactura END AS url_autofactura, r.expires_at,
                r.factura_visible AS factura_id, r.uuid_visible AS uuid,
                CASE WHEN r.estado_visible='facturado' THEN NULL ELSE r.error_codigo END AS error_codigo,
                CASE WHEN r.estado_visible='facturado' THEN NULL ELSE r.error_detalle END AS error_detalle,
                r.created_at, r.updated_at, (r.recibo_id IS NOT NULL) AS sincronizable
           FROM recibos_visibles r
          WHERE r.negocio_id=$1
         UNION ALL
         SELECT f.folio, CASE WHEN f.cancelada_at IS NULL THEN 'facturado' ELSE 'cancelado' END::text, f.total, NULL::text, NULL::timestamptz,
                f.factura_id, f.uuid, NULL::text, NULL::text,
                f.emitida_at, f.emitida_at, false
           FROM facturas_pedido f
          WHERE f.negocio_id=$1
            AND NOT EXISTS (
              SELECT 1 FROM facturacion_recibos r
               WHERE r.negocio_id=f.negocio_id AND upper(r.folio)=upper(f.folio)
            )
       )
       SELECT r.folio, r.estado, r.total, r.url_autofactura, r.expires_at,
              r.factura_id, r.uuid, r.error_codigo, r.error_detalle,
              r.created_at, r.updated_at, r.sincronizable,
              -- Fecha real de la venta (los pedidos guardan created_at en UTC
              -- sin zona). created_at es cuándo se registró el recibo, que
              -- puede ser días después.
              COALESCE(p.created_at, pp.created_at) AT TIME ZONE 'UTC' AS venta_at,
              (SELECT max(f.emitida_at) FROM facturas_pedido f
                WHERE f.negocio_id=$1 AND upper(f.folio)=upper(r.folio)
                  AND f.factura_id IS NOT NULL AND f.cancelada_at IS NULL) AS timbrada_at,
              -- Plazo para facturarla (plazoFacturacion.js) y si es de antes
              -- de que Xabor haga la global.
              CASE WHEN COALESCE(p.created_at, pp.created_at) IS NULL THEN NULL
                   ELSE (now() AT TIME ZONE $6) >= ${LIMITE_PLAZO_LISTADO} END AS plazo_vencido,
              CASE WHEN COALESCE(p.created_at, pp.created_at) IS NULL THEN NULL
                   ELSE to_char(${LIMITE_PLAZO_LISTADO} - interval '1 microsecond', 'YYYY-MM-DD') END AS plazo_ultimo_dia,
              ((COALESCE(p.created_at, pp.created_at) AT TIME ZONE 'UTC') AT TIME ZONE $6)::date < $9::date AS antes_global_xabor,
              -- El cliente la pidió en el portal: liga emitiendo o con error,
              -- o con un intento rechazado que se reabrió para corregir.
              (SELECT a.estado FROM autofacturas a WHERE a.negocio_id=$1 AND upper(a.folio)=upper(r.folio)
                ORDER BY a.created_at DESC LIMIT 1) AS autofactura_estado,
              EXISTS (SELECT 1 FROM autofactura_intentos i WHERE i.negocio_id=$1 AND upper(i.folio)=upper(r.folio)) AS autofactura_intentada,
              COALESCE(NULLIF(p.datos->'cliente'->>'nombre',''),
                       NULLIF(p.datos->>'nombre_cliente',''),
                       NULLIF(p.datos->>'nombre',''),
                       NULLIF(pp.datos->'cliente'->>'nombre',''),
                       NULLIF(pp.datos->>'nombre_cliente',''),
                       NULLIF(pp.datos->>'nombre','')) AS cliente,
              COALESCE(NULLIF(p.datos->'cliente'->>'rfc',''),
                       NULLIF(p.datos->'cliente'->>'tax_id',''),
                       NULLIF(p.datos->>'rfc',''),
                       NULLIF(pp.datos->'cliente'->>'rfc',''),
                       NULLIF(pp.datos->'cliente'->>'tax_id',''),
                       NULLIF(pp.datos->>'rfc','')) AS cliente_rfc,
              COALESCE(NULLIF(p.datos->'cliente'->>'telefono',''),
                       NULLIF(p.datos->>'telefono',''),
                       NULLIF(p.datos->>'telefono_conversacion','')) AS cliente_telefono,
              COUNT(*) OVER()::int AS total_filtrado
         FROM documentos r
         LEFT JOIN pedidos_activos p
           ON p.negocio_id=$1 AND upper(p.folio)=upper(r.folio)
         LEFT JOIN pedidos_programados pp
           ON pp.negocio_id=$1 AND upper(pp.folio)=upper(r.folio)
          AND pp.activado=FALSE AND p.folio IS NULL
        WHERE ($2::text = '' OR r.estado=$2)
          AND ($3::text = '' OR r.folio ILIKE '%' || $3 || '%'
               OR COALESCE(p.datos->'cliente'->>'nombre','') ILIKE '%' || $3 || '%'
               OR COALESCE(p.datos->>'nombre_cliente','') ILIKE '%' || $3 || '%'
               OR COALESCE(pp.datos->'cliente'->>'nombre','') ILIKE '%' || $3 || '%'
               OR COALESCE(pp.datos->>'nombre_cliente','') ILIKE '%' || $3 || '%')
        ORDER BY r.updated_at DESC, r.folio DESC
        LIMIT $4 OFFSET $5`,
      [negocioId, estadoNormalizado, texto, maximo, salto, plazo.tz, plazo.tipo, plazo.dias, plazo.globalDesde]),
    pool.query(
      `WITH recibos_visibles AS (${RECIBOS_VISIBLES_SQL}), documentos AS (
         SELECT r.folio, r.estado_visible AS estado, r.total
           FROM recibos_visibles r
          WHERE r.negocio_id=$1
         UNION ALL
         SELECT f.folio, CASE WHEN f.cancelada_at IS NULL THEN 'facturado' ELSE 'cancelado' END::text, f.total
           FROM facturas_pedido f
          WHERE f.negocio_id=$1
            AND NOT EXISTS (
              SELECT 1 FROM facturacion_recibos r
               WHERE r.negocio_id=f.negocio_id AND upper(r.folio)=upper(f.folio)
            )
       )
       SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE estado IN ('creando','abierto'))::int AS pendientes,
              COUNT(*) FILTER (WHERE estado='facturado')::int AS facturadas,
              COUNT(*) FILTER (WHERE estado='global')::int AS globales,
              COUNT(*) FILTER (WHERE estado='error')::int AS errores,
              COALESCE(SUM(total) FILTER (WHERE estado='facturado'), 0)::numeric AS total_facturado
         FROM documentos`,
      [negocioId]),
  ]);

  const recibos = lista.rows.map(({ total_filtrado: _totalFiltrado, ...r }) => ({
    ...r,
    total: Number(r.total),
    error_detalle: r.error_detalle ? String(r.error_detalle).slice(0, 300) : null,
    estado_real: estadoRealVenta(r),
  }));
  const agregado = resumen.rows[0] || {};
  return {
    recibos,
    resumen: {
      total: Number(agregado.total || 0),
      pendientes: Number(agregado.pendientes || 0),
      facturadas: Number(agregado.facturadas || 0),
      globales: Number(agregado.globales || 0),
      errores: Number(agregado.errores || 0),
      totalFacturado: Number(agregado.total_facturado || 0),
    },
    paginacion: {
      limite: maximo,
      offset: salto,
      total: Number(lista.rows[0]?.total_filtrado || 0),
    },
  };
}

export async function estadoFacturacionNegocio(negocioId) {
  const [proveedor, verificacion, config] = await Promise.all([
    puedeFacturar(negocioId),
    verificarAccesoFacturapi(negocioId),
    obtenerConfiguracionFacturacion(negocioId),
  ]);
  const ivaConfigurado = config.iva_tasa !== null && config.iva_tasa !== undefined;
  return {
    proveedorConfigurado: proveedor,
    ivaConfigurado,
    puedeFacturar: proveedor && verificacion.disponible && ivaConfigurado,
    verificacionFacturapi: verificacion,
    configuracion: config,
  };
}

// Cuándo vuelve a consultarse un recibo. Uno abierto solo cambia si el
// cliente factura en el portal de Facturapi o si alguien hace la global
// fuera de Xabor: basta una vez al día, mientras no venza. Los que fallaron
// al crearse se reintentan más seguido mientras la venta es reciente. Los
// vencidos y los de más de 45 días ya no se consultan: no pueden cambiar.
// Si el negocio tiene el aviso de Facturapi activo, sus abiertos tampoco: los
// cubren el aviso y el respaldo diario por lista (facturapiWebhook.js).
const RECIBOS_POR_CONSULTAR_SQL = `
  SELECT r.negocio_id, r.folio, r.recibo_id, r.estado
    FROM facturacion_recibos r
   WHERE estado IN ('abierto','creando','error')
     AND NOT (estado = 'abierto' AND EXISTS (
           SELECT 1 FROM facturapi_webhooks w WHERE w.negocio_id = r.negocio_id AND w.estado = 'activo'))
     AND created_at > NOW() - INTERVAL '45 days'
     AND (expires_at IS NULL OR expires_at > NOW() - INTERVAL '1 day')
     AND updated_at < NOW() - CASE
           WHEN estado = 'abierto' THEN INTERVAL '24 hours'
           WHEN created_at > NOW() - INTERVAL '1 day' THEN INTERVAL '30 minutes'
           WHEN created_at > NOW() - INTERVAL '7 days' THEN INTERVAL '6 hours'
           ELSE INTERVAL '24 hours' END
   ORDER BY updated_at ASC LIMIT $1`;

export async function reconciliarRecibosFacturacion(limite = 50) {
  // Todo el barrido comparte un presupuesto de llamadas y un espacio entre
  // ellas, y se detiene si Facturapi rechaza la cuenta (facturapiRitmo.js).
  return enBarridoFacturapi(() => reconciliarConRitmo(limite));
}

async function reconciliarConRitmo(limite) {
  // Primero se cierran los recibos de ventas que ya se facturaron por el
  // portal de Xabor; si no, el barrido de abajo los volvería a tratar como
  // abiertos. Import dinámico: reciboTrasAutofactura.js importa este módulo.
  let cierres = null;
  try {
    const { cerrarRecibosPendientesTrasAutofactura } = await import('./reciboTrasAutofactura.js');
    cierres = await cerrarRecibosPendientesTrasAutofactura();
  } catch (e) {
    console.warn(`[Facturacion] cierre de recibos tras autofactura: ${e.codigo || e.message}`);
  }
  // Ventas pagadas que se quedaron sin liga de autofactura (ligasFacturaVenta.js).
  let ligas = null;
  try {
    const { barrerVentasSinLiga } = await import('./ligasFacturaVenta.js');
    ligas = await barrerVentasSinLiga();
  } catch (e) {
    console.warn(`[Facturacion] barrido de ligas: ${e.codigo || e.message}`);
  }
  // Cancelaciones de CFDI en espera del receptor o del SAT.
  let cancelaciones = null;
  try {
    const { sincronizarCancelacionesPendientes } = await import('./cancelacionCfdi.js');
    cancelaciones = await sincronizarCancelacionesPendientes();
  } catch (e) {
    console.warn(`[Facturacion] verificación de cancelaciones: ${e.codigo || e.message}`);
  }
  // Avisos de Facturapi: UUID de las facturas avisadas y respaldo diario por lista.
  let avisos = null;
  try {
    avisos = { uuids: await completarUuidsPendientes(), respaldo: await respaldoRecibosPorLista() };
  } catch (e) {
    console.warn(`[Facturacion] avisos de Facturapi: ${e.codigo || e.message}`);
  }
  const { rows } = await pool.query(RECIBOS_POR_CONSULTAR_SQL, [Math.min(Math.max(Number(limite) || 50, 1), 200)]);
  let sincronizados = 0, revisados = 0;
  for (const row of rows) {
    if (!puedeLlamarFacturapi(row.negocio_id)) continue; // en pausa o sin presupuesto: espera su turno
    revisados++;
    try {
      if (row.recibo_id) await sincronizarRecibo(row.negocio_id, row.folio);
      else await asegurarReciboPedido(row.negocio_id, row.folio);
      sincronizados++;
    } catch (e) {
      if (e instanceof FacturapiRitmoError) continue; // no se llamó: no cuenta como intento
      // Un intento fallido también espera su intervalo; si no, el mismo
      // recibo se volvería a pedir en cada barrido.
      await pool.query(`UPDATE facturacion_recibos SET updated_at = NOW() WHERE negocio_id=$1 AND folio=$2`,
        [row.negocio_id, row.folio]).catch(() => {});
      console.warn(`[Facturacion] reconciliación ${row.folio}: ${e.codigo || e.message}`);
    }
  }
  return { revisados, sincronizados, cierres, ligas, cancelaciones, avisos };
}
