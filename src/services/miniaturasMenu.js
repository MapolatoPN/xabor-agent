/**
 * miniaturasMenu.js — Miniaturas JPEG de las fotos del menú para el formulario
 * «tienda» de WhatsApp (contrato tienda_v1; propuesta, sección 3).
 *
 * Por qué JPEG siempre: Flows solo acepta JPEG o PNG en Image y en
 * start.image, WebP falla en iOS anteriores al 14, y las fotos guardadas por
 * imagenesProducto.js pueden ser WebP o PNG con transparencia. La receta es
 * fija: girar según EXIF, recortar a la medida por atención, fondo blanco
 * (la transparencia de un PNG sale blanca, no negra) y mozjpeg.
 *
 * Variantes:
 *   lista96   96×96   q65  renglón del platillo (NavigationList start.image)
 *   cat128    128×128 q70  renglón de la categoría
 *   ficha480  480×320 q70  foto de PERSONALIZAR y EDITAR (Image)
 *   lista80   80×80   q55  renglón del platillo cuando el MENU no cabe (escalera, peldaño 1);
 *                          no se precalienta: la pide la escalera (VARIANTES_PRECALENTADAS)
 * Si el base64 pasa de TOPE_OBJETIVO se recodifica bajando la calidad de 10 en
 * 10; si aun en la calidad mínima pasa de TOPE_DURO (el límite de 100 KB de
 * start.image [V]) la miniatura NO existe: el renglón sale sin imagen. Los topes
 * se miden sobre el base64, que es lo que viaja: más estricto que medir el JPEG.
 *
 * Caché solo en memoria (decisión del dueño, v1): LRU de CAPACIDAD_CACHE
 * entradas y BYTES_CACHE bytes, con llave `${storage_key}|${variante}`. No
 * necesita invalidación: guardarArchivo da un UUID nuevo en cada reemplazo de
 * foto, así que una llave nunca cambia de contenido. Se pierde en cada
 * despliegue y se vuelve a precalentar.
 *
 * Este módulo NO toca la base de datos. Generar con sharp es caro y nunca
 * ocurre dentro de una petición: `obtener` es síncrono y solo lee la caché; si
 * falta, encola y devuelve null (el elemento sale sin imagen). La cola trabaja
 * en segundo plano, una foto a la vez, cediendo el hilo entre fotos. Quién
 * encola y cuándo (al arrancar, tras guardar una foto, al armar el formulario)
 * lo decide vitrinaTienda.js.
 */
import sharp from 'sharp';
import { leerArchivo } from './almacenamiento.js';

export const VARIANTES = Object.freeze({
  lista96: Object.freeze({ ancho: 96, alto: 96, calidad: 65 }),
  cat128: Object.freeze({ ancho: 128, alto: 128, calidad: 70 }),
  // Escalera de bytes, peldaño 1 (catalogoFlowTienda.js): solo cuando el MENU no cabe con lista96.
  lista80: Object.freeze({ ancho: 80, alto: 80, calidad: 55 }),
  ficha480: Object.freeze({ ancho: 480, alto: 320, calidad: 70 }),
});
export const NOMBRES_VARIANTES = Object.freeze(Object.keys(VARIANTES));
// Las que se precalientan (encolar sin variantes): las de la Fase 1. lista80
// solo hace falta si el MENU no cabe con lista96, y eso no pasa con la carta
// de Obispado (50 KB de 600): se genera bajo demanda, cuando la escalera la
// pide con obtener() (ese MENU sale sin ella; los siguientes, con ella).
export const VARIANTES_PRECALENTADAS = Object.freeze(['lista96', 'cat128', 'ficha480']);
export const TOPE_OBJETIVO = 60_000; // caracteres de base64
export const TOPE_DURO = 100_000; // [V] start.image: base64 de hasta 100 KB
export const PASO_CALIDAD = 10;
export const CALIDAD_MINIMA = 20;
export const CAPACIDAD_CACHE = 1500;
export const BYTES_CACHE = 32 * 1024 * 1024;
export const MAX_COLA = 5000;
export const REINTENTO_FALLIDA_MS = 10 * 60_000;
// Las fotos guardadas miden a lo más 2048 px por lado (imagenes.js); esto solo
// frena un archivo ajeno que se haga pasar por foto.
const PIXELES_MAXIMOS = 64_000_000;

