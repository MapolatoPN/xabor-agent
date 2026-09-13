// ─── Lo que este cliente pidió AQUÍ otras veces ───────────────────────────
//
// Módulo puro. Recibe los pedidos anteriores de ESE teléfono en ESE negocio y
// arma un perfil. No consulta la base: quien llama hace la consulta con el
// filtro puesto, y eso es a propósito (ver más abajo).
//
// ── LA MEMORIA NO AUTORIZA ───────────────────────────────────────────────
//
// Es la regla entera. Lo que el cliente pidió la semana pasada no es lo que
// pide hoy, y un bot que lo asume acaba mandando a cocina un pedido que nadie
// hizo. Lo que la memoria puede hacer es PROPONER:
//
//   permitido    «la vez pasada pediste X, ¿te lo repito?»
//   prohibido    agregar X
//
// La propuesta entra por donde entran todas —`propuestasDelBot`— y necesita el
// mismo «sí» inequívoco que cualquier otra. Aquí no hay un atajo.
//
// ── Y EL NOMBRE NO SALE DE `clientes` ────────────────────────────────────
//
// `clientes.telefono` es CLAVE PRIMARIA GLOBAL: hay una sola fila por número
// para todo Xabor, y `nombre` se sobreescribe con el último que se haya visto,
// en cualquier negocio. El propio código ya lo sabe —por eso el estado de pausa
// vive en `conversaciones_control`, con clave por negocio— y aquí importa por
// una razón distinta:
//
//   saludar con `clientes.nombre` es decirle a un restaurante el nombre que esa
//   persona le dio a otro.
//
// No es un fallo técnico, es una fuga entre clientes de la plataforma. Así que
// el nombre que este módulo devuelve sale de los PEDIDOS de este negocio, y de
// ningún otro sitio. Si esa persona nunca pidió aquí, no hay nombre, y el bot
// saluda sin nombre — que es lo que hace un mesero que no te conoce.
//
// Por eso tampoco se lee la base desde aquí: quien la consulte tiene que
// escribir el filtro por negocio, y así se ve en la llamada.

const norm = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Cuántos pedidos atrás se miran. Más allá, los gustos ya no dicen mucho. */
export const PEDIDOS_QUE_CUENTAN = 10;

const arreglo = (x) => (Array.isArray(x) ? x : []);

/**
 * El perfil de este cliente EN ESTE NEGOCIO.
 *
 * `pedidos` son filas con `{ negocio_id, datos, creado_en }`, tal como salen de
 * `pedidos_activos`. Cualquier fila de otro negocio se DESCARTA aquí también:
 * el filtro de la consulta es el primero, y este es el segundo. Un perfil
 * contaminado no se nota al mirarlo.
 */
export function perfilDelCliente(pedidos, { negocioId } = {}) {
  const vacio = { conoce: false, nombre: null, visitas: 0, favoritos: [],
    modalidadHabitual: null, pagoHabitual: null };
  const n = String(negocioId || '');
  if (!n) return vacio;

  const propios = arreglo(pedidos)
    .filter((p) => String(p?.negocio_id || '') === n)
    .slice(0, PEDIDOS_QUE_CUENTAN);
  if (!propios.length) return vacio;

  const cuenta = new Map();
  const modalidades = new Map();
  const pagos = new Map();
  let nombre = null;

  for (const p of propios) {
    const d = p?.datos || {};
    // El nombre sale del pedido —lo que esta persona dijo llamarse al pedir
    // AQUÍ— y se toma el más reciente que exista.
    if (!nombre && d?.cliente?.nombre) nombre = String(d.cliente.nombre).trim() || null;
    for (const it of arreglo(d.items)) {
      const k = String(it?.nombre || '').trim();
      if (!k) continue;
      cuenta.set(k, (cuenta.get(k) || 0) + (Number(it?.cantidad) || 1));
    }
    if (d.modalidad) modalidades.set(d.modalidad, (modalidades.get(d.modalidad) || 0) + 1);
    const pago = d.forma_pago ?? d.formaPago;
    if (pago) pagos.set(pago, (pagos.get(pago) || 0) + 1);
  }

  const masFrecuente = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    conoce: true,
    nombre,
    visitas: propios.length,
    favoritos: [...cuenta.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([nombreProducto, veces]) => ({ nombre: nombreProducto, veces })),
    modalidadHabitual: masFrecuente(modalidades),
    pagoHabitual: masFrecuente(pagos),
  };
}

