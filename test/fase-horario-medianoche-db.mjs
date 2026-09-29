// Lee cambios desde Postgres y atraviesa el canal real; NO envía el outbox.
// Meta nunca se llama. El reloj y el modelo son simulados, la base es desechable.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mock } from 'node:test';
import { prepararNegocioBotones } from './lib-botones-local.mjs';
import { pool, actualizarConfiguracion } from '../src/services/database.js';
import { atenderConAgente } from '../src/mesero-agente/canalDelAgente.js';
import { reglasDelNegocio, estadoApertura } from '../src/services/tiendaOnline.js';
import { cargarReglas, obtenerEstadoRestaurante } from '../src/agent/prompts.js';

process.env.MESERO_AGENTE_MODE = 'true';
process.env.WHATSAPP_INTERACTIVOS = 'true';
const f = await prepararNegocioBotones(); // exige localhost y nombre test_botones_
const reglas = await cargarReglas(f.negocioId);
let llamadas = 0;
async function comprobar(cierre, abierto) {
  reglas.horarios.lunes = { abierto: true, apertura: '04:30', cierre };
  await actualizarConfiguracion({ reglas_atencion: JSON.stringify(reglas), timezone: 'America/Matamoros' }, f.negocioId);
  const leidas = await cargarReglas(f.negocioId);
  assert.equal(obtenerEstadoRestaurante(leidas).abierto, abierto);
  const tienda = await reglasDelNegocio(f.negocioId);
  assert.deepEqual(tienda.cierres_especiales, reglas.cierres_especiales);
  assert.equal(estadoApertura(tienda).abierto, abierto);
  const antes = llamadas;
  const r = await atenderConAgente({
    ...f, mensaje: 'Hola', wamids: [`wamid.horario.${randomUUID()}`],
    llamarModelo: async () => {
      llamadas++;
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hola. ¿Qué deseas ordenar?' }] };
    },
  });
  assert(r.ok, JSON.stringify(r));
  const { rows: [salida] } = await pool.query('SELECT estado,carga FROM agente_outbox WHERE evento_clave=$1', [r.outbox.clave]);
  assert.equal(salida.estado, 'pendiente'); // no se envía
  assert.equal(/por el momento ya cerramos/.test(JSON.stringify(salida.carga)), !abierto);
  if (!abierto) assert.equal(llamadas, antes, 'cerrado no consulta al modelo');
  else assert.match(JSON.stringify(salida.carga), /Café americano/,
    'abierto retoma el borrador; un saludo no necesita llamar al modelo');
}
try {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-29T03:20:43.922Z') });
  await comprobar('15:00', false);
  await comprobar('00:00', true); // cambio guardado se aplica SIN reiniciar
  await comprobar('00:45', true);
  await comprobar('21:00', false); // también cerrar vuelve a actuar inmediatamente
  reglas.cierres_especiales = [{ fecha: '2026-09-28', motivo: 'Cierre de prueba' }];
  await comprobar('00:00', false);
  assert.equal((await pool.query('SELECT count(*)::int n FROM pedidos_activos WHERE negocio_id=$1', [f.negocioId])).rows[0].n, 0);
  console.log('OK horario DB: cerrado -> medianoche -> nocturno -> cerrado -> especial, sin reinicio, cero pedidos y cero envíos.');
} finally {
  mock.timers.reset();
  await pool.end();
}
