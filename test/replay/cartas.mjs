// ─── LAS CARTAS DEL REPLAY ────────────────────────────────────────────────
//
// Dos negocios, a propósito, y sin una palabra en común entre sus cartas: la
// invariante de multiempresa no se puede medir con un solo negocio.
//
// La primera es la de Obispado, copiada de las suites que ya la usan (mismas
// cardinalidades: `Salsa 1-1` en los sencillos y `1-2` en los mixtos es dato
// del negocio, y es lo que separa dos presentaciones del mismo platillo sin
// que nadie escriba una regla sobre chilaquiles).

const g = (nombre, minimo, maximo, opciones, requerido = true) => ({
  nombre, requerido, minimo, maximo,
  opciones: opciones.map((n) => ({ nombre: n, disponible: true, precio_extra: 0 })),
});

const SALSAS = ['Roja', 'Suiza', 'Verde', 'Mole', 'Chipotle'];
const PROTS = ['Huevos Estrellados', 'Huevos Revueltos', 'Pechuga de pollo', 'Chicharron Prensado'];
const GUARNS = ['Frijolitos naturales', 'Frijolitos con chorizo', 'Papas a la mexicana', 'Papas con chorizo'];

export const OBISPADO = [
  { id: 1, nombre: 'CHILAQUILES', productos: [
    { id: 11, nombre: 'Chilaquiles Sencillos', precio: 195, disponible: true, orden: 0,
      modificadores: [g('Salsa', 1, 1, SALSAS), g('Proteína', 1, 1, PROTS), g('Guarniciones', 1, 2, GUARNS)] },
    { id: 12, nombre: 'Chilaquiles Mixtos', precio: 205, disponible: true, orden: 1,
      modificadores: [g('Salsa', 1, 2, SALSAS), g('Proteína', 1, 2, PROTS), g('Guarniciones', 1, 2, GUARNS)] },
    { id: 13, nombre: 'Bowl de Chilaquiles', precio: 140, disponible: true, orden: 2,
      modificadores: [g('Salsa', 1, 1, SALSAS), g('Proteína', 1, 1, PROTS)] },
  ] },
  { id: 2, nombre: 'DULCES', productos: [
    { id: 21, nombre: 'Hotcakes', precio: 95, disponible: true, orden: 0,
      modificadores: [g('Fruta', 0, 2, ['Fresa', 'Plátano'], false)] },
    { id: 22, nombre: 'Waffle', precio: 105, disponible: true, orden: 1,
      modificadores: [g('Fruta', 0, 2, ['Fresa', 'Plátano'], false)] },
  ] },
  { id: 3, nombre: 'BEBIDAS', productos: [
    { id: 31, nombre: 'Licuado de fresa', precio: 60, disponible: true, orden: 0, modificadores: [] },
    { id: 32, nombre: 'Licuado de platano', precio: 60, disponible: true, orden: 1, modificadores: [] },
    { id: 33, nombre: 'Café Americano', precio: 45, disponible: true, orden: 2, modificadores: [] },
  ] },
];

/** El otro negocio. Ni una palabra compartida con el anterior. */
export const PIZZERIA = [
  { id: 1, nombre: 'PIZZAS', productos: [
    { id: 51, nombre: 'Pizza Individual', precio: 120, disponible: true, orden: 0,
      modificadores: [g('Sabor', 1, 1, ['Pepperoni', 'Hawaiana', 'Mexicana'])] },
    { id: 52, nombre: 'Pizza Mitad y Mitad', precio: 160, disponible: true, orden: 1,
      modificadores: [g('Sabor', 2, 2, ['Pepperoni', 'Hawaiana', 'Mexicana'])] },
  ] },
  { id: 2, nombre: 'ENTRADAS', productos: [
    { id: 61, nombre: 'Pan de ajo', precio: 55, disponible: true, orden: 0, modificadores: [] },
  ] },
];

export const NEGOCIOS = Object.freeze({
  obispado: { id: '11111111-1111-1111-1111-111111111111', nombre: 'Obispado', catalogo: OBISPADO },
  pizzeria: { id: '22222222-2222-2222-2222-222222222222', nombre: 'La Pizzería', catalogo: PIZZERIA },
});

/** Los precios como los espera `resumenDelPedido`: por nombre canónico. */
export function preciosDe(catalogo) {
  const fuera = {};
  for (const c of catalogo) for (const p of c.productos) fuera[p.nombre] = p.precio;
  return fuera;
}

/** Todos los nombres vendibles de una carta: lo que se usa para detectar inventos. */
export function nombresDe(catalogo) {
  return catalogo.flatMap((c) => c.productos.filter((p) => p.disponible !== false).map((p) => p.nombre));
}

/** Resuelve `$id:Nombre` de un fixture al id real de esa carta. */
export function idDe(catalogo, nombre) {
  for (const c of catalogo) {
    for (const p of c.productos) if (p.nombre === nombre) return String(p.id);
  }
  throw new Error(`el fixture pide el id de "${nombre}" y esa carta no lo tiene`);
}
