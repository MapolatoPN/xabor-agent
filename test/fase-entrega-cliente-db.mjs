import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {pool,marcarEntregadoRepartidor,obtenerPedidosAsignadosARepartidor} from '../src/services/database.js';
import {seguimientoPublico} from '../src/services/tiendaCheckout.js';
import {leerPedidosActivosDelTelefono} from '../src/mesero-agente/recepcionista.js';
import {prepararNegocioBotones,exigirBaseBotonesLocal} from './lib-botones-local.mjs';
exigirBaseBotonesLocal();
let n=0;const caso=async(t,f)=>{await f();console.log(`OK entrega cliente DB ${++n}: ${t}`);};
try{
  const f=await prepararNegocioBotones(),otro=await prepararNegocioBotones();
  const folio=`QA-ENT-${randomUUID().slice(0,8)}`,rid=randomUUID(),token=randomBytes(24).toString('hex');
  const datos={modalidad:'entrega a domicilio',cliente:{telefono:f.telefono},repartidor_id:rid,entrega_estado:'asignado',total:200,items:[]};
  await pool.query(`INSERT INTO pedidos_activos(negocio_id,folio,estado,datos,created_at,entregado_at)
    VALUES($1,$2,'entregado',$3,now() AT TIME ZONE 'UTC',now())`,[f.negocioId,folio,datos]);
  await pool.query(`INSERT INTO tienda_pedidos(negocio_id,checkout_token,tracking_token,pedido_folio,estado)
    VALUES($1,$2,$3,$4,'creado')`,[f.negocioId,randomUUID(),token,folio]);
  await caso('cierre del panel aparece En camino, sigue en portal y se encuentra por WhatsApp',async()=>{
    assert.equal((await seguimientoPublico(token)).etapaActual,'en_camino');
    assert((await obtenerPedidosAsignadosARepartidor(rid)).some(p=>p.folio===folio));
    assert((await leerPedidosActivosDelTelefono(pool,{negocioId:f.negocioId,telefono:f.telefono})).some(p=>p.folio===folio));
  });
  await caso('otro repartidor u otro negocio no puede confirmar recepción',async()=>{
    assert.equal(await marcarEntregadoRepartidor(folio,otro.negocioId,rid),null);
    assert.equal(await marcarEntregadoRepartidor(folio,f.negocioId,randomUUID()),null);
    assert.equal((await seguimientoPublico(token)).etapaActual,'en_camino');
  });
  await caso('dos confirmaciones simultáneas generan una sola recepción durable',async()=>{
    const r=await Promise.all([marcarEntregadoRepartidor(folio,f.negocioId,rid),marcarEntregadoRepartidor(folio,f.negocioId,rid)]);
    assert.equal(r.filter(Boolean).length,1);assert.equal(r.find(Boolean).entrega_estado,'entregado');
    assert(r.find(Boolean).entrega_recibida_at);
    assert.equal((await seguimientoPublico(token)).etapaActual,'entregado');
    assert(!(await obtenerPedidosAsignadosARepartidor(rid)).some(p=>p.folio===folio));
  });
  await caso('pedidos cerrados de días anteriores no se reactivan ni envían confirmación nueva',async()=>{
    const viejo=folio+'-V';
    await pool.query(`INSERT INTO pedidos_activos(negocio_id,folio,estado,datos,created_at,entregado_at)
      VALUES($1,$2,'entregado',$3,(now() AT TIME ZONE 'UTC')-interval '2 days',now()-interval '2 days')`,[f.negocioId,viejo,datos]);
    assert.equal(await marcarEntregadoRepartidor(viejo,f.negocioId,rid),null);
    assert(!(await obtenerPedidosAsignadosARepartidor(rid)).some(p=>p.folio===viejo));
  });
  await caso('asignación por sí sola conserva Listo; recoger conserva recepción final',async()=>{
    await pool.query("UPDATE pedidos_activos SET estado='listo',datos=$3 WHERE negocio_id=$1 AND folio=$2",[f.negocioId,folio,datos]);
    assert.equal((await seguimientoPublico(token)).etapaActual,'listo');
    await pool.query("UPDATE pedidos_activos SET estado='entregado',datos=$3 WHERE negocio_id=$1 AND folio=$2",[f.negocioId,folio,{...datos,modalidad:'recoger en tienda'}]);
    assert.equal((await seguimientoPublico(token)).etapaActual,'entregado');
  });
  console.log(`${n} pruebas de entrega correctas`);
}finally{await pool.end();}
