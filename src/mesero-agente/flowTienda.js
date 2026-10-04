// Formulario «tienda» (contrato tienda_v1): el borrador del endpoint. Puro: sin
// base de datos, Meta ni pedidos; el adaptador SQL (flowRepetibleSql.js) guarda
// el borrador y aplica las barreras de sesión, igual que con carrito_v1.
//
// El borrador tiene la MISMA forma que el de carrito_v1 (filas eN/nN con su
// item, siguiente, deshacer, modalidad, pago, dirección y nota): el recibo
// final, comandosCarrito, el resumen en el chat y la huella sirven sin tocar
// nada comercial. Solo agrega `aperturas` (las últimas 20 altas),
// `apertura_minima` (la revisión más vieja que esas 20 aún reconocen) y `vista`
// (qué pantalla dibujar; una vista nueva sin cambio de revisión no se guarda).
//
// Etapas: TIENDA | ENTREGA | DIRECCION | FINAL. Dentro de TIENDA el servidor no
// sabe en qué pantalla de exploración está el cliente y no lo necesita:
//   - solo lectura (ver, ver_tacos, ver_carrito, editar, seguir, categoria):
//     no escriben el borrador ni exigen la revisión;
//   - agregar: no exige la revisión (es un alta, no choca con otros cambios);
//     la protege la apertura r{revision}.p{N} que mandó «ver». Una apertura ya
//     usada responde «Ya está en tu pedido» y no duplica (doble toque, o Atrás
//     hasta una ficha vieja);
//   - aplicar, quitar, deshacer, continuar y los tacos exigen la revisión;
//   - ENTREGA y DIRECCION (y su Atrás) se delegan en cambiarCarrito y
//     respuestaCarrito, con CARRITO traducido a TIENDA.
// Después de «Agregar» responde la CATEGORIA del platillo con «Tu pedido» al
// día. El dueño pidió el MENU (A1), pero el teléfono no deja saltar de la ficha
// al MENU (4-oct, «invalid-screen-transition»); Atrás desde la categoría trae
// el MENU fresco.
//
// Las respuestas son la misma pantalla, la siguiente del routing_model o la de
// antes (la que tiene la arista hacia ésta); toda apertura (INIT) es el MENU.
// Ver la nota [M] junto a regreso().
import { borradorCarrito, cambiarCarrito, respuestaCarrito, comandosCarrito, faltantesCarrito, lineaVista, codigo } from './flowCarrito.js';
import { borradorCategorias, cambiarCategorias, respuestaCategorias, sinDireccion } from './flowCategorias.js';
import { cantidadFlow } from './catalogoFlowCategorias.js';
import { comandosFormulario } from './formularioAgrupado.js';
import { leerObservacionesPlatillo, MAX_OBSERVACIONES_PLATILLO } from './observacionesDelPlatillo.js';
import { sinContratoDireccion } from './direccionFormulario.js';
import { sinContratoNota } from './notaDelPedido.js';
import { RANURAS, MAX_RENGLONES_TIENDA, LIMITES_TIENDA, varianteDeGrupo, categoriaDeTacos, entradasMenu, datosMenu, datosCategoria,
  datosPersonalizar, datosEditar, datosCarrito, resumenDelPedido, recortar, bloque } from './catalogoFlowTienda.js';

