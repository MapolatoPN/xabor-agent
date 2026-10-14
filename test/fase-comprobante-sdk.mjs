// SDK y bytes de imagen reales; servidor multimodal local, ninguna API real.
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { arrancarVisionMock,respuestaDeAnalisis,analisisBase } from './lib-vision-mock.mjs';
import { SCHEMA_COMPROBANTE,PROMPT_COMPROBANTE,validarLecturaComprobante } from '../src/mesero-agente/compararComprobante.js';
const mock=await arrancarVisionMock();
process.env.ANTHROPIC_BASE_URL=mock.url;process.env.ANTHROPIC_API_KEY='solo-local-no-real';
const { analizarImagenCliente,reiniciarCacheVision }=await import('../src/agent/vision.js');
const {pool}=await import('../src/services/database.js');
const contrato={nombre:'comprobante-v1',schema:SCHEMA_COMPROBANTE,prompt:PROMPT_COMPROBANTE,validar:validarLecturaComprobante};
const lectura={version:1,es_comprobante:true,legible:true,importe:200,moneda:'MXN',fecha:'2026-10-14',
  folios:['XAB-1660'],estado_operacion:'exitosa',confianza_general:0.94};
const imagen=await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="450" height="400">
  <rect width="450" height="400" fill="white"/><text x="25" y="55" font-size="24">Comprobante de pago</text>
  <text x="25" y="105" font-size="24">200.00 MXN</text><text x="25" y="155" font-size="24">2026-10-14</text>
  <text x="25" y="205" font-size="24">XAB-1660</text><text x="25" y="255" font-size="24">Operación exitosa</text></svg>`)).png().toBuffer();
let n=0;
async function t(nombre,fn){await fn();console.log(`OK comprobante SDK ${++n}: ${nombre}`);}
const opts={negocioId:'11111111-1111-4111-8111-111111111111',mediaId:'imagen-local',imagen,mimeType:'image/png',contrato};
try {
  await t('imagen sin caption usa contrato de recibo, no texto libre',async()=>{
    mock.responder=()=>respuestaDeAnalisis(lectura);const r=await analizarImagenCliente(opts);
    assert.deepEqual(r.analisis,lectura);const b=mock.requests.at(-1).body;
    assert.deepEqual(b.output_config.format.schema,SCHEMA_COMPROBANTE);assert.equal(b.system,PROMPT_COMPROBANTE);
    assert.equal(b.messages[0].content[0].type,'image');assert.ok(b.messages[0].content[0].source.data.length>0);
    assert.equal(b.messages[0].content[1].text,'Analiza la imagen.');
  });
  await t('cache del recibo no hace otra llamada',async()=>{const antes=mock.requests.length;assert.equal((await analizarImagenCliente(opts)).cacheHit,true);assert.equal(mock.requests.length,antes);});
  await t('cache general y de recibos se mantienen separados',async()=>{
    mock.responder=()=>respuestaDeAnalisis(analisisBase());const r=await analizarImagenCliente({...opts,contrato:null});
    assert.equal(r.analisis.tipo,'promocion');assert.notEqual(r.cacheHit,true);assert.equal((await analizarImagenCliente(opts)).analisis.importe,200);
  });
  await t('datos adicionales y texto inseguro no pasan el validador',async()=>{
    reiniciarCacheVision();mock.responder=()=>respuestaDeAnalisis({...lectura,cuenta_bancaria:'no persistir'});
    assert.equal((await analizarImagenCliente(opts)).motivo,'output_invalido');
  });
  await t('imagen corrupta evita la llamada al proveedor',async()=>{
    reiniciarCacheVision();const antes=mock.requests.length;
    assert.equal((await analizarImagenCliente({...opts,imagen:Buffer.from('invalida')})).motivo,'imagen_invalida');assert.equal(mock.requests.length,antes);
  });
  console.log(`${n} pruebas SDK correctas`);
} finally {await mock.cerrar();await pool.end();}
