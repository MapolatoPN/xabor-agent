/**
 * dolares.js — Cobro en dólares en el mostrador (Fase 1).
 *
 * Diseño aprobado por Mario el 2-nov-2026:
 *   - El administrador lo enciende por negocio y fija el tipo de cambio en
 *     Configuración › Pagos. Apagado, o sin renglones en la bitácora, nadie
 *     cobra en dólares.
 *   - Se cobra desde «Cobrar» del mostrador, en dólares ENTEROS (billetes) y
 *     con el cambio SIEMPRE en pesos.
 *   - El tipo de cambio lo pone el servidor, no la pantalla, y queda congelado
 *     en el pedido (`datos.pago_dolares`). Si la pantalla mostraba otro, el
 *     cobro se rechaza: el cajero ya le habría dicho al cliente un cambio
 *     equivocado.
 *   - La Caja lleva dos monedas: los pesos esperados bajan por el cambio que
 *     se dio, y los dólares se esperan y se cuentan aparte, en dólares. El
 *     cajón nunca se convierte, así que cuadra aunque el tipo de cambio
 *     cambie a media jornada.
 *
 * Fase 2 (2-nov-2026): el cliente puede completar con pesos en efectivo
 * («USD 5 y $100»). Los pesos entran al cajón de pesos, el cambio sale de ahí
 * mismo y el detalle guarda las dos partes (`pago_dolares.pesos_mxn`).
 *
 * La clave 'dolares' NO contiene «efectivo» a propósito: varias partes del
 * sistema reconocen el efectivo en pesos por ese texto y contarían los
 * dólares como pesos. Por la misma razón es una forma FIJA y no un renglón de
 * formas_cobro (la 125 reserva la clave).
 *
 * El bot y la tienda en línea no leen este módulo.
 */
import { pool } from './database.js';

export const FORMA_DOLARES = 'dolares';
export const TIPO_CAMBIO_MIN = 10;
export const TIPO_CAMBIO_MAX = 30;
// Un cambio de más de 10 % contra el anterior se confirma: de un día para
// otro es más probable un dedazo que una devaluación.
export const SALTO_A_CONFIRMAR = 0.10;
// Tope de un solo cobro: un cero de más (300 → 3000) no pasa como pago.
export const USD_MAX_POR_COBRO = 1000;
// Lo mismo para la parte en pesos de un pago combinado.
export const PESOS_MAX_POR_COBRO = 20000;

const dinero = (n) => Math.round((Number(n) || 0) * 100) / 100;

function errorDolares(code, mensaje, extra = {}) {
  const e = new Error(mensaje);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

function exigirNegocio(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    throw errorDolares('TENANT_CONTEXT_REQUIRED', 'negocioId requerido');
  }
  return negocioId.trim();
}

export function esFormaDolares(forma) {
  return String(forma ?? '').trim().toLowerCase() === FORMA_DOLARES;
}

/**
 * Lee un tipo de cambio escrito a mano: «17.50», «17,50», «$17.5» o el número
 * 17.5. Lo ambiguo («1,750.00», «17.505») se rechaza en vez de adivinarse: es
 * la lección del fondo del 1-oct en Obispado, donde «900,00» se guardó como
 * $90,000 por quitar la coma a ciegas. NaN si no se puede leer.
 */
export function leerTipoCambio(valor) {
  if (typeof valor === 'number') {
    return Number.isFinite(valor) && Math.abs(valor * 100 - Math.round(valor * 100)) < 1e-6 ? dinero(valor) : NaN;
  }
  const t = String(valor ?? '').trim().replace(/^\$\s*/, '');
  if (!/^\d{1,3}([.,]\d{1,2})?$/.test(t)) return NaN;
  return dinero(Number(t.replace(',', '.')));
}

/** El tipo de cambio ya validado, o un error que dice qué escribir. */
export function validarTipoCambio(valor) {
  const tc = leerTipoCambio(valor);
  if (!Number.isFinite(tc) || tc <= 0) {
    throw errorDolares('TIPO_CAMBIO_INVALIDO', 'Escribe el tipo de cambio como 17.50: pesos por dólar, hasta dos decimales');
  }
  if (tc < TIPO_CAMBIO_MIN || tc > TIPO_CAMBIO_MAX) {
    throw errorDolares('TIPO_CAMBIO_FUERA_DE_RANGO',
      `El tipo de cambio debe estar entre $${TIPO_CAMBIO_MIN} y $${TIPO_CAMBIO_MAX} por dólar (escribiste $${tc.toFixed(2)})`);
  }
  return tc;
}

