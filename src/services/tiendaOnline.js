// ─── Tienda Online: resolución de tienda, catálogo público y apertura ──────
//
// Módulo SaaS: una sola base de código sirve a todas las tiendas. Dar de alta
// un negocio nuevo es activar el módulo `tienda_online` y configurar — nunca
// tocar este archivo. Aquí NO hay ningún nombre de restaurante, ningún id
// hardcodeado y ninguna credencial: todo sale de la fila del negocio.
//
// Lo que este servicio NO hace (a propósito, para no duplicar motores):
//   · precios y modificadores  → posEnvios.recalcularItemsDesdeMenu
//   · creación de pedidos      → orders/orderManager (registrarPedido/emitirPedido)
//   · impresión                → services/impresionService (vía emitirPedido)
//   · métodos de pago          → database.obtenerMetodosPagoDisponibles
//   · horarios/envío/zonas     → configuracion.reglas_atencion (fuente única
//     que ya usan POS y bot; la tienda LEE, no redefine)
import { pool } from './database.js';

// Zona horaria: hoy el modelo de negocios no tiene columna de timezone (deuda
// conocida). En vez de esparcir un literal por el código, se resuelve por
// negocio desde `configuracion.timezone` si existe y, si no, se cae a este
// default explícito. Cuando exista negocios.timezone, se cambia SOLO aquí.
const TZ_DEFAULT = process.env.XABOR_TZ_DEFAULT || 'America/Matamoros';

export class TiendaError extends Error {
  constructor(mensaje, codigo, status = 400) {
    super(mensaje);
    this.codigo = codigo;
    this.status = status;
  }
}

const MODALIDADES_VALIDAS = ['recoger', 'domicilio'];
export const MODALIDAD_A_PEDIDO = {
  recoger: 'recoger en tienda',
  domicilio: 'entrega a domicilio',
};

// ── Resolución del tenant ─────────────────────────────────────────────────
// El slug es lo ÚNICO que llega del navegador y nunca se confía en un
// negocio_id de la petición. La resolución es fail-closed en cuatro puertas:
// el negocio existe y está activo, tiene el módulo contratado, y su tienda
// está publicada (pausada/borrador no atienden).
//
// Preparado para dominios propios: esta función recibe un identificador
// abstracto, no un path. Cuando se agregue `pedidos.negocio.com`, se resuelve
// el host a un slug antes de llamar aquí y el resto del checkout no cambia.
export async function resolverTienda(identificador, { exigirPublicada = true } = {}) {
  const slug = String(identificador || '').trim().toLowerCase();
  if (!slug || slug.length > 120 || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new TiendaError('Tienda no encontrada', 'SLUG_INVALIDO', 404);
  }
  // Un slug propio de tienda (tienda_config.slug_publico) gana sobre el slug
  // interno del negocio; ambos son únicos a nivel plataforma.
  const { rows } = await pool.query(
    `SELECT n.id, n.nombre, n.slug, n.activo, n.estado,
            t.estado AS tienda_estado, t.slug_publico, t.titular, t.descripcion,
            t.color_primario, t.logo_url, t.portada_url, t.modalidades,
            t.acepta_programados, t.anticipacion_minutos, t.mensaje_bienvenida
       FROM negocios n
       LEFT JOIN tienda_config t ON t.negocio_id = n.id
      WHERE lower(t.slug_publico) = $1 OR lower(n.slug) = $1
      ORDER BY (lower(t.slug_publico) = $1) DESC
      LIMIT 1`,
    [slug]
  );
  const row = rows[0];
  if (!row) throw new TiendaError('Tienda no encontrada', 'NO_EXISTE', 404);
  if (!row.activo || row.estado === 'suspendido') {
    throw new TiendaError('Tienda no disponible', 'NEGOCIO_INACTIVO', 404);
  }

  const { obtenerEstadoModulo } = await import('./database.js');
  const estadoModulo = await obtenerEstadoModulo(row.id, 'tienda_online');
  if (!['activo', 'contratado'].includes(estadoModulo)) {
    // 404 y no 403: una tienda sin el módulo no debe ser distinguible de una
    // inexistente desde fuera.
    throw new TiendaError('Tienda no encontrada', 'MODULO_NO_CONTRATADO', 404);
  }

  const estadoTienda = row.tienda_estado || 'borrador';
  if (exigirPublicada && estadoTienda !== 'publicada') {
    throw new TiendaError(
      estadoTienda === 'pausada' ? 'La tienda está temporalmente pausada' : 'Tienda no encontrada',
      estadoTienda === 'pausada' ? 'TIENDA_PAUSADA' : 'TIENDA_NO_PUBLICADA',
      estadoTienda === 'pausada' ? 503 : 404
    );
  }

  return {
    negocioId: row.id,
    negocioNombre: row.nombre,
    slug: row.slug_publico || row.slug,
    estadoTienda,
    branding: {
      titular: row.titular || row.nombre,
      descripcion: row.descripcion || null,
      color: row.color_primario || null,
      logo: row.logo_url || null,
      portada: row.portada_url || null,
      bienvenida: row.mensaje_bienvenida || null,
    },
    modalidades: normalizarModalidades(row.modalidades),
    aceptaProgramados: row.acepta_programados === true,
    anticipacionMinutos: Number(row.anticipacion_minutos) || 30,
  };
}

