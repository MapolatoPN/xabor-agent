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

  // 4. Total elegible: total de la venta, sin propina
  const totalElegible = parseFloat(pedido.total || 0) - parseFloat(pedido.propina || 0);
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
  const { rows: [stats] } = await pool.query(`
    SELECT
      COUNT(DISTINCT a.id) FILTER (WHERE a.activo)                       AS clientes_inscritos,
      COALESCE(SUM(m.puntos) FILTER (WHERE m.tipo = 'acumulacion'), 0)   AS puntos_emitidos,
      COALESCE(SUM(ABS(m.puntos)) FILTER (WHERE m.tipo = 'canje'), 0)    AS puntos_canjeados,
      COALESCE(SUM(a.puntos_balance), 0)                                  AS saldo_total
    FROM rewards_accounts a
    LEFT JOIN rewards_movements m ON m.account_id = a.id AND m.tenant_id = $1
    WHERE a.tenant_id = $1
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
  return perfil || null;
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
