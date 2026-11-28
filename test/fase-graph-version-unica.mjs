// La versión de la Graph API de Meta sale de un solo lugar (metaVersionGraph.js).
//
// Sin base de datos ni red: las llamadas a Meta se capturan con un fetch
// falso, que nunca sale de este proceso.
//
//   node test/fase-graph-version-unica.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

delete process.env.META_GRAPH_VERSION;
delete process.env.META_EMBEDDED_SIGNUP_MOCK;
process.env.META_GRAPH_BASE_URL = 'http://127.0.0.1:9';

let fallas = 0;
const t = async (id, nombre, fn) => {
  try { await fn(); console.log(`  ✅ ${id} ${nombre}`); }
  catch (e) { fallas += 1; console.log(`  ❌ ${id} ${nombre}\n     ${e.message.split('\n').join('\n     ')}`); }
};
const conVersion = async (valor, fn) => {
  const antes = process.env.META_GRAPH_VERSION;
  if (valor === undefined) delete process.env.META_GRAPH_VERSION; else process.env.META_GRAPH_VERSION = valor;
  try { return await fn(); }
  finally { if (antes === undefined) delete process.env.META_GRAPH_VERSION; else process.env.META_GRAPH_VERSION = antes; }
};

// fetch falso: guarda la URL y responde como Meta en el caso feliz.
const llamadas = [];
const fetchReal = globalThis.fetch;
globalThis.fetch = async (url, opciones = {}) => {
  const u = String(url);
  llamadas.push(u);
  const cuerpo = /\/media$/.test(new URL(u).pathname) ? { id: 'MEDIA_FALSO' }
    : /\/messages$/.test(new URL(u).pathname) ? { messages: [{ id: 'wamid.FALSO' }] }
      : { is_on_biz_app: true, platform_type: 'CLOUD_API' };
  return new Response(JSON.stringify(cuerpo), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const ultimaRuta = () => new URL(llamadas.at(-1)).pathname;

const V = await import('../src/services/metaVersionGraph.js');
const docs = await import('../src/services/metaEnvioDocumentos.js');
const es = await import('../src/services/metaEmbeddedSignup.js');
const CRED = { phoneNumberId: 'PNID_PRUEBA', accessToken: 'TOKEN_DE_PRUEBA' };

console.log('\nfase-graph-version-unica');

await t('V1', 'por omisión es v25.0', () => conVersion(undefined, () => {
  assert.equal(V.GRAPH_VERSION_POR_OMISION, 'v25.0');
  assert.equal(V.versionGraph(), 'v25.0');
  assert.equal(V.versionGraphIgnorada(), false);
}));

await t('V2', 'META_GRAPH_VERSION elige la versión (v20.0 = reversa exacta a lo de antes)', async () => {
  await conVersion('v20.0', () => assert.equal(V.versionGraph(), 'v20.0'));
  await conVersion('v27.0', () => assert.equal(V.versionGraph(), 'v27.0'));
  await conVersion('  v26.0  ', () => assert.equal(V.versionGraph(), 'v26.0'));
});

await t('V3', 'un valor sin la forma vNN.0 se ignora y cae a la de por omisión', async () => {
  for (const malo of ['v25', '25.0', 'v25.1', 'v1.0', 'v25.0/../me', 'v25.0?x=1', 'latest']) {
    await conVersion(malo, () => {
      assert.equal(V.versionGraph(), 'v25.0', malo);
      assert.equal(V.versionGraphIgnorada(), true, malo);
    });
  }
  await conVersion('', () => assert.equal(V.versionGraphIgnorada(), false));
});

await t('V4', 'el envío de documentos usa la versión, leída en cada llamada', async () => {
  llamadas.length = 0;
  await conVersion(undefined, () => docs.enviarDocumento('5215550000000', Buffer.from('%PDF'), 'a.pdf', '', CRED));
  assert.deepEqual(llamadas.map((u) => new URL(u).pathname),
    ['/v25.0/PNID_PRUEBA/media', '/v25.0/PNID_PRUEBA/messages']);
  await conVersion('v20.0', () => docs.enviarDocumento('5215550000000', Buffer.from('%PDF'), 'a.pdf', '', CRED));
  assert.equal(ultimaRuta(), '/v20.0/PNID_PRUEBA/messages');
});

await t('V5', 'Embedded Signup consulta a graph.facebook.com con la versión', async () => {
  llamadas.length = 0;
  const r = await conVersion(undefined, () => es.verificarModoNumero('PNID_PRUEBA', 'TOKEN_DE_PRUEBA'));
  assert.equal(r.ok, true);
  assert.ok(llamadas.at(-1).startsWith('https://graph.facebook.com/v25.0/PNID_PRUEBA?'), llamadas.at(-1));
  await conVersion('v20.0', () => es.verificarModoNumero('PNID_PRUEBA', 'TOKEN_DE_PRUEBA'));
  assert.ok(llamadas.at(-1).startsWith('https://graph.facebook.com/v20.0/'), llamadas.at(-1));
});

await t('V6', 'el panel recibe la misma versión para el SDK de Facebook (dos rutas de configuración)', () => {
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.equal(server.split('graphApiVersion: versionGraph()').length - 1, 2);
  assert.ok(!/\bGRAPH_VERSION\b(?!_)/.test(server), 'server.js todavía usa GRAPH_VERSION');
});

await t('V7', 'el arranque deja en el log qué versión usa el proceso', () => {
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(server, /console\.log\(`\[Startup\] Graph API de Meta: \$\{versionGraph\(\)\}/);
});

await t('V8', 'whatsapp-meta.js arma sus 8 URLs con versionGraph()', () => {
  const wa = readFileSync(new URL('../src/channels/whatsapp-meta.js', import.meta.url), 'utf8');
  assert.equal(wa.split('${META_GRAPH_BASE_URL}/${versionGraph()}/').length - 1, 8);
  assert.match(wa, /import \{ versionGraph \} from '\.\.\/services\/metaVersionGraph\.js';/);
});

await t('V9', 'la barrera del predeploy pasa y está conectada al predeploy', async () => {
  await import('../scripts/check-graph-version-unica.mjs');
  const pre = readFileSync(new URL('../scripts/predeploy-check-incidentes.mjs', import.meta.url), 'utf8');
  assert.match(pre, /^await import\('\.\/check-graph-version-unica\.mjs'\);$/m);
});

globalThis.fetch = fetchReal;
console.log(fallas ? `\n❌ ${fallas} falla(s)` : '\n✅ fase-graph-version-unica: todo en verde');
process.exit(fallas ? 1 : 0);