function normalizarModalidades(valor) {
  const arr = Array.isArray(valor) ? valor : [];
  const limpias = arr.map(v => String(v).toLowerCase()).filter(v => MODALIDADES_VALIDAS.includes(v));
  return limpias.length ? [...new Set(limpias)] : ['recoger'];
}

// ── Reglas operativas del negocio (fuente única) ──────────────────────────
export async function reglasDelNegocio(negocioId) {
  const { rows } = await pool.query(
    `SELECT clave, valor FROM configuracion WHERE negocio_id = $1 AND clave IN ('reglas_atencion','timezone')`,
    [negocioId]
  );
  const mapa = new Map(rows.map(r => [r.clave, r.valor]));
  let reglas = {};
  try { reglas = JSON.parse(mapa.get('reglas_atencion') || '{}'); } catch { reglas = {}; }
  const p = reglas.pedidos || {};
  return {
    timezone: mapa.get('timezone') || TZ_DEFAULT,
    horarios: reglas.horarios || {},
    costoEnvioBase: Number(p.costo_envio) || 0,
    pedidoMinimo: Number(p.pedido_minimo_entrega) || 0,
    entregaGratisDesde: Number(p.entrega_gratis_desde) || 0,
    zonas: Array.isArray(p.zonas_entrega) ? p.zonas_entrega : [],
    preparacionMinutos: Number(p.tiempo_preparacion_minutos) || 20,
    entregaMin: Number(p.tiempo_entrega_min_minutos) || 30,
    entregaMax: Number(p.tiempo_entrega_max_minutos) || 45,
  };
}

// ── Estado de apertura ────────────────────────────────────────────────────
// "Tienda publicada" y "negocio abierto" son cosas distintas: una tienda
// publicada con el negocio cerrado sigue siendo visible y — según
// configuración — puede aceptar pedidos programados.
const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

export function partesEnZona(fecha, timezone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, weekday: 'short', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(fecha).map(x => [x.type, x.value]));
  const diaSemana = new Date(`${p.year}-${p.month}-${p.day}T12:00:00Z`).getUTCDay();
  return {
    fechaISO: `${p.year}-${p.month}-${p.day}`,
    minutos: Number(p.hour) * 60 + Number(p.minute),
    diaSemana,
    diaNombre: DIAS[diaSemana],
  };
}

const aMinutos = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

export function estadoApertura(reglas, ahora = new Date()) {
  const { diaNombre, minutos } = partesEnZona(ahora, reglas.timezone);
  const hoy = reglas.horarios?.[diaNombre];
  if (hoy?.abierto) {
    const ini = aMinutos(hoy.apertura), fin = aMinutos(hoy.cierre);
    if (ini !== null && fin !== null && minutos >= ini && minutos < fin) {
      return { abierto: true, cierraA: hoy.cierre };
    }
    if (ini !== null && minutos < ini) {
      return { abierto: false, abreA: hoy.apertura, cuando: 'hoy' };
    }
  }
  // Próximo día con horario
  const idx = DIAS.indexOf(diaNombre);
  for (let i = 1; i <= 7; i++) {
    const d = DIAS[(idx + i) % 7];
    const h = reglas.horarios?.[d];
    if (h?.abierto && aMinutos(h.apertura) !== null) {
      return { abierto: false, abreA: h.apertura, cuando: i === 1 ? 'mañana' : d };
    }
  }
  return { abierto: false, abreA: null, cuando: null };
}

