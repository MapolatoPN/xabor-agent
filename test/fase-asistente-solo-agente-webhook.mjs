import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { pool, actualizarConfiguracion } from '../src/services/database.js';
import { prepararNegocioBotones, exigirBaseBotonesLocal } from './lib-botones-local.mjs';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';

exigirBaseBotonesLocal();
let srv, meta, modelo;
const secreto = 'asistente-webhook-local';
try {
  const fuera = await prepararNegocioBotones(), apagado = await prepararNegocioBotones();
  await actualizarConfiguracion({ mesero_agente_telefonos: '528780000001' }, fuera.negocioId);
  await actualizarConfiguracion({ mesero_agente_v1: 'false', mesero_whatsapp_v1: 'true', pedido_reconciliador_v2: 'true' }, apagado.negocioId);
  meta = await arrancarMetaMock(); modelo = await arrancarAnthropicMock();
  modelo.encolarRespuesta('Esta respuesta del motor anterior nunca debe salir');
  srv = await arrancarServidor({ PORT: '55974', META_GRAPH_BASE_URL: meta.baseUrl, ANTHROPIC_BASE_URL: modelo.baseUrl,
    ANTHROPIC_API_KEY: 'local-test', META_APP_SECRET: secreto, MESERO_AGENTE_MODE: 'true' }, { timeoutMs: 30000 });
  for (const [nombre, f] of [['fuera del piloto', fuera], ['bandera antigua encendida y nueva apagada', apagado]]) {
    const wamid = `wamid.ASISTENTE-${f.marca}`;
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: f.marca }, contacts: [{ wa_id: f.telefono, profile: { name: 'QA local' } }],
      messages: [{ id: wamid, from: f.telefono, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Quiero dos cafés' } }],
    } }] }] });
    const r = await fetch(srv.base + '/webhook/whatsapp', { method: 'POST', body, headers: { 'Content-Type': 'application/json',
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', secreto).update(body).digest('hex')}` } });
    assert.equal(r.status, 200);
    let revision;
    const fin = Date.now() + 20000;
    while (Date.now() < fin) {
      revision = (await pool.query('SELECT requiere_revision,motivo FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2', [f.negocioId, f.telefono])).rows[0];
      if (revision?.requiere_revision) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(revision?.requiere_revision, true, nombre + ': debe pasar al personal');
    assert.equal(revision.motivo, 'AGENTE_FUERA_DE_ALCANCE');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM pedidos_activos WHERE negocio_id=$1', [f.negocioId])).rows[0].n, 0);
    console.log(`OK webhook local: ${nombre}, revisión humana durable sin pedido.`);
  }
  assert.equal(modelo.pendientes(), 1, 'se llamó a un modelo fuera del alcance nuevo');
  const clientes = new Set([fuera.telefono, apagado.telefono]);
  const respuestas = meta.obtenerMensajesEnviados().filter(m => clientes.has(m.to) && m.status !== 'read');
  assert.equal(respuestas.length, 0, 'no debe responder el motor anterior ni inventar un acuse');
  console.log('OK webhook local: ninguna llamada a IA, ninguna respuesta automática, ninguna impresora/proveedor real.');
} finally { srv?.detener(); modelo?.detener(); meta?.detener(); await pool.end(); }
