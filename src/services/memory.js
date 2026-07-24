/**
 * XABOR Memory Engine — Servicio de Memoria
 *
 * Tres responsabilidades:
 * 1. Escribir eventos al event log (Capa 1)
 * 2. Consultar y actualizar perfiles computados (Capa 2)
 * 3. Gestionar oportunidades comerciales
 *
 * Este módulo no importa ni modifica ningún componente crítico.
 * Es consultado por brain.js (lectura) y por jobs en background (escritura).
 */

import { pool } from './database.js';

// ─── CAPA 1: Event Log ────────────────────────────────────────────────────────

/**
 * Registrar cualquier evento en el log inmutable.
 * Nunca lanza excepción — falla silenciosamente para no bloquear flujos críticos.
 */
export async function registrarEvento({ tipo, entidad_tipo, entidad_id, payload = {}, canal, sesion_id }) {
  try {
    await pool.query(
      `INSERT INTO eventos (tipo_evento, entidad_tipo, entidad_id, payload, canal, sesion_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tipo, entidad_tipo, entidad_id, JSON.stringify(payload), canal || null, sesion_id || null]
    );
  } catch (e) {
    // Silencioso: el event log nunca debe bloquear el flujo operacional
    console.error('[Memory] Error registrando evento:', e.message);
  }
}

// Tipos de eventos predefinidos para consistencia
export const EVENTOS = {
  // Conversación
  MENSAJE_RECIBIDO:        'mensaje_recibido',
  MENU_SOLICITADO:         'menu_solicitado',
  PRECIO_CONSULTADO:       'precio_consultado',
  PEDIDO_INICIADO:         'pedido_iniciado',
  PEDIDO_CONFIRMADO:       'pedido_confirmado',
  PEDIDO_CANCELADO:        'pedido_cancelado',
  CLIENTE_NO_RESPONDIO:    'cliente_no_respondio',
  CLIENTE_REACTIVADO:      'cliente_reactivado',

  // Campañas
  MENSAJE_RECUPERACION_ENVIADO: 'mensaje_recuperacion_enviado',
  CAMPANA_ENVIADA:         'campana_enviada',
  CAMPANA_RESPONDIDA:      'campana_respondida',

  // Producto
  PRODUCTO_CONSULTADO:     'producto_consultado',
  PRODUCTO_PEDIDO:         'producto_pedido',
  PRODUCTO_RECHAZADO:      'producto_rechazado',

  // Negocio
  DECISION_NEGOCIO:        'decision_negocio',
  PRECIO_MODIFICADO:       'precio_modificado',
};

// ─── CAPA 2: Perfiles de Clientes ─────────────────────────────────────────────

/**
 * Obtener el perfil enriquecido de un cliente para inyectar en el contexto del agente.
 * Retorna null si el cliente no existe o no tiene perfil aún.
 */
export async function obtenerPerfilCliente(telefono) {
  try {
    const { rows } = await pool.query(
      `SELECT
        c.nombre,
        c.ultima_visita,
        p.pedidos_total,
        p.ticket_promedio,
        p.total_gastado,
        p.dias_entre_compras_prom,
        p.ultimo_pedido_hace_dias,
        p.dia_favorito,
        p.hora_favorita,
        p.modalidad_favorita,
        p.pago_favorito,
        p.productos_favoritos,
        p.segmento,
        p.score_abandono,
        p.acepta_promociones
       FROM clientes c
       LEFT JOIN perfiles_clientes p ON p.telefono = c.telefono
       WHERE c.telefono = $1`,
      [telefono]
    );
    return rows[0] || null;
  } catch (e) {
    console.error('[Memory] Error obteniendo perfil:', e.message);
    return null;
  }
}

/**
 * Construir el bloque de contexto que se inyecta en el system prompt del agente.
 * Retorna una cadena lista para incluir en el prompt, o cadena vacía si no hay datos.
 */
export function construirContextoCliente(perfil) {
  if (!perfil || !perfil.nombre) return '';

  const lineas = [];

  if (perfil.pedidos_total > 0) {
    lineas.push(`Cliente: ${perfil.nombre} | ${perfil.pedidos_total} pedido${perfil.pedidos_total > 1 ? 's' : ''} realizados`);

    if (perfil.ticket_promedio) {
      lineas.push(`Ticket promedio: $${Number(perfil.ticket_promedio).toFixed(0)} MXN | Total gastado: $${Number(perfil.total_gastado || 0).toFixed(0)} MXN`);
    }

    if (perfil.productos_favoritos?.length) {
      lineas.push(`Productos favoritos: ${perfil.productos_favoritos.join(', ')}`);
    }

    if (perfil.modalidad_favorita) {
      lineas.push(`Prefiere: ${perfil.modalidad_favorita} | Pago habitual: ${perfil.pago_favorito || 'variado'}`);
    }

    if (perfil.ultimo_pedido_hace_dias !== null && perfil.ultimo_pedido_hace_dias !== undefined) {
      const dias = perfil.ultimo_pedido_hace_dias;
      if (dias === 0) lineas.push('Compró hoy anteriormente.');
      else if (dias === 1) lineas.push('Última compra: ayer.');
      else lineas.push(`Última compra: hace ${dias} día${dias > 1 ? 's' : ''}.`);
    }

    if (perfil.dia_favorito) {
      lineas.push(`Suele comprar los ${perfil.dia_favorito}s.`);
    }

    if (perfil.segmento === 'vip') lineas.push('Segmento: Cliente VIP.');
    else if (perfil.segmento === 'en_riesgo') lineas.push('Segmento: Cliente en riesgo de abandono — trato especialmente cálido.');
    else if (perfil.segmento === 'dormido') lineas.push('Segmento: Cliente inactivo — lleva mucho tiempo sin comprar.');

  } else {
    // Cliente nuevo o sin historial de pedidos
    lineas.push(`Cliente: ${perfil.nombre} | Cliente nuevo, sin pedidos previos registrados.`);
  }

  if (lineas.length === 0) return '';

  return `\n[MEMORIA DEL CLIENTE]\n${lineas.join('\n')}\n[FIN MEMORIA]\n`;
}

/**
 * Calcular y guardar el perfil enriquecido de un cliente específico.
 * Se llama desde el job de enriquecimiento o después de cada pedido confirmado.
 */
export async function recalcularPerfilCliente(telefono) {
  try {
    // Calcular métricas desde pedidos_activos (fuente de verdad)
    const { rows: [metricas] } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE estado NOT IN ('cancelado')) AS pedidos_total,
        AVG((datos->>'total')::numeric) FILTER (WHERE estado NOT IN ('cancelado')) AS ticket_promedio,
        SUM((datos->>'total')::numeric) FILTER (WHERE estado NOT IN ('cancelado')) AS total_gastado,
        MAX(created_at) AS ultimo_pedido_at,
        NOW()::date - MAX(created_at)::date AS ultimo_pedido_hace_dias,
        -- Día de la semana favorito (0=domingo...6=sábado)
        MODE() WITHIN GROUP (ORDER BY EXTRACT(DOW FROM created_at))::int AS dia_favorito_num,
        MODE() WITHIN GROUP (ORDER BY EXTRACT(HOUR FROM created_at))::int AS hora_favorita,
        MODE() WITHIN GROUP (ORDER BY datos->>'modalidad') AS modalidad_favorita,
        MODE() WITHIN GROUP (ORDER BY datos->'pago'->>'metodo') AS pago_favorito
      FROM pedidos_activos
      WHERE datos->'cliente'->>'telefono' = $1
        AND estado NOT IN ('cancelado')
    `, [telefono]);

    if (!metricas || parseInt(metricas.pedidos_total) === 0) {
      // Sin pedidos: asegurar que existe en perfiles pero como 'nuevo'
      await pool.query(`
        INSERT INTO perfiles_clientes (telefono, segmento, ultima_actualizacion)
        VALUES ($1, 'nuevo', NOW())
        ON CONFLICT (telefono) DO UPDATE SET ultima_actualizacion = NOW()
      `, [telefono]);
      return;
    }

    // Calcular días promedio entre compras (si hay más de 1 pedido)
    const { rows: [intervalo] } = await pool.query(`
      SELECT AVG(diff) AS promedio_dias
      FROM (
        SELECT
          EXTRACT(EPOCH FROM (created_at - LAG(created_at) OVER (ORDER BY created_at))) / 86400 AS diff
        FROM pedidos_activos
        WHERE datos->'cliente'->>'telefono' = $1
          AND estado NOT IN ('cancelado')
      ) t
      WHERE diff IS NOT NULL
    `, [telefono]);

    // Top 3 productos favoritos
    const { rows: productos } = await pool.query(`
      SELECT item->>'nombre' AS nombre, COUNT(*) AS veces
      FROM pedidos_activos,
           jsonb_array_elements(datos->'items') AS item
      WHERE datos->'cliente'->>'telefono' = $1
        AND estado NOT IN ('cancelado')
      GROUP BY item->>'nombre'
      ORDER BY veces DESC
      LIMIT 3
    `, [telefono]);

    const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
    const diaFavorito = metricas.dia_favorito_num !== null ? dias[metricas.dia_favorito_num] : null;
    const pedidosTotal = parseInt(metricas.pedidos_total);
    const totalGastado = parseFloat(metricas.total_gastado || 0);
    const ticketPromedio = parseFloat(metricas.ticket_promedio || 0);
    const diasSinComprar = parseInt(metricas.ultimo_pedido_hace_dias || 0);
    const diasEntrePedidos = parseFloat(intervalo?.promedio_dias || 0);

    // Calcular score de abandono (0-100)
    // Si lleva más del doble de su ciclo promedio sin comprar → alto riesgo
    let scoreAbandono = 0;
    if (diasEntrePedidos > 0) {
      scoreAbandono = Math.min(100, Math.round((diasSinComprar / (diasEntrePedidos * 2)) * 100));
    } else if (diasSinComprar > 30) {
      scoreAbandono = Math.min(100, diasSinComprar);
    }

    // Determinar segmento
    let segmento = 'nuevo';
    if (pedidosTotal >= 10 || totalGastado >= 3000) {
      segmento = 'vip';
    } else if (pedidosTotal >= 3) {
      if (diasSinComprar > 45) segmento = 'dormido';
      else if (scoreAbandono >= 70) segmento = 'en_riesgo';
      else segmento = 'frecuente';
    } else if (pedidosTotal >= 1) {
      if (diasSinComprar > 30) segmento = 'dormido';
      else segmento = 'frecuente';
    }

    await pool.query(`
      INSERT INTO perfiles_clientes (
        telefono, pedidos_total, ticket_promedio, total_gastado,
        dias_entre_compras_prom, ultimo_pedido_hace_dias,
        dia_favorito, hora_favorita, modalidad_favorita, pago_favorito,
        productos_favoritos, segmento, score_abandono, ultima_actualizacion
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
      ON CONFLICT (telefono) DO UPDATE SET
        pedidos_total           = EXCLUDED.pedidos_total,
        ticket_promedio         = EXCLUDED.ticket_promedio,
        total_gastado           = EXCLUDED.total_gastado,
        dias_entre_compras_prom = EXCLUDED.dias_entre_compras_prom,
        ultimo_pedido_hace_dias = EXCLUDED.ultimo_pedido_hace_dias,
        dia_favorito            = EXCLUDED.dia_favorito,
        hora_favorita           = EXCLUDED.hora_favorita,
        modalidad_favorita      = EXCLUDED.modalidad_favorita,
        pago_favorito           = EXCLUDED.pago_favorito,
        productos_favoritos     = EXCLUDED.productos_favoritos,
        segmento                = EXCLUDED.segmento,
        score_abandono          = EXCLUDED.score_abandono,
        ultima_actualizacion    = NOW()
    `, [
      telefono,
      pedidosTotal,
      ticketPromedio,
      totalGastado,
      diasEntrePedidos || null,
      diasSinComprar,
      diaFavorito,
      metricas.hora_favorita,
      metricas.modalidad_favorita,
      metricas.pago_favorito,
      productos.map(p => p.nombre),
      segmento,
      scoreAbandono
    ]);

    console.log(`[Memory] Perfil actualizado: ${telefono} | segmento: ${segmento} | score: ${scoreAbandono}`);
  } catch (e) {
    console.error('[Memory] Error recalculando perfil:', e.message);
  }
}

