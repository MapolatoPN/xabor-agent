/**
 * rewardsService.js — Módulo de Lealtad Xabor Rewards
 *
 * Completamente aislado de los flujos críticos de WhatsApp, comandas e impresión.
 * Cualquier fallo en este módulo NO afecta la operación del restaurante.
 *
 * DEUDA TÉCNICA:
 *   - clientes.telefono es actualmente la identidad del cliente (PK VARCHAR).
 *   - rewards_accounts.telefono es FK a esa columna.
 *   - Cuando se migre a UUID, reemplazar todas las referencias a `telefono` en este
 *     archivo por `cliente_id`, sin necesidad de cambiar la lógica de negocio.
 *   - La función `obtenerOCrearCuenta` es el único punto de contacto con la tabla
 *     clientes, lo que facilita esa futura migración.
 *
 * FUTURO CRM (no implementado aún, estructura compatible):
 *   - rewards_levels: niveles de membresía (Bronze/Silver/Gold)
 *     Se agrega como tabla independiente con FK a rewards_accounts.
 *   - Cupones, referidos, cumpleaños: nuevas tablas sin alterar rewards_movements.
 *   - Campañas: usar movimientos tipo 'ajuste_positivo' con motivo = 'campaña'.
 *   - Expiración: job nocturno que crea movimientos tipo 'expiracion'.
 */

import { pool } from './database.js';

const DEFAULT_TENANT = 'xabor-principal';

// ─── Niveles de membresía ─────────────────────────────────────────────────────
// Se calcula desde puntos_acumulados_total (histórico, nunca baja).
// Bronze: 0–499 | Silver: 500–1499 | Gold: 1500+
// Sin tabla nueva — calculado en tiempo real.
export function calcularNivel(puntosAcumuladosTotal) {
  const pts = parseInt(puntosAcumuladosTotal) || 0;
  if (pts >= 1500) return { nombre: 'Gold',   emoji: '🥇', color: '#f59e0b', siguiente: null,     falta: 0 };
  if (pts >= 500)  return { nombre: 'Silver', emoji: '🥈', color: '#6b7280', siguiente: 'Gold',   falta: 1500 - pts };
  return               { nombre: 'Bronze', emoji: '🥉', color: '#b45309', siguiente: 'Silver', falta: 500  - pts };
}

// ─── Cálculo central de puntos ────────────────────────────────────────────────
// ÚNICA fuente de verdad para el cálculo de puntos.
// El frontend solo muestra estimaciones; el backend valida y persiste.
//
// Fórmula: floor(totalElegible / config.monto_por_punto)
// Ejemplo con monto_por_punto=10:
//   $189 → floor(189/10) = 18 puntos
//   $486 → floor(486/10) = 48 puntos
//   $99  → floor(99/10)  =  9 puntos
export function calcularPuntos(totalElegible, config) {
  if (!config || !config.activo) return 0;
  if (!totalElegible || totalElegible <= 0) return 0;
  const monto = parseFloat(config.monto_por_punto);
  if (!monto || monto <= 0) return 0;
  return Math.floor(totalElegible / monto);
}

// ─── Configuración ────────────────────────────────────────────────────────────
export async function obtenerConfig(tenantId = DEFAULT_TENANT) {
  const { rows } = await pool.query(
    'SELECT * FROM rewards_config WHERE tenant_id = $1',
    [tenantId]
  );
  return rows[0] || null;
}

export async function actualizarConfig(tenantId = DEFAULT_TENANT, datos) {
  const camposPermitidos = [
    'nombre_programa','activo','monto_por_punto','puntos_por_peso',
    'canje_minimo','canal_mostrador','canal_whatsapp','canal_telefono',
    'canal_rappi','vigencia_dias'
  ];
  const campos = Object.keys(datos).filter(c => camposPermitidos.includes(c));
  if (!campos.length) return;
  const valores = campos.map(c => datos[c]);
  const set = campos.map((c, i) => `${c} = $${i + 2}`).join(', ');
  await pool.query(
    `UPDATE rewards_config SET ${set}, updated_at = NOW() WHERE tenant_id = $1`,
    [tenantId, ...valores]
  );
}