/** Dólares recibidos: billetes enteros, de 1 al tope por cobro. */
export function leerDolaresRecibidos(valor) {
  const texto = typeof valor === 'number' ? null : String(valor ?? '').trim();
  const n = texto === null ? valor : (texto === '' ? NaN : Number(texto));
  if (!Number.isInteger(n) || n < 1) {
    throw errorDolares('DOLARES_INVALIDOS', 'Escribe los dólares recibidos en billetes enteros, sin centavos');
  }
  if (n > USD_MAX_POR_COBRO) {
    throw errorDolares('DOLARES_INVALIDOS', `Más de USD ${USD_MAX_POR_COBRO} en un solo cobro: revisa la cantidad`);
  }
  return n;
}

/**
 * Los pesos en efectivo que completan un pago en dólares. Vacío es 0. Se
 * aceptan centavos con punto o coma («100.50», «100,50»), sin separador de
 * miles: un «1,000» se rechaza en vez de adivinarse.
 */
export function leerPesosRecibidos(valor) {
  if (valor === null || valor === undefined || (typeof valor === 'string' && valor.trim() === '')) return 0;
  const n = typeof valor === 'number' ? valor
    : (/^\d{1,6}([.,]\d{1,2})?$/.test(String(valor).trim()) ? Number(String(valor).trim().replace(',', '.')) : NaN);
  if (!Number.isFinite(n) || n < 0 || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) {
    throw errorDolares('PESOS_INVALIDOS', 'Escribe los pesos recibidos como 100 o 100.50');
  }
  if (n > PESOS_MAX_POR_COBRO) {
    throw errorDolares('PESOS_INVALIDOS', `Más de $${PESOS_MAX_POR_COBRO} en pesos en un solo cobro: revisa la cantidad`);
  }
  return dinero(n);
}

/** Los dólares enteros que cubren `total` pesos al tipo de cambio dado. */
export function dolaresParaCubrir(total, tipoCambio) {
  const t = dinero(total), tc = Number(tipoCambio);
  if (!(t > 0) || !(tc > 0)) return 0;
  let n = Math.max(0, Math.floor(t / tc));
  while (dinero(n * tc) < t - 0.009) n++;
  return n;
}

/**
 * El cobro en dólares de un total en pesos: lo que se guarda en el pedido y
 * el cambio, en pesos. Función pura: la usan la ruta de cobro y ✏️ Pago, y la
 * pantalla hace la misma cuenta.
 *
 * `pesos` es la parte en efectivo de un pago combinado (0 si todo fue en
 * dólares). Si esos pesos ya cubren el total solos, los dólares sobran: es
 * más probable que se escribió en el campo equivocado, y se rechaza.
 */
export function calcularCobroDolares({ total, usd, tipoCambio, pesos = 0 }) {
  const t = dinero(total);
  const tc = dinero(tipoCambio);
  const p = dinero(pesos);
  const equivalente = dinero(usd * tc);
  const cubierto = dinero(equivalente + p);
  if (p > 0 && p >= t - 0.009) {
    throw errorDolares('PESOS_CUBREN_SOLOS',
      `Con $${p.toFixed(2)} en pesos ya se cubre el total de $${t.toFixed(2)}: cóbralo en Efectivo`);
  }
  if (cubierto < t - 0.009) {
    const necesarios = dolaresParaCubrir(dinero(t - p), tc);
    const suma = p > 0 ? ` y con $${p.toFixed(2)} en pesos, $${cubierto.toFixed(2)}` : '';
    throw errorDolares('DOLARES_NO_CUBREN',
      `USD ${usd} a $${tc.toFixed(2)} son $${equivalente.toFixed(2)}${suma}: faltan $${dinero(t - cubierto).toFixed(2)} (se necesitan USD ${necesarios}${p > 0 ? ' con esos pesos' : ''})`,
      { faltan: dinero(t - cubierto), necesarios });
  }
  return {
    pago_dolares: { usd, tipo_cambio: tc, equivalente_mxn: equivalente, ...(p > 0 ? { pesos_mxn: p } : {}) },
    cambio: dinero(cubierto - t),
  };
}

