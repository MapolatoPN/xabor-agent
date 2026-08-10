/**
 * menuAutomatico.js — El menú que cada negocio manda por WhatsApp.
 *
 * Antes de esto, el bot mandaba SIEMPRE `public/menu.png`: un archivo dentro
 * del repositorio, servido en una URL pública, idéntico para todos los
 * negocios. Aquí cada negocio tiene el suyo, lo sube desde su panel y lo
 * reemplaza cuando quiere, sin deploy y sin reinicio.
 *
 * Tres decisiones que conviene tener a la vista:
 *
 * 1. La imagen viaja a Meta como media privada (buffer -> /media -> media_id),
 *    igual que los documentos PDF y las imágenes de chat. Nunca se le da a
 *    Meta una URL para que la descargue. Ver `leerArchivo` en
 *    almacenamiento.js para el razonamiento completo.
 *
 * 2. NO se cachea el media_id de Meta. Los media_id caducan y, sobre todo,
 *    cachearlos crea el bug clásico: el negocio sube un menú nuevo y sus
 *    clientes siguen recibiendo el viejo. Se sube en cada envío. El costo es
 *    una llamada extra a Meta por solicitud de menú; el beneficio es que
 *    "subí el menú nuevo" significa exactamente eso.
 *
 * 3. La detección es determinista y no gasta IA. Comparar contra una lista de
 *    frases que el negocio controla es predecible y auditable; pedirle al
 *    modelo que decida es caro y no reproducible. Las frases del negocio nunca
 *    se compilan como expresión regular -- se comparan como texto normalizado.
 */
import { pool } from './database.js';
import { guardarArchivo, leerArchivo, eliminarArchivo } from './almacenamiento.js';
import { validarImagenReal, comprimirImagen, sanitizarNombreImagen } from './imagenes.js';

// Mismo límite que el resto del media de Xabor (MEDIA_MAX_IMAGE_MB).
export function tamanoMaximoBytes() {
  return (Number(process.env.MEDIA_MAX_IMAGE_MB) || 8) * 1024 * 1024;
}

export const FRASES_POR_DEFECTO = [
  'menu', 'menú', 'carta', 'precios', 'lista de precios',
  'que venden', 'qué venden', 'que tienen', 'qué tienen',
];

const TEXTO_ACOMPANA = 'Claro 👇 Te comparto nuestro menú.';
const TEXTO_FALLBACK = 'No pude enviar el menú en este momento. En un momento te ayudamos.';

export { TEXTO_ACOMPANA, TEXTO_FALLBACK };

/**
 * Normaliza para comparar: minúsculas, sin acentos, sin signos, espacios
 * colapsados. "¿Me mandas el MENÚ?" y "me mandas el menu" son la misma cosa
 * para un cliente, así que tienen que serlo para el matcher.
 */
