// «Revisa tu pedido» con el nombre de cada grupo (prueba del dueño, 3-oct-2026).
// Suite pura: sin base de datos.
import assert from 'node:assert/strict';
import { respuestaDesdePedido, MAX_RESUMEN_AGRUPADO } from '../src/mesero-agente/recuperacionDelTurno.js';
import { vistaDelPedido } from '../src/mesero-agente/vistaDelPedido.js';
import { etiquetaGrupo, opcionesAgrupadas, tituloVisible } from '../src/mesero-agente/presentacionDeOpciones.js';

let ok = 0;
const t = (nombre, fn) => { fn(); ok++; console.log('OK', nombre); };
const g = (nombre, minimo, maximo, opciones) => ({ nombre, requerido: minimo > 0, minimo, maximo,
  opciones: opciones.map((n) => ({ nombre: n, disponible: true, precio_extra: 0 })) });
// Los grupos reales del Licuado de Obispado, en el orden del menú.
const CARTA = [{ id: 1, nombre: 'Bebidas', productos: [{ id: 112, nombre: 'Licuado', precio: 55, disponible: true, orden: 0,
  modificadores: [g('Medida', 1, 1, ['Chico', 'Grande 1 Litro']), g('Sabor', 1, 1, ['Platáno', 'Fresa', 'Melón', 'Papaya']),
    g('¿Fruta Extra?', 1, 1, ['Plátano', 'Fresa', 'Sin fruta extra', 'Melón', 'Papaya']),
    g('Complementos', 1, 3, ['Chocolate', 'Vainilla', 'Avena', 'Granola', 'Canela', 'Sin complementos']),
    g('Tipo de Leche', 1, 1, ['Entera', 'Deslactosada']), g('Endulzante', 1, 1, ['Azucar normal', 'Splenda', 'Sin azucar'])] }] }];
// Guardado en otro orden que el menú, como pasa cuando el cliente elige por partes.
const licuado = (lid = 'l1') => ({ lid, id: 112, nombre: 'Licuado', cantidad: 1, notas: '', modificadores: [
  { grupo: 'Complementos', opciones: ['Chocolate', 'Vainilla'] }, { grupo: 'Sabor', opciones: ['Melón'] },
  { grupo: 'Medida', opciones: ['Grande 1 Litro'] }, { grupo: '¿Fruta Extra?', opciones: ['Sin fruta extra'] },
  { grupo: 'Endulzante', opciones: ['Splenda'] }, { grupo: 'Tipo de Leche', opciones: ['Entera'] }] });
const datos = { modalidad: 'recoger en tienda', forma_pago: 'efectivo', cliente: {} };
const precios = { Licuado: 75 };
const render = (pedido, reglas = null) => respuestaDesdePedido({ estado: {}, pedido, modalidades: ['recoger en tienda'],
  metodosPago: [], requierePago: true, reglas });
// Una vista completa, sin opciones pendientes, para que salga el resumen.
const vista = (items) => {
  const v = vistaDelPedido({ carrito: { items, datos }, catalogo: CARTA, precios, requierePago: true });
  return { ...v, falta: [], lineas: v.lineas.map((l) => Object.defineProperty({ ...l, falta_elegir: [] }, 'gruposEnOrden',
    { value: l.gruposEnOrden, enumerable: false })), total: v.total ?? 75 * items.length };
};

t('R1 el licuado se lee con sus grupos y en el orden del menú', () => {
  const texto = render(vista([licuado()]));
  assert.match(texto, /\nMedida: Grande 1 Litro · Sabor: Melón · Fruta Extra: Sin fruta extra · Complementos: Chocolate, Vainilla · Tipo de Leche: Entera · Endulzante: Splenda\n/);
  assert.match(texto, /\nModalidad: Recoger en tienda\nForma de pago: Efectivo\n/);
});

t('R2 etiquetas sin «¿?» ni «:»; opciones sin grupo como hoy', () => {
  assert.equal(etiquetaGrupo('¿Fruta Extra?'), 'Fruta Extra');
  assert.equal(etiquetaGrupo('Salsa:'), 'Salsa');
  assert.equal(opcionesAgrupadas([{ opcion: 'Roja' }, { opcion: 'Pollo' }]), 'Roja · Pollo');
  assert.equal(tituloVisible('recoger'), 'Recoger');
  assert.equal(tituloVisible(''), '');
});

t('R3 la huella no depende del texto', () => {
  const v = vista([licuado()]);
  const antes = v.huella;
  render(v);
  assert.equal(v.huella, antes);
  assert.equal(vistaDelPedido({ carrito: { items: [licuado()], datos }, catalogo: CARTA, precios }).huella, antes);
});

t('R4 un pedido largo sale plano, igual que antes', () => {
  const muchos = Array.from({ length: 6 }, (_, i) => licuado(`l${i}`));
  const texto = render(vista(muchos));
  assert.doesNotMatch(texto, /Medida:/);
  assert.match(texto, /\nChocolate · Vainilla · Melón · Grande 1 Litro · Sin fruta extra · Splenda · Entera\n/);
  const corto = render(vista([licuado()]));
  assert.ok(corto.length <= MAX_RESUMEN_AGRUPADO);
});

t('R5 un nombre de grupo que parece afirmar un cambio deja el renglón plano', () => {
  const linea = (opciones) => ({ producto: 'Licuado', cantidad: 1, precio_unitario: 75, nota: null, opciones });
  const pedido = (opciones) => ({ lineas: [linea(opciones)], falta: [], aclaraciones: [], subtotal: 75, costo_envio: 0,
    total: 75, modalidad: 'recoger en tienda', forma_pago: 'efectivo', cliente: {} });
  for (const opciones of [[{ grupo: 'Registro', opcion: 'Sí' }], [{ grupo: '¿Te lo agregamos?', opcion: 'Sí' }],
    [{ grupo: 'Listo para llevar', opcion: 'Sí' }, { grupo: 'Agregados', opcion: 'Queso' }]]) {
    const texto = render(pedido(opciones));
    assert.doesNotMatch(texto, /Registro:|agregamos:|Agregados:/, JSON.stringify(opciones));
  }
  // Una frase prohibida del negocio que coincide con un grupo también baja a plano.
  const reglas = { bot: { respuestas_prohibidas: ['Sabor: Melón'] } };
  assert.doesNotMatch(render(pedido([{ grupo: 'Sabor', opcion: 'Melón' }]), reglas), /Sabor:/);
  assert.match(render(pedido([{ grupo: 'Sabor', opcion: 'Melón' }])), /Sabor: Melón/);
});

console.log(`fase-resumen-agrupado: ${ok}/5`);
