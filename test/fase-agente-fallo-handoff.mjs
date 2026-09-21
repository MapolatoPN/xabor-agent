// ─── FALLA DEL AGENTE: PAUSA Y REVISIÓN HUMANA ─────────────────────────────
// Contrato de seguridad del canal: un fallo del agente nuevo no puede volver
// a ejecutar el mismo mensaje con brain.js/legacy, porque ese camino es el
// comportamiento que este despliegue está reemplazando.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const canal = readFileSync(new URL('../src/channels/whatsapp-meta.js', import.meta.url), 'utf8');
const inicio = canal.indexOf('// ── EL AGENTE DE HERRAMIENTAS');
const fin = canal.indexOf('// Si Claude tarda más de 8s', inicio);
assert.ok(inicio >= 0 && fin > inicio, 'no se encontró el bloque de enrutamiento del agente');
const bloque = canal.slice(inicio, fin);

assert.match(bloque, /await pasarAgenteARevision\(/, 'un fallo del agente debe mandar la conversación a revisión');
assert.match(bloque, /pasa a revisión humana/, 'el catch del agente debe describir el handoff');
assert.match(bloque, /respuestaEnviada = true/, 'un turno sin respuesta enviada no puede darse por atendido');
assert.ok((bloque.match(/\breturn;/g) || []).length >= 2, 'los caminos de fallo deben cortar antes de legacy');
assert.doesNotMatch(bloque, /sigue el bot de siempre/, 'el agente no puede degradar al bot legacy');
assert.match(canal, /AGENTE_NO_PUDO_ATENDER/, 'el motivo de revisión debe quedar trazado');

console.log('Fallo del agente: pausa humana, 5 invariantes pasadas, 0 fallidas.');
