// ─── Saneamiento de Rewards (fase 3, puntos 12, 13 y 14) ──────────────────
//
//   node scripts/rewards-saneamiento.mjs reporte          --negocio <uuid>
//   node scripts/rewards-saneamiento.mjs anular-generico  --negocio <uuid> [--aplicar] [--usuario <quién>]
//   node scripts/rewards-saneamiento.mjs normalizar       --negocio <uuid> [--aplicar] [--usuario <quién>]
//   node scripts/rewards-saneamiento.mjs revertir         --lote <uuid> | --bitacora <id> [--aplicar] [--usuario <quién>]
//
// LO QUE ESTE SCRIPT GARANTIZA:
//
//   · Sin --aplicar NO escribe. Corre dentro de una transacción READ ONLY
//     (la propia base rechaza cualquier escritura) y termina en ROLLBACK.
//     Imprime exactamente lo que haría.
//   · Nada se borra. Anular deja la cuenta dada de baja (activo = false) con
//     su saldo en cero por un movimiento 'ajuste_negativo'; fusionar mueve el
//     saldo con un par de ajustes. El historial de movimientos no se toca.
//   · Todo queda en rewards_bitacora (migración 149) con el antes y el
//     después, agrupado por un lote. `revertir --lote` deshace un lote entero
//     en orden inverso; `--bitacora` una sola fila.
//   · Un negocio a la vez (--negocio). Con --aplicar, un candado consultivo
//     por negocio y FOR UPDATE en cada cuenta: dos corridas no se pisan, y
//     una venta que entra a la vez espera.
//   · Verificación antes del COMMIT: normalizar conserva los puntos del
//     negocio al punto; anular baja exactamente lo anulado. Si no cuadra, se
//     revierte todo.
//   · Sin teléfonos completos en la salida: solo los últimos 4 dígitos.
//   · En una base que todavía no tiene la migración 149 (producción antes del
//     despliegue de la fase 3), el modo de prueba funciona y lee todas las
//     cuentas como «sin inscribir»; --aplicar y revertir se niegan.
//
// anular-generico (punto 12): cuentas activas que no son de una persona: el
//   registro técnico del mostrador (`pos-…`), `rappi-…`, «—», vacío. Saldo a
//   cero, fuera de inscritos y niveles (activo = false).
// normalizar (punto 14): el mismo número guardado en dos formatos (10 dígitos
//   y 52/521 + 10) son una persona. Se deja UNA cuenta con los 10 dígitos:
//   si no existe, se renombra la inscrita (o la más vieja); las demás se
//   fusionan en ella (saldo, acumulado, canjeado, inscripción, nombre).
//   Los teléfonos del negocio y los internos no se tocan.
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const ARGS = process.argv.slice(2);
const SUB = ARGS[0];
const opcion = (n) => { const i = ARGS.indexOf(`--${n}`); return i >= 0 ? ARGS[i + 1] : undefined; };
const APLICAR = ARGS.includes('--aplicar');
const USUARIO = opcion('usuario') || 'saneamiento';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFICABLE = (a) => `${a}.telefono ~ '^[0-9]{10,13}$'`;
// ¿La base ya tiene la 149 (inscripción y bitácora)? Se mide al conectar.
let CON_149 = true;
const INSCRITO_AT = () => (CON_149 ? 'inscrito_at' : 'NULL::timestamptz');

function uso(msg) {
  if (msg) console.error(`ERROR: ${msg}\n`);
  console.error('Uso: node scripts/rewards-saneamiento.mjs reporte|anular-generico|normalizar --negocio <uuid> [--aplicar]');
  console.error('     node scripts/rewards-saneamiento.mjs revertir --lote <uuid> | --bitacora <id> [--aplicar]');
  process.exit(2);
}

// …1234: nunca el número completo.
function enmascarar(t) {
  const s = String(t == null ? '' : t);
  if (!s) return '(vacío)';
  const fin = s.slice(-4);
  if (/^\d+$/.test(s)) return `…${fin} (${s.length} díg.)`;
  const pre = s.match(/^[a-z]+-/i)?.[0] || '';
  return `${pre}…${fin}`;
}
const n = (v) => (Number(v) || 0).toLocaleString('es-MX');
const instantanea = (a) => ({
  id: a.id, telefono: a.telefono, nombre: a.nombre, activo: a.activo, cliente_id: a.cliente_id,
  puntos_balance: a.puntos_balance, puntos_acumulados_total: a.puntos_acumulados_total,
  puntos_canjeados_total: a.puntos_canjeados_total,
  inscrito_at: a.inscrito_at, inscripcion_origen: a.inscripcion_origen, inscrito_por: a.inscrito_por,
});