export const ETAPAS_TIENDA = Object.freeze(['TIENDA', 'ENTREGA', 'DIRECCION', 'FINAL']);
export const PANTALLAS_TIENDA = Object.freeze(['MENU', 'CATEGORIA', 'PERSONALIZAR', 'TACOS', 'CARRITO', 'EDITAR']);
export const MAX_APERTURAS = 20;
export const MAX_DESHACER = 10; // como carrito_v1
// Qué operación admite cada pantalla, y cuáles solo leen.
export const OPERACIONES_TIENDA = Object.freeze({
  MENU: ['ver_carrito', 'categoria'], CATEGORIA: ['ver', 'ver_tacos', 'ver_carrito'], PERSONALIZAR: ['agregar'],
  TACOS: ['terminar', 'agregar', 'individual'], CARRITO: ['editar', 'seguir', 'deshacer', 'continuar'], EDITAR: ['aplicar', 'quitar'],
});
export const SOLO_LECTURA = Object.freeze(['ver', 'ver_tacos', 'ver_carrito', 'editar', 'seguir', 'categoria']);
const RANURAS_CLAVES = Array.from({ length: RANURAS }, (_, g) => ['r', 's', 'm'].map((v) => `g${g}_${v}`)).flat();
const CLAVES = {
  ver_carrito: ['operacion'], seguir: ['operacion'], categoria: ['operacion', 'categoria'], ver: ['operacion', 'producto'],
  ver_tacos: ['operacion', 'categoria'], editar: ['operacion', 'fila'], deshacer: ['operacion', 'revision'], continuar: ['operacion', 'revision'],
  quitar: ['operacion', 'revision', 'fila'], aplicar: ['operacion', 'revision', 'fila', 'cantidad', 'observaciones', ...RANURAS_CLAVES],
  agregar: ['operacion', 'apertura', 'producto', 'cantidad', 'observaciones', ...RANURAS_CLAVES],
};
// Atrás desde una pantalla de exploración (lo mandan las que llevan
// refresh_on_back: MENU, CATEGORIA y CARRITO): la pantalla de antes. Desde una
// categoría o el carrito, el MENU fresco (al carrito abierto desde una
// categoría también se le responde el MENU: salto conocido).
const ATRAS = { MENU: 'MENU', CATEGORIA: 'MENU', PERSONALIZAR: 'MENU', TACOS: 'MENU', CARRITO: 'MENU', EDITAR: 'CARRITO' };
const APERTURA = /^r(0|[1-9]\d*)\.p(0|[1-9]\d*)$/;
/** La revisión más vieja cuya apertura todavía se reconoce (sube cuando una sale de las últimas 20). */
const aperturaMinima = (b) => (Number.isInteger(b?.apertura_minima) && b.apertura_minima > 0 ? b.apertura_minima : 0);

// La compra de platillos valida sin dirección ni nota (son del cierre).
const sinContrato = (f) => sinContratoNota(sinContratoDireccion(f));
const compraFoto = (f) => ({ ...sinContrato(f), tipo: 'flow_productos', version: 'repetible_v1', presentacion: 'categorias_v1' });
const modo = (b) => (Number.isInteger(b.modalidad) ? (b.modalidad < 0 ? '' : `m${b.modalidad}`) : b.modalidad);
const pago = (b) => (Number.isInteger(b.pago) ? (b.pago < 0 ? '' : `p${b.pago}`) : b.pago);
const unir = (l) => (l.length < 2 ? l.join('') : `${l.slice(0, -1).join(', ')} y ${l.at(-1)}`);
const vacio = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
const objeto = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** La pantalla que corresponde a la etapa cuando nada más la decide. */
const vistaDeEtapa = (b) => ({ pantalla: b?.etapa === 'TIENDA' || !ETAPAS_TIENDA.includes(b?.etapa) ? 'MENU' : b.etapa });

/** El platillo pN de la foto, o -1. */
export function productoDeLaFoto(foto, id) {
  const i = codigo(id, 'p');
  return i >= 0 && foto.productos?.[i] ? i : -1;
}

// [M] Lo que el teléfono acepta como respuesta (4-oct, avisos del teléfono y
// telemetría del 1 al 4-oct): la misma pantalla, una arista del routing_model
// o la pantalla de la que sale esa arista (la de antes). Un salto entre
// pantallas no vecinas lo rechaza con «invalid-screen-transition … doesn't
// satisfy provided routing_model» aunque el destino esté en la pila: así fallaba
// «Agregar» (PERSONALIZAR → MENU) y falla «Agregar al carrito» de carrito_v1
// (PLATILLO → CARRITO). Y el INIT solo abre en la primera pantalla (MENU): uno
// que abrió en ENTREGA también dio aviso. Por eso la ficha y los tacos regresan
// a su CATEGORIA, nunca al MENU, y toda apertura es el MENU.
/** La entrada del menú (página de categoría) donde está el platillo i: la CATEGORIA de la que salió su ficha. */
export function entradaDelPlatillo(foto, i) {
  const entradas = entradasMenu(foto);
  return (entradas.find((e) => e.elementos.includes(i)) || entradas[0])?.id ?? null;
}
/** La página de la categoría de tacos que trae «Varios tacos a la vez» (de ella sale TACOS). */
function entradaDeTacos(foto) {
  const tacos = categoriaDeTacos(foto), entradas = entradasMenu(foto);
  return ((tacos && entradas.find((e) => e.categoria.id === tacos.id && e.elementos.includes(null))) || entradas[0])?.id ?? null;
}
/** Adónde regresa una respuesta que no se queda en su pantalla: la pantalla de antes. */
function regreso(foto, s, d) {
  if (s?.screen === 'TACOS') return { pantalla: 'CATEGORIA', entrada: entradaDeTacos(foto) };
  if (s?.screen === 'PERSONALIZAR') return { pantalla: 'CATEGORIA', entrada: entradaDelPlatillo(foto, productoDeLaFoto(foto, d?.producto)) };
  if (s?.screen === 'EDITAR' || s?.screen === 'CARRITO') return { pantalla: 'CARRITO' };
  return { pantalla: 'MENU' };
}

