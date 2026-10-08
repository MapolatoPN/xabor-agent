// Genera secretos NUEVOS para la firma de los avisos de Rappi (uno por evento)
// y los deja en un archivo, nunca en pantalla.
//
//   railway run --service xabor-agent node scripts/ops/rappi-firma-2026-10/generar-secretos.mjs            (consulta)
//   railway run --service xabor-agent node scripts/ops/rappi-firma-2026-10/generar-secretos.mjs --aplicar  (genera)
//
// Sin --aplicar solo consulta cada aviso (URL, tiendas, estado). Con
// --aplicar llama a PUT webhook/{evento}/reset-secret: desde ese momento Rappi
// firma con el secreto nuevo. Los secretos quedan, separados por coma, en
// --salida=<archivo> (por omisión C:\xabor-respaldos\rappi-firma\secretos-<fecha>.txt):
// ese texto es el valor de RAPPI_WEBHOOK_SECRET en Railway. Con
// RAPPI_WEBHOOK_FIRMA en «registrar» nada se rechaza mientras tanto.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { obtenerWebhook, reiniciarSecretoWebhook } from '../../../src/services/rappi-api.js';

const args = process.argv.slice(2);
const aplicar = args.includes('--aplicar');
const valor = (k) => (args.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3);
const EVENTOS = (valor('eventos') || 'NEW_ORDER,ORDER_EVENT_CANCEL,PING,MENU_APPROVED,MENU_REJECTED')
  .split(',').map((s) => s.trim()).filter(Boolean);
const salida = valor('salida') || `C:/xabor-respaldos/rappi-firma/secretos-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;

const registrados = [];
for (const evento of EVENTOS) {
  const w = await obtenerWebhook(evento).catch((e) => ({ error: e.message.slice(0, 120) }));
  if (!w) { console.log(`${evento}: no registrado`); continue; }
  if (w.error) { console.log(`${evento}: error al consultar (${w.error})`); continue; }
  // Rappi responde una lista: [{ event, stores: [{ store_id, url, state }] }].
  const tiendas = (Array.isArray(w) ? w : [w]).flatMap((x) => x?.stores || x?.data || []);
  if (!tiendas.length) { console.log(`${evento}: sin tiendas registradas`); continue; }
  const urls = [...new Set(tiendas.map((s) => s.url).filter(Boolean))];
  console.log(`${evento}: ${tiendas.length} tienda(s) (${tiendas.map((s) => `${s.store_id} ${s.state}`).join(', ')}), url ${urls.join(', ')}`);
  registrados.push(evento);
}

if (!aplicar) {
  console.log(`\nCONSULTA: nada cambió. Con --aplicar se generan secretos nuevos para: ${registrados.join(', ') || '(ninguno)'}`);
  process.exit(0);
}
if (!registrados.length) { console.error('No hay avisos registrados: no se genera nada.'); process.exit(1); }

const secretos = [];
for (const evento of registrados) {
  try {
    const r = await reiniciarSecretoWebhook(evento);
    if (typeof r?.secret !== 'string' || !r.secret) throw new Error('Rappi no devolvió un secreto');
    secretos.push(r.secret);
    console.log(`${evento}: secreto nuevo …${r.secret.slice(-4)}`);
  } catch (e) {
    console.error(`${evento}: NO se generó (${String(e.message).slice(0, 120)})`);
  }
}
if (!secretos.length) { console.error('No se generó ningún secreto.'); process.exit(1); }
mkdirSync(dirname(salida), { recursive: true });
writeFileSync(salida, secretos.join(','), { mode: 0o600 });
console.log(`\n${secretos.length} secreto(s) en ${salida}. Ese texto es RAPPI_WEBHOOK_SECRET en Railway.`);
