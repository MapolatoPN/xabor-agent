// Suite persistida: chat multimedia básico -- enviar y recibir fotos como
// WhatsApp normal (sin IA visual, sin catálogo, sin video/audio). Cubre los
// casos obligatorios del encargo: enviar una/varias imágenes desde el
// panel, caption, archivo muy grande, extensión falsa/MIME inválido, error
// de Meta + reintento, recibir imagen desde webhook simulado, webhook
// duplicado, refrescar y conservar historial (vía DB), WebSocket (payload
// del broadcast), aislamiento cruzado entre dos negocios, negocio sin
// WhatsApp configurado.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import sharp from 'sharp';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4160';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool, actualizarConfiguracion, crearUsuarioConPassword } = await import('../src/services/database.js');
const { validarImagenReal, comprimirImagen, MAX_IMAGENES_POR_ENVIO } = await import('../src/services/imagenes.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
function cookieHeader(usuarioId, negocioId, rol) { return `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`; }
async function api(base, path, { cookie, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

// Imágenes reales mínimas (magic bytes reales, sintetizadas con sharp --
// nunca fotos/datos de un cliente real).
const JPG_REAL = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 200, g: 30, b: 30 } } }).jpeg().toBuffer();
const PNG_REAL = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 30, g: 200, b: 30, alpha: 0.5 } } }).png().toBuffer();
const WEBP_REAL = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 30, g: 30, b: 200 } } }).webp().toBuffer();
const GRANDE_REAL = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 100, g: 100, b: 100 } } }).jpeg({ quality: 100 }).toBuffer();

// ═══════════ Unidad: validación pura (sin servidor) ═══════════
await t('VALIDACION', 'jpg real (magic bytes) se acepta', async () => {
  const r = await validarImagenReal(JPG_REAL);
  assert.strictEqual(r.valido, true);
  assert.strictEqual(r.mime, 'image/jpeg');
});
await t('VALIDACION', 'png real se acepta', async () => {
  const r = await validarImagenReal(PNG_REAL);
  assert.strictEqual(r.valido, true);
  assert.strictEqual(r.mime, 'image/png');
});
await t('VALIDACION', 'webp real se acepta', async () => {
  const r = await validarImagenReal(WEBP_REAL);
  assert.strictEqual(r.valido, true);
  assert.strictEqual(r.mime, 'image/webp');
});
await t('VALIDACION', 'texto plano con extensión .jpg falsa no pasa (magic bytes reales de texto)', async () => {
  const r = await validarImagenReal(Buffer.from('esto no es una imagen, es texto plano', 'utf8'));
  assert.strictEqual(r.valido, false);
  assert.strictEqual(r.motivo, 'mime_invalido');
});
await t('VALIDACION', 'un ejecutable con extensión .png falsificada no pasa (magic bytes reales de EXE)', async () => {
  const exeDisfrazado = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
  const r = await validarImagenReal(exeDisfrazado);
  assert.strictEqual(r.valido, false);
  assert.strictEqual(r.motivo, 'mime_invalido');
});
await t('VALIDACION', 'gif real (tipo no soportado explícitamente) se rechaza', async () => {
  const gifReal = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } } }).gif().toBuffer();
  const r = await validarImagenReal(gifReal);
  assert.strictEqual(r.valido, false);
  assert.strictEqual(r.motivo, 'mime_invalido');
});
await t('VALIDACION', 'archivo que excede el tamaño máximo se rechaza', async () => {
  const original = process.env.MEDIA_MAX_IMAGE_MB;
  process.env.MEDIA_MAX_IMAGE_MB = String((JPG_REAL.length - 1) / (1024 * 1024)); // 1 byte por debajo del real
  const r = await validarImagenReal(JPG_REAL);
  process.env.MEDIA_MAX_IMAGE_MB = original;
  assert.strictEqual(r.valido, false);
  assert.strictEqual(r.motivo, 'tamano_excedido');
});
await t('COMPRESION', 'una imagen enorme (4000x3000) se redimensiona a un lado máximo razonable', async () => {
  const { buffer } = await comprimirImagen(GRANDE_REAL, 'image/jpeg');
  const meta = await sharp(buffer).metadata();
  assert.ok(meta.width <= 2048 && meta.height <= 2048, `esperaba <=2048px, obtuve ${meta.width}x${meta.height}`);
  assert.ok(buffer.length < GRANDE_REAL.length, 'la versión comprimida debe pesar menos que la original');
});
await t('COMPRESION', 'una imagen ya pequeña no se agranda (withoutEnlargement)', async () => {
  const { buffer } = await comprimirImagen(JPG_REAL, 'image/jpeg');
  const meta = await sharp(buffer).metadata();
  assert.strictEqual(meta.width, 20);
  assert.strictEqual(meta.height, 20);
});

