// El dueño decidió (14-oct-2026) apagar los repartidores para todos los
// negocios: hoy no se trabaja con esa modalidad.
//
//   · El módulo «repartidores» pasa a no_configurado donde estaba activo o
//     configurado. El código ya no registra ni enruta repartidores por
//     WhatsApp sin el módulo (whatsapp-meta.js).
//   · Los dos registros de Acuña hechos por error desde una conversación de
//     cliente (#52 del 12-oct y #53 del 14-oct) quedan inactivos y en modo
//     «cliente», para que esos teléfonos vuelvan al flujo de cliente desde
//     ahora, sin esperar al despliegue.
//
// No borra nada. Respaldo por negocio en configuracion
// (repartidores_apagado_respaldo_20261014) y auditoría por cambio.
//
//   node scripts/apagar-repartidores-20261014.mjs inspeccionar   (solo lectura)
//   node scripts/apagar-repartidores-20261014.mjs aplicar
//   node scripts/apagar-repartidores-20261014.mjs revertir
import assert from 'node:assert/strict';
import pg from 'pg';

const [modo = 'inspeccionar'] = process.argv.slice(2);
assert(['inspeccionar', 'aplicar', 'revertir'].includes(modo), 'modo: inspeccionar | aplicar | revertir');
assert(process.env.DATABASE_URL, 'falta DATABASE_URL');

const ACUNA = 'bb27290a-3359-4348-ba60-03d89f97127f';
const REGISTROS_POR_ERROR = [52, 53];
const RESPALDO = 'repartidores_apagado_respaldo_20261014';
const ESTADOS_ENCENDIDOS = ['activo', 'configurado'];
const escribe = modo !== 'inspeccionar';

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 12000 });
try {
  await db.connect();
  await db.query(escribe ? 'BEGIN' : 'BEGIN READ ONLY');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SET LOCAL statement_timeout='15s'");
  const bloqueo = escribe ? 'FOR UPDATE' : '';

  let actor = null;
  if (escribe) {
    const { rows } = await db.query(`SELECT u.id FROM administradores_plataforma ap JOIN usuarios u ON u.id = ap.usuario_id
      WHERE ap.activo AND u.activo AND lower(u.nombre) = 'mario'`);
    assert.equal(rows.length, 1, 'no se encontró al administrador de plataforma');
    actor = rows[0].id;
  }
  const auditar = (accion, negocioId, antes, despues) => db.query(`INSERT INTO auditoria_plataforma
      (superadmin_id, accion, negocio_id, estado_anterior, estado_nuevo, contexto) VALUES ($1, $2, $3, $4, $5, $6)`,
    [actor, accion, negocioId, JSON.stringify(antes), JSON.stringify(despues),
      JSON.stringify({ autorizacion: 'desactivar el tema de repartidores para todos', respaldo: RESPALDO, envios: 0 })]);

  const { rows: respaldos } = await db.query(`SELECT negocio_id, valor FROM configuracion WHERE clave = $1 ${bloqueo}`, [RESPALDO]);

  if (modo === 'revertir') {
    assert(respaldos.length, 'no hay respaldo: nada que revertir');
    for (const r of respaldos) {
      const antes = JSON.parse(r.valor);
      if (antes.modulo) {
        await db.query(`UPDATE negocio_modulos SET estado = $3 WHERE negocio_id = $1 AND modulo = 'repartidores' AND estado = $2`,
          [r.negocio_id, 'no_configurado', antes.modulo]);
      }
      for (const rep of antes.repartidores || []) {
        await db.query('UPDATE repartidores SET activo = $3, modo_actual = $4 WHERE id = $1 AND negocio_id = $2',
          [rep.id, r.negocio_id, rep.activo, rep.modo_actual]);
      }
      await auditar('revertir_apagado_repartidores', r.negocio_id, { modulo: 'no_configurado' }, antes);
      await db.query('DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2', [r.negocio_id, RESPALDO]);
    }
    await db.query('COMMIT');
    console.log(JSON.stringify({ modo, negociosRestaurados: respaldos.length, envios: 0 }));
  } else {
    if (modo === 'aplicar') assert(!respaldos.length, 'ya se aplicó (hay respaldo); inspeccionar o revertir antes de repetir');

    const { rows: modulos } = await db.query(`SELECT m.negocio_id, n.nombre, m.estado FROM negocio_modulos m
      JOIN negocios n ON n.id = m.negocio_id
      WHERE m.modulo = 'repartidores' AND m.estado = ANY($1) ORDER BY n.nombre ${bloqueo}`, [ESTADOS_ENCENDIDOS]);
    const { rows: registros } = await db.query(`SELECT id, negocio_id, activo, modo_actual, created_at FROM repartidores
      WHERE id = ANY($1) ORDER BY id ${bloqueo}`, [REGISTROS_POR_ERROR]);
    assert.equal(registros.length, REGISTROS_POR_ERROR.length, 'faltan registros esperados');
    for (const r of registros) {
      assert.equal(r.negocio_id, ACUNA, `#${r.id} no es de Acuña`);
      assert(new Date(r.created_at) >= new Date('2026-10-12T00:00:00Z'), `#${r.id} no es de los registros del 12 y 14-oct`);
    }

    const plan = new Map();
    const de = (id) => plan.get(id) || plan.set(id, { modulo: null, repartidores: [] }).get(id);
    for (const m of modulos) de(m.negocio_id).modulo = m.estado;
    for (const r of registros) {
      if (r.activo !== false || r.modo_actual !== 'cliente') de(r.negocio_id).repartidores.push({ id: r.id, activo: r.activo, modo_actual: r.modo_actual });
    }

    if (modo === 'aplicar') {
      for (const [negocioId, antes] of plan) {
        if (antes.modulo) {
          await db.query(`UPDATE negocio_modulos SET estado = 'no_configurado' WHERE negocio_id = $1 AND modulo = 'repartidores' AND estado = $2`,
            [negocioId, antes.modulo]);
        }
        for (const rep of antes.repartidores) {
          await db.query(`UPDATE repartidores SET activo = FALSE, modo_actual = 'cliente', modo_actualizado_at = NOW()
            WHERE id = $1 AND negocio_id = $2`, [rep.id, negocioId]);
        }
        await db.query('INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1, $2, $3)', [negocioId, RESPALDO, JSON.stringify(antes)]);
        await auditar('apagar_repartidores', negocioId, antes,
          { modulo: antes.modulo ? 'no_configurado' : null, repartidores: antes.repartidores.map((r) => ({ id: r.id, activo: false, modo_actual: 'cliente' })) });
      }
      await db.query('COMMIT');
    } else {
      await db.query('ROLLBACK');
    }
    console.log(JSON.stringify({
      modo,
      modulos: modulos.map((m) => ({ negocio: m.nombre, antes: m.estado, despues: 'no_configurado' })),
      registros: registros.map((r) => ({ id: r.id, antes: { activo: r.activo, modo_actual: r.modo_actual }, despues: { activo: false, modo_actual: 'cliente' } })),
      envios: 0,
    }, null, 1));
  }
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  console.error('Operación detenida:', e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