/**
 * ¿Se le puede llamar por su nombre?
 *
 * Solo si pidió aquí y dejó un nombre al pedir. Un nombre de una sola letra o
 * que es un número no es un nombre: la gente escribe cualquier cosa en ese
 * campo, y «Hola 2» es peor que «Hola».
 */
export function nombreParaSaludar(perfil) {
  const n = String(perfil?.nombre || '').trim();
  if (!perfil?.conoce || n.length < 2) return null;
  if (/^\d+$/.test(n)) return null;
  // Solo el primer nombre: el apellido en un saludo suena a cobranza.
  return n.split(/\s+/)[0];
}

/**
 * Lo que se le podría OFRECER a partir de su historial.
 *
 * Devuelve candidatos, no acciones. Quien llame decide si los registra como
 * propuesta —y solo entonces existen para el cliente— o si este no es el
 * momento (`puedeRecomendarAhora` sigue mandando).
 *
 * Se cruzan con el catálogo de HOY: un favorito que ya no está en la carta, o
 * que está agotado, no se ofrece. Ofrecer lo que no hay es peor que no ofrecer.
 */
export function repetirLoDeSiempre(perfil, { catalogo = [], carrito = null, limite = 1 } = {}) {
  if (!perfil?.conoce) return [];
  const vendibles = new Map();
  for (const cat of catalogo || []) {
    for (const p of (cat?.productos || [])) {
      if (p?.disponible === false || p?.agotado === true) continue;
      vendibles.set(norm(p.nombre), { nombre: String(p.nombre), categoria: String(cat?.nombre || '') });
    }
  }
  const yaPedido = new Set(arreglo(carrito?.items).map((i) => norm(i?.nombre)));
  const fuera = [];
  for (const f of perfil.favoritos) {
    if (fuera.length >= limite) break;
    const k = norm(f.nombre);
    if (yaPedido.has(k)) continue;
    const enCarta = vendibles.get(k);
    if (!enCarta) continue;
    fuera.push({ nombre: enCarta.nombre, categoria: enCarta.categoria, motivo: 'lo_pidio_antes', veces: f.veces });
  }
  return fuera;
}

/**
 * Los datos operativos que se pueden PREGUNTAR más corto, no dar por hechos.
 *
 * «¿Como siempre, para recoger?» está bien. Rellenar la modalidad sin
 * preguntar no: el día que esa persona quiera entrega a domicilio, el pedido
 * sale para la puerta equivocada y nadie se entera hasta que el repartidor
 * llama.
 */
export function atajosOperativos(perfil) {
  if (!perfil?.conoce) return {};
  return {
    ...(perfil.modalidadHabitual ? { modalidadSugerida: perfil.modalidadHabitual } : {}),
    ...(perfil.pagoHabitual ? { pagoSugerido: perfil.pagoHabitual } : {}),
  };
}

/** Lo que se le pasa al modelo. Sin teléfono, sin historial crudo. */
export const perfilParaElModelo = (perfil) => (perfil?.conoce ? {
  nombre: nombreParaSaludar(perfil),
  visitas: perfil.visitas,
  suele_pedir: perfil.favoritos.slice(0, 3).map((f) => f.nombre),
  suele_recoger: perfil.modalidadHabitual,
  suele_pagar: perfil.pagoHabitual,
} : null);