// ── Catálogo público ──────────────────────────────────────────────────────
// Reutiliza el catálogo maestro: NO copia productos. `tienda_productos`
// solo decide qué se publica y permite overrides opcionales por canal.
export async function catalogoPublico(negocioId) {
  const { rows } = await pool.query(
    `SELECT c.id AS categoria_id, c.nombre AS categoria, c.orden AS categoria_orden,
            p.id, p.nombre, p.descripcion, p.precio, p.disponible, p.agotado, p.orden,
            tp.badge, tp.destacado, tp.descripcion_comercial, tp.imagen_url, tp.precio_tienda,
            tp.orden AS orden_tienda
       FROM menu_productos p
       JOIN menu_categorias c ON c.id = p.categoria_id AND c.negocio_id = p.negocio_id
       JOIN tienda_productos tp ON tp.producto_id = p.id AND tp.negocio_id = p.negocio_id
      WHERE p.negocio_id = $1 AND tp.publicado = TRUE AND c.activa = TRUE
      ORDER BY c.orden, c.nombre, tp.orden, p.orden, p.nombre`,
    [negocioId]
  );
  if (!rows.length) return [];

  const ids = rows.map(r => r.id);
  // Mismas columnas que usa el motor de modificadores del POS
  // (requerido/minimo/maximo): la tienda las MUESTRA y el servidor las
  // vuelve a imponer al cobrar vía recalcularItemsDesdeMenu.
  const { rows: grupos } = await pool.query(
    `SELECT g.id, g.producto_id, g.nombre, g.requerido, g.minimo, g.maximo, g.orden,
            o.id AS opcion_id, o.nombre AS opcion, o.precio_extra, o.disponible AS opcion_disponible,
            o.orden AS opcion_orden
       FROM menu_modificadores_grupos g
       LEFT JOIN menu_modificadores_opciones o ON o.grupo_id = g.id AND o.negocio_id = g.negocio_id
      WHERE g.negocio_id = $1 AND g.producto_id = ANY($2::int[])
      ORDER BY g.orden, g.id, o.orden, o.id`,
    [negocioId, ids]
  ).catch(() => ({ rows: [] }));

  const gruposPorProducto = new Map();
  for (const g of grupos) {
    if (!gruposPorProducto.has(g.producto_id)) gruposPorProducto.set(g.producto_id, new Map());
    const mapa = gruposPorProducto.get(g.producto_id);
    if (!mapa.has(g.id)) {
      mapa.set(g.id, {
        id: g.id, nombre: g.nombre,
        requerido: g.requerido === true,
        min: Number(g.minimo) || 0,
        max: g.maximo == null ? null : Number(g.maximo),
        opciones: [],
      });
    }
    if (g.opcion_id && g.opcion_disponible !== false) {
      mapa.get(g.id).opciones.push({
        id: g.opcion_id, nombre: g.opcion, precioExtra: Number(g.precio_extra) || 0,
      });
    }
  }

  const categorias = new Map();
  for (const r of rows) {
    if (!categorias.has(r.categoria_id)) {
      categorias.set(r.categoria_id, { id: r.categoria_id, nombre: r.categoria, productos: [] });
    }
    const gruposProd = [...(gruposPorProducto.get(r.id)?.values() || [])].filter(g => g.opciones.length);
    categorias.get(r.categoria_id).productos.push({
      id: r.id,
      nombre: r.nombre,
      descripcion: r.descripcion_comercial || r.descripcion || null,
      // El precio que se muestra es el del catálogo (o su override de canal);
      // el que se cobra lo recalcula SIEMPRE el servidor al hacer checkout.
      precio: Number(r.precio_tienda ?? r.precio),
      imagen: r.imagen_url || null,
      badge: r.badge || null,
      destacado: r.destacado === true,
      agotado: r.agotado === true || r.disponible === false,
      grupos: gruposProd,
    });
  }
  return [...categorias.values()];
}

