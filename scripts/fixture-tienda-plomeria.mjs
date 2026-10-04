// Fixtures puras de la plomería del formulario «tienda» (tienda_v1): una carta
// con la forma de la de Mapolato (desayunos con opciones, bebidas y tacos por
// cantidad), la configuración de un negocio con dirección y nota activas, y
// los estados de la conversación que abren cada formulario. Sin base de
// datos, Meta ni red. Las usan check-tienda-plomeria.mjs (predeploy) y
// test/fase-tienda-bandera-apagada.mjs (contra el código de la base).
import { estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';

export const IDS = Object.freeze({ categorias: '66666666666', carrito: '77777777777', categoriasDir: '88888888888',
  carritoDir: '99999999999', categoriasNota: '12121212121', carritoNota: '13131313131', configurar: '44444444444',
  editar: '55555555555', tienda: '14141414141' });
export const TELEFONO = '5218781234567';
export const OTRO_TELEFONO = '5218780000000';

const grupo = (nombre, minimo, maximo, opciones, extras = {}) => ({ nombre, requerido: minimo > 0, minimo, maximo,
  opciones: opciones.map((o) => ({ nombre: o, precio_extra: extras[o] || 0, disponible: true })) });
const producto = (id, nombre, precio, modificadores = [], orden = 0) => ({ id, nombre, precio, disponible: true, orden, modificadores });

/** La carta: `categoriasExtra` agrega categorías de un platillo (para pasar de 20). */
export function carta({ categoriasExtra = 0 } = {}) {
  const c = [
    { id: 'c1', nombre: 'Desayunos', orden: 0, productos: [
      producto(1, 'Chilaquiles', 145, [grupo('Salsa', 1, 1, ['Roja', 'Verde', 'Chipotle'], { Chipotle: 10 }),
        grupo('Proteína', 1, 1, ['Huevo', 'Pollo', 'Bistec'], { Bistec: 30 })], 0),
      producto(2, 'Hotcakes', 139, [], 1)] },
    { id: 'c2', nombre: 'Bebidas', orden: 1, productos: [producto(3, 'Café americano', 45), producto(4, 'Jugo de naranja', 55.5, [], 1)] },
    { id: 'c3', nombre: 'Tacos', orden: 2, productos: [
      producto(5, 'Taco de Barbacoa', 30, [grupo('Tortilla', 1, 1, ['Harina', 'Maíz'])]),
      producto(6, 'Taco de Pastor', 28, [grupo('Tortilla', 1, 1, ['Harina', 'Maíz'])], 1)] },
  ];
  for (let i = 0; i < categoriasExtra; i++) {
    c.push({ id: `x${i}`, nombre: `Especial ${i}`, orden: 10 + i, productos: [producto(100 + i, `Especial ${i}`, 50 + i)] });
  }
  return c;
}

export const reglas = { pedidos: { modalidades: ['recoger en tienda', 'entrega a domicilio'], costo_envio: 60,
  zonas_entrega: [{ nombre: 'UTNC', costo: 150 }, { nombre: 'Cervecera', costo: 150 }] } };
export const modalidades = ['recoger en tienda', 'entrega a domicilio'];
export const metodosPago = [{ tipo: 'efectivo', disponible_para_bot: true, habilitado: true }, { tipo: 'tarjeta', disponible_para_bot: true, habilitado: true }];

/** Mapolato hoy: Flows, carrito unificado, categorías y carrito con dirección y nota. */
export const cfgHoy = Object.freeze({ whatsapp_flows_v1: 'true', whatsapp_atencion_general_v1: 'true', whatsapp_inicio_mapo_v1: 'true',
  bot_whatsapp_solo_prueba: 'false', whatsapp_carrito_unificado_v1: 'true', whatsapp_flow_configurar_id: IDS.configurar,
  whatsapp_flow_categorias_id: IDS.categorias, whatsapp_flow_carrito_id: IDS.carrito,
  whatsapp_flow_categorias_dir_id: IDS.categoriasDir, whatsapp_flow_carrito_dir_id: IDS.carritoDir,
  whatsapp_flow_nota_v1: 'true', whatsapp_flow_categorias_nota_id: IDS.categoriasNota, whatsapp_flow_carrito_nota_id: IDS.carritoNota });
/** La tienda encendida: 'true' (todos) o 'prueba' (solo TELEFONO). */
export const cfgTienda = (modo = 'true', extra = {}) => ({ ...cfgHoy, whatsapp_flow_tienda_v1: modo, whatsapp_flow_tienda_id: IDS.tienda,
  ...(modo === 'prueba' ? { whatsapp_flow_tienda_telefonos: TELEFONO } : {}), ...extra });

const CHILAQUILES = { lid: 'L1', id: 1, nombre: 'Chilaquiles', cantidad: 2, notas: 'Sin cebolla',
  modificadores: [{ grupo: 'Salsa', opciones: ['Verde'] }, { grupo: 'Proteína', opciones: ['Pollo'] }] };
const CAFE = { lid: 'L2', id: 3, nombre: 'Café americano', cantidad: 1, notas: '', modificadores: [] };

/**
 * Un estado de la conversación. `items`: 'vacio' | 'dos' | número de cafés |
 * arreglo. `entrega`: datos del carrito (modalidad, forma_pago).
 */
export function estado({ pendiente = { tipo: 'agregar_otro' }, items = 'vacio', entrega = {}, cantidad = null } = {}) {
  const e = estadoNuevo({ negocioId: 'n', conversacionId: 'c' });
  e.carrito.items = Array.isArray(items) ? structuredClone(items) : items === 'dos' ? structuredClone([CHILAQUILES, CAFE])
    : typeof items === 'number' ? Array.from({ length: items }, (_, i) => ({ ...structuredClone(CAFE), lid: `C${i}` })) : [];
  if (cantidad !== null && e.carrito.items[0]) e.carrito.items[0].cantidad = cantidad;
  e.carrito.datos = { cliente: { referencias: '' }, ...entrega };
  e.pendiente = pendiente;
  e.dialogo = { ciclo: e.conversacionId, texto: 'Elige', id: 'd1' };
  return e;
}

/** Los estados que abren cada formulario de pedido (acción y pendiente). */
export const ESCENARIOS = Object.freeze([
  ['arma tu pedido, vacío', 'flow_productos', () => estado()],
  ['elegir producto, uno', 'flow_productos', () => estado({ pendiente: { tipo: 'elegir_producto', cantidad: 1, candidatos: [{ id: 5 }, { id: 6 }] } })],
  ['elegir producto, tres', 'flow_productos', () => estado({ pendiente: { tipo: 'elegir_producto', cantidad: 3, candidatos: [{ id: 5 }] } })],
  ['arma tu pedido con platillos', 'flow_productos', () => estado({ items: 'dos' })],
  ['tu carrito (agregar otro)', 'flow_configurar', () => estado({ items: 'dos' })],
  ['editar pedido', 'flow_configurar', () => estado({ pendiente: { tipo: 'editar_pedido' }, items: 'dos' })],
  ['dirección con pago', 'flow_configurar', () => estado({ pendiente: { tipo: 'direccion' }, items: 'dos',
    entrega: { modalidad: 'entrega a domicilio', forma_pago: 'efectivo' } })],
  ['dirección sin pago', 'flow_configurar', () => estado({ pendiente: { tipo: 'direccion' }, items: 'dos',
    entrega: { modalidad: 'entrega a domicilio' } })],
  ['personaliza (legado)', 'flow_configurar', () => estado({ pendiente: { tipo: 'elegir_opcion' }, items: 'dos' })],
  ['carrito de 21 renglones', 'flow_configurar', () => estado({ items: 21 })],
  ['cantidad de 25', 'flow_configurar', () => estado({ items: 'dos', cantidad: 25 })],
  ['carrito vacío', 'flow_configurar', () => estado({ pendiente: { tipo: 'editar_pedido' } })],
]);

// El transporte de Flows exige estas variables. Se ponen solo durante los
// casos que las usan y se restauran (este chequeo corre dentro del predeploy).
const ENTORNO_FLOWS = { WHATSAPP_FLOW_ENDPOINT: 'true', WHATSAPP_FLOW_PRIVATE_KEY: 'x', META_APP_SECRET: 'x' };
export async function conEntornoFlows(fn, entorno = process.env) {
  const previo = Object.fromEntries(Object.keys(ENTORNO_FLOWS).map((k) => [k, entorno[k]]));
  Object.assign(entorno, ENTORNO_FLOWS);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete entorno[k]; else entorno[k] = v; }
  }
}

/** construirFormulario sin lo aleatorio (token y preguntaId), para comparar. */
export function sinAzar(r) {
  if (!r) return r;
  const c = structuredClone(r), token = c.botones?.[0]?.token;
  delete c.preguntaId;
  const s = JSON.stringify(c);
  return JSON.parse(token ? s.split(token).join('TOKEN') : s);
}
