import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Ejecuta el módulo real con su dependencia de DB sustituida por un stub.
// Sin conexiones, secrets, clientes ni migraciones.
const ruta = new URL('../src/services/accesoComercialBasico.js', import.meta.url);
const fuente = readFileSync(ruta,'utf8');
assert.match(fuente,/import \{ pool \} from '\.\/database\.js';/);
const modulo = await import('data:text/javascript;charset=utf-8,' +
  encodeURIComponent(fuente.replace("import { pool } from './database.js';","const pool = {};")));
const { accesoComercialBasico } = modulo;

test('un negocio previo sin alta pública conserva su acceso',async()=>{
  assert.equal(await accesoComercialBasico('existente',{consultar:async()=>({rows:[]})}),true);
});
test('permite la prueba vigente y la suscripción activa',async()=>{
  assert.equal(await accesoComercialBasico('nuevo',{consultar:async()=>({rows:[{permitido:true}]})}),true);
});
test('bloquea una prueba vencida o estado comercial ausente',async()=>{
  assert.equal(await accesoComercialBasico('nuevo',{consultar:async()=>({rows:[{permitido:false}]})}),false);
  assert.equal(await accesoComercialBasico('nuevo',{consultar:async()=>({rows:[{permitido:null}]})}),false);
});
test('no inventa negocio y solo consulta el identificador de la sesión',async()=>{
  let sql='',parametros=[];
  assert.equal(await accesoComercialBasico('',{consultar:async()=>{throw Error('No debe consultar')}}),false);
  await accesoComercialBasico('id-negocio',{consultar:async(q,p)=>{sql=q;parametros=p;return {rows:[]}}});
  assert.deepEqual(parametros,['id-negocio']);
  assert.match(sql,/WHERE s\.negocio_id = \$1/);
  assert.match(sql,/s\.used_at \+ INTERVAL '7 days' > NOW\(\)/);
  assert.match(sql,/pc\.estado = 'activo'/);
});
test('error de base de datos bloquea, salvo despliegue sin migración nueva',async()=>{
  const log=console.error;console.error=()=>{};
  try{
    assert.equal(await accesoComercialBasico('nuevo',{consultar:async()=>{throw Object.assign(Error('error'),{code:'XX000'})}}),false);
    assert.equal(await accesoComercialBasico('antiguo',{consultar:async()=>{throw Object.assign(Error('tabla ausente'),{code:'42P01'})}}),true);
  }finally{console.error=log;}
});
test('el servidor aplica la barrera comercial en HTTP y WebSocket',()=>{
  const servidor=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  const usos=servidor.match(/await accesoComercialBasico\(payload\.negocioId\)/g)||[];
  assert.ok(usos.length>=3,'Requiere barreras en dos autenticaciones HTTP y WebSocket');
  assert.match(servidor,/rechazar\(402, 'Payment Required'\)/);
});
