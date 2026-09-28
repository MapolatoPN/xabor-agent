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