// ─── Cuentas de cliente ───────────────────────────────────────────────────────
// Único punto de contacto con la tabla `clientes`.
// Al migrar a UUID, solo esta función cambia.
export async function obtenerOCrearCuenta(telefono, tenantId = DEFAULT_TENANT) {
  // Verificar que el cliente existe en tabla clientes (evita FK violada)
  const { rows: [cliente] } = await pool.query(
    'SELECT telefono, nombre FROM clientes WHERE telefono = $1',
    [telefono]
  );
  if (!cliente) throw new Error(`[Rewards] Cliente ${telefono} no existe en tabla clientes`);

  const { rows: [cuenta] } = await pool.query(
    `INSERT INTO rewards_accounts (telefono, tenant_id)
     VALUES ($1, $2)
     ON CONFLICT (telefono, tenant_id) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [telefono, tenantId]
  );
  return cuenta;
}

export async function obtenerCuentaPorTelefono(telefono, tenantId = DEFAULT_TENANT) {
  const { rows } = await pool.query(
    'SELECT * FROM rewards_accounts WHERE telefono = $1 AND tenant_id = $2',
    [telefono, tenantId]
  );
  return rows[0] || null;
}

// ─── Acumulación automática ───────────────────────────────────────────────────
// Llamada desde orderManager.js cuando estado = 'entregado'.
// Se ejecuta en background (fire-and-forget con try/catch en orderManager).
// Si falla aquí, la venta ya quedó archivada — nunca bloquea el flujo crítico.
export async function acumularPuntos(folio, pedido, tenantId = DEFAULT_TENANT) {
  // 1. Configuración
  const config = await obtenerConfig(tenantId);
  if (!config || !config.activo) {
    console.log(`[Rewards] Desactivado — sin puntos para ${folio}`);
    return null;
  }

  // 2. Canal habilitado
  const canal = pedido.canal || 'presencial';
  const mapaCanal = {
    presencial: config.canal_mostrador,
    whatsapp:   config.canal_whatsapp,
    voz:        config.canal_telefono,
    rappi:      config.canal_rappi,
  };
  if (!mapaCanal[canal]) {
    console.log(`[Rewards] Canal '${canal}' no habilitado — sin puntos para ${folio}`);
    return null;
  }

  // 3. Cliente real asignado (no '—', no vacío, no falso)
  const telefono = pedido.cliente?.telefono;
  if (!telefono || telefono === '—' || telefono.length < 7) {
    console.log(`[Rewards] Sin cliente válido — sin puntos para ${folio}`);
    return null;
  }

  // 4. Total elegible: descontar propina y monto canjeado (no se acumulan puntos sobre puntos)
  // Buscar si hubo canje en este folio para excluir ese monto del eligible
  let montoCanjeado = 0;
  try {
    const { rows: [canjePrev] } = await pool.query(
      `SELECT metadata FROM rewards_movements
       WHERE folio_venta = $1 AND tipo = 'canje' AND tenant_id = $2`,
      [folio, tenantId]
    );
    if (canjePrev?.metadata) {
      const meta = typeof canjePrev.metadata === 'string'
        ? JSON.parse(canjePrev.metadata) : canjePrev.metadata;
      montoCanjeado = parseFloat(meta.monto_descuento || 0);
    }
  } catch (_) { /* sin canje previo — continuar */ }

  const totalElegible = Math.max(0,
    parseFloat(pedido.total || 0) - parseFloat(pedido.propina || 0) - montoCanjeado
  );
  const puntos = calcularPuntos(totalElegible, config);
  if (puntos <= 0) {
    console.log(`[Rewards] $${totalElegible.toFixed(2)} elegible = 0 puntos — ${folio}`);
    return null;
  }

  // 5. Transacción con lock: crear/actualizar cuenta → movimiento → balance
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Obtener o crear cuenta
    const { rows: [cuentaBase] } = await client.query(
      `INSERT INTO rewards_accounts (telefono, tenant_id)
       VALUES ($1, $2)
       ON CONFLICT (telefono, tenant_id) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      [telefono, tenantId]
    );

    // Lock de fila para evitar race conditions en lecturas concurrentes
    const { rows: [cuenta] } = await client.query(
      'SELECT * FROM rewards_accounts WHERE id = $1 FOR UPDATE',
      [cuentaBase.id]
    );

    const balanceAnterior  = cuenta.puntos_balance;
    const balancePosterior = balanceAnterior + puntos;

    // Registrar movimiento — UNIQUE(tenant_id, folio_venta, tipo) impide duplicados
    await client.query(
      `INSERT INTO rewards_movements
         (account_id, tenant_id, tipo, puntos, balance_anterior, balance_posterior,
          folio_venta, usuario, motivo, metadata)
       VALUES ($1, $2, 'acumulacion', $3, $4, $5, $6, 'sistema',
               'Acumulación automática por venta', $7)`,
      [
        cuenta.id, tenantId, puntos,
        balanceAnterior, balancePosterior,
        folio,
        JSON.stringify({ total_venta: pedido.total, canal, cliente: telefono })
      ]
    );

    // Actualizar balance del cliente
    await client.query(
      `UPDATE rewards_accounts
       SET puntos_balance = $1,
           puntos_acumulados_total = puntos_acumulados_total + $2,
           updated_at = NOW()
       WHERE id = $3`,
      [balancePosterior, puntos, cuenta.id]
    );

    await client.query('COMMIT');
    console.log(`[Rewards] ✅ ${folio} — ${telefono} +${puntos} pts → balance: ${balancePosterior}`);

    // Notificar al cliente por WhatsApp (fire-and-forget, nunca bloquea)
    const nivelActual = calcularNivel((cuenta.puntos_acumulados_total || 0) + puntos);
    import('../channels/whatsapp-meta.js').then(({ enviarMensaje }) => {
      const msgNivel = nivelActual.siguiente
        ? `Faltan ${nivelActual.falta} pts para llegar a ${nivelActual.siguiente} ${nivelActual.nombre === 'Bronze' ? '🥈' : '🥇'}`
        : '¡Eres miembro Gold! 🏆';
      const msg = `🎉 ¡Ganaste *${puntos} puntos* en Xabor!\n\nTu saldo: *${balancePosterior} pts* ${nivelActual.emoji} ${nivelActual.nombre}\n${msgNivel}`;
      return enviarMensaje(telefono, msg);
    }).catch(e => console.error('[Rewards] Error enviando notif WA:', e.message));

    return { puntos, balancePosterior, telefono };

  } catch (e) {
    await client.query('ROLLBACK');
    // Violación de unique = ya se procesó antes. Silencioso e idempotente.
    if (e.code === '23505') {
      console.log(`[Rewards] Duplicado ignorado — ${folio} ya tenía acumulación`);
      return null;
    }
    // Cualquier otro error: loguear con contexto suficiente para diagnóstico
    console.error(`[Rewards] ❌ Error acumulando puntos — folio:${folio} cliente:${telefono}`, e.message);
    throw e;
  } finally {
    client.release();
  }
}

