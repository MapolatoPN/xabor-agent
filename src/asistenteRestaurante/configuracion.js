// Asistente del restaurante, Fase 2: la configuración de cada sucursal.
//
// Se guarda en la tabla configuracion (sin migración), junto a las banderas de
// la Fase 1 (avisos.js):
//   asistente_restaurante_tipos_apagados  JSON con los tipos de aviso apagados.
//   asistente_restaurante_umbrales        JSON con los ajustes de AJUSTES.
// Un valor dañado nunca rompe la revisión: cada ajuste inválido vuelve a su
// valor de siempre, y un tipo desconocido se ignora. «Quién ve» sigue fallando
// cerrado (avisos.js): una lista dañada es nadie.
//
// Quién la cambia (decisión del dueño, 27-nov-2026): solo quien RECIBE los
// avisos de esa sucursal. Los avisos de control hablan del personal
// (cortesías, descuentos, cancelaciones): otro administrador no debe poder
// agregarse a la lista ni callarlos. Una sesión de soporte tampoco.
//
// Lo que NO se configura, porque son reglas del dueño: el mínimo de 100
// tickets por producto y 30 por grupo, no repetir un aviso en 7 días, el
// máximo de 3 al día (solo se puede bajar) y la prohibición de lenguaje de
// causa y efecto.
import { TIPOS_HALLAZGO, TIPOS_CONTROL, TIPOS_INFORMATIVOS, UMBRALES_ASISTENTE } from './reglas.js';
import { MAXIMO_AL_DIA, MINIMO_IMPACTO } from './priorizar.js';
import { CLAVE_MODO, CLAVE_DESTINATARIOS, configuracionAsistente } from './avisos.js';

export const CLAVE_TIPOS_APAGADOS = 'asistente_restaurante_tipos_apagados';
export const CLAVE_UMBRALES = 'asistente_restaurante_umbrales';
export const MAXIMO_DESTINATARIOS = 20;

// Los tipos, agrupados como los ve el dueño. Cubren TIPOS_HALLAZGO exactamente
// una vez (lo exige la prueba C1).
export const GRUPOS_TIPOS = Object.freeze([
  { id: 'control', titulo: 'Control de las ventas', tipos: ['descuentos_altos', 'cancelaciones_altas', 'cortesias_altas', 'ventas_sin_forma_pago', 'ventas_fuera_horario', 'ventas_incompletas'] },
  { id: 'bajan', titulo: 'Ventas que bajan', tipos: ['producto_baja', 'categoria_baja', 'canal_baja', 'dia_flojo', 'franja_floja'] },
  { id: 'suben', titulo: 'Ventas que suben', tipos: ['producto_sube', 'categoria_sube', 'canal_sube'] },
  { id: 'clientes', titulo: 'Clientes', tipos: ['clientes_dejaron', 'nuevos_regresan_menos', 'clientes_cambiaron'] },
  { id: 'lunes', titulo: 'Los lunes', tipos: ['pedidos_grandes', 'combinaciones', 'poca_venta'] },
]);

export const NOMBRES_TIPOS = Object.freeze({
  descuentos_altos: 'Descuentos más altos que lo normal',
  cancelaciones_altas: 'Cancelaciones más altas que lo normal',
  cortesias_altas: 'Cortesías más altas que lo normal',
  ventas_sin_forma_pago: 'Ventas sin forma de pago',
  ventas_fuera_horario: 'Ventas fuera del horario',
  ventas_incompletas: 'Ventas con datos incompletos',
  producto_baja: 'Productos que venden menos',
  categoria_baja: 'Categorías que venden menos',
  canal_baja: 'Canales que venden menos',
  dia_flojo: 'Días de la semana más flojos',
  franja_floja: 'Horas del día más flojas',
  producto_sube: 'Productos que venden más',
  categoria_sube: 'Categorías que venden más',
  canal_sube: 'Canales que venden más',
  clientes_dejaron: 'Clientes frecuentes que dejaron de venir',
  nuevos_regresan_menos: 'Clientes nuevos que regresan menos',
  clientes_cambiaron: 'Clientes frecuentes que cambiaron su forma de pedir',
  pedidos_grandes: 'Pedidos grandes de la semana',
  combinaciones: 'Platillos que se piden juntos',
  poca_venta: 'Productos con poca venta',
});

