// Avisos de Facturapi (webhooks) sobre los recibos de cada negocio.
//
// Xabor se enteraba de que un recibo cambió (el cliente se autofacturó en
// factura.space, entró en una global, se canceló) consultándolo uno por uno
// en el barrido de reconciliación. Facturapi avisa por webhook
// (`receipt.status_updated`, con el recibo entero). Aquí se recibe:
//
//   1. el token de la URL dice de qué negocio es; el cuerpo nunca lo decide;
//   2. `Facturapi-Signature` = HMAC-SHA256 en hexadecimal del cuerpo crudo con
//      el secreto del webhook de ese negocio (así lo valida el SDK oficial);
//   3. `organization` y `livemode` deben ser los guardados al registrar;
//   4. el id del evento se aplica una sola vez;
//   5. un recibo solo avanza: uno cerrado nunca vuelve a abierto.
//
// La ruta no llama a Facturapi. El UUID de una factura avisada y el respaldo
// diario por lista corren en el barrido, con el presupuesto de
// facturapiRitmo.js. El registro del webhook en cada organización lo hace
// scripts/ops/facturapi-webhook-2026-10/webhook.mjs.
import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { pool, registrarFacturaEmitida } from './database.js';
import { descifrarSecretoIntegracion } from './cifradoIntegraciones.js';
import { listarRecibos, obtenerFactura } from './facturapi.js';
import { puedeLlamarFacturapi, FacturapiRitmoError } from './facturapiRitmo.js';

const ESTADO_LOCAL = { open: 'abierto', invoiced_to_customer: 'facturado', invoiced_globally: 'global', canceled: 'cancelado' };
// Estados locales de un recibo que todavía puede cambiar en Facturapi.
const ABIERTOS = ['creando', 'abierto', 'error'];
const TIPOS_RECIBO = new Set(['receipt.status_updated', 'receipt.self_invoice_complete']);
const TOKEN = /^[a-f0-9]{48}$/;
const POR_PAGINA = 100;

function numeroEnv(nombre, porOmision) {
  const n = Number(process.env[nombre]);
  return Number.isFinite(n) && n > 0 ? n : porOmision;
}

/** ¿`firma` es el HMAC-SHA256 en hexadecimal de los bytes de `cuerpo` con `secreto`? */
export function firmaValida(cuerpo, firma, secreto) {
  if (!Buffer.isBuffer(cuerpo) || typeof secreto !== 'string' || !secreto) return false;
  const hex = typeof firma === 'string' ? firma.trim() : '';
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  const esperada = createHmac('sha256', secreto).update(cuerpo).digest();
  return timingSafeEqual(esperada, Buffer.from(hex, 'hex'));
}

function secretoDe(w) {
  return descifrarSecretoIntegracion({
    cifrado: w.secreto_cifrado, iv: w.secreto_iv, authTag: w.secreto_auth_tag, version: w.secreto_formato_version,
  });
}

