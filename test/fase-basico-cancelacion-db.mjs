import './entorno-superadmin-local.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../src/services/database.js';
import { cancelarSuscripcionBasico } from '../src/services/suscripcionBasicoMp.js';
import { ErrorMercadoPagoSaas } from '../src/services/mercadoPagoSaasCliente.js';

after(async()=>{await pool.end();});
async function contrato(){
  const suf=randomUUID();
  const {rows:[n]}=await pool.query(`INSERT INTO negocios(nombre,slug) VALUES ('Cancelación QA',$1) RETURNING id`,['qa-cancelacion-'+suf]);
  const remote={id:'QA_CANCEL_'+suf,external_reference:'xabor-basico:'+n.id,status:'authorized'};
  await pool.query(`INSERT INTO suscripciones_basico_mp(negocio_id,external_reference,preapproval_id,estado_mp,mensualidad)
    VALUES ($1,$2,$3,'authorized',150)`,[n.id,remote.external_reference,remote.id]);
  return {negocioId:n.id,remote,estado:async()=>(await pool.query('SELECT * FROM suscripciones_basico_mp WHERE negocio_id=$1',[n.id])).rows[0]};
}

test('cancelar confirma el contrato propio y conserva pagos, periodo e historial ajeno',async()=>{
  const c=await contrato(),otro=await contrato(),ajeno=await otro.estado();
  await pool.query(`INSERT INTO pagos_suscripcion_basico_mp
    (negocio_id,preapproval_id,authorized_payment_id,payment_id,monto,moneda,aprobado_at,periodo_desde,periodo_hasta)
    VALUES ($1,$2,$3,$4,150,'MXN',now(),now(),now()+INTERVAL '1 month')`,[c.negocioId,c.remote.id,randomUUID(),randomUUID()]);
  const pagos=async()=>(await pool.query('SELECT * FROM pagos_suscripcion_basico_mp WHERE negocio_id=$1',[c.negocioId])).rows;
  const antes=await pagos();let peticiones=0;
  const r=await cancelarSuscripcionBasico({negocioId:c.negocioId,obtenerPreapproval:async()=>c.remote,
    cancelar:async id=>{peticiones++;assert.equal(id,c.remote.id);return {...c.remote,status:'cancelled'};}});
  assert.equal(r.cancelada,true);assert.equal(peticiones,1);
  assert.equal((await c.estado()).estado_mp,'canceled');
  assert.deepEqual(await pagos(),antes);assert.deepEqual(await otro.estado(),ajeno);
});

test('sin contrato propio no se contacta a Mercado Pago',async()=>{
  await assert.rejects(cancelarSuscripcionBasico({negocioId:randomUUID(),
    obtenerPreapproval:async()=>assert.fail('no consultar'),cancelar:async()=>assert.fail('no cancelar')}),e=>e.code==='CONTRATO_INEXISTENTE');
});

test('un contrato remoto con otra identidad o referencia se rechaza antes del PUT',async()=>{
  const c=await contrato(),antes=await c.estado();
  for(const dato of [{...c.remote,id:'OTRO'},{...c.remote,external_reference:'OTRA'}]){
    await assert.rejects(cancelarSuscripcionBasico({negocioId:c.negocioId,obtenerPreapproval:async()=>dato,
      cancelar:async()=>assert.fail('no cancelar otro contrato')}),e=>e.code==='CONTRATO_INCONSISTENTE');
    assert.deepEqual(await c.estado(),antes);
  }
});

test('un PUT sin confirmación válida no cambia el estado local ni declara éxito',async()=>{
  const c=await contrato(),antes=await c.estado();
  for(const dato of [undefined,{...c.remote,status:'pending'},{...c.remote,status:'authorized'},
    {...c.remote,id:'OTRO',status:'cancelled'},{...c.remote,external_reference:'OTRA',status:'cancelled'}]){
    await assert.rejects(cancelarSuscripcionBasico({negocioId:c.negocioId,obtenerPreapproval:async()=>c.remote,
      cancelar:async()=>dato}),e=>e.code==='CANCELACION_NO_CONFIRMADA'&&e.status===503);
    assert.deepEqual(await c.estado(),antes);
  }
});

test('un rechazo o timeout del proveedor conserva el estado anterior',async()=>{
  const c=await contrato(),antes=await c.estado();
  for(const estado of [502,503]){
    await assert.rejects(cancelarSuscripcionBasico({negocioId:c.negocioId,obtenerPreapproval:async()=>c.remote,
      cancelar:async()=>{throw new ErrorMercadoPagoSaas('QA proveedor no confirmó',estado);}}),e=>e.estado===estado);
    assert.deepEqual(await c.estado(),antes);
  }
});

test('si MP ya canceló, concilia ambas variantes históricas sin enviar otro PUT',async()=>{
  for(const status of ['cancelled','canceled']){
    const c=await contrato();
    assert.equal((await cancelarSuscripcionBasico({negocioId:c.negocioId,obtenerPreapproval:async()=>({...c.remote,status}),
      cancelar:async()=>assert.fail('no repetir cancelación terminal')})).cancelada,true);
    assert.equal((await c.estado()).estado_mp,'canceled');
  }
});

test('una respuesta perdida se recupera al reintentar y las repeticiones locales son idempotentes',async()=>{
  const c=await contrato();let consultas=0,cancelaciones=0;
  const opciones={negocioId:c.negocioId,obtenerPreapproval:async()=>{consultas++;return c.remote;},
    cancelar:async()=>{cancelaciones++;c.remote.status='cancelled';throw new ErrorMercadoPagoSaas('QA respuesta perdida',503);}};
  await assert.rejects(cancelarSuscripcionBasico(opciones));
  assert.equal((await c.estado()).estado_mp,'authorized');
  assert.equal((await cancelarSuscripcionBasico(opciones)).cancelada,true);
  assert.deepEqual(await cancelarSuscripcionBasico(opciones),{cancelada:true,yaCancelada:true});
  assert.equal(consultas,2);assert.equal(cancelaciones,1);
});
