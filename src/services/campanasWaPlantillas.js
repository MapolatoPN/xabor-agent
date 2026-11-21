/**
 * campanasWaPlantillas.js — reglas puras de las campañas de WhatsApp con
 * plantilla aprobada por Meta. Sin base, sin red: todo lo que aquí se decide
 * se prueba en test/fase-campanas-wa.mjs.
 *
 * Por qué plantilla (20-nov-2026, Mario: «sí, prepáralas»): WhatsApp solo deja
 * mandar texto libre dentro de las 24 h desde el último mensaje del cliente.
 * Una campaña de texto libre le llega solo a quien escribió ayer; a los demás
 * Meta la acepta y minutos después la rechaza (131047). Con una plantilla
 * aprobada por Meta el mensaje sí puede salir a cualquier cliente, y Meta lo
 * cobra por mensaje a la cuenta del negocio.
 *
 * Lo que Xabor sabe mandar hoy: encabezado de texto (con o sin variable) o de
 * imagen (por liga pública), cuerpo con variables {{1}} o {{nombre}}, pie, y
 * botones de teléfono, liga (fija o con variable), «copiar código» y el de
 * baja. Lo demás (video, documento, carrusel, oferta con tiempo, Flows, otras
 * respuestas rápidas, una promoción sin botón de baja) se lista como «no
 * compatible» con la razón, para que no se mande a medias.
 */

// Meta cobra por mensaje según la categoría de la plantilla. Son tarifas
// APROXIMADAS para México (nov-2026), solo para que el panel avise antes de
// mandar; el cobro real lo hace Meta con su tarifa vigente.
export const TARIFA_APROX_USD = Object.freeze({ MARKETING: 0.045, UTILITY: 0.0085 });
export const CATEGORIAS = Object.freeze(['MARKETING', 'UTILITY']);

// Hora local del negocio en que la cola manda (de 9:00 a 20:59). Una
// promoción a las 3 de la mañana se bloquea o se reporta, y eso le baja la
// calidad al número.
export const HORARIO_ENVIO = Object.freeze({ desde: 9, hasta: 21 });

// A quién NO se le vuelve a mandar: quien recibió una campaña con plantilla en
// los últimos N días (si el administrador deja la casilla puesta).
export const DIAS_SIN_REPETIR = 7;

export const SEGMENTOS = Object.freeze([
  ['todos', 'Todos los clientes'], ['vip', 'VIP'], ['frecuente', 'Frecuentes'], ['en_riesgo', 'En riesgo'],
  ['dormido', 'Dormidos'], ['nuevo', 'Nuevos'], ['rewards_1', 'Rewards: con puntos'],
  ['rewards_100', 'Rewards: 100+ puntos'], ['rewards_500', 'Rewards: 500+ puntos'], ['rewards_1500', 'Rewards: 1500+ puntos'],
]);
const SEGMENTOS_VALIDOS = new Set(SEGMENTOS.map(([s]) => s));
export const segmentoValido = (s) => SEGMENTOS_VALIDOS.has(s);

// ─── Teléfono ────────────────────────────────────────────────────────────────
// Como lo espera Meta para mandar. 10 dígitos = móvil mexicano (es lo que
// supone todo el sistema: normalizarTelefonoMX, Rewards, la tienda); con 521
// (como llega de WhatsApp) se manda con 52; con otro prefijo internacional se
// deja como vino de WhatsApp. Lo demás no se manda.
export function telefonoParaMeta(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  if (/^\d{10}$/.test(d)) return `52${d}`;
  if (/^521\d{10}$/.test(d)) return `52${d.slice(3)}`;
  if (/^52\d{10}$/.test(d)) return d;
  if (/^[1-9]\d{10,14}$/.test(d) && !d.startsWith('52')) return d;
  return null;
}

// ─── Plantillas ──────────────────────────────────────────────────────────────
function variablesDe(texto, formato) {
  const re = formato === 'NAMED' ? /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g : /\{\{\s*(\d+)\s*\}\}/g;
  const vistas = [];
  for (const m of String(texto || '').matchAll(re)) if (!vistas.includes(m[1])) vistas.push(m[1]);
  if (formato !== 'NAMED') vistas.sort((a, b) => Number(a) - Number(b));
  return vistas;
}

