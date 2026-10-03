// Cómo se LEEN las opciones de un platillo en el resumen y en las listas.
//
// Solo presentación. La huella de confirmación se calcula con la estructura
// (`grupo:opcion`), y la foto de los formularios guarda sus propios títulos:
// nada de lo que se arma aquí decide qué se cobra ni qué se confirma.
//
// 3-oct, prueba del dueño: «Grande 1 Litro · Melón · Sin fruta extra ·
// Chocolate · Vainilla» no se podía verificar de un vistazo. Con el nombre
// del grupo, cada opción dice a qué pregunta responde.

const limpio = (v) => String(v ?? '').replace(/[*_~`]/g, '').trim();
const normalizar = (v) => limpio(v).toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ]+/g, ' ').trim();

/** «¿Fruta Extra?» → «Fruta Extra». Conserva las mayúsculas del menú. */
export function etiquetaGrupo(nombre) {
  return limpio(nombre).replace(/^¿\s*/, '').replace(/\s*\?$/, '').replace(/:/g, '').trim();
}

/**
 * «Medida: Grande 1 Litro · Sabor: Melón · Complementos: Chocolate, Vainilla».
 *
 * Los grupos van en el orden del catálogo cuando se conoce (`gruposEnOrden`);
 * si no, en el orden en que se guardaron. Las opciones sin grupo van sin
 * etiqueta, igual que hoy.
 */
export function opcionesAgrupadas(opciones = [], gruposEnOrden = []) {
  const orden = new Map((gruposEnOrden || []).map((g, i) => [normalizar(g), i]));
  const grupos = [];
  for (const o of opciones || []) {
    const clave = normalizar(o?.grupo);
    let g = grupos.find((x) => x.clave === clave);
    if (!g) grupos.push(g = { clave, etiqueta: etiquetaGrupo(o?.grupo), opciones: [], llegada: grupos.length });
    g.opciones.push(limpio(o?.opcion));
  }
  const posicion = (g) => (orden.has(g.clave) ? orden.get(g.clave) : 1e6 + g.llegada);
  grupos.sort((a, b) => posicion(a) - posicion(b));
  return grupos.map((g) => (g.etiqueta ? `${g.etiqueta}: ${g.opciones.join(', ')}` : g.opciones.join(' · '))).join(' · ');
}

/** «recoger» → «Recoger». Solo para lo que se muestra; nunca para datos comparados. */
export function tituloVisible(texto) {
  const s = String(texto ?? '');
  return s ? s[0].toLocaleUpperCase('es-MX') + s.slice(1) : s;
}