// ── Escrituras (solo con --aplicar) ──────────────────────────────────────
// Un movimiento y el saldo de su cuenta se escriben JUNTOS: el libro y el
// saldo nunca pueden quedar distintos. Si el saldo en la base no es el que
// se leyó, se detiene (y la transacción entera se deshace).
async function movimiento(db, cuenta, tipo, delta, motivo, metadata) {
  const anterior = Number(cuenta.puntos_balance) || 0;
  const posterior = anterior + delta;
  if (posterior < 0) throw new Error(`saldo negativo en la cuenta ${cuenta.id}`);
  const { rows: [m] } = await db.query(
    `INSERT INTO rewards_movements
       (account_id, tenant_id, tipo, puntos, balance_anterior, balance_posterior, folio_venta, usuario, motivo, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9) RETURNING id`,
    [cuenta.id, cuenta.tenant_id, tipo, delta, anterior, posterior, USUARIO, motivo, JSON.stringify(metadata)]);
  const { rowCount } = await db.query(
    'UPDATE rewards_accounts SET puntos_balance = $2, updated_at = NOW() WHERE id = $1 AND puntos_balance = $3',
    [cuenta.id, posterior, anterior]);
  if (rowCount !== 1) throw new Error(`el saldo de la cuenta ${cuenta.id} cambió mientras se ajustaba`);
  cuenta.puntos_balance = posterior;
  return m.id;
}
async function bitacora(db, { tenantId, accountId, accion, lote, antes, despues, motivo }) {
  const { rows: [b] } = await db.query(
    `INSERT INTO rewards_bitacora (tenant_id, account_id, accion, lote, antes, despues, motivo, usuario)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [tenantId, accountId, accion, lote, JSON.stringify(antes), JSON.stringify(despues), motivo, USUARIO]);
  return b.id;
}
async function saldoNegocio(db, tenantId) {
  const { rows: [r] } = await db.query(
    `SELECT COALESCE(sum(puntos_balance), 0)::bigint AS saldo,
            COALESCE(sum(puntos_acumulados_total), 0)::bigint AS acumulado
       FROM rewards_accounts WHERE tenant_id = $1 AND activo`, [tenantId]);
  return { saldo: Number(r.saldo), acumulado: Number(r.acumulado) };
}

// ── reporte (punto 13 y 14: solo lectura) ────────────────────────────────
async function reporte(db, tenantId) {
  const { rows: [r] } = await db.query(`
    WITH c AS (
      SELECT a.*, right(a.telefono, 10) AS tel10,
             EXISTS (SELECT 1 FROM negocio_telefonos_propios tp WHERE tp.negocio_id::text = a.tenant_id AND tp.activo AND tp.telefono = right(a.telefono, 10)) AS propio,
             EXISTS (SELECT 1 FROM clientes_negocio cn WHERE cn.negocio_id::text = a.tenant_id AND cn.es_interno AND cn.telefono = right(a.telefono, 10)) AS interno,
             EXISTS (SELECT 1 FROM clientes_negocio cn WHERE cn.negocio_id::text = a.tenant_id AND cn.telefono = right(a.telefono, 10) AND COALESCE(btrim(cn.nombre), '') <> '') AS con_nombre_lista
        FROM rewards_accounts a WHERE a.tenant_id = $1 AND a.activo
    ), v AS (SELECT * FROM c WHERE ${IDENTIFICABLE('c')} AND NOT propio AND NOT interno),
    p AS (SELECT tel10, bool_or(${INSCRITO_AT()} IS NOT NULL) AS inscrito, sum(puntos_balance) AS saldo,
                 count(*) AS cuentas, bool_or(con_nombre_lista) AS con_nombre FROM v GROUP BY tel10)
    SELECT
      (SELECT count(*) FROM p WHERE inscrito)::int AS inscritas,
      (SELECT COALESCE(sum(saldo), 0) FROM p WHERE inscrito)::int AS saldo_inscritas,
      (SELECT count(*) FROM p WHERE NOT inscrito)::int AS sin_inscribir,
      (SELECT COALESCE(sum(saldo), 0) FROM p WHERE NOT inscrito)::int AS saldo_sin_inscribir,
      (SELECT count(*) FROM p WHERE NOT inscrito AND con_nombre)::int AS sin_inscribir_con_nombre,
      (SELECT count(*) FROM p WHERE cuentas > 1)::int AS personas_duplicadas,
      (SELECT COALESCE(sum(cuentas - 1), 0) FROM p WHERE cuentas > 1)::int AS cuentas_sobrantes,
      (SELECT count(*) FROM v WHERE length(telefono) <> 10)::int AS formato_largo,
      (SELECT count(*) FROM c WHERE NOT ${IDENTIFICABLE('c')} OR telefono IS NULL)::int AS genericas,
      (SELECT COALESCE(sum(puntos_balance), 0) FROM c WHERE NOT ${IDENTIFICABLE('c')} OR telefono IS NULL)::int AS saldo_genericas,
      (SELECT count(*) FROM c WHERE ${IDENTIFICABLE('c')} AND (propio OR interno))::int AS del_negocio,
      (SELECT COALESCE(sum(puntos_balance), 0) FROM c WHERE ${IDENTIFICABLE('c')} AND (propio OR interno))::int AS saldo_del_negocio
  `, [tenantId]);
  console.log('Personas inscritas ........................', n(r.inscritas), `(${n(r.saldo_inscritas)} pts)`);
  console.log('Personas sin inscribir (automáticas) ......', n(r.sin_inscribir), `(${n(r.saldo_sin_inscribir)} pts; ${n(r.sin_inscribir_con_nombre)} con nombre en Clientes)`);
  console.log('Mismo número en varios formatos ...........', n(r.personas_duplicadas), `persona(s), ${n(r.cuentas_sobrantes)} cuenta(s) de más`);
  console.log('Cuentas con 52/521 delante ................', n(r.formato_largo));
  console.log('Registros genéricos (pos-, rappi-, vacío) .', n(r.genericas), `(${n(r.saldo_genericas)} pts)`);
  console.log('Teléfonos del negocio o internos ..........', n(r.del_negocio), `(${n(r.saldo_del_negocio)} pts; no se tocan)`);
}

// ── anular-generico (punto 12) ───────────────────────────────────────────
async function anularGenerico(db, tenantId, lote) {
  const { rows } = await db.query(
    `SELECT a.*, (SELECT count(*) FROM rewards_movements m WHERE m.account_id = a.id)::int AS movimientos,
            (SELECT max(m.created_at) FROM rewards_movements m WHERE m.account_id = a.id) AS ultimo
       FROM rewards_accounts a
      WHERE a.tenant_id = $1 AND a.activo AND (a.telefono IS NULL OR NOT ${IDENTIFICABLE('a')})
      ORDER BY a.id ${APLICAR ? 'FOR UPDATE OF a' : ''}`, [tenantId]);
  if (!rows.length) { console.log('No hay registros genéricos activos: nada que anular.'); return { cuentas: 0, puntos: 0 }; }
  let puntos = 0;
  for (const a of rows) {
    const saldo = Number(a.puntos_balance) || 0;
    puntos += saldo;
    console.log(`  · cuenta ${a.id} ${enmascarar(a.telefono)}: ${n(saldo)} pts de saldo, ${n(a.puntos_acumulados_total)} acumulados, ${a.movimientos} movimiento(s)${a.inscrito_at ? ', INSCRITA' : ''} → saldo 0 y dada de baja`);
    if (!APLICAR) continue;
    const antes = instantanea(a);
    const motivo = 'Saneamiento: registro genérico del mostrador, no es un cliente';
    const mov = saldo > 0
      ? await movimiento(db, a, 'ajuste_negativo', -saldo, motivo, { saneamiento: 'anular-generico', lote })
      : null;
    await db.query(
      `UPDATE rewards_accounts SET puntos_balance = 0, activo = false,
              inscrito_at = NULL, inscripcion_origen = NULL, inscrito_por = NULL, updated_at = NOW()
        WHERE id = $1`, [a.id]);
    await bitacora(db, {
      tenantId, accountId: a.id, accion: 'anulacion', lote, motivo, antes,
      despues: { puntos_balance: 0, activo: false, movimiento: mov },
    });
  }
  console.log(`Total: ${rows.length} cuenta(s), ${n(puntos)} pts anulados.`);
  return { cuentas: rows.length, puntos };
}

// ── normalizar (punto 14) ────────────────────────────────────────────────
async function normalizar(db, tenantId, lote) {
  const { rows } = await db.query(
    `SELECT a.*, right(a.telefono, 10) AS tel10,
            EXISTS (SELECT 1 FROM negocio_telefonos_propios tp WHERE tp.negocio_id::text = a.tenant_id AND tp.activo AND tp.telefono = right(a.telefono, 10))
         OR EXISTS (SELECT 1 FROM clientes_negocio cn WHERE cn.negocio_id::text = a.tenant_id AND cn.es_interno AND cn.telefono = right(a.telefono, 10)) AS fuera
       FROM rewards_accounts a
      WHERE a.tenant_id = $1 AND a.activo AND ${IDENTIFICABLE('a')}
      ORDER BY a.id ${APLICAR ? 'FOR UPDATE OF a' : ''}`, [tenantId]);
  const grupos = new Map();
  for (const a of rows) { if (!grupos.has(a.tel10)) grupos.set(a.tel10, []); grupos.get(a.tel10).push(a); }

  let renombradas = 0, fusionadas = 0, puntosMovidos = 0, omitidas = 0;
  for (const [tel10, cuentas] of grupos) {
    if (cuentas.length === 1 && cuentas[0].telefono === tel10) continue;
    if (cuentas.some(c => c.fuera)) { console.log(`  · ${enmascarar(tel10)}: teléfono del negocio o interno, no se toca`); omitidas++; continue; }

    let destino = cuentas.find(c => c.telefono === tel10)
      || [...cuentas].sort((x, y) => (Number(!!y.inscrito_at) - Number(!!x.inscrito_at))
          || (new Date(x.created_at) - new Date(y.created_at)) || (x.id - y.id))[0];
    const renombrar = destino.telefono !== tel10;
    if (renombrar) {
      // UNIQUE (telefono, tenant_id): una cuenta dada de baja con los 10
      // dígitos bloquea el renombre. Eso lo decide una persona.
      const { rows: [ocupada] } = await db.query(
        'SELECT id FROM rewards_accounts WHERE tenant_id = $1 AND telefono = $2', [tenantId, tel10]);
      if (ocupada) { console.log(`  · ${enmascarar(tel10)}: hay una cuenta dada de baja (${ocupada.id}) con ese número; revisar a mano`); omitidas++; continue; }
    }
    const fuentes = cuentas.filter(c => c.id !== destino.id);
    const linea = [`  · ${enmascarar(tel10)}:`];
    if (renombrar) linea.push(`cuenta ${destino.id} ${enmascarar(destino.telefono)} → 10 dígitos;`);
    for (const f of fuentes) linea.push(`fusionar cuenta ${f.id} ${enmascarar(f.telefono)} (${n(f.puntos_balance)} pts${f.inscrito_at ? ', inscrita' : ''}) en la ${destino.id};`);
    console.log(linea.join(' '));

    if (renombrar) {
      renombradas++;
      if (APLICAR) {
        // FK rewards_accounts.telefono → clientes(telefono).
        const { rowCount: creado } = await db.query(
          `INSERT INTO clientes (telefono, nombre, ultima_visita, negocio_id) VALUES ($1, $2, NOW(), $3)
           ON CONFLICT (telefono) DO NOTHING`, [tel10, destino.nombre || null, tenantId]);
        const antes = instantanea(destino);
        await db.query('UPDATE rewards_accounts SET telefono = $1, updated_at = NOW() WHERE id = $2', [tel10, destino.id]);
        destino.telefono = tel10;
        await bitacora(db, {
          tenantId, accountId: destino.id, accion: 'normalizacion', lote,
          motivo: 'Saneamiento: teléfono a 10 dígitos', antes, despues: { telefono: tel10, cliente_global_creado: creado > 0 },
        });
      }
    }
    for (const f of fuentes) {
      fusionadas++;
      const saldo = Number(f.puntos_balance) || 0;
      puntosMovidos += saldo;
      if (!APLICAR) continue;
      const antes = { origen: instantanea(f), destino: instantanea(destino) };
      const copiado = {
        inscripcion: !!f.inscrito_at && !destino.inscrito_at,
        nombre: !String(destino.nombre || '').trim() && !!String(f.nombre || '').trim(),
        cliente_id: !destino.cliente_id && !!f.cliente_id,
      };
      const meta = { saneamiento: 'fusion', lote, origen: f.id, destino: destino.id };
      const motivoO = `Saneamiento: fusionada en la cuenta ${destino.id} (mismo número)`;
      const motivoD = `Saneamiento: fusión de la cuenta ${f.id} (mismo número en otro formato)`;
      const movO = saldo > 0 ? await movimiento(db, f, 'ajuste_negativo', -saldo, motivoO, meta) : null;
      const movD = saldo > 0 ? await movimiento(db, destino, 'ajuste_positivo', saldo, motivoD, meta) : null;
      await db.query(
        `UPDATE rewards_accounts SET puntos_balance = 0, activo = false,
                inscrito_at = NULL, inscripcion_origen = NULL, inscrito_por = NULL, updated_at = NOW()
          WHERE id = $1`, [f.id]);
      const { rows: [d] } = await db.query(
        `UPDATE rewards_accounts SET
            puntos_acumulados_total = puntos_acumulados_total + $2,
            puntos_canjeados_total  = puntos_canjeados_total + $3,
            inscrito_at        = CASE WHEN $4 THEN $5::timestamptz ELSE inscrito_at END,
            inscripcion_origen = CASE WHEN $4 THEN $6 ELSE inscripcion_origen END,
            inscrito_por       = CASE WHEN $4 THEN $7 ELSE inscrito_por END,
            nombre             = CASE WHEN $8 THEN $9 ELSE nombre END,
            cliente_id         = CASE WHEN $10 THEN $11::uuid ELSE cliente_id END,
            updated_at = NOW()
          WHERE id = $1 RETURNING *`,
        [destino.id, Number(f.puntos_acumulados_total) || 0, Number(f.puntos_canjeados_total) || 0,
          copiado.inscripcion, f.inscrito_at, f.inscripcion_origen, f.inscrito_por,
          copiado.nombre, f.nombre, copiado.cliente_id, f.cliente_id]);
      Object.assign(destino, d);
      await bitacora(db, {
        tenantId, accountId: destino.id, accion: 'fusion', lote,
        motivo: 'Saneamiento: mismo número en dos formatos',
        antes, despues: { origen: instantanea({ ...f, puntos_balance: 0, activo: false, inscrito_at: null, inscripcion_origen: null, inscrito_por: null }), destino: instantanea(destino), copiado, movimientos: [movO, movD] },
      });
    }
  }
  if (!renombradas && !fusionadas) console.log('Todas las cuentas ya están en 10 dígitos y sin duplicados: nada que hacer.');
  console.log(`Total: ${renombradas} a 10 dígitos, ${fusionadas} fusión(es) (${n(puntosMovidos)} pts movidos), ${omitidas} omitida(s).`);
  return { renombradas, fusionadas, puntosMovidos };
}

// ── revertir ─────────────────────────────────────────────────────────────
async function revertir(db, { lote, bitacoraId }) {
  const { rows } = await db.query(
    `SELECT * FROM rewards_bitacora WHERE ${lote ? 'lote = $1' : 'id = $1'} ORDER BY id DESC`,
    [lote || Number(bitacoraId)]);
  if (!rows.length) throw new Error('No hay filas de bitácora con ese lote o id');
  const tenantId = rows[0].tenant_id;
  if (rows.some(r => r.tenant_id !== tenantId)) throw new Error('El lote mezcla negocios: no se revierte');
  if (APLICAR) await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rewards-saneamiento:${tenantId}`]);
  const cuenta = async (id) => (await db.query(`SELECT * FROM rewards_accounts WHERE id = $1 ${APLICAR ? 'FOR UPDATE' : ''}`, [id])).rows[0];
  const metaR = (r) => ({ saneamiento: 'revertir', bitacora: r.id, lote: r.lote });
  let hechas = 0;
  for (const r of rows) {
    if (r.revertido_at) { console.log(`  · bitácora ${r.id} (${r.accion}): ya revertida, se omite`); continue; }
    const A = r.antes || {}, D = r.despues || {};
    if (r.accion === 'anulacion') {
      const a = await cuenta(r.account_id);
      if (a.activo) throw new Error(`bitácora ${r.id}: la cuenta ${a.id} ya está activa`);
      console.log(`  · bitácora ${r.id}: reactivar cuenta ${a.id} ${enmascarar(a.telefono)} con ${n(A.puntos_balance)} pts`);
      if (APLICAR) {
        if (Number(A.puntos_balance) > 0) await movimiento(db, a, 'ajuste_positivo', Number(A.puntos_balance), 'Saneamiento revertido: anulación deshecha', metaR(r));
        await db.query(
          `UPDATE rewards_accounts SET activo = true, inscrito_at = $2, inscripcion_origen = $3, inscrito_por = $4, updated_at = NOW() WHERE id = $1`,
          [a.id, A.inscrito_at, A.inscripcion_origen, A.inscrito_por]);
      }
    } else if (r.accion === 'fusion') {
      const o = A.origen, d0 = A.destino;
      const d = await cuenta(r.account_id);
      const f = await cuenta(o.id);
      if (!f || f.activo || f.tenant_id !== tenantId) throw new Error(`bitácora ${r.id}: la cuenta de origen ya no está dada de baja`);
      const saldo = Number(o.puntos_balance) || 0;
      if ((Number(d.puntos_balance) || 0) < saldo) {
        throw new Error(`bitácora ${r.id}: la cuenta ${d.id} ya gastó parte de los ${saldo} pts fusionados (tiene ${d.puntos_balance}); revertir a mano`);
      }
      console.log(`  · bitácora ${r.id}: separar ${n(saldo)} pts de la cuenta ${d.id} y reactivar la ${f.id} ${enmascarar(f.telefono)}`);
      if (APLICAR) {
        const c = D.copiado || {};
        if (saldo > 0) {
          await movimiento(db, d, 'ajuste_negativo', -saldo, 'Saneamiento revertido: fusión deshecha', metaR(r));
          await movimiento(db, f, 'ajuste_positivo', saldo, 'Saneamiento revertido: fusión deshecha', metaR(r));
        }
        await db.query(
          `UPDATE rewards_accounts SET
              puntos_acumulados_total = GREATEST(0, puntos_acumulados_total - $2),
              puntos_canjeados_total  = GREATEST(0, puntos_canjeados_total - $3),
              inscrito_at        = CASE WHEN $4 AND inscrito_at = $5::timestamptz THEN $6::timestamptz ELSE inscrito_at END,
              inscripcion_origen = CASE WHEN $4 AND inscrito_at = $5::timestamptz THEN $7 ELSE inscripcion_origen END,
              inscrito_por       = CASE WHEN $4 AND inscrito_at = $5::timestamptz THEN $8 ELSE inscrito_por END,
              nombre             = CASE WHEN $9 AND nombre IS NOT DISTINCT FROM $10 THEN $11 ELSE nombre END,
              cliente_id         = CASE WHEN $12 AND cliente_id IS NOT DISTINCT FROM $13::uuid THEN $14::uuid ELSE cliente_id END,
              updated_at = NOW()
            WHERE id = $1`,
          [d.id, Number(o.puntos_acumulados_total) || 0, Number(o.puntos_canjeados_total) || 0,
            !!c.inscripcion, o.inscrito_at, d0.inscrito_at, d0.inscripcion_origen, d0.inscrito_por,
            !!c.nombre, o.nombre, d0.nombre, !!c.cliente_id, o.cliente_id, d0.cliente_id]);
        await db.query(
          `UPDATE rewards_accounts SET activo = true, inscrito_at = $2, inscripcion_origen = $3, inscrito_por = $4, updated_at = NOW() WHERE id = $1`,
          [f.id, o.inscrito_at, o.inscripcion_origen, o.inscrito_por]);
      }
    } else if (r.accion === 'normalizacion') {
      const a = await cuenta(r.account_id);
      if (a.telefono !== D.telefono) throw new Error(`bitácora ${r.id}: la cuenta ${a.id} ya no tiene el teléfono normalizado`);
      const { rows: [ocupada] } = await db.query('SELECT id FROM rewards_accounts WHERE tenant_id = $1 AND telefono = $2 AND id <> $3', [tenantId, A.telefono, a.id]);
      if (ocupada) throw new Error(`bitácora ${r.id}: el teléfono original ya lo usa la cuenta ${ocupada.id}`);
      console.log(`  · bitácora ${r.id}: cuenta ${a.id} vuelve a ${enmascarar(A.telefono)}`);
      if (APLICAR) await db.query('UPDATE rewards_accounts SET telefono = $1, updated_at = NOW() WHERE id = $2', [A.telefono, a.id]);
    } else {
      throw new Error(`bitácora ${r.id}: una «${r.accion}» no la revierte este script`);
    }
    if (APLICAR) await db.query('UPDATE rewards_bitacora SET revertido_at = NOW(), revertido_por = $2 WHERE id = $1', [r.id, USUARIO]);
    hechas++;
  }
  console.log(`Total: ${hechas} fila(s) de bitácora ${APLICAR ? 'revertidas' : 'por revertir'}.`);
  return { hechas, tenantId };
}

