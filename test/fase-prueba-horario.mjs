import assert from 'node:assert/strict';
import { estadoParaPruebaDeHorario, CLAVE_PRUEBA_HORARIO } from '../src/mesero-agente/pruebaDeHorario.js';
const cerrado = {abierto:false,preApertura:true,fechaHoy:'2026-10-09'};
const prueba = {negocioId:'acuna',telefono:'528787899919',inicio:'2026-10-09T23:00:00Z',hasta:'2026-10-10T01:00:00Z'};
const base = {estadoRestaurante:cerrado,cfg:{bot_whatsapp_solo_prueba:'true',
  mesero_agente_telefonos:'528787899919,5218787899919',[CLAVE_PRUEBA_HORARIO]:JSON.stringify(prueba)},
  ia:{modo:'formulario',alcance:'prueba',completo:true},negocioId:'acuna',telefono:prueba.telefono,
  canal:'whatsapp',ahora:new Date('2026-10-10T00:00:00Z')};
for (const telefono of [prueba.telefono,'5218787899919','8787899919']) {
  const estado = estadoParaPruebaDeHorario({...base,telefono});
  assert.equal(estado.abierto,true);assert.equal(estado.preApertura,false);
}
const rechazar = (cambios) => assert.strictEqual(estadoParaPruebaDeHorario({...base,...cambios}),cerrado);
for (const cambios of [
  {negocioId:'obispado'},{telefono:'528780000000'},{telefono:null},{canal:'web'},
  {ia:null},{ia:{...base.ia,completo:false}},{ia:{...base.ia,alcance:'todos'}},
  {ia:{...base.ia,modo:'recepcionista'}},{cfg:{...base.cfg,bot_whatsapp_solo_prueba:'false'}},
  {cfg:{...base.cfg,mesero_agente_telefonos:''}},
  {cfg:{...base.cfg,[CLAVE_PRUEBA_HORARIO]:'{'}},
  {cfg:{...base.cfg,[CLAVE_PRUEBA_HORARIO]:''}},
  {ahora:new Date(prueba.hasta)},{ahora:new Date('2026-10-09T22:59:59Z')},{ahora:new Date(NaN)},
]) rechazar(cambios);
for (const cambios of [{hasta:'2026-10-10T01:00:01Z'},{inicio:'invalido'},
  {hasta:prueba.inicio},{telefono:''},{negocioId:'obispado'}]) {
  rechazar({cfg:{...base.cfg,[CLAVE_PRUEBA_HORARIO]:JSON.stringify({...prueba,...cambios})}});
}
const abierto={abierto:true};assert.strictEqual(estadoParaPruebaDeHorario({...base,estadoRestaurante:abierto}),abierto);
assert.deepEqual(cerrado,{abierto:false,preApertura:true,fechaHoy:'2026-10-09'});
console.log('prueba de horario: 24 verificaciones pasadas; expiración, identidad, canal y restricciones');
