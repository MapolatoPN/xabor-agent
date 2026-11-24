// Qué sucursal atiende este WhatsApp, dicho en los mensajes del bot, y a dónde
// mandar a quien buscaba otra sucursal del mismo dueño.
//
// Incidente del 23-nov-2026 (XAB-3915): un cliente de Acuña escribió al
// WhatsApp de Obispado (la página de Mapolato solo enlazaba ese número). Llenó
// el formulario y confirmó un pedido «para recoger» sin que ningún mensaje
// dijera de qué sucursal era, y Obispado lo preparó en vano. Del 5-oct al
// 23-nov hubo otras 14 conversaciones en Obispado que buscaban Acuña. El
// personal las resolvió dando el número a mano, y una vez lo dio equivocado.
//
// Dos interruptores por negocio, los dos apagados por omisión:
// - whatsapp_sucursal_visible_v1 = 'true': el saludo, «Revisa tu pedido», la
//   confirmación, el aviso de cerrado y el cuerpo corto del menú («Estrenamos
//   una nueva forma de pedir») nombran la sucursal y su ciudad.
// - whatsapp_sucursales_hermanas = JSON con las otras sucursales. Si el cliente
//   menciona una («el pedido es en Acuña»), recibe su WhatsApp y su tienda sin
//   que la conversación se pause. A quien solo ha pedido en una hermana, el
//   saludo le avisa antes del formulario.

export const CLAVE_SUCURSAL_VISIBLE = 'whatsapp_sucursal_visible_v1';
export const CLAVE_HERMANAS = 'whatsapp_sucursales_hermanas';

const normalizar = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const limpio = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const digitos = (s) => String(s ?? '').replace(/\D/g, '');
const esRecoger = (modalidad) => normalizar(modalidad).includes('recoger');

/** La ciudad solo se agrega si el nombre no la trae ya («Mapolato Acuña»). */
function ciudadAparte(nombre, ciudad) {
  const c = normalizar(ciudad);
  return c && !normalizar(nombre).includes(c) ? limpio(ciudad) : '';
}

/**
 * La sucursal de este WhatsApp, o null si el interruptor está apagado o falta
 * el nombre. `etiqueta`: «Mapolato Obispado · Piedras Negras».
 */
export function sucursalVisible(cfg) {
  if (String(cfg?.[CLAVE_SUCURSAL_VISIBLE]) !== 'true') return null;
  const nombre = limpio(cfg?.nombre || cfg?.nombre_negocio);
  if (!nombre) return null;
  const ciudad = limpio(cfg?.ciudad);
  const aparte = ciudadAparte(nombre, ciudad);
  return {
    nombre, ciudad, ciudadAparte: aparte, direccion: limpio(cfg?.direccion),
    etiqueta: aparte ? `${nombre} · ${aparte}` : nombre,
  };
}

const nombrada = (sucursal) => `*${sucursal.nombre}*${sucursal.ciudadAparte ? ` (${sucursal.ciudadAparte})` : ''}`;

/** «de *Mapolato Obispado* (Piedras Negras)» para «Soy *Mapo Bot* …». */
export function deLaSucursal(sucursal) {
  return sucursal ? ` de ${nombrada(sucursal)}` : '';
}

/** « en *Mapolato Obispado* (Piedras Negras)» para el aviso de cerrado («Recibimos tu mensaje en …»). */
export function enLaSucursal(sucursal) {
  return sucursal ? ` en ${nombrada(sucursal)}` : '';
}

/**
 * El cuerpo corto del menú (FRASES.CARTA_FORMULARIO: lo que recibe quien pide
 * la carta sin carrito) con la sucursal tras el «¡Hola! 👋» y, si toca, el
 * aviso al cliente de una hermana. El último
 * renglón («En este botón…») queda pegado al botón. Sin sucursal ni aviso, el
 * texto sale idéntico.
 */
export function cartaDeLaSucursal(carta, { sucursal = null, aviso = '' } = {}) {
  const t = String(carta || '');
  if (!sucursal && !aviso) return t;
  const i = t.indexOf('\n');
  const hola = i < 0 ? t : t.slice(0, i);
  const resto = i < 0 ? '' : t.slice(i + 1);
  const cabeza = sucursal ? `${hola}\nEste es el WhatsApp${deLaSucursal(sucursal)}.` : hola;
  const cuerpo = [cabeza, aviso, resto].filter(Boolean).join(aviso ? '\n\n' : '\n');
  // El cuerpo de un formulario de WhatsApp no pasa de 1024: sin el aviso antes que sin formulario.
  return cuerpo.length <= 1024 ? cuerpo : cartaDeLaSucursal(t, { sucursal });
}

