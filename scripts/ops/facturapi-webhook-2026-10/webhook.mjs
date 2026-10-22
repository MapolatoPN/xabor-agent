// Aviso (webhook) de Facturapi sobre los recibos de cada negocio.
//
//   node scripts/ops/facturapi-webhook-2026-10/webhook.mjs estado [--remoto]
//   node scripts/ops/facturapi-webhook-2026-10/webhook.mjs registrar --negocio=<slug> [--url-base=https://xabor.mx] [--aplicar]
//   node scripts/ops/facturapi-webhook-2026-10/webhook.mjs pausar    --negocio=<slug> [--aplicar]
//   node scripts/ops/facturapi-webhook-2026-10/webhook.mjs reanudar  --negocio=<slug> [--aplicar]
//   node scripts/ops/facturapi-webhook-2026-10/webhook.mjs retirar   --negocio=<slug> [--aplicar]
//
// SIMULACRO por omisión: dice qué haría y no escribe ni en la base ni en
// Facturapi. Con --aplicar:
//   - registrar: crea el webhook en la organización de Facturapi del negocio
//     (POST /webhooks, solo `receipt.status_updated`) con la URL
//     <url-base>/webhook/facturapi/<token> y guarda su secreto cifrado. Si un
//     registro anterior se cortó a medias, adopta el webhook que ya tenga esa
//     URL en vez de crear otro. Desde ahí el barrido deja de consultar uno por
//     uno los recibos abiertos de ese negocio (facturapiWebhook.js).
//   - pausar: el barrido vuelve a consultar como antes; los avisos se acusan y
//     no se aplican. Solo base. `reanudar` lo deshace.
//   - retirar: borra el webhook en Facturapi (DELETE /webhooks/:id) y lo marca
//     'retirado'. Para volver: registrar de nuevo.
// Antes de escribir guarda la fila anterior (sin secreto) en --respaldo=<dir>
// (por omisión C:/xabor-respaldos/facturapi-webhook-2026-10).
//
// Necesita DATABASE_URL e INTEGRATIONS_ENCRYPTION_KEY (la de la app: descifra
// la llave de Facturapi y cifra el secreto). Ni la llave, ni el secreto, ni el
// token completo se imprimen. Con una base local exige FACTURAPI_BASE_URL (un
// Facturapi simulado); con una remota la prohíbe.
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cifrarSecretoIntegracion, descifrarSecretoIntegracion } from '../../../src/services/cifradoIntegraciones.js';

const argv = process.argv.slice(2);
const valor = (k) => (argv.find(a => a.startsWith(`--${k}=`)) || '').slice(k.length + 3);
const comando = argv.find(a => !a.startsWith('--')) || 'estado';
const aplicar = argv.includes('--aplicar');
const remoto = argv.includes('--remoto');
const slug = valor('negocio').trim();
const urlBase = (valor('url-base') || 'https://xabor.mx').replace(/\/+$/, '');
const dirRespaldo = valor('respaldo') || 'C:/xabor-respaldos/facturapi-webhook-2026-10';
const EVENTOS = ['receipt.status_updated'];

function salir(mensaje, codigo = 1) { console.error(mensaje); process.exit(codigo); }

if (!['estado', 'registrar', 'pausar', 'reanudar', 'retirar'].includes(comando)) {
  salir(`Comando desconocido: ${comando}. Usa estado | registrar | pausar | reanudar | retirar`, 2);
}
if (comando !== 'estado' && !slug) salir(`${comando} necesita --negocio=<slug>`, 2);
if (!process.env.DATABASE_URL) salir('DATABASE_URL requerida', 2);
if (!/^https:\/\/[^/]+$/.test(urlBase) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(urlBase)) {
  salir(`--url-base debe ser https://<dominio> sin ruta (llegó ${urlBase})`, 2);
}

