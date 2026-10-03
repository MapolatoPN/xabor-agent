// Flujos de servicio que vencen a los 30 minutos o al cambiar el día (3-oct-2026).
// El 2-oct el formulario de factura pendiente seguía vivo al día siguiente.
// Suite pura: sin base de datos.
import assert from 'node:assert/strict';
import { estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { cicloParaTurno, flujoAbiertoVencido, limpiarFlujoVencido } from '../src/mesero-agente/cicloDelAgente.js';

let ok = 0;
const t = (nombre, fn) => { fn(); ok++; console.log('OK', nombre); };
const zona = 'America/Matamoros';
const MIN = 60 * 1000;
// _actualizadoAt llega como cadena ISO desde la base (persistenciaDelTurno).
const conFlujo = ({ hace = 10 * MIN, en = '2026-10-02T14:00:00.000Z', pendiente = { tipo: 'formulario_servicio', servicio: 'facturacion' },
  evento = null, items = [] } = {}) => {
  const e = estadoNuevo({ negocioId: 'n', conversacionId: 'agente:520000:c3' });
  e.ciclo = 3; e.pendiente = pendiente; e.evento = evento;
  e.carrito.items = items;
  e._actualizadoAt = en; e._inactividadMs = hace;
  return e;
};
const cafe = [{ lid: 'c1', id: 1, nombre: 'Café americano', cantidad: 1, modificadores: [], notas: '' }];

t('F1 a los 10 minutos el flujo sigue; a los 31 vence', () => {
  assert.equal(flujoAbiertoVencido(conFlujo({ hace: 10 * MIN }), { zona }), false);
  assert.equal(flujoAbiertoVencido(conFlujo({ hace: 31 * MIN }), { zona }), true);
});

t('F2 cambia el día en Matamoros aunque pasen pocos minutos', () => {
  // 04:50Z = 23:50 del 1-oct en Matamoros (UTC-5); 15 minutos después ya es el 2-oct.
  assert.equal(flujoAbiertoVencido(conFlujo({ en: '2026-10-02T04:50:00.000Z', hace: 15 * MIN }), { zona }), true);
  // 14:00Z + 15 min sigue siendo el mismo día local.
  assert.equal(flujoAbiertoVencido(conFlujo({ en: '2026-10-02T14:00:00.000Z', hace: 15 * MIN }), { zona }), false);
});

t('F3 solo vencen los flujos de servicio y la ficha de evento', () => {
  assert.equal(flujoAbiertoVencido(conFlujo({ hace: 40 * MIN, pendiente: { tipo: 'confirmar_resumen' } }), { zona }), false);
  assert.equal(flujoAbiertoVencido(conFlujo({ hace: 40 * MIN, pendiente: null, evento: { nombre: 'Ana' } }), { zona }), true);
  assert.equal(flujoAbiertoVencido(conFlujo({ hace: 40 * MIN, pendiente: { tipo: 'inicio_mapo' } }), { zona }), true);
  const conFolio = conFlujo({ hace: 40 * MIN }); conFolio.folio = 'XAB-1';
  assert.equal(flujoAbiertoVencido(conFolio, { zona }), false);
  const sinMarca = conFlujo({ hace: 40 * MIN }); delete sinMarca._actualizadoAt;
  assert.equal(flujoAbiertoVencido(sinMarca, { zona }), false);
});

t('F4 con la bandera apagada nada cambia', () => {
  const e = conFlujo({ hace: 40 * MIN, evento: { nombre: 'Ana' } });
  assert.equal(cicloParaTurno(e, 'hola', { zona }), e);
});

t('F5 sin carrito, un flujo vencido abre ciclo nuevo', () => {
  const e = conFlujo({ hace: 40 * MIN, evento: { nombre: 'Ana' } });
  const n = cicloParaTurno(e, 'eshola', { zona, flujosCaducan: true });
  assert.equal(n.conversacionId, 'agente:520000:c4');
  assert.equal(n.evento ?? null, null); assert.equal(n.pendiente ?? null, null);
});

t('F6 con carrito, se suelta el flujo y el pedido se queda', () => {
  const e = conFlujo({ hace: 40 * MIN, items: cafe });
  const n = cicloParaTurno(e, 'hola', { zona, flujosCaducan: true });
  assert.equal(n.conversacionId, e.conversacionId);
  assert.equal(n.pendiente, null); assert.equal(n.evento, null);
  assert.deepEqual(n.carrito.items, cafe);
});

t('F7 limpiarFlujoVencido no toca un flujo vigente ni un pedido sin flujo', () => {
  const vigente = conFlujo({ hace: 5 * MIN, items: cafe });
  assert.equal(limpiarFlujoVencido(vigente, { zona }), vigente);
  const resumen = conFlujo({ hace: 50 * MIN, items: cafe, pendiente: { tipo: 'confirmar_resumen' } });
  assert.equal(limpiarFlujoVencido(resumen, { zona }), resumen);
});

console.log(`fase-flujos-caducan: ${ok}/7`);