// ── Métodos de pago realmente disponibles para la tienda ──────────────────
// Nunca se inventan proveedores: si el negocio no tiene un método habilitado,
// la tienda no lo ofrece.
export async function metodosPagoTienda(negocioId, modalidad) {
  const { rows } = await pool.query(
    `SELECT tipo, habilitado FROM metodos_pago WHERE negocio_id = $1 AND habilitado = TRUE`,
    [negocioId]
  );
  const habilitados = new Set(rows.map(r => r.tipo));
  const metodos = [];
  if (habilitados.has('efectivo')) {
    metodos.push({
      id: 'efectivo',
      etiqueta: modalidad === 'domicilio' ? 'Efectivo al recibir' : 'Efectivo al recoger',
      pagaDespues: true,
    });
  }
  if (habilitados.has('terminal')) {
    metodos.push({
      id: 'terminal',
      etiqueta: modalidad === 'domicilio' ? 'Tarjeta al recibir' : 'Tarjeta al recoger',
      pagaDespues: true,
    });
  }
  if (habilitados.has('transferencia')) {
    metodos.push({ id: 'transferencia', etiqueta: 'Transferencia', pagaDespues: true });
  }
  if (habilitados.has('enlace_pago')) {
    metodos.push({ id: 'enlace_pago', etiqueta: 'Pagar en línea', pagaDespues: false });
  }
  return metodos;
}

// ── Configuración de la tienda (backoffice) ───────────────────────────────
export async function obtenerConfigTienda(negocioId) {
  const { rows } = await pool.query(
    `SELECT t.*, n.slug AS slug_negocio, n.nombre AS negocio_nombre
       FROM negocios n LEFT JOIN tienda_config t ON t.negocio_id = n.id
      WHERE n.id = $1`,
    [negocioId]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    estado: r.estado || 'borrador',
    slug: r.slug_publico || r.slug_negocio,
    slugPublico: r.slug_publico || null,
    slugNegocio: r.slug_negocio,
    titular: r.titular || r.negocio_nombre,
    descripcion: r.descripcion || '',
    color: r.color_primario || '',
    logo: r.logo_url || '',
    portada: r.portada_url || '',
    modalidades: normalizarModalidades(r.modalidades),
    aceptaProgramados: r.acepta_programados === true,
    anticipacionMinutos: Number(r.anticipacion_minutos) || 30,
    mensajeBienvenida: r.mensaje_bienvenida || '',
    publicadaAt: r.publicada_at || null,
  };
}

const CAMPOS_CONFIG = {
  titular: 'titular', descripcion: 'descripcion', color: 'color_primario',
  logo: 'logo_url', portada: 'portada_url', mensajeBienvenida: 'mensaje_bienvenida',
};

export async function guardarConfigTienda(negocioId, cambios = {}) {
  const set = {};
  for (const [entrada, columna] of Object.entries(CAMPOS_CONFIG)) {
    if (cambios[entrada] !== undefined) set[columna] = String(cambios[entrada] || '').slice(0, 600) || null;
  }
  if (cambios.modalidades !== undefined) set.modalidades = JSON.stringify(normalizarModalidades(cambios.modalidades));
  if (cambios.aceptaProgramados !== undefined) set.acepta_programados = !!cambios.aceptaProgramados;
  if (cambios.anticipacionMinutos !== undefined) {
    const n = parseInt(cambios.anticipacionMinutos, 10);
    if (!Number.isFinite(n) || n < 0 || n > 1440) throw new TiendaError('Anticipación inválida', 'ANTICIPACION_INVALIDA');
    set.anticipacion_minutos = n;
  }
  if (cambios.slugPublico !== undefined) {
    const s = String(cambios.slugPublico || '').trim().toLowerCase();
    if (s && !/^[a-z0-9][a-z0-9-]{2,60}$/.test(s)) {
      throw new TiendaError('La dirección solo admite letras, números y guiones', 'SLUG_INVALIDO');
    }
    set.slug_publico = s || null;
  }

  const columnas = Object.keys(set);
  if (!columnas.length) return obtenerConfigTienda(negocioId);

  const asignaciones = columnas.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const valores = columnas.map(c => set[c]);
  try {
    await pool.query(
      `INSERT INTO tienda_config (negocio_id, ${columnas.join(', ')})
       VALUES ($1, ${columnas.map((_, i) => `$${i + 2}`).join(', ')})
       ON CONFLICT (negocio_id) DO UPDATE SET ${asignaciones}, updated_at = NOW()`,
      [negocioId, ...valores]
    );
  } catch (e) {
    if (e.code === '23505') throw new TiendaError('Esa dirección ya está ocupada', 'SLUG_OCUPADO', 409);
    throw e;
  }
  return obtenerConfigTienda(negocioId);
}