/**
 * El borrador inicial: el de carrito_v1 (filas eN de la foto, modalidad y pago)
 * con la etapa TIENDA y sin aperturas. «Escribir dirección» abre en DIRECCION.
 */
export function borradorTienda(foto) {
  const b = borradorCarrito(foto);
  return { ...b, etapa: b.etapa === 'CARRITO' ? 'TIENDA' : b.etapa, aperturas: [] };
}

/**
 * Lo que manda PERSONALIZAR o EDITAR (ids «oN» de su ficha) → item con la forma
 * de carrito_v1 ({producto0, cantidad, observaciones, gG_s|gG_m con p{i}g{G}o{N}}).
 * Estricto: cada grupo llega por la variante que su ficha dibuja (Radio,
 * Dropdown o Checkbox) y las demás vacías; una ranura sin grupo, vacía.
 */
export function itemDeFicha(foto, i, d) {
  const p = foto.productos?.[i];
  if (!p) return { error: 'Ese platillo ya no está disponible.' };
  const nota = leerObservacionesPlatillo(d.observaciones);
  if (nota === null) return { error: `Usa hasta ${MAX_OBSERVACIONES_PLATILLO} caracteres de texto en la nota para cocina.` };
  if (!cantidadFlow(d.cantidad)) return { error: 'Elige la cantidad del platillo.' };
  const item = { producto0: `p${i}`, cantidad: d.cantidad, observaciones: nota }, faltan = [];
  for (let g = 0; g < RANURAS; g++) {
    const grupo = p.grupos[g], valores = { r: d[`g${g}_r`], s: d[`g${g}_s`], m: d[`g${g}_m`] };
    for (const [t, v] of Object.entries(valores)) {
      if (!vacio(v) && (t === 'm' ? !Array.isArray(v) || v.some((x) => typeof x !== 'string') : typeof v !== 'string')) return { error: 'Selección no disponible.' };
    }
    if (!grupo) { if (Object.values(valores).some((v) => !vacio(v))) return { error: 'Selección no disponible.' }; continue; }
    const propia = varianteDeGrupo(grupo);
    if (Object.entries(valores).some(([t, v]) => t !== propia && !vacio(v))) return { error: 'Selección no disponible.' };
    const ids = vacio(valores[propia]) ? [] : propia === 'm' ? valores.m : [valores[propia]], indices = [];
    for (const id of ids) {
      const k = codigo(id, 'o');
      if (!grupo.opciones[k] || indices.includes(k)) return { error: 'Selección no disponible.' };
      indices.push(k);
    }
    if (indices.length > grupo.maximo) return { error: `En ${grupo.nombre} elige hasta ${grupo.maximo}.` };
    if (indices.length < grupo.minimo) faltan.push(grupo.nombre);
    item[`g${g}_${grupo.maximo > 1 ? 'm' : 's'}`] = grupo.maximo > 1 ? indices.map((k) => `p${i}g${g}o${k}`) : indices.length ? `p${i}g${g}o${indices[0]}` : '';
  }
  if (faltan.length) return { error: `Falta elegir ${unir(faltan)} para este platillo.` };
  // La misma validación que el recibo final (comandosCarrito → comandosFormulario).
  if (comandosFormulario(compraFoto(foto), { items: [item], modalidad: 'm0', pago: 'p0' }) === null) return { error: 'Completa las opciones del platillo.' };
  return { item };
}

/** «Para continuar falta elegir…» con los nombres (incidente 1-oct-2026), en palabras de la tienda. */
export function textoFaltantesTienda(platillos = []) {
  if (!platillos.length) return '';
  if (platillos.length === 1) return `Para continuar falta elegir ${unir(platillos[0].grupos)} en ${platillos[0].nombre}. Ábrelo en «Editar o quitar».`;
  return `Para continuar falta elegir opciones en ${platillos.length} platillos (${unir(platillos.map((p) => p.nombre))}). Ábrelos uno por uno en «Editar o quitar».`;
}

