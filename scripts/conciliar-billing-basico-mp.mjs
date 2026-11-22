// Reconcilia pagos SaaS ante retrasos/pérdidas de webhook.
// NO se ejecuta automáticamente en el servidor ni por predeploy.
// Uso (después de probar staging y autorizarlo):
// XABOR_CONCILIACION_CONFIRMADA=SI XABOR_SUSCRIPCIONES_MP=true \
//   MP_SAAS_ACCESS_TOKEN=... DATABASE_URL=... node scripts/conciliar-billing-basico-mp.mjs
// No imprime clientes, correos, IDs de pago ni credenciales.
// La verificación de invoice y pago y el ledger idempotente viven en servicio.
import 'dotenv/config';
import { pool } from '../src/services/database.js';
import { buscarFacturasMpSaasPorContrato } from '../src/services/mercadoPagoSaasCliente.js';
import { conciliarFacturaMercadoPago } from '../src/services/suscripcionBasicoMp.js';

if (process.env.XABOR_CONCILIACION_CONFIRMADA !== 'SI' ||
    process.env.XABOR_SUSCRIPCIONES_MP !== 'true' ||
    !process.env.MP_SAAS_ACCESS_TOKEN || !process.env.DATABASE_URL) {
  console.error('Conciliación NO habilitada. Faltan configuración y autorización explícitas.');
  process.exit(2);
}
const solicitado=Number.parseInt(process.env.XABOR_CONCILIACION_MAX || '10',10);
const max=Math.min(30,Math.max(1,Number.isInteger(solicitado)?solicitado:10));
let examinados=0,consultadas=0,acreditadas=0,duplicadas=0,fallidas=0;

try {
  const { rows: contratos } = await pool.query(
    'SELECT preapproval_id FROM suscripciones_basico_mp WHERE preapproval_id IS NOT NULL ORDER BY creado_at DESC LIMIT $1',
    [max]);
  for (const c of contratos) {
    examinados++;
    try {
      // Máximo 40 facturas por contrato y pasada, para mantener una carga
      // finita. Las siguientes pasadas tratarán las más recientes de nuevo,
      // sin duplicarlas gracias al ledger. Revisar paginación para gran escala.
      for (const offset of [0,20]) {
        const facturas=await buscarFacturasMpSaasPorContrato(c.preapproval_id,{limit:20,offset});
        if(!facturas.length)break;
        for(const f of facturas) {
          if(!/^\d{1,24}$/.test(String(f.id||'')))continue;
          consultadas++;
          const r=await conciliarFacturaMercadoPago(String(f.id));
          if(r.aplicado)acreditadas++;
          else if(r.motivo==='ya_acreditado')duplicadas++;
        }
        if(facturas.length<20)break;
      }
    } catch(e) {
      fallidas++;
      console.error('[reconciliación] Un contrato necesita revisión:',e.code||'error');
    }
  }
  console.log(JSON.stringify({
    contratosExaminados:examinados,facturasExaminadas:consultadas,
    nuevasAcreditadas:acreditadas,yaAcreditadas:duplicadas,contratosConError:fallidas,
  }));
  if(fallidas)process.exitCode=1;
} catch(e) {
  console.error('[reconciliación] Error de base de datos:',e.code||'desconocido');
  process.exitCode=1;
} finally {await pool.end().catch(()=>{});}