// ── Checklist de publicación ──────────────────────────────────────────────
// Calculado desde datos reales: una tienda incompleta no se publica en
// silencio, y el negocio ve exactamente qué le falta.
export async function checklistPublicacion(negocioId) {
  const [cfg, reglas, cat, metodos] = await Promise.all([
    obtenerConfigTienda(negocioId),
    reglasDelNegocio(negocioId),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM tienda_productos WHERE negocio_id = $1 AND publicado = TRUE`,
      [negocioId]
    ).then(r => r.rows[0].n),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM metodos_pago WHERE negocio_id = $1 AND habilitado = TRUE`,
      [negocioId]
    ).then(r => r.rows[0].n),
  ]);
  const { rows: [neg] } = await pool.query(
    `SELECT nombre, slug FROM negocios WHERE id = $1`, [negocioId]);
  const diasAbiertos = Object.values(reglas.horarios || {}).filter(h => h?.abierto).length;
  const domicilio = cfg?.modalidades?.includes('domicilio');

  const items = [
    { clave: 'negocio', etiqueta: 'Datos del negocio', listo: !!(neg?.nombre && neg?.slug) },
    { clave: 'horarios', etiqueta: 'Horarios de atención', listo: diasAbiertos > 0,
      detalle: diasAbiertos ? `${diasAbiertos} días con horario` : 'Sin horarios configurados' },
    { clave: 'identidad', etiqueta: 'Identidad de la tienda', listo: !!(cfg?.titular),
      detalle: cfg?.logo ? 'Con logo' : 'Sin logo (opcional)' },
    { clave: 'productos', etiqueta: 'Productos publicados', listo: cat > 0,
      detalle: cat ? `${cat} producto${cat !== 1 ? 's' : ''}` : 'Ningún producto publicado' },
    { clave: 'modalidades', etiqueta: 'Cómo recibe el cliente', listo: (cfg?.modalidades || []).length > 0,
      detalle: (cfg?.modalidades || []).join(' · ') },
    { clave: 'entregas', etiqueta: 'Entregas a domicilio', listo: !domicilio || reglas.costoEnvioBase >= 0,
      detalle: domicilio ? `Envío base $${reglas.costoEnvioBase}` : 'No aplica' },
    { clave: 'pagos', etiqueta: 'Métodos de pago', listo: metodos > 0,
      detalle: metodos ? `${metodos} habilitado${metodos !== 1 ? 's' : ''}` : 'Ninguno habilitado' },
  ];
  return { items, listaParaPublicar: items.every(i => i.listo), estado: cfg?.estado || 'borrador' };
}

export async function cambiarEstadoTienda(negocioId, nuevoEstado) {
  if (!['borrador', 'publicada', 'pausada'].includes(nuevoEstado)) {
    throw new TiendaError('Estado inválido', 'ESTADO_INVALIDO');
  }
  if (nuevoEstado === 'publicada') {
    const { listaParaPublicar, items } = await checklistPublicacion(negocioId);
    if (!listaParaPublicar) {
      const faltan = items.filter(i => !i.listo).map(i => i.etiqueta);
      throw new TiendaError(`Falta configurar: ${faltan.join(', ')}`, 'CHECKLIST_INCOMPLETO', 409);
    }
  }
  await pool.query(
    `INSERT INTO tienda_config (negocio_id, estado, publicada_at)
     VALUES ($1, $2, CASE WHEN $2 = 'publicada' THEN NOW() ELSE NULL END)
     ON CONFLICT (negocio_id) DO UPDATE
       SET estado = $2,
           publicada_at = CASE WHEN $2 = 'publicada' THEN COALESCE(tienda_config.publicada_at, NOW())
                               ELSE tienda_config.publicada_at END,
           updated_at = NOW()`,
    [negocioId, nuevoEstado]
  );
  return obtenerConfigTienda(negocioId);
}