// ─── Estadísticas generales (panel admin) ────────────────────────────────────
export async function obtenerResumenRewards(tenantId = DEFAULT_TENANT) {
  // saldo_total se calcula por separado para evitar fan-out del LEFT JOIN
  const { rows: [stats] } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM rewards_accounts WHERE tenant_id = $1 AND activo)            AS clientes_inscritos,
      COALESCE(SUM(m.puntos) FILTER (WHERE m.tipo = 'acumulacion'), 0)                   AS puntos_emitidos,
      COALESCE(SUM(ABS(m.puntos)) FILTER (WHERE m.tipo = 'canje'), 0)                    AS puntos_canjeados,
      (SELECT COALESCE(SUM(puntos_balance),0) FROM rewards_accounts WHERE tenant_id = $1) AS saldo_total
    FROM rewards_movements m
    WHERE m.tenant_id = $1
  `, [tenantId]);

  return {
    clientes_inscritos: parseInt(stats.clientes_inscritos || 0),
    puntos_emitidos:    parseInt(stats.puntos_emitidos    || 0),
    puntos_canjeados:   parseInt(stats.puntos_canjeados   || 0),
    saldo_total:        parseInt(stats.saldo_total        || 0),
  };
}

// ─── Búsqueda de clientes ─────────────────────────────────────────────────────
export async function buscarClientesRewards(q, tenantId = DEFAULT_TENANT) {
  const buscar = `%${(q || '').trim()}%`;
  const { rows } = await pool.query(`
    SELECT
      c.telefono, c.nombre, c.ultima_visita,
      a.id AS account_id, a.puntos_balance, a.puntos_acumulados_total,
      a.activo AS rewards_activo, a.created_at AS rewards_desde
    FROM clientes c
    LEFT JOIN rewards_accounts a ON a.telefono = c.telefono AND a.tenant_id = $1
    WHERE (c.nombre ILIKE $2 OR c.telefono ILIKE $2)
      AND c.telefono != '—'
      AND NOT COALESCE(c.es_interno, FALSE)
    ORDER BY c.ultima_visita DESC NULLS LAST
    LIMIT 20
  `, [tenantId, buscar]);
  return rows;
}

// ─── Lista de clientes inscritos ──────────────────────────────────────────────
export async function listarClientesRewards(tenantId = DEFAULT_TENANT) {
  const { rows } = await pool.query(`
    SELECT
      c.telefono, c.nombre, c.ultima_visita,
      a.id AS account_id, a.puntos_balance, a.puntos_acumulados_total,
      a.activo AS rewards_activo, a.created_at AS rewards_desde
    FROM rewards_accounts a
    JOIN clientes c ON c.telefono = a.telefono
    WHERE a.tenant_id = $1
      AND NOT COALESCE(c.es_interno, FALSE)
    ORDER BY a.puntos_balance DESC
    LIMIT 200
  `, [tenantId]);
  return rows;
}

// ─── Perfil de un cliente ─────────────────────────────────────────────────────
export async function obtenerPerfilRewards(telefono, tenantId = DEFAULT_TENANT) {
  const { rows: [perfil] } = await pool.query(`
    SELECT
      c.telefono, c.nombre, c.ultima_visita,
      a.id AS account_id, a.puntos_balance, a.puntos_acumulados_total,
      a.puntos_canjeados_total, a.activo AS rewards_activo, a.created_at AS rewards_desde
    FROM clientes c
    LEFT JOIN rewards_accounts a ON a.telefono = c.telefono AND a.tenant_id = $1
    WHERE c.telefono = $2
  `, [tenantId, telefono]);
  if (!perfil) return null;
  perfil.nivel = calcularNivel(perfil.puntos_acumulados_total);
  return perfil;
}

// ─── Movimientos de un cliente ────────────────────────────────────────────────
export async function obtenerMovimientosCliente(accountId, limit = 50) {
  const { rows } = await pool.query(`
    SELECT id, tipo, puntos, balance_anterior, balance_posterior,
           folio_venta, usuario, motivo, created_at
    FROM rewards_movements
    WHERE account_id = $1
    ORDER BY created_at DESC
    LIMIT $2
  `, [accountId, limit]);
  return rows;
}

// ─── Movimientos recientes (panel admin) ─────────────────────────────────────
export async function obtenerMovimientosRecientes(tenantId = DEFAULT_TENANT, limit = 30) {
  const { rows } = await pool.query(`
    SELECT
      m.id, m.tipo, m.puntos, m.balance_posterior,
      m.folio_venta, m.created_at,
      c.nombre, c.telefono
    FROM rewards_movements m
    JOIN rewards_accounts a ON a.id = m.account_id
    JOIN clientes c ON c.telefono = a.telefono
    WHERE m.tenant_id = $1
    ORDER BY m.created_at DESC
    LIMIT $2
  `, [tenantId, limit]);
  return rows;
}

// ─── Cálculo de bloques disponibles para canje (usado en POS) ────────────────
// Retorna cuántos puntos puede canjear el cliente en bloques de config.canje_minimo
// sin exceder el total de la venta.
export function calcularBloquesDisponibles(puntosBalance, totalVenta, config) {
  if (!config || !config.activo) return { bloques: 0, puntos: 0, valor: 0 };
  const min   = parseInt(config.canje_minimo) || 100;
  const valor = parseFloat(config.puntos_por_peso) || 0.5;
  const valorPorBloque = min * valor;
  if (valorPorBloque <= 0) return { bloques: 0, puntos: 0, valor: 0 };
  const bloquesPorBalance = Math.floor(puntosBalance / min);
  const bloquesPorTotal   = Math.floor(totalVenta / valorPorBloque);
  const bloques = Math.min(bloquesPorBalance, bloquesPorTotal);
  return { bloques, puntos: bloques * min, valor: bloques * valorPorBloque };
}

// ─── Registrar canje en POS ───────────────────────────────────────────────────
// Se llama SINCRÓNICAMENTE cuando el staff confirma un pedido con puntos aplicados.
// Retorna { puntos, monto, balancePosterior } o null si ya fue procesado.
// Lanza error si saldo insuficiente o puntos inválidos — el caller debe manejarlos.
export async function registrarCanje(folio, telefono, puntosACanjear, usuario, tenantId = DEFAULT_TENANT) {
  const config = await obtenerConfig(tenantId);
  if (!config || !config.activo) throw new Error('Rewards desactivado');

  const min = parseInt(config.canje_minimo) || 100;
  if (puntosACanjear % min !== 0)   throw new Error(`Los puntos deben ser múltiplo de ${min}`);
  if (puntosACanjear <= 0)           throw new Error('Puntos a canjear deben ser positivos');

  const montoCanje = puntosACanjear * parseFloat(config.puntos_por_peso);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [cuenta] } = await client.query(
      'SELECT * FROM rewards_accounts WHERE telefono = $1 AND tenant_id = $2 FOR UPDATE',
      [telefono, tenantId]
    );
    if (!cuenta)                          throw new Error('Cuenta Rewards no encontrada');
    if (cuenta.puntos_balance < puntosACanjear) throw new Error('Saldo insuficiente');

    const balanceAnterior  = cuenta.puntos_balance;
    const balancePosterior = balanceAnterior - puntosACanjear;

    await client.query(
      `INSERT INTO rewards_movements
         (account_id, tenant_id, tipo, puntos, balance_anterior, balance_posterior,
          folio_venta, usuario, motivo, metadata)
       VALUES ($1, $2, 'canje', $3, $4, $5, $6, $7, 'Canje de puntos en venta', $8)`,
      [
        cuenta.id, tenantId, -puntosACanjear,
        balanceAnterior, balancePosterior,
        folio, usuario || 'operador',
        JSON.stringify({ monto_descuento: montoCanje, puntos_canjeados: puntosACanjear })
      ]
    );

    await client.query(
      `UPDATE rewards_accounts
       SET puntos_balance = $1,
           puntos_canjeados_total = puntos_canjeados_total + $2,
           updated_at = NOW()
       WHERE id = $3`,
      [balancePosterior, puntosACanjear, cuenta.id]
    );

    await client.query('COMMIT');
    console.log(`[Rewards] Canje: ${folio} — ${telefono} -${puntosACanjear} pts ($${montoCanje} desc)`);
    return { puntos: puntosACanjear, monto: montoCanje, balancePosterior };

  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') {
      console.log(`[Rewards] Canje duplicado ignorado — ${folio}`);
      return null;
    }
    throw e;
  } finally {
    client.release();
  }
}

// ─── Revertir movimientos de un folio (al cancelar una venta) ────────────────
// Crea un movimiento tipo 'reverso' por cada movimiento original del folio.
// Fire-and-forget desde el endpoint de cancelación — la cancelación siempre procede.
// El saldo nunca queda en negativo (se recorta a 0).
export async function revertirMovimientosFolio(folio, tenantId = DEFAULT_TENANT) {
  const { rows: movimientos } = await pool.query(
    `SELECT m.*, a.telefono
     FROM rewards_movements m
     JOIN rewards_accounts a ON a.id = m.account_id
     WHERE m.folio_venta = $1 AND m.tenant_id = $2
       AND m.tipo IN ('acumulacion','canje')`,
    [folio, tenantId]
  );

  if (!movimientos.length) {
    console.log(`[Rewards] Sin movimientos que revertir para ${folio}`);
    return null;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const mov of movimientos) {
      // Evitar reverso duplicado por movimiento original
      const { rows: [existeReverso] } = await client.query(
        `SELECT id FROM rewards_movements
         WHERE tenant_id = $1 AND tipo = 'reverso'
           AND metadata->>'movimiento_original_id' = $2`,
        [tenantId, String(mov.id)]
      );
      if (existeReverso) {
        console.log(`[Rewards] Reverso ya existe para mov ${mov.id} — skip`);
        continue;
      }

      const { rows: [cuenta] } = await client.query(
        'SELECT * FROM rewards_accounts WHERE id = $1 FOR UPDATE',
        [mov.account_id]
      );
      if (!cuenta) continue;

      // puntos del movimiento original pueden ser negativos (canje) o positivos (acumulacion)
      const puntosReverso   = -mov.puntos; // invertir el signo
      const balAnterior     = cuenta.puntos_balance;
      const balPosterior    = Math.max(0, balAnterior + puntosReverso);
      const puntosEfectivos = balPosterior - balAnterior;

      await client.query(
        `INSERT INTO rewards_movements
           (account_id, tenant_id, tipo, puntos, balance_anterior, balance_posterior,
            folio_venta, usuario, motivo, metadata)
         VALUES ($1, $2, 'reverso', $3, $4, $5, $6, 'sistema', $7, $8)`,
        [
          cuenta.id, tenantId, puntosEfectivos,
          balAnterior, balPosterior,
          folio,
          `Reverso por cancelación de venta ${folio}`,
          JSON.stringify({ movimiento_original_id: String(mov.id), tipo_original: mov.tipo })
        ]
      );

      await client.query(
        `UPDATE rewards_accounts SET puntos_balance = $1, updated_at = NOW() WHERE id = $2`,
        [balPosterior, cuenta.id]
      );

      // Ajustar acumulados históricos
      if (mov.tipo === 'acumulacion') {
        await client.query(
          `UPDATE rewards_accounts
           SET puntos_acumulados_total = GREATEST(0, puntos_acumulados_total + $1)
           WHERE id = $2`,
          [puntosEfectivos, cuenta.id]
        );
      } else if (mov.tipo === 'canje') {
        // revertir canje devuelve puntos → reduce canjeados_total
        await client.query(
          `UPDATE rewards_accounts
           SET puntos_canjeados_total = GREATEST(0, puntos_canjeados_total - $1)
           WHERE id = $2`,
          [mov.puntos * -1, cuenta.id] // mov.puntos era negativo, negarlo = positivo = lo que se canjeó
        );
      }
    }

    await client.query('COMMIT');
    console.log(`[Rewards] ✅ Reverso completado para ${folio}`);
    return true;

  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`[Rewards] ❌ Error revertiendo ${folio}:`, e.message);
    throw e;
  } finally {
    client.release();
  }
}

// ─── Ajuste manual de puntos (solo admin) ────────────────────────────────────
// tipo: 'ajuste_positivo' | 'ajuste_negativo'
// motivo: obligatorio, se guarda en el movimiento
export async function ajustarPuntosManual(telefono, puntos, tipo, motivo, usuario, tenantId = DEFAULT_TENANT) {
  if (!['ajuste_positivo', 'ajuste_negativo'].includes(tipo)) {
    throw new Error('Tipo de ajuste inválido');
  }
  if (!motivo?.trim()) throw new Error('El motivo es obligatorio');
  puntos = parseInt(puntos);
  if (!puntos || puntos <= 0) throw new Error('Los puntos deben ser un entero positivo');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [cuenta] } = await client.query(
      'SELECT * FROM rewards_accounts WHERE telefono = $1 AND tenant_id = $2 FOR UPDATE',
      [telefono, tenantId]
    );
    if (!cuenta) throw new Error('Cuenta Rewards no encontrada');

    const delta         = tipo === 'ajuste_positivo' ? puntos : -puntos;
    const balAnterior   = cuenta.puntos_balance;
    const balPosterior  = Math.max(0, balAnterior + delta);

    await client.query(
      `INSERT INTO rewards_movements
         (account_id, tenant_id, tipo, puntos, balance_anterior, balance_posterior,
          folio_venta, usuario, motivo)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8)`,
      [cuenta.id, tenantId, tipo, delta, balAnterior, balPosterior, usuario, motivo.trim()]
    );

    await client.query(
      `UPDATE rewards_accounts SET puntos_balance = $1, updated_at = NOW() WHERE id = $2`,
      [balPosterior, cuenta.id]
    );

    await client.query('COMMIT');
    console.log(`[Rewards] Ajuste manual: ${telefono} ${tipo} ${puntos} pts (${motivo}) por ${usuario}`);
    return { balanceAnterior: balAnterior, balancePosterior: balPosterior };

  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