// Llave de almacenamiento tal como la genera almacenamiento.js: segmentos con
// letras, dígitos, punto, guion y guion bajo; nunca vacíos, «.» ni «..». La
// valida aquí también porque el driver local la une a una ruta del disco.
const LLAVE = /^[A-Za-z0-9_.\-/]{1,512}$/;
export function llaveDeAlmacenamientoValida(llave) {
  return typeof llave === 'string' && LLAVE.test(llave)
    && llave.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function variante(nombre) {
  const v = Object.hasOwn(VARIANTES, nombre) ? VARIANTES[nombre] : null;
  if (!v) throw new TypeError(`Variante de miniatura desconocida: ${nombre}`);
  return v;
}

/**
 * La miniatura de una foto: { base64, calidad, bytes } o null si ni en la
 * calidad mínima cabe en el tope duro. Lanza si la imagen no se puede leer.
 */
export async function generarMiniatura(buffer, nombreVariante, { topeObjetivo = TOPE_OBJETIVO, topeDuro = TOPE_DURO } = {}) {
  const v = variante(nombreVariante);
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('imagen vacía');
  let calidad = v.calidad, base64;
  for (;;) {
    const jpeg = await sharp(buffer, { limitInputPixels: PIXELES_MAXIMOS })
      .rotate()
      .resize(v.ancho, v.alto, { fit: 'cover', position: 'attention' })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: calidad, mozjpeg: true })
      .toBuffer();
    base64 = jpeg.toString('base64');
    if (base64.length <= topeObjetivo || calidad - PASO_CALIDAD < CALIDAD_MINIMA) break;
    calidad -= PASO_CALIDAD;
  }
  if (base64.length > topeDuro) return null;
  return { base64, calidad, bytes: base64.length };
}

/**
 * Una caché con su cola. `leer(storageKey)` devuelve los bytes de la foto
 * (por omisión, el almacenamiento del servidor). Todo lo demás es inyectable
 * para las pruebas.
 */