/** Renglón de «Revisa tu pedido»; va justo después de «Modalidad:». */
export function renglonDelResumen(sucursal) {
  return sucursal ? `Sucursal: *${sucursal.etiqueta}*\n` : '';
}

/**
 * Frase final de la confirmación. Para recoger dice dónde, con la dirección;
 * a domicilio, quién lo prepara.
 */
export function fraseDeConfirmacion(sucursal, modalidad) {
  if (!sucursal) return '';
  if (esRecoger(modalidad)) {
    const ciudad = sucursal.ciudad ? `, ${sucursal.ciudad}` : '';
    return sucursal.direccion
      ? `Recoges en ${sucursal.nombre}: ${sucursal.direccion}${ciudad}.`
      : `Recoges en ${sucursal.etiqueta}.`;
  }
  return `Lo prepara ${sucursal.etiqueta}.`;
}

// ── Sucursales hermanas ────────────────────────────────────────────────────

/**
 * Lee `whatsapp_sucursales_hermanas`: [{ nombre, ciudad, whatsapp, tienda?,
 * negocio_id?, alias? }]. Descarta en silencio lo que no sirva: sin nombre o
 * ciudad no hay cómo reconocerla, y sin WhatsApp ni tienda no hay a dónde
 * mandar al cliente. Una hermana con la misma ciudad que este negocio se
 * ignora: confundiría la ciudad propia con la ajena.
 */
export function sucursalesHermanas(cfg) {
  let lista;
  try { lista = JSON.parse(String(cfg?.[CLAVE_HERMANAS] || '[]')); } catch { return []; }
  if (!Array.isArray(lista)) return [];
  const propia = normalizar(cfg?.ciudad);
  return lista.map((h) => {
    const nombre = limpio(h?.nombre);
    const ciudad = limpio(h?.ciudad);
    const tel = digitos(h?.whatsapp);
    const whatsapp = tel.length >= 10 && tel.length <= 13 ? tel : '';
    const tienda = /^https:\/\/[^\s]+$/.test(String(h?.tienda || '')) ? String(h.tienda) : '';
    const negocioId = /^[0-9a-f-]{36}$/i.test(String(h?.negocio_id || '')) ? String(h.negocio_id) : null;
    const alias = (Array.isArray(h?.alias) ? h.alias : []).map(normalizar).filter((a) => a.length >= 4);
    return { nombre, ciudad, whatsapp, tienda, negocioId, alias };
  }).filter((h) => h.nombre && h.ciudad && (h.whatsapp || h.tienda) && normalizar(h.ciudad) !== propia);
}

const PREFIJO = '(?:en|de|del|para|a|al|sucursal|sucursales)';
const ANTES_DEL_LUGAR = '(?:la )?(?:sucursal (?:de |en )?)?(?:cd |ciudad )?';

/**
 * La hermana que el mensaje nombra como LUGAR («en Acuña», «la sucursal de
 * Ciudad Acuña», «para acuna?»), o null. El lugar suelto no basta: «Acuña» es
 * también una calle muy común («Manuel Acuña 302») y un apellido.
 */
export function hermanaMencionada(mensaje, cfg) {
  const t = normalizar(mensaje);
  if (!t) return null;
  for (const h of sucursalesHermanas(cfg)) {
    const lugares = [...new Set([normalizar(h.ciudad), normalizar(h.nombre), ...h.alias])].filter(Boolean)
      .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const lugar = `(?:${lugares.join('|')})`;
    const nombrado = new RegExp(`(?:^| )${PREFIJO} ${ANTES_DEL_LUGAR}${lugar}(?: |$)`).test(t);
    const solo = new RegExp(`^(?:es )?${ANTES_DEL_LUGAR}${lugar}$`).test(t);
    if (nombrado || solo) return h;
  }
  return null;
}

const ligaWhatsApp = (h) => (h.whatsapp ? `https://wa.me/${h.whatsapp}` : '');

/**
 * Lo que recibe quien buscaba la hermana. Lo contesta el bot sin pausar la
 * conversación (ver recepcionista.js, R5); para cancelar un pedido hecho aquí
 * por error, «hablar con alguien» lo pasa al equipo.
 */
