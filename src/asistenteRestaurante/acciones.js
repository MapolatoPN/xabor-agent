// Asistente del restaurante, Mejora 1 (28-nov-2026, plan aprobado por el
// dueño): el botón de cada tarjeta de Reportes › Asistente.
//
// Reglas del dueño:
//   · «El asistente no ejecuta nada por sí solo. Los botones de acción solo
//     abren una pantalla ya existente con datos precargados; el usuario
//     confirma ahí.» Aquí no se manda, no se cambia ni se guarda nada del
//     negocio: solo se decide QUÉ pantalla abre cada tipo y con qué datos.
//   · Un botón principal por tipo; si no hay una acción real, no hay botón
//     (clientes_cambiaron).
//   · Se anota que se usó (tabla asistente_restaurante_acciones, la 166).
//
// Bandera por sucursal: asistente_restaurante_acciones_v1 = 'true'. Apagada,
// las tarjetas salen sin botón y Campañas no acepta el público de un aviso.
//
// Los clientes de «Preparar campaña» NO viajan al navegador: el panel manda
// el número del aviso y Campañas le pide aquí sus clientes (clientesDelAviso),
// siempre junto con el negocio de la sesión.
import { faltasDeAccion } from './reglas.js';

export const BANDERA_ACCIONES = 'asistente_restaurante_acciones_v1';
export const PASOS = Object.freeze(['abrio', 'creo_campana']);

// Lo que ve el cliente si el administrador deja el mensaje sugerido. Sin
// cifras ni datos de nadie; el administrador lo cambia en Campañas.
export const MENSAJES_SUGERIDOS = Object.freeze({
  clientes_dejaron: 'Hace tiempo que no te vemos y te extrañamos. ¡Te esperamos esta semana!',
  nuevos_regresan_menos: 'Gracias por tu primer pedido. ¡Nos encantará atenderte otra vez esta semana!',
});

const NOMBRE_CAMPANA = Object.freeze({
  clientes_dejaron: 'Clientes frecuentes que no han vuelto',
  nuevos_regresan_menos: 'Clientes nuevos: segunda visita',
});

// tipo → { clave, etiqueta, destino }. `destino` es la pestaña del panel.
export const ACCIONES = Object.freeze({
  clientes_dejaron: { clave: 'campana_clientes', etiqueta: 'Preparar campaña', destino: 'campanas' },
  nuevos_regresan_menos: { clave: 'campana_nuevos', etiqueta: 'Preparar campaña', destino: 'campanas' },
  producto_baja: { clave: 'menu_producto', etiqueta: 'Abrir en Menú', destino: 'menu' },
  producto_sube: { clave: 'menu_producto', etiqueta: 'Abrir en Menú', destino: 'menu' },
  categoria_baja: { clave: 'reporte_categoria', etiqueta: 'Ver en Reportes', destino: 'productos' },
  categoria_sube: { clave: 'reporte_categoria', etiqueta: 'Ver en Reportes', destino: 'productos' },
  canal_baja: { clave: 'reporte_canal', etiqueta: 'Ver en Reportes', destino: 'productos' },
  canal_sube: { clave: 'reporte_canal', etiqueta: 'Ver en Reportes', destino: 'productos' },
  dia_flojo: { clave: 'promocion', etiqueta: 'Crear promoción', destino: 'tienda' },
  franja_floja: { clave: 'promocion', etiqueta: 'Crear promoción', destino: 'tienda' },
  combinaciones: { clave: 'promocion', etiqueta: 'Crear promoción', destino: 'tienda' },
  descuentos_altos: { clave: 'correcciones', etiqueta: 'Ver correcciones', destino: 'ajustes' },
  cortesias_altas: { clave: 'correcciones', etiqueta: 'Ver correcciones', destino: 'ajustes' },
  cancelaciones_altas: { clave: 'historial', etiqueta: 'Ver en Historial', destino: 'historial' },
  ventas_sin_forma_pago: { clave: 'historial', etiqueta: 'Ver en Historial', destino: 'historial' },
  ventas_fuera_horario: { clave: 'historial', etiqueta: 'Ver en Historial', destino: 'historial' },
  ventas_incompletas: { clave: 'historial', etiqueta: 'Ver en Historial', destino: 'historial' },
  pedidos_grandes: { clave: 'historial', etiqueta: 'Ver en Historial', destino: 'historial' },
  poca_venta: { clave: 'menu', etiqueta: 'Abrir Menú', destino: 'menu' },
});
export const CLAVES_ACCION = Object.freeze([...new Set(Object.values(ACCIONES).map((a) => a.clave))]);

const esUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const exigirNegocio = (nid) => { if (!esUuid(nid)) { const e = new Error('negocioId requerido'); e.code = 'TENANT_CONTEXT_REQUIRED'; throw e; } };
const ID = /^\d{1,18}$/;
const idCategoria = (c) => Number(String(c).slice(2));

/**
 * El botón de un hallazgo guardado, o null. PURA. `datos` es lo que necesita
 * el panel para abrir la pantalla: números internos y fechas, NUNCA los
 * clientes (de ellos solo va cuántos son).
 */
export function accionDe(tipo, contenido) {
  const def = ACCIONES[tipo];
  if (!def) return null;
  const c = contenido && typeof contenido === 'object' && !Array.isArray(contenido) ? contenido : {};
  const a = c.accion && typeof c.accion === 'object' && !Array.isArray(c.accion) ? c.accion : {};
  // Una acción guardada con forma inválida no da botón (nunca se adivina).
  if (faltasDeAccion(c.accion ?? null).length) return null;
  const con = (datos) => ({ clave: def.clave, etiqueta: def.etiqueta, destino: def.destino, datos });
  switch (def.clave) {
    case 'campana_clientes':
      return a.clientes ? con({ cuantos: a.clientes.length, nombre: NOMBRE_CAMPANA[tipo], sugerencia: MENSAJES_SUGERIDOS[tipo] }) : null;
    case 'campana_nuevos':
      return con({ segmento: 'nuevo', nombre: NOMBRE_CAMPANA[tipo], sugerencia: MENSAJES_SUGERIDOS[tipo] });
    case 'menu_producto':
      return a.producto ? con({ producto: a.producto }) : null;
    case 'reporte_categoria':
      return a.categoria && a.desde && a.hasta ? con({ vista: 'categorias', categoria: a.categoria, desde: a.desde, hasta: a.hasta }) : null;
    case 'reporte_canal':
      return a.canal && a.desde && a.hasta ? con({ vista: 'productos', canal: a.canal, desde: a.desde, hasta: a.hasta }) : null;
    case 'promocion':
      if (tipo === 'dia_flojo') return Number.isInteger(a.dia) ? con({ dias: [a.dia] }) : null;
      if (tipo === 'combinaciones') return a.categorias ? con({ categorias: a.categorias.map(idCategoria) }) : null;
      if (tipo === 'franja_floja') {
        // «13-15» → de 13:00 a 15:00. Sin franja con horas, la promoción abre vacía.
        const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(a.franja || ''));
        const hh = (h) => `${String(h).padStart(2, '0')}:00`;
        return m && Number(m[1]) < Number(m[2]) && Number(m[2]) <= 24
          ? con({ horaInicio: hh(m[1]), horaFin: Number(m[2]) === 24 ? '23:59' : hh(m[2]) }) : con({});
      }
      return con({});
    case 'correcciones':
      return a.hasta ? con({ fecha: a.hasta }) : null;
    case 'historial':
      return a.desde && a.hasta ? con({ desde: a.desde, hasta: a.hasta, filtro: tipo === 'cancelaciones_altas' ? 'no_venta' : 'todas' }) : null;
    case 'menu':
      return con({});
    default:
      return null;
  }
}

/** ¿Tiene la sucursal los botones encendidos? */
export async function accionesEncendidas(db, negocioId) {
  exigirNegocio(negocioId);
  const { rows: [r] } = await db.query(
    'SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2', [negocioId, BANDERA_ACCIONES]);
  return String(r?.valor ?? '').trim() === 'true';
}

/** Un error con código, para que la ruta responda lo correcto sin detalles internos. */
function errorAccion(mensaje, codigo) {
  const e = new Error(mensaje);
  e.code = codigo;
  return e;
}

