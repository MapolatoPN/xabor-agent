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

  console.log('Estado del agente: error de lectura rechazado; conversación nueva solo tras lectura exitosa.');
} finally {
  pool.query = consultaOriginal;
  await pool.end();
}
