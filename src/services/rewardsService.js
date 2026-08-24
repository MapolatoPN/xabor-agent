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

import { pool, obtenerEstadoModulo } from './database.js';

const DEFAULT_TENANT = 'xabor-principal';

// Mismo criterio de disponibilidad que requireModulo/moduloHabilitado en
// server.js/database.js -- 'activo' o 'configurado' cuentan como
// disponible. Rewards solo siembra 'activo' hoy, pero se comparte el
// mismo criterio por si en el futuro se usa 'configurado' para él.
const REWARDS_ESTADOS_DISPONIBLES = ['activo', 'configurado'];

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
// rewards_accounts (UNIQUE telefono+tenant_id) es la identidad propia de
// Rewards por negocio -- nombre incluido (columna propia, migración 015).
// `clientes` solo se consulta para confirmar que la fila exista (lo exige
// la FK rewards_accounts.telefono -> clientes.telefono); nunca se lee su
// `nombre` para mostrarlo, y nunca se asume que el negocio_id de esa fila
// coincide con el tenant que está inscribiendo -- el mismo teléfono puede
// ser cliente "dueño" de otro negocio en `clientes` y aun así tener aquí
// una cuenta de Rewards totalmente independiente para este tenant.
/**
 * Asegura que exista la fila de `clientes` a la que apunta la FK
 * `rewards_accounts.telefono -> clientes(telefono)`.
 *
 * Por qué hace falta: un cliente de WhatsApp siempre tiene fila (la crea la
 * conversación), pero uno que compra por POS, tienda web o Rappi puede no
 * tenerla nunca. La acumulación entonces reventaba con
 * `violates foreign key constraint rewards_accounts_telefono_fkey` y el
 * cliente se quedaba sin sus puntos aunque el pedido y el cobro hubieran
 * salido perfectos (incidente XAB-0180).
 *
 * Es DO NOTHING a propósito, no DO UPDATE: `clientes.telefono` es una PK
 * GLOBAL con una columna negocio_id. Si ese teléfono ya existe porque compró
 * en otro negocio, tocar la fila lo movería de negocio o le borraría el
 * nombre. Aquí solo hace falta que la fila EXISTA para que la FK se cumpla;
 * la identidad de Rewards es propia y vive en (telefono, tenant_id).
 *
 * Recibe el `client` de la transacción para que crear el cliente y acreditar
 * los puntos sean el mismo acto: o pasan los dos, o no pasa ninguno.
 */
async function asegurarClienteParaRewards(ejecutor, telefono, nombre, tenantId) {
  await ejecutor.query(
    `INSERT INTO clientes (telefono, nombre, ultima_visita, negocio_id)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (telefono) DO NOTHING`,
    [telefono, nombre || null, tenantId || null]);
}

