// ─── Pedidos de temporada (Thanksgiving y fechas parecidas) ────────────────
//
// Un formulario público para AGENDAR platillos de un solo día por ventana de
// entrega («entre 9 y 10 a. m.»). Vive aparte del flujo de comandas: no crea
// pedidos_activos, no imprime y no manda WhatsApp. El negocio ve la lista en
// /temporada y la prepara el día.
//
// La garantía que importa es el CUPO. Cada ventana tiene dos:
//   · cupo_platillos: platillos que la cocina saca en esa ventana (recoger y
//     domicilio juntos);
//   · cupo_domicilio: pedidos a domicilio que caben en esa ventana.
// Cada alta bloquea la fila de su campaña (SELECT … FOR UPDATE), así que dos
// clientes que piden a la vez el último lugar no pueden pasar los dos: el
// segundo mide el cupo con el primero ya contado.
//
// Las fechas y horas son de pared en la zona del negocio
// (configuracion.timezone, America/Matamoros por omisión) y se convierten con
// zonaHoraria.js; nunca con la zona del proceso.
import { pool } from './database.js';
import { TZ_DEFAULT, esZonaValida, desdeHoraLocal, aHoraLocal } from './zonaHoraria.js';

export class TemporadaError extends Error {
  constructor(mensaje, codigo, http = 400, extra = null) {
    super(mensaje);
    this.codigo = codigo;
    this.http = http;
    this.extra = extra;
  }
}

const CLAVE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HORA_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::00)?$/;
const FECHA_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ENVIO_RE = /^[A-Za-z0-9_-]{8,80}$/;

// Columnas de la campaña con fecha y horas como TEXTO: node-pg convierte un
// `date` a medianoche de la zona del proceso, que no es la del negocio.
const COLUMNAS_CAMPANA = `c.id, c.negocio_id, c.clave, c.titulo, c.descripcion, c.producto, c.precio, c.prefijo,
  to_char(c.fecha, 'YYYY-MM-DD') AS fecha, to_char(c.hora_inicio, 'HH24:MI') AS hora_inicio,
  to_char(c.hora_fin, 'HH24:MI') AS hora_fin, c.minutos_ventana, c.cupo_platillos, c.cupo_domicilio,
  c.max_platillos_pedido, c.acepta_recoger, c.acepta_domicilio, c.cierra_en, c.activa,
  c.creado_en, c.actualizado_en`;

const COLUMNAS_PEDIDO = `p.id, p.campana_id, p.numero, p.nombre, p.telefono, p.platillos, p.modalidad,
  p.direccion, p.referencias, p.notas, to_char(p.ventana_inicio, 'HH24:MI') AS ventana_inicio,
  to_char(p.ventana_fin, 'HH24:MI') AS ventana_fin, p.estado, p.creado_en, p.cancelado_en`;

// ─── Piezas puras (las prueba la suite sin base) ───────────────────────────

export function minutosDeHora(hora) {
  const m = HORA_RE.exec(String(hora ?? '').trim());
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}

export function horaDeMinutos(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/** Las ventanas de entrega del día: [{inicio:'09:00', fin:'10:00'}, …]. */
export function ventanasDe({ hora_inicio, hora_fin, minutos_ventana }) {
  const ini = minutosDeHora(hora_inicio);
  const fin = minutosDeHora(hora_fin);
  const paso = Number(minutos_ventana);
  const out = [];
  if (ini === null || fin === null || !Number.isInteger(paso) || paso <= 0) return out;
  for (let t = ini; t + paso <= fin; t += paso) out.push({ inicio: horaDeMinutos(t), fin: horaDeMinutos(t + paso) });
  return out;
}

/**
 * Teléfono como solo dígitos. Se aceptan 10 dígitos (México o EE. UU.: en la
 * frontera llegan los dos) o el número con su lada de país (52, 521, 1).
 */
export function normalizarTelefono(texto) {
  const d = String(texto ?? '').replace(/\D/g, '');
  const valido = d.length === 10
    || (d.length === 12 && d.startsWith('52'))
    || (d.length === 13 && d.startsWith('521'))
    || (d.length === 11 && d.startsWith('1'));
  if (!valido) throw new TemporadaError('Escribe un teléfono de 10 dígitos.', 'TELEFONO_INVALIDO');
  return d;
}

/** Texto de una sola línea, sin caracteres de control, con largo máximo. */
function texto(valor, { max, min = 0, campo, codigo, mensaje }) {
  const t = String(valor ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length < min || t.length > max) {
    throw new TemporadaError(mensaje || `Revisa ${campo}.`, codigo || 'DATO_INVALIDO', 400, { campo });
  }
  return t;
}

function entero(valor, { min, max, campo, codigo }) {
  const n = typeof valor === 'string' && /^\s*\d+\s*$/.test(valor) ? Number(valor) : valor;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new TemporadaError(`Revisa ${campo}.`, codigo || 'DATO_INVALIDO', 400, { campo });
  }
  return n;
}

