// Operación administrativa explícita, no test. Solo añade el campo flows a
// la app compartida autorizada; no envía mensajes ni modifica la conversación.
import assert from 'node:assert/strict';
import { credencialFlows, clienteMetaFlows } from './lib-meta-flows.mjs';

const [modo] = process.argv.slice(2);
assert(['verificar', 'activar'].includes(modo), 'Indica verificar o activar');
const appId = '4005577379739305';
const negocioId = '5de544d8-9a0a-4972-9c92-fd48ff22de66';
const callback = 'https://xabor-agent-production.up.railway.app/webhook/whatsapp';
assert.equal(process.env.META_APP_ID, appId);
assert(process.env.META_APP_SECRET, 'META_APP_SECRET requerida');
const token = `${appId}|${process.env.META_APP_SECRET}`;
const api = async (method = 'GET', body) => {
  const r = await fetch(`https://graph.facebook.com/v26.0/${appId}/subscriptions`, {
    method, body, headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json();
  // No imprimir mensajes de error remotos que pudieran contener credenciales.
  assert(r.ok, `Meta HTTP ${r.status}, código ${j.error?.code}, subcódigo ${j.error?.error_subcode}`);
  return j;
};
const normalizar = subs => subs.map(s => ({ ...s,
  fields: [...(s.fields || [])].sort((a, b) => a.name.localeCompare(b.name)),
})).sort((a, b) => a.object.localeCompare(b.object));
const cred = await credencialFlows(negocioId);
assert.equal(cred.wabaId, '1566117335235289');
const apps = await clienteMetaFlows(cred.token)(`${cred.wabaId}/subscribed_apps`);
assert(apps.data.some(a => a.whatsapp_business_api_data?.id === appId));
const antes = await api();
assert(!antes.paging?.next, 'Revisar todas las suscripciones antes de operar');
const subs = antes.data.filter(s => s.object === 'whatsapp_business_account');
assert.equal(subs.length, 1);
const sub = subs[0];
assert.equal(sub.callback_url, callback);
assert.equal(sub.active, true);
for (const [name, version] of Object.entries({ messages: 'v25.0', account_update: 'v26.0',
  history: 'v26.0', smb_app_state_sync: 'v26.0', smb_message_echoes: 'v26.0' })) {
  assert.equal(sub.fields.find(f => f.name === name)?.version, version, `Cambió ${name}: revisar antes de operar`);
}
console.log(JSON.stringify({ etapa: 'antes', subscriptions: antes.data }));
if (modo === 'activar' && !sub.fields.some(f => f.name === 'flows')) {
  assert(process.env.META_VERIFY_TOKEN, 'META_VERIFY_TOKEN requerida');
  // Suscribir SOLO el campo nuevo. No reenviar los existentes con otra versión.
  const r = await api('POST', new URLSearchParams({ object: sub.object,
    callback_url: sub.callback_url, verify_token: process.env.META_VERIFY_TOKEN, fields: 'flows' }));
  assert.equal(r.success, true);
}
const despues = await api();
console.log(JSON.stringify({ etapa: 'despues', subscriptions: despues.data }));
const sinNuevoCampo = despues.data.map(s => s.object === sub.object
  ? { ...s, fields: s.fields.filter(f => f.name !== 'flows') } : s);
const anterioresSinFlows = antes.data.map(s => s.object === sub.object
  ? { ...s, fields: s.fields.filter(f => f.name !== 'flows') } : s);
assert.deepEqual(normalizar(sinNuevoCampo), normalizar(anterioresSinFlows),
  'La configuración anterior cambió: detener la activación del piloto y revisar');
if (modo === 'activar') {
  assert(despues.data.find(s => s.object === sub.object)?.fields.some(f => f.name === 'flows'));
}
console.log(JSON.stringify({ modo, camposPreviosIntactos: true, callbackIntacto: true,
  avisosFlows: despues.data.find(s => s.object === sub.object)?.fields.find(f => f.name === 'flows') || null }));
