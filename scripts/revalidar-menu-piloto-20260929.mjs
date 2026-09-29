// Revisión delegada por el dueño en esta conversación, no revisión automática.
// Alcance fijo, huellas exactas y CAS: no aprueba imágenes/carta posteriores.
import assert from 'node:assert/strict';
import pg from 'pg';
import { leerRevisionParaPanel, registrarRevisionMenu } from '../src/services/revisionMenuWhatsapp.js';
const [modo] = process.argv.slice(2);
assert(['verificar','activar'].includes(modo));
assert(process.env.DATABASE_URL);
const negocioId='5de544d8-9a0a-4972-9c92-fd48ff22de66';
const usuarioId='bf7f7417-ae2b-4f6e-84b4-a36ecd9b63d9';
const esperadas={huellaCarta:'c1:fa0dd7604584462b6b9cce13364b25fa',huellaImagenes:'i1:fc78cbbb6b9a6e51d5d85aa9c3c9464e'};
const db=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
try {
  await db.connect();await db.query(modo==='activar'?'BEGIN':'BEGIN READ ONLY');
  await db.query("SET LOCAL lock_timeout='5s'");
  const {rows:[usuario]}=await db.query('SELECT negocio_id,activo,nombre FROM usuarios WHERE id=$1',[usuarioId]);
  assert.equal(usuario?.negocio_id,negocioId);assert.equal(usuario.activo,true);
  assert.equal(usuario.nombre,'MARIO ALBERTO CANTU OCHOA');
  const antes=await leerRevisionParaPanel(negocioId,{db});
  assert.equal(antes.huellaCarta,esperadas.huellaCarta,'La carta cambió: no revalidar a ciegas');
  assert.equal(antes.huellaImagenes,esperadas.huellaImagenes,'Las imágenes cambiaron: nueva revisión requerida');
  assert(['carta_cambio','vigente'].includes(antes.estado));
  let despues=antes;
  if(modo==='activar' && antes.estado!=='vigente') {
    const r=await registrarRevisionMenu(negocioId,usuarioId,esperadas,{db});
    assert.equal(r.ok,true);despues=r.revision;assert.equal(despues.estado,'vigente');
  }
  const {rows:[cfg]}=await db.query("SELECT valor FROM configuracion WHERE negocio_id=$1 AND clave='reglas_atencion'",[negocioId]);
  const reglas=JSON.parse(cfg.valor);
  await db.query('COMMIT');
  console.log(JSON.stringify({modo,menuAntes:antes.estado,menuDespues:despues.estado,
    huellas:esperadas,aprobacion:'dueño en conversación; operación delegada',
    costoBase:reglas.pedidos.costo_envio,zonasSinModificar:reglas.pedidos.zonas_entrega}));
} catch(e) {await db.query('ROLLBACK').catch(()=>{});throw e;}
finally {await db.end();}
