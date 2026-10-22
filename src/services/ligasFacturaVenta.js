// Liga de autofactura y recibo de cada venta pagada.
//
// Antes la liga de Xabor solo se creaba si antes salía bien el recibo de
// Facturapi: con el proveedor caído, la venta se quedaba sin liga aunque la
// liga no dependa de él. Y había ventas que nunca llegaban a facturables al
// disparar: «Entregado» en el tablero guarda el estado sin esperar
// (orderManager) y lanza la liga en paralelo, que leía la venta todavía sin
// entregar. Les pasaba a las ventas que solo se vuelven facturables al
// entregarse: POS, WhatsApp en efectivo o terminal, Rappi.
//
//   - asegurarLigaYReciboVenta: liga primero y por su lado; luego el recibo.
//   - barrerVentasSinLiga: dentro de la reconciliación de cada 5 min, crea la
//     liga y el recibo de las ventas del mes que se quedaron sin liga.
// Rappi queda fuera del barrido hasta decidir quién factura esas ventas.
import { pool, obtenerEstadoModulo } from './database.js';
import { crearOObtenerAutofactura } from './autofacturaService.js';
import { asegurarReciboPedido, obtenerConfiguracionFacturacion } from './facturacionService.js';
import { enBarridoFacturapi } from './facturapiRitmo.js';

export async function asegurarLigaYReciboVenta(negocioId, folio, origen) {
  if ((await obtenerEstadoModulo(negocioId, 'facturacion')) !== 'activo') return null;
  const cfg = await obtenerConfiguracionFacturacion(negocioId);
  if (!cfg.autoemitir_recibo) return null;
  let portal = null;
  try { portal = await crearOObtenerAutofactura(negocioId, folio); }
  catch (e) { console.warn(`[Autofactura] liga nativa ${folio} (${origen}): ${e.codigo || e.message}`); }
  let recibo = null;
  try {
    // También al cobrar respeta la pausa de Facturapi (facturapiRitmo.js): si
    // la cuenta fue rechazada, la fila queda en error y la reconciliación la
    // reintenta cuando se levante la pausa. Dentro de un barrido comparte su
    // presupuesto.
    recibo = await enBarridoFacturapi(() => asegurarReciboPedido(negocioId, folio), { llamadas: 2, espacioMs: 0 });
    console.log(`[Facturacion] recibo automático ${folio} (${origen}) estado=${recibo?.estado}`);
  } catch (e) {
    // La venta ya ocurrió; la fila del recibo (si alcanzó a crearse) conserva
    // el error para la reconciliación.
    console.warn(`[Facturacion] autoemisión pendiente ${folio} (${origen}): ${e.codigo || e.message}`);
  }
  if (!recibo && !portal) return null;
  return { ...(recibo || {}), url_xabor: portal?.url || null, portal_expires_at: portal?.expiresAt || null };
}

// Una venta que no se pudo preparar no se reintenta en cada ciclo: espera 6 h
// (en memoria del proceso; un despliegue la vuelve a intentar).
const ESPERA_MS = 6 * 60 * 60 * 1000;
const fallidas = new Map();

export async function barrerVentasSinLiga(limite = 50, { ahora = Date.now() } = {}) {
  const { rows } = await pool.query(
    `SELECT p.negocio_id, p.folio
       FROM pedidos_activos p
       JOIN negocio_modulos m ON m.negocio_id=p.negocio_id AND m.modulo='facturacion' AND m.estado='activo'
       JOIN facturacion_configuracion c ON c.negocio_id=p.negocio_id AND c.autoemitir_recibo
      WHERE p.created_at >= date_trunc('month', (now() AT TIME ZONE 'America/Matamoros')) - INTERVAL '1 day'
        AND p.created_at < now() - INTERVAL '2 minutes'
        AND p.estado <> 'cancelado'
        AND (p.estado='entregado' OR p.datos->>'pago_confirmado'='true' OR p.datos->>'origen'='restaurante')
        AND COALESCE(p.datos->>'forma_pago','') NOT IN ('por_cobrar','rappi')
        AND COALESCE(p.datos->>'canal','') <> 'rappi'
        AND COALESCE((p.datos->>'total')::numeric, 0) > 0
        AND NOT EXISTS (SELECT 1 FROM autofacturas a WHERE a.negocio_id=p.negocio_id AND a.folio=p.folio)
      ORDER BY p.created_at ASC
      LIMIT 400`);
  const resultado = { candidatas: rows.length, preparadas: 0, fallidas: 0, en_espera: 0 };
  let hechas = 0;
  for (const r of rows) {
    if (hechas >= limite) break;
    const clave = `${r.negocio_id}:${r.folio}`;
    if ((fallidas.get(clave) || 0) > ahora) { resultado.en_espera++; continue; }
    // La liga de Xabor no depende de Facturapi: se prepara aunque Facturapi esté
    // en pausa o el barrido sin presupuesto. Esos casos cortan el recibo antes
    // de salir a la red y lo dejan en error para la reconciliación.
    hechas++;
    const res = await asegurarLigaYReciboVenta(r.negocio_id, r.folio, 'barrido').catch(() => null);
    if (res?.url_xabor) { resultado.preparadas++; fallidas.delete(clave); }
    else { resultado.fallidas++; fallidas.set(clave, ahora + ESPERA_MS); }
  }
  return resultado;
}

// Solo pruebas: olvidar las esperas.
export function _olvidarEsperas() { fallidas.clear(); }