const host = new URL(process.env.DATABASE_URL).hostname;
const local = ['localhost', '127.0.0.1', '::1'].includes(host);
const baseSimulada = process.env.FACTURAPI_BASE_URL || '';
const usaFacturapi = comando === 'registrar' || comando === 'retirar' || (comando === 'estado' && remoto);
if (usaFacturapi && local && !baseSimulada) salir('Base local: define FACTURAPI_BASE_URL (Facturapi simulado). No se llama al Facturapi real desde una base de pruebas.', 2);
if (usaFacturapi && !local && baseSimulada) salir('Base remota con FACTURAPI_BASE_URL definido: quítalo para usar el Facturapi real.', 2);
const API = baseSimulada || 'https://www.facturapi.io/v2';
console.log(`[facturapi-webhook] base: ${host}${local ? ' (local)' : ''} · ${comando}${aplicar ? ' --aplicar' : ' (simulacro)'}`);

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false } });
await c.connect();

const enmascarar = (texto) => String(texto || '').replace(/\/webhook\/facturapi\/([a-f0-9]{6})[a-f0-9]+/g, '/webhook/facturapi/$1…');
const sinSecreto = (f) => f && Object.fromEntries(Object.entries(f).filter(([k]) => !k.startsWith('secreto_')));

async function negocioPorSlug(s) {
  const { rows: [n] } = await c.query('SELECT id, slug, nombre FROM negocios WHERE slug=$1', [s]);
  if (!n) throw new Error(`No existe el negocio ${s}`);
  return n;
}

async function filaDe(negocioId) {
  const { rows: [f] } = await c.query('SELECT * FROM facturapi_webhooks WHERE negocio_id=$1', [negocioId]);
  return f || null;
}

async function llaveFacturapi(negocioId) {
  const { rows: [r] } = await c.query(
    `SELECT ic.estado, cc.access_token_cifrado, cc.token_iv, cc.token_auth_tag, cc.token_formato_version
       FROM integraciones_canal ic JOIN integraciones_canal_credenciales cc ON cc.integracion_id = ic.id
      WHERE ic.negocio_id=$1 AND ic.canal='facturacion' AND ic.proveedor='facturapi'`, [negocioId]);
  if (!r) throw new Error('El negocio no tiene llave de Facturapi');
  if (r.estado !== 'activo') throw new Error(`La integración de Facturapi está '${r.estado}' (¿freno puesto?)`);
  const { apiKey } = JSON.parse(descifrarSecretoIntegracion({
    cifrado: r.access_token_cifrado, iv: r.token_iv, authTag: r.token_auth_tag, version: r.token_formato_version,
  }));
  if (!apiKey) throw new Error('La llave de Facturapi está vacía');
  return apiKey;
}

async function api(apiKey, method, path, body) {
  const resp = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Accept-Language': 'es' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw Object.assign(new Error(`Facturapi respondió ${resp.status}: ${json?.message || 'sin detalle'}`), { status: resp.status });
  return json;
}

