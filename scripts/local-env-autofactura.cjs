'use strict';
// Entorno LOCAL de autofactura — única fuente de verdad para
// `npm run dev:autofactura` y `npm run smoke:autofactura`.
//
// Carga las variables de dev-local.env.cmd (nunca las imprime ni las copia a
// otro archivo), conserva su INTEGRATIONS_ENCRYPTION_KEY y sobrescribe SOLO el
// pathname de DATABASE_URL para apuntar a la base local de pruebas
// `edged1_agrescate` (mismo host, puerto y credenciales). Además diagnostica,
// en solo lectura, que el negocio de prueba exista y esté activo, que tenga el
// módulo de facturación y en qué estado está su credencial de Facturapi
// (CONFIGURADA / NO CONFIGURADA / NO DESCIFRABLE) sin mostrar jamás la llave.
const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const RAIZ = path.resolve(__dirname, '..');
const ARCHIVO_ENV_POR_DEFECTO = 'C:\\xabor-agent\\dev-local.env.cmd';
const DB_LOCAL = 'edged1_agrescate';
const NEGOCIO_TEST = '6885c311-c6d7-4c18-8cb7-6dc3a1f96e41';
const MODULO_OK = new Set(['activo', 'configurado']);
const AVISO_REVINCULAR = 'Facturapi debe volver a vincularse UNA vez desde Configuración → Facturación.';

function resolverArchivoEnv() {
  if (process.env.XABOR_DEV_ENV_CMD) return process.env.XABOR_DEV_ENV_CMD;
  const local = path.join(RAIZ, 'dev-local.env.cmd');
  return fs.existsSync(local) ? local : ARCHIVO_ENV_POR_DEFECTO;
}

// `set NOMBRE=valor` de un .cmd; ignora REM, @echo y líneas vacías.
function leerEnvCmd(archivo) {
  if (!fs.existsSync(archivo)) throw new Error(`No existe el archivo de entorno local: ${archivo}`);
  const vars = {};
  for (const linea of fs.readFileSync(archivo, 'utf8').split(/\r?\n/)) {
    const m = linea.match(/^\s*set\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/i);
    if (!m) continue;
    let valor = m[2].trim();
    if (/^".*"$/.test(valor)) valor = valor.slice(1, -1);
    vars[m[1]] = valor;
  }
  return vars;
}

/**
 * El entorno con el que corren dev y smoke. Las variables del archivo mandan
 * sobre las de la sesión (así los dos comandos ven exactamente lo mismo).
 * Falla cerrado: sin DATABASE_URL, sin INTEGRATIONS_ENCRYPTION_KEY o con
 * NODE_ENV=production no devuelve nada.
 */
function construirEntorno({ archivo = resolverArchivoEnv(), base = process.env, db = DB_LOCAL } = {}) {
  const vars = leerEnvCmd(archivo);
  const env = { ...base, ...vars };
  if (String(env.NODE_ENV || '').toLowerCase() === 'production') {
    throw new Error('NODE_ENV=production: el entorno local de autofactura no corre en producción.');
  }
  if (!env.DATABASE_URL) throw new Error(`DATABASE_URL no está definida en ${archivo}.`);
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { throw new Error('DATABASE_URL no es una URL válida.'); }
  url.pathname = `/${db}`;
  env.DATABASE_URL = url.toString();
  if (!new URL(env.DATABASE_URL).pathname.endsWith(`/${db}`)) throw new Error(`DATABASE_URL no quedó apuntando a ${db}.`);
  if (!env.INTEGRATIONS_ENCRYPTION_KEY) throw new Error(`INTEGRATIONS_ENCRYPTION_KEY no está definida en ${archivo}.`);
  const resumen = {
    db: `${url.hostname}:${url.port || '5432'}/${db}`,
    encryptionKey: 'CONFIGURADA',
    entorno: 'LOCAL',
    archivo,
  };
  return { env, resumen };
}

function imprimirResumen(resumen) {
  console.log(`DB: ${resumen.db}`);
  console.log(`ENCRYPTION_KEY: ${resumen.encryptionKey}`);
  console.log(`ENTORNO: ${resumen.entorno}`);
}

