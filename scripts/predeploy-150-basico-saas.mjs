// Ejecutar --comprobar es solo lectura. El predeploy exige autorización para
// 150–156 sobre esquema ausente, 155–156 sobre 150–154, o 156 sobre 150–155.
import 'dotenv/config';
import {pool} from '../src/services/database.js';
import {inspeccionarEsquemaBasico,prepararEsquemaBasico} from './lib-migraciones-basico.mjs';
import {prepararMesasBasico} from './lib-basico-mesas.mjs';
try {
  const estado=await inspeccionarEsquemaBasico(pool);
  if(process.argv.includes('--comprobar')) {
    console.log(JSON.stringify({...estado,soloLectura:true}));
    if(estado.estado!=='completo')process.exitCode=1;
  } else if(estado.estado==='ausente'&&process.env.XABOR_MIGRAR_BASICO!=='SI') {
    if(process.env.XABOR_ALTA_PUBLICA_BASICO==='true'||process.env.XABOR_SUSCRIPCIONES_MP==='true')throw Error('Básico habilitado sin autorización para preparar sus tablas');
    console.log('[predeploy-basico] Básico apagado; no se cambió el esquema');
  } else {
    console.log(JSON.stringify(await prepararEsquemaBasico(pool,{autorizar:process.env.XABOR_MIGRAR_BASICO==='SI'})));
  }
  const mesas=await prepararMesasBasico(pool,{autorizar:process.env.XABOR_MIGRAR_BASICO==='SI',comprobar:process.argv.includes('--comprobar')});
  console.log(JSON.stringify({mesasBasico:mesas}));
  if(mesas.pendientes)process.exitCode=1;
}catch(e){console.error('[predeploy-basico] '+e.message);process.exitCode=1;}
finally{await pool.end();}