function fechaValida(f) {
  const m = FECHA_RE.exec(String(f ?? ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/**
 * ¿Se puede pedir ahora? Y, por ventana, ¿ya empezó? `uso` trae lo apartado
 * por ventana: { '09:00': { platillos, domicilios } }.
 */
export function estadoCampana(c, zona, ahora = new Date(), uso = {}) {
  const fin = desdeHoraLocal(`${c.fecha}T${c.hora_fin}`, zona);
  let motivo = null;
  if (!c.activa) motivo = 'inactiva';
  else if (c.cierra_en && ahora >= new Date(c.cierra_en)) motivo = 'cerrada';
  else if (!fin || ahora >= fin) motivo = 'terminada';
  const ventanas = ventanasDe(c).map((v) => {
    const inicio = desdeHoraLocal(`${c.fecha}T${v.inicio}`, zona);
    const pasada = !inicio || ahora >= inicio;
    const u = uso[v.inicio] || { platillos: 0, domicilios: 0 };
    const libres = Math.max(0, c.cupo_platillos - u.platillos);
    const tope = pasada || motivo ? 0 : Math.min(c.max_platillos_pedido, libres);
    return {
      inicio: v.inicio, fin: v.fin, pasada,
      // Lo más que se puede pedir en esa ventana para cada modalidad (0 = no
      // hay lugar). No se publica el uso exacto: basta con saber hasta cuánto.
      maxRecoger: c.acepta_recoger ? tope : 0,
      maxDomicilio: c.acepta_domicilio && u.domicilios < c.cupo_domicilio ? tope : 0,
    };
  });
  return { abierta: motivo === null, motivo, ventanas };
}

/** Folio que ve el cliente: TG-007. */
export const folioDe = (prefijo, numero) => `${prefijo}-${String(numero).padStart(3, '0')}`;

// ─── Base de datos ─────────────────────────────────────────────────────────

async function zonaDe(negocioId, db) {
  const { rows } = await db.query(
    `SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = 'timezone' LIMIT 1`, [negocioId]);
  const z = rows[0]?.valor;
  return typeof z === 'string' && esZonaValida(z) ? z : TZ_DEFAULT;
}

async function usoPorVentana(campanaId, db) {
  const { rows } = await db.query(
    `SELECT to_char(ventana_inicio, 'HH24:MI') AS v, COALESCE(SUM(platillos), 0)::int AS platillos,
            (COUNT(*) FILTER (WHERE modalidad = 'domicilio'))::int AS domicilios, COUNT(*)::int AS pedidos
       FROM temporada_pedidos WHERE campana_id = $1 AND estado = 'confirmado' GROUP BY 1`, [campanaId]);
  return Object.fromEntries(rows.map((r) => [r.v, r]));
}

/** La campaña por su clave pública, solo si su negocio está activo. */
async function campanaPorClave(clave, db, { bloquear = false } = {}) {
  const c = String(clave ?? '').trim().toLowerCase();
  if (!CLAVE_RE.test(c) || c.length > 60) return null;
  const { rows } = await db.query(
    `SELECT ${COLUMNAS_CAMPANA}, n.nombre AS negocio_nombre
       FROM temporada_campanas c JOIN negocios n ON n.id = c.negocio_id
      WHERE c.clave = $1 AND n.activo = true AND n.estado IS DISTINCT FROM 'suspendido'
      ${bloquear ? 'FOR UPDATE OF c' : ''}`, [c]);
  return rows[0] || null;
}

const NO_DISPONIBLE = () => new TemporadaError('Estos pedidos no están disponibles.', 'NO_DISPONIBLE', 404);

/** Lo que la página pública necesita para mostrar horarios. */
export async function campanaPublica(clave, { db = pool, ahora = new Date() } = {}) {
  const c = await campanaPorClave(clave, db);
  // Una campaña apagada no se distingue de una inexistente desde fuera.
  if (!c || !c.activa) throw NO_DISPONIBLE();
  const zona = await zonaDe(c.negocio_id, db);
  const est = estadoCampana(c, zona, ahora, await usoPorVentana(c.id, db));
  return {
    clave: c.clave,
    negocio: c.negocio_nombre,
    titulo: c.titulo,
    descripcion: c.descripcion,
    producto: c.producto,
    precio: c.precio === null ? null : Number(c.precio),
    fecha: c.fecha,
    zona,
    maxPlatillosPedido: c.max_platillos_pedido,
    modalidades: { recoger: c.acepta_recoger, domicilio: c.acepta_domicilio },
    cierraEn: c.cierra_en ? new Date(c.cierra_en).toISOString() : null,
    abierta: est.abierta,
    motivo: est.motivo,
    ventanas: est.ventanas,
  };
}

function pedidoParaCliente(p, c) {
  return {
    folio: folioDe(c.prefijo, p.numero),
    nombre: p.nombre,
    platillos: p.platillos,
    modalidad: p.modalidad,
    direccion: p.direccion,
    ventana: { inicio: p.ventana_inicio, fin: p.ventana_fin },
    fecha: c.fecha,
    producto: c.producto,
    total: c.precio === null ? null : Number(c.precio) * p.platillos,
  };
}

/** Valida lo que manda el formulario. No toca la base. */
export function validarEntradaPedido(b) {
  const d = b && typeof b === 'object' ? b : {};
  const modalidad = d.modalidad === 'domicilio' ? 'domicilio' : d.modalidad === 'recoger' ? 'recoger' : null;
  if (!modalidad) throw new TemporadaError('Elige si pasas a recoger o lo llevamos a domicilio.', 'MODALIDAD_INVALIDA');
  const salida = {
    nombre: texto(d.nombre, { min: 2, max: 80, campo: 'nombre', codigo: 'NOMBRE_INVALIDO', mensaje: 'Escribe tu nombre.' }),
    telefono: normalizarTelefono(d.telefono),
    platillos: entero(d.platillos, { min: 1, max: 10000, campo: 'platillos', codigo: 'PLATILLOS_INVALIDOS' }),
    modalidad,
    ventana: minutosDeHora(d.ventana) === null ? null : horaDeMinutos(minutosDeHora(d.ventana)),
    direccion: null,
    referencias: null,
    notas: texto(d.notas, { max: 500, campo: 'notas' }) || null,
    claveEnvio: String(d.claveEnvio ?? ''),
  };
  if (!salida.ventana) throw new TemporadaError('Elige un horario de entrega.', 'VENTANA_INVALIDA');
  if (!ENVIO_RE.test(salida.claveEnvio)) throw new TemporadaError('Recarga la página e inténtalo de nuevo.', 'ENVIO_INVALIDO');
  if (modalidad === 'domicilio') {
    salida.direccion = texto(d.direccion, { min: 5, max: 300, campo: 'direccion', codigo: 'DIRECCION_INVALIDA',
      mensaje: 'Escribe la dirección de entrega (calle, número y colonia).' });
    salida.referencias = texto(d.referencias, { max: 300, campo: 'referencias' }) || null;
  }
  return salida;
}

/**
 * Agenda un pedido. Devuelve { pedido, repetido, negocioId }. `repetido`:
 * la misma clave de envío ya había entrado (doble clic, reintento): se
 * devuelve el pedido que ya existe y no se aparta otro cupo.
 */
export async function crearPedidoTemporada(clave, cuerpo, { db = pool, ahora = new Date() } = {}) {
  const d = validarEntradaPedido(cuerpo);
  const cliente = await db.connect();
  try {
    await cliente.query('BEGIN');
    // El candado de la campaña ordena todas las altas: el cupo se mide con
    // las anteriores ya contadas.
    const c = await campanaPorClave(clave, cliente, { bloquear: true });
    if (!c || !c.activa) throw NO_DISPONIBLE();

    const { rows: [previo] } = await cliente.query(
      `SELECT ${COLUMNAS_PEDIDO} FROM temporada_pedidos p WHERE p.campana_id = $1 AND p.clave_envio = $2`,
      [c.id, d.claveEnvio]);
    if (previo) {
      await cliente.query('COMMIT');
      return { pedido: pedidoParaCliente(previo, c), repetido: true, negocioId: c.negocio_id };
    }

    const zona = await zonaDe(c.negocio_id, cliente);
    const uso = await usoPorVentana(c.id, cliente);
    const est = estadoCampana(c, zona, ahora, uso);
    if (!est.abierta) {
      throw new TemporadaError('Ya no estamos recibiendo pedidos para esta fecha.', 'CERRADA', 409);
    }
    if (d.modalidad === 'recoger' && !c.acepta_recoger) {
      throw new TemporadaError('Para esta fecha solo entregamos a domicilio.', 'MODALIDAD_NO_DISPONIBLE');
    }
    if (d.modalidad === 'domicilio' && !c.acepta_domicilio) {
      throw new TemporadaError('Para esta fecha solo puedes pasar a recoger.', 'MODALIDAD_NO_DISPONIBLE');
    }
    if (d.platillos > c.max_platillos_pedido) {
      throw new TemporadaError(`Puedes agendar hasta ${c.max_platillos_pedido} platillos por pedido.`,
        'DEMASIADOS_PLATILLOS', 400, { max: c.max_platillos_pedido });
    }
    const v = est.ventanas.find((x) => x.inicio === d.ventana);
    if (!v) throw new TemporadaError('Elige uno de los horarios de la lista.', 'VENTANA_INVALIDA');
    if (v.pasada) throw new TemporadaError('Ese horario ya pasó. Elige otro.', 'VENTANA_PASADA', 409);

    const u = uso[v.inicio] || { platillos: 0, domicilios: 0 };
    const libres = c.cupo_platillos - u.platillos;
    if (d.platillos > libres) {
      throw new TemporadaError(
        libres > 0 ? `En ese horario solo quedan ${libres} platillos. Elige otro horario o menos platillos.`
          : 'Ese horario ya se llenó. Elige otro.',
        'VENTANA_LLENA', 409, { libres: Math.max(0, libres) });
    }
    if (d.modalidad === 'domicilio' && u.domicilios >= c.cupo_domicilio) {
      throw new TemporadaError('Ya no hay entregas a domicilio en ese horario. Elige otro o pasa a recoger.',
        'DOMICILIO_LLENO', 409);
    }

    const { rows: [{ siguiente }] } = await cliente.query(
      `SELECT COALESCE(MAX(numero), 0) + 1 AS siguiente FROM temporada_pedidos WHERE campana_id = $1`, [c.id]);
    const { rows: [nuevo] } = await cliente.query(
      `INSERT INTO temporada_pedidos AS p (campana_id, negocio_id, numero, nombre, telefono, platillos, modalidad,
                                           direccion, referencias, notas, ventana_inicio, ventana_fin, clave_envio)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::time, $12::time, $13)
       RETURNING ${COLUMNAS_PEDIDO}`,
      [c.id, c.negocio_id, siguiente, d.nombre, d.telefono, d.platillos, d.modalidad,
        d.direccion, d.referencias, d.notas, v.inicio, v.fin, d.claveEnvio]);
    await cliente.query('COMMIT');
    return { pedido: pedidoParaCliente(nuevo, c), repetido: false, negocioId: c.negocio_id };
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

// ─── Administración (siempre con el negocio de la sesión) ──────────────────

function campanaParaAdmin(c, zona) {
  return {
    id: String(c.id), clave: c.clave, titulo: c.titulo, descripcion: c.descripcion, producto: c.producto,
    precio: c.precio === null ? null : Number(c.precio), prefijo: c.prefijo, fecha: c.fecha,
    hora_inicio: c.hora_inicio, hora_fin: c.hora_fin, minutos_ventana: c.minutos_ventana,
    cupo_platillos: c.cupo_platillos, cupo_domicilio: c.cupo_domicilio, max_platillos_pedido: c.max_platillos_pedido,
    acepta_recoger: c.acepta_recoger, acepta_domicilio: c.acepta_domicilio, activa: c.activa,
    // Como hora de pared del negocio, para el <input type="datetime-local">.
    cierra_en: c.cierra_en ? aHoraLocal(new Date(c.cierra_en), zona) : null,
    zona,
  };
}

/** Campañas del negocio, con lo agendado, y una clave sugerida para la nueva. */
export async function listarCampanas(negocioId, { db = pool } = {}) {
  const zona = await zonaDe(negocioId, db);
  const { rows } = await db.query(
    `SELECT ${COLUMNAS_CAMPANA},
            (SELECT COUNT(*) FROM temporada_pedidos p WHERE p.campana_id = c.id AND p.estado = 'confirmado')::int AS pedidos,
            (SELECT COALESCE(SUM(platillos), 0) FROM temporada_pedidos p WHERE p.campana_id = c.id AND p.estado = 'confirmado')::int AS platillos
       FROM temporada_campanas c WHERE c.negocio_id = $1 ORDER BY c.fecha DESC, c.id DESC`, [negocioId]);
  const { rows: [neg] } = await db.query(
    `SELECT COALESCE(NULLIF(lower(t.slug_publico), ''), lower(n.slug)) AS slug
       FROM negocios n LEFT JOIN tienda_config t ON t.negocio_id = n.id WHERE n.id = $1`, [negocioId]);
  const base = String(neg?.slug || 'negocio').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'negocio';
  return {
    campanas: rows.map((r) => ({ ...campanaParaAdmin(r, zona), pedidos: r.pedidos, platillos: r.platillos })),
    claveSugerida: `${base}-thanksgiving-${new Date().getFullYear()}`,
    zona,
  };
}

function validarCampana(b, zona) {
  const d = b && typeof b === 'object' ? b : {};
  const clave = String(d.clave ?? '').trim().toLowerCase();
  if (!CLAVE_RE.test(clave) || clave.length < 3 || clave.length > 60) {
    throw new TemporadaError('La clave lleva solo minúsculas, números y guiones (p. ej. mapolato-thanksgiving-2026).', 'CLAVE_INVALIDA');
  }
  if (!fechaValida(d.fecha)) throw new TemporadaError('Revisa la fecha.', 'FECHA_INVALIDA');
  const ini = minutosDeHora(d.hora_inicio);
  const fin = minutosDeHora(d.hora_fin);
  if (ini === null || fin === null || fin <= ini) {
    throw new TemporadaError('La hora final debe ser después de la inicial.', 'HORARIO_INVALIDO');
  }
  const minutos = entero(d.minutos_ventana, { min: 15, max: 240, campo: 'minutos por ventana', codigo: 'HORARIO_INVALIDO' });
  if ((fin - ini) % minutos !== 0) {
    throw new TemporadaError('El horario debe dividirse exacto en ventanas (p. ej. de 9:00 a 16:00 en ventanas de 60 min).', 'HORARIO_INVALIDO');
  }
  const cupoPlatillos = entero(d.cupo_platillos, { min: 1, max: 10000, campo: 'platillos por ventana', codigo: 'CUPO_INVALIDO' });
  const cupoDomicilio = entero(d.cupo_domicilio, { min: 0, max: 1000, campo: 'domicilios por ventana', codigo: 'CUPO_INVALIDO' });
  const maxPedido = entero(d.max_platillos_pedido, { min: 1, max: cupoPlatillos, campo: 'máximo por pedido', codigo: 'CUPO_INVALIDO' });
  const recoger = d.acepta_recoger === true;
  const domicilio = d.acepta_domicilio === true;
  if (!recoger && !domicilio) throw new TemporadaError('Acepta al menos recoger o domicilio.', 'MODALIDAD_INVALIDA');
  if (domicilio && cupoDomicilio < 1) {
    throw new TemporadaError('Con domicilio encendido, el cupo de domicilios por ventana debe ser al menos 1.', 'CUPO_INVALIDO');
  }
  let precio = null;
  if (d.precio !== null && d.precio !== undefined && String(d.precio).trim() !== '') {
    precio = Number(d.precio);
    if (!Number.isFinite(precio) || precio < 0 || precio > 100000) throw new TemporadaError('Revisa el precio.', 'PRECIO_INVALIDO');
    precio = Math.round(precio * 100) / 100;
  }
  const prefijo = String(d.prefijo ?? 'TG').trim().toUpperCase();
  if (!/^[A-Z]{1,5}$/.test(prefijo)) throw new TemporadaError('El prefijo del folio lleva de 1 a 5 letras.', 'PREFIJO_INVALIDO');
  let cierra = null;
  if (d.cierra_en !== null && d.cierra_en !== undefined && String(d.cierra_en).trim() !== '') {
    cierra = desdeHoraLocal(String(d.cierra_en).trim(), zona);
    if (!cierra) throw new TemporadaError('Revisa la fecha y hora de cierre.', 'CIERRE_INVALIDO');
  }
  return {
    clave, fecha: d.fecha, hora_inicio: horaDeMinutos(ini), hora_fin: horaDeMinutos(fin), minutos_ventana: minutos,
    titulo: texto(d.titulo, { min: 1, max: 120, campo: 'título', codigo: 'TITULO_INVALIDO' }),
    producto: texto(d.producto ?? 'Platillo', { min: 1, max: 80, campo: 'producto', codigo: 'PRODUCTO_INVALIDO' }),
    descripcion: String(d.descripcion ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, 2000),
    precio, prefijo, cupo_platillos: cupoPlatillos, cupo_domicilio: cupoDomicilio, max_platillos_pedido: maxPedido,
    acepta_recoger: recoger, acepta_domicilio: domicilio, cierra_en: cierra, activa: d.activa === true,
  };
}

const CAMPOS_HORARIO = ['clave', 'fecha', 'hora_inicio', 'hora_fin', 'minutos_ventana'];

/**
 * Crea (id = null) o actualiza una campaña del negocio de la sesión. Con
 * pedidos ya agendados, la clave, la fecha y el horario no cambian: moverían
 * los pedidos a ventanas que el cliente no eligió (o romperían el enlace).
 */
export async function guardarCampana(negocioId, id, cuerpo, { db = pool } = {}) {
  const zona = await zonaDe(negocioId, db);
  const d = validarCampana(cuerpo, zona);
  const cliente = await db.connect();
  try {
    await cliente.query('BEGIN');
    let fila;
    const valores = [d.clave, d.titulo, d.descripcion, d.producto, d.precio, d.prefijo, d.fecha, d.hora_inicio,
      d.hora_fin, d.minutos_ventana, d.cupo_platillos, d.cupo_domicilio, d.max_platillos_pedido,
      d.acepta_recoger, d.acepta_domicilio, d.cierra_en, d.activa];
    if (id === null) {
      ({ rows: [fila] } = await cliente.query(
        `INSERT INTO temporada_campanas AS c (clave, titulo, descripcion, producto, precio, prefijo, fecha, hora_inicio,
           hora_fin, minutos_ventana, cupo_platillos, cupo_domicilio, max_platillos_pedido, acepta_recoger,
           acepta_domicilio, cierra_en, activa, negocio_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::time,$9::time,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING ${COLUMNAS_CAMPANA}`, [...valores, negocioId]));
    } else {
      const idNum = /^\d{1,18}$/.test(String(id)) ? String(id) : null;
      const { rows: [actual] } = idNum ? await cliente.query(
        `SELECT ${COLUMNAS_CAMPANA} FROM temporada_campanas c WHERE c.id = $1 AND c.negocio_id = $2 FOR UPDATE`,
        [idNum, negocioId]) : { rows: [] };
      if (!actual) throw new TemporadaError('Campaña no encontrada', 'NO_ENCONTRADA', 404);
      const { rows: [{ n }] } = await cliente.query(
        `SELECT COUNT(*)::int AS n FROM temporada_pedidos WHERE campana_id = $1 AND estado = 'confirmado'`, [idNum]);
      const cambiaHorario = CAMPOS_HORARIO.some((k) => String(actual[k]) !== String(d[k]));
      if (n > 0 && cambiaHorario) {
        throw new TemporadaError(
          `Ya hay ${n} pedido(s) agendado(s): la clave, la fecha y el horario no se pueden cambiar. Los cupos, el texto y el cierre sí.`,
          'CAMPANA_CON_PEDIDOS', 409);
      }
      ({ rows: [fila] } = await cliente.query(
        `UPDATE temporada_campanas AS c SET clave=$1, titulo=$2, descripcion=$3, producto=$4, precio=$5, prefijo=$6,
                fecha=$7::date, hora_inicio=$8::time, hora_fin=$9::time, minutos_ventana=$10, cupo_platillos=$11,
                cupo_domicilio=$12, max_platillos_pedido=$13, acepta_recoger=$14, acepta_domicilio=$15,
                cierra_en=$16, activa=$17, actualizado_en=now()
          WHERE c.id = $18 AND c.negocio_id = $19 RETURNING ${COLUMNAS_CAMPANA}`, [...valores, idNum, negocioId]));
    }
    await cliente.query('COMMIT');
    return campanaParaAdmin(fila, zona);
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    if (e?.code === '23505' && e.constraint === 'temporada_campanas_clave_unica') {
      throw new TemporadaError('Esa clave ya la usa otra campaña. Elige otra.', 'CLAVE_OCUPADA', 409);
    }
    throw e;
  } finally {
    cliente.release();
  }
}

/** La campaña con sus ventanas (uso contra cupo) y todos sus pedidos. */
export async function pedidosDeCampana(negocioId, id, { db = pool } = {}) {
  const idNum = /^\d{1,18}$/.test(String(id)) ? String(id) : null;
  const { rows: [c] } = idNum ? await db.query(
    `SELECT ${COLUMNAS_CAMPANA} FROM temporada_campanas c WHERE c.id = $1 AND c.negocio_id = $2`, [idNum, negocioId])
    : { rows: [] };
  if (!c) throw new TemporadaError('Campaña no encontrada', 'NO_ENCONTRADA', 404);
  const zona = await zonaDe(negocioId, db);
  const uso = await usoPorVentana(c.id, db);
  const { rows } = await db.query(
    `SELECT ${COLUMNAS_PEDIDO} FROM temporada_pedidos p WHERE p.campana_id = $1
      ORDER BY p.ventana_inicio, p.numero`, [c.id]);
  return {
    campana: campanaParaAdmin(c, zona),
    ventanas: ventanasDe(c).map((v) => {
      const u = uso[v.inicio] || { platillos: 0, domicilios: 0, pedidos: 0 };
      return { ...v, platillos: u.platillos, domicilios: u.domicilios, pedidos: u.pedidos,
        cupoPlatillos: c.cupo_platillos, cupoDomicilio: c.cupo_domicilio };
    }),
    pedidos: rows.map((p) => ({
      id: String(p.id), folio: folioDe(c.prefijo, p.numero), nombre: p.nombre, telefono: p.telefono,
      platillos: p.platillos, modalidad: p.modalidad, direccion: p.direccion, referencias: p.referencias,
      notas: p.notas, ventana: { inicio: p.ventana_inicio, fin: p.ventana_fin }, estado: p.estado,
      creado_en: p.creado_en, cancelado_en: p.cancelado_en,
    })),
  };
}

/** Cancela un pedido del negocio: libera su cupo y conserva su folio. */
export async function cancelarPedidoTemporada(negocioId, pedidoId, { actorId = null, db = pool } = {}) {
  const idNum = /^\d{1,18}$/.test(String(pedidoId)) ? String(pedidoId) : null;
  if (!idNum) throw new TemporadaError('Pedido no encontrado', 'NO_ENCONTRADO', 404);
  const { rows: [p] } = await db.query(
    `UPDATE temporada_pedidos SET estado = 'cancelado', cancelado_en = now(), cancelado_por = $3
      WHERE id = $1 AND negocio_id = $2 AND estado = 'confirmado' RETURNING id`,
    [idNum, negocioId, actorId ? String(actorId) : null]);
  if (p) return { ok: true };
  const { rows: [existe] } = await db.query(
    `SELECT estado FROM temporada_pedidos WHERE id = $1 AND negocio_id = $2`, [idNum, negocioId]);
  if (!existe) throw new TemporadaError('Pedido no encontrado', 'NO_ENCONTRADO', 404);
  throw new TemporadaError('Ese pedido ya estaba cancelado.', 'YA_CANCELADO', 409);
}
