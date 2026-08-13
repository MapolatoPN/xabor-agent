/**
 * menuAutomatico.js — El menú que cada negocio manda por WhatsApp.
 *
 * V2 MULTIIMAGEN (migración 050): un menú son 1..N PÁGINAS ordenadas en
 * whatsapp_menu_imagenes. La imagen única del V1 quedó convertida en la
 * Página 1 por el backfill; las columnas viejas de
 * whatsapp_menu_automatico ya no se escriben (quedan como respaldo de
 * rollback) pero se siguen LEYENDO como último recurso, por si alguna base
 * corrió el código nuevo sin el backfill.
 *
 * Principios que este módulo garantiza (misma familia que el P0
 * transaccional):
 *
 * 1. El envío es VERIFICADO: enviarMenuAutomatico devuelve exactamente qué
 *    páginas se entregaron. Éxito parcial NUNCA se reporta como éxito
 *    completo, y el texto que ve el cliente lo decide CÓDIGO según el
 *    resultado real -- jamás una afirmación optimista.
 * 2. Si las imágenes no salen, el fallback textual se construye desde el
 *    CATÁLOGO REAL (menu_productos), nunca de la memoria del modelo.
 * 3. La imagen viaja a Meta como media privada (buffer), sin cachear
 *    media_id -- mismas razones que el V1 (ver historial del archivo).
 * 4. La detección es determinista (frases del negocio, normalizadas,
 *    jamás compiladas como regex crudo).
 * 5. Estados imposibles no existen: activo exige ≥1 página; borrar la
 *    última página desactiva el menú de forma explícita.
 */
import { pool, obtenerMenuCompleto } from './database.js';
import { guardarArchivo, leerArchivo, eliminarArchivo } from './almacenamiento.js';
import { validarImagenReal, comprimirImagen, sanitizarNombreImagen } from './imagenes.js';

// Mismo límite que el resto del media de Xabor (MEDIA_MAX_IMAGE_MB).
export function tamanoMaximoBytes() {
  return (Number(process.env.MEDIA_MAX_IMAGE_MB) || 8) * 1024 * 1024;
}

export const MAX_PAGINAS_MENU = 10;

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

/**
 * Las páginas del menú de UN negocio, ordenadas. Multi-tenant por
 * construcción (WHERE negocio_id). Cinturón de compatibilidad: si la tabla
 * hija está vacía pero la columna V1 tiene imagen (base sin backfill), esa
 * imagen se presenta como una página virtual 'v1'.
 */
async function obtenerPaginas(negocioId) {
  const { rows } = await pool.query(
    `SELECT id, storage_key, mime_type, nombre_archivo, tamano_bytes, orden
       FROM whatsapp_menu_imagenes WHERE negocio_id = $1 ORDER BY orden, created_at`,
    [negocioId]);
  if (rows.length) return rows;
  const { rows: [v1] } = await pool.query(
    `SELECT storage_key, mime_type, nombre_archivo, tamano_bytes
       FROM whatsapp_menu_automatico WHERE negocio_id = $1 AND storage_key IS NOT NULL`,
    [negocioId]);
  if (!v1) return [];
  return [{ id: 'v1', storage_key: v1.storage_key, mime_type: v1.mime_type, nombre_archivo: v1.nombre_archivo, tamano_bytes: v1.tamano_bytes, orden: 1 }];
}