function guardarRespaldo(nombre, datos) {
  mkdirSync(dirRespaldo, { recursive: true });
  const ruta = join(dirRespaldo, `${nombre}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(ruta, JSON.stringify(datos, null, 2));
  return ruta;
}

async function webhooksRemotos(apiKey) {
  const lista = await api(apiKey, 'GET', '/webhooks?limit=100');
  return Array.isArray(lista?.data) ? lista.data : [];
}

async function estado() {
  const { rows } = await c.query(
    `SELECT n.id, n.slug, ic.estado AS integracion, w.estado AS webhook, w.webhook_id, w.livemode,
            w.routing_token, w.ultimo_evento_at, w.respaldo_completado_at, w.respaldo_pagina,
            (SELECT json_object_agg(resultado, n) FROM (
               SELECT resultado, count(*)::int n FROM facturapi_webhook_eventos e
                WHERE e.negocio_id = n.id AND e.recibido_at > NOW() - INTERVAL '7 days' GROUP BY resultado) x) AS eventos_7d
       FROM integraciones_canal ic
       JOIN negocios n ON n.id = ic.negocio_id
       LEFT JOIN facturapi_webhooks w ON w.negocio_id = n.id
      WHERE ic.canal='facturacion' AND ic.proveedor='facturapi' AND ($1 = '' OR n.slug = $1)
      ORDER BY n.slug`, [slug]);
  console.table(rows.map(({ id, routing_token: _t, eventos_7d, ...r }) => ({ ...r, eventos_7d: JSON.stringify(eventos_7d || {}) })));
  if (!remoto) return;
  for (const r of rows) {
    if (r.integracion !== 'activo') continue;
    try {
      const lista = await webhooksRemotos(await llaveFacturapi(r.id));
      console.log(`\n${r.slug}: ${lista.length} webhook(s) en Facturapi`);
      for (const w of lista) {
        const nuestro = r.routing_token && String(w.url || '').endsWith(`/webhook/facturapi/${r.routing_token}`);
        console.log(`  ${w.id} · ${w.status} · ${JSON.stringify(w.enabled_events)} · ${enmascarar(w.url)}${nuestro ? ' · ES EL DE XABOR' : ''}`);
      }
    } catch (e) { console.log(`\n${r.slug}: no se pudo consultar Facturapi (${e.message})`); }
  }
}

async function registrar() {
  const n = await negocioPorSlug(slug);
  const actual = await filaDe(n.id);
  if (actual && ['activo', 'pausado'].includes(actual.estado)) {
    salir(`${slug} ya tiene webhook (${actual.estado}, ${actual.webhook_id}). Para cambiarlo: retirar y registrar.`);
  }
  const apiKey = await llaveFacturapi(n.id);
  const token = actual?.estado === 'registrando' ? actual.routing_token : randomBytes(24).toString('hex');
  const url = `${urlBase}/webhook/facturapi/${token}`;
  console.log(`Negocio: ${n.nombre} (${slug})`);
  console.log(`Ambiente de la llave: ${apiKey.startsWith('sk_live_') ? 'live' : apiKey.startsWith('sk_test_') ? 'test' : 'desconocido'}`);
  console.log(`URL: ${enmascarar(url)}`);
  console.log(`Eventos: ${EVENTOS.join(', ')}`);
  if (!aplicar) {
    console.log('\nSIMULACRO: no se escribió nada (ni en la base ni en Facturapi). Repite con --aplicar.');
    return;
  }
  console.log(`Respaldo: ${guardarRespaldo(`registrar-${slug}`, { negocio: slug, antes: sinSecreto(actual) })}`);
  // El token queda en la base ANTES de crear el webhook: si algo se corta
  // después, el registro se repite y adopta el webhook con esta URL.
  if (actual?.estado !== 'registrando') {
    await c.query(
      `INSERT INTO facturapi_webhooks (negocio_id, routing_token, estado) VALUES ($1,$2,'registrando')
       ON CONFLICT (negocio_id) DO UPDATE SET routing_token=$2, estado='registrando', webhook_id=NULL,
         organizacion_id=NULL, livemode=NULL, secreto_cifrado=NULL, secreto_iv=NULL, secreto_auth_tag=NULL,
         secreto_formato_version=NULL, respaldo_desde=NULL, respaldo_pagina=NULL, respaldo_completado_at=NULL,
         updated_at=NOW()`, [n.id, token]);
  }
  const previo = (await webhooksRemotos(apiKey)).find(w => w.url === url);
  const wh = previo
    ? await api(apiKey, 'GET', `/webhooks/${encodeURIComponent(previo.id)}`)
    : await api(apiKey, 'POST', '/webhooks', { url, enabled_events: EVENTOS });
  if (previo) console.log(`Ya existía en Facturapi un webhook con esta URL (${previo.id}): se adopta.`);
  if (!wh?.id || typeof wh.secret !== 'string' || !wh.secret || typeof wh.organization !== 'string' || typeof wh.livemode !== 'boolean') {
    throw new Error(`Facturapi no devolvió id, secret, organization y livemode (webhook ${wh?.id || '?'}); la fila queda 'registrando' y se puede repetir`);
  }
  const s = cifrarSecretoIntegracion(wh.secret);
  const { rowCount } = await c.query(
    `UPDATE facturapi_webhooks SET estado='activo', webhook_id=$3, organizacion_id=$4, livemode=$5,
       secreto_cifrado=$6, secreto_iv=$7, secreto_auth_tag=$8, secreto_formato_version=$9, updated_at=NOW()
      WHERE negocio_id=$1 AND routing_token=$2 AND estado='registrando'`,
    [n.id, token, wh.id, wh.organization, wh.livemode, s.cifrado, s.iv, s.authTag, s.version]);
  if (!rowCount) throw new Error(`El webhook ${wh.id} quedó creado en Facturapi pero la fila cambió mientras tanto; corre «estado --remoto» y retíralo si sobra`);
  console.log(`\nRegistrado: webhook ${wh.id} (${wh.status}, ${wh.livemode ? 'live' : 'test'}).`);
  if (wh.status !== 'enabled') console.log(`OJO: Facturapi lo reporta '${wh.status}', no 'enabled'.`);
  console.log(`Reversa: node scripts/ops/facturapi-webhook-2026-10/webhook.mjs retirar --negocio=${slug} --aplicar`);
}

async function cambiarEstado(desde, hacia) {
  const n = await negocioPorSlug(slug);
  const actual = await filaDe(n.id);
  if (actual?.estado !== desde) salir(`${slug}: el webhook está '${actual?.estado || 'sin registrar'}', no '${desde}'.`);
  console.log(`${slug}: ${desde} → ${hacia}`);
  if (!aplicar) { console.log('SIMULACRO: no se escribió nada. Repite con --aplicar.'); return; }
  console.log(`Respaldo: ${guardarRespaldo(`${comando}-${slug}`, { negocio: slug, antes: sinSecreto(actual) })}`);
  await c.query(`UPDATE facturapi_webhooks SET estado=$2, updated_at=NOW() WHERE negocio_id=$1 AND estado=$3`, [n.id, hacia, desde]);
  console.log(`Hecho. Reversa: node scripts/ops/facturapi-webhook-2026-10/webhook.mjs ${hacia === 'pausado' ? 'reanudar' : 'pausar'} --negocio=${slug} --aplicar`);
}

async function retirar() {
  const n = await negocioPorSlug(slug);
  const actual = await filaDe(n.id);
  if (!actual || actual.estado === 'retirado') salir(`${slug}: no hay webhook que retirar.`);
  const apiKey = await llaveFacturapi(n.id);
  const url = `${urlBase}/webhook/facturapi/${actual.routing_token}`;
  const id = actual.webhook_id || (await webhooksRemotos(apiKey)).find(w => w.url === url)?.id || null;
  console.log(`${slug}: ${actual.estado} → retirado; webhook en Facturapi: ${id || 'ninguno'}`);
  if (!aplicar) { console.log('SIMULACRO: no se escribió nada. Repite con --aplicar.'); return; }
  console.log(`Respaldo: ${guardarRespaldo(`retirar-${slug}`, { negocio: slug, antes: sinSecreto(actual) })}`);
  if (id) {
    try { await api(apiKey, 'DELETE', `/webhooks/${encodeURIComponent(id)}`); }
    catch (e) { if (e.status !== 404) throw e; console.log('Facturapi ya no lo tenía (404).'); }
  }
  await c.query(
    `UPDATE facturapi_webhooks SET estado='retirado', secreto_cifrado=NULL, secreto_iv=NULL, secreto_auth_tag=NULL,
       secreto_formato_version=NULL, respaldo_desde=NULL, respaldo_pagina=NULL, updated_at=NOW()
      WHERE negocio_id=$1`, [n.id]);
  console.log('Retirado. El barrido vuelve a consultar los recibos abiertos de este negocio como antes.');
}

try {
  if (comando === 'estado') await estado();
  else if (comando === 'registrar') await registrar();
  else if (comando === 'pausar') await cambiarEstado('activo', 'pausado');
  else if (comando === 'reanudar') await cambiarEstado('pausado', 'activo');
  else await retirar();
} catch (e) {
  console.error(`FALLO: ${e.message}`);
  process.exitCode = 1;
} finally {
  await c.end().catch(() => {});
}