async function enTransaccion(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

async function ledgerDe(db, negocioId, folio) {
  const { rows: [f] } = await db.query(
    `SELECT factura_id, uuid FROM facturas_pedido
      WHERE negocio_id=$1 AND upper(folio)=upper($2) AND factura_id IS NOT NULL
      ORDER BY emitida_at DESC LIMIT 1`, [negocioId, folio]);
  return f || null;
}

async function anotarDobleCfdi(db, negocioId, folio, detalle) {
  await db.query(
    `UPDATE facturacion_recibos SET error_codigo='DOBLE_CFDI', error_detalle=$3, updated_at=NOW()
      WHERE negocio_id=$1 AND folio=$2`, [negocioId, folio, detalle]);
  console.error(`[Facturacion] DOBLE CFDI: ${folio} — ${detalle}`);
  console.warn(`[TXN] evento=doble_cfdi negocio=${negocioId} folio=${folio}`);
}

/**
 * Lleva a `facturacion_recibos` el estado de un recibo tal como lo reporta
 * Facturapi (aviso o lista del respaldo). `db` debe estar en una transacción:
 * la fila se bloquea para que un aviso y el barrido no se pisen.
 * Devuelve { resultado, folio?, estado? }.
 */
export async function aplicarReciboRemoto(db, negocioId, remoto) {
  const reciboId = typeof remoto?.id === 'string' ? remoto.id : '';
  if (!reciboId) return { resultado: 'sin_recibo' };
  const { rows: [local] } = await db.query(
    `SELECT folio, estado, total, factura_id, error_codigo FROM facturacion_recibos
      WHERE negocio_id=$1 AND recibo_id=$2 FOR UPDATE`, [negocioId, reciboId]);
  if (!local) return { resultado: 'recibo_ajeno' }; // no lo creó Xabor
  const folio = local.folio;
  const nuevo = ESTADO_LOCAL[remoto.status];
  if (!nuevo) return { resultado: 'estado_desconocido', folio };
  const total = Number(remoto.total);
  if (!Number.isFinite(total) || Math.abs(Number(local.total) - total) > 0.01) {
    console.warn(`[FacturapiWebhook] total distinto en ${folio}: local=${local.total} remoto=${remoto.total ?? 'n/a'}; no se cambia`);
    return { resultado: 'total_divergente', folio };
  }
  const facturaRemota = typeof remoto.invoice === 'string' ? remoto.invoice : remoto.invoice?.id || null;

  if (!ABIERTOS.includes(local.estado)) {
    // Ya cerrado en Xabor. Solo una segunda factura cambia algo: se anota, una vez.
    const doble = local.estado === 'facturado' && local.error_codigo !== 'DOBLE_CFDI' && (nuevo === 'global'
      || (nuevo === 'facturado' && facturaRemota && local.factura_id && facturaRemota !== local.factura_id));
    if (doble) {
      await anotarDobleCfdi(db, negocioId, folio, `El recibo quedó ${remoto.status} en Facturapi (${facturaRemota || 'global'}) y la venta ya tenía ${local.factura_id || 'factura'}`);
      return { resultado: 'doble_cfdi', folio };
    }
    // Un recibo cancelado después de facturar por el portal de Xabor sigue
    // `facturado` (reciboTrasAutofactura.js).
    const igual = local.estado === nuevo || (local.estado === 'facturado' && nuevo !== 'abierto');
    return { resultado: igual ? 'sin_cambio' : 'regresion_ignorada', folio };
  }

  if (local.estado === nuevo) return { resultado: 'sin_cambio', folio };
  if (nuevo === 'abierto') {
    await db.query(
      `UPDATE facturacion_recibos SET estado='abierto', error_codigo=NULL, error_detalle=NULL, updated_at=NOW()
        WHERE negocio_id=$1 AND folio=$2`, [negocioId, folio]);
    return { resultado: 'aplicado', folio, estado: 'abierto' };
  }

  // La venta pudo facturarse por el portal de Xabor (CFDI directo) antes de
  // que su recibo se cerrara.
  const ledger = await ledgerDe(db, negocioId, folio);
  if (nuevo === 'cancelado') {
    if (ledger) {
      await db.query(
        `UPDATE facturacion_recibos SET estado='facturado', factura_id=$3, uuid=$4,
           error_codigo=NULL, error_detalle=NULL, updated_at=NOW()
          WHERE negocio_id=$1 AND folio=$2`, [negocioId, folio, ledger.factura_id, ledger.uuid]);
      return { resultado: 'aplicado', folio, estado: 'facturado' };
    }
    await db.query(
      `UPDATE facturacion_recibos SET estado='cancelado', error_codigo=NULL, error_detalle=NULL, updated_at=NOW()
        WHERE negocio_id=$1 AND folio=$2`, [negocioId, folio]);
    return { resultado: 'aplicado', folio, estado: 'cancelado' };
  }
  if (ledger && ledger.factura_id !== facturaRemota) {
    await db.query(
      `UPDATE facturacion_recibos SET estado=$3, factura_id=COALESCE($4, factura_id), updated_at=NOW()
        WHERE negocio_id=$1 AND folio=$2`, [negocioId, folio, nuevo, facturaRemota]);
    await anotarDobleCfdi(db, negocioId, folio, `El recibo quedó ${remoto.status} en Facturapi (${facturaRemota || 'global'}) y la venta ya tenía ${ledger.factura_id}`);
    return { resultado: 'doble_cfdi', folio, estado: nuevo };
  }
  if (nuevo === 'facturado') {
    // El aviso trae el id de la factura, no su UUID: lo pide el barrido.
    await db.query(
      `UPDATE facturacion_recibos SET estado='facturado', factura_id=COALESCE($3, factura_id),
         error_codigo=CASE WHEN COALESCE($3, factura_id) IS NULL THEN NULL ELSE 'UUID_PENDIENTE' END,
         error_detalle=NULL, updated_at=NOW()
        WHERE negocio_id=$1 AND folio=$2`, [negocioId, folio, facturaRemota]);
    return { resultado: 'aplicado', folio, estado: 'facturado' };
  }
  await db.query(
    `UPDATE facturacion_recibos SET estado='global', factura_id=COALESCE($3, factura_id),
       error_codigo=NULL, error_detalle=NULL, updated_at=NOW()
      WHERE negocio_id=$1 AND folio=$2`, [negocioId, folio, facturaRemota]);
  return { resultado: 'aplicado', folio, estado: 'global' };
}

const texto = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
const fecha = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v) : null);