/**
 * Anota que alguien pulsó el botón de un aviso de SU sucursal. El aviso tiene
 * que ser de los elegidos y la clave, la de su tipo. Devuelve { ok: true } o
 * lanza con code SIN_AVISO (404) | ACCION_INVALIDA (400) | APAGADO (409).
 */
export async function registrarAccion(db, negocioId, { hallazgoId, usuarioId = null, clave }) {
  exigirNegocio(negocioId);
  if (!ID.test(String(hallazgoId))) throw errorAccion('Aviso inválido.', 'ACCION_INVALIDA');
  if (!CLAVES_ACCION.includes(clave)) throw errorAccion('Acción inválida.', 'ACCION_INVALIDA');
  if (!(await accionesEncendidas(db, negocioId))) throw errorAccion('Los botones del asistente no están encendidos en esta sucursal.', 'APAGADO');
  const { rows: [h] } = await db.query(
    `SELECT id, tipo, contenido FROM asistente_restaurante_hallazgos
      WHERE negocio_id = $1 AND id = $2::bigint AND elegido`, [negocioId, String(hallazgoId)]);
  if (!h) throw errorAccion('Aviso no encontrado.', 'SIN_AVISO');
  const accion = accionDe(h.tipo, h.contenido);
  if (!accion || accion.clave !== clave) throw errorAccion('Ese aviso no tiene esa acción.', 'ACCION_INVALIDA');
  await db.query(
    `INSERT INTO asistente_restaurante_acciones (negocio_id, hallazgo_id, usuario_id, accion, paso)
     VALUES ($1, $2, $3, $4, 'abrio')`, [negocioId, h.id, esUuid(usuarioId) ? usuarioId : null, clave]);
  return { ok: true };
}

/**
 * Para Campañas (campanasWa.js): los clientes del aviso «clientes frecuentes
 * que no han vuelto», como Set de id de clientes_negocio. Solo de un aviso
 * elegido de ESTA sucursal y con los botones encendidos. Campañas, además,
 * se queda solo con los que sean de su propia Lista del negocio.
 * Lanza con code SIN_AVISO | APAGADO.
 */
export async function clientesDelAviso(db, negocioId, hallazgoId) {
  exigirNegocio(negocioId);
  if (!ID.test(String(hallazgoId ?? ''))) throw errorAccion('Ese aviso del asistente ya no está.', 'SIN_AVISO');
  if (!(await accionesEncendidas(db, negocioId))) throw errorAccion('Los botones del asistente no están encendidos en esta sucursal.', 'APAGADO');
  const { rows: [h] } = await db.query(
    `SELECT tipo, contenido FROM asistente_restaurante_hallazgos
      WHERE negocio_id = $1 AND id = $2::bigint AND elegido AND tipo = 'clientes_dejaron'`, [negocioId, String(hallazgoId)]);
  const accion = h ? accionDe(h.tipo, h.contenido) : null;
  if (!accion || accion.clave !== 'campana_clientes') throw errorAccion('Ese aviso del asistente ya no está.', 'SIN_AVISO');
  return new Set(h.contenido.accion.clientes.map((x) => x.toLowerCase()));
}

/**
 * Anota la campaña que salió de un aviso. Mejor esfuerzo: si falla, la
 * campaña ya quedó guardada y se manda igual (nunca se detiene por esto).
 */
export async function anotarCampanaDelAviso(db, negocioId, { hallazgoId, usuarioId = null, campanaId }) {
  try {
    exigirNegocio(negocioId);
    if (!ID.test(String(hallazgoId)) || !Number.isSafeInteger(Number(campanaId))) return false;
    const { rowCount } = await db.query(
      `INSERT INTO asistente_restaurante_acciones (negocio_id, hallazgo_id, usuario_id, accion, paso, campana_id)
       SELECT $1, h.id, $3, 'campana_clientes', 'creo_campana', $4
         FROM asistente_restaurante_hallazgos h WHERE h.negocio_id = $1 AND h.id = $2::bigint`,
      [negocioId, String(hallazgoId), esUuid(usuarioId) ? usuarioId : null, Number(campanaId)]);
    return rowCount === 1;
  } catch (e) {
    console.error('[Asistente] anotar campaña del aviso:', e.message);
    return false;
  }
}