export function crearMiniaturas({
  leer = leerArchivo, capacidad = CAPACIDAD_CACHE, maxBytes = BYTES_CACHE, maxCola = MAX_COLA,
  reintentoMs = REINTENTO_FALLIDA_MS, topeObjetivo = TOPE_OBJETIVO, topeDuro = TOPE_DURO,
  ahora = Date.now, programar = setImmediate, avisar = (m) => console.warn(m),
} = {}) {
  const cache = new Map(); // llave → base64, del uso más viejo al más reciente
  let bytes = 0;
  const cola = new Map(); // storageKey → Set(variante); una lectura por foto
  let pendientes = 0;
  const fallidas = new Map(); // llave → instante del fallo
  let trabajando = false, programado = false, esperas = [];
  const cuenta = { lecturas: 0, generadas: 0, fallidas: 0, descartadas: 0 };
  const llave = (storageKey, v) => `${storageKey}|${v}`;

  function guardar(l, base64) {
    if (cache.has(l)) { bytes -= cache.get(l).length; cache.delete(l); }
    cache.set(l, base64); bytes += base64.length;
    for (const [vieja, valor] of cache) {
      if (cache.size <= capacidad && bytes <= maxBytes) break;
      cache.delete(vieja); bytes -= valor.length;
    }
  }
  function marcarFallida(storageKey, variantes, motivo) {
    for (const v of variantes) { fallidas.delete(llave(storageKey, v)); fallidas.set(llave(storageKey, v), ahora()); cuenta.fallidas++; }
    while (fallidas.size > capacidad) fallidas.delete(fallidas.keys().next().value);
    avisar(`[Miniaturas] sin miniatura ${[...variantes].join(',')} de ${storageKey}: ${motivo}`);
  }

  /** Solo la caché, sin encolar. Síncrono. */
  function enCache(storageKey, nombreVariante) {
    variante(nombreVariante);
    if (!llaveDeAlmacenamientoValida(storageKey)) return null;
    const l = llave(storageKey, nombreVariante), base64 = cache.get(l);
    if (base64 === undefined) return null;
    cache.delete(l); cache.set(l, base64); // uso reciente
    return base64;
  }

  /** Encola sin esperar. Devuelve cuántas variantes quedaron en la cola. */
  function encolar(storageKey, variantes = VARIANTES_PRECALENTADAS) {
    for (const v of variantes) variante(v);
    if (!llaveDeAlmacenamientoValida(storageKey)) return 0;
    let n = 0;
    for (const v of variantes) {
      const l = llave(storageKey, v);
      if (cache.has(l) || cola.get(storageKey)?.has(v)) continue;
      const fallo = fallidas.get(l);
      if (fallo !== undefined && ahora() - fallo < reintentoMs) continue;
      if (pendientes >= maxCola) { cuenta.descartadas++; continue; }
      if (!cola.has(storageKey)) cola.set(storageKey, new Set());
      cola.get(storageKey).add(v); pendientes++; n++;
    }
    if (n) despertar();
    return n;
  }

  /** La miniatura si ya está; si no, null y queda encolada. Síncrono: apto dentro de una transacción. */
  function obtener(storageKey, nombreVariante) {
    const base64 = enCache(storageKey, nombreVariante);
    if (base64 === null) encolar(storageKey, [nombreVariante]);
    return base64;
  }

  function despertar() {
    if (trabajando || programado) return;
    programado = true;
    programar(() => { programado = false; trabajar(); });
  }
  const ceder = () => new Promise((r) => programar(r));

  async function trabajar() {
    if (trabajando) return;
    trabajando = true;
    try {
      while (cola.size) {
        const [storageKey, variantes] = cola.entries().next().value;
        cola.delete(storageKey); pendientes -= variantes.size;
        let buffer;
        try { cuenta.lecturas++; buffer = await leer(storageKey); } catch (e) { marcarFallida(storageKey, variantes, `lectura: ${e?.message}`); continue; }
        for (const v of variantes) {
          try {
            const r = await generarMiniatura(buffer, v, { topeObjetivo, topeDuro });
            if (!r) { marcarFallida(storageKey, [v], `más de ${topeDuro} caracteres aun en calidad ${CALIDAD_MINIMA}`); continue; }
            guardar(llave(storageKey, v), r.base64); fallidas.delete(llave(storageKey, v)); cuenta.generadas++;
          } catch (e) { marcarFallida(storageKey, [v], e?.message); }
        }
        await ceder(); // el servidor atiende entre foto y foto
      }
    } catch (e) {
      avisar(`[Miniaturas] la cola se detuvo: ${e?.message}`);
    } finally {
      trabajando = false;
      if (cola.size) despertar();
      else { const listas = esperas; esperas = []; for (const r of listas) r(); }
    }
  }

  /** Se resuelve cuando la cola queda vacía (scripts y pruebas). */
  function esperar() {
    if (!trabajando && !programado && !cola.size) return Promise.resolve();
    return new Promise((r) => esperas.push(r));
  }
  // `fallidas` cuenta fallos desde el arranque; `fallidasRecientes`, las que aún esperan su reintento.
  const estado = () => ({ entradas: cache.size, bytes, pendientes, fallidasRecientes: fallidas.size, ...cuenta });
  function vaciar() { cache.clear(); bytes = 0; fallidas.clear(); }

  return { enCache, obtener, encolar, esperar, estado, vaciar };
}

/** La instancia del servidor. */
export const miniaturasMenu = crearMiniaturas();
export const miniaturaEnCache = (storageKey, nombreVariante) => miniaturasMenu.enCache(storageKey, nombreVariante);
export const miniaturaOEncolar = (storageKey, nombreVariante) => miniaturasMenu.obtener(storageKey, nombreVariante);
export const encolarMiniaturas = (storageKey, variantes) => miniaturasMenu.encolar(storageKey, variantes);