/** PID que escucha en el puerto, o null si está libre. Nunca mata nada. */
async function pidEnPuerto(puerto) {
  if (process.platform === 'win32') {
    try {
      const salida = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
      for (const linea of salida.split(/\r?\n/)) {
        const m = linea.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
        if (m && Number(m[2]) === Number(puerto)) return Number(m[3]);
      }
      const salida6 = execFileSync('netstat', ['-ano', '-p', 'tcpv6'], { encoding: 'utf8', windowsHide: true });
      for (const linea of salida6.split(/\r?\n/)) {
        const m = linea.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
        if (m && Number(m[2]) === Number(puerto)) return Number(m[3]);
      }
      return null;
    } catch { /* cae al sondeo por socket */ }
  }
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve('desconocido'));
    s.listen(puerto, () => s.close(() => resolve(null)));
  });
}

/**
 * Diagnóstico de solo lectura contra la base local, con los servicios reales
 * del repo. Devuelve etiquetas listas para imprimir; nunca la llave.
 */
async function diagnosticar(env, { negocioId = NEGOCIO_TEST } = {}) {
  process.env.DATABASE_URL = env.DATABASE_URL;
  process.env.INTEGRATIONS_ENCRYPTION_KEY = env.INTEGRATIONS_ENCRYPTION_KEY;
  const { pool } = await import(pathToFileURL(path.join(RAIZ, 'src', 'services', 'database.js')).href);
  const { obtenerCredencialesFacturapiDescifradas } =
    await import(pathToFileURL(path.join(RAIZ, 'src', 'services', 'integracionesService.js')).href);
  const d = { negocioId, negocio: 'NO EXISTE', nombre: null, modulo: 'NO', facturapi: 'NO CONFIGURADA', esTest: false, ok: false };
  try {
    const { rows: [n] } = await pool.query('SELECT nombre, activo FROM negocios WHERE id=$1', [negocioId]);
    if (n) { d.nombre = n.nombre; d.negocio = n.activo ? 'OK' : 'INACTIVO'; }
    const { rows: [m] } = await pool.query(
      `SELECT estado FROM negocio_modulos WHERE negocio_id=$1 AND modulo='facturacion'`, [negocioId]);
    d.modulo = m && MODULO_OK.has(m.estado) ? 'OK' : `NO (${m ? m.estado : 'sin módulo'})`;
    const { rows: [ic] } = await pool.query(
      `SELECT ic.estado, (cc.integracion_id IS NOT NULL) AS con_credencial
         FROM integraciones_canal ic LEFT JOIN integraciones_canal_credenciales cc ON cc.integracion_id=ic.id
        WHERE ic.negocio_id=$1 AND ic.canal='facturacion' AND ic.proveedor='facturapi'`, [negocioId]);
    if (ic && ic.con_credencial && ic.estado === 'activo') {
      let cred = null;
      try { cred = await obtenerCredencialesFacturapiDescifradas(negocioId); } catch { cred = null; }
      if (cred && cred.apiKey) {
        d.esTest = /^sk_test_/.test(cred.apiKey);
        d.facturapi = d.esTest ? 'CONFIGURADA' : 'CONFIGURADA (NO ES sk_test_)';
      } else {
        d.facturapi = 'NO DESCIFRABLE';
      }
    }
    d.ok = d.negocio === 'OK' && d.modulo === 'OK';
  } finally {
    await pool.end().catch(() => {});
  }
  return d;
}

function imprimirDiagnostico(d) {
  console.log(`NEGOCIO TEST: ${d.negocio}${d.nombre ? ` (${d.nombre})` : ''}`);
  console.log(`MODULO FACTURACION: ${d.modulo}`);
  console.log(`FACTURAPI TEST: ${d.facturapi}`);
  if (d.facturapi !== 'CONFIGURADA') console.log(AVISO_REVINCULAR);
}

module.exports = {
  RAIZ, DB_LOCAL, NEGOCIO_TEST, AVISO_REVINCULAR,
  resolverArchivoEnv, leerEnvCmd, construirEntorno, imprimirResumen, pidEnPuerto, diagnosticar, imprimirDiagnostico,
};
