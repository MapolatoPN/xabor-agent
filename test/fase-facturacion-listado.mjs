import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {pool} from '../src/services/database.js';
import {prepararNegocioBotones} from './lib-botones-local.mjs';
import {listarRecibosFacturacion} from '../src/services/facturacionService.js';

try {
  const f=await prepararNegocioBotones(), otro=await prepararNegocioBotones();
  for(const estado of ['abierto','error','cancelado','global']) {
    const folio=`PRUEBA-${estado}`;
    await pool.query(`INSERT INTO facturacion_recibos(negocio_id,folio,total,idempotency_key,estado)
      VALUES($1,$2,100,$4,$3)`,[f.negocioId,folio,estado,`${f.negocioId}:${folio}`]);
    await pool.query(`INSERT INTO facturas_pedido(negocio_id,folio,factura_id,uuid,total,fuente)
      VALUES($1,$2,$2,'11111111-2222-3333-4444-555555555556',100,'panel')`,[f.negocioId,folio]);
  }
  await pool.query(`INSERT INTO facturacion_recibos(negocio_id,folio,total,idempotency_key,estado)
    VALUES($1,'AJENO',100,$2,'abierto')`,[f.negocioId,`${f.negocioId}:ajeno`]);
  await pool.query(`INSERT INTO facturas_pedido(negocio_id,folio,factura_id,uuid,total,fuente)
    VALUES($1,'AJENO','ajeno','11111111-2222-3333-4444-555555555556',100,'panel')`,[otro.negocioId]);
  const r=await listarRecibosFacturacion(f.negocioId);
  assert.equal(r.resumen.total,5);assert.equal(r.resumen.facturadas,2);assert.equal(r.resumen.pendientes,1);
  for(const estado of ['abierto','error']) {
    const fila=r.recibos.find(x=>x.folio===`PRUEBA-${estado}`);
    assert.equal(fila.estado,'facturado');assert(fila.uuid);assert.equal(fila.factura_id,`PRUEBA-${estado}`);
  }
  for(const estado of ['cancelado','global'])assert.equal(r.recibos.find(x=>x.folio===`PRUEBA-${estado}`).estado,estado);
  assert.equal(r.recibos.find(x=>x.folio==='AJENO').estado,'abierto');
  assert.equal((await listarRecibosFacturacion(f.negocioId,{estado:'facturado'})).recibos.length,2);
  assert.equal((await pool.query("SELECT estado FROM facturacion_recibos WHERE negocio_id=$1 AND folio='PRUEBA-abierto'",[f.negocioId])).rows[0].estado,'abierto');
  console.log('OK listado: emisión, contadores, filtros, aislamiento y lectura sin mutaciones');

  const panel=readFileSync(new URL('../panel/index.html',import.meta.url),'utf8');
  const codigo=panel.slice(panel.indexOf('async function cargarPaginasFacturacion'),panel.indexOf('function facturacionFiltrarEstado'));
  const elementos=new Map();
  const el=id=>{if(!elementos.has(id))elementos.set(id,{value:'',innerHTML:'',textContent:''});return elementos.get(id);};
  const recibos=Array.from({length:570},(_,i)=>({folio:i===569?'XAB-1113':`XAB-${i}`,estado:'facturado',total:100,created_at:'2026-10-02',factura_id:`f${i}`}));
  const servicios=[{id:'s1',referencia:'Evento',estado:'facturada',total:200,created_at:'2026-10-02'}];
  let llamadas=0,fallar=false;
  const contexto=vm.createContext({document:{getElementById:el},PUEDE_FACTURAR:true,esc:String,
    estadoServicioUI:()=>['Timbrada','',''],estadoReciboUI:()=>['Timbrada','',''],esReciboPruebaUI:()=>false,
    apiFetch:async ruta=>{llamadas++;const u=new URL(ruta,'http://local');const offset=Number(u.searchParams.get('offset'));
      if(fallar && offset===100)return {ok:false,json:async()=>({error:'Error de segunda página'})};
      const campo=ruta.includes('/recibos')?'recibos':'servicios',filas=campo==='recibos'?recibos:servicios;
      return {ok:true,json:async()=>({[campo]:filas.slice(offset,offset+100),paginacion:{total:filas.length}})};}});
  vm.runInContext(codigo,contexto);
  el('facturacion-recibos-buscar').value='XAB-1113';
  await vm.runInContext('cargarCentroFacturacion()',contexto);
  assert.match(el('facturacion-recibos-lista').innerHTML,/XAB-1113/);
  assert.equal(el('facturacion-kpi-facturadas').textContent,'571');assert.equal(llamadas,7);
  el('facturacion-recibos-buscar').value='Evento';el('facturacion-recibos-estado').value='facturado';
  await vm.runInContext('cargarCentroFacturacion()',contexto);
  assert.match(el('facturacion-recibos-lista').innerHTML,/Evento/);
  fallar=true;await vm.runInContext('cargarCentroFacturacion()',contexto);
  assert.match(el('facturacion-recibos-lista').innerHTML,/Error de segunda página/);
  console.log('OK panel: 570 ventas, búsqueda fuera de primera página, contadores completos, servicios y fallo parcial visible');
} finally {await pool.end();}