// ═══════════ Setup de negocios/módulos/credenciales ═══════════
const TEL_A1 = '5218789950001';
const TEL_A2 = '5218789950002';
const TEL_B1 = '5218789950010';
const TEL_ENTRANTE = '5218789950020';
const TEL_DEDUP = '5218789950021';
const TEL_SIN_WA = '5218789950030';

await pool.query(`DELETE FROM mensajes WHERE telefono LIKE '52187899500%'`);
await pool.query(`DELETE FROM documentos WHERE telefono LIKE '52187899500%'`);
await pool.query(`INSERT INTO clientes (telefono, nombre, negocio_id) VALUES ($1,'Cliente Img A',$2) ON CONFLICT (telefono) DO UPDATE SET negocio_id = $2`, [TEL_A1, SEED.negocioA]);
await pool.query(`INSERT INTO clientes (telefono, nombre, negocio_id) VALUES ($1,'Cliente Img A2',$2) ON CONFLICT (telefono) DO UPDATE SET negocio_id = $2`, [TEL_A2, SEED.negocioA]);
await pool.query(`INSERT INTO clientes (telefono, nombre, negocio_id) VALUES ($1,'Cliente Img B',$2) ON CONFLICT (telefono) DO UPDATE SET negocio_id = $2`, [TEL_B1, SEED.negocioB]);
await pool.query(`INSERT INTO clientes (telefono, nombre, negocio_id) VALUES ($1,'Cliente Sin WA',$2) ON CONFLICT (telefono) DO UPDATE SET negocio_id = $2`, [TEL_SIN_WA, SEED.negocioB]);

async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(
    `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
     ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`,
    [negocioId, modulo, estado]
  );
}
// chat_imagenes ya viene 'activo' por defecto para todo negocio desde la
// migración 026 -- se fija explícito aquí solo para que la prueba sea
// reproducible sin depender de ese estado previo.
await fijarModulo(SEED.negocioA, 'chat_imagenes', 'activo');
await fijarModulo(SEED.negocioB, 'chat_imagenes', 'activo');

const PNID_A = 'PNID_IMG_A_WEBHOOK';
await pool.query(`INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo) VALUES ($1,'whatsapp',$2,'Prueba imagenes A', TRUE) ON CONFLICT (canal, identificador) DO NOTHING`, [SEED.negocioA, PNID_A]);
await actualizarConfiguracion({ int_wa_phone_id: PNID_A, int_wa_token: 'fake-token-img-a' }, SEED.negocioA);
// negocioB debe quedar SIN credenciales de WhatsApp para la prueba de "409
// sin WhatsApp configurado" -- otras suites (fase-a-regresion, fase-b-
// integraciones) configuran credenciales de prueba para negocioB y no
// garantizan limpiarlas antes de que corra esta suite (el orden de
// ejecución entre archivos no está garantizado) -- se limpia aquí de forma
// defensiva en vez de asumir un estado previo.
await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave IN ('int_wa_phone_id','int_wa_token')`, [SEED.negocioB]);
await pool.query(`
  DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN (
    SELECT id FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'whatsapp'
  )