function ejemploDe(componente, lugar, param, formato) {
  const ej = componente?.example || {};
  if (formato === 'NAMED') {
    const lista = lugar === 'encabezado' ? ej.header_text_named_params : ej.body_text_named_params;
    return (Array.isArray(lista) ? lista.find((x) => x?.param_name === param)?.example : null) || '';
  }
  const lista = lugar === 'encabezado' ? ej.header_text : ej.body_text?.[0];
  return (Array.isArray(lista) ? lista[Number(param) - 1] : null) || '';
}

const QUE_LLEVA = { VIDEO: 'un video', DOCUMENT: 'un documento', LOCATION: 'una ubicación', PRODUCT: 'un producto del catálogo' };

// El botón de baja de una promoción: el de Meta («Detener promociones» /
// «Stop promotions») o uno de respuesta rápida que diga lo mismo. Es la única
// respuesta rápida que Xabor sabe atender (anota la baja en el cliente).
const TEXTO_DE_BAJA = /\b(stop|detener|baja|desuscrib|unsubscribe|opt[\s-]?out|no\s+(me\s+)?interesa|no\s+(quiero\s+)?recibir|dejar\s+de\s+recibir|ya\s+no\s+(me\s+)?(mand|envi)|cancelar\s+(promo|suscrip))/i;
export const esBotonDeBaja = (texto) => TEXTO_DE_BAJA.test(String(texto || ''));

// Los toques de botón de una plantilla llegan al bot como un mensaje de tipo
// «button», y el bot de pedidos solo contesta los botones que él mismo mandó:
// «Quiero pedir» en una campaña se queda sin respuesta. Por eso una campaña
// lleva liga (a la tienda) o teléfono, y de respuesta rápida solo la baja.
const RAZON_RESPUESTA_RAPIDA = (t) => `el botón «${t}» es de respuesta rápida y el bot no contesta ese toque: cámbialo por un botón de liga a tu tienda`;

/**
 * Lo que el panel necesita saber de una plantilla de Meta, y si Xabor la sabe
 * mandar. `ranuras` son los huecos que el administrador llena: cada una con su
 * `clave` estable (encabezado:1, cuerpo:nombre, boton:0, encabezado:imagen).
 */
