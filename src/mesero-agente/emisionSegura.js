// ─── LA EMISIÓN SEGURA: lo que sale al cliente se deriva del estado ───────
//
// Cuando el pedido está en curso, el texto ya se construye con el estado
// (`respuestaDesdePedido`) y la prosa del modelo no sale. Quedan los turnos en
// los que sí se publica prosa del modelo: saludos sin pedido, consultas del
// menú, una búsqueda con varios candidatos. Ahí el modelo puede equivocarse de
// formas que el cliente leería como hechos:
//
//   · filtrar protocolo interno (JSON, nombres de herramientas, marcadores),
//     sobre todo cuando la respuesta se corta;
//   · nombrar un producto que la carta de WhatsApp NO publica (artículos
//     internos del POS);
//   · citar un precio que no está en la carta ni en el pedido;
//   · afirmar que el pedido quedó registrado o dar un folio sin que exista.
//
// Antes, la primera clase escalaba a una persona y las otras salían tal cual.
// Ahora cualquiera de ellas DESCARTA la prosa y la sustituye por una respuesta
// que el backend construye con datos verificados (la consulta real o la
// siguiente pregunta del pedido). La prosa descartada no se publica ni se
// "limpia" a medias: limpiar podría dejar una promesa escrita antes de tiempo.
import { detectarSalidaInterna } from './salidaPublicable.js';

const norm = (s) => ` ${String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ$.]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
const normPalabras = (s) => ` ${String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;

const productosDe = (catalogo) => (Array.isArray(catalogo) ? catalogo : [])
  .flatMap((c) => (Array.isArray(c?.productos) ? c.productos : []));

/** Importes en pesos mencionados en un texto: «$105», «$1,250.50», «105 pesos». */
export function importesMencionados(texto) {
  const t = String(texto || '');
  const fuera = [];
  for (const m of t.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g)) {
    fuera.push(Number(`${m[1].replace(/,/g, '')}.${m[2] || '0'}`));
  }
  for (const m of t.matchAll(/\b(\d{1,5})(?:\.(\d{1,2}))?\s*(?:pesos|mxn)\b/gi)) {
    fuera.push(Number(`${m[1]}.${m[2] || '0'}`));
  }
  return fuera.filter((n) => Number.isFinite(n));
}

/** Todos los importes que Xabor puede sostener en este turno. */
export function importesVerificados({ catalogo = [], pedido = null, reglas = null, promociones = [] } = {}) {
  const permitidos = new Set();
  const agregar = (v) => { const n = Number(v); if (Number.isFinite(n) && n > 0) permitidos.add(Math.round(n * 100)); };
  for (const p of productosDe(catalogo)) {
    agregar(p.precio);
    for (const g of (p.modificadores || p.grupos || [])) {
      for (const o of (g?.opciones || [])) {
        const extra = Number(o?.precio_extra ?? o?.precio ?? 0) || 0;
        agregar(extra);
        if (extra > 0) agregar(Number(p.precio) + extra);
      }
    }
  }
  for (const l of (pedido?.lineas || [])) {
    agregar(l.precio_unitario);
    if (Number.isFinite(Number(l.precio_unitario))) agregar(Number(l.precio_unitario) * (Number(l.cantidad) || 1));
  }
  agregar(pedido?.subtotal); agregar(pedido?.total); agregar(pedido?.costo_envio);
  agregar(reglas?.pedidos?.costo_envio); agregar(reglas?.pedidos?.pedido_minimo_entrega);
  for (const z of (reglas?.pedidos?.zonas_entrega || [])) agregar(z?.costo);
  for (const promo of (Array.isArray(promociones) ? promociones : [])) {
    if (promo?.tipo === 'monto_fijo') agregar(promo.valor);
  }
  return permitidos;
}

const AFIRMA_REGISTRO = [
  /\b(?:pedido|orden)\b[^.!?\n]{0,40}\b(?:quedo|queda|esta|fue|ha sido|ya esta)\s+(?:confirmad|registrad|levantad)/,
  /\b(?:confirme|registre|levante)\s+(?:tu|su)\s+(?:pedido|orden)\b/,
  /\bfolio\b/,
  /\bxab\s?\d{2,}\b/,
];

/**
 * Revisa la prosa del modelo contra el estado autorizado del turno.
 * Devuelve `{ ok: true }` o `{ ok: false, motivo, detalle }`.
 */
export function revisarRedaccion({
  texto = '', estado = null, pedido = null, catalogo = [], nombresOcultos = [],
  reglas = null, promociones = [],
} = {}) {
  const interna = detectarSalidaInterna(texto);
  if (interna) return { ok: false, motivo: `salida_interna:${interna.clase}`, detalle: interna.token };

  // Productos ocultos. Primero se retiran del texto los nombres PUBLICADOS
  // (del más largo al más corto), para que «Hotcakes Tradicionales» no cuente
  // como una mención del artículo interno «Hotcakes».
  let resto = normPalabras(texto);
  const publicados = productosDe(catalogo).map((p) => normPalabras(p.nombre).trim()).filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const n of publicados) resto = resto.split(` ${n} `).join(' ');
  for (const oculto of nombresOcultos) {
    const n = normPalabras(oculto).trim();
    if (n && n.length >= 3 && resto.includes(` ${n} `)) {
      return { ok: false, motivo: 'producto_no_publicado', detalle: oculto };
    }
  }

  if (!estado?.hechos?.confirmado) {
    const t = normPalabras(texto);
    // Excepciones informativas cerradas, sin números ni afirmaciones de
    // asignación. No retirar la protección general de folios inventados.
    const folioInformativo=/^(?:el folio (?:aparece|esta) en (?:tu|el) ticket|donde esta el folio|envia el folio de (?:tu|la) compra)$/.test(t.trim());
    if (!folioInformativo && AFIRMA_REGISTRO.some((re) => re.test(t))) {
      return { ok: false, motivo: 'confirmacion_no_registrada', detalle: null };
    }
  }

  const importes = importesMencionados(texto);
  if (importes.length) {
    const permitidos = importesVerificados({ catalogo, pedido, reglas, promociones });
    const falso = importes.find((n) => !permitidos.has(Math.round(n * 100)));
    if (falso !== undefined) return { ok: false, motivo: 'precio_no_verificado', detalle: falso };
  }
  return { ok: true };
}

export { norm as _normParaPruebas };