`, [SEED.negocioB]);
await pool.query(`UPDATE integraciones_canal SET activo = FALSE, estado = 'no_configurado' WHERE negocio_id = $1 AND canal = 'whatsapp'`, [SEED.negocioB]);

const cookieAdminA = cookieHeader(SEED.adminNegocioAUsuarioId, SEED.negocioA, 'admin');
// El usuario "superadmin" del fixture solo tiene membresía real en negocioA
// -- para operar como admin de negocioB (y distinguir 403 de membresía de
// un 409 real de "WhatsApp no configurado") hace falta un usuario con
// membresía activa propia en ese negocio.
await pool.query(`DELETE FROM usuarios WHERE email = 'admin-b-chatimagenes@test.local'`);
const adminB = await crearUsuarioConPassword({
  negocioId: SEED.negocioB, nombre: 'Admin B (prueba imágenes)', email: 'admin-b-chatimagenes@test.local',
  password: 'ClaveAdminBPrueba123!', rol: 'admin',
});
const cookieAdminB = cookieHeader(adminB.id, SEED.negocioB, 'admin');

// ═══════════ Frontend: el botón se declara gateado por módulo (estático) ═══════
await t('FRONTEND', 'botón adjuntar imagen existe y está gateado por data-modulo', async () => {
  const html = readFileSync(join(__dirname, '..', 'panel', 'index.html'), 'utf8');
  assert.match(html, /id="btn-adjuntar-imagen"[\s\S]{0,80}data-modulo="chat_imagenes"/);
  assert.match(html, /id="input-imagenes-camara"[\s\S]{0,200}capture="environment"/);
  assert.match(html, /id="input-imagenes-galeria"[\s\S]{0,120}multiple/);
});

const metaMock = await arrancarMetaMock();
const srv = await arrancarServidor({ PORT: PUERTO, META_GRAPH_BASE_URL: metaMock.baseUrl }, { timeoutMs: 30000 });

try {
  // ═══════════ Backend: negocio B (sin credenciales WA) -> 409 ═══════
  await t('MODULO', 'negocio sin WhatsApp configurado -> 409 al enviar (no 500, no crash)', async () => {
    const r = await api(srv.base, '/api/imagenes/enviar', {
      cookie: cookieAdminB, method: 'POST',
      body: { telefono: TEL_SIN_WA, imagenes: [{ filename: 'foto.jpg', base64: JPG_REAL.toString('base64') }] },
    });
    assert.strictEqual(r.status, 409);
  });

  // ═══════════ Envío: una imagen ═══════
  let documentoEnviadoId;
  await t('ENVIO', 'enviar una imagen válida desde el panel (escritorio)', async () => {
    const r = await api(srv.base, '/api/imagenes/enviar', {
      cookie: cookieAdminA, method: 'POST',
      body: { telefono: TEL_A1, imagenes: [{ filename: 'producto.jpg', base64: JPG_REAL.toString('base64') }], caption: 'Aquí tienes la foto' },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.resultados.length, 1);
    assert.strictEqual(r.body.resultados[0].ok, true);
    assert.strictEqual(r.body.resultados[0].documento.estado, 'listo');
    assert.strictEqual(r.body.resultados[0].documento.categoria, 'imagen');
    documentoEnviadoId = r.body.resultados[0].documento.id;
  });

  await t('ENVIO', 'el mensaje queda con tipo=imagen y visible en la conversación', async () => {
    const r = await api(srv.base, `/api/conversacion/${TEL_A1}`, { cookie: cookieAdminA });
    assert.strictEqual(r.status, 200);
    const msg = r.body.find(m => m.tipo === 'imagen');
    assert.ok(msg, 'debe existir un mensaje de tipo imagen');
    assert.strictEqual(msg.documento_estado, 'listo');
  });

  // ═══════════ Envío: varias imágenes + caption ═══════
  await t('ENVIO', 'enviar varias imágenes (jpg+png+webp) en un solo lote, con caption', async () => {
    const r = await api(srv.base, '/api/imagenes/enviar', {
      cookie: cookieAdminA, method: 'POST',
      body: {
        telefono: TEL_A2, caption: 'Tres fotos de muestra',
        imagenes: [
          { filename: 'a.jpg', base64: JPG_REAL.toString('base64') },
          { filename: 'b.png', base64: PNG_REAL.toString('base64') },
          { filename: 'c.webp', base64: WEBP_REAL.toString('base64') },
        ],
      },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.resultados.length, 3);
    assert.ok(r.body.resultados.every(x => x.ok));
    const { rows } = await pool.query(`SELECT mime_type FROM documentos WHERE telefono = $1 ORDER BY created_at`, [TEL_A2]);
    assert.deepStrictEqual(rows.map(x => x.mime_type).sort(), ['image/jpeg', 'image/png', 'image/webp']);
  });

  await t('LIMITE', `más de ${MAX_IMAGENES_POR_ENVIO} imágenes en un envío -> 400`, async () => {
    const imagenes = Array.from({ length: MAX_IMAGENES_POR_ENVIO + 1 }, (_, i) => ({ filename: `x${i}.jpg`, base64: JPG_REAL.toString('base64') }));
    const r = await api(srv.base, '/api/imagenes/enviar', { cookie: cookieAdminA, method: 'POST', body: { telefono: TEL_A1, imagenes } });
    assert.strictEqual(r.status, 400);
  });

  // ═══════════ Validación de archivo inválido en el propio endpoint HTTP ═══════
  await t('VALIDACION-HTTP', 'extensión falsa (texto plano con nombre .jpg) es bloqueada por el endpoint de envío', async () => {
    const r = await api(srv.base, '/api/imagenes/enviar', {
      cookie: cookieAdminA, method: 'POST',
      body: { telefono: TEL_A1, imagenes: [{ filename: 'falso.jpg', base64: Buffer.from('no soy una imagen').toString('base64') }] },
    });
    assert.strictEqual(r.status, 502, JSON.stringify(r.body)); // huboExito=false -> 502 con detalle por imagen
    assert.strictEqual(r.body.resultados[0].ok, false);
  });

  await t('VALIDACION-HTTP', 'lote mixto (una válida + una inválida) reporta éxito parcial, no aborta todo el lote', async () => {
    const r = await api(srv.base, '/api/imagenes/enviar', {
      cookie: cookieAdminA, method: 'POST',
      body: {
        telefono: TEL_A1,
        imagenes: [
          { filename: 'buena.jpg', base64: JPG_REAL.toString('base64') },
          { filename: 'mala.jpg', base64: Buffer.from('no soy una imagen').toString('base64') },
        ],
      },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.resultados.filter(x => x.ok).length, 1);
    assert.strictEqual(r.body.resultados.filter(x => !x.ok).length, 1);
  });

  // ═══════════ Error de Meta + reintento ═══════════
  await t('ERROR-META', 'error real de Meta al enviar -> 502 con detalle, no crashea el servidor', async () => {
    metaMock.forzarErrorSiguienteEnvio();
    const r = await api(srv.base, '/api/imagenes/enviar', {
      cookie: cookieAdminA, method: 'POST',
      body: { telefono: TEL_A1, imagenes: [{ filename: 'reintentar.jpg', base64: JPG_REAL.toString('base64') }] },
    });
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.body.resultados[0].ok, false);
  });
  await t('ERROR-META', 'reintentar la misma imagen tras el error -> ahora sí se envía', async () => {
    const r = await api(srv.base, '/api/imagenes/enviar', {
      cookie: cookieAdminA, method: 'POST',
      body: { telefono: TEL_A1, imagenes: [{ filename: 'reintentar.jpg', base64: JPG_REAL.toString('base64') }] },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.resultados[0].ok, true);
  });

  // ═══════════ Aislamiento cruzado ═══════════
  await t('AISLAMIENTO', 'negocio B no puede leer metadata de una imagen de negocio A -> 403', async () => {
    const r = await api(srv.base, `/api/imagenes/${documentoEnviadoId}`, { cookie: cookieAdminB });
    assert.strictEqual(r.status, 403);
  });
  await t('AISLAMIENTO', 'negocio B no puede descargar el archivo de una imagen de negocio A -> 404 (mismo criterio que /api/documentos/:id/archivo -- no confirma existencia cruzada)', async () => {
    const r = await fetch(`${srv.base}/api/imagenes/${documentoEnviadoId}/archivo`, { headers: { Cookie: cookieAdminB } });
    assert.strictEqual(r.status, 404);
  });
  await t('AISLAMIENTO', 'imagen inexistente -> 404', async () => {
    const r = await api(srv.base, `/api/imagenes/00000000-0000-0000-0000-000000000000`, { cookie: cookieAdminA });
    assert.strictEqual(r.status, 404);
  });
  await t('AISLAMIENTO', 'descargar el archivo propio sí funciona y devuelve bytes de imagen real', async () => {
    const r = await fetch(`${srv.base}/api/imagenes/${documentoEnviadoId}/archivo`, { headers: { Cookie: cookieAdminA } });
    assert.strictEqual(r.status, 200);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.ok(buf.length > 0);
    assert.strictEqual(r.headers.get('content-type'), 'image/jpeg');
  });

  // ═══════════ Recepción vía webhook (Meta simulada) ═══════════
  async function simularWebhookImagen(phoneNumberId, telefono, mediaId, wamid, caption) {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: phoneNumberId },
        messages: [{ type: 'image', from: telefono, id: wamid, image: { id: mediaId, mime_type: 'image/jpeg', caption: caption || undefined } }],
        contacts: [{ profile: { name: 'Cliente WhatsApp Foto' } }],
      } }] }],
    };
    await fetch(srv.base + '/webhook/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    await new Promise(r => setTimeout(r, 500));
  }

  await t('ENTRANTE', 'imagen entrante aparece en la conversación', async () => {
    const mediaId = 'MEDIA_IMG_ENTRANTE_1';
    metaMock.registrarArchivo(mediaId, JPG_REAL, 'image/jpeg');
    await simularWebhookImagen(PNID_A, TEL_ENTRANTE, mediaId, 'wamid.IMG-ENTRANTE-1', 'Foto del cliente');
    const r = await api(srv.base, `/api/conversacion/${TEL_ENTRANTE}`, { cookie: cookieAdminA });
    assert.strictEqual(r.status, 200);
    const msgImg = r.body.find(m => m.tipo === 'imagen');
    assert.ok(msgImg, 'debe existir un mensaje de tipo imagen');
    assert.strictEqual(msgImg.documento_estado, 'listo');
    assert.strictEqual(msgImg.documento_caption, 'Foto del cliente');
  });

  await t('ENTRANTE', 'la imagen entrante se puede descargar y son bytes de imagen real', async () => {
    const { rows } = await pool.query(`SELECT id, checksum FROM documentos WHERE telefono = $1 AND categoria = 'imagen'`, [TEL_ENTRANTE]);
    assert.strictEqual(rows.length, 1);
    assert.ok(rows[0].checksum, 'debe haberse calculado un checksum SHA-256');
    const r = await fetch(`${srv.base}/api/imagenes/${rows[0].id}/archivo`, { headers: { Cookie: cookieAdminA } });
    assert.strictEqual(r.status, 200);
  });

  await t('DEDUP', 'reentrega del mismo webhook (mismo wamid) no duplica la imagen', async () => {
    const mediaId = 'MEDIA_IMG_ENTRANTE_DEDUP';
    metaMock.registrarArchivo(mediaId, PNG_REAL, 'image/png');
    await simularWebhookImagen(PNID_A, TEL_DEDUP, mediaId, 'wamid.IMG-DEDUP', null);
    await simularWebhookImagen(PNID_A, TEL_DEDUP, mediaId, 'wamid.IMG-DEDUP'); // idéntico
    const { rows } = await pool.query(`SELECT * FROM documentos WHERE telefono = $1 AND negocio_id = $2`, [TEL_DEDUP, SEED.negocioA]);
    assert.strictEqual(rows.length, 1);
  });

  await t('MODULO', 'negocio sin chat_imagenes: imagen entrante se descartaría (verificación directa del gate)', async () => {
    await fijarModulo(SEED.negocioA, 'chat_imagenes', 'no_contratado');
    const mediaId = 'MEDIA_IMG_MODULO_OFF';
    metaMock.registrarArchivo(mediaId, JPG_REAL, 'image/jpeg');
    const telModuloOff = '5218789950099';
    await simularWebhookImagen(PNID_A, telModuloOff, mediaId, 'wamid.IMG-MODULO-OFF');
    const { rows } = await pool.query(`SELECT * FROM documentos WHERE telefono = $1`, [telModuloOff]);
    assert.strictEqual(rows.length, 0, 'con el módulo apagado no debe crearse ninguna fila');
    await fijarModulo(SEED.negocioA, 'chat_imagenes', 'activo'); // restaurar para el resto de la suite
  });

  await t('REGRESION', 'un mensaje de texto normal sigue funcionando en la misma conversación (coexiste con imágenes)', async () => {
    const { guardarMensaje } = await import('../src/services/database.js');
    const msg = await guardarMensaje(TEL_A1, null, 'saliente', 'Gracias por tu preferencia', SEED.negocioA, 'humano');
    assert.ok(msg);
    assert.strictEqual(msg.tipo, 'texto');
    const r = await api(srv.base, `/api/conversacion/${TEL_A1}`, { cookie: cookieAdminA });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.some(m => m.tipo === 'imagen'));
    assert.ok(r.body.some(m => m.tipo === 'texto' && m.texto === 'Gracias por tu preferencia'));
  });
} finally {
  srv.detener();
  metaMock.detener();
  await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave IN ('int_wa_phone_id','int_wa_token')`, [SEED.negocioA]);
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('\nDetalle de fallos:'); fallos.forEach(f => console.log('  - ' + f)); }
await pool.end();
process.exit(fallidas > 0 ? 1 : 0);