/**
 * Job: enriquecer todos los perfiles de clientes activos.
 * Diseñado para correrse en background, nunca en el path de respuesta.
 */
export async function enriquecerTodosLosPerfiles() {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT datos->'cliente'->>'telefono' AS telefono
       FROM pedidos_activos
       WHERE datos->'cliente'->>'telefono' IS NOT NULL
         AND datos->'cliente'->>'telefono' != '—'
         AND datos->'cliente'->>'telefono' NOT LIKE 'rappi-%'
         AND datos->'cliente'->>'telefono' IN (SELECT telefono FROM clientes)`
    );

    console.log(`[Memory] Enriqueciendo ${rows.length} perfiles...`);
    let actualizados = 0;

    for (const { telefono } of rows) {
      if (telefono) {
        await recalcularPerfilCliente(telefono);
        actualizados++;
      }
    }

    console.log(`[Memory] ✅ ${actualizados} perfiles actualizados`);
    return actualizados;
  } catch (e) {
    console.error('[Memory] Error en enriquecimiento masivo:', e.message);
    return 0;
  }
}

// ─── Oportunidades ────────────────────────────────────────────────────────────

/**
 * Actualizar o crear el estado comercial de una conversación.
 */
export async function actualizarOportunidad(telefono, sesion_id, { estado, intent, valor_estimado, folio_pedido } = {}) {
  try {
    const existing = await pool.query(
      `SELECT id, intents_detectados FROM oportunidades
       WHERE sesion_id = $1 AND estado NOT IN ('cerrada_con_venta', 'perdida')
       LIMIT 1`,
      [sesion_id]
    );

    if (existing.rows.length > 0) {
      const { id, intents_detectados } = existing.rows[0];
      const intents = intents_detectados || [];
      if (intent && !intents.includes(intent)) intents.push(intent);

      await pool.query(`
        UPDATE oportunidades SET
          estado = COALESCE($1, estado),
          intents_detectados = $2,
          valor_estimado = COALESCE($3, valor_estimado),
          folio_pedido = COALESCE($4, folio_pedido),
          ultima_actividad_at = NOW(),
          cerrada_at = CASE WHEN $1 IN ('cerrada_con_venta', 'perdida', 'recuperada') THEN NOW() ELSE cerrada_at END
        WHERE id = $5
      `, [estado || null, intents, valor_estimado || null, folio_pedido || null, id]);
    } else {
      const intents = intent ? [intent] : [];
      await pool.query(`
        INSERT INTO oportunidades (telefono, sesion_id, estado, intents_detectados, valor_estimado, folio_pedido)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [telefono, sesion_id, estado || 'activa', intents, valor_estimado || null, folio_pedido || null]);
    }
  } catch (e) {
    console.error('[Memory] Error actualizando oportunidad:', e.message);
  }
}