export async function obtenerOCrearCuenta(telefono, nombre, tenantId = DEFAULT_TENANT) {
  // Antes esto lanzaba "Cliente no existe" y dejaba el alta manual sin
  // salida. Un teléfono que llega por aquí viene de una compra o de un alta
  // deliberada: se asegura la fila y se sigue, con la misma regla de arriba.
  await asegurarClienteParaRewards(pool, telefono, nombre, tenantId);

  // Conflicto en la UNIQUE (telefono, tenant_id) -- nunca en telefono solo:
  // el mismo teléfono en otro tenant_id no genera conflicto aquí, inserta
  // una fila nueva e independiente con su propio nombre. Cuando SÍ hay
  // conflicto, es porque este mismo negocio ya tenía una cuenta para este
  // teléfono -- ahí sí se permite corregir el nombre (COALESCE evita
  // borrarlo si esta llamada no trae uno nuevo).
  const { rows: [cuenta] } = await pool.query(
    `INSERT INTO rewards_accounts (telefono, tenant_id, nombre)
     VALUES ($1, $2, $3)
     ON CONFLICT (telefono, tenant_id)
     DO UPDATE SET nombre = COALESCE(EXCLUDED.nombre, rewards_accounts.nombre), updated_at = NOW()
     RETURNING *`,
    [telefono, tenantId, nombre || null]
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
  // 0. Módulo Rewards contratado y disponible para este negocio -- defensa
  // en profundidad independiente de rewards_config.activo (que es un flag
  // heredado, previo a negocio_modulos, y puede quedar desincronizado). Se
  // consulta negocio_modulos directamente vía obtenerEstadoModulo, nunca se
  // asume. Sin punto de entrada gateado aquí, un negocio sin Rewards
  // contratado podría acumular puntos igualmente porque esta función se
  // invoca desde el flujo de pedidos (fuera de las 11 rutas de
  // requireModulo('rewards')). Fallo seguro: sin más, no acumula.
  const estadoModulo = await obtenerEstadoModulo(tenantId, 'rewards');
  if (!REWARDS_ESTADOS_DISPONIBLES.includes(estadoModulo)) {
    console.log(`[Rewards] Módulo no disponible (estado=${estadoModulo || 'sin contratar'}) — sin puntos para ${folio}`);
    return null;
  }

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

    // La FK de rewards_accounts apunta a clientes: si ese teléfono nunca se
    // dio de alta (compra por POS, tienda web o Rappi), el INSERT de abajo
    // reventaría y el cliente perdería sus puntos. Se asegura primero, en la
    // MISMA transacción.
    await asegurarClienteParaRewards(client, telefono, pedido.cliente?.nombre, tenantId);

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

    // Registrar movimiento. El índice único parcial
    // (tenant_id, folio_venta, tipo) WHERE tipo IN ('acumulacion','canje')
    // es la garantía real de "una compra = una acumulación": un webhook
    // repetido, el reconciliador o un reintento no pueden acreditar dos
    // veces. Se declara ON CONFLICT DO NOTHING para que ese caso sea un
    // camino NORMAL y silencioso, en vez de una excepción que aborta la
    // transacción y se pierde en un catch.
    const movimiento = await client.query(
      `INSERT INTO rewards_movements
         (account_id, tenant_id, tipo, puntos, balance_anterior, balance_posterior,
          folio_venta, usuario, motivo, metadata)
       VALUES ($1, $2, 'acumulacion', $3, $4, $5, $6, 'sistema',
               'Acumulación automática por venta', $7)
       ON CONFLICT (tenant_id, folio_venta, tipo)
         WHERE tipo IN ('acumulacion','canje') DO NOTHING`,
      [
        cuenta.id, tenantId, puntos,
        balanceAnterior, balancePosterior,
        folio,
        JSON.stringify({ total_venta: pedido.total, canal, cliente: telefono })
      ]
    );

    if (movimiento.rowCount === 0) {
      // Ya se había acreditado esta venta. Se confirma sin tocar el balance:
      // el saldo del cliente no puede moverse dos veces por la misma compra.
      await client.query('COMMIT');
      console.log(`[Rewards] ${folio} ya tenía acumulación — no se acredita de nuevo`);
      return { puntos: 0, balancePosterior: balanceAnterior, telefono, yaAcreditado: true };
    }

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

    // Notificar al cliente por WhatsApp (fire-and-forget, nunca bloquea la
    // acumulación de puntos, que ya quedó confirmada arriba). Fix de
    // seguridad: antes llamaba a enviarMensaje() sin credenciales, lo que
    // usaba el caché global del motor del bot (mismo mecanismo que causó
    // el incidente de aislamiento de WhatsApp) -- CUALQUIER negocio con
    // Rewards activo habría notificado por el número de Nonna Maye. Ahora
    // se resuelven credenciales propias del negocio vía
    // obtenerCredencialesWhatsappNegocio (el mismo resolvedor ya validado
    // para el envío manual del panel, reutilizado tal cual, sin
    // modificarlo). Sin integración propia verificada, la notificación
    // simplemente se omite -- nunca cae a Nonna Maye ni a ningún caché
    // global, y la acumulación de puntos ya sucedió de todos modos.
    const nivelActual = calcularNivel((cuenta.puntos_acumulados_total || 0) + puntos);
    (async () => {
      const { obtenerCredencialesWhatsappNegocio } = await import('./database.js');
      const credenciales = await obtenerCredencialesWhatsappNegocio(tenantId);
      if (!credenciales) {
        console.log(`[Rewards] Notificación de puntos omitida — sin integración de WhatsApp propia para este negocio (folio ${folio})`);
        return;
      }
      const { enviarMensaje } = await import('../channels/whatsapp-meta.js');
      const msgNivel = nivelActual.siguiente
        ? `Faltan ${nivelActual.falta} pts para llegar a ${nivelActual.siguiente} ${nivelActual.nombre === 'Bronze' ? '🥈' : '🥇'}`
        : '¡Eres miembro Gold! 🏆';
      const msg = `🎉 ¡Ganaste *${puntos} puntos* en Xabor!\n\nTu saldo: *${balancePosterior} pts* ${nivelActual.emoji} ${nivelActual.nombre}\n${msgNivel}`;
      return enviarMensaje(telefono, msg, credenciales);
    })().catch(e => console.error(`[Rewards] Error enviando notificación de puntos (folio ${folio}):`, e.message));

    return { puntos, balancePosterior, telefono };

  } catch (e) {
    await client.query('ROLLBACK');
    // Violación de unique = ya se procesó antes. Silencioso e idempotente.
    if (e.code === '23505') {
      console.log(`[Rewards] Duplicado ignorado — ${folio} ya tenía acumulación`);
      return null;
    }
    // Cualquier otro error: línea estructurada y buscable. La acumulación es
    // idempotente, así que volver a dispararla para ese folio es seguro y es
    // la forma de recuperarla sin tocar la base a mano.
    console.error(`[Rewards] FALLO_ACUMULACION folio=${folio} negocio=${tenantId} cliente=${telefono} code=${e.code || 'sin_code'} constraint=${e.constraint || '-'} :: ${e.message}`);
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
// Arranca desde `rewards_accounts` (ya aislada por tenant_id), nunca desde
// `clientes` sin filtrar -- así nunca puede devolver un cliente de otro
// negocio, ni con datos de Rewards ni sin ellos. `clientes` solo aporta
// `ultima_visita` real (uso general, no específico de Rewards) cuando esa
// fila SÍ pertenece a este mismo negocio; si pertenece a otro, se omite
// (nunca se muestra ese dato ajeno).
export async function buscarClientesRewards(q, tenantId = DEFAULT_TENANT) {
  const buscar = `%${(q || '').trim()}%`;
  const { rows } = await pool.query(`
    SELECT
      a.telefono, a.nombre,
      CASE WHEN c.negocio_id::text = $1 THEN c.ultima_visita ELSE NULL END AS ultima_visita,
      a.id AS account_id, a.puntos_balance, a.puntos_acumulados_total,
      a.activo AS rewards_activo, a.created_at AS rewards_desde
    FROM rewards_accounts a
    LEFT JOIN clientes c ON c.telefono = a.telefono
    WHERE a.tenant_id = $1
      AND (a.nombre ILIKE $2 OR a.telefono ILIKE $2)
      AND a.telefono != '—'
    ORDER BY a.updated_at DESC NULLS LAST
    LIMIT 20
  `, [tenantId, buscar]);
  return rows;
}

// ─── Lista de clientes inscritos ──────────────────────────────────────────────
export async function listarClientesRewards(tenantId = DEFAULT_TENANT) {
  // LEFT JOIN solo para el flag es_interno (excluir clientes internos de
  // prueba de la lista, mismo comportamiento que ya existía) -- nunca para
  // nombre/ultima_visita, que ya vienen de la propia cuenta aislada.
  const { rows } = await pool.query(`
    SELECT
      a.telefono, a.nombre,
      a.id AS account_id, a.puntos_balance, a.puntos_acumulados_total,
      a.activo AS rewards_activo, a.created_at AS rewards_desde
    FROM rewards_accounts a
    LEFT JOIN clientes c ON c.telefono = a.telefono
    WHERE a.tenant_id = $1
      AND NOT COALESCE(c.es_interno, FALSE)
    ORDER BY a.puntos_balance DESC
    LIMIT 200
  `, [tenantId]);
  return rows;
}

// ─── Perfil de un cliente ─────────────────────────────────────────────────────
// Arranca desde rewards_accounts (aislada por tenant_id) -- si este
// negocio nunca inscribió ese teléfono, no existe perfil que mostrar,
// sin importar si el teléfono es cliente de otro negocio. "última
// actividad de Rewards" se deriva de la propia cuenta (updated_at),
// nunca de clientes.ultima_visita (ese campo es global entre negocios,
// no específico de Rewards -- ver decisión de producto).
export async function obtenerPerfilRewards(telefono, tenantId = DEFAULT_TENANT) {
  const { rows: [perfil] } = await pool.query(`
    SELECT
      a.telefono, a.nombre, a.updated_at AS ultima_actividad_rewards,
      a.id AS account_id, a.puntos_balance, a.puntos_acumulados_total,
      a.puntos_canjeados_total, a.activo AS rewards_activo, a.created_at AS rewards_desde
    FROM rewards_accounts a
    WHERE a.tenant_id = $1 AND a.telefono = $2
  `, [tenantId, telefono]);
  if (!perfil) return null;
  perfil.nivel = calcularNivel(perfil.puntos_acumulados_total);
  return perfil;
}

// ─── Movimientos de un cliente ────────────────────────────────────────────────
// tenantId es defensa en profundidad: el caller (server.js) ya resolvió
// account_id a través de una consulta filtrada por tenant_id, pero esta
// función vuelve a exigirlo explícitamente en su propio WHERE -- nunca
// confía únicamente en que el account_id que le llegó ya fue validado
// aguas arriba.
export async function obtenerMovimientosCliente(accountId, tenantId = DEFAULT_TENANT, limit = 50) {
  const { rows } = await pool.query(`
    SELECT m.id, m.tipo, m.puntos, m.balance_anterior, m.balance_posterior,
           m.folio_venta, m.usuario, m.motivo, m.created_at
    FROM rewards_movements m
    JOIN rewards_accounts a ON a.id = m.account_id
    WHERE m.account_id = $1 AND m.tenant_id = $2 AND a.tenant_id = $2
    ORDER BY m.created_at DESC
    LIMIT $3
  `, [accountId, tenantId, limit]);
  return rows;
}

// ─── Movimientos recientes (panel admin) ─────────────────────────────────────
export async function obtenerMovimientosRecientes(tenantId = DEFAULT_TENANT, limit = 30) {
  const { rows } = await pool.query(`
    SELECT
      m.id, m.tipo, m.puntos, m.balance_posterior,
      m.folio_venta, m.created_at,
      a.nombre, a.telefono
    FROM rewards_movements m
    JOIN rewards_accounts a ON a.id = m.account_id
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
  // 0. Mismo gate de negocio_modulos que acumularPuntos -- el canje
  // también se dispara desde el flujo de pedidos (POS presencial), fuera
  // de las rutas gateadas por requireModulo('rewards').
  const estadoModulo = await obtenerEstadoModulo(tenantId, 'rewards');
  if (!REWARDS_ESTADOS_DISPONIBLES.includes(estadoModulo)) {
    throw new Error('Rewards no está contratado para este negocio');
  }

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

// ─── Consultar el canje ya registrado de un folio ────────────────────────────
// Para cobros reintentados (reingeniería UX): registrarCanje es idempotente
// por folio (idx_rewards_movements_no_dup) y devuelve null en el duplicado;
// esta lectura recupera puntos y monto del canje original sin volver a mover
// saldo. Devuelve null si el folio no tiene canje.
export async function obtenerCanjeDeFolio(folio, tenantId = DEFAULT_TENANT) {
  const { rows } = await pool.query(
    `SELECT puntos, metadata FROM rewards_movements
     WHERE folio_venta = $1 AND tenant_id = $2 AND tipo = 'canje'
     LIMIT 1`,
    [folio, tenantId]
  );
  if (!rows.length) return null;
  const meta = rows[0].metadata || {};
  return {
    puntos: Math.abs(parseInt(rows[0].puntos, 10) || 0),
    monto: parseFloat(meta.monto_descuento) || 0,
  };
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