/**
 * Un pago de MESA en dólares (migración 126, 3-nov-2026). El abono y la
 * propina van en pesos —la propina se captura en pesos y se le paga al
 * mesero en pesos— y los cubre lo que dio el cliente: dólares al tipo de
 * cambio más, si completó, pesos. El cambio, en pesos. `config` es lo
 * vigente (configDolares): apagados, o con otro tipo de cambio en la
 * pantalla, se rechaza igual que en el mostrador.
 */
export function pagoDeMesaEnDolares({ monto, propina = 0, usd, pesos, tipoCambioVisto }, config) {
  if (!dolaresCobrables(config)) throw errorDolares('DOLARES_APAGADOS', motivoSinDolares(config));
  if (leerTipoCambio(tipoCambioVisto) !== config.tipo_cambio) {
    throw errorDolares('TIPO_CAMBIO_CAMBIO',
      `El tipo de cambio ahora es $${config.tipo_cambio.toFixed(2)}: revisa el cambio antes de cobrar`,
      { detalle: { tipo_cambio: config.tipo_cambio } });
  }
  const dolares = leerDolaresRecibidos(usd);
  const enPesos = leerPesosRecibidos(pesos);
  const { pago_dolares, cambio } = calcularCobroDolares({
    total: dinero(Number(monto) + Number(propina || 0)), usd: dolares, tipoCambio: config.tipo_cambio, pesos: enPesos,
  });
  return {
    usd: dolares, tipo_cambio: pago_dolares.tipo_cambio, pesos_mxn: enPesos > 0 ? enPesos : null,
    equivalente_mxn: pago_dolares.equivalente_mxn, cambio,
  };
}

/**
 * Una línea para quien entrega o cobra (lista de envíos, repartidor): con
 * cuánto paga el cliente y cuánto cambio en pesos hay que llevarle. null si
 * el pedido no es en dólares o no trae el detalle.
 */
export function textoCobroEnDolares(datos) {
  const p = pagoDolaresDe(datos);
  if (!p) return null;
  return `Dólares: paga con USD ${p.usd}${p.pesos_mxn > 0 ? ` + $${p.pesos_mxn.toFixed(2)}` : ''}`
    + ` (a $${p.tipo_cambio.toFixed(2)}) · cambio $${p.cambio.toFixed(2)}`;
}

/** Cómo se lee un pago de mesa en dólares en el papel y en la pantalla. */
export function etiquetaPagoMesaEnDolares({ usd, pesos_mxn, tipo_cambio }) {
  const pesos = Number(pesos_mxn) || 0;
  return `Dólares USD ${Number(usd)}${pesos > 0 ? ` + $${pesos.toFixed(2)}` : ''} a $${Number(tipo_cambio).toFixed(2)}`;
}

/**
 * El pago en dólares que guarda un pedido, o null si no es de dólares o no
 * trae el detalle. La Caja lo usa para sumar dólares y el cambio en pesos.
 */
export function pagoDolaresDe(datos) {
  const d = datos && typeof datos === 'object' ? datos : {};
  if (!esFormaDolares(d.forma_pago)) return null;
  const p = d.pago_dolares;
  if (!p || typeof p !== 'object') return null;
  const usd = Number(p.usd), tc = Number(p.tipo_cambio), eq = Number(p.equivalente_mxn);
  if (!Number.isInteger(usd) || usd < 1 || !(tc > 0) || !Number.isFinite(eq) || eq <= 0) return null;
  return {
    usd, tipo_cambio: dinero(tc), equivalente_mxn: dinero(eq),
    // Fase 2: la parte en pesos de un pago combinado (0 en uno solo en dólares).
    pesos_mxn: dinero(Math.max(0, Number(p.pesos_mxn) || 0)),
    cambio: dinero(Math.max(0, Number(d.cambio) || 0)),
  };
}

/**
 * Lo que una VENTA dejó en dólares, venga del mostrador (`pago_dolares`) o de
 * una mesa (renglones `pagos[]` con metodo 'dolares', migración 126). null si
 * no hubo dólares o si falta el detalle. `propina` es la que se le pagó al
 * mesero en pesos de esos cobros: también sale del cajón de pesos. Con varios
 * pagos a distintos tipos de cambio, el de la venta es el promedio efectivo.
 */
