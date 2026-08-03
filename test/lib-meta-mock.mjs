// Servidor HTTP mínimo que simula la Graph API de Meta para las pruebas de
// documentos PDF (nunca se llama a la Meta real). Se usa junto con
// META_GRAPH_BASE_URL para que whatsapp-meta.js apunte aquí en vez del host
// real -- ver esa env var en src/channels/whatsapp-meta.js.
import { createServer } from 'http';

export function arrancarMetaMock() {
  const archivosPorMediaId = {};
  let forzarErrorSiguienteEnvio = false;

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // Simula un fallo real de Meta (usado por pruebas de "error de Meta" /
    // reintento) -- se autolimpia tras UNA sola respuesta, para no dejar
    // el mock en modo fallo para el resto de la suite por accidente.
    if (forzarErrorSiguienteEnvio && req.method === 'POST' && (/\/media$/.test(url.pathname) || /\/messages$/.test(url.pathname))) {
      forzarErrorSiguienteEnvio = false;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'simulado: Meta no disponible' } }));
    }
    // Paso 1 de descarga: resolver media_id -> url + metadata
    const matchResolver = url.pathname.match(/^\/v20\.0\/([^/]+)$/);
    if (req.method === 'GET' && matchResolver && archivosPorMediaId[matchResolver[1]]) {
      const archivo = archivosPorMediaId[matchResolver[1]];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        url: `http://localhost:${server.address().port}/v20.0/download/${matchResolver[1]}`,
        mime_type: archivo.mimeType || 'application/pdf',
        file_size: archivo.buffer.length,
      }));
    }
    // Paso 2 de descarga: bytes reales
    const matchDescarga = url.pathname.match(/^\/v20\.0\/download\/([^/]+)$/);
    if (req.method === 'GET' && matchDescarga && archivosPorMediaId[matchDescarga[1]]) {
      const archivo = archivosPorMediaId[matchDescarga[1]];
      res.writeHead(200, { 'Content-Type': archivo.mimeType || 'application/pdf' });
      return res.end(archivo.buffer);
    }
    // Subida de media saliente
    if (req.method === 'POST' && /\/media$/.test(url.pathname)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ id: 'MEDIA_ID_SALIENTE_FAKE' }));
    }
    // Envío de mensaje (texto/imagen/documento)
    if (req.method === 'POST' && /\/messages$/.test(url.pathname)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ messages: [{ id: 'wamid.SALIENTE_FAKE_' + Date.now() }] }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not_found_en_mock' } }));
  });

  return new Promise((resolve) => {
    server.listen(0, () => resolve({
      baseUrl: `http://localhost:${server.address().port}`,
      registrarArchivo: (mediaId, buffer, mimeType = 'application/pdf') => { archivosPorMediaId[mediaId] = { buffer, mimeType }; },
      forzarErrorSiguienteEnvio: () => { forzarErrorSiguienteEnvio = true; },
      detener: () => server.close(),
    }));
  });
}
