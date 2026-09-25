import assert from 'node:assert/strict';
import { pool } from '../src/services/database.js';
import { leerEstado } from '../src/mesero-agente/canalDelAgente.js';

const consultaOriginal = pool.query;
try {
  pool.query = async () => { throw new Error('lectura interrumpida'); };
  await assert.rejects(leerEstado('negocio-prueba', '528781234567'), /lectura interrumpida/,
    'una lectura fallida no debe parecer una conversación nueva');

  pool.query = async () => ({ rows: [] });
  const nuevo = await leerEstado('negocio-prueba', '528781234567');
  assert.deepEqual(nuevo.carrito.items, []);

  pool.query = async () => ({ rows: [{ estado: nuevo,
    actualizado_at: new Date('2026-09-24T10:00:00Z'), inactividad_ms: '180000' }] });
  const guardado = await leerEstado('negocio-prueba', '528781234567');
  assert.equal(guardado._inactividadMs, 180000,
    'la inactividad debe provenir del mismo reloj que guardó el estado');

  console.log('Estado del agente: error de lectura rechazado; conversación nueva solo tras lectura exitosa.');
} finally {
  pool.query = consultaOriginal;
  await pool.end();
}