/**
 * Obtener oportunidades pendientes para mostrar en el dashboard.
 */
export async function obtenerOportunidadesPendientes() {
  try {
    const { rows } = await pool.query(`
      SELECT
        o.id, o.telefono, o.intents_detectados, o.valor_estimado,
        o.ultima_actividad_at,
        EXTRACT(EPOCH FROM (NOW() - o.ultima_actividad_at))/60 AS minutos_inactiva,
        c.nombre,
        p.segmento, p.ticket_promedio
      FROM oportunidades o
      LEFT JOIN clientes c ON c.telefono = o.telefono
      LEFT JOIN perfiles_clientes p ON p.telefono = o.telefono
      WHERE o.estado = 'pendiente'
      ORDER BY p.segmento = 'vip' DESC, o.valor_estimado DESC NULLS LAST, o.ultima_actividad_at ASC
      LIMIT 50
    `);
    return rows;
  } catch (e) {
    console.error('[Memory] Error obteniendo oportunidades:', e.message);
    return [];
  }
}

/**
 * Job: detectar conversaciones que se volvieron oportunidades pendientes.
 * Corre cada 5-10 minutos en background.
 */
export async function detectarConversacionesAbandonadas(minutosUmbral = 30) {
  try {
    // Marcar como 'pendiente' oportunidades activas sin actividad reciente
    const { rowCount } = await pool.query(`
      UPDATE oportunidades SET estado = 'pendiente'
      WHERE estado = 'activa'
        AND array_length(intents_detectados, 1) > 0
        AND ultima_actividad_at < NOW() - ($1 || ' minutes')::interval
    `, [minutosUmbral]);

    if (rowCount > 0) {
      console.log(`[Memory] ${rowCount} conversaciones marcadas como oportunidades pendientes`);
    }
    return rowCount;
  } catch (e) {
    console.error('[Memory] Error detectando abandonos:', e.message);
    return 0;
  }
}