/** El borrador resumido para dibujar: renglones con nombre, detalle e importe (centavos, como carrito_v1). */
export function pedidoDelBorrador(foto, b) {
  const renglones = (b.filas || []).map((f) => {
    const l = lineaVista(foto, f);
    const importeCentavos = Math.round((l.ficha.precio + l.seleccion.reduce((n, o) => n + o.precio, 0)) * 100) * l.cantidad;
    const faltan = l.ficha.grupos.filter((g) => l.seleccion.filter((o) => o.grupo === g.nombre).length < g.minimo).map((g) => g.nombre);
    return { key: f.key, nombre: l.ficha.nombre, cantidad: l.cantidad, detalle: [...l.seleccion.map((o) => o.opcion), l.nota].filter(Boolean).join(' · '),
      importeCentavos, faltan };
  });
  return { renglones, unidades: renglones.reduce((n, r) => n + r.cantidad, 0), subtotalCentavos: renglones.reduce((n, r) => n + r.importeCentavos, 0) };
}

export function cambiarTienda(foto, anterior, s) {
  const b = structuredClone(anterior), d = s?.data;
  if (!Array.isArray(b.aperturas)) b.aperturas = [];
  if (!Array.isArray(b.deshacer)) b.deshacer = [];
  // Solo lectura: misma revisión, así el adaptador no escribe nada.
  const leer = (vista) => ({ borrador: { ...b, revision: anterior.revision, vista } });
  const fallo = (error, vista) => ({ borrador: { ...structuredClone(anterior), vista: vista || vistaDeEtapa(anterior) }, error });
  const escribir = (vista, etapa = 'TIENDA') => { b.etapa = etapa; b.revision++; b.vista = vista; return { borrador: b }; };
  const recordar = () => {
    b.deshacer = [...b.deshacer, { filas: structuredClone(anterior.filas), modalidad: anterior.modalidad, pago: anterior.pago,
      aperturas: [...(anterior.aperturas || [])] }].slice(-MAX_DESHACER);
  };
  // ENTREGA y DIRECCION: las de carrito_v1, con su etapa CARRITO llamada TIENDA.
  const delegar = () => {
    const r = cambiarCarrito(foto, { ...b, etapa: b.etapa === 'TIENDA' ? 'CARRITO' : b.etapa }, s);
    const nb = { ...r.borrador, etapa: r.borrador.etapa === 'CARRITO' ? 'TIENDA' : r.borrador.etapa };
    delete nb.compra; delete nb.editando;
    // Del carrito (o de la entrega) solo se regresa al carrito: es su ancestro.
    nb.vista = nb.etapa === 'TIENDA' ? { pantalla: 'CARRITO' } : vistaDeEtapa(nb);
    return r.error ? { borrador: nb, error: r.error } : { borrador: nb };
  };

  if (s?.action === 'INIT') {
    if (b.etapa === 'FINAL') return leer({ pantalla: 'FINAL' });
    // Toda apertura es el MENU, la primera pantalla: el teléfono rechaza un INIT
    // en otra [M]. «Ver mi pedido» o un cierre a medias (ENTREGA, DIRECCION,
    // también «Escribir dirección») abren el MENU con «Tu pedido» hasta arriba;
    // lo elegido (platillos, entrega, pago, dirección, nota) se conserva.
    if (['ENTREGA', 'DIRECCION'].includes(b.etapa)) {
      b.etapa = 'TIENDA'; b.revision++; b.vista = { pantalla: 'MENU' };
      return { borrador: b };
    }
    return leer({ pantalla: 'MENU' });
  }
  if (b.etapa === 'FINAL') return leer({ pantalla: 'FINAL' });
  if (s?.action === 'BACK') {
    if (['ENTREGA', 'DIRECCION'].includes(s.screen)) return delegar();
    return leer({ pantalla: ATRAS[s.screen] || 'MENU' });
  }
  if (s?.action !== 'data_exchange' || !objeto(d)) return fallo('No pude leer la selección. Intenta de nuevo.', regreso(foto, s, null));
  if (['ENTREGA', 'DIRECCION'].includes(s.screen)) return delegar();
  if (!PANTALLAS_TIENDA.includes(s.screen)) return fallo('Ventana no disponible.');
  const op = d.operacion;
  if (!OPERACIONES_TIENDA[s.screen].includes(op)) return fallo('Acción no disponible.', regreso(foto, s, d));
  if (s.screen !== 'TACOS' && Object.keys(d).some((k) => !CLAVES[op].includes(k))) {
    return fallo('Selección no disponible.', regreso(foto, s, d));
  }
  const vigente = () => d.revision === String(anterior.revision);
  const fila = () => b.filas.find((f) => f.key === d.fila);

  // ── Solo lectura ──
  if (op === 'ver_carrito') return leer({ pantalla: 'CARRITO' });
  if (op === 'seguir') return leer({ pantalla: 'MENU' });
  if (op === 'categoria') {
    return entradasMenu(foto).some((e) => e.id === d.categoria) ? leer({ pantalla: 'CATEGORIA', entrada: d.categoria })
      : fallo('Esa categoría ya no está en el menú.', { pantalla: 'MENU' });
  }
  if (op === 'ver') {
    const i = productoDeLaFoto(foto, d.producto);
    if (i < 0) return fallo('Ese platillo ya no está disponible.', { pantalla: 'MENU' });
    return leer({ pantalla: 'PERSONALIZAR', producto: `p${i}`, apertura: `r${anterior.revision}.p${i}` });
  }
  if (op === 'ver_tacos') {
    const tacos = categoriaDeTacos(foto);
    return tacos && d.categoria === tacos.id ? leer({ pantalla: 'TACOS', categoria: tacos.id }) : fallo('Selección no disponible.', { pantalla: 'MENU' });
  }
  if (op === 'editar' && s.screen === 'CARRITO') {
    return fila() ? leer({ pantalla: 'EDITAR', fila: d.fila }) : fallo('Ese platillo ya no está en tu pedido.', { pantalla: 'CARRITO' });
  }

  // ── Alta desde la ficha ──
  if (s.screen === 'PERSONALIZAR') {
    const m = typeof d.apertura === 'string' ? APERTURA.exec(d.apertura) : null, i = productoDeLaFoto(foto, d.producto);
    // Una apertura que no salió de «ver» (de otro platillo o de una revisión
    // futura) no vale; tampoco una tan vieja que ya no se recuerda si se usó
    // (anterior a la última que salió de las 20 recordadas).
    if (!m || i < 0 || Number(m[1]) > anterior.revision || Number(m[1]) < aperturaMinima(anterior) || Number(m[2]) !== i) {
      return fallo('La ventana cambió. Elige el platillo otra vez.', regreso(foto, s, d));
    }
    if (b.aperturas.includes(d.apertura)) {
      // No se duplica. El aviso dice la verdad: si lo quitó después, ya no está.
      const nombre = foto.productos[i].nombre, sigue = b.filas.some((f) => f.item.producto0 === `p${i}`);
      return leer({ pantalla: 'CATEGORIA', entrada: entradaDelPlatillo(foto, i), aviso: sigue ? `Ya está en tu pedido: ${nombre}. Revísalo en «Tu pedido».`
        : `Ya agregaste ${nombre} desde esa ficha y después lo quitaste. Para pedirlo otra vez, elígelo en la lista.` });
    }
    const ficha = { pantalla: 'PERSONALIZAR', producto: `p${i}`, apertura: d.apertura };
    const r = itemDeFicha(foto, i, d);
    if (r.error) return fallo(r.error, ficha);
    if (b.filas.length >= MAX_RENGLONES_TIENDA) {
      return fallo(`Tu pedido llegó a ${MAX_RENGLONES_TIENDA} renglones, el máximo de este formulario. Puedes aumentar cantidades en «Editar o quitar».`, ficha);
    }
    recordar();
    const key = `n${b.siguiente++}`;
    b.filas.push({ key, item: r.item });
    const aperturas = [...b.aperturas, d.apertura], olvidadas = aperturas.slice(0, -MAX_APERTURAS);
    b.aperturas = aperturas.slice(-MAX_APERTURAS);
    // Lo que sale de la lista ya no se puede reconocer: desde aquí, una apertura
    // de esa revisión o anterior se rechaza en vez de agregarse otra vez.
    if (olvidadas.length) b.apertura_minima = Math.max(aperturaMinima(b), ...olvidadas.map((a) => Number(APERTURA.exec(a)[1]) + 1));
    // A su CATEGORIA (la pantalla de antes), con «Tu pedido» al día: al MENU el
    // teléfono no deja saltar [M]. Atrás desde ahí trae el MENU fresco.
    return escribir({ pantalla: 'CATEGORIA', entrada: entradaDelPlatillo(foto, i), agregado: [key] });
  }

  // ── Tacos por cantidad: la validación de categorias_v1 (sub-borrador compra) ──
  if (s.screen === 'TACOS') {
    const tacos = categoriaDeTacos(foto);
    if (!tacos) return fallo('Selección no disponible.', regreso(foto, s, d));
    // Volver a una pantalla de tacos vieja no vuelve a agregar lo de entonces.
    if (!vigente()) return fallo('La ventana cambió: revisa «Tu pedido» antes de agregar más tacos.', regreso(foto, s, d));
    const compra = { ...borradorCategorias(), revision: anterior.revision, etapa: 'TACOS', categoria: tacos.id, navegacion: ['MENU'] };
    const paso = cambiarCategorias(compraFoto(foto), compra, s);
    const aqui = { pantalla: 'TACOS', categoria: tacos.id };
    if (paso.error) return fallo(paso.error, aqui);
    // «Agregar» (terminar) e «Individual» regresan a la página de tacos de la que
    // salió TACOS: al MENU el teléfono no deja saltar [M].
    const destino = { terminar: regreso(foto, s, d), agregar: aqui, individual: regreso(foto, s, d) }[op];
    const nuevos = paso.borrador.items;
    if (!nuevos.length) return leer(destino);
    if (b.filas.length + nuevos.length > MAX_RENGLONES_TIENDA) {
      return fallo(`Tu pedido admite hasta ${MAX_RENGLONES_TIENDA} renglones en este formulario. Puedes aumentar cantidades en «Editar o quitar».`, aqui);
    }
    recordar();
    const keys = nuevos.map((item) => { const key = `n${b.siguiente++}`; b.filas.push({ key, item }); return key; });
    return escribir(destino.pantalla === 'CATEGORIA' ? { ...destino, agregado: keys } : destino);
  }

  // ── Cambios que exigen la revisión ──
  if (!vigente()) return fallo('La ventana cambió. Revisa tu pedido.', { pantalla: 'CARRITO' });
  if (op === 'aplicar' || op === 'quitar') {
    const f = fila();
    if (!f) return fallo('Ese platillo ya no está en tu pedido.', { pantalla: 'CARRITO' });
    if (op === 'quitar') { recordar(); b.filas = b.filas.filter((x) => x.key !== f.key); return escribir({ pantalla: 'CARRITO' }); }
    const r = itemDeFicha(foto, codigo(f.item.producto0, 'p'), d);
    if (r.error) return fallo(r.error, { pantalla: 'EDITAR', fila: f.key });
    recordar(); f.item = r.item;
    return escribir({ pantalla: 'CARRITO' });
  }
  if (op === 'deshacer') {
    const previo = b.deshacer.pop();
    if (!previo) return fallo('No hay cambios para deshacer.', { pantalla: 'CARRITO' });
    // Con la dirección en su propia pantalla, deshacer solo devuelve los platillos
    // (como carrito_v1) y sus aperturas: lo deshecho se puede volver a agregar.
    b.filas = previo.filas;
    if (Array.isArray(previo.aperturas)) b.aperturas = previo.aperturas;
    return escribir({ pantalla: 'CARRITO' });
  }
  // continuar
  if (!b.filas.length) {
    // Vaciar un pedido que tenía platillos se guarda como en carrito_v1 (sin
    // entrega ni dirección); uno que nunca tuvo no tiene nada que guardar.
    if (!foto.lineas?.length) return fallo('Tu pedido está vacío. Toca «Seguir pidiendo» y elige un platillo.', { pantalla: 'CARRITO' });
    b.modalidad = modo(b); b.pago = pago(b); sinDireccion(b);
    return escribir({ pantalla: 'FINAL' }, 'FINAL');
  }
  if (!comandosCarrito(sinContrato(foto), { filas: b.filas, modalidad: 'm0', pago: 'p0' })) {
    return fallo(textoFaltantesTienda(faltantesCarrito(foto, b).platillos) || 'Revisa las opciones de tus platillos antes de continuar.', { pantalla: 'CARRITO' });
  }
  b.modalidad = modo(b); b.pago = pago(b);
  return escribir({ pantalla: 'ENTREGA' }, 'ENTREGA');
}