// ── Publicación de productos ──────────────────────────────────────────────
export async function listarProductosPublicables(negocioId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.nombre, p.precio, p.disponible, p.agotado,
            c.nombre AS categoria,
            COALESCE(tp.publicado, FALSE) AS publicado,
            tp.badge, tp.destacado, tp.precio_tienda
       FROM menu_productos p
       JOIN menu_categorias c ON c.id = p.categoria_id AND c.negocio_id = p.negocio_id
       LEFT JOIN tienda_productos tp ON tp.producto_id = p.id AND tp.negocio_id = p.negocio_id
      WHERE p.negocio_id = $1
      ORDER BY c.orden, c.nombre, p.orden, p.nombre`,
    [negocioId]
  );
  return rows.map(r => ({
    id: r.id, nombre: r.nombre, categoria: r.categoria,
    precio: Number(r.precio), publicado: r.publicado === true,
    destacado: r.destacado === true, badge: r.badge || null,
    precioTienda: r.precio_tienda == null ? null : Number(r.precio_tienda),
    agotado: r.agotado === true || r.disponible === false,
  }));
}

// Publica o despublica productos. `productoIds` siempre se filtra contra el
// negocio: un id ajeno simplemente no coincide y no se escribe nada.
export async function publicarProductos(negocioId, productoIds, publicado) {
  const ids = (Array.isArray(productoIds) ? productoIds : []).map(Number).filter(Number.isFinite);
  if (!ids.length) return { actualizados: 0 };
  const { rowCount } = await pool.query(
    `INSERT INTO tienda_productos (negocio_id, producto_id, publicado)
     SELECT $1, p.id, $3 FROM menu_productos p WHERE p.negocio_id = $1 AND p.id = ANY($2::int[])
     ON CONFLICT (negocio_id, producto_id)
       DO UPDATE SET publicado = $3, updated_at = NOW()`,
    [negocioId, ids, !!publicado]
  );
  return { actualizados: rowCount };
}

export async function actualizarProductoTienda(negocioId, productoId, cambios = {}) {
  const pid = Number(productoId);
  if (!Number.isFinite(pid)) throw new TiendaError('Producto inválido', 'PRODUCTO_INVALIDO');
  const set = {};
  if (cambios.badge !== undefined) set.badge = String(cambios.badge || '').slice(0, 40) || null;
  if (cambios.destacado !== undefined) set.destacado = !!cambios.destacado;
  if (cambios.descripcionComercial !== undefined) {
    set.descripcion_comercial = String(cambios.descripcionComercial || '').slice(0, 500) || null;
  }
  if (cambios.imagenUrl !== undefined) set.imagen_url = String(cambios.imagenUrl || '').slice(0, 500) || null;
  if (cambios.precioTienda !== undefined) {
    if (cambios.precioTienda === null || cambios.precioTienda === '') set.precio_tienda = null;
    else {
      const n = Number(cambios.precioTienda);
      if (!Number.isFinite(n) || n < 0) throw new TiendaError('Precio inválido', 'PRECIO_INVALIDO');
      set.precio_tienda = Math.round(n * 100) / 100;
    }
  }
  const columnas = Object.keys(set);
  if (!columnas.length) return { ok: true };
  await pool.query(
    `INSERT INTO tienda_productos (negocio_id, producto_id, publicado, ${columnas.join(', ')})
     SELECT $1, p.id, TRUE, ${columnas.map((_, i) => `$${i + 3}`).join(', ')}
       FROM menu_productos p WHERE p.negocio_id = $1 AND p.id = $2
     ON CONFLICT (negocio_id, producto_id) DO UPDATE
       SET ${columnas.map((c, i) => `${c} = $${i + 3}`).join(', ')}, updated_at = NOW()`,
    [negocioId, pid, ...columnas.map(c => set[c])]
  );
  return { ok: true };
}