/** Configuración del menú de UN negocio. Nunca devuelve storage_keys. */
export async function obtenerMenuNegocio(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return null;
  const { rows } = await pool.query(
    `SELECT activo, frases_disparadoras, updated_at
       FROM whatsapp_menu_automatico WHERE negocio_id = $1`, [negocioId.trim()]);
  const fila = rows[0];
  const paginas = await obtenerPaginas(negocioId.trim());
  const imagenes = paginas.map((p, i) => ({
    id: String(p.id), nombreArchivo: p.nombre_archivo, mimeType: p.mime_type,
    tamanoBytes: p.tamano_bytes, orden: i + 1,
  }));
  if (!fila) {
    return {
      activo: false, tieneImagen: imagenes.length > 0, imagenes,
      nombreArchivo: imagenes[0]?.nombreArchivo || null, mimeType: imagenes[0]?.mimeType || null,
      tamanoBytes: imagenes[0]?.tamanoBytes || null, frases: FRASES_POR_DEFECTO, actualizadoEn: null,
    };
  }
  return {
    activo: fila.activo,
    tieneImagen: imagenes.length > 0,
    imagenes,
    // Campos V1 (compatibilidad con consumidores existentes): la primera página.
    nombreArchivo: imagenes[0]?.nombreArchivo || null,
    mimeType: imagenes[0]?.mimeType || null,
    tamanoBytes: imagenes[0]?.tamanoBytes || null,
    frases: fila.frases_disparadoras,
    actualizadoEn: fila.updated_at,
  };
}

/** Uso interno del bot: SÍ incluye storage_keys. Nunca sale por HTTP. */
export async function obtenerMenuParaEnvio(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return null;
  const { rows } = await pool.query(
    `SELECT activo, storage_key, mime_type, nombre_archivo, frases_disparadoras
       FROM whatsapp_menu_automatico WHERE negocio_id = $1`, [negocioId.trim()]);
  if (!rows[0]) return null;
  const paginas = await obtenerPaginas(negocioId.trim());
  return { ...rows[0], imagenes: paginas };
}

const MAX_FRASES = 40;
const MAX_LARGO_FRASE = 60;

/**
 * Las frases son datos del negocio, así que se limpian igual que cualquier
 * entrada: se recortan, se limita cuántas y cuán largas, y se descartan las
 * vacías (y los duplicados equivalentes tras normalizar).
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

/** Activa/desactiva y/o reemplaza la lista de frases. No toca las imágenes. */
export async function guardarConfigMenu(negocioId, { activo, frases }, actorUsuarioId = null) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    return { ok: false, error: 'negocioId inválido' };
  }
  const { rows: [actual] } = await pool.query(
    `SELECT activo FROM whatsapp_menu_automatico WHERE negocio_id = $1`, [negocioId.trim()]);
  const nuevoActivo = typeof activo === 'boolean' ? activo : Boolean(actual?.activo);

  // Estado imposible bloqueado en la app (la 050 quitó el CHECK del V1):
  // activo exige al menos una página real.
  if (nuevoActivo) {
    const paginas = await obtenerPaginas(negocioId.trim());
    if (!paginas.length) {
      return { ok: false, error: 'Sube al menos una imagen de tu menú para poder activarlo' };
    }
  }

  const frasesLimpias = sanearFrases(frases);
  if (frases !== undefined && (!frasesLimpias || frasesLimpias.length === 0)) {
    return { ok: false, error: 'Deja al menos una frase que active el envío del menú' };
  }

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
 * Agrega una PÁGINA nueva al final, o REEMPLAZA una existente
 * (opciones.imagenId). Valida por magic bytes, comprime y quita metadatos
 * (EXIF/GPS), igual que el V1.
 */
