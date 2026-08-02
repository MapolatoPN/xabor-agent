/**
 * almacenamiento.js — Capa de almacenamiento de archivos privados
 * (documentos PDF de chat y PDFs de cotizaciones), con dos drivers:
 *
 *   STORAGE_DRIVER=local (default) — filesystem local bajo storage/,
 *   mismo patrón que storage/cfdi/ (satSync.js). Pensado para
 *   desarrollo y para las suites de prueba (no requiere credenciales).
 *
 *   STORAGE_DRIVER=s3 — cualquier backend S3-compatible (AWS S3,
 *   Cloudflare R2, MinIO) vía S3_ENDPOINT/S3_BUCKET/S3_REGION/
 *   S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY/S3_FORCE_PATH_STYLE.
 *
 * Nunca se expone una URL pública permanente: el driver local no
 * genera URL alguna (el endpoint sirve el archivo directamente,
 * re-validando permisos en cada request); el driver s3 solo genera
 * URLs prefirmadas de corta duración, y únicamente después de que el
 * llamador ya validó que el actor tiene permiso sobre ese archivo.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_STORAGE_DIR = path.join(__dirname, '../../storage/documentos');

function driverActivo() {
  return (process.env.STORAGE_DRIVER || 'local').trim().toLowerCase();
}

function asegurarDirectorio(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

// storage_key para el driver local es una ruta relativa dentro de
// storage/documentos/; para s3 es la key del objeto en el bucket.
// En ambos casos usa un UUID (nunca el nombre de archivo original)
// para que la ruta no sea adivinable ni filtre el nombre real.
function generarStorageKey(negocioId, extension) {
  const ext = (extension || 'pdf').replace(/[^a-z0-9]/gi, '') || 'pdf';
  return `${negocioId}/${crypto.randomUUID()}.${ext}`;
}

let clienteS3 = null;
async function obtenerClienteS3() {
  if (clienteS3) return clienteS3;
  const { S3Client } = await import('@aws-sdk/client-s3');
  clienteS3 = new S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  });
  return clienteS3;
}

/** Guarda un buffer y devuelve el storage_key para persistir en DB. */
export async function guardarArchivo(buffer, { negocioId, extension } = {}) {
  if (!negocioId) throw new Error('almacenamiento.guardarArchivo: negocioId requerido');
  const storageKey = generarStorageKey(negocioId, extension);

  if (driverActivo() === 's3') {
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const cliente = await obtenerClienteS3();
    await cliente.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: storageKey,
      Body: buffer,
      ContentType: 'application/pdf',
    }));
    return storageKey;
  }

  const rutaAbsoluta = path.join(LOCAL_STORAGE_DIR, storageKey);
  asegurarDirectorio(path.dirname(rutaAbsoluta));
  fs.writeFileSync(rutaAbsoluta, buffer);
  return storageKey;
}

/** Lee un archivo del driver local. El driver s3 no lo soporta -- usar obtenerUrlDescarga. */
export async function leerArchivo(storageKey) {
  if (driverActivo() === 's3') {
    throw new Error('almacenamiento.leerArchivo: no soportado en driver s3, usar obtenerUrlDescarga');
  }
  const rutaAbsoluta = path.join(LOCAL_STORAGE_DIR, storageKey);
  return fs.readFileSync(rutaAbsoluta);
}

/**
 * driver local: siempre null (el endpoint llamador debe hacer streaming
 * directo vía leerArchivo, tras validar permisos).
 * driver s3: URL prefirmada de corta duración. Se debe llamar SOLO
 * después de validar que el actor tiene permiso sobre el archivo --
 * esta función no vuelve a validar nada.
 */
export async function obtenerUrlDescarga(storageKey, { ttlSegundos = 300 } = {}) {
  if (driverActivo() !== 's3') return null;
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const cliente = await obtenerClienteS3();
  const comando = new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: storageKey });
  return getSignedUrl(cliente, comando, { expiresIn: ttlSegundos });
}

export async function eliminarArchivo(storageKey) {
  if (driverActivo() === 's3') {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const cliente = await obtenerClienteS3();
    await cliente.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: storageKey }));
    return;
  }
  const rutaAbsoluta = path.join(LOCAL_STORAGE_DIR, storageKey);
  if (fs.existsSync(rutaAbsoluta)) fs.unlinkSync(rutaAbsoluta);
}

export function driverEsLocal() {
  return driverActivo() !== 's3';
}