// ── Principal ────────────────────────────────────────────────────────────
async function main() {
  if (!['reporte', 'anular-generico', 'normalizar', 'revertir'].includes(SUB)) uso();
  if (!process.env.DATABASE_URL) uso('DATABASE_URL requerida');
  const negocio = opcion('negocio');
  const lote = opcion('lote'), bitacoraId = opcion('bitacora');
  if (SUB === 'revertir') {
    if (!lote === !bitacoraId) uso('revertir lleva --lote <uuid> o --bitacora <id> (uno de los dos)');
    if (lote && !UUID.test(lote)) uso('--lote debe ser un uuid');
    if (bitacoraId && !/^\d+$/.test(bitacoraId)) uso('--bitacora debe ser un número');
  } else if (!UUID.test(negocio || '')) uso('--negocio <uuid> es obligatorio');
  if (SUB === 'reporte' && APLICAR) uso('reporte no escribe: quita --aplicar');

  const host = new URL(process.env.DATABASE_URL).hostname;
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
    ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });
  await db.connect();
  try {
    await db.query(APLICAR ? 'BEGIN' : 'BEGIN READ ONLY');
    const { rows: [esquema] } = await db.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = current_schema() AND table_name = 'rewards_accounts'
                         AND column_name = 'inscrito_at') AS columnas,
              to_regclass('rewards_bitacora') IS NOT NULL AS bitacora`);
    CON_149 = !!(esquema.columnas && esquema.bitacora);
    if (!CON_149) {
      if (APLICAR || SUB === 'revertir') {
        throw new Error('esta base todavía no tiene la migración 149 (llega con el despliegue de la fase 3): aquí solo corre el modo de prueba');
      }
      console.log('(Esta base todavía no tiene la migración 149: todas las cuentas se leen como «sin inscribir».)');
    }
    if (SUB !== 'revertir') {
      const { rows: [neg] } = await db.query('SELECT id::text AS id, nombre FROM negocios WHERE id::text = $1', [negocio]);
      if (!neg) throw new Error('Ese negocio no existe');
      console.log(`Negocio: ${neg.nombre} (${neg.id})`);
      if (APLICAR) await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rewards-saneamiento:${neg.id}`]);
    }
    console.log(APLICAR ? '── APLICANDO ──' : '── MODO DE PRUEBA: no se escribe nada ──');

    const nuevoLote = randomUUID();
    let loteUsado = false;
    if (SUB === 'reporte') await reporte(db, negocio);
    if (SUB === 'anular-generico') {
      const antes = await saldoNegocio(db, negocio);
      const r = await anularGenerico(db, negocio, nuevoLote);
      if (APLICAR && r.cuentas) {
        const despues = await saldoNegocio(db, negocio);
        if (antes.saldo - despues.saldo !== r.puntos) throw new Error(`verificación: el saldo bajó ${antes.saldo - despues.saldo}, se esperaba ${r.puntos}`);
        loteUsado = true;
      }
    }
    if (SUB === 'normalizar') {
      const antes = await saldoNegocio(db, negocio);
      const r = await normalizar(db, negocio, nuevoLote);
      if (APLICAR) {
        const despues = await saldoNegocio(db, negocio);
        if (antes.saldo !== despues.saldo || antes.acumulado !== despues.acumulado) {
          throw new Error(`verificación: los puntos del negocio cambiaron (${antes.saldo} → ${despues.saldo})`);
        }
        loteUsado = !!(r.renombradas || r.fusionadas);
      }
    }
    if (SUB === 'revertir') await revertir(db, { lote, bitacoraId });

    if (APLICAR) {
      await db.query('COMMIT');
      if (loteUsado) console.log(`Lote: ${nuevoLote}`);
      console.log('Hecho.' + (loteUsado ? ` Para deshacerlo: node scripts/rewards-saneamiento.mjs revertir --lote ${nuevoLote} --aplicar` : ''));
    } else {
      await db.query('ROLLBACK');
      if (SUB !== 'reporte') console.log(`Modo de prueba: no se escribió nada. Para aplicarlo, repetir con --aplicar.`);
    }
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error(`FALLO: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}

await main();
