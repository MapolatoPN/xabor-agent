// Prueba de la restricción de confirmación en Postgres local. Todos los INSERT
// quedan dentro de una transacción que se revierte, incluso si la prueba falla.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { almacenEnPostgres, libroDeOperaciones } from '../src/mesero-agente/libroDeOperaciones.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
  throw new Error('Esta prueba solo acepta Postgres local');
}
const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: false });
await db.connect();
try {
  await db.query('BEGIN');
  const { rows: negocios } = await db.query('SELECT id FROM negocios LIMIT 1');
  if (!negocios[0]) throw new Error('La base local no tiene un negocio de prueba');
  const negocioId = negocios[0].id;
  const conversacion = `prueba-${randomUUID()}`;
  const insertar = (clave) => db.query(
    `INSERT INTO agente_operaciones
       (negocio_id, conversacion_id, turno_id, operacion_clave, herramienta, argumentos_hash)
     VALUES ($1,$2,$3,$4,'confirmar_pedido','prueba')
     ON CONFLICT DO NOTHING RETURNING id`,
    [negocioId, conversacion, clave, clave]);

  const primera = await insertar(randomUUID());
  const segunda = await insertar(randomUUID());
  assert.equal(primera.rowCount, 1);
  assert.equal(segunda.rowCount, 0, 'el índice permitió dos confirmaciones posibles');

  await db.query("UPDATE agente_operaciones SET estado = 'rechazada' WHERE id = $1", [primera.rows[0].id]);
  const trasRechazo = await insertar(randomUUID());
  assert.equal(trasRechazo.rowCount, 1, 'un rechazo conocido bloqueó un intento legítimo');

  const libro = libroDeOperaciones(almacenEnPostgres({ query: (...args) => db.query(...args) }));
  const otroCiclo = `prueba-${randomUUID()}`;
  const llamada = { negocioId, conversacionId: otroCiclo, turnoId: 't1',
    herramienta: 'confirmar_pedido', argumentos: { huella_resumen: 'h' } };
  await libro.ejecutarUnaVez(llamada, async () => ({ aplicada: true,
    resultado: { aplicado: true, folio: 'XAB-PRUEBA' } }));
  let segundoEfecto = false;
  const repetida = await libro.ejecutarUnaVez({ ...llamada, turnoId: 't2' }, async () => {
    segundoEfecto = true; return { aplicada: true };
  });
  assert.equal(segundoEfecto, false);
  assert.equal(repetida.resultado.folio, 'XAB-PRUEBA');
  console.log('Índice local: bloquea doble confirmación y libera después de rechazo conocido.');
} finally {
  await db.query('ROLLBACK').catch(() => {});
  await db.end();
}