/**
 * Un aviso de Facturapi. Devuelve { http, resultado, negocioId?, folio? };
 * `http` es lo que se le responde a Facturapi.
 */
export async function procesarAvisoFacturapi({ token, cuerpo, firma }) {
  if (typeof token !== 'string' || !TOKEN.test(token)) return { http: 404, resultado: 'token_invalido' };
  const { rows: [w] } = await pool.query(
    `SELECT negocio_id, estado, organizacion_id, livemode,
            secreto_cifrado, secreto_iv, secreto_auth_tag, secreto_formato_version
       FROM facturapi_webhooks WHERE routing_token=$1`, [token]);
  if (!w || !['activo', 'pausado'].includes(w.estado)) return { http: 404, resultado: 'token_invalido' };
  const negocioId = w.negocio_id;
  let secreto;
  try { secreto = secretoDe(w); } catch { return { http: 500, resultado: 'secreto_ilegible', negocioId }; }
  if (!firmaValida(cuerpo, firma, secreto)) return { http: 401, resultado: 'firma_invalida', negocioId };

  let evento;
  try { evento = JSON.parse(cuerpo.toString('utf8')); } catch { evento = null; }
  if (!evento || typeof evento !== 'object' || Array.isArray(evento)) return { http: 400, resultado: 'cuerpo_no_json', negocioId };
  if (evento.organization !== w.organizacion_id || evento.livemode !== w.livemode) {
    return { http: 200, resultado: 'organizacion_ajena', negocioId };
  }
  const eventoId = typeof evento.id === 'string' ? evento.id.trim() : '';
  if (!eventoId || eventoId.length > 100) return { http: 400, resultado: 'evento_sin_id', negocioId };
  await pool.query(`UPDATE facturapi_webhooks SET ultimo_evento_at=NOW() WHERE negocio_id=$1`, [negocioId]);
  // En pausa el barrido consulta como antes: el aviso se acusa y no se aplica.
  if (w.estado !== 'activo') return { http: 200, resultado: 'en_pausa', negocioId };

  const tipo = texto(evento.type, 100) || '';
  const remoto = evento.data?.type === 'receipt' && evento.data?.object && typeof evento.data.object === 'object'
    ? evento.data.object : null;
  try {
    return await enTransaccion(async (c) => {
      const { rows: nuevo } = await c.query(
        `INSERT INTO facturapi_webhook_eventos
           (negocio_id, evento_id, tipo, recibo_id, estado_remoto, resultado, evento_creado_at)
         VALUES ($1,$2,$3,$4,$5,'procesando',$6)
         ON CONFLICT (negocio_id, evento_id) DO NOTHING RETURNING 1`,
        [negocioId, eventoId, tipo, texto(remoto?.id, 100), texto(remoto?.status, 40), fecha(evento.created_at)]);
      if (!nuevo.length) return { http: 200, resultado: 'duplicado', negocioId };
      const r = TIPOS_RECIBO.has(tipo) && remoto
        ? await aplicarReciboRemoto(c, negocioId, remoto)
        : { resultado: 'tipo_ignorado' };
      await c.query(
        `UPDATE facturapi_webhook_eventos SET resultado=$3, folio=$4 WHERE negocio_id=$1 AND evento_id=$2`,
        [negocioId, eventoId, r.resultado, r.folio || null]);
      return { http: 200, resultado: r.resultado, negocioId, folio: r.folio };
    });
  } catch (e) {
    console.error(`[FacturapiWebhook] no se pudo aplicar el evento negocio=${negocioId}: ${e.message}`);
    return { http: 500, resultado: 'error_base', negocioId };
  }
}

