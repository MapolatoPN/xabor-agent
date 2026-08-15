// ─── Motor de promociones de Xabor ────────────────────────────────────────
//
// El navegador NUNCA decide un descuento: manda a lo sumo un código y el
// servidor decide si aplica, cuánto y en qué orden. Todo cálculo vive aquí.
//
// Multiempresa por diseño: cada promoción pertenece a un negocio y el código
// es único POR NEGOCIO (índice idx_promo_negocio_codigo). Dos restaurantes
// pueden tener "SOFIA15" con reglas distintas sin verse entre sí.
//
// Reutilizable: el motor recibe un contexto neutro (subtotal, items, canal,
// modalidad, cliente) y no sabe nada de HTTP ni de la tienda. Cuando otro
// canal quiera promociones, se le pasa `canal: 'whatsapp'` y funciona.
import { pool } from './database.js';
import { partesEnZona } from './tiendaOnline.js';

export class PromocionError extends Error {
  constructor(mensaje, codigo) { super(mensaje); this.codigo = codigo; }
}

const dinero = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── Elegibilidad de UNA promoción ─────────────────────────────────────────
// Devuelve null si aplica, o un motivo legible si no. El motivo solo se le
// muestra al cliente cuando escribió un código explícitamente; las
// automáticas fallan en silencio.
function motivoNoAplica(promo, ctx) {
  if (!promo.activa) return 'Esta promoción ya no está disponible';

  const canales = Array.isArray(promo.canales) ? promo.canales : ['tienda_online'];
  if (!canales.includes(ctx.canal)) return 'Este código no aplica en esta tienda';

  if (Array.isArray(promo.modalidades) && promo.modalidades.length &&
      !promo.modalidades.includes(ctx.modalidad)) {
    return promo.modalidades.includes('domicilio')
      ? 'Este código solo aplica en pedidos a domicilio'
      : 'Este código solo aplica en pedidos para recoger';
  }

  const ahora = ctx.ahora || new Date();
  if (promo.vigencia_desde && ahora < new Date(promo.vigencia_desde)) return 'Esta promoción aún no comienza';
  if (promo.vigencia_hasta && ahora > new Date(promo.vigencia_hasta)) return 'Esta promoción ya venció';

  // Día y hora se evalúan en la zona horaria del negocio, no del navegador.
  const { diaSemana, minutos } = partesEnZona(ahora, ctx.timezone);
  if (Array.isArray(promo.dias_semana) && promo.dias_semana.length &&
      !promo.dias_semana.map(Number).includes(diaSemana)) {
    return 'Esta promoción no aplica hoy';
  }
  const aMin = (t) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const ini = aMin(promo.hora_inicio), fin = aMin(promo.hora_fin);
  if (ini !== null && fin !== null && (minutos < ini || minutos >= fin)) {
    return `Esta promoción aplica de ${promo.hora_inicio} a ${promo.hora_fin}`;
  }

  const baseAplicable = baseParaPromo(promo, ctx);
  if (Number(promo.minimo_compra) > 0 && ctx.subtotal < Number(promo.minimo_compra)) {
    const faltan = dinero(Number(promo.minimo_compra) - ctx.subtotal);
    return `Te faltan $${faltan} para usar esta promoción`;
  }
  if (baseAplicable <= 0) return 'Tu pedido no tiene productos que apliquen a esta promoción';

  if (promo.limite_usos != null && Number(promo.usos) >= Number(promo.limite_usos)) {
    return 'Esta promoción alcanzó su límite de usos';
  }
  if (promo.solo_primera_compra && ctx.clienteTienePedidos) {
    return 'Esta promoción es solo para la primera compra';
  }
  if (promo.limite_por_cliente != null && ctx.usosDelCliente != null &&
      ctx.usosDelCliente[promo.id] >= Number(promo.limite_por_cliente)) {
    return 'Ya usaste esta promoción el máximo de veces';
  }
  return null;
}

// Base sobre la que se calcula: todo el subtotal, o solo los productos/
// categorías incluidos si la promoción está acotada.
function baseParaPromo(promo, ctx) {
  const prods = Array.isArray(promo.productos) ? promo.productos.map(Number) : null;
  const cats = Array.isArray(promo.categorias) ? promo.categorias.map(Number) : null;
  if ((!prods || !prods.length) && (!cats || !cats.length)) return ctx.subtotal;
  return dinero((ctx.items || []).reduce((s, it) => {
    const incluido = (prods && prods.includes(Number(it.producto_id))) ||
                     (cats && cats.includes(Number(it.categoria_id)));
    return incluido ? s + (Number(it.precio_unitario) || 0) * (Number(it.cantidad) || 1) : s;
  }, 0));
}

