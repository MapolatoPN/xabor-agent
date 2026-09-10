// SINCRONIZACIÓN DE LO OPERADO SIN INTERNET.
//
// Recibe el lote que el Edge acumuló durante un corte y lo incorpora a la nube.
// Es la mitad delicada del modo offline: aquí es donde un error no se ve hasta
// que la caja del día no cuadra.
//
// ── Por qué esto puede ser idempotente de verdad ────────────────────────────
// Porque no inventa identificadores. Cuentas, items y pagos nacen en el Edge
// con su UUID definitivo, y el folio de venta se deriva del UUID de la cuenta
// (`RM-<8 hex>-<reversos>`), así que subir el mismo lote una vez o cinco
// produce el mismo resultado. Las guardas son de la propia base:
//
//   · PK por UUID en las tres tablas.
//   · `idx_restaurante_venta_folio` UNIQUE sobre venta_folio.
//   · `pedidos_activos` con ON CONFLICT (folio) DO NOTHING.
//
// ── Reglas de resolución ────────────────────────────────────────────────────
// 1. UNA TRANSACCIÓN POR CUENTA, no por lote. Una mesa en conflicto no puede
//    dejar sin subir las otras treinta ventas del día.
// 2. EL DINERO COBRADO ES UN HECHO. Un pago registrado offline se guarda
//    aunque la nube ya haya cerrado esa cuenta; lo que NO se hace es
//    recalcular ni reabrir la venta. Se reporta para que un humano lo mire.
// 3. LO QUE NO SE PUDO APLICAR NO SE CONFIRMA. Solo se devuelven como
//    confirmados los eventos realmente incorporados: el Edge conserva el resto
//    en su cola y lo reintenta.
// 4. NADA SE RESUELVE ADIVINANDO. Dos cuentas distintas sobre la misma mesa
//    son una ambigüedad real de operación; se reporta y decide una persona.
import { pool } from './database.js';

const aPesos = (centavos) => Number((Number(centavos || 0) / 100).toFixed(2));

export const CONFLICTOS = {
  // Otra cuenta distinta ocupa esa mesa en la nube. Dos dispositivos operaron
  // la misma mesa por separado: nadie puede decidir por ellos cuál vale.
  MESA_OCUPADA: 'MESA_OCUPADA',
  // Llegaron pagos de una cuenta que la nube ya cerró. Se guardan igual.
  PAGO_SOBRE_CUENTA_CERRADA: 'PAGO_SOBRE_CUENTA_CERRADA',
  // El mesero o el usuario que capturó ya no existe en la nube.
  USUARIO_DESCONOCIDO: 'USUARIO_DESCONOCIDO',
  ERROR: 'ERROR',
};

function validarNegocioId(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    throw new Error('sincronizarLoteSala: negocioId requerido');
  }
  return negocioId.trim();
}

/**
 * Incorpora un lote del Edge.
 *
 * @param lote  { cuentas: [...], eventos: [...] } tal como lo emite
 *              `edge/sala/operacionLocal.js` → `exportarLote()`.
 * @returns { aplicadas, conflictos, eventosConfirmados, reporte }
 *          `reporte` es lo que se le enseña a una persona al final del corte:
 *          qué entró, con qué folio, y qué quedó pendiente de decisión.
 */
export async function sincronizarLoteSala(negocioId, lote, { ejecutor = pool } = {}) {
  const nid = validarNegocioId(negocioId);
  const cuentas = Array.isArray(lote?.cuentas) ? lote.cuentas : [];
  const eventos = Array.isArray(lote?.eventos) ? lote.eventos : [];

  const reporte = [];
  const eventosConfirmados = [];
  let aplicadas = 0, conflictos = 0;

  for (const cuenta of cuentas) {
    const resultado = await incorporarCuenta(nid, cuenta, ejecutor);
    reporte.push(resultado);
    if (resultado.estado === 'conflicto') {
      conflictos += 1;
      continue;   // sus eventos NO se confirman: el Edge los conserva
    }
    aplicadas += 1;
    for (const e of eventos) if (e.cuentaId === cuenta.id) eventosConfirmados.push(e.id);
  }

  // Un evento de una cuenta que no vino en el lote no puede confirmarse: sin su
  // estado no hay nada que aplicar. Se deja en la cola del Edge a propósito.
  return { aplicadas, conflictos, eventosConfirmados, reporte };
}

