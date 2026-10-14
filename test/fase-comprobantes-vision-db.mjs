import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { prepararNegocioBotones,exigirBaseBotonesLocal } from './lib-botones-local.mjs';
import { pool,actualizarConfiguracion,crearDocumentoPendiente } from '../src/services/database.js';
import { procesarComprobantesWhatsapp,consultarPedidosParaComprobante } from '../src/services/comprobantesWhatsapp.js';
import { despacharRespuestasPendientes } from '../src/mesero-agente/entregaDeRespuestas.js';
import { BANDERA_COMPROBANTES,ACUSE_COMPROBANTE } from '../src/mesero-agente/compararComprobante.js';
exigirBaseBotonesLocal();
process.env.MESERO_AGENTE_MODE='true';
const hechos=[];let n=0;
async function t(nombre,fn){await fn();console.log(`OK comprobantes DB ${++n}: ${nombre}`);}
const lectura={version:1,es_comprobante:true,legible:true,importe:200,moneda:'MXN',fecha:'2026-10-14',
  folios:[],estado_operacion:'exitosa',confianza_general:0.95};
async function fixture({activo=true,estado='pendiente_pago',importe=200}={}) {
  const f=await prepararNegocioBotones();hechos.push(f.negocioId);
  await actualizarConfiguracion({[BANDERA_COMPROBANTES]:String(activo),timezone:'America/Matamoros'},f.negocioId);
  const folio=`QA-COMP-${randomUUID().slice(0,8)}`;
  await pool.query(`INSERT INTO pedidos_activos(negocio_id,folio,estado,datos,created_at)
    VALUES($1,$2,$3,$4::jsonb,now() AT TIME ZONE 'UTC')`,
    [f.negocioId,folio,estado,JSON.stringify({cliente:{telefono:f.telefono},total:importe,canal:'whatsapp',estado,pago_confirmado:estado==='entregado'})]);
  const crearDoc=()=>crearDocumentoPendiente({negocioId:f.negocioId,telefono:f.telefono,direccion:'entrante',origen:'cliente',
    categoria:'imagen',filename:'comprobante.png',mimeType:'image/png',wamid:`wamid.${randomUUID()}`});
  const doc=await crearDoc();
  let llamadas=0,lecturas=0,revisiones=0;
  const avisos=[];
  const opts={db:pool,negocioId:f.negocioId,telefono:f.telefono,documentoIds:[doc.id],
    analizar:async()=>{lecturas++;return {ok:true,analisis:lectura};},
    enviar:async({texto})=>{assert.equal(texto,ACUSE_COMPROBANTE);llamadas++;return {messages:[{id:`wamid.salida.${randomUUID()}`}]};},
    registrarHistorial:async()=>null,
    alHumano:async()=>{revisiones++;return true;},broadcastPanel:async(n,d)=>avisos.push({n,d})};
  return {...f,folio,doc,crearDoc,opts,avisos,cuentas:()=>({llamadas,lecturas,revisiones})};
}
async function fotoEstado(f){return (await pool.query('SELECT estado,datos,created_at,updated_at FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2',[f.negocioId,f.folio])).rows[0];}
try {
  // Aditiva y reejecutable; ninguna bandera nace activa.
  const migracion=await readFile(new URL('../migrations/117_comprobantes_lecturas.sql',import.meta.url),'utf8');
  await pool.query(migracion);await pool.query(migracion);
  lectura.fecha=(await pool.query("SELECT to_char(now() AT TIME ZONE 'America/Matamoros','YYYY-MM-DD') fecha")).rows[0].fecha;
  await t('imagen sin caption, comparación real, acuse exacto y pedido/carrito intactos',async()=>{
    const f=await fixture(),antes=await fotoEstado(f);
    const estado=(await pool.query('SELECT estado,revision FROM conversacion_estado WHERE negocio_id=$1',[f.negocioId])).rows;
    const r=await procesarComprobantesWhatsapp(f.opts);assert.equal(r.entrega,'entregado');assert.equal(r.comparaciones[0].coincide,true);
    assert.deepEqual(await fotoEstado(f),antes);assert.deepEqual((await pool.query('SELECT estado,revision FROM conversacion_estado WHERE negocio_id=$1',[f.negocioId])).rows,estado);
    assert.deepEqual(f.cuentas(),{llamadas:1,lecturas:1,revisiones:0});
  });
  await t('pago ya confirmado o entregado también recibe acuse',async()=>{const f=await fixture({estado:'entregado'});await procesarComprobantesWhatsapp(f.opts);assert.equal(f.cuentas().llamadas,1);assert.equal(f.cuentas().revisiones,0);});
  await t('importe diferente genera revisión interna sin modificar pago',async()=>{
    const f=await fixture({importe:300}),antes=await fotoEstado(f);const r=await procesarComprobantesWhatsapp(f.opts);
    assert.ok(r.comparaciones[0].motivos.includes('importe_diferente'));assert.equal(f.cuentas().llamadas,1);assert.equal(f.cuentas().revisiones,1);
    assert.equal(f.avisos[0].d.prioridad,'alta');assert.ok(!JSON.stringify(f.avisos).includes(f.telefono));assert.deepEqual(await fotoEstado(f),antes);
  });
  await t('mismo documento o texto tardío no producen segundo acuse',async()=>{
    const f=await fixture();await procesarComprobantesWhatsapp(f.opts);await procesarComprobantesWhatsapp(f.opts);
    await procesarComprobantesWhatsapp({...f.opts,documentoIds:[],texto:'Es un comprobante de pago'});
    assert.deepEqual(f.cuentas(),{llamadas:1,lecturas:1,revisiones:0});
  });
  await t('dos imágenes y después caption: un solo acuse',async()=>{
    const f=await fixture(),doc=await f.crearDoc();await procesarComprobantesWhatsapp({...f.opts,documentoIds:[f.doc.id,doc.id]});
    await procesarComprobantesWhatsapp({...f.opts,documentoIds:[],texto:'Es mi comprobante'});assert.equal(f.cuentas().llamadas,1);
  });
  await t('bandera apagada no analiza ni envía',async()=>{const f=await fixture({activo:false});assert.equal((await procesarComprobantesWhatsapp(f.opts)).habilitado,false);assert.equal(f.cuentas().lecturas,0);});
  await t('no cruza documentos ni pedidos de otro negocio',async()=>{
    const f=await fixture(),otro=await fixture();const r=await procesarComprobantesWhatsapp({...f.opts,documentoIds:[otro.doc.id]});
    assert.equal(r.atendida,false);assert.equal(f.cuentas().lecturas,0);
    assert.deepEqual((await consultarPedidosParaComprobante(pool,otro.negocioId,f.telefono,'America/Matamoros')).length,0);
  });
  await t('foto de comida conserva ruta normal y no crea acuse',async()=>{
    const f=await fixture();const r=await procesarComprobantesWhatsapp({...f.opts,analizar:async()=>({ok:true,analisis:{...lectura,es_comprobante:false}})});
    assert.equal(r.atendida,false);assert.equal(f.cuentas().llamadas,0);
  });
  await t('proveedor caído con caption de comprobante: acuse y revisión',async()=>{
    const f=await fixture();await procesarComprobantesWhatsapp({...f.opts,texto:'Mi comprobante',analizar:async()=>{throw Error('timeout');}});
    assert.equal(f.cuentas().llamadas,1);assert.equal(f.cuentas().revisiones,1);
  });
  await t('pausa humana gana antes del análisis',async()=>{
    const f=await fixture();await pool.query('INSERT INTO conversaciones_control(negocio_id,telefono,bot_pausado) VALUES($1,$2,true)',[f.negocioId,f.telefono]);
    assert.equal((await procesarComprobantesWhatsapp(f.opts)).sinRespuesta,true);assert.equal(f.cuentas().lecturas,0);
  });
  await t('persona que toma el chat durante visión impide el acuse',async()=>{
    const f=await fixture();const r=await procesarComprobantesWhatsapp({...f.opts,analizar:async()=>{
      await pool.query('INSERT INTO conversaciones_control(negocio_id,telefono,bot_pausado) VALUES($1,$2,true)',[f.negocioId,f.telefono]);return {ok:true,analisis:lectura};}});
    assert.equal(r.entrega,'descartado');assert.equal(f.cuentas().llamadas,0);
  });
  await t('doble procesamiento concurrente tiene una lectura y un envío',async()=>{
    const f=await fixture();await Promise.all([procesarComprobantesWhatsapp(f.opts),procesarComprobantesWhatsapp(f.opts)]);
    assert.equal(f.cuentas().lecturas,1);assert.equal(f.cuentas().llamadas,1);
  });
  await t('bandera retirada durante análisis impide envío y avisos',async()=>{
    const f=await fixture();await procesarComprobantesWhatsapp({...f.opts,analizar:async()=>{
      await actualizarConfiguracion({[BANDERA_COMPROBANTES]:'false'},f.negocioId);return {ok:true,analisis:{...lectura,importe:199}};}});
    assert.deepEqual(f.cuentas(),{llamadas:0,lecturas:0,revisiones:0});assert.equal(f.avisos.length,0);
  });
  await t('revisión caída se retoma sin repetir acuse ni lectura',async()=>{
    const f=await fixture({importe:300});await assert.rejects(procesarComprobantesWhatsapp({...f.opts,alHumano:async()=>false}),/REVISION_NO_CONFIRMADA/);
    await procesarComprobantesWhatsapp(f.opts);assert.equal(f.cuentas().llamadas,1);assert.equal(f.cuentas().lecturas,1);assert.equal(f.cuentas().revisiones,1);
  });
  await t('acuse incierto nunca se reenvía',async()=>{
    const f=await fixture();let llamadas=0;const opts={...f.opts,enviar:async()=>{llamadas++;throw Error('fetch failed');}};
    assert.equal((await procesarComprobantesWhatsapp(opts)).entrega,'incierto');await procesarComprobantesWhatsapp(opts);assert.equal(llamadas,1);
  });
  await t('despachador recupera acuse pendiente después de interrupción',async()=>{
    const f=await fixture();await procesarComprobantesWhatsapp(f.opts);
    await pool.query("UPDATE agente_outbox SET estado='pendiente',wamid_salida=NULL,disponible_at=now() WHERE negocio_id=$1",[f.negocioId]);
    const antes=await fotoEstado(f);const r=await despacharRespuestasPendientes({db:pool,enviar:f.opts.enviar,registrarHistorial:async()=>null,alHumano:f.opts.alHumano});
    assert.equal(r.entregadas,1);assert.deepEqual(await fotoEstado(f),antes);
  });
  console.log(`${n} pruebas PostgreSQL correctas`);
} finally {
  for(const id of hechos) await pool.query('DELETE FROM negocios WHERE id=$1',[id]).catch(()=>{});
  await pool.end();
}
