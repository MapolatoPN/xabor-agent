// ─── Pedidos de temporada (Thanksgiving y fechas parecidas) ────────────────
//
// Un formulario público para AGENDAR platillos de un solo día por ventana de
// entrega («entre 9 y 10 a. m.»). Vive aparte del flujo de comandas: no crea
// pedidos_activos, no imprime y no manda WhatsApp por su cuenta (la
// confirmación y el recordatorio los abre la página en wa.me y los envía quien
// atiende). El negocio ve la lista en /temporada y la prepara el día.
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
  c.anticipo_tipo, c.anticipo_valor, c.mensaje_confirmacion, c.mensaje_recordatorio, c.creado_en, c.actualizado_en`;

// precio_unitario: el precio por platillo con el que se agendó (migración
// 139). NULL = el de la campaña (sin precio al agendar, o entró con el código
// anterior a la 139): cada lectura lo resuelve con precioDe().
const COLUMNAS_PEDIDO = `p.id, p.campana_id, p.numero, p.nombre, p.telefono, p.platillos, p.modalidad,
  p.direccion, p.referencias, p.notas, to_char(p.ventana_inicio, 'HH24:MI') AS ventana_inicio,
  to_char(p.ventana_fin, 'HH24:MI') AS ventana_fin, p.estado, p.creado_en, p.cancelado_en, p.precio_unitario,
  p.estado_entrega, p.entrega_cambiada_en, p.origen, p.creado_por, p.actualizado_en`;

const METODOS_PAGO = ['efectivo', 'transferencia', 'tarjeta'];
const TIPOS_ANTICIPO = ['ninguno', 'porcentaje', 'monto'];
// El camino de un pedido el día de la entrega, en orden. «entregado» es
// también «recogido» (la página lo nombra según la modalidad).
export const ESTADOS_ENTREGA = ['agendado', 'en_preparacion', 'listo', 'entregado'];

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

// ─── Dinero ────────────────────────────────────────────────────────────────
// Todas las cuentas en CENTAVOS enteros: 0.1 + 0.2 no debe dejar un saldo de
// $0.0000001. node-pg entrega `numeric` como texto ("229.00").

/** Pesos (número o texto de la base) → centavos enteros; null si no hay. */
export function aCentavos(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
const aPesos = (centavos) => (centavos === null ? null : centavos / 100);
/** Centavos → «$1,234» o «$114.50», para los mensajes. */
const pesosTexto = (c) => '$' + (c % 100 ? (c / 100).toFixed(2) : String(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Precio por platillo del pedido: el congelado o, si no hay, el de la campaña. */
export const precioDe = (pedido, campana) => aCentavos(pedido.precio_unitario ?? campana.precio);

/**
 * El estado de pago de un pedido. No se guarda: sale de sus movimientos.
 *   precio: centavos por platillo (null = la campaña no tiene precio)
 *   pagos:  [{ monto (centavos), metodo, anulado }]
 *   anticipo: { tipo: 'ninguno'|'porcentaje'|'monto', valor (porcentaje o centavos) }
 * Devuelve pesos (no centavos) para que la página no tenga que dividir.
 */
export function resumenPago({ precio, platillos, pagos = [], anticipo = { tipo: 'ninguno', valor: null } }) {
  const total = precio === null || precio === undefined ? null : precio * platillos;
  const vigentes = pagos.filter((p) => !p.anulado);
  const pagado = vigentes.reduce((s, p) => s + p.monto, 0);
  let requerido = 0;
  if (total !== null && anticipo?.tipo === 'porcentaje') requerido = Math.round((total * Number(anticipo.valor)) / 100);
  else if (total !== null && anticipo?.tipo === 'monto') requerido = Math.min(Number(anticipo.valor), total);
  const estado = pagado <= 0 ? 'sin_pago' : total !== null && pagado >= total ? 'pagado' : 'anticipo';
  return {
    total: aPesos(total),
    pagado: aPesos(pagado),
    saldo: total === null ? null : aPesos(Math.max(0, total - pagado)),
    // Lo pagado de más (p. ej. si luego bajan los platillos): se devuelve o se abona.
    excedente: total === null ? 0 : aPesos(Math.max(0, pagado - total)),
    estado,
    anticipoRequerido: aPesos(requerido),
    faltaAnticipo: requerido > pagado ? aPesos(requerido - pagado) : 0,
    metodos: [...new Set(vigentes.map((p) => p.metodo))],
  };
}

/**
 * Los totales en pesos de una campaña. Recibe cada pedido en CENTAVOS:
 *   [{ estado: 'confirmado'|'cancelado', total (centavos o null), pagado (centavos, sin anulados) }]
 * y devuelve pesos:
 *   venta        lo que suman los pedidos confirmados (null si ninguno tiene precio)
 *   cobrado      todo lo recibido y no anulado, de cualquier pedido: lo que
 *                debería haber en caja
 *   porCobrar    lo que falta cobrar de los confirmados
 *   porDevolver  lo pagado de más en un confirmado más lo pagado en un
 *                cancelado (deja de contar cuando se anula ese pago)
 * Cuadra siempre que todos tengan precio: venta − cobrado + porDevolver = porCobrar.
 * Con `campanaConPrecio` la venta es $0 aunque no haya pedidos (no null).
 */
export function totalesTemporada(pedidos, { campanaConPrecio = false } = {}) {
  let venta = 0, cobrado = 0, porCobrar = 0, porDevolver = 0, conSaldo = 0, conPrecio = 0, sinPrecio = 0;
  for (const p of pedidos) {
    const pagado = p.pagado || 0;
    cobrado += pagado;
    if (p.estado !== 'confirmado') { porDevolver += pagado; continue; }
    if (p.total === null || p.total === undefined) { sinPrecio += 1; continue; }
    conPrecio += 1;
    venta += p.total;
    if (p.total > pagado) { porCobrar += p.total - pagado; conSaldo += 1; } else porDevolver += pagado - p.total;
  }
  const hayVenta = campanaConPrecio || conPrecio > 0;
  return {
    venta: hayVenta ? aPesos(venta) : null,
    cobrado: aPesos(cobrado),
    porCobrar: aPesos(porCobrar),
    porDevolver: aPesos(porDevolver),
    conSaldo,
    sinPrecio: hayVenta ? sinPrecio : 0,
  };
}

// ─── Mensajes de WhatsApp al cliente (punto 5) ─────────────────────────────
// Xabor no manda nada por su cuenta: la página abre wa.me con el texto ya
// armado aquí y quien atiende lo envía desde el WhatsApp del negocio. Cada
// campaña puede tener su texto; NULL = el de Xabor.

/** Los datos que puede llevar un mensaje, en el orden en que se ofrecen. */
export const CAMPOS_MENSAJE = Object.freeze(['nombre', 'folio', 'platillos', 'producto', 'fecha', 'horario', 'tipo',
  'direccion', 'referencias', 'notas', 'total', 'pagado', 'saldo', 'pago']);
const NOMBRE_MENSAJE = { confirmacion: 'confirmación', recordatorio: 'recordatorio' };

export const MENSAJES_OMISION = Object.freeze({
  confirmacion: [
    'Hola {nombre}, te confirmamos tu pedido {folio}:',
    '• {platillos} × {producto}',
    '• {fecha}, {horario}',
    '• {tipo}',
    '• Dirección: {direccion}',
    '• Referencias: {referencias}',
    '• Notas: {notas}',
    'Total {total}: {pago}.',
    '¡Gracias por tu pedido!',
  ].join('\n'),
  recordatorio: [
    // El horario ya termina en «a. m.»/«p. m.»: ningún renglón le pone punto.
    'Hola {nombre}, te recordamos tu pedido {folio}:',
    '• {fecha}, {horario}',
    '• {platillos} × {producto}',
    '• {tipo}',
    '• Dirección: {direccion}',
    'Total {total}: {pago}.',
    '¡Gracias!',
  ].join('\n'),
});

const DIAS_TXT = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES_TXT = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre',
  'octubre', 'noviembre', 'diciembre'];
/** '2026-11-26' → 'jueves 26 de noviembre' (fecha de pared: sin zona que la mueva). */
export function fechaTexto(iso) {
  const m = FECHA_RE.exec(String(iso ?? ''));
  if (!m) return '';
  const f = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${DIAS_TXT[f.getUTCDay()]} ${+m[3]} de ${MESES_TXT[+m[2] - 1]}`;
}
/** '09:00','10:00' → 'de 9:00 a 10:00 a. m.'; '11:00','12:00' → 'de 11:00 a. m. a 12:00 p. m.' */
export function horarioTexto(ini, fin) {
  const parte = (h) => {
    const [hh, mm] = String(h).split(':').map(Number);
    return [`${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')}`, hh < 12 ? 'a. m.' : 'p. m.'];
  };
  const [a, sa] = parte(ini), [b, sb] = parte(fin);
  return sa === sb ? `de ${a} a ${b} ${sb}` : `de ${a} ${sa} a ${b} ${sb}`;
}

