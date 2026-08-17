// ─── Reservas de promoción DENTRO de una transacción ajena ──────────────────
//
// Esto NO es un motor de promociones paralelo: opera sobre las MISMAS tablas
// que `tiendaPromociones.js` (`tienda_promocion_usos` y el contador
// `tienda_promociones.usos`). Existe por una razón concreta: consumir y liberar
// tienen que ocurrir DENTRO de la transacción del dinero -- la de
// `consumirDeudaDeDerivacion` y la de `vencerEsperaDePago` --, y esas viven en
// `database.js`. Estas funciones reciben el `client` de esa transacción y no
// abren ninguna propia.
//
// Sin `import` de database.js: evita un ciclo de módulos con una capa que ya
// importa medio proyecto.
//
// EL CONTADOR
//
//   reservar  -> usos + 1   (lo hace tiendaPromociones, con UPDATE condicional)
//   consumir  -> no lo toca (la reserva ya lo contaba)
//   liberar   -> usos - 1
//
// Por eso `consumidas + reservas activas <= limite_usos` se sostiene siempre, y
// la garantía vive en el `WHERE ... usos < limite_usos` de la base, no en la
// aplicación.

/**
 * Convierte las reservas vivas de un pedido en usos consumidos.
 *
 * Va dentro de la transacción que marca el pedido como pagado, con el mismo
 * lock de obligación financiera: si el expirador está corriendo a la vez, uno
 * de los dos espera y ve el resultado del otro.
 *
 * `version` es el hash de versión del pedido que el settlement acaba de
 * revalidar. Una reserva de OTRA versión ya no representa el precio que se
 * cobró: no se consume y se reporta como inválida, para que el llamador deje
 * anomalía en vez de liberar el pedido en silencio.
 *
 * Idempotente: un segundo paso no encuentra nada en 'reservada' y devuelve 0.
 */
export async function consumirReservasDePedido(client, { negocioId, folio, version = null }) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    throw new Error('consumirReservasDePedido requiere negocioId');
  }
  const nid = negocioId.trim();

  // FOR UPDATE: entre leer y decidir, el expirador podría estar soltando estas
  // mismas filas. Se bloquean y se decide con lo que la base garantiza.
  const { rows: reservas } = await client.query(
    `SELECT id, promocion_id, pedido_version FROM tienda_promocion_usos
      WHERE negocio_id = $1 AND pedido_folio = $2 AND estado = 'reservada'
      FOR UPDATE`,
    [nid, folio]);
  if (!reservas.length) return { consumidas: 0, invalidas: [] };

  // Un hash ausente es de una reserva anterior a que existiera la columna: no
  // se puede comparar, y bloquear por eso seria inventar una discrepancia.
  const invalidas = version
    ? reservas.filter(r => r.pedido_version && r.pedido_version !== version)
    : [];
  const validas = reservas.filter(r => !invalidas.includes(r));

  if (validas.length) {
    await client.query(
      `UPDATE tienda_promocion_usos
          SET estado = 'consumida', consumida_at = NOW()
        WHERE negocio_id = $1 AND id = ANY($2::uuid[])`,
      [nid, validas.map(r => r.id)]);
  }

  return {
    consumidas: validas.length,
    invalidas: invalidas.map(r => ({ id: r.id, promocionId: r.promocion_id, version: r.pedido_version })),
  };
}

/**
 * Suelta las reservas vivas de un pedido y devuelve el cupo.
 *
 * Va dentro de la transacción que vence el pago y cancela el pedido. Hacerlo
 * después del COMMIT abriría una ventana en la que el pedido ya está cancelado
 * y el cupón sigue apartado por nadie -- y si el proceso muere ahí, para
 * siempre.
 *
 * Solo toca filas 'reservada': una promoción ya consumida jamás se libera,
 * porque detrás hay dinero real.
 */
export async function liberarReservasDePedido(client, {
  negocioId, folio, motivo = 'la espera de pago vencio', soloVersion = null,
}) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    throw new Error('liberarReservasDePedido requiere negocioId');
  }
  const nid = negocioId.trim();

  // `soloVersion` acota la liberacion a las reservas de UNA version del pedido.
  // Sin esto, un cobro tardio de la v1 soltaba tambien la reserva de la v2 --
  // que pertenece a un cobro todavia vivo y que nadie pidio tocar. El
  // vencimiento de la obligacion entera no la pasa: ahi si se suelta todo.
  const { rows: sueltas } = await client.query(
    `DELETE FROM tienda_promocion_usos
      WHERE negocio_id = $1 AND pedido_folio = $2 AND estado = 'reservada'
        AND ($3::text IS NULL OR pedido_version IS NULL OR pedido_version = $3)
      RETURNING promocion_id`,
    [nid, folio, soloVersion]);
  if (!sueltas.length) return { liberadas: 0, promociones: [] };

  // Una fila por promoción devuelve un cupo. Se agrupa porque el contador es
  // por promoción, no por fila.
  const porPromo = new Map();
  for (const s of sueltas) porPromo.set(s.promocion_id, (porPromo.get(s.promocion_id) || 0) + 1);

  for (const [promocionId, n] of porPromo) {
    await client.query(
      `UPDATE tienda_promociones SET usos = GREATEST(usos - $3, 0), updated_at = NOW()
        WHERE id = $1 AND negocio_id = $2`,
      [promocionId, nid, n]);
  }
  console.log(`[Promos] ${sueltas.length} reserva(s) liberadas del pedido ${folio}: ${motivo}`);
  return { liberadas: sueltas.length, promociones: [...porPromo.keys()] };
}

/** ¿Este pedido tiene alguna promoción todavía reservada? Solo lectura. */
export async function reservasVivasDePedido(client, negocioId, folio) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return [];
  const { rows } = await client.query(
    `SELECT id, promocion_id, pedido_version FROM tienda_promocion_usos
      WHERE negocio_id = $1 AND pedido_folio = $2 AND estado = 'reservada'`,
    [negocioId.trim(), folio]);
  return rows;
}