export function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // acentos fuera
    .replace(/[¿?¡!.,;:()"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Frases que, si aparecen, indican que el cliente está HABLANDO del menú en
// pasado o comentando, no pidiéndolo. "el menu estuvo muy bueno ayer" no es
// una solicitud. Es una lista corta a propósito: el objetivo es evitar los
// falsos positivos fáciles, no adivinar intenciones.
const MARCAS_DE_COMENTARIO = [
  'estuvo', 'estaba', 'estuvieron', 'me gusto', 'me gustaron', 'buenisimo',
  'muy bueno', 'muy buena', 'delicioso', 'deliciosa', 'rico', 'rica',
  'ayer', 'la vez pasada', 'el otro dia', 'gracias por el',
];

/**
 * ¿Este mensaje pide el menú?
 *
 * Una frase dispara si aparece como palabra completa dentro del mensaje
 * normalizado -- "menu" dispara con "me mandas el menu", pero no con
 * "menudencias". Se usa comparación por límites de palabra construida a
 * partir de la frase ESCAPADA, nunca la frase cruda: el negocio escribe
 * frases, no expresiones regulares.
 */
export function mensajePideMenu(texto, frases = FRASES_POR_DEFECTO) {
  const msg = normalizar(texto);
  if (!msg) return false;

  // Un mensaje largo que además comenta ("el menú estuvo muy bueno ayer")
  // se descarta antes de mirar las frases.
  if (MARCAS_DE_COMENTARIO.some((m) => msg.includes(normalizar(m)))) return false;

  const lista = (Array.isArray(frases) && frases.length ? frases : FRASES_POR_DEFECTO);
  return lista.some((frase) => {
    const f = normalizar(frase);
    if (!f) return false;
    // Límites de palabra sobre texto ya normalizado (solo letras/números/
    // espacios), con la frase escapada.
    const escapada = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|\\s)${escapada}(\\s|$)`).test(msg);
  });
}

/** Configuración del menú de UN negocio. Nunca devuelve la storage_key. */
export async function obtenerMenuNegocio(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return null;
  const { rows } = await pool.query(
    `SELECT activo, mime_type, nombre_archivo, tamano_bytes, frases_disparadoras,
            storage_key IS NOT NULL AS tiene_imagen, updated_at
       FROM whatsapp_menu_automatico WHERE negocio_id = $1`, [negocioId.trim()]);
  const fila = rows[0];
  if (!fila) {
    return {
      activo: false, tieneImagen: false, nombreArchivo: null, mimeType: null,
      tamanoBytes: null, frases: FRASES_POR_DEFECTO, actualizadoEn: null,
    };
  }
  return {
    activo: fila.activo,
    tieneImagen: fila.tiene_imagen,
    nombreArchivo: fila.nombre_archivo,
    mimeType: fila.mime_type,
    tamanoBytes: fila.tamano_bytes,
    frases: fila.frases_disparadoras,
    actualizadoEn: fila.updated_at,
  };
}

/** Uso interno del bot: sí incluye la storage_key. Nunca sale por HTTP. */
export async function obtenerMenuParaEnvio(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return null;
  const { rows } = await pool.query(
    `SELECT activo, storage_key, mime_type, nombre_archivo, frases_disparadoras
       FROM whatsapp_menu_automatico WHERE negocio_id = $1`, [negocioId.trim()]);
  return rows[0] || null;
}

const MAX_FRASES = 40;
const MAX_LARGO_FRASE = 60;

/**
 * Las frases son datos del negocio, así que se limpian igual que cualquier
 * entrada: se recortan, se limita cuántas y cuán largas, y se descartan las
 * vacías. Sin límite, una lista enorme convertiría cada mensaje entrante en
 * un barrido caro.
 */
export function sanearFrases(frases) {
  if (!Array.isArray(frases)) return null;
  const limpias = [];
  for (const f of frases) {
    if (typeof f !== 'string') continue;
    const t = f.trim().slice(0, MAX_LARGO_FRASE);
    if (!t) continue;
    if (!limpias.some((x) => normalizar(x) === normalizar(t))) limpias.push(t);
    if (limpias.length >= MAX_FRASES) break;
  }
  return limpias;
}

/** Activa/desactiva y/o reemplaza la lista de frases. No toca la imagen. */
export async function guardarConfigMenu(negocioId, { activo, frases }, actorUsuarioId = null) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    return { ok: false, error: 'negocioId inválido' };
  }
  const actual = await obtenerMenuParaEnvio(negocioId);
  const nuevoActivo = typeof activo === 'boolean' ? activo : Boolean(actual?.activo);

  // El CHECK de la base lo impediría igual; aquí se traduce a algo que el
  // negocio pueda entender en vez de un error de Postgres.
  if (nuevoActivo && !actual?.storage_key) {
    return { ok: false, error: 'Sube primero la imagen de tu menú para poder activarlo' };
  }

  const frasesLimpias = sanearFrases(frases);
  if (frases !== undefined && (!frasesLimpias || frasesLimpias.length === 0)) {
    return { ok: false, error: 'Deja al menos una frase que active el envío del menú' };
  }

  // INSERT o UPDATE explícito, no ON CONFLICT: Postgres evalúa el CHECK
  // (activo exige imagen) sobre la fila propuesta ANTES de resolver el
  // conflicto, así que un upsert con activo=TRUE y storage_key sin definir
  // reventaba aunque la fila que iba a quedar sí tuviera imagen.
  if (actual) {
    await pool.query(
      `UPDATE whatsapp_menu_automatico
          SET activo = $2,
              frases_disparadoras = COALESCE($3::text[], frases_disparadoras),
              actualizado_por = $4, updated_at = NOW()
        WHERE negocio_id = $1`,
      [negocioId.trim(), nuevoActivo, frasesLimpias, actorUsuarioId]);
  } else {
    await pool.query(
      `INSERT INTO whatsapp_menu_automatico (negocio_id, activo, frases_disparadoras, actualizado_por)
       VALUES ($1, $2, COALESCE($3::text[], $4::text[]), $5)`,
      [negocioId.trim(), nuevoActivo, frasesLimpias, FRASES_POR_DEFECTO, actorUsuarioId]);
  }

  return { ok: true, menu: await obtenerMenuNegocio(negocioId) };
}

/**
 * Guarda la imagen del menú. Valida por magic bytes (nunca por extensión ni
 * por el Content-Type que mande el navegador), comprime, y borra metadatos
 * -- una foto del menú tomada con el celular puede traer GPS del local.
 */
export async function guardarImagenMenu(negocioId, buffer, nombreOriginal, actorUsuarioId = null) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    return { ok: false, error: 'negocioId inválido' };
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, error: 'No recibimos ninguna imagen' };
  }
  if (buffer.length > tamanoMaximoBytes()) {
    return { ok: false, error: `La imagen pesa más de ${Math.round(tamanoMaximoBytes() / 1024 / 1024)} MB` };
  }

  // validarImagenReal mira los magic bytes Y decodifica con sharp: un .jpg
  // que en realidad es un SVG, un HTML o un ZIP no pasa de aquí.
  const validacion = await validarImagenReal(buffer);
  if (!validacion.valido) {
    return { ok: false, error: 'Sube una imagen JPG, PNG o WEBP válida' };
  }

  // comprimirImagen re-encoda siempre a un formato conocido y, al no llamar
  // .withMetadata(), ya deja el EXIF fuera -- el menu puede ser una foto
  // tomada en el local y ese EXIF llevaria su GPS. El mime/extension de
  // salida puede no ser el de entrada (un PNG sin transparencia sale jpg):
  // se persiste el de SALIDA, que es lo que realmente se va a enviar.
  const comprimida = await comprimirImagen(buffer, validacion.mime);
  const bytes = comprimida.buffer;

  const storageKey = await guardarArchivo(bytes, {
    negocioId: negocioId.trim(),
    extension: comprimida.extension,
    mimeType: comprimida.mime,
    categoria: 'menu',
  });

  const anterior = await obtenerMenuParaEnvio(negocioId);

  // El nombre original solo se muestra en el panel y viaja en un header
  // Content-Disposition; jamas forma parte de la ruta (la ruta es un UUID).
  // Se reutiliza el saneador que ya existe para las imagenes de chat.
  const nombreVisible = sanitizarNombreImagen(nombreOriginal || 'menu', comprimida.extension);

  await pool.query(
    `INSERT INTO whatsapp_menu_automatico
       (negocio_id, storage_key, mime_type, nombre_archivo, tamano_bytes, actualizado_por)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (negocio_id) DO UPDATE SET
       storage_key = $2, mime_type = $3, nombre_archivo = $4, tamano_bytes = $5,
       actualizado_por = $6, updated_at = NOW()`,
    [negocioId.trim(), storageKey, comprimida.mime, nombreVisible, bytes.length, actorUsuarioId]);

  // El objeto viejo se borra DESPUÉS de que el nuevo ya está referenciado en
  // la base: si el borrado falla, sobra un archivo huérfano; si se hiciera al
  // revés y fallara el INSERT, quedaría una referencia rota.
  if (anterior?.storage_key && anterior.storage_key !== storageKey) {
    await eliminarArchivo(anterior.storage_key).catch((e) =>
      console.error(`[MenuAutomatico] no se pudo borrar la imagen anterior: ${e.message}`));
  }

  return { ok: true, menu: await obtenerMenuNegocio(negocioId) };
}

/** Quita la imagen. Desactiva primero, para no violar el CHECK. */
export async function eliminarImagenMenu(negocioId, actorUsuarioId = null) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    return { ok: false, error: 'negocioId inválido' };
  }
  const actual = await obtenerMenuParaEnvio(negocioId);
  if (!actual?.storage_key) return { ok: true, menu: await obtenerMenuNegocio(negocioId) };

  await pool.query(
    `UPDATE whatsapp_menu_automatico
        SET activo = FALSE, storage_key = NULL, mime_type = NULL,
            nombre_archivo = NULL, tamano_bytes = NULL,
            actualizado_por = $2, updated_at = NOW()
      WHERE negocio_id = $1`, [negocioId.trim(), actorUsuarioId]);

  await eliminarArchivo(actual.storage_key).catch((e) =>
    console.error(`[MenuAutomatico] no se pudo borrar la imagen: ${e.message}`));

  return { ok: true, menu: await obtenerMenuNegocio(negocioId) };
}

/** Los bytes, para la vista previa del panel y para el envío por WhatsApp. */
export async function leerImagenMenu(negocioId) {
  const fila = await obtenerMenuParaEnvio(negocioId);
  if (!fila?.storage_key) return null;
  const buffer = await leerArchivo(fila.storage_key);
  return { buffer, mimeType: fila.mime_type || 'image/jpeg', nombre: fila.nombre_archivo || 'menu' };
}

/**
 * Manda el menú del negocio: primero el texto, después la imagen.
 *
 * Si la imagen falla NO se finge éxito -- se manda un aviso claro y se
 * devuelve `ok: false` para que el llamador lo registre. Un cliente que
 * pregunta por el menú y no recibe nada es peor que uno que recibe "ahora
 * no puedo, te ayudamos en un momento".
 *
 * Devuelve qué se envió realmente, para que el webhook pueda guardar los
 * mensajes salientes sin adivinar.
 */
export async function enviarMenuAutomatico({ negocioId, telefono, credenciales, enviarTexto, enviarImagenBuffer }) {
  const fila = await obtenerMenuParaEnvio(negocioId);
  if (!fila?.storage_key) return { ok: false, motivo: 'sin_imagen', textoEnviado: null };

  await enviarTexto(telefono, TEXTO_ACOMPANA, credenciales);

  try {
    const { buffer, mimeType, nombre } = await leerImagenMenu(negocioId);
    await enviarImagenBuffer(telefono, buffer, nombre, mimeType, '', credenciales);
    return { ok: true, motivo: null, textoEnviado: TEXTO_ACOMPANA };
  } catch (e) {
    console.error(`[MenuAutomatico] no se pudo enviar el menú del negocio ${negocioId}: ${e.message}`);
    await enviarTexto(telefono, TEXTO_FALLBACK, credenciales).catch(() => {});
    return { ok: false, motivo: 'error_envio', textoEnviado: TEXTO_ACOMPANA, textoFallback: TEXTO_FALLBACK };
  }
}