/**
 * La respuesta del endpoint para el borrador. `vitrina`: la de vitrinaTienda.js
 * más, opcional, `miniatura(storageKey, variante)` (solo la caché). Sin vitrina
 * se dibuja sin fotos ni descripciones.
 */
export function respuestaTienda(foto, b, token, errorDado = '', sel = null, vitrina = null) {
  if (b.etapa === 'FINAL') return { screen: 'SUCCESS', data: { extension_message_response: { params: { flow_token: token, revision: String(b.revision) } } } };
  // Un texto de más no se dibuja: el error se corta aquí también para las
  // pantallas que se delegan (TACOS, ENTREGA, DIRECCION), que no lo cortan.
  const error = errorDado ? bloque(errorDado, LIMITES_TIENDA.texto.TextBody) : '';
  let vista = b.vista?.pantalla ? b.vista : vistaDeEtapa(b);
  // ENTREGA y DIRECCION solo se dibujan en su etapa; fuera de ella, el carrito.
  if (['ENTREGA', 'DIRECCION', 'FINAL'].includes(vista.pantalla) && vista.pantalla !== b.etapa) vista = { pantalla: 'CARRITO' };
  if (['ENTREGA', 'DIRECCION'].includes(vista.pantalla)) {
    const r = respuestaCarrito(foto, { ...b, etapa: vista.pantalla }, token, error, sel);
    if (r.screen === 'ENTREGA') {
      const p = pedidoDelBorrador(foto, b);
      r.data.resumen = recortar(`${resumenDelPedido(p)}. Elige cómo lo recibes y cómo pagas.`, LIMITES_TIENDA.texto.TextSubheading);
    }
    return r;
  }
  const pedido = pedidoDelBorrador(foto, b), revision = String(b.revision);
  if (vista.pantalla === 'PERSONALIZAR') {
    const i = productoDeLaFoto(foto, vista.producto);
    if (i >= 0) {
      const apertura = typeof vista.apertura === 'string' && APERTURA.test(vista.apertura) ? vista.apertura : `r${b.revision}.p${i}`;
      const intento = error && objeto(sel) && sel.apertura === apertura ? sel : null;
      return { screen: 'PERSONALIZAR', data: datosPersonalizar(foto, i, vitrina, { apertura, error, intento }) };
    }
    vista = { pantalla: 'MENU' };
  }
  if (vista.pantalla === 'EDITAR') {
    const fila = b.filas.find((f) => f.key === vista.fila);
    if (fila) {
      const intento = error && objeto(sel) && sel.revision === revision && sel.fila === fila.key ? sel : null;
      return { screen: 'EDITAR', data: datosEditar(foto, fila, vitrina, { revision: b.revision, error, intento }) };
    }
    vista = { pantalla: 'CARRITO' };
  }
  if (vista.pantalla === 'TACOS') {
    const tacos = categoriaDeTacos(foto);
    if (tacos) {
      const compra = { ...borradorCategorias(), revision: b.revision, etapa: 'TACOS', categoria: tacos.id, navegacion: ['MENU'] };
      const r = respuestaCategorias(compraFoto(foto), compra, token, error, sel);
      r.data.resumen = pedido.unidades ? resumenDelPedido(pedido) : 'Elige tus tacos.';
      return r;
    }
    vista = { pantalla: 'MENU' };
  }
  if (vista.pantalla === 'CATEGORIA') {
    const agregado = Array.isArray(vista.agregado) && vista.agregado.length ? vista.agregado : null;
    const aviso = error || vista.aviso || (agregado ? 'Listo, ya está en tu pedido. Elige otro platillo o toca «Tu pedido» para continuar.' : '');
    const data = datosCategoria(foto, vista.entrada, pedido, vitrina, { aviso, agregado });
    if (data) return { screen: 'CATEGORIA', data };
    vista = { pantalla: 'MENU' };
  }
  if (vista.pantalla === 'CARRITO') {
    return { screen: 'CARRITO', data: datosCarrito(pedido, { revision: b.revision, error, puedeDeshacer: b.deshacer?.length > 0 }) };
  }
  return { screen: 'MENU', data: datosMenu(foto, pedido, vitrina, { aviso: error || vista.aviso || '', agregado: vista.agregado || null }).data };
}