// Los ajustes de «qué tan sensible». Enteros, con su rango. El valor de
// siempre es el que usa la Fase 1 (la prueba C1 exige que coincidan).
export const AJUSTES = Object.freeze({
  avisosPorDia: { def: MAXIMO_AL_DIA, min: 1, max: MAXIMO_AL_DIA, titulo: 'Avisos por día', unidad: 'avisos' },
  minimoPesos: { def: MINIMO_IMPACTO, min: 100, max: 20000, titulo: 'Pesos mínimos en juego para avisar (no aplica a los de control)', unidad: 'pesos' },
  cambioPct: { def: UMBRALES_ASISTENTE.cambioPct, min: 10, max: 50, titulo: 'Cambio mínimo para avisar que algo sube o baja', unidad: '%' },
  pedidoGrandeVeces: { def: UMBRALES_ASISTENTE.pedidoGrandeFactor, min: 2, max: 10, titulo: 'Pedido grande: veces el ticket típico', unidad: 'veces' },
  pedidoGrandePiso: { def: UMBRALES_ASISTENTE.pedidoGrandePiso, min: 500, max: 20000, titulo: 'Pedido grande: nunca menos de', unidad: 'pesos' },
  diasSinVenir: { def: UMBRALES_ASISTENTE.clienteAusenciaMinima, min: 14, max: 90, titulo: 'Cliente frecuente que dejó de venir: días sin pedir', unidad: 'días' },
});
export const AJUSTES_DE_SIEMPRE = Object.freeze(Object.fromEntries(Object.entries(AJUSTES).map(([k, a]) => [k, a.def])));

const esUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const exigirNegocio = (nid) => { if (!esUuid(nid)) { const e = new Error('negocioId requerido'); e.code = 'TENANT_CONTEXT_REQUIRED'; throw e; } };
const enRango = (a, v) => Number.isInteger(v) && v >= a.min && v <= a.max;
const leerJson = (texto, respaldo) => { try { const v = JSON.parse(texto); return v ?? respaldo; } catch { return respaldo; } };

/** Tipos apagados desde lo guardado: solo tipos conocidos, sin repetir. */
export function tiposApagadosDe(texto) {
  const v = leerJson(texto || '[]', []);
  return Array.isArray(v) ? [...new Set(v.filter((t) => TIPOS_HALLAZGO.includes(t)))] : [];
}

/** Ajustes desde lo guardado: cada uno válido o el de siempre. */
export function ajustesDe(texto) {
  const v = leerJson(texto || '{}', {});
  const o = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  return Object.fromEntries(Object.entries(AJUSTES).map(([k, a]) => [k, enRango(a, o[k]) ? o[k] : a.def]));
}

/** Toda la configuración del asistente de UNA sucursal. Nunca lanza por un valor raro. */
export async function leerConfiguracion(db, negocioId) {
  exigirNegocio(negocioId);
  const base = await configuracionAsistente(db, negocioId);
  const { rows } = await db.query(
    'SELECT clave, valor FROM configuracion WHERE negocio_id = $1 AND clave = ANY($2::text[])',
    [negocioId, [CLAVE_TIPOS_APAGADOS, CLAVE_UMBRALES]]);
  const v = Object.fromEntries(rows.map((r) => [r.clave, String(r.valor ?? '')]));
  return { ...base, tiposApagados: tiposApagadosDe(v[CLAVE_TIPOS_APAGADOS]), ajustes: ajustesDe(v[CLAVE_UMBRALES]) };
}

/** ¿Este usuario puede cambiar la configuración del asistente de esta sucursal? */
export function puedeEditar(cfg, { usuarioId, esSoporte } = {}) {
  return !!cfg && cfg.activo && !esSoporte && esUuid(usuarioId) && cfg.destinatarios.includes(usuarioId.toLowerCase());
}

/**
 * Lo que la revisión de la mañana necesita: los umbrales de las reglas
 * (reglas.buscarHallazgos) y los filtros de la elección (priorizar).
 * El mínimo en pesos NO toca los de control ni los informativos.
 */
export function paraLaRevision(cfg) {
  const a = cfg?.ajustes || AJUSTES_DE_SIEMPRE;
  const minimos = {};
  for (const tipo of TIPOS_HALLAZGO) {
    if (!TIPOS_CONTROL.includes(tipo) && !TIPOS_INFORMATIVOS.includes(tipo)) minimos[tipo] = a.minimoPesos;
  }
  return {
    umbrales: {
      cambioPct: a.cambioPct,
      caidaPct: a.cambioPct,
      pedidoGrandeFactor: a.pedidoGrandeVeces,
      pedidoGrandePiso: a.pedidoGrandePiso,
      clienteAusenciaMinima: a.diasSinVenir,
    },
    tiposApagados: [...(cfg?.tiposApagados || [])],
    minimos,
    maximo: a.avisosPorDia,
  };
}