export async function guardarImagenMenu(negocioId, buffer, nombreOriginal, actorUsuarioId = null, opciones = {}) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    return { ok: false, error: 'negocioId inválido' };
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, error: 'No recibimos ninguna imagen' };
  }
  if (buffer.length > tamanoMaximoBytes()) {
    return { ok: false, error: `La imagen pesa más de ${Math.round(tamanoMaximoBytes() / 1024 / 1024)} MB` };
  }
  const validacion = await validarImagenReal(buffer);
  if (!validacion.valido) {
    return { ok: false, error: 'Sube una imagen JPG, PNG o WEBP válida' };
  }
  const comprimida = await comprimirImagen(buffer, validacion.mime);
  const bytes = comprimida.buffer;
  const nombreVisible = sanitizarNombreImagen(nombreOriginal || 'menu', comprimida.extension);
  const negocio = negocioId.trim();

  // La fila padre (frases/activo) debe existir para poder activar después.
  await pool.query(
    `INSERT INTO whatsapp_menu_automatico (negocio_id, activo, frases_disparadoras, actualizado_por)
     VALUES ($1, FALSE, $2::text[], $3) ON CONFLICT (negocio_id) DO NOTHING`,
    [negocio, FRASES_POR_DEFECTO, actorUsuarioId]);

  const imagenId = opciones.imagenId || null;
  if (imagenId) {
    // REEMPLAZO: la página debe ser de ESTE negocio (tenant-filtered).
    const { rows: [pagina] } = await pool.query(
      `SELECT id, storage_key FROM whatsapp_menu_imagenes WHERE id = $1 AND negocio_id = $2`,
      [imagenId, negocio]);
    if (!pagina) return { ok: false, error: 'Esa página del menú no existe' };
    const storageKey = await guardarArchivo(bytes, { negocioId: negocio, extension: comprimida.extension, mimeType: comprimida.mime, categoria: 'menu' });
    await pool.query(
      `UPDATE whatsapp_menu_imagenes SET storage_key = $3, mime_type = $4, nombre_archivo = $5, tamano_bytes = $6, updated_at = NOW()
        WHERE id = $1 AND negocio_id = $2`,
      [imagenId, negocio, storageKey, comprimida.mime, nombreVisible, bytes.length]);
    // El objeto viejo se borra DESPUÉS de que el nuevo ya está referenciado.
    if (pagina.storage_key && pagina.storage_key !== storageKey) {
      await eliminarArchivo(pagina.storage_key).catch((e) =>
        console.error(`[MenuAutomatico] no se pudo borrar la imagen anterior: ${e.message}`));
    }
    return { ok: true, menu: await obtenerMenuNegocio(negocio) };
  }

  // ALTA: nueva página al final, con tope sanitario.
  const paginas = await obtenerPaginas(negocio);
  const reales = paginas.filter((p) => p.id !== 'v1');
  if (reales.length >= MAX_PAGINAS_MENU) {
    return { ok: false, error: `Un menú puede tener máximo ${MAX_PAGINAS_MENU} páginas` };
  }
  const storageKey = await guardarArchivo(bytes, { negocioId: negocio, extension: comprimida.extension, mimeType: comprimida.mime, categoria: 'menu' });
  const siguienteOrden = reales.length ? Math.max(...reales.map((p) => p.orden)) + 1 : 1;
  await pool.query(
    `INSERT INTO whatsapp_menu_imagenes (negocio_id, storage_key, mime_type, nombre_archivo, tamano_bytes, orden)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [negocio, storageKey, comprimida.mime, nombreVisible, bytes.length, siguienteOrden]);
  await pool.query(
    `UPDATE whatsapp_menu_automatico SET actualizado_por = $2, updated_at = NOW() WHERE negocio_id = $1`,
    [negocio, actorUsuarioId]);
  return { ok: true, menu: await obtenerMenuNegocio(negocio) };
}

/**
 * Quita UNA página. Si era la última, el menú se DESACTIVA de forma segura
 * (nunca queda activo=true con cero imágenes). El orden restante se
 * compacta a 1..n.
 */
export async function eliminarImagenMenuPagina(negocioId, imagenId, actorUsuarioId = null) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    return { ok: false, error: 'negocioId inválido' };
  }
  const negocio = negocioId.trim();
  const { rows: [pagina] } = await pool.query(
    `DELETE FROM whatsapp_menu_imagenes WHERE id = $1 AND negocio_id = $2 RETURNING storage_key`,
    [imagenId, negocio]);
  if (!pagina) return { ok: false, error: 'Esa página del menú no existe' };
  await eliminarArchivo(pagina.storage_key).catch((e) =>
    console.error(`[MenuAutomatico] no se pudo borrar la imagen: ${e.message}`));

  // Compactar orden 1..n.
  await pool.query(`
    WITH renum AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY orden, created_at) AS nuevo
      FROM whatsapp_menu_imagenes WHERE negocio_id = $1)
    UPDATE whatsapp_menu_imagenes m SET orden = renum.nuevo
      FROM renum WHERE m.id = renum.id`, [negocio]);

  const restantes = await obtenerPaginas(negocio);
  if (!restantes.length) {
    await pool.query(
      `UPDATE whatsapp_menu_automatico SET activo = FALSE, actualizado_por = $2, updated_at = NOW() WHERE negocio_id = $1`,
      [negocio, actorUsuarioId]);
  }
  return { ok: true, menu: await obtenerMenuNegocio(negocio) };
}

/** Reordena las páginas: `ids` debe ser exactamente el conjunto actual. */
export async function reordenarImagenesMenu(negocioId, ids, actorUsuarioId = null) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    return { ok: false, error: 'negocioId inválido' };
  }
  const negocio = negocioId.trim();
  const { rows } = await pool.query(
    `SELECT id FROM whatsapp_menu_imagenes WHERE negocio_id = $1`, [negocio]);
  const actuales = new Set(rows.map((r) => String(r.id)));
  const pedidos = Array.isArray(ids) ? ids.map(String) : [];
  if (pedidos.length !== actuales.size || !pedidos.every((id) => actuales.has(id)) || new Set(pedidos).size !== pedidos.length) {
    return { ok: false, error: 'El orden recibido no coincide con las páginas actuales' };
  }
  for (let i = 0; i < pedidos.length; i++) {
    await pool.query(
      `UPDATE whatsapp_menu_imagenes SET orden = $3, updated_at = NOW() WHERE id = $1 AND negocio_id = $2`,
      [pedidos[i], negocio, i + 1]);
  }
  await pool.query(
    `UPDATE whatsapp_menu_automatico SET actualizado_por = $2, updated_at = NOW() WHERE negocio_id = $1`,
    [negocio, actorUsuarioId]);
  return { ok: true, menu: await obtenerMenuNegocio(negocio) };
}

/** Compatibilidad V1: quita TODAS las páginas y desactiva. */
export async function eliminarImagenMenu(negocioId, actorUsuarioId = null) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    return { ok: false, error: 'negocioId inválido' };
  }
  const negocio = negocioId.trim();
  const paginas = await obtenerPaginas(negocio);
  for (const p of paginas.filter((x) => x.id !== 'v1')) {
    await pool.query(`DELETE FROM whatsapp_menu_imagenes WHERE id = $1 AND negocio_id = $2`, [p.id, negocio]);
    await eliminarArchivo(p.storage_key).catch(() => {});
  }
  await pool.query(
    `UPDATE whatsapp_menu_automatico
        SET activo = FALSE, storage_key = NULL, mime_type = NULL,
            nombre_archivo = NULL, tamano_bytes = NULL,
            actualizado_por = $2, updated_at = NOW()
      WHERE negocio_id = $1`, [negocio, actorUsuarioId]);
  return { ok: true, menu: await obtenerMenuNegocio(negocio) };
}

/**
 * Bytes de UNA página (default: la primera), para preview del panel y para
 * el envío. imagenId 'v1' lee la columna del V1.
 */
export async function leerImagenMenu(negocioId, imagenId = null) {
  const paginas = await obtenerPaginas(negocioId);
  if (!paginas.length) return null;
  const pagina = imagenId ? paginas.find((p) => String(p.id) === String(imagenId)) : paginas[0];
  if (!pagina) return null;
  const buffer = await leerArchivo(pagina.storage_key);
  return { buffer, mimeType: pagina.mime_type || 'image/jpeg', nombre: pagina.nombre_archivo || 'menu' };
}

/**
 * Fallback TEXTUAL construido desde el catálogo REAL del negocio -- se usa
 * cuando las imágenes no pudieron enviarse. Jamás inventa categorías,
 * productos ni precios: si el catálogo está vacío, devuelve null y el
 * llamador usa el aviso genérico.
 */
export async function menuTextualDesdeCatalogo(negocioId) {
  try {
    const categorias = await obtenerMenuCompleto(negocioId);
    if (!Array.isArray(categorias) || !categorias.length) return null;
    let texto = '';
    for (const cat of categorias) {
      const disponibles = (cat.productos || []).filter((p) => p.disponible && !p.agotado);
      if (!disponibles.length) continue;
      texto += `\n*${cat.nombre}*\n`;
      for (const p of disponibles) {
        texto += `• ${p.nombre} — $${p.precio}\n`;
        if (texto.length > 1500) return texto.trim() + '\n…';
      }
    }
    return texto.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Manda el menú COMPLETO del negocio: el texto de acompañamiento y después
 * TODAS las páginas en su orden configurado.
 *
 * Contrato de honestidad (P0): el resultado dice exactamente qué se envió.
 *  - Todas las páginas OK  → { ok: true, enviadas: N }
 *  - Falla alguna página   → reintento único por página; si persiste,
 *    ok: false con `enviadas`/`fallidas`, y el CLIENTE recibe un aviso
 *    redactado por código: parcial ("te llegaron X de Y") o, si no salió
 *    ninguna, el menú TEXTUAL del catálogo real (si existe) o el aviso
 *    genérico. Jamás se afirma "aquí está el menú" sin evidencia de envío.
 */
export async function enviarMenuAutomatico({ negocioId, telefono, credenciales, enviarTexto, enviarImagenBuffer }) {
  const fila = await obtenerMenuParaEnvio(negocioId);
  const paginas = fila?.imagenes || [];
  if (!paginas.length) return { ok: false, motivo: 'sin_imagen', textoEnviado: null, enviadas: 0, fallidas: [] };

  await enviarTexto(telefono, TEXTO_ACOMPANA, credenciales);

  let enviadas = 0;
  const fallidas = [];
  for (let i = 0; i < paginas.length; i++) {
    const pagina = paginas[i];
    let exito = false;
    for (let intento = 1; intento <= 2 && !exito; intento++) { // 1 reintento seguro, nunca un loop
      try {
        const leida = await leerImagenMenu(negocioId, pagina.id);
        if (!leida) throw new Error('página ilegible');
        await enviarImagenBuffer(telefono, leida.buffer, leida.nombre, leida.mimeType, '', credenciales);
        exito = true;
      } catch (e) {
        if (intento === 2) {
          console.error(`[MenuAutomatico] página ${i + 1}/${paginas.length} del negocio ${negocioId} no se pudo enviar: ${e.message}`);
        }
      }
    }
    if (exito) enviadas++; else fallidas.push(i + 1);
  }

  if (!fallidas.length) {
    return { ok: true, motivo: null, textoEnviado: TEXTO_ACOMPANA, enviadas, fallidas: [] };
  }

  // Éxito parcial o total: el cliente recibe la VERDAD, redactada por código.
  let textoFallback;
  if (enviadas > 0) {
    textoFallback = `Te llegaron ${enviadas} de ${paginas.length} páginas del menú; en un momento te compartimos el resto. Una disculpa.`;
  } else {
    const textual = await menuTextualDesdeCatalogo(negocioId);
    textoFallback = textual
      ? `No pude enviarte la imagen del menú en este momento, pero te comparto lo principal:\n${textual}`
      : TEXTO_FALLBACK;
  }
  await enviarTexto(telefono, textoFallback, credenciales).catch(() => {});
  console.error(`[MenuAutomatico] envío ${enviadas ? 'PARCIAL' : 'FALLIDO'} del menú del negocio ${negocioId}: ${enviadas}/${paginas.length} páginas (fallidas: ${fallidas.join(',')})`);
  return {
    ok: false, motivo: enviadas > 0 ? 'envio_parcial' : 'error_envio',
    textoEnviado: TEXTO_ACOMPANA, textoFallback, enviadas, fallidas,
  };
}