export function analizarPlantilla(p) {
  const formato = String(p?.parameter_format || '').toUpperCase() === 'NAMED' ? 'NAMED' : 'POSITIONAL';
  const categoria = String(p?.category || '').toUpperCase();
  const razones = [];
  const ranuras = [];
  let encabezado = null; let cuerpo = ''; let pie = '';
  const botones = [];
  if (p?.status !== 'APPROVED') razones.push('Meta todavía no la aprueba');
  if (!CATEGORIAS.includes(categoria)) {
    razones.push(categoria === 'AUTHENTICATION' ? 'es de códigos de acceso, no de campañas' : `es de la categoría ${categoria || 'desconocida'}`);
  }
  for (const c of Array.isArray(p?.components) ? p.components : []) {
    const tipo = String(c?.type || '').toUpperCase();
    if (tipo === 'HEADER') {
      const f = String(c.format || 'TEXT').toUpperCase();
      if (f === 'TEXT') {
        encabezado = { tipo: 'texto', texto: String(c.text || '') };
        for (const v of variablesDe(c.text, formato)) {
          ranuras.push({ clave: `encabezado:${v}`, lugar: 'encabezado', param: v, tipo: 'texto', ejemplo: ejemploDe(c, 'encabezado', v, formato) });
        }
      } else if (f === 'IMAGE') {
        encabezado = { tipo: 'imagen' };
        ranuras.push({ clave: 'encabezado:imagen', lugar: 'encabezado', param: null, tipo: 'imagen', ejemplo: '' });
      } else {
        razones.push(`el encabezado lleva ${QUE_LLEVA[f] || `algo de tipo ${f}`}, y Xabor todavía no lo manda`);
      }
    } else if (tipo === 'BODY') {
      cuerpo = String(c.text || '');
      for (const v of variablesDe(c.text, formato)) {
        ranuras.push({ clave: `cuerpo:${v}`, lugar: 'cuerpo', param: v, tipo: 'texto', ejemplo: ejemploDe(c, 'cuerpo', v, formato) });
      }
    } else if (tipo === 'FOOTER') {
      pie = String(c.text || '');
    } else if (tipo === 'BUTTONS') {
      (Array.isArray(c.buttons) ? c.buttons : []).forEach((b, i) => {
        const bt = String(b?.type || '').toUpperCase();
        const texto = String(b?.text || '');
        const baja = bt === 'QUICK_REPLY' && esBotonDeBaja(texto);
        botones.push({ tipo: bt, texto, baja });
        if (bt === 'QUICK_REPLY' && !baja) razones.push(RAZON_RESPUESTA_RAPIDA(texto));
        if (bt === 'URL' && /\{\{/.test(String(b.url || ''))) {
          ranuras.push({ clave: `boton:${i}`, lugar: 'boton', param: String(i), tipo: 'url', ejemplo: String(b.example?.[0] || ''), liga: String(b.url) });
        } else if (bt === 'COPY_CODE') {
          ranuras.push({ clave: `boton:${i}`, lugar: 'boton', param: String(i), tipo: 'cupon', ejemplo: String(b.example?.[0] || b.example || '') });
        } else if (!['QUICK_REPLY', 'PHONE_NUMBER', 'URL'].includes(bt)) {
          razones.push(`trae un botón de tipo ${bt || 'desconocido'}, que Xabor todavía no manda`);
        }
      });
    } else {
      razones.push(`trae un bloque ${tipo || 'desconocido'} (carrusel, oferta con tiempo u otro) que Xabor todavía no manda`);
    }
  }
  if (!cuerpo) razones.push('no tiene texto en el cuerpo');
  // Decisión de Mario (21-nov-2026): la promoción va a todos menos a quien se
  // dio de baja, así que cada una tiene que traer cómo darse de baja.
  if (categoria === 'MARKETING' && !botones.some((b) => b.baja)) {
    razones.push('no tiene botón para darse de baja («Detener promociones»): sin él el cliente no puede pedir que ya no le manden');
  }
  return {
    id: p?.id ? String(p.id) : null, nombre: String(p?.name || ''), idioma: String(p?.language || ''),
    categoria, formato, encabezado, cuerpo, pie, botones, ranuras, compatible: razones.length === 0, razones,
  };
}

// ─── Variables ───────────────────────────────────────────────────────────────
// Meta rechaza variables con saltos de línea, tabuladores o más de 4 espacios
// seguidos: se aplanan aquí para que no tumben la campaña entera.
export const limpiarVariable = (s) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

export function primerNombre(nombre) {
  const p = limpiarVariable(nombre).split(' ')[0] || '';
  if (!/\p{L}/u.test(p) || p.length > 30) return '';
  return p.charAt(0).toLocaleUpperCase('es-MX') + p.slice(1);
}

// Lo que la caja escribe cuando no sabe el nombre: «RAPPI 3259», «LLEVAR»,
// «Cliente», «Mesa 4», «SRA VALDES». Saludar «Hola Rappi» se lee mal: esos
// van con el texto de respaldo.
const NO_SON_NOMBRE = new Set(['rappi', 'didi', 'uber', 'llevar', 'para', 'a', 'cliente', 'clienta', 'mostrador', 'publico', 'público',
  'general', 'mesa', 'varios', 'prueba', 'test', 'na', 'nn', 'sn', 'sin', 'nombre', 'ninguno', 'x', 'xx', 'xxx', 'sr', 'sra',
  'srta', 'señor', 'señora', 'don', 'doña', 'lic', 'ing', 'dr', 'dra', 'empresa', 'oficina', 'pedido', 'domicilio', 'recoger']);

/** El primer nombre que sí se puede poner en un saludo, o '' si no hay. */
export function nombreUsable(nombre) {
  const limpio = limpiarVariable(nombre);
  if (!limpio || /\d/.test(limpio)) return '';
  const p = primerNombre(limpio);
  const clave = p.toLocaleLowerCase('es-MX').replace(/[.]+$/, '');
  if (p.length < 2 || NO_SON_NOMBRE.has(clave)) return '';
  // «ROSSY» → «Rossy»; «María» se queda como está.
  return p === p.toLocaleUpperCase('es-MX') ? p.charAt(0) + p.slice(1).toLocaleLowerCase('es-MX') : p;
}

export class ErrorCampana extends Error {
  constructor(mensaje, codigo, extra = {}) { super(mensaje); this.codigo = codigo; Object.assign(this, extra); }
}

const LIMITE = { texto: 200, url: 200, cupon: 15, imagen: 1000 };

/**
 * Valida lo que el administrador llenó contra las ranuras de la plantilla.
 * `variables`: { [clave]: { fuente: 'nombre' | 'fijo', texto } }. Devuelve la
 * versión limpia (solo las claves de la plantilla) o lanza ErrorCampana.
 */
export function validarVariables(analisis, variables, respaldoNombre) {
  const limpias = {};
  let usaNombre = false;
  for (const r of analisis.ranuras) {
    const v = variables?.[r.clave];
    const etiqueta = etiquetaRanura(r);
    if (!v || !['nombre', 'fijo'].includes(v.fuente)) throw new ErrorCampana(`Falta llenar «${etiqueta}».`, 'VARIABLE_FALTA', { clave: r.clave });
    if (v.fuente === 'nombre') {
      if (r.tipo !== 'texto') throw new ErrorCampana(`«${etiqueta}» no puede ser el nombre del cliente.`, 'VARIABLE_INVALIDA', { clave: r.clave });
      usaNombre = true;
      limpias[r.clave] = { fuente: 'nombre' };
      continue;
    }
    const texto = limpiarVariable(v.texto);
    if (!texto) throw new ErrorCampana(`Falta llenar «${etiqueta}».`, 'VARIABLE_FALTA', { clave: r.clave });
    if (texto.length > LIMITE[r.tipo]) {
      throw new ErrorCampana(`«${etiqueta}» es muy largo (máximo ${LIMITE[r.tipo]} caracteres).`, 'VARIABLE_INVALIDA', { clave: r.clave });
    }
    if (r.tipo === 'imagen' && !/^https:\/\/[^\s]+$/i.test(texto)) {
      throw new ErrorCampana('La imagen tiene que ser una liga pública que empiece con https://', 'VARIABLE_INVALIDA', { clave: r.clave });
    }
    if (r.tipo === 'cupon' && !/^[A-Za-z0-9]+$/.test(texto)) {
      throw new ErrorCampana('El código solo lleva letras y números, sin espacios.', 'VARIABLE_INVALIDA', { clave: r.clave });
    }
    limpias[r.clave] = { fuente: 'fijo', texto };
  }
  const respaldo = limpiarVariable(respaldoNombre);
  if (usaNombre && !respaldo) {
    throw new ErrorCampana('Escribe qué poner cuando no sabemos el nombre del cliente (por ejemplo «cliente»).', 'RESPALDO_FALTA');
  }
  if (respaldo.length > 30) throw new ErrorCampana('El texto para cuando no sabemos el nombre es muy largo (máximo 30).', 'RESPALDO_FALTA');
  if (usaNombre && (!/\p{L}/u.test(respaldo) || /[{}<>]/.test(respaldo))) {
    throw new ErrorCampana('El texto para cuando no sabemos el nombre tiene que ser una palabra (por ejemplo «cliente»), sin llaves ni símbolos.', 'RESPALDO_FALTA');
  }
  return { variables: limpias, respaldoNombre: usaNombre ? respaldo : '' };
}

export function etiquetaRanura(r) {
  if (r.tipo === 'imagen') return 'Imagen del encabezado';
  if (r.lugar === 'boton') return r.tipo === 'cupon' ? 'Código del botón «copiar código»' : 'Final de la liga del botón';
  const donde = r.lugar === 'encabezado' ? 'Encabezado' : 'Mensaje';
  return `${donde}: {{${r.param}}}`;
}

function valorRanura(r, variables, nombreCliente, respaldoNombre) {
  const v = variables[r.clave];
  if (v.fuente === 'nombre') return nombreUsable(nombreCliente) || respaldoNombre;
  return v.texto;
}

/** ¿La campaña pone el nombre del cliente en algún lado? */
export const usaNombreDelCliente = (variables) => Object.values(variables || {}).some((v) => v?.fuente === 'nombre');

// ─── Tandas ──────────────────────────────────────────────────────────────────
// Cuántos envíos salen como máximo en 24 h y con qué porcentaje de rechazos la
// campaña se pausa sola. El umbral se mide desde que hay suficientes intentos
// para que un par de números malos no la paren.
export const TANDAS = Object.freeze({ tope24h: 250, topeMinimo: 10, topeMaximo: 100000, umbralPct: 10, umbralMinimo: 2,
  umbralMaximo: 50, intentosParaMedir: 20 });

export function validarTandas(tope24h, umbralRechazoPct) {
  const tope = tope24h === undefined || tope24h === null || tope24h === '' ? TANDAS.tope24h : Number(tope24h);
  if (!Number.isInteger(tope) || tope < TANDAS.topeMinimo || tope > TANDAS.topeMaximo) {
    throw new ErrorCampana(`El tope por tanda va de ${TANDAS.topeMinimo} a ${TANDAS.topeMaximo.toLocaleString('es-MX')} mensajes en 24 horas.`, 'TANDA_INVALIDA');
  }
  const umbral = umbralRechazoPct === undefined || umbralRechazoPct === null || umbralRechazoPct === '' ? TANDAS.umbralPct : Number(umbralRechazoPct);
  if (!Number.isInteger(umbral) || umbral < TANDAS.umbralMinimo || umbral > TANDAS.umbralMaximo) {
    throw new ErrorCampana(`La pausa por rechazos va de ${TANDAS.umbralMinimo}% a ${TANDAS.umbralMaximo}%.`, 'TANDA_INVALIDA');
  }
  return { tope24h: tope, umbralRechazoPct: umbral };
}

/** ¿Se pausa? Solo con suficientes intentos y si los rechazos pasan el umbral. */
export function rebasaUmbral({ intentos, rechazos }, umbralPct) {
  if (!Number.isInteger(umbralPct) || intentos < TANDAS.intentosParaMedir) return false;
  return rechazos * 100 > umbralPct * intentos;
}

/** Los `components` que pide la Graph API para mandar esta plantilla a un cliente. */
export function construirComponentes(analisis, variables, nombreCliente, respaldoNombre) {
  const comps = [];
  const parametro = (r) => {
    const texto = valorRanura(r, variables, nombreCliente, respaldoNombre);
    return analisis.formato === 'NAMED' ? { type: 'text', parameter_name: r.param, text: texto } : { type: 'text', text: texto };
  };
  const enc = analisis.ranuras.filter((r) => r.lugar === 'encabezado');
  if (enc.length) {
    comps.push({ type: 'header', parameters: enc.map((r) => (r.tipo === 'imagen'
      ? { type: 'image', image: { link: variables[r.clave].texto } } : parametro(r))) });
  }
  const cuerpo = analisis.ranuras.filter((r) => r.lugar === 'cuerpo');
  if (cuerpo.length) comps.push({ type: 'body', parameters: cuerpo.map(parametro) });
  for (const r of analisis.ranuras.filter((x) => x.lugar === 'boton')) {
    const texto = variables[r.clave].texto;
    comps.push(r.tipo === 'cupon'
      ? { type: 'button', sub_type: 'copy_code', index: r.param, parameters: [{ type: 'coupon_code', coupon_code: texto }] }
      : { type: 'button', sub_type: 'url', index: r.param, parameters: [{ type: 'text', text: texto }] });
  }
  return comps;
}

/** Cómo se verá el mensaje (para la vista previa del panel). */
export function vistaPrevia(analisis, variables, nombreCliente, respaldoNombre) {
  const poner = (texto, lugar) => String(texto || '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (todo, param) => {
    const r = analisis.ranuras.find((x) => x.lugar === lugar && x.param === param);
    return r && variables[r.clave] ? valorRanura(r, variables, nombreCliente, respaldoNombre) : todo;
  });
  const img = analisis.ranuras.find((r) => r.tipo === 'imagen');
  return {
    encabezado: analisis.encabezado?.tipo === 'texto' ? poner(analisis.encabezado.texto, 'encabezado') : null,
    imagen: img && variables[img.clave] ? variables[img.clave].texto : null,
    cuerpo: poner(analisis.cuerpo, 'cuerpo'),
    pie: analisis.pie || null,
    botones: analisis.botones.map((b) => b.texto).filter(Boolean),
  };
}

// ─── Errores de Meta ─────────────────────────────────────────────────────────
// Qué hacer con un rechazo AL MANDAR (respuesta HTTP de la Graph API):
//   detener      → algo de la cuenta o de la plantilla: le pasaría a todos.
//   reintentar   → límite de velocidad: el mismo cliente se intenta más tarde.
//   destinatario → solo ese cliente: se anota y se sigue con el siguiente.
//   incierto     → no sabemos si salió (se cayó la red a medio envío): NUNCA
//                  se reintenta solo, para no cobrarle a nadie dos veces.
const DETENER = new Set([10, 190, 200, 368, 131031, 131042, 131048, 132000, 132001, 132005, 132007, 132012, 132015, 132016, 133010]);
const REINTENTAR = new Set([4, 80007, 130429, 131056, 131057]);

export function clasificarErrorMeta({ red = false, status = 0, codigo = null } = {}) {
  if (red) return 'incierto';
  if (status === 401 || status === 403 || DETENER.has(codigo)) return 'detener';
  if (status === 429 || REINTENTAR.has(codigo)) return 'reintentar';
  if (status >= 500 && !codigo) return 'incierto';
  return 'destinatario';
}

const EXPLICACION = {
  4: 'Meta pidió bajar la velocidad', 10: 'Falta un permiso en la cuenta de WhatsApp',
  100: 'Meta rechazó un dato (el número o una variable)', 190: 'El acceso de WhatsApp venció: hay que reconectar el número',
  200: 'Falta un permiso en la cuenta de WhatsApp', 368: 'Meta bloqueó temporalmente la cuenta por sus políticas',
  130429: 'Meta pidió bajar la velocidad', 131000: 'Meta tuvo un error al mandarlo',
  131026: 'El número no tiene WhatsApp o no pudo recibirlo', 131031: 'La cuenta de WhatsApp está bloqueada',
  131042: 'Hay un problema con el pago de la cuenta de WhatsApp',
  131047: 'Fuera de la ventana de 24 h (texto libre)', 131048: 'Meta frenó los envíos de este número por reportes de spam',
  131049: 'Meta no lo entregó para no saturar al cliente de promociones',
  131050: 'El cliente pidió no recibir promociones de este negocio', 131051: 'Tipo de mensaje no soportado',
  131053: 'Meta no pudo descargar la imagen', 131056: 'Demasiados mensajes seguidos al mismo cliente',
  131057: 'La cuenta de WhatsApp está en mantenimiento', 132000: 'Las variables no cuadran con la plantilla',
  132001: 'La plantilla no existe en ese idioma', 132005: 'El mensaje quedó demasiado largo',
  132007: 'El texto no cumple las reglas de formato de Meta', 132012: 'Las variables no cuadran con la plantilla',
  132015: 'Meta pausó la plantilla (por baja calidad)', 132016: 'Meta deshabilitó la plantilla',
  133010: 'El número del negocio no está registrado en WhatsApp',
};
export const explicarCodigo = (codigo) => (codigo == null ? 'Sin respuesta de Meta' : (EXPLICACION[codigo] || `Meta respondió el código ${codigo}`));

// ─── Costo y horario ─────────────────────────────────────────────────────────
export function costoAproximado(categoria, n) {
  const tarifa = TARIFA_APROX_USD[categoria] ?? TARIFA_APROX_USD.MARKETING;
  // En diezmilésimos de dólar para que 3 × 0.045 dé 0.14 y no 0.13 por el redondeo binario.
  const diezmilesimos = Math.round(tarifa * 10000) * Math.max(0, Math.floor(Number(n) || 0));
  return { tarifaUsd: tarifa, totalUsd: Math.round(diezmilesimos / 100) / 100 };
}

export function horaLocal(ahora, zona) {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: zona, hour: 'numeric', hourCycle: 'h23' }).format(ahora);
  return Number(h) % 24;
}
export const dentroDeHorario = (ahora, zona) => {
  const h = horaLocal(ahora, zona);
  return h >= HORARIO_ENVIO.desde && h < HORARIO_ENVIO.hasta;
};