async function incorporarCuenta(nid, cuenta, ejecutor) {
  const base = { cuentaId: cuenta.id, mesa: cuenta.mesa_numero, ventaFolio: cuenta.venta_folio || null };
  const client = await ejecutor.connect();
  try {
    await client.query('BEGIN');

    // Los usuarios son FK reales. Si el mesero se dio de baja mientras el Edge
    // estaba desconectado, el INSERT fallaría con un 23503 que no dice nada
    // útil: se comprueba antes para poder reportarlo con nombre y apellido.
    const usuarios = [cuenta.mesero_usuario_id, cuenta.abierta_por, cuenta.cerrada_por]
      .concat((cuenta.items || []).map((i) => i.agregado_por))
      .concat((cuenta.pagos || []).map((p) => p.registrado_por))
      .filter(Boolean);
    const faltante = await primerUsuarioDesconocido(client, nid, [...new Set(usuarios)]);
    if (faltante) {
      await client.query('ROLLBACK');
      return { ...base, estado: 'conflicto', conflicto: CONFLICTOS.USUARIO_DESCONOCIDO, detalle: faltante };
    }

    const { rows: previas } = await client.query(
      `SELECT id, estado, venta_folio FROM restaurante_cuentas
        WHERE id = $1 AND negocio_id = $2 FOR UPDATE`,
      [cuenta.id, nid]
    );
    const previa = previas[0] || null;
    const yaCerradaEnNube = previa && previa.estado === 'cerrada';

    if (!previa) {
      // Una cuenta CERRADA nunca choca con el índice único: solo cubre
      // `estado='abierta'`. Es el caso normal al reconectar, porque para
      // entonces la mesa ya se cobró.
      const ocupada = cuenta.estado === 'abierta'
        ? await mesaOcupadaPorOtra(client, nid, cuenta.mesa_numero, cuenta.id)
        : null;
      if (ocupada) {
        await client.query('ROLLBACK');
        return {
          ...base, estado: 'conflicto', conflicto: CONFLICTOS.MESA_OCUPADA,
          detalle: `la mesa ${cuenta.mesa_numero} ya tiene la cuenta ${ocupada} abierta en la nube`,
        };
      }
      await client.query(
        `INSERT INTO restaurante_cuentas
           (id, negocio_id, mesa_numero, personas, mesero_usuario_id, estado, abierta_por,
            abierta_at, cerrada_por, cerrada_at, comandas_emitidas, reversos, notas)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [cuenta.id, nid, cuenta.mesa_numero, cuenta.personas, cuenta.mesero_usuario_id,
          cuenta.estado, cuenta.abierta_por, cuenta.abierta_at, cuenta.cerrada_por,
          cuenta.cerrada_at, cuenta.comandas_emitidas, cuenta.reversos || 0, cuenta.notas || null]
      );
    } else if (!yaCerradaEnNube) {
      // Solo se avanza el estado de una cuenta que sigue viva. Una ya cerrada
      // en la nube no se reabre nunca desde aquí.
      await client.query(
        `UPDATE restaurante_cuentas
            SET personas = $3, comandas_emitidas = GREATEST(comandas_emitidas, $4),
                estado = $5, cerrada_por = COALESCE($6, cerrada_por),
                cerrada_at = COALESCE($7, cerrada_at), updated_at = NOW()
          WHERE id = $1 AND negocio_id = $2`,
        [cuenta.id, nid, cuenta.personas, cuenta.comandas_emitidas,
          cuenta.estado, cuenta.cerrada_por, cuenta.cerrada_at]
      );
    }

    // ── Items: upsert por UUID. El estado SÍ se actualiza (algo capturado
    // offline pudo enviarse a cocina o cancelarse después).
    for (const i of (cuenta.items || [])) {
      await client.query(
        `INSERT INTO restaurante_cuenta_items
           (id, cuenta_id, negocio_id, producto, cantidad, precio_unitario, modificadores,
            notas, estado, comanda_num, agregado_por, cancelado_por, motivo_cancelacion, cancelado_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (id) DO UPDATE SET
           estado = EXCLUDED.estado, comanda_num = EXCLUDED.comanda_num,
           cancelado_por = EXCLUDED.cancelado_por,
           motivo_cancelacion = EXCLUDED.motivo_cancelacion,
           cancelado_at = EXCLUDED.cancelado_at`,
        [i.id, cuenta.id, nid, i.producto, i.cantidad, aPesos(i.precio_unitario_centavos),
          JSON.stringify(i.modificadores || []), i.notas || null, i.estado, i.comanda_num,
          i.agregado_por, i.cancelado_por, i.motivo_cancelacion, i.cancelado_at, i.created_at]
      );
    }

    // ── Pagos: un cobro es un hecho inmutable. Se inserta y nunca se pisa.
    let pagosNuevos = 0;
    for (const p of (cuenta.pagos || [])) {
      const { rowCount } = await client.query(
        `INSERT INTO restaurante_cuenta_pagos
           (id, cuenta_id, negocio_id, metodo, monto, propina, cubre, referencia, registrado_por, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO NOTHING`,
        [p.id, cuenta.id, nid, p.metodo, aPesos(p.monto_centavos), aPesos(p.propina_centavos),
          p.cubre, p.referencia, p.registrado_por, p.created_at]
      );
      pagosNuevos += rowCount;
    }

    // ── La venta consolidada, si la cuenta se cerró sin enlace.
    let ventaFolio = previa?.venta_folio || null;
    if (cuenta.estado === 'cerrada' && cuenta.venta_folio && !yaCerradaEnNube) {
      await insertarVenta(client, nid, cuenta);
      await client.query(
        `UPDATE restaurante_cuentas
            SET venta_folio = $3, contabilizada_at = COALESCE(contabilizada_at, NOW()), updated_at = NOW()
          WHERE id = $1 AND negocio_id = $2 AND venta_folio IS NULL`,
        [cuenta.id, nid, cuenta.venta_folio]
      );
      ventaFolio = cuenta.venta_folio;
    }

    await client.query('COMMIT');

    if (yaCerradaEnNube && pagosNuevos > 0) {
      return {
        ...base, estado: 'aplicada', ventaFolio,
        conflicto: CONFLICTOS.PAGO_SOBRE_CUENTA_CERRADA, pagosNuevos,
        detalle: 'se registraron pagos de una cuenta que la nube ya había cerrado; la venta NO se recalculó',
      };
    }
    return { ...base, estado: previa ? 'actualizada' : 'aplicada', ventaFolio, pagosNuevos };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return { ...base, estado: 'conflicto', conflicto: CONFLICTOS.ERROR, detalle: e.message };
  } finally {
    client.release();
  }
}

async function primerUsuarioDesconocido(client, nid, ids) {
  if (!ids.length) return null;
  const { rows } = await client.query(
    `SELECT u.id FROM usuarios u
       JOIN usuario_negocios un ON un.usuario_id = u.id AND un.negocio_id = $2
      WHERE u.id = ANY($1::uuid[])`,
    [ids, nid]
  );
  const conocidos = new Set(rows.map((r) => r.id));
  return ids.find((id) => !conocidos.has(id)) || null;
}

async function mesaOcupadaPorOtra(client, nid, mesa, cuentaId) {
  const { rows } = await client.query(
    `SELECT id FROM restaurante_cuentas
      WHERE negocio_id = $1 AND mesa_numero = $2 AND estado = 'abierta' AND id <> $3 LIMIT 1`,
    [nid, mesa, cuentaId]
  );
  return rows[0]?.id || null;
}

/**
 * La venta consolidada, con la MISMA forma que produce `cerrarCuenta` — es lo
 * que leen el corte de caja y los reportes. Si divergiera, una venta hecha sin
 * internet no aparecería igual que una hecha con él.
 */
async function insertarVenta(client, nid, cuenta) {
  const vivos = (cuenta.items || []).filter((i) => i.estado !== 'cancelado');
  const totalCentavos = vivos.reduce((s, i) => s + i.cantidad * i.precio_unitario_centavos, 0);
  const propinasCentavos = (cuenta.pagos || []).reduce((s, p) => s + p.propina_centavos, 0);

  const porMetodo = new Map();
  for (const p of (cuenta.pagos || [])) {
    const acc = porMetodo.get(p.metodo) || { metodo: p.metodo, monto: 0, propina: 0 };
    acc.monto += p.monto_centavos; acc.propina += p.propina_centavos;
    porMetodo.set(p.metodo, acc);
  }
  const pagos = [...porMetodo.values()]
    .sort((a, b) => a.metodo.localeCompare(b.metodo))
    .map((p) => ({ metodo: p.metodo, monto: aPesos(p.monto), propina: aPesos(p.propina) }));
  const formaPago = pagos.length === 0 ? 'sin pago' : (pagos.length === 1 ? pagos[0].metodo : 'mixto');

  const datosVenta = {
    id: cuenta.venta_folio,
    origen: 'restaurante',
    canal: 'restaurante_mesa',
    modalidad: 'mesa',
    mesa: cuenta.mesa_numero,
    personas: cuenta.personas,
    mesero: cuenta.mesero_nombre || null,
    cuenta_id: cuenta.id,
    abierta_at: cuenta.abierta_at,
    // Marca la procedencia: en el corte del día se puede distinguir lo que se
    // cobró sin enlace de lo que pasó por la nube en vivo.
    sincronizada_offline: true,
    cliente: { nombre: `Mesa ${cuenta.mesa_numero}` },
    items: vivos.map((i) => ({
      nombre: i.producto, cantidad: i.cantidad,
      precio_unitario: aPesos(i.precio_unitario_centavos),
      notas: [i.notas, ...(Array.isArray(i.modificadores) ? i.modificadores : [])].filter(Boolean).join(', ') || undefined,
    })),
    total: aPesos(totalCentavos),
    propinas: aPesos(propinasCentavos),
    costo_envio: 0,
    forma_pago: formaPago,
    pagos,
    estado: 'entregado',
  };

  // `created_at` va al momento en que se COBRÓ, no al de la sincronización.
  // El corte de caja agrupa el día por `pedidos_activos.created_at`
  // (cortesCaja.js:208), así que dejarlo en NOW() metería la venta del sábado
  // sin internet en el corte del domingo. La caja de un día tiene que cuadrar
  // con lo que pasó ESE día, no con cuándo volvió el enlace.
  await client.query(
    `INSERT INTO pedidos_activos (folio, estado, datos, negocio_id, created_at, entregado_at)
     VALUES ($1, 'entregado', $2, $3, COALESCE($4::timestamptz, NOW()), COALESCE($4::timestamptz, NOW()))
     ON CONFLICT (folio) DO NOTHING`,
    [cuenta.venta_folio, JSON.stringify(datosVenta), nid, cuenta.cerrada_at || null]
  );
}