/** Los administradores activos de ESTA sucursal (los únicos que pueden recibir avisos). */
export async function administradoresDe(db, negocioId) {
  exigirNegocio(negocioId);
  const { rows } = await db.query(`
    SELECT u.id::text AS id, u.nombre, u.email
      FROM usuario_negocios un JOIN usuarios u ON u.id = un.usuario_id
     WHERE un.negocio_id = $1 AND un.rol = 'admin' AND un.activo AND u.activo IS NOT FALSE
     ORDER BY lower(coalesce(u.nombre, '')), u.id`, [negocioId]);
  return rows;
}

/** Los avisos callados con «No avisar de esto», con su último título. */
export async function silenciadosDe(db, negocioId) {
  exigirNegocio(negocioId);
  const { rows } = await db.query(`
    SELECT s.firma, s.creado_en, u.nombre AS por,
           (SELECT h.tipo FROM asistente_restaurante_hallazgos h
             WHERE h.negocio_id = s.negocio_id AND h.firma = s.firma ORDER BY h.id DESC LIMIT 1) AS tipo,
           (SELECT h.titulo FROM asistente_restaurante_hallazgos h
             WHERE h.negocio_id = s.negocio_id AND h.firma = s.firma ORDER BY h.id DESC LIMIT 1) AS titulo
      FROM asistente_restaurante_silenciados s LEFT JOIN usuarios u ON u.id = s.usuario_id
     WHERE s.negocio_id = $1
     ORDER BY s.creado_en DESC, s.firma
     LIMIT 100`, [negocioId]);
  return rows.map((r) => ({ firma: r.firma, tipo: r.tipo || null, titulo: r.titulo || null, por: r.por || null, creado_en: r.creado_en }));
}

/** Lo que pinta la tarjeta. */
export async function vistaConfiguracion(db, negocioId, cfg, usuarioId) {
  const [admins, silenciados] = await Promise.all([administradoresDe(db, negocioId), silenciadosDe(db, negocioId)]);
  const apagados = new Set(cfg.tiposApagados);
  return {
    disponible: true,
    yo: usuarioId,
    modo: cfg.modo,
    grupos: GRUPOS_TIPOS.map((g) => ({
      id: g.id, titulo: g.titulo,
      tipos: g.tipos.map((tipo) => ({ tipo, nombre: NOMBRES_TIPOS[tipo], encendido: !apagados.has(tipo) })),
    })),
    ajustes: { ...cfg.ajustes },
    limites: Object.fromEntries(Object.entries(AJUSTES).map(([k, a]) => [k, { ...a }])),
    administradores: admins.map((a) => ({ ...a, recibe: cfg.destinatarios.includes(a.id.toLowerCase()) })),
    silenciados,
  };
}

function rechazo(mensaje) { const e = new Error(mensaje); e.code = 'CONFIGURACION_INVALIDA'; return e; }

/**
 * Valida lo que manda la tarjeta. Todo es obligatorio y nada desconocido
 * pasa. Lanza CONFIGURACION_INVALIDA con un mensaje para el dueño.
 * Devuelve { modo, tiposApagados, ajustes, destinatarios } ya limpio.
 */
export function validarCambio(cuerpo, { usuarioId } = {}) {
  if (!cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) throw rechazo('Configuración inválida.');
  const permitidas = ['modo', 'tiposApagados', 'ajustes', 'destinatarios'];
  for (const k of Object.keys(cuerpo)) if (!permitidas.includes(k)) throw rechazo(`No se reconoce «${String(k).slice(0, 40)}».`);
  if (cuerpo.modo !== 'visible' && cuerpo.modo !== 'ensayo') throw rechazo('El estado debe ser «visible» o «ensayo».');

  if (!Array.isArray(cuerpo.tiposApagados)) throw rechazo('Faltan los tipos de aviso.');
  for (const t of cuerpo.tiposApagados) if (!TIPOS_HALLAZGO.includes(t)) throw rechazo(`Tipo de aviso desconocido: «${String(t).slice(0, 40)}».`);
  const tiposApagados = [...new Set(cuerpo.tiposApagados)];

  const aj = cuerpo.ajustes;
  if (!aj || typeof aj !== 'object' || Array.isArray(aj)) throw rechazo('Faltan los ajustes.');
  for (const k of Object.keys(aj)) if (!AJUSTES[k]) throw rechazo(`Ajuste desconocido: «${String(k).slice(0, 40)}».`);
  const ajustes = {};
  for (const [k, a] of Object.entries(AJUSTES)) {
    if (!enRango(a, aj[k])) throw rechazo(`«${a.titulo}» debe ser un número entero entre ${a.min.toLocaleString('es-MX')} y ${a.max.toLocaleString('es-MX')}.`);
    ajustes[k] = aj[k];
  }

  const d = cuerpo.destinatarios;
  if (!Array.isArray(d) || !d.length) throw rechazo('Elige al menos a una persona que reciba los avisos.');
  if (d.length > MAXIMO_DESTINATARIOS) throw rechazo(`Máximo ${MAXIMO_DESTINATARIOS} personas.`);
  if (!d.every(esUuid)) throw rechazo('Hay una persona inválida en «Quién ve los avisos».');
  const destinatarios = [...new Set(d.map((x) => x.toLowerCase()))];
  if (!esUuid(usuarioId) || !destinatarios.includes(usuarioId.toLowerCase())) {
    throw rechazo('No te puedes quitar de «Quién ve los avisos»: ya no podrías cambiar esta configuración.');
  }
  return { modo: cuerpo.modo, tiposApagados, ajustes, destinatarios };
}