function calcularDescuento(promo, ctx) {
  if (promo.tipo === 'envio_gratis') {
    return { descuento: 0, envioGratis: true };
  }
  const base = baseParaPromo(promo, ctx);
  let d = promo.tipo === 'porcentaje'
    ? dinero(base * (Number(promo.valor) / 100))
    : dinero(Number(promo.valor));
  if (promo.max_descuento != null) d = Math.min(d, dinero(promo.max_descuento));
  d = Math.min(d, base); // nunca descuenta más de lo que cuesta
  return { descuento: d, envioGratis: false };
}

// ── Motor: aplica automáticas + código, resuelve acumulación ──────────────
// Reglas de acumulación:
//   · Se ordenan por prioridad (menor primero) y se aplican en ese orden.
//   · Una promoción no acumulable descarta a las demás del mismo tipo de
//     beneficio: se queda la que más le conviene al cliente.
//   · Envío gratis y descuento sí conviven (son beneficios distintos).
export async function calcularPromociones({
  negocioId, subtotal, items = [], costoEnvio = 0, modalidad = 'recoger',
  codigo = null, telefono = null, canal = 'tienda_online', timezone = 'America/Matamoros',
  ahora = new Date(),
}) {
  const sub = dinero(subtotal);
  const { rows } = await pool.query(
    `SELECT * FROM tienda_promociones
      WHERE negocio_id = $1 AND activa = TRUE
        AND (automatica = TRUE OR ($2::text IS NOT NULL AND lower(codigo) = lower($2)))
      ORDER BY prioridad ASC, created_at ASC`,
    [negocioId, codigo || null]
  );

  // Historial del cliente: solo si hay teléfono (invitado sin teléfono no
  // puede reclamar promociones de primera compra ni límites por cliente).
  let clienteTienePedidos = false;
  let usosDelCliente = {};
  if (telefono) {
    const [{ rows: previos }, { rows: usos }] = await Promise.all([
      pool.query(
        `SELECT 1 FROM pedidos_activos
          WHERE negocio_id = $1 AND datos->'cliente'->>'telefono' = $2 LIMIT 1`,
        [negocioId, telefono]
      ),
      pool.query(
        `SELECT promocion_id, COUNT(*)::int AS n FROM tienda_promocion_usos
          WHERE negocio_id = $1 AND cliente_telefono = $2 GROUP BY promocion_id`,
        [negocioId, telefono]
      ),
    ]);
    clienteTienePedidos = previos.length > 0;
    usosDelCliente = Object.fromEntries(usos.map(u => [u.promocion_id, u.n]));
  }

  const ctx = { subtotal: sub, items, modalidad, canal, timezone, ahora, clienteTienePedidos, usosDelCliente };

  const aplicadas = [];
  const rechazos = [];
  let envioGratis = false;
  let bloqueadoPorNoAcumulable = false;

  for (const promo of rows) {
    const motivo = motivoNoAplica(promo, ctx);
    if (motivo) {
      // Solo se le explica al cliente el código que él escribió.
      if (codigo && promo.codigo && promo.codigo.toLowerCase() === codigo.toLowerCase()) {
        rechazos.push({ codigo: promo.codigo, motivo });
      }
      continue;
    }
    if (bloqueadoPorNoAcumulable && promo.tipo !== 'envio_gratis') continue;

    const { descuento, envioGratis: gratis } = calcularDescuento(promo, ctx);
    if (gratis) {
      if (modalidad !== 'domicilio') continue; // envío gratis no significa nada al recoger
      envioGratis = true;
    } else if (descuento <= 0) {
      continue;
    }
    aplicadas.push({
      id: promo.id,
      campaniaId: promo.campania_id || null,
      nombre: promo.nombre,
      codigo: promo.codigo || null,
      tipo: promo.tipo,
      descuento,
      envioGratis: gratis,
      automatica: promo.automatica === true,
    });
    if (!promo.acumulable && promo.tipo !== 'envio_gratis') bloqueadoPorNoAcumulable = true;
  }

  // Si escribió un código y no quedó aplicado ni rechazado con motivo, no existe.
  if (codigo && !aplicadas.some(a => a.codigo && a.codigo.toLowerCase() === codigo.toLowerCase()) &&
      !rechazos.length) {
    rechazos.push({ codigo, motivo: 'Ese código no existe o ya no está disponible' });
  }

  const descuentoTotal = dinero(aplicadas.reduce((s, a) => s + a.descuento, 0));
  const envioBase = modalidad === 'domicilio' ? dinero(costoEnvio) : 0;
  const envioFinal = envioGratis ? 0 : envioBase;
  const total = Math.max(0, dinero(sub - descuentoTotal + envioFinal));

  return {
    subtotal: sub,
    descuento: descuentoTotal,
    envio: envioFinal,
    envioBase,
    envioGratis,
    total,
    ahorro: dinero(descuentoTotal + (envioGratis ? envioBase : 0)),
    aplicadas,
    rechazos,
  };
}

