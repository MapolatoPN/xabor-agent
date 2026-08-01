import { readFileSync } from 'fs';
import assert from 'assert';

const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8');
const casos = [
  ['control móvil visible', /id="chat-atencion-estado"/],
  ['acción tomar conversación', /Tomar conversación/],
  ['acción devolver al bot', /Devolver al bot/],
  ['estado automático', /'Atención automática'/],
  ['estado humano', /'Atención humana'/],
  ['prioridad de pausa general', /!atencionNegocioActiva[\s\S]{0,120}Atención automática pausada en todo el negocio/],
  ['aviso persistente en bandeja', /La atención automática del negocio está pausada/],
  ['error inline sin alert bloqueante', /mostrarErrorChat\(data\.error/],
  ['operador consulta estado general', /apiFetch\('\/api\/bot-whatsapp'\)/],
];
for (const [nombre, patron] of casos) {
  assert.match(html, patron, nombre);
  console.log(`OK ${nombre}`);
}
assert.doesNotMatch(html, /Bot global activo|Bot global apagado/);
console.log(`\n${casos.length + 1} pasadas, 0 fallidas`);