/**
 * Monta POST /webhook/facturapi/:token. Va ANTES del express.json global:
 * la firma se calcula sobre los bytes tal como llegaron.
 */
export function registrarWebhookFacturapi(app) {
  app.post('/webhook/facturapi/:token', express.raw({ type: () => true, limit: '256kb' }), async (req, res) => {
    let r;
    try {
      r = await procesarAvisoFacturapi({
        token: String(req.params.token || ''),
        cuerpo: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        firma: req.get('facturapi-signature'),
      });
    } catch (e) {
      console.error('[FacturapiWebhook] error inesperado:', e.message);
      r = { http: 500, resultado: 'error' };
    }
    res.sendStatus(r.http);
    if (r.resultado !== 'token_invalido') {
      console.log(`[FacturapiWebhook] negocio=${r.negocioId || '?'} http=${r.http} resultado=${r.resultado}${r.folio ? ` folio=${r.folio}` : ''}`);
    }
  });
}

/**
 * Barrido: el UUID de las facturas que llegaron por aviso. Una consulta por
 * factura, dentro del presupuesto del barrido; un fallo espera 30 minutos.
 */
export async function completarUuidsPendientes(limite = 20) {
  const { rows } = await pool.query(
    `SELECT negocio_id, folio, factura_id, total FROM facturacion_recibos
      WHERE estado='facturado' AND error_codigo='UUID_PENDIENTE' AND factura_id IS NOT NULL AND uuid IS NULL
        AND (error_detalle IS NULL OR updated_at < NOW() - INTERVAL '30 minutes')
      ORDER BY updated_at ASC LIMIT $1`, [limite]);
  let completados = 0;
  for (const r of rows) {
    if (!puedeLlamarFacturapi(r.negocio_id, 1)) continue;
    try {
      const factura = await obtenerFactura(r.negocio_id, r.factura_id);
      const uuid = typeof factura?.uuid === 'string' && factura.uuid ? factura.uuid : null;
      if (!uuid) throw Object.assign(new Error('la factura no trae UUID'), { codigo: 'SIN_UUID' });
      await pool.query(
        `UPDATE facturacion_recibos SET uuid=$3, error_codigo=NULL, error_detalle=NULL, updated_at=NOW()
          WHERE negocio_id=$1 AND folio=$2 AND error_codigo='UUID_PENDIENTE'`, [r.negocio_id, r.folio, uuid]);
      await registrarFacturaEmitida({ negocioId: r.negocio_id, folio: r.folio, facturaId: r.factura_id, uuid, total: r.total, fuente: 'autofactura' });
      completados++;
    } catch (e) {
      if (e instanceof FacturapiRitmoError) continue; // no se llamó
      await pool.query(
        `UPDATE facturacion_recibos SET error_detalle=$3, updated_at=NOW()
          WHERE negocio_id=$1 AND folio=$2 AND error_codigo='UUID_PENDIENTE'`,
        [r.negocio_id, r.folio, `Reintento: ${e.codigo || e.status || 'error'}`]).catch(() => {});
      console.warn(`[FacturapiWebhook] UUID de ${r.folio}: ${e.codigo || e.message}`);
    }
  }
  return { revisados: rows.length, completados };
}