export function dolaresDeVenta(datos) {
  const d = datos && typeof datos === 'object' ? datos : {};
  const forma = String(d.forma_pago ?? '').trim().toLowerCase();
  if (Array.isArray(d.pagos) && d.pagos.length && (forma === FORMA_DOLARES || forma === 'mixto')) {
    const lineas = d.pagos.filter(p => esFormaDolares(p?.metodo));
    if (!lineas.length) return null;
    let usd = 0, equivalente = 0, pesos = 0, cambio = 0, propina = 0;
    for (const p of lineas) {
      const u = Number(p.usd), tc = Number(p.tipo_cambio);
      if (!Number.isInteger(u) || u < 1 || !(tc > 0)) return null;
      usd += u;
      equivalente += Number(p.equivalente_mxn) > 0 ? Number(p.equivalente_mxn) : dinero(u * tc);
      pesos += Number(p.pesos_mxn) || 0;
      cambio += Number(p.cambio) || 0;
      propina += Number(p.propina) || 0;
    }
    return {
      usd, tipo_cambio: dinero(equivalente / usd), equivalente_mxn: dinero(equivalente),
      pesos_mxn: dinero(pesos), cambio: dinero(cambio), propina: dinero(propina),
    };
  }
  const delMostrador = pagoDolaresDe(d);
  return delMostrador ? { ...delMostrador, propina: 0 } : null;
}

// ─── Configuración por negocio (bitácora de la 125) ─────────────────────────

const SIN_DOLARES = Object.freeze({ activo: false, tipo_cambio: null, actualizado_at: null, actualizado_por: null });
// Decisión de Mario (4-nov-2026): todos los negocios, los de hoy y los que se
// den de alta, aceptan dólares en Para llevar, Recoger, Domicilio y Mesas.
// Un negocio sin renglones nace ENCENDIDO, pero sin tipo de cambio no se
// puede cobrar en dólares: la opción no aparece hasta que el administrador
// lo escribe. Apagarlos sigue siendo posible y queda en la bitácora.
const DOLARES_POR_OMISION = Object.freeze({ activo: true, tipo_cambio: null, actualizado_at: null, actualizado_por: null });

/** ¿Se puede cobrar en dólares con esta configuración? (encendidos y con tipo de cambio) */
export const dolaresCobrables = (cfg) => cfg?.activo === true && Number(cfg?.tipo_cambio) > 0;

/** El motivo, para el cajero, de que no se pueda cobrar en dólares. */
export const motivoSinDolares = (cfg) => (cfg?.activo === true
  ? 'Falta el tipo de cambio de los dólares (Configuración › Pagos)'
  : 'Este negocio no acepta dólares (Configuración › Pagos)');

/**
 * Lo vigente: el último renglón del negocio. Sin renglones, encendidos y sin
 * tipo de cambio (DOLARES_POR_OMISION). Si la tabla no se puede leer, quedan
 * APAGADOS (falla cerrado: nadie cobra con un tipo de cambio que no se pudo
 * leer).
 */
export async function configDolares(negocioId, { ejecutor = pool } = {}) {
  const nid = exigirNegocio(negocioId);
  try {
    const { rows: [r] } = await ejecutor.query(
      `SELECT d.activo, d.tipo_cambio, d.created_at, u.nombre AS usuario
         FROM dolares_tipo_cambio d
         LEFT JOIN usuarios u ON u.id = d.usuario_id
        WHERE d.negocio_id = $1
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT 1`, [nid]);
    if (!r) return { ...DOLARES_POR_OMISION };
    return {
      activo: r.activo === true,
      tipo_cambio: r.tipo_cambio === null ? null : dinero(r.tipo_cambio),
      actualizado_at: r.created_at,
      actualizado_por: r.usuario || null,
    };
  } catch (e) {
    console.error('[Dolares] No se pudo leer la configuración; quedan apagados:', e.message);
    return { ...SIN_DOLARES, error: true };
  }
}

/** Los últimos cambios, del más nuevo al más viejo, con quién los hizo. */
export async function historialDolares(negocioId, { limite = 10 } = {}) {
  const nid = exigirNegocio(negocioId);
  const n = Math.min(50, Math.max(1, parseInt(limite, 10) || 10));
  try {
    const { rows } = await pool.query(
      `SELECT d.activo, d.tipo_cambio, d.created_at, u.nombre AS usuario
         FROM dolares_tipo_cambio d
         LEFT JOIN usuarios u ON u.id = d.usuario_id
        WHERE d.negocio_id = $1
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT $2`, [nid, n]);
    return rows.map(r => ({
      activo: r.activo === true,
      tipo_cambio: r.tipo_cambio === null ? null : dinero(r.tipo_cambio),
      creado_at: r.created_at,
      usuario: r.usuario || null,
    }));
  } catch (e) {
    console.error('[Dolares] No se pudo leer el historial:', e.message);
    return [];
  }
}