/**
 * Guarda el cambio en UNA transacción, después de comprobar que cada persona
 * de la lista es administrador activo de ESTA sucursal. Deja la huella en la
 * bitácora (antes y después). La sucursal viene de la sesión, nunca del cuerpo.
 */
export async function guardarConfiguracion(db, negocioId, { usuarioId, cambio, registrarAuditoria }) {
  exigirNegocio(negocioId);
  const cliente = await db.connect();
  try {
    await cliente.query('BEGIN');
    // Un candado por sucursal: dos guardados a la vez no se mezclan.
    await cliente.query("SELECT pg_advisory_xact_lock(hashtextextended('asistente-configuracion:' || $1::text, 0))", [negocioId]);
    const antes = await leerConfiguracion(cliente, negocioId);
    if (!puedeEditar(antes, { usuarioId })) { const e = new Error('Sin acceso a la configuración del asistente.'); e.code = 'SIN_ACCESO'; throw e; }
    const admins = new Set((await administradoresDe(cliente, negocioId)).map((a) => a.id.toLowerCase()));
    const ajenos = cambio.destinatarios.filter((id) => !admins.has(id));
    if (ajenos.length) throw rechazo('Solo los administradores activos de esta sucursal pueden recibir los avisos.');
    const poner = async (clave, valor) => cliente.query(`
      INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1, $2, $3)
      ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = now()`, [negocioId, clave, valor]);
    await poner(CLAVE_MODO, cambio.modo);
    await poner(CLAVE_DESTINATARIOS, JSON.stringify(cambio.destinatarios));
    await poner(CLAVE_TIPOS_APAGADOS, JSON.stringify(cambio.tiposApagados));
    await poner(CLAVE_UMBRALES, JSON.stringify(cambio.ajustes));
    const foto = (c) => ({ modo: c.modo, destinatarios: c.destinatarios, tiposApagados: c.tiposApagados, ajustes: c.ajustes });
    if (registrarAuditoria) {
      await registrarAuditoria({
        actorUsuarioId: usuarioId, accion: 'asistente_restaurante_configuracion', negocioId,
        estadoAnterior: foto(antes), estadoNuevo: foto(cambio),
      }, cliente);
    }
    await cliente.query('COMMIT');
    return foto(cambio);
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

/** «Volver a avisar»: quita la marca de «No avisar de esto» de ESTA sucursal. */
export async function volverAAvisar(db, negocioId, { usuarioId, firma, registrarAuditoria }) {
  exigirNegocio(negocioId);
  if (typeof firma !== 'string' || !firma || firma.length > 300) return { quitado: false };
  const cliente = await db.connect();
  try {
    await cliente.query('BEGIN');
    const { rows } = await cliente.query(
      'DELETE FROM asistente_restaurante_silenciados WHERE negocio_id = $1 AND firma = $2 RETURNING firma, usuario_id::text AS usuario_id, creado_en',
      [negocioId, firma]);
    if (rows.length && registrarAuditoria) {
      await registrarAuditoria({
        actorUsuarioId: usuarioId, accion: 'asistente_restaurante_volver_a_avisar', negocioId,
        estadoAnterior: { firma: rows[0].firma, callado_por: rows[0].usuario_id, callado_en: rows[0].creado_en }, estadoNuevo: { firma: rows[0].firma },
      }, cliente);
    }
    await cliente.query('COMMIT');
    return { quitado: rows.length > 0 };
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}
