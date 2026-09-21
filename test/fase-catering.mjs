import assert from 'node:assert/strict';
import { esSolicitudCatering } from '../src/agent/catering.js';
import { camposObligatoriosCompletos } from '../src/agent/comercialMarkers.js';
import { construirBloqueModoComercial } from '../src/agent/prompts.js';

const completos = {
  nombre: 'Ana', numero_personas: '40', lugar: 'Jardín', fecha_evento_iso: '2026-10-15',
};
assert.equal(esSolicitudCatering('Quiero cotización para un evento de 40 personas'), true);
assert.equal(esSolicitudCatering('Necesito mesa de postres para una boda'), true);
assert.equal(esSolicitudCatering('Manejamos catering'), true);
assert.equal(esSolicitudCatering('Quiero ordenar chilaquiles'), false);
assert.equal(esSolicitudCatering('20 personas'), false);
assert.equal(camposObligatoriosCompletos(completos, { perfil: 'catering' }), true);
assert.equal(camposObligatoriosCompletos({ ...completos, lugar: '' }, { perfil: 'catering' }), false);
const prompt = construirBloqueModoComercial({}, { perfil: 'catering' });
assert.match(prompt, /No uses ni menciones platillos/i);
assert.match(prompt, /número de invitados/i);
assert.match(prompt, /<BORRADOR_LISTO>/);
console.log('Catering: 8 invariantes pasadas, 0 fallidas.');
