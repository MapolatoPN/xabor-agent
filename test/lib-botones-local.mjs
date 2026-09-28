import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, actualizarConfiguracion } from '../src/services/database.js';
import { estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';

export function exigirBaseBotonesLocal() {
  const url = new URL(process.env.DATABASE_URL);
  assert(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.match(url.pathname, /^\/test_botones_/);
  assert.match(process.env.NODE_OPTIONS || '', /red-solo-local/);
}
export async function prepararNegocioBotones() {
  exigirBaseBotonesLocal();
  const marca = randomUUID(), telefono = `52879${Math.floor(Math.random()*1e7).toString().padStart(7,'0')}`;
  const { rows:[n] } = await pool.query('INSERT INTO negocios(nombre,slug,bot_whatsapp_activo) VALUES($1,$2,true) RETURNING id',
    ['Botones aislados',`botones-${marca}`]);
  const negocioId = n.id;
  await pool.query("INSERT INTO clientes(negocio_id,telefono,nombre) VALUES($1,$2,'Cliente local')",[negocioId,telefono]);
  await pool.query('INSERT INTO whatsapp_conversaciones(negocio_id,telefono) VALUES($1,$2)',[negocioId,telefono]);
  await pool.query("INSERT INTO negocio_modulos(negocio_id,modulo,estado) VALUES($1,'whatsapp','activo')",[negocioId]);
  await pool.query("INSERT INTO metodos_pago(negocio_id,tipo,habilitado,disponible_para_bot,disponible_para_operador,orden) VALUES($1,'efectivo',true,true,true,0)",[negocioId]);
  const { rows:[c] } = await pool.query("INSERT INTO menu_categorias(negocio_id,nombre,activa) VALUES($1,'Bebidas',true) RETURNING id",[negocioId]);
  const { rows:[p] } = await pool.query("INSERT INTO menu_productos(negocio_id,categoria_id,nombre,precio,disponible) VALUES($1,$2,'Café americano',45,true) RETURNING id",[negocioId,c.id]);
  await pool.query('INSERT INTO whatsapp_productos(negocio_id,producto_id,publicado) VALUES($1,$2,true)',[negocioId,p.id]);
  await pool.query("INSERT INTO integraciones_canal(negocio_id,canal,identificador,activo) VALUES($1,'whatsapp',$2,true)",[negocioId,marca]);
  const reglas = { restaurante:'Prueba aislada',timezone:'America/Matamoros',
    horarios:Object.fromEntries(['lunes','martes','miercoles','jueves','viernes','sabado','domingo'].map(d=>[d,{abierto:true,apertura:'00:00',cierre:'24:00'}])),
    pedidos:{modalidades:['recoger en tienda'],tiempo_preparacion_minutos:20,pedido_minimo_entrega:0,costo_envio:0,pago_aceptado:['efectivo']},
    cierres_especiales:[],promociones:[],politicas:[] };
  await actualizarConfiguracion({int_wa_phone_id:marca,int_wa_token:'token-local',mesero_agente_v1:'true',mesero_agente_telefonos:telefono,
    whatsapp_interactivos_v1:'true',reglas_atencion:JSON.stringify(reglas),pedido_requiere_pago:'true'},negocioId);
  const estado = estadoNuevo({negocioId,conversacionId:`agente:${telefono}`});
  estado.carrito = {items:[{lid:'cafe-1',id:p.id,nombre:'Café americano',cantidad:1,modificadores:[],notas:''}],
    datos:{modalidad:'recoger en tienda',forma_pago:'efectivo',cliente:{nombre:'Cliente local',telefono}}};
  await pool.query('INSERT INTO conversacion_estado(negocio_id,session_id,estado,revision) VALUES($1,$2,$3,1)',[negocioId,`agente:${telefono}`,JSON.stringify(estado)]);
  return {negocioId,telefono,marca,productoId:p.id,estado};
}

export async function prepararNegocioMixtos() {
  const f = await prepararNegocioBotones();
  const {rows:[p]} = await pool.query("INSERT INTO menu_productos(negocio_id,categoria_id,nombre,precio,disponible) SELECT $1,categoria_id,'Chilaquiles Mixtos',120,true FROM menu_productos WHERE id=$2 RETURNING id",[f.negocioId,f.productoId]);
  await pool.query('INSERT INTO whatsapp_productos(negocio_id,producto_id,publicado) VALUES($1,$2,true)',[f.negocioId,p.id]);
  for (const [orden,[nombre,minimo,maximo,opciones]] of [
    ['Salsa',1,2,['Roja','Verde','Suiza','Chipotle']],
    ['Proteína',1,1,['Pollo','Huevo']],
    ['Guarnición',2,2,['Frijoles','Papas a la mexicana','Arroz','Ensalada']],
  ].entries()) {
    const {rows:[g]}=await pool.query('INSERT INTO menu_modificadores_grupos(negocio_id,producto_id,nombre,requerido,minimo,maximo,orden) VALUES($1,$2,$3,true,$4,$5,$6) RETURNING id',
      [f.negocioId,p.id,nombre,minimo,maximo,orden]);
    for (const [i,n] of opciones.entries()) await pool.query('INSERT INTO menu_modificadores_opciones(negocio_id,grupo_id,nombre,precio_extra,disponible,orden) VALUES($1,$2,$3,$4,true,$5)',
      [f.negocioId,g.id,n,n==='Pollo'?20:n==='Chipotle'?5:0,i]);
  }
  f.estado.carrito.items=[{lid:'mixtos-1',id:p.id,nombre:'Chilaquiles Mixtos',cantidad:1,modificadores:[],notas:''}];
  delete f.estado.carrito.datos.modalidad;delete f.estado.carrito.datos.forma_pago;
  await pool.query('UPDATE conversacion_estado SET estado=$3 WHERE negocio_id=$1 AND session_id=$2',[f.negocioId,`agente:${f.telefono}`,JSON.stringify(f.estado)]);
  await actualizarConfiguracion({whatsapp_interactivos_elecciones_v1:'true'},f.negocioId);
  return {...f,mixtosId:p.id};
}
