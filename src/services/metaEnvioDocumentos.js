/**
 * metaEnvioDocumentos.js — Envío de documentos/PDFs privados via Meta
 * Cloud API (sube el archivo como media privada en 2 pasos, luego
 * referencia ese media_id en el mensaje -- nunca expone una URL pública
 * del archivo). Extraído de whatsapp-meta.js (que sigue re-exportando
 * enviarDocumento sin cambio de comportamiento) para que servicios que
 * necesitan enviar un documento (ej. notificacionBorradorAdmin.js)
 * puedan importarlo sin arrastrar el resto de whatsapp-meta.js -- ese
 * archivo importa `server.js` a su vez (import circular ya existente,
 * seguro en el runtime real porque server.js siempre es el punto de
 * entrada real), lo que rompe con un TDZ real si algún consumidor
 * externo importa whatsapp-meta.js como PRIMER módulo en un proceso
 * donde server.js todavía no arrancó (exactamente el caso de un test
 * que importa este servicio de forma aislada, sin levantar server.js
 * como proceso hijo). whatsapp-meta.js es un archivo protegido (ver
 * CLAUDE.md) -- este es el único cambio ahí: mover 2 funciones
 * autocontenidas a un archivo nuevo y reexportarlas, sin tocar ninguna
 * otra lógica ni comportamiento.
 */
const META_GRAPH_BASE_URL = process.env.META_GRAPH_BASE_URL || 'https://graph.facebook.com';

// Exportada (ademas de enviarDocumento) porque whatsapp-meta.js la
// reutiliza tal cual para enviarImagenBuffer -- mismo helper de subida
// en 2 pasos, sin duplicar la logica de red en dos archivos.
export async function subirMediaAMeta(buffer, filename, credenciales, mimeType = 'application/pdf') {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: mimeType }), filename);
  const url = `${META_GRAPH_BASE_URL}/v20.0/${credenciales.phoneNumberId}/media`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${credenciales.accessToken}` },
    body: form,
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(`Meta API (subir media): ${JSON.stringify(err)}`);
  }
  const data = await resp.json();
  return data.id;
}

export async function enviarDocumento(telefono, buffer, filename, caption = '', credenciales) {
  if (!credenciales?.phoneNumberId || !credenciales?.accessToken) {
    console.error('[Meta WA] enviarDocumento sin credenciales resueltas — envío omitido (fail closed)');
    return null;
  }
  const mediaId = await subirMediaAMeta(buffer, filename, credenciales);
  const url = `${META_GRAPH_BASE_URL}/v20.0/${credenciales.phoneNumberId}/messages`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${credenciales.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: telefono,
      type: 'document',
      document: { id: mediaId, filename, caption },
    }),
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(`Meta API (documento): ${JSON.stringify(err)}`);
  }
  return resp.json();
}