export function textoParaHermana({ cfg, hermana, folio = null, cerrado = false }) {
  const propia = limpio(cfg?.nombre || cfg?.nombre_negocio) || 'esta sucursal';
  const aparte = ciudadAparte(propia, cfg?.ciudad);
  // «Mapolato Acuña» ya dice la ciudad en el nombre, pero «es para Acuña» la necesita igual.
  const ciudad = aparte || limpio(cfg?.ciudad);
  const aqui = aparte ? `*${propia}*, en ${aparte}` : `*${propia}*`;
  const renglones = [`Este WhatsApp es de ${aqui}.`, ''];
  const wa = ligaWhatsApp(hermana);
  if (wa) renglones.push(`Para *${hermana.nombre}* escríbeles a su WhatsApp:\n${wa}`);
  if (hermana.tienda) renglones.push(`${wa ? 'O pide' : `Para *${hermana.nombre}* pide`} en línea:\n${hermana.tienda}`);
  renglones.push('');
  if (folio) renglones.push(`Tu pedido ${folio} quedó registrado aquí, en ${ciudad || propia}. Si era para ${hermana.ciudad}, escribe «hablar con alguien» y el equipo lo cancela.`);
  else renglones.push(`Si tu mensaje es para ${ciudad || 'esta sucursal'}, aquí te atendemos${cerrado ? ' en cuanto abramos' : ''}.`);
  return renglones.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * ¿Este teléfono pidió en una hermana y nunca aquí? Devuelve esa hermana o
 * null. Solo lee hermanas con `negocio_id` configurado (el dueño las ligó a
 * mano). Si falla la lectura, null: el saludo sale como siempre.
 */
export async function hermanaDelCliente(db, { cfg, negocioId, telefono } = {}) {
  const tel = digitos(telefono).slice(-10);
  const hermanas = sucursalesHermanas(cfg).filter((h) => h.negocioId && h.negocioId !== negocioId);
  if (!db || !negocioId || tel.length !== 10 || !hermanas.length) return null;
  try {
    // Mismo índice que la ficha del cliente (081): negocio + teléfono a 10 dígitos.
    const { rows } = await db.query({ text: `
      SELECT negocio_id::text AS negocio_id FROM pedidos_activos
       WHERE negocio_id = ANY($1::uuid[]) AND estado <> 'cancelado'
         AND datos->'cliente'->>'telefono' IS NOT NULL
         AND right(regexp_replace(datos->'cliente'->>'telefono', '\\D', '', 'g'), 10) = $2
       GROUP BY negocio_id`,
      values: [[negocioId, ...hermanas.map((h) => h.negocioId)], tel], query_timeout: 2000 });
    const con = new Set(rows.map((r) => r.negocio_id));
    if (con.has(negocioId)) return null;
    return hermanas.find((h) => con.has(h.negocioId)) || null;
  } catch (e) {
    console.error(`[SUCURSAL] no se pudo leer el historial en hermanas negocio=${negocioId}: ${e?.message}`);
    return null;
  }
}

/**
 * Mete `parrafo` antes del último párrafo del saludo («¿Cómo puedo
 * ayudarte?»), para que la pregunta siga al final, junto a los botones. Si el
 * saludo no tiene párrafos, lo agrega al final.
 */
export function insertarAntesDeLaPregunta(texto, parrafo) {
  const t = String(texto || '');
  if (!parrafo) return t;
  const i = t.lastIndexOf('\n\n');
  return i < 0 ? `${t}\n\n${parrafo}` : `${t.slice(0, i)}\n\n${parrafo}${t.slice(i)}`;
}

/** Párrafo que el saludo agrega para un cliente de la hermana. */
export function avisoClienteDeHermana({ cfg, hermana }) {
  if (!hermana) return '';
  const propia = limpio(cfg?.nombre || cfg?.nombre_negocio);
  const ciudad = ciudadAparte(propia, cfg?.ciudad) || limpio(cfg?.ciudad);
  const wa = ligaWhatsApp(hermana);
  const destino = wa ? `escríbeles aquí:\n${wa}` : `pide en línea:\n${hermana.tienda}`;
  return `📍 Tus pedidos anteriores fueron en *${hermana.nombre}*. Este WhatsApp es de `
    + `${ciudad || propia || 'otra sucursal'}; si tu pedido es para ${hermana.ciudad}, ${destino}`;
}
