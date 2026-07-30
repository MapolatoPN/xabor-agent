// ─── Seed de integraciones_canal (Incidente P0 — aislamiento) ──────────────
// Script MANUAL — nunca se ejecuta automáticamente. Requisito de deploy
// OBLIGATORIO antes de subir la corrección de aislamiento: sin una fila
// mapeando el canal real (WhatsApp/voz) al negocio_id de Nonna Maye, el
// webhook/llamada entrante fallará cerrado (rechazado, ver whatsapp-meta.js
// y voice.js) y el canal en vivo de Nonna Maye se rompería en producción.
//
// Nunca imprime tokens ni secretos -- el identificador de canal
// (phone_number_id de Meta, número de Twilio) NO es un secreto según la
// migración 008 ("Nunca un secreto ... esta tabla solo resuelve a qué
// negocio pertenece este identificador"), así que sí se registra en el log
// para poder confirmar visualmente que se mapeó el número correcto.
//
// Uso (canal whatsapp -- IDENTIFICADOR se toma automáticamente de
// META_PHONE_NUMBER_ID si ya está configurado en el entorno del servicio,
// para no tener que copiarlo/pegarlo a mano):
//   railway run --service xabor-agent \
//     node scripts/seed-integracion-canal.js CANAL=whatsapp NEGOCIO_SLUG=nonna-maye
//
// Uso (canal voz -- no hay env var existente con el número de Twilio, se
// pasa explícito; no es un secreto, es el número público que marcan los
// clientes):
//   railway run --service xabor-agent \
//     node scripts/seed-integracion-canal.js CANAL=voz IDENTIFICADOR=+528781234567 NEGOCIO_SLUG=nonna-maye
//
// Salvaguarda: misma que crear-admin-local.js/registrar-superadmin.js -- se
// niega a correr contra un host que parezca Railway/producción salvo
// PERMITIR_HOST_REMOTO=si. Idempotente: ON CONFLICT (canal, identificador)
// actualiza negocio_id/nombre/activo en vez de duplicar o fallar.

import 'dotenv/config';
import { pool } from '../src/services/database.js';

function argOrEnv(nombre) {
  const argPrefix = `${nombre}=`;
  const arg = process.argv.slice(2).find(a => a.startsWith(argPrefix));
  if (arg) return arg.slice(argPrefix.length);
  return process.env[nombre];
}

function abortar(msg) {
  console.error(`[seed-integracion-canal] ❌ ${msg}`);
  process.exit(1);
}

const canal = (argOrEnv('CANAL') || '').trim().toLowerCase();
const negocioSlug = (argOrEnv('NEGOCIO_SLUG') || '').trim();
const nombreIntegracion = argOrEnv('NOMBRE') || null;
const dbUrl = process.env.DATABASE_URL;
const permitirHostRemoto = process.env.PERMITIR_HOST_REMOTO === 'si';

// El identificador NO es un secreto (ver comentario de cabecera), pero para
// 'whatsapp' se auto-completa desde META_PHONE_NUMBER_ID -- ya vive en el
// entorno del servicio via `railway run`, así que nunca hay que copiarlo/
// pegarlo a mano ni pasarlo por la terminal del operador.
let identificador = argOrEnv('IDENTIFICADOR');
if (!identificador && canal === 'whatsapp') identificador = process.env.META_PHONE_NUMBER_ID;
identificador = (identificador || '').trim();

if (!['whatsapp', 'voz'].includes(canal)) abortar("CANAL debe ser 'whatsapp' o 'voz'.");
if (!identificador) abortar(`Falta IDENTIFICADOR (para 'whatsapp' se puede omitir si META_PHONE_NUMBER_ID ya está en el entorno).`);
if (!negocioSlug) abortar('Falta NEGOCIO_SLUG (ej. nonna-maye).');
if (!dbUrl) abortar('Falta DATABASE_URL.');

const pareceProduccion = /railway\.app|rlwy\.net|proxy\.rlwy/i.test(dbUrl);
if (pareceProduccion && !permitirHostRemoto) {
  abortar(
    'DATABASE_URL parece apuntar a un host de Railway/producción. ' +
    'Vuelve a ejecutar con PERMITIR_HOST_REMOTO=si si de verdad quieres continuar ahí.'
  );
}

try {
  const { rows: negocios } = await pool.query('SELECT id, nombre, slug FROM negocios WHERE slug = $1', [negocioSlug]);
  const negocio = negocios[0];
  if (!negocio) abortar(`No existe ningún negocio con slug '${negocioSlug}'. No se creó nada.`);

  // Guarda de conflicto: si (canal, identificador) YA pertenece a OTRO
  // negocio, detenerse -- nunca reasignar en silencio un identificador que
  // ya está mapeado a alguien más (idempotente solo cuando el dueño ya
  // coincide; conflicto real con otro negocio es un abortar, no un
  // sobrescribir).
  const { rows: existentes } = await pool.query(
    'SELECT ic.negocio_id, n.slug AS negocio_slug FROM integraciones_canal ic JOIN negocios n ON n.id = ic.negocio_id WHERE ic.canal = $1 AND ic.identificador = $2',
    [canal, identificador]
  );
  if (existentes[0] && existentes[0].negocio_id !== negocio.id) {
    abortar(`Conflicto: canal='${canal}' identificador='${identificador.slice(0,3)}***${identificador.slice(-2)}' ya está mapeado a otro negocio ('${existentes[0].negocio_slug}'). No se modificó nada -- resuélvelo manualmente antes de reintentar.`);
  }

  const { rows: resultado } = await pool.query(
    `INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre, activo)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (canal, identificador) DO UPDATE SET
       negocio_id = $1, nombre = COALESCE($4, integraciones_canal.nombre), activo = true
     RETURNING id, (xmax = 0) AS fue_insertado`,
    [negocio.id, canal, identificador, nombreIntegracion]
  );
  const fila = resultado[0];

  console.log(`[seed-integracion-canal] ✅ ${fila.fue_insertado ? 'Registrado' : 'Actualizado'}: canal='${canal}' identificador='${identificador}' → negocio='${negocio.nombre}' (${negocio.slug}, id=${negocio.id})`);
  console.log(`[seed-integracion-canal] integracionId=${fila.id}`);
} catch (e) {
  abortar(e.message);
} finally {
  await pool.end();
}
