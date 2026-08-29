import { readFileSync } from 'fs';
import assert from 'assert';

const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8');
const casos = [
  ['control móvil visible', /id="chat-atencion-estado"/],
  ['acción tomar conversación', /Tomar conversación/],
  ['acción devolver al bot', /Devolver al bot/],
  // Rediseño UX mensajería (sprint ux-chats-mobile): los textos de estado se
  // reescribieron para distinguir claramente el bot GLOBAL del negocio de la
  // pausa por-conversación (ver fase-chats-mobile-ux). Se conserva la
  // intención de cada control, con el copy nuevo.
  ['estado automático (bot atendiendo)', /'Bot atendiendo'/],
  ['estado humano (atención manual)', /Estás atendiendo esta conversación/],
  ['prioridad de pausa general', /!atencionNegocioActiva[\s\S]{0,400}Automatización pausada en el negocio/],
  ['aviso de bot pausado en la bandeja', /Atención automática pausada/],
  ['error inline sin alert bloqueante', /mostrarErrorChat\(data\.error/],
  ['operador consulta estado general', /apiFetch\('\/api\/bot-whatsapp'\)/],
];
for (const [nombre, patron] of casos) {
  assert.match(html, patron, nombre);
  console.log(`OK ${nombre}`);
}
assert.doesNotMatch(html, /Bot global activo|Bot global apagado/);
console.log(`\n${casos.length + 1} pasadas, 0 fallidas`);