/**
 * Barrido: respaldo de los avisos, una vez al día por negocio con webhook
 * activo. Lista los recibos creados en los últimos FACTURAPI_RESPALDO_DIAS
 * (9: la liga dura 7.5 días) página por página y los aplica igual que un
 * aviso. Si se acaba el presupuesto, la siguiente vuelta sigue en la página
 * donde iba. Un cambio que encuentra aquí es un aviso que no llegó.
 */
export async function respaldoRecibosPorLista() {
  const { rows } = await pool.query(
    `SELECT w.negocio_id, w.respaldo_desde, w.respaldo_pagina FROM facturapi_webhooks w
      WHERE w.estado='activo'
        -- Con la integración suspendida (el freno) no hay a quién preguntar.
        AND EXISTS (SELECT 1 FROM integraciones_canal ic
                     WHERE ic.negocio_id=w.negocio_id AND ic.canal='facturacion'
                       AND ic.proveedor='facturapi' AND ic.estado='activo')
        AND (respaldo_completado_at IS NULL
             OR (respaldo_completado_at AT TIME ZONE 'America/Matamoros')::date
                < (NOW() AT TIME ZONE 'America/Matamoros')::date)`);
  const resumen = { negocios: rows.length, paginas: 0, corregidos: 0, completos: 0 };
  for (const w of rows) {
    let desde = w.respaldo_desde, pagina = w.respaldo_pagina;
    if (!desde || !pagina) {
      desde = new Date(Date.now() - numeroEnv('FACTURAPI_RESPALDO_DIAS', 9) * 24 * 60 * 60 * 1000);
      pagina = 1;
      await pool.query(
        `UPDATE facturapi_webhooks SET respaldo_desde=$2, respaldo_pagina=1, updated_at=NOW() WHERE negocio_id=$1`,
        [w.negocio_id, desde]);
    }
    while (puedeLlamarFacturapi(w.negocio_id, 1)) {
      let lista;
      try {
        lista = await listarRecibos(w.negocio_id, { desde, pagina, limite: POR_PAGINA });
      } catch (e) {
        if (!(e instanceof FacturapiRitmoError)) console.warn(`[FacturapiWebhook] respaldo negocio=${w.negocio_id} página ${pagina}: ${e.codigo || e.message}`);
        break;
      }
      resumen.paginas++;
      const recibos = Array.isArray(lista?.data) ? lista.data : [];
      for (const remoto of recibos) {
        let r;
        try { r = await enTransaccion((c) => aplicarReciboRemoto(c, w.negocio_id, remoto)); } catch (e) {
          console.warn(`[FacturapiWebhook] respaldo negocio=${w.negocio_id} recibo: ${e.message}`);
          continue;
        }
        if ((r.resultado === 'aplicado' && r.estado !== 'abierto') || r.resultado === 'doble_cfdi') {
          resumen.corregidos++;
          console.warn(`[FacturapiWebhook] webhook_perdido negocio=${w.negocio_id} folio=${r.folio} estado=${r.estado || r.resultado}`);
        }
      }
      const totalPaginas = Number(lista?.total_pages);
      const ultima = recibos.length < POR_PAGINA || (totalPaginas > 0 && pagina >= totalPaginas);
      if (ultima) {
        await pool.query(
          `UPDATE facturapi_webhooks SET respaldo_completado_at=NOW(), respaldo_pagina=NULL, respaldo_desde=NULL, updated_at=NOW()
            WHERE negocio_id=$1`, [w.negocio_id]);
        resumen.completos++;
        break;
      }
      pagina += 1;
      await pool.query(`UPDATE facturapi_webhooks SET respaldo_pagina=$2, updated_at=NOW() WHERE negocio_id=$1`, [w.negocio_id, pagina]);
    }
  }
  return resumen;
}