/** Número para wa.me: solo dígitos y con lada de país. 10 dígitos se toman como de México. */
export function numeroWhatsApp(telefono) {
  const d = String(telefono ?? '').replace(/\D/g, '');
  if (d.length === 10) return '52' + d;
  if (d.length === 13 && d.startsWith('521')) return '52' + d.slice(3);
  if ((d.length === 12 && d.startsWith('52')) || (d.length === 11 && d.startsWith('1'))) return d;
  return null;
}

/**
 * Arma un mensaje: cada {campo} se cambia por su valor. Un renglón con un dato
 * que no aplica (la dirección de quien pasa a recoger, el total sin precio) se
 * quita entero. Lo que trae el valor no se vuelve a leer: un nombre que dice
 * «{folio}» se queda como texto.
 */
export function armarMensaje(plantilla, valores) {
  const lineas = [];
  for (const linea of String(plantilla ?? '').split('\n')) {
    let vacio = false;
    const t = linea.replace(/\{([a-z_]+)\}(\.?)/g, (m, k, punto) => {
      if (!Object.prototype.hasOwnProperty.call(valores, k)) return m;
      const v = valores[k] === null || valores[k] === undefined ? '' : String(valores[k]);
      if (!v.trim()) vacio = true;
      // «{horario}.» con «… p. m.»: un dato que ya cierra con punto no lleva otro.
      return v + (punto && v.endsWith('.') ? '' : punto);
    });
    if (!vacio) lineas.push(t);
  }
  return lineas.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * El texto de una campaña como se guarda. undefined = no vino (una página
 * anterior: se conserva el que había); vacío o igual al de Xabor = null.
 */
export function validarMensaje(valor, tipo) {
  if (valor === undefined) return undefined;
  const t = String(valor ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!t) return null;
  const campo = `mensaje_${tipo}`;
  if (t.length > 1500) {
    throw new TemporadaError(`El mensaje de ${NOMBRE_MENSAJE[tipo]} es muy largo: máximo 1500 letras.`, 'MENSAJE_INVALIDO', 400, { campo });
  }
  const usados = [...t.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
  const raros = [...new Set(usados.filter((k) => !CAMPOS_MENSAJE.includes(k)))];
  if (raros.length) {
    throw new TemporadaError(`En el mensaje de ${NOMBRE_MENSAJE[tipo]} no conozco ${raros.map((k) => `{${k}}`).join(', ')}. ` +
      `Puedes usar: ${CAMPOS_MENSAJE.map((k) => `{${k}}`).join(' ')}.`, 'MENSAJE_INVALIDO', 400, { campo });
  }
  if (/[{}]/.test(t.replace(/\{[a-z_]+\}/g, ''))) {
    throw new TemporadaError(`En el mensaje de ${NOMBRE_MENSAJE[tipo]} hay una llave { o } suelta: cada dato va como {folio}.`,
      'MENSAJE_INVALIDO', 400, { campo });
  }
  return t === MENSAJES_OMISION[tipo] ? null : t;
}

/** Lo que dice {pago}: «ya está pagado», «pagaste $X, quedan $Y por pagar» o «$Y por pagar». */
function textoPago(totalC, pagadoC) {
  if (totalC === null) return '';
  const saldo = Math.max(0, totalC - pagadoC);
  if (saldo === 0) return 'ya está pagado';
  return pagadoC > 0 ? `pagaste ${pesosTexto(pagadoC)}, quedan ${pesosTexto(saldo)} por pagar` : `${pesosTexto(saldo)} por pagar`;
}

/** Los valores de un pedido para sus mensajes (montos del servidor, en centavos). */
function valoresMensaje(p, c, folio, totalC, pagadoC) {
  const dom = p.modalidad === 'domicilio';
  return {
    nombre: p.nombre, folio, platillos: p.platillos, producto: c.producto, fecha: fechaTexto(c.fecha),
    horario: horarioTexto(p.ventana_inicio, p.ventana_fin), tipo: dom ? 'Entrega a domicilio' : 'Pasas a recoger',
    direccion: dom ? p.direccion : '', referencias: dom ? p.referencias : '', notas: p.notas,
    total: totalC === null ? '' : pesosTexto(totalC), pagado: totalC === null ? '' : pesosTexto(pagadoC),
    saldo: totalC === null ? '' : pesosTexto(Math.max(0, totalC - pagadoC)), pago: textoPago(totalC, pagadoC),
  };
}

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
    total: precioDe(p, c) === null ? null : (precioDe(p, c) * p.platillos) / 100,
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
    // El precio se congela al agendar: si la campaña cambia de precio después,
    // este pedido conserva el que vio el cliente.
    const { rows: [nuevo] } = await cliente.query(
      `INSERT INTO temporada_pedidos AS p (campana_id, negocio_id, numero, nombre, telefono, platillos, modalidad,
                                           direccion, referencias, notas, ventana_inicio, ventana_fin, clave_envio,
                                           precio_unitario)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::time, $12::time, $13, $14)
       RETURNING ${COLUMNAS_PEDIDO}`,
      [c.id, c.negocio_id, siguiente, d.nombre, d.telefono, d.platillos, d.modalidad,
        d.direccion, d.referencias, d.notas, v.inicio, v.fin, d.claveEnvio, c.precio]);
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
    // Anticipo: 'ninguno', 'porcentaje' (valor = %) o 'monto' (valor = pesos).
    anticipo_tipo: c.anticipo_tipo || 'ninguno',
    anticipo_valor: c.anticipo_valor === null || c.anticipo_valor === undefined ? null : Number(c.anticipo_valor),
    // Textos de WhatsApp de la campaña; null = el de Xabor (MENSAJES_OMISION).
    mensaje_confirmacion: c.mensaje_confirmacion ?? null,
    mensaje_recordatorio: c.mensaje_recordatorio ?? null,
    zona,
  };
}