/**
 * Enciende/apaga los dólares y/o cambia el tipo de cambio. Cada cambio es un
 * renglón nuevo; guardar lo mismo que ya está no escribe nada. Sin tipo de
 * cambio escrito se conserva el vigente (solo se enciende o apaga).
 *
 * Un salto de más de SALTO_A_CONFIRMAR contra el vigente se rechaza con
 * TIPO_CAMBIO_SALTO hasta que llega `confirmarSalto`.
 */
export async function guardarDolares(negocioId, { activo, tipoCambio = null, confirmarSalto = false, usuarioId = null } = {}) {
  const nid = exigirNegocio(negocioId);
  if (typeof activo !== 'boolean') throw errorDolares('ACTIVO_INVALIDO', 'Indica si el negocio acepta dólares (activo: true o false)');
  const escrito = tipoCambio === null || tipoCambio === undefined || String(tipoCambio).trim() === ''
    ? null : validarTipoCambio(tipoCambio);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Dos administradores guardando a la vez: el segundo compara contra lo
    // que dejó el primero, no contra lo que leyó antes.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('dolares_tipo_cambio'), hashtext($1))`, [nid]);
    const { rows: [r] } = await client.query(
      `SELECT activo, tipo_cambio FROM dolares_tipo_cambio
        WHERE negocio_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [nid]);
    // Sin renglones, lo vigente es DOLARES_POR_OMISION (encendidos, sin tipo de cambio).
    const anterior = r
      ? { activo: r.activo === true, tipo_cambio: r.tipo_cambio !== null ? dinero(r.tipo_cambio) : null }
      : { activo: DOLARES_POR_OMISION.activo, tipo_cambio: null };
    const tc = escrito ?? anterior.tipo_cambio;
    if (activo && tc === null) {
      throw errorDolares('TIPO_CAMBIO_REQUERIDO', 'Escribe el tipo de cambio antes de aceptar dólares');
    }
    if (escrito !== null && anterior.tipo_cambio !== null && confirmarSalto !== true) {
      const salto = Math.abs(escrito / anterior.tipo_cambio - 1);
      if (salto > SALTO_A_CONFIRMAR + 1e-9) {
        throw errorDolares('TIPO_CAMBIO_SALTO',
          `El tipo de cambio pasaría de $${anterior.tipo_cambio.toFixed(2)} a $${escrito.toFixed(2)} (${Math.round(salto * 100)} % de diferencia). Confírmalo si es correcto.`,
          { anterior: anterior.tipo_cambio, nuevo: escrito });
      }
    }
    if (anterior.activo === activo && anterior.tipo_cambio === tc) {
      await client.query('ROLLBACK');
      return { ...(await configDolares(nid)), sin_cambios: true, anterior };
    }
    await client.query(
      `INSERT INTO dolares_tipo_cambio (negocio_id, activo, tipo_cambio, usuario_id) VALUES ($1, $2, $3, $4)`,
      [nid, activo, tc, usuarioId || null]);
    await client.query('COMMIT');
    console.log(`[Dolares] negocio=${nid} activo=${anterior.activo}→${activo} tc=${anterior.tipo_cambio}→${tc} usuario=${usuarioId || 'legado'}`);
    return { ...(await configDolares(nid)), sin_cambios: false, anterior };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** El tipo de cambio que estaba vigente en `instante` (o null si no había). */
export async function tipoCambioVigenteEn(negocioId, instante, { ejecutor = pool } = {}) {
  const nid = exigirNegocio(negocioId);
  const cuando = instante instanceof Date ? instante : new Date(instante);
  if (Number.isNaN(cuando.getTime())) return null;
  const { rows: [r] } = await ejecutor.query(
    `SELECT tipo_cambio, created_at FROM dolares_tipo_cambio
      WHERE negocio_id = $1 AND created_at <= $2 AND tipo_cambio IS NOT NULL
      ORDER BY created_at DESC, id DESC LIMIT 1`, [nid, cuando.toISOString()]);
  return r ? { tipo_cambio: dinero(r.tipo_cambio), desde: r.created_at } : null;
}

// ─── ✏️ Pago: corregir desde o hacia dólares un pedido YA cobrado ───────────

const esVentaDeMesa = (datos, folio) =>
  String(datos?.canal || '').trim().toLowerCase() === 'restaurante_mesa' || /^RM-/i.test(String(folio || ''));

/**
 * Se cobró como otra cosa y el cliente pagó en dólares. Se usa el tipo de
 * cambio vigente A LA HORA DEL COBRO, no el de ahora: con ese dio el cajero
 * el cambio. Deja el pedido igual que si se hubiera cobrado en dólares.
 */
export async function corregirPagoADolares(negocioId, folio, { usd, pesos = 0 } = {}) {
  const nid = exigirNegocio(negocioId);
  const dolares = leerDolaresRecibidos(usd);
  const enPesos = leerPesosRecibidos(pesos);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [fila] } = await client.query(
      `SELECT datos, estado, created_at FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2 FOR UPDATE`,
      [folio, nid]);
    if (!fila) throw errorDolares('NO_ENCONTRADO', 'Pedido no encontrado');
    const datos = fila.datos || {};
    if (fila.estado === 'cancelado') throw errorDolares('CANCELADO', 'El pedido está cancelado');
    // Un pedido por cobrar no se «corrige»: se cobra. Recoger y Domicilio del
    // POS no llevan pago_confirmado (su venta cuenta desde que se crean con su
    // forma de pago), así que lo que manda es la misma regla que la Caja.
    // Uno que espera su pago en línea (pendiente_pago) tampoco: lo confirma el
    // flujo de pagos, y la Caja no lo cuenta como venta.
    const formaActual = String(datos.forma_pago || '').trim().toLowerCase();
    if (fila.estado === 'pendiente_pago' || datos.pago_confirmado === false
        || formaActual === 'por_cobrar' || formaActual === 'pendiente' || !formaActual) {
      throw errorDolares('POR_COBRAR', 'Este pedido no está cobrado: usa «Cobrar» para cobrarlo en dólares');
    }
    if (esVentaDeMesa(datos, folio)) throw errorDolares('MESA', 'Las cuentas de mesa todavía no se cobran en dólares');
    const cobradoAt = datos.cobrado_at && !Number.isNaN(Date.parse(datos.cobrado_at)) ? new Date(datos.cobrado_at) : fila.created_at;
    const vigente = await tipoCambioVigenteEn(nid, cobradoAt, { ejecutor: client });
    if (!vigente) {
      throw errorDolares('SIN_TIPO_CAMBIO', 'No había tipo de cambio registrado a la hora de ese cobro: no se puede pasar a dólares');
    }
    const calculo = calcularCobroDolares({ total: datos.total, usd: dolares, tipoCambio: vigente.tipo_cambio, pesos: enPesos });
    const campos = {
      forma_pago: FORMA_DOLARES, ...calculo,
      billete: 0, mixto_efectivo: null, mixto_terminal: null,
    };
    const { rows: [act] } = await client.query(
      `UPDATE pedidos_activos SET datos = datos || $3::jsonb, updated_at = NOW()
        WHERE folio = $1 AND negocio_id = $2 RETURNING datos`, [folio, nid, JSON.stringify(campos)]);
    await client.query('COMMIT');
    pool.query(`UPDATE pedidos SET forma_pago = $2 WHERE folio = $1 AND negocio_id = $3`, [folio, FORMA_DOLARES, nid])
      .catch(e => console.error('[Dolares] espejo en pedidos falló:', e.message));
    return { datos: act.datos, tipo_cambio_desde: vigente.desde };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Se cobró en dólares y era otra forma: se quita el detalle en dólares y el
 * cambio (sin dólares no hubo cambio en pesos que descontar del cajón). Si
 * el pedido no estaba en dólares no toca nada y devuelve null.
 */
export async function salirDeDolares(negocioId, folio, formaNueva) {
  const nid = exigirNegocio(negocioId);
  const { rows: [act] } = await pool.query(
    `UPDATE pedidos_activos
        SET datos = (datos - 'pago_dolares') || jsonb_build_object('forma_pago', $3::text, 'cambio', 0),
            updated_at = NOW()
      WHERE folio = $1 AND negocio_id = $2 AND lower(datos->>'forma_pago') = $4
      RETURNING datos`, [folio, nid, String(formaNueva), FORMA_DOLARES]);
  if (!act) return null;
  pool.query(`UPDATE pedidos SET forma_pago = $2 WHERE folio = $1 AND negocio_id = $3`, [folio, String(formaNueva), nid])
    .catch(e => console.error('[Dolares] espejo en pedidos falló:', e.message));
  return act.datos;
}