// ── Pista comercial: "te faltan $X para envío gratis" ─────────────────────
// Se calcula con las MISMAS reglas del motor, no con un número inventado en
// el frontend.
export async function pistaEnvioGratis({ negocioId, subtotal, modalidad, canal = 'tienda_online' }) {
  if (modalidad !== 'domicilio') return null;
  const { rows } = await pool.query(
    `SELECT nombre, minimo_compra FROM tienda_promociones
      WHERE negocio_id = $1 AND activa = TRUE AND tipo = 'envio_gratis' AND automatica = TRUE
        AND canales @> $2::jsonb
      ORDER BY minimo_compra ASC`,
    [negocioId, JSON.stringify([canal])]
  );
  if (!rows.length) return null;
  const sub = dinero(subtotal);
  const alcanzada = rows.find(r => sub >= Number(r.minimo_compra));
  if (alcanzada) return { logrado: true, mensaje: '🎉 ¡Ya tienes envío gratis!' };
  const siguiente = rows[0];
  const faltan = dinero(Number(siguiente.minimo_compra) - sub);
  return { logrado: false, faltan, mensaje: `Te faltan $${faltan} para obtener envío gratis` };
}

// ── Registro de uso (idempotente) ─────────────────────────────────────────
// Se llama UNA vez al confirmar el pedido. El UNIQUE (negocio, promoción,
// folio) hace que un reintento del checkout no infle usos ni ventas.
export async function registrarUsosPromociones({
  negocioId, folio, aplicadas = [], telefono = null, montoVenta = 0, clienteNuevo = false,
}) {
  if (!aplicadas.length) return { registrados: 0 };
  const client = await pool.connect();
  let registrados = 0;
  try {
    await client.query('BEGIN');
    for (const a of aplicadas) {
      const { rowCount } = await client.query(
        `INSERT INTO tienda_promocion_usos
           (negocio_id, promocion_id, campania_id, pedido_folio, cliente_telefono,
            monto_descuento, monto_venta, cliente_nuevo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (negocio_id, promocion_id, pedido_folio) DO NOTHING`,
        [negocioId, a.id, a.campaniaId, folio, telefono,
         a.descuento || 0, montoVenta, !!clienteNuevo]
      );
      if (rowCount > 0) {
        registrados++;
        // El contador solo sube cuando el uso se insertó de verdad.
        await client.query(
          `UPDATE tienda_promociones SET usos = usos + 1, updated_at = NOW()
            WHERE id = $1 AND negocio_id = $2`,
          [a.id, negocioId]
        );
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Tienda] Error registrando usos de promoción:', e.message);
  } finally {
    client.release();
  }
  return { registrados };
}

// ── CRUD de promociones (backoffice) ──────────────────────────────────────
const TIPOS = ['envio_gratis', 'porcentaje', 'monto_fijo'];

export async function listarPromociones(negocioId) {
  const { rows } = await pool.query(
    `SELECT p.*, c.nombre AS campania_nombre, c.influencer,
            COALESCE(u.ventas, 0) AS ventas_generadas,
            COALESCE(u.descuento, 0) AS descuento_otorgado,
            COALESCE(u.n, 0) AS usos_reales,
            COALESCE(u.nuevos, 0) AS clientes_nuevos
       FROM tienda_promociones p
       LEFT JOIN tienda_campanas c ON c.id = p.campania_id
       LEFT JOIN (
         SELECT promocion_id, COUNT(*)::int AS n,
                SUM(monto_venta)::numeric AS ventas,
                SUM(monto_descuento)::numeric AS descuento,
                COUNT(*) FILTER (WHERE cliente_nuevo)::int AS nuevos
           FROM tienda_promocion_usos WHERE negocio_id = $1 GROUP BY promocion_id
       ) u ON u.promocion_id = p.id
      WHERE p.negocio_id = $1
      ORDER BY p.activa DESC, p.created_at DESC`,
    [negocioId]
  );
  return rows.map(r => ({
    id: r.id, nombre: r.nombre, tipo: r.tipo, codigo: r.codigo,
    automatica: r.automatica, valor: Number(r.valor),
    minimoCompra: Number(r.minimo_compra), maxDescuento: r.max_descuento == null ? null : Number(r.max_descuento),
    vigenciaDesde: r.vigencia_desde, vigenciaHasta: r.vigencia_hasta,
    limiteUsos: r.limite_usos, limitePorCliente: r.limite_por_cliente,
    soloPrimeraCompra: r.solo_primera_compra, acumulable: r.acumulable, prioridad: r.prioridad,
    activa: r.activa,
    campania: r.campania_id ? { id: r.campania_id, nombre: r.campania_nombre, influencer: r.influencer } : null,
    metricas: {
      usos: Number(r.usos_reales),
      ventas: Number(r.ventas_generadas),
      descuento: Number(r.descuento_otorgado),
      clientesNuevos: Number(r.clientes_nuevos),
      ticketPromedio: Number(r.usos_reales) ? dinero(Number(r.ventas_generadas) / Number(r.usos_reales)) : 0,
    },
  }));
}

export async function guardarPromocion(negocioId, datos = {}, promocionId = null) {
  const tipo = String(datos.tipo || '').trim();
  if (!TIPOS.includes(tipo)) throw new PromocionError('Tipo de promoción inválido', 'TIPO_INVALIDO');
  const nombre = String(datos.nombre || '').trim();
  if (!nombre) throw new PromocionError('La promoción necesita un nombre', 'SIN_NOMBRE');

  const automatica = !!datos.automatica;
  let codigo = String(datos.codigo || '').trim().toUpperCase() || null;
  if (!automatica && !codigo) throw new PromocionError('Una promoción con código necesita el código', 'SIN_CODIGO');
  if (codigo && !/^[A-Z0-9][A-Z0-9._-]{1,29}$/.test(codigo)) {
    throw new PromocionError('El código solo admite letras, números, punto, guion y guion bajo', 'CODIGO_INVALIDO');
  }
  if (automatica) codigo = codigo || null;

  const valor = Number(datos.valor) || 0;
  if (tipo === 'porcentaje' && (valor <= 0 || valor > 100)) {
    throw new PromocionError('El porcentaje debe estar entre 1 y 100', 'VALOR_INVALIDO');
  }
  if (tipo === 'monto_fijo' && valor <= 0) {
    throw new PromocionError('El descuento debe ser mayor a cero', 'VALOR_INVALIDO');
  }

  const campos = {
    nombre, tipo, codigo, automatica, valor,
    minimo_compra: Math.max(0, Number(datos.minimoCompra) || 0),
    max_descuento: datos.maxDescuento == null || datos.maxDescuento === '' ? null : Number(datos.maxDescuento),
    vigencia_desde: datos.vigenciaDesde || null,
    vigencia_hasta: datos.vigenciaHasta || null,
    dias_semana: datos.diasSemana ? JSON.stringify(datos.diasSemana.map(Number)) : null,
    hora_inicio: datos.horaInicio || null,
    hora_fin: datos.horaFin || null,
    limite_usos: datos.limiteUsos == null || datos.limiteUsos === '' ? null : parseInt(datos.limiteUsos, 10),
    limite_por_cliente: datos.limitePorCliente == null || datos.limitePorCliente === '' ? null : parseInt(datos.limitePorCliente, 10),
    solo_primera_compra: !!datos.soloPrimeraCompra,
    canales: JSON.stringify(Array.isArray(datos.canales) && datos.canales.length ? datos.canales : ['tienda_online']),
    modalidades: datos.modalidades ? JSON.stringify(datos.modalidades) : null,
    productos: datos.productos ? JSON.stringify(datos.productos.map(Number)) : null,
    categorias: datos.categorias ? JSON.stringify(datos.categorias.map(Number)) : null,
    acumulable: datos.acumulable !== false,
    prioridad: Number.isFinite(Number(datos.prioridad)) ? Number(datos.prioridad) : 100,
    activa: datos.activa !== false,
    campania_id: datos.campaniaId || null,
  };

  // La campaña debe ser del MISMO negocio: nunca se atribuye a la campaña de otro.
  if (campos.campania_id) {
    const { rows } = await pool.query(
      `SELECT 1 FROM tienda_campanas WHERE id = $1 AND negocio_id = $2`,
      [campos.campania_id, negocioId]);
    if (!rows.length) throw new PromocionError('La campaña no pertenece a este negocio', 'CAMPANIA_AJENA');
  }

  const cols = Object.keys(campos);
  const vals = cols.map(c => campos[c]);
  try {
    if (promocionId) {
      const { rowCount } = await pool.query(
        `UPDATE tienda_promociones SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}, updated_at = NOW()
          WHERE id = $1 AND negocio_id = $2`,
        [promocionId, negocioId, ...vals]
      );
      if (!rowCount) throw new PromocionError('Promoción no encontrada', 'NO_ENCONTRADA');
      return { id: promocionId };
    }
    const { rows } = await pool.query(
      `INSERT INTO tienda_promociones (negocio_id, ${cols.join(', ')})
       VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
      [negocioId, ...vals]
    );
    return { id: rows[0].id };
  } catch (e) {
    if (e.code === '23505') throw new PromocionError('Ya existe una promoción con ese código en este negocio', 'CODIGO_DUPLICADO');
    throw e;
  }
}

export async function eliminarPromocion(negocioId, promocionId) {
  const { rowCount } = await pool.query(
    `UPDATE tienda_promociones SET activa = FALSE, updated_at = NOW()
      WHERE id = $1 AND negocio_id = $2`,
    [promocionId, negocioId]
  );
  return rowCount > 0;
}

// ── Campañas / influencers ────────────────────────────────────────────────
export async function listarCampanas(negocioId) {
  const { rows } = await pool.query(
    `SELECT c.*,
            COALESCE(u.n, 0) AS usos, COALESCE(u.ventas, 0) AS ventas,
            COALESCE(u.descuento, 0) AS descuento, COALESCE(u.nuevos, 0) AS clientes_nuevos
       FROM tienda_campanas c
       LEFT JOIN (
         SELECT campania_id, COUNT(*)::int AS n, SUM(monto_venta)::numeric AS ventas,
                SUM(monto_descuento)::numeric AS descuento,
                COUNT(*) FILTER (WHERE cliente_nuevo)::int AS nuevos
           FROM tienda_promocion_usos WHERE negocio_id = $1 AND campania_id IS NOT NULL
          GROUP BY campania_id
       ) u ON u.campania_id = c.id
      WHERE c.negocio_id = $1
      ORDER BY c.activa DESC, c.created_at DESC`,
    [negocioId]
  );
  return rows.map(c => ({
    id: c.id, nombre: c.nombre, influencer: c.influencer, contacto: c.contacto,
    notas: c.notas, activa: c.activa,
    metricas: {
      usos: Number(c.usos), ventas: Number(c.ventas), descuento: Number(c.descuento),
      clientesNuevos: Number(c.clientes_nuevos),
      clientesRecurrentes: Number(c.usos) - Number(c.clientes_nuevos),
      ticketPromedio: Number(c.usos) ? dinero(Number(c.ventas) / Number(c.usos)) : 0,
    },
  }));
}

export async function guardarCampana(negocioId, datos = {}, campaniaId = null) {
  const nombre = String(datos.nombre || '').trim();
  if (!nombre) throw new PromocionError('La campaña necesita un nombre', 'SIN_NOMBRE');
  const campos = {
    nombre,
    influencer: String(datos.influencer || '').trim() || null,
    contacto: String(datos.contacto || '').trim() || null,
    notas: String(datos.notas || '').trim() || null,
    activa: datos.activa !== false,
  };
  const cols = Object.keys(campos);
  const vals = cols.map(c => campos[c]);
  try {
    if (campaniaId) {
      const { rowCount } = await pool.query(
        `UPDATE tienda_campanas SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}, updated_at = NOW()
          WHERE id = $1 AND negocio_id = $2`,
        [campaniaId, negocioId, ...vals]);
      if (!rowCount) throw new PromocionError('Campaña no encontrada', 'NO_ENCONTRADA');
      return { id: campaniaId };
    }
    const { rows } = await pool.query(
      `INSERT INTO tienda_campanas (negocio_id, ${cols.join(', ')})
       VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
      [negocioId, ...vals]);
    return { id: rows[0].id };
  } catch (e) {
    if (e.code === '23505') throw new PromocionError('Ya existe una campaña con ese nombre', 'NOMBRE_DUPLICADO');
    throw e;
  }
}