/** El anticipo de la campaña como lo pide resumenPago (monto en centavos). */
function anticipoDe(c) {
  const tipo = c.anticipo_tipo || 'ninguno';
  if (tipo === 'porcentaje') return { tipo, valor: Number(c.anticipo_valor) };
  if (tipo === 'monto') return { tipo, valor: aCentavos(c.anticipo_valor) };
  return { tipo: 'ninguno', valor: null };
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
    // Para el formulario: el texto de Xabor y los datos que puede llevar.
    mensajesOmision: MENSAJES_OMISION,
    camposMensaje: CAMPOS_MENSAJE,
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
  // Anticipo. Sin el campo (una página anterior a la 139) queda undefined y
  // guardarCampana conserva el que ya tenía la campaña.
  let anticipoTipo, anticipoValor;
  if (d.anticipo_tipo !== undefined) {
    anticipoTipo = String(d.anticipo_tipo ?? 'ninguno');
    if (!TIPOS_ANTICIPO.includes(anticipoTipo)) throw new TemporadaError('Revisa el anticipo.', 'ANTICIPO_INVALIDO');
    anticipoValor = null;
    if (anticipoTipo !== 'ninguno') {
      if (precio === null) {
        throw new TemporadaError('Para pedir anticipo, primero pon el precio por platillo.', 'ANTICIPO_SIN_PRECIO');
      }
      const v = Number(d.anticipo_valor);
      const max = anticipoTipo === 'porcentaje' ? 100 : 1000000;
      if (!Number.isFinite(v) || v <= 0 || v > max || Math.abs(Math.round(v * 100) - v * 100) > 1e-6) {
        throw new TemporadaError(anticipoTipo === 'porcentaje' ? 'El anticipo es un porcentaje entre 1 y 100.'
          : 'Escribe el monto del anticipo en pesos.', 'ANTICIPO_INVALIDO');
      }
      anticipoValor = v;
    }
  }
  return {
    clave, fecha: d.fecha, hora_inicio: horaDeMinutos(ini), hora_fin: horaDeMinutos(fin), minutos_ventana: minutos,
    titulo: texto(d.titulo, { min: 1, max: 120, campo: 'título', codigo: 'TITULO_INVALIDO' }),
    producto: texto(d.producto ?? 'Platillo', { min: 1, max: 80, campo: 'producto', codigo: 'PRODUCTO_INVALIDO' }),
    descripcion: String(d.descripcion ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, 2000),
    precio, prefijo, cupo_platillos: cupoPlatillos, cupo_domicilio: cupoDomicilio, max_platillos_pedido: maxPedido,
    acepta_recoger: recoger, acepta_domicilio: domicilio, cierra_en: cierra, activa: d.activa === true,
    anticipo_tipo: anticipoTipo, anticipo_valor: anticipoValor,
    // undefined (una página anterior) conserva el texto que ya tenía.
    mensaje_confirmacion: validarMensaje(d.mensaje_confirmacion, 'confirmacion'),
    mensaje_recordatorio: validarMensaje(d.mensaje_recordatorio, 'recordatorio'),
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
    // Sin precio no hay anticipo (la base también lo exige).
    const anticipo = (tipo, valor) => {
      if (tipo !== 'ninguno' && d.precio === null) {
        throw new TemporadaError('Para pedir anticipo, primero pon el precio por platillo.', 'ANTICIPO_SIN_PRECIO');
      }
      return [tipo, tipo === 'ninguno' ? null : valor];
    };
    if (id === null) {
      ({ rows: [fila] } = await cliente.query(
        `INSERT INTO temporada_campanas AS c (clave, titulo, descripcion, producto, precio, prefijo, fecha, hora_inicio,
           hora_fin, minutos_ventana, cupo_platillos, cupo_domicilio, max_platillos_pedido, acepta_recoger,
           acepta_domicilio, cierra_en, activa, negocio_id, anticipo_tipo, anticipo_valor,
           mensaje_confirmacion, mensaje_recordatorio)
         VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::time,$9::time,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         RETURNING ${COLUMNAS_CAMPANA}`,
        [...valores, negocioId, ...anticipo(d.anticipo_tipo ?? 'ninguno', d.anticipo_valor ?? null),
          d.mensaje_confirmacion ?? null, d.mensaje_recordatorio ?? null]));
    } else {
      const idNum = /^\d{1,18}$/.test(String(id)) ? String(id) : null;
      const { rows: [actual] } = idNum ? await cliente.query(
        `SELECT ${COLUMNAS_CAMPANA} FROM temporada_campanas c WHERE c.id = $1 AND c.negocio_id = $2 FOR UPDATE`,
        [idNum, negocioId]) : { rows: [] };
      if (!actual) throw new TemporadaError('Campaña no encontrada', 'NO_ENCONTRADA', 404);
      const [anticipoTipo, anticipoValor] = d.anticipo_tipo === undefined
        ? anticipo(actual.anticipo_tipo, actual.anticipo_valor) : anticipo(d.anticipo_tipo, d.anticipo_valor);
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
                cierra_en=$16, activa=$17, anticipo_tipo=$20, anticipo_valor=$21,
                mensaje_confirmacion=$22, mensaje_recordatorio=$23, actualizado_en=now()
          WHERE c.id = $18 AND c.negocio_id = $19 RETURNING ${COLUMNAS_CAMPANA}`,
        [...valores, idNum, negocioId, anticipoTipo, anticipoValor,
          d.mensaje_confirmacion === undefined ? actual.mensaje_confirmacion : d.mensaje_confirmacion,
          d.mensaje_recordatorio === undefined ? actual.mensaje_recordatorio : d.mensaje_recordatorio]));
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
    `SELECT ${COLUMNAS_PEDIDO}, uc.nombre AS creado_por_nombre
       FROM temporada_pedidos p LEFT JOIN usuarios uc ON uc.id = p.creado_por
      WHERE p.campana_id = $1
      ORDER BY p.ventana_inicio, p.numero`, [c.id]);
  const { rows: movimientos } = await db.query(
    `SELECT g.id, g.pedido_id, g.monto, g.metodo, g.referencia, g.registrado_en, g.anulado_en, g.motivo_anulacion,
            ur.nombre AS registrado_por_nombre, ua.nombre AS anulado_por_nombre
       FROM temporada_pagos g JOIN temporada_pedidos p ON p.id = g.pedido_id
       LEFT JOIN usuarios ur ON ur.id = g.registrado_por LEFT JOIN usuarios ua ON ua.id = g.anulado_por
      WHERE p.campana_id = $1 AND g.negocio_id = $2 ORDER BY g.registrado_en, g.id`, [c.id, negocioId]);
  const pagosDe = new Map();
  for (const g of movimientos) {
    const k = String(g.pedido_id);
    if (!pagosDe.has(k)) pagosDe.set(k, []);
    pagosDe.get(k).push(g);
  }
  // Quién movió por última vez la entrega de cada pedido, quién lo editó y
  // quién abrió WhatsApp para cada mensaje (de la bitácora).
  const { rows: ultimos } = await db.query(
    `SELECT DISTINCT ON (b.pedido_id, b.accion) b.pedido_id, b.accion, b.creado_en, u.nombre
       FROM temporada_bitacora b LEFT JOIN usuarios u ON u.id = b.usuario_id
      WHERE b.campana_id = $1 AND b.negocio_id = $2
        AND b.accion IN ('entrega_cambiada', 'editado', 'whatsapp_confirmacion', 'whatsapp_recordatorio')
      ORDER BY b.pedido_id, b.accion, b.id DESC`, [c.id, negocioId]);
  const entregaPor = new Map(), editadoPor = new Map(), whatsappPor = new Map();
  for (const r of ultimos) {
    const k = String(r.pedido_id);
    if (r.accion === 'entrega_cambiada') entregaPor.set(k, r.nombre || null);
    else if (r.accion === 'editado') editadoPor.set(k, { en: r.creado_en, por: r.nombre || null });
    else whatsappPor.set(`${k}:${r.accion.slice('whatsapp_'.length)}`, { en: r.creado_en, por: r.nombre || null });
  }
  // Cuántos pedidos confirmados de cada ventana van en cada paso.
  const pasos = {};
  for (const p of rows) {
    if (p.estado !== 'confirmado') continue;
    const k = p.ventana_inicio;
    pasos[k] ||= Object.fromEntries(ESTADOS_ENTREGA.map((e) => [e, 0]));
    pasos[k][ESTADOS_ENTREGA.includes(p.estado_entrega) ? p.estado_entrega : 'agendado'] += 1;
  }
  const anticipo = anticipoDe(c);
  // Cada pedido también en centavos, para los totales de arriba: la página no
  // suma dinero.
  const cuentas = [];
  const pedidos = rows.map((p) => {
    const pagos = pagosDe.get(String(p.id)) || [];
    const precio = precioDe(p, c);
    const movs = pagos.map((g) => ({ monto: aCentavos(g.monto), metodo: g.metodo, anulado: !!g.anulado_en }));
    const resumen = resumenPago({ precio, platillos: p.platillos, anticipo, pagos: movs });
    const pagadoC = movs.reduce((s, g) => s + (g.anulado ? 0 : g.monto), 0);
    cuentas.push({ estado: p.estado, total: precio === null ? null : precio * p.platillos, pagado: pagadoC });
    // Un cancelado ya no debe nada: lo que haya pagado está por devolver
    // (deja de contar cuando se anula ese pago, al devolverlo).
    const cancelado = p.estado !== 'confirmado';
    const pago = cancelado
      ? { ...resumen, saldo: resumen.saldo === null ? null : 0, faltaAnticipo: 0, porDevolver: aPesos(pagadoC) }
      : { ...resumen, porDevolver: resumen.excedente };
    const folio = folioDe(c.prefijo, p.numero);
    // Los dos mensajes ya armados (la página solo los pone en el enlace) y
    // cuándo se abrió WhatsApp para cada uno. A un cancelado no se le escribe.
    let whatsapp = null;
    if (!cancelado) {
      const v = valoresMensaje(p, c, folio, precio === null ? null : precio * p.platillos, pagadoC);
      whatsapp = {
        numero: numeroWhatsApp(p.telefono),
        confirmacion: armarMensaje(c.mensaje_confirmacion || MENSAJES_OMISION.confirmacion, v),
        recordatorio: armarMensaje(c.mensaje_recordatorio || MENSAJES_OMISION.recordatorio, v),
        enviado: {
          confirmacion: whatsappPor.get(`${p.id}:confirmacion`) || null,
          recordatorio: whatsappPor.get(`${p.id}:recordatorio`) || null,
        },
      };
    }
    return {
      id: String(p.id), folio, nombre: p.nombre, telefono: p.telefono,
      platillos: p.platillos, modalidad: p.modalidad, direccion: p.direccion, referencias: p.referencias,
      notas: p.notas, ventana: { inicio: p.ventana_inicio, fin: p.ventana_fin }, estado: p.estado,
      creado_en: p.creado_en, cancelado_en: p.cancelado_en,
      // 'formulario' (la página) o 'panel' (capturado aquí, con quién).
      origen: p.origen || 'formulario', creado_por: p.creado_por_nombre || null,
      editado: editadoPor.get(String(p.id)) || null,
      entrega: { estado: p.estado_entrega || 'agendado', cambiada_en: p.entrega_cambiada_en || null,
        por: entregaPor.get(String(p.id)) || null },
      precio: precio === null ? null : precio / 100,
      whatsapp,
      pago: {
        ...pago,
        movimientos: pagos.map((g) => ({
          id: String(g.id), monto: Number(g.monto), metodo: g.metodo, referencia: g.referencia,
          registrado_en: g.registrado_en, registrado_por: g.registrado_por_nombre || null,
          anulado: !!g.anulado_en, anulado_en: g.anulado_en, anulado_por: g.anulado_por_nombre || null,
          motivo_anulacion: g.motivo_anulacion,
        })),
      },
    };
  });
  return {
    campana: campanaParaAdmin(c, zona),
    ventanas: ventanasDe(c).map((v) => {
      const u = uso[v.inicio] || { platillos: 0, domicilios: 0, pedidos: 0 };
      const e = pasos[v.inicio] || Object.fromEntries(ESTADOS_ENTREGA.map((x) => [x, 0]));
      return { ...v, platillos: u.platillos, domicilios: u.domicilios, pedidos: u.pedidos,
        cupoPlatillos: c.cupo_platillos, cupoDomicilio: c.cupo_domicilio,
        entrega: { ...e, entregados: e.entregado, pendientes: e.agendado + e.en_preparacion + e.listo } };
    }),
    // Venta total, cobrado, por cobrar y por devolver (punto 4).
    totales: totalesTemporada(cuentas, { campanaConPrecio: aCentavos(c.precio) !== null }),
    pedidos,
  };
}

// ─── Bitácora y pagos ──────────────────────────────────────────────────────

/** Una línea de la bitácora: quién (usuario de la sesión), qué y cuándo. */
async function anotar(db, { negocioId, campanaId, pedidoId = null, usuarioId = null, accion, detalle = {} }) {
  await db.query(
    `INSERT INTO temporada_bitacora (negocio_id, campana_id, pedido_id, usuario_id, accion, detalle)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [negocioId, campanaId, pedidoId, usuarioId || null, accion, JSON.stringify(detalle)]);
}

const ID_RE = /^\d{1,18}$/;
const idValido = (v) => (ID_RE.test(String(v ?? '')) ? String(v) : null);

/** Monto en pesos con a lo más dos decimales → centavos. */
function montoDe(valor) {
  const s = typeof valor === 'number' ? String(valor) : String(valor ?? '').trim().replace(/[$,\s]/g, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) {
    throw new TemporadaError('Escribe el monto en pesos (p. ej. 229 o 114.50).', 'MONTO_INVALIDO', 400, { campo: 'monto' });
  }
  const c = Math.round(Number(s) * 100);
  if (c <= 0) throw new TemporadaError('El monto debe ser mayor que cero.', 'MONTO_INVALIDO', 400, { campo: 'monto' });
  return c;
}

/**
 * Registra un pago (anticipo o liquidación) de un pedido del negocio. Bloquea
 * el pedido: dos cajeros que cobran a la vez el mismo saldo no lo cobran dos
 * veces. Nunca acepta más que el saldo.
 */
export async function registrarPagoTemporada(negocioId, pedidoId, cuerpo, { actorId = null, db = pool } = {}) {
  const idNum = idValido(pedidoId);
  if (!idNum) throw new TemporadaError('Pedido no encontrado', 'NO_ENCONTRADO', 404);
  const b = cuerpo && typeof cuerpo === 'object' ? cuerpo : {};
  const monto = montoDe(b.monto);
  const metodo = String(b.metodo ?? '');
  if (!METODOS_PAGO.includes(metodo)) {
    throw new TemporadaError('Elige cómo pagó: efectivo, transferencia o tarjeta.', 'METODO_INVALIDO', 400, { campo: 'metodo' });
  }
  const referencia = texto(b.referencia, { max: 120, campo: 'referencia' }) || null;
  if (!actorId) throw new TemporadaError('Inicia sesión de nuevo.', 'SIN_USUARIO', 403);
  const cliente = await db.connect();
  try {
    await cliente.query('BEGIN');
    const { rows: [p] } = await cliente.query(
      `SELECT ${COLUMNAS_PEDIDO}, p.negocio_id FROM temporada_pedidos p
        WHERE p.id = $1 AND p.negocio_id = $2 FOR UPDATE`, [idNum, negocioId]);
    if (!p) throw new TemporadaError('Pedido no encontrado', 'NO_ENCONTRADO', 404);
    if (p.estado !== 'confirmado') throw new TemporadaError('Ese pedido está cancelado: no se le registran pagos.', 'PEDIDO_CANCELADO', 409);
    const { rows: [c] } = await cliente.query(
      `SELECT ${COLUMNAS_CAMPANA} FROM temporada_campanas c WHERE c.id = $1 AND c.negocio_id = $2`, [p.campana_id, negocioId]);
    const precio = precioDe(p, c);
    if (precio === null) {
      throw new TemporadaError('Esta campaña no tiene precio: ponlo en la configuración para registrar pagos.', 'SIN_PRECIO', 409);
    }
    const { rows: previos } = await cliente.query(
      `SELECT monto, metodo, anulado_en FROM temporada_pagos WHERE pedido_id = $1`, [idNum]);
    const antes = resumenPago({ precio, platillos: p.platillos, anticipo: anticipoDe(c),
      pagos: previos.map((g) => ({ monto: aCentavos(g.monto), metodo: g.metodo, anulado: !!g.anulado_en })) });
    const saldo = aCentavos(antes.saldo);
    if (saldo <= 0) throw new TemporadaError('Ese pedido ya está pagado.', 'YA_PAGADO', 409);
    if (monto > saldo) {
      throw new TemporadaError(`El saldo de este pedido es de $${(saldo / 100).toFixed(2)}: no se puede registrar más.`,
        'PAGO_EXCEDE', 409, { saldo: saldo / 100 });
    }
    const { rows: [g] } = await cliente.query(
      `INSERT INTO temporada_pagos (pedido_id, negocio_id, monto, metodo, referencia, registrado_por)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [idNum, negocioId, (monto / 100).toFixed(2), metodo, referencia, actorId]);
    const despues = resumenPago({ precio, platillos: p.platillos, anticipo: anticipoDe(c),
      pagos: [...previos.map((x) => ({ monto: aCentavos(x.monto), metodo: x.metodo, anulado: !!x.anulado_en })),
        { monto, metodo, anulado: false }] });
    await anotar(cliente, { negocioId, campanaId: p.campana_id, pedidoId: idNum, usuarioId: actorId, accion: 'pago_registrado',
      detalle: { pago_id: String(g.id), monto: monto / 100, metodo, referencia, estado: despues.estado, saldo: despues.saldo } });
    await cliente.query('COMMIT');
    return { ok: true, pagoId: String(g.id), pago: despues };
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

/** Anula un pago mal capturado (o devuelto). No lo borra: queda quién, cuándo y por qué. */
export async function anularPagoTemporada(negocioId, pagoId, cuerpo, { actorId = null, db = pool } = {}) {
  const idNum = idValido(pagoId);
  if (!idNum) throw new TemporadaError('Pago no encontrado', 'NO_ENCONTRADO', 404);
  const motivo = texto(cuerpo?.motivo, { min: 3, max: 300, campo: 'motivo', codigo: 'MOTIVO_REQUERIDO',
    mensaje: 'Escribe por qué se anula el pago.' });
  if (!actorId) throw new TemporadaError('Inicia sesión de nuevo.', 'SIN_USUARIO', 403);
  const cliente = await db.connect();
  try {
    await cliente.query('BEGIN');
    const { rows: [g] } = await cliente.query(
      `SELECT g.id, g.pedido_id, g.monto, g.metodo, g.anulado_en, p.campana_id
         FROM temporada_pagos g JOIN temporada_pedidos p ON p.id = g.pedido_id
        WHERE g.id = $1 AND g.negocio_id = $2 FOR UPDATE OF g, p`, [idNum, negocioId]);
    if (!g) throw new TemporadaError('Pago no encontrado', 'NO_ENCONTRADO', 404);
    if (g.anulado_en) throw new TemporadaError('Ese pago ya estaba anulado.', 'YA_ANULADO', 409);
    await cliente.query(
      `UPDATE temporada_pagos SET anulado_en = now(), anulado_por = $2, motivo_anulacion = $3 WHERE id = $1`,
      [idNum, actorId, motivo]);
    await anotar(cliente, { negocioId, campanaId: g.campana_id, pedidoId: String(g.pedido_id), usuarioId: actorId,
      accion: 'pago_anulado', detalle: { pago_id: idNum, monto: Number(g.monto), metodo: g.metodo, motivo } });
    await cliente.query('COMMIT');
    return { ok: true };
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

const NOMBRE_ENTREGA = { agendado: 'Agendado', en_preparacion: 'En preparación', listo: 'Listo', entregado: 'Entregado' };

/**
 * Mueve la entrega de un pedido un paso adelante (o uno atrás, para deshacer
 * un toque equivocado). `desde` es el paso que veía quien pulsó: si otra
 * tableta ya lo movió, no se pisa y se avisa en qué paso quedó. Bloquea el
 * pedido y anota en la bitácora quién y cuándo, en la misma transacción.
 */
export async function cambiarEntregaTemporada(negocioId, pedidoId, cuerpo, { actorId = null, db = pool } = {}) {
  const idNum = idValido(pedidoId);
  if (!idNum) throw new TemporadaError('Pedido no encontrado', 'NO_ENCONTRADO', 404);
  const b = cuerpo && typeof cuerpo === 'object' ? cuerpo : {};
  const a = String(b.estado ?? ''), desde = String(b.desde ?? '');
  if (!ESTADOS_ENTREGA.includes(a) || !ESTADOS_ENTREGA.includes(desde)) {
    throw new TemporadaError('Paso de entrega desconocido.', 'ENTREGA_INVALIDA', 400);
  }
  if (Math.abs(ESTADOS_ENTREGA.indexOf(a) - ESTADOS_ENTREGA.indexOf(desde)) !== 1) {
    throw new TemporadaError('La entrega avanza (o se regresa) un paso a la vez.', 'ENTREGA_SALTO', 400);
  }
  if (!actorId) throw new TemporadaError('Inicia sesión de nuevo.', 'SIN_USUARIO', 403);
  const cliente = await db.connect();
  try {
    await cliente.query('BEGIN');
    const { rows: [p] } = await cliente.query(
      `SELECT id, campana_id, numero, estado, estado_entrega FROM temporada_pedidos
        WHERE id = $1 AND negocio_id = $2 FOR UPDATE`, [idNum, negocioId]);
    if (!p) throw new TemporadaError('Pedido no encontrado', 'NO_ENCONTRADO', 404);
    if (p.estado !== 'confirmado') {
      throw new TemporadaError('Ese pedido está cancelado: no se le cambia la entrega.', 'PEDIDO_CANCELADO', 409);
    }
    if (p.estado_entrega !== desde) {
      throw new TemporadaError(`Alguien más ya lo cambió: va en «${NOMBRE_ENTREGA[p.estado_entrega] || p.estado_entrega}».`,
        'ENTREGA_CAMBIO', 409, { estado_entrega: p.estado_entrega });
    }
    const { rows: [n] } = await cliente.query(
      `UPDATE temporada_pedidos SET estado_entrega = $2, entrega_cambiada_en = now(), actualizado_en = now()
        WHERE id = $1 RETURNING entrega_cambiada_en`, [idNum, a]);
    await anotar(cliente, { negocioId, campanaId: p.campana_id, pedidoId: idNum, usuarioId: actorId,
      accion: 'entrega_cambiada', detalle: { de: desde, a, numero: p.numero } });
    await cliente.query('COMMIT');
    return { ok: true, estado_entrega: a, entrega_cambiada_en: n.entrega_cambiada_en };
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

// ─── Captura y edición desde el panel ──────────────────────────────────────
// Para los pedidos que llegan por WhatsApp o por teléfono. El administrador
// puede agendar aunque la página ya no reciba pedidos (cerrada o apagada) y en
// un horario que ya empezó: esas reglas protegen al cliente que pide solo, no
// a quien captura sabiendo lo que hace. Los CUPOS sí se respetan; pasarlos
// exige `exceder: true` (la página lo pide después de mostrar la advertencia)
// y queda anotado en la bitácora.

// Lo que dice el formulario público le habla al cliente («Escribe tu
// nombre»); en el panel se le habla a quien captura.
const MENSAJES_PANEL = {
  NOMBRE_INVALIDO: 'Escribe el nombre del cliente (de 2 a 80 letras).',
  MODALIDAD_INVALIDA: 'Elige si pasa a recoger o es a domicilio.',
  ENVIO_INVALIDO: 'Cierra la ventana y vuelve a abrir «Nuevo pedido».',
};
function validarParaPanel(b, claveEnvio) {
  try {
    return validarEntradaPedido({ ...(b && typeof b === 'object' ? b : {}), claveEnvio });
  } catch (e) {
    if (e instanceof TemporadaError && MENSAJES_PANEL[e.codigo]) e.message = MENSAJES_PANEL[e.codigo];
    throw e;
  }
}

async function campanaDelNegocio(cliente, negocioId, campanaId) {
  const idNum = idValido(campanaId);
  const { rows: [c] } = idNum ? await cliente.query(
    `SELECT ${COLUMNAS_CAMPANA} FROM temporada_campanas c WHERE c.id = $1 AND c.negocio_id = $2 FOR UPDATE`,
    [idNum, negocioId]) : { rows: [] };
  if (!c) throw new TemporadaError('Campaña no encontrada', 'NO_ENCONTRADA', 404);
  return c;
}

function modalidadAceptada(c, modalidad) {
  if (modalidad === 'recoger' && !c.acepta_recoger) {
    throw new TemporadaError('Esta campaña no acepta pedidos para recoger. Cámbialo en la configuración si hace falta.', 'MODALIDAD_NO_DISPONIBLE');
  }
  if (modalidad === 'domicilio' && !c.acepta_domicilio) {
    throw new TemporadaError('Esta campaña no acepta pedidos a domicilio. Cámbialo en la configuración si hace falta.', 'MODALIDAD_NO_DISPONIBLE');
  }
}

/**
 * Qué cupos pasaría el pedido en su ventana. `propio` = lo que el mismo
 * pedido ya ocupa en esa ventana (al editarlo, no se cuenta dos veces).
 * Bajar platillos o quedarse igual nunca advierte, aunque el horario ya
 * estuviera pasado de cupo.
 */
function excesosDeCupo(c, uso, { ventana, platillos, modalidad }, propio = null) {
  const u = uso[ventana] || { platillos: 0, domicilios: 0 };
  const ocupados = u.platillos - (propio ? propio.platillos : 0);
  const domicilios = u.domicilios - (propio && propio.modalidad === 'domicilio' ? 1 : 0);
  const libres = c.cupo_platillos - ocupados;
  const excesos = [];
  if (platillos > c.max_platillos_pedido && !(propio && platillos <= propio.platillosAntes)) {
    excesos.push({ codigo: 'DEMASIADOS_PLATILLOS',
      texto: `El máximo por pedido es de ${c.max_platillos_pedido} platillos y este lleva ${platillos}.` });
  }
  if (platillos > libres && !(propio && platillos <= propio.platillos)) {
    excesos.push({ codigo: 'VENTANA_LLENA', texto: libres > 0
      ? `En ese horario quedan ${libres} de ${c.cupo_platillos} platillos y este pedido lleva ${platillos}.`
      : `Ese horario ya tiene sus ${c.cupo_platillos} platillos (o más) agendados.` });
  }
  if (modalidad === 'domicilio' && domicilios >= c.cupo_domicilio && !(propio && propio.modalidad === 'domicilio')) {
    excesos.push({ codigo: 'DOMICILIO_LLENO',
      texto: `Ese horario ya tiene sus ${c.cupo_domicilio} entregas a domicilio.` });
  }
  return { excesos, libres: Math.max(0, libres), domiciliosLibres: Math.max(0, c.cupo_domicilio - domicilios) };
}

function exigirPermisoDeExceder(medida, exceder) {
  if (!medida.excesos.length || exceder === true) return medida.excesos.map((x) => x.codigo);
  throw new TemporadaError(medida.excesos.map((x) => x.texto).join(' '), 'CUPO_EXCEDIDO', 409, {
    excesos: medida.excesos, libres: medida.libres, domiciliosLibres: medida.domiciliosLibres,
  });
}

/**
 * Agenda un pedido desde el panel (llegó por WhatsApp o por teléfono).
 * `claveEnvio` la genera la página al abrir «Nuevo pedido»: guardar dos veces
 * (doble clic, red caída) devuelve el mismo pedido.
 */
export async function crearPedidoPanel(negocioId, campanaId, cuerpo, { actorId = null, db = pool } = {}) {
  const b = cuerpo && typeof cuerpo === 'object' ? cuerpo : {};
  const d = validarParaPanel(b, String(b.claveEnvio ?? ''));
  if (!actorId) throw new TemporadaError('Inicia sesión de nuevo.', 'SIN_USUARIO', 403);
  const cliente = await db.connect();
  try {
    await cliente.query('BEGIN');
    // El mismo candado que las altas de la página: el cupo se mide con todo
    // lo anterior ya contado, venga de donde venga.
    const c = await campanaDelNegocio(cliente, negocioId, campanaId);
    const { rows: [previo] } = await cliente.query(
      `SELECT id, numero FROM temporada_pedidos WHERE campana_id = $1 AND clave_envio = $2`, [c.id, d.claveEnvio]);
    if (previo) {
      await cliente.query('COMMIT');
      return { ok: true, repetido: true, pedido: { id: String(previo.id), folio: folioDe(c.prefijo, previo.numero) } };
    }
    modalidadAceptada(c, d.modalidad);
    const v = ventanasDe(c).find((x) => x.inicio === d.ventana);
    if (!v) throw new TemporadaError('Elige uno de los horarios de la lista.', 'VENTANA_INVALIDA');
    const excedio = exigirPermisoDeExceder(excesosDeCupo(c, await usoPorVentana(c.id, cliente), d), b.exceder);

    const { rows: [{ siguiente }] } = await cliente.query(
      `SELECT COALESCE(MAX(numero), 0) + 1 AS siguiente FROM temporada_pedidos WHERE campana_id = $1`, [c.id]);
    const { rows: [nuevo] } = await cliente.query(
      `INSERT INTO temporada_pedidos (campana_id, negocio_id, numero, nombre, telefono, platillos, modalidad,
                                      direccion, referencias, notas, ventana_inicio, ventana_fin, clave_envio,
                                      precio_unitario, origen, creado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::time, $12::time, $13, $14, 'panel', $15)
       RETURNING id, numero`,
      [c.id, negocioId, siguiente, d.nombre, d.telefono, d.platillos, d.modalidad,
        d.direccion, d.referencias, d.notas, v.inicio, v.fin, d.claveEnvio, c.precio, actorId]);
    await anotar(cliente, { negocioId, campanaId: c.id, pedidoId: String(nuevo.id), usuarioId: actorId, accion: 'creado_panel',
      detalle: { numero: nuevo.numero, platillos: d.platillos, ventana: v.inicio, modalidad: d.modalidad, excedio } });
    await cliente.query('COMMIT');
    return { ok: true, repetido: false, excedio, pedido: { id: String(nuevo.id), folio: folioDe(c.prefijo, nuevo.numero) } };
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

// Lo que se puede editar, como lo guarda la base. `ventana` = su inicio.
const CAMPOS_EDITABLES = ['nombre', 'telefono', 'platillos', 'ventana', 'modalidad', 'direccion', 'referencias', 'notas'];
const comoEnBase = (p) => ({
  nombre: p.nombre, telefono: p.telefono, platillos: p.platillos, ventana: p.ventana_inicio, modalidad: p.modalidad,
  direccion: p.direccion ?? null, referencias: p.referencias ?? null, notas: p.notas ?? null,
});
// '' y null son lo mismo («sin notas»); los platillos se comparan como número.
const igualCampo = (k, a, b) => (k === 'platillos' ? Number(a) === Number(b) : String(a ?? '') === String(b ?? ''));

/**
 * Edita un pedido confirmado sin cancelarlo: cantidad, horario, tipo,
 * dirección, referencias, notas, nombre y teléfono. `antes` trae lo que veía
 * quien edita: si alguien más lo cambió mientras tanto, no se pisa (409). Al
 * cambiar de horario, de tipo o de cantidad se vuelve a medir el cupo. Cada
 * cambio queda en la bitácora con su valor anterior, quién y cuándo.
 */
export async function editarPedidoTemporada(negocioId, pedidoId, cuerpo, { actorId = null, db = pool } = {}) {
  const idNum = idValido(pedidoId);
  if (!idNum) throw new TemporadaError('Pedido no encontrado', 'NO_ENCONTRADO', 404);
  const b = cuerpo && typeof cuerpo === 'object' ? cuerpo : {};
  // Una clave fija y válida: al editar no hay envío que deduplicar.
  const d = validarParaPanel(b, 'edicion-panel');
  const antes = b.antes && typeof b.antes === 'object' ? b.antes : null;
  if (!antes || CAMPOS_EDITABLES.some((k) => !(k in antes))) {
    throw new TemporadaError('Recarga la página y vuelve a abrir el pedido.', 'EDICION_INVALIDA');
  }
  if (!actorId) throw new TemporadaError('Inicia sesión de nuevo.', 'SIN_USUARIO', 403);
  const cliente = await db.connect();
  try {
    await cliente.query('BEGIN');
    const { rows: [ref] } = await cliente.query(
      `SELECT campana_id FROM temporada_pedidos WHERE id = $1 AND negocio_id = $2`, [idNum, negocioId]);
    if (!ref) throw new TemporadaError('Pedido no encontrado', 'NO_ENCONTRADO', 404);
    // Primero la campaña y después el pedido, en el mismo orden que el alta:
    // el cupo se mide sin que entre otro pedido a la vez.
    const c = await campanaDelNegocio(cliente, negocioId, ref.campana_id);
    const { rows: [p] } = await cliente.query(
      `SELECT ${COLUMNAS_PEDIDO} FROM temporada_pedidos p WHERE p.id = $1 AND p.negocio_id = $2 FOR UPDATE`,
      [idNum, negocioId]);
    if (!p) throw new TemporadaError('Pedido no encontrado', 'NO_ENCONTRADO', 404);
    if (p.estado !== 'confirmado') {
      throw new TemporadaError('Ese pedido está cancelado: no se edita.', 'PEDIDO_CANCELADO', 409);
    }
    const actual = comoEnBase(p);
    if (CAMPOS_EDITABLES.some((k) => !igualCampo(k, antes[k], actual[k]))) {
      throw new TemporadaError('Alguien más cambió este pedido mientras lo editabas. Ciérralo y vuelve a abrirlo para ver lo nuevo.',
        'EDITADO_POR_OTRO', 409);
    }
    const nuevo = { nombre: d.nombre, telefono: d.telefono, platillos: d.platillos, ventana: d.ventana,
      modalidad: d.modalidad, direccion: d.direccion, referencias: d.referencias, notas: d.notas };
    const cambios = {};
    for (const k of CAMPOS_EDITABLES) {
      if (!igualCampo(k, actual[k], nuevo[k])) cambios[k] = { de: actual[k], a: nuevo[k] };
    }
    if (!Object.keys(cambios).length) {
      await cliente.query('COMMIT');
      return { ok: true, cambios, excedio: [] };
    }
    const v = ventanasDe(c).find((x) => x.inicio === nuevo.ventana);
    if (!v) throw new TemporadaError('Elige uno de los horarios de la lista.', 'VENTANA_INVALIDA');
    // Un tipo que la campaña ya no acepta solo se rechaza si se está cambiando a él.
    if (cambios.modalidad) modalidadAceptada(c, nuevo.modalidad);
    let excedio = [];
    if (cambios.ventana || cambios.platillos || cambios.modalidad) {
      const mismaVentana = actual.ventana === nuevo.ventana;
      const propio = { platillosAntes: actual.platillos,
        ...(mismaVentana ? { platillos: actual.platillos, modalidad: actual.modalidad } : { platillos: 0, modalidad: null }) };
      excedio = exigirPermisoDeExceder(excesosDeCupo(c, await usoPorVentana(c.id, cliente), nuevo, propio), b.exceder);
    }
    // Bajar platillos por debajo de lo ya pagado: se puede (se devuelve o se
    // abona), pero que sea a propósito. La cuenta la hace el servidor, con el
    // precio congelado del pedido; el pedido está bloqueado: no entra un pago a la vez.
    const precio = precioDe(p, c);
    if (cambios.platillos && nuevo.platillos < actual.platillos && precio !== null && b.excedente !== true) {
      const { rows: [{ pagado }] } = await cliente.query(
        `SELECT COALESCE(SUM(monto), 0) AS pagado FROM temporada_pagos WHERE pedido_id = $1 AND anulado_en IS NULL`, [idNum]);
      const pagadoC = aCentavos(pagado), totalC = precio * nuevo.platillos;
      if (totalC < pagadoC) {
        throw new TemporadaError(
          `${folioDe(c.prefijo, p.numero)} ya pagó ${pesosTexto(pagadoC)}. Con ${nuevo.platillos} platillo${nuevo.platillos === 1 ? '' : 's'} ` +
          `el total baja a ${pesosTexto(totalC)}: quedarían ${pesosTexto(pagadoC - totalC)} pagados de más (se devuelven o se abonan).`,
          'QUEDA_PAGADO_DE_MAS', 409, { pagado: pagadoC / 100, total: totalC / 100, excedente: (pagadoC - totalC) / 100 });
      }
    }
    await cliente.query(
      `UPDATE temporada_pedidos SET nombre = $2, telefono = $3, platillos = $4, modalidad = $5, direccion = $6,
              referencias = $7, notas = $8, ventana_inicio = $9::time, ventana_fin = $10::time, actualizado_en = now()
        WHERE id = $1`,
      [idNum, nuevo.nombre, nuevo.telefono, nuevo.platillos, nuevo.modalidad, nuevo.direccion, nuevo.referencias,
        nuevo.notas, v.inicio, v.fin]);
    await anotar(cliente, { negocioId, campanaId: c.id, pedidoId: idNum, usuarioId: actorId, accion: 'editado',
      detalle: { numero: p.numero, cambios, excedio } });
    await cliente.query('COMMIT');
    return { ok: true, cambios, excedio };
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

export const TIPOS_MENSAJE = Object.freeze(['confirmacion', 'recordatorio']);

/**
 * Anota que alguien abrió WhatsApp con la confirmación o el recordatorio de un
 * pedido (bitácora whatsapp_confirmacion / whatsapp_recordatorio): así el día
 * anterior se ve a quién falta recordarle. No sabe si de verdad se envió.
 */
export async function anotarWhatsAppTemporada(negocioId, pedidoId, cuerpo, { actorId = null, db = pool } = {}) {
  const idNum = idValido(pedidoId);
  if (!idNum) throw new TemporadaError('Pedido no encontrado', 'NO_ENCONTRADO', 404);
  const tipo = cuerpo && typeof cuerpo === 'object' ? cuerpo.tipo : undefined;
  if (!TIPOS_MENSAJE.includes(tipo)) throw new TemporadaError('Revisa qué mensaje se abrió.', 'TIPO_INVALIDO');
  if (!actorId) throw new TemporadaError('Inicia sesión de nuevo.', 'SIN_USUARIO', 403);
  const { rows: [p] } = await db.query(
    `SELECT id, campana_id, numero, estado FROM temporada_pedidos WHERE id = $1 AND negocio_id = $2`, [idNum, negocioId]);
  if (!p) throw new TemporadaError('Pedido no encontrado', 'NO_ENCONTRADO', 404);
  if (p.estado !== 'confirmado') {
    throw new TemporadaError('Ese pedido está cancelado: no se le escribe.', 'PEDIDO_CANCELADO', 409);
  }
  await anotar(db, { negocioId, campanaId: p.campana_id, pedidoId: p.id, usuarioId: actorId,
    accion: `whatsapp_${tipo}`, detalle: { numero: p.numero } });
  return { ok: true, tipo };
}

/** Todo lo que le ha pasado a un pedido, del más viejo al más nuevo, con quién. */
export async function historialPedidoTemporada(negocioId, pedidoId, { db = pool } = {}) {
  const idNum = idValido(pedidoId);
  if (!idNum) throw new TemporadaError('Pedido no encontrado', 'NO_ENCONTRADO', 404);
  const { rows: [p] } = await db.query(
    `SELECT p.id, p.numero, p.origen, p.creado_en, u.nombre AS creado_por, c.prefijo
       FROM temporada_pedidos p JOIN temporada_campanas c ON c.id = p.campana_id
       LEFT JOIN usuarios u ON u.id = p.creado_por
      WHERE p.id = $1 AND p.negocio_id = $2`, [idNum, negocioId]);
  if (!p) throw new TemporadaError('Pedido no encontrado', 'NO_ENCONTRADO', 404);
  const { rows } = await db.query(
    `SELECT b.accion, b.detalle, b.creado_en, u.nombre
       FROM temporada_bitacora b LEFT JOIN usuarios u ON u.id = b.usuario_id
      WHERE b.pedido_id = $1 AND b.negocio_id = $2 ORDER BY b.id`, [idNum, negocioId]);
  return {
    folio: folioDe(p.prefijo, p.numero), origen: p.origen, creado_en: p.creado_en, creado_por: p.creado_por || null,
    eventos: rows.map((r) => ({ accion: r.accion, detalle: r.detalle, en: r.creado_en, por: r.nombre || null })),
  };
}

/** Cancela un pedido del negocio: libera su cupo y conserva su folio. */
export async function cancelarPedidoTemporada(negocioId, pedidoId, { actorId = null, db = pool } = {}) {
  const idNum = /^\d{1,18}$/.test(String(pedidoId)) ? String(pedidoId) : null;
  if (!idNum) throw new TemporadaError('Pedido no encontrado', 'NO_ENCONTRADO', 404);
  const { rows: [p] } = await db.query(
    `UPDATE temporada_pedidos SET estado = 'cancelado', cancelado_en = now(), cancelado_por = $3
      WHERE id = $1 AND negocio_id = $2 AND estado = 'confirmado' RETURNING id, campana_id, numero, platillos`,
    [idNum, negocioId, actorId ? String(actorId) : null]);
  if (p) {
    // La bitácora va aparte: si fallara, el pedido ya quedó cancelado (lo que
    // pidió el administrador) y solo se pierde la anotación.
    await anotar(db, { negocioId, campanaId: p.campana_id, pedidoId: String(p.id), usuarioId: actorId, accion: 'cancelado',
      detalle: { numero: p.numero, platillos: p.platillos } })
      .catch((e) => console.warn(`[Temporada] bitácora de cancelación no guardada (${p.id}): ${e.message}`));
    return { ok: true };
  }
  const { rows: [existe] } = await db.query(
    `SELECT estado FROM temporada_pedidos WHERE id = $1 AND negocio_id = $2`, [idNum, negocioId]);
  if (!existe) throw new TemporadaError('Pedido no encontrado', 'NO_ENCONTRADO', 404);
  throw new TemporadaError('Ese pedido ya estaba cancelado.', 'YA_CANCELADO', 409);
}
