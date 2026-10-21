// La promoción dentro del formulario «tienda» (tienda_v1), ANTES de enviarlo.
//
// Incidente 21-oct-2026 (Mapolato Acuña, miércoles): con «Miércoles de
// Chilaquiles» (2x1) vigente, una clienta armó en el formulario dos
// Chilaquiles Sencillos que sí participaban, llegó a «Entrega y pago» viendo
// «Continuar · $450» y pidió ayuda: «cuando voy a pagar no se me aplica la
// promoción del día». El motor la habría aplicado en el resumen del chat, pero
// el formulario solo dibujaba el subtotal y un «promociones se calculan al
// revisar» en letra chica. Se fue a pedir por chat; otros ni preguntan.
//
// LÍMITE DURO: este módulo NO decide precios ni descuentos. Le pregunta a
// `previsualizarPedido` —el MISMO pipeline de `registrarPedido`, sin
// persistir nada— y traduce su respuesta a lo que el formulario dibuja. La
// explicación de una promoción que no aplicó la redacta `promoDiagnostico`
// (código, nunca el modelo).
//
// Falla cerrado hacia lo de antes: error, demora de más de ESPERA_PROMO_MS,
// orden rechazada o cualquier duda → null, y el formulario se dibuja con el
// subtotal exactamente como siempre. Nunca bloquea ni tumba una respuesta.
//
// Interruptor sin redeploy: `whatsapp_flow_tienda_promos_v1 = 'false'` en la
// configuración del negocio lo apaga.
import { previsualizarPedido } from '../orders/orderManager.js';
import { explicarPromosNoAplicadas } from '../services/promoDiagnostico.js';
import { lineaVista, codigo } from './flowCarrito.js';

export const ESPERA_PROMO_MS = 1200;
const VIDA_CACHE_MS = 60_000, MAX_CACHE = 200;
// Misma pregunta en menos de un minuto (Atrás, «Seguir pidiendo», una
// categoría) no vuelve a la base. La vigencia de una promoción se mide en
// minutos; el resumen del chat la recalcula de todos modos al final.
const cache = new Map();

/** ¿Este negocio muestra la promoción en el formulario? Encendido salvo que se apague explícitamente. */
export const promosEnFormularioActivas = (cfg) => cfg?.whatsapp_flow_tienda_promos_v1 !== 'false';

const centavos = (n) => Math.round((Number(n) || 0) * 100);

/**
 * Las entregas con las que se calcula. Si el cliente ya eligió, la suya. Si
 * no, TODAS las que ofrece el formulario: se mostrará el descuento menor, para
 * no prometer uno que otra entrega no tendría (una promoción puede ser solo
 * para recoger o solo a domicilio).
 */
export function entregasPosibles(foto, borrador) {
  const m = borrador?.modalidad, i = Number.isInteger(m) ? m : codigo(m, 'm');
  const elegida = foto?.modalidades?.[i]?.valor;
  if (elegida) return [elegida];
  const todas = [...new Set((foto?.modalidades || []).map((x) => x?.valor).filter(Boolean))];
  return todas.length ? todas : [null];
}

/**
 * La forma de pago para la vista previa. El validador la exige, pero no mueve
 * el total (`calcularPromociones` ni la recibe): la elegida o, si aún no hay,
 * la primera que ofrece el formulario. Sin ninguna, la vista se rechaza.
 */
export function pagoParaVista(foto, borrador) {
  const p = borrador?.pago, i = Number.isInteger(p) ? p : codigo(p, 'p');
  return foto?.pagos?.[i]?.valor || foto?.pagos?.find((x) => x?.valor)?.valor || null;
}

/** La orden que espera `previsualizarPedido`, armada con los renglones del borrador (ids y nombres de la foto). */
export function ordenDelBorrador({ negocioId, foto, borrador, telefono = null, modalidad = null }) {
  const items = (borrador?.filas || []).map((f) => {
    const l = lineaVista(foto, f);
    return { id: l.ficha.id, nombre: l.ficha.nombre, cantidad: l.cantidad,
      modificadores: l.seleccion.map((o) => ({ grupo: o.grupo, opcion: o.opcion })) };
  });
  return { negocioId, telefono_conversacion: telefono, catalogo_publicado: 'whatsapp', items,
    cliente: { telefono: telefono || null }, modalidad: modalidad || null, forma_pago: pagoParaVista(foto, borrador) };
}

/** «Con 1 platillo participante más …»: lo que el motor reporta como oportunidad, en palabras del cliente. */
function textoOportunidad(o, aplicada) {
  const n = Number(o?.unidadesFaltantes);
  if (!Number.isInteger(n) || n < 1 || !o?.nombre) return '';
  const cuantos = n === 1 ? '1 platillo participante más' : `${n} platillos participantes más`;
  return aplicada ? `Con ${cuantos}, «${o.nombre}» se aplica otra vez.` : `Con ${cuantos} se aplica «${o.nombre}».`;
}

async function calcular({ negocioId, foto, borrador, telefono, previsualizar, explicar }) {
  const vistas = await Promise.all(entregasPosibles(foto, borrador).map((modalidad) =>
    previsualizar(ordenDelBorrador({ negocioId, foto, borrador, telefono, modalidad }), negocioId, { canal: 'whatsapp' })));
  // Una sola rechazada (platillo incompleto, carta cambiada, modo solicitud) y
  // no se dibuja nada: el formulario y el chat ya dicen qué falta.
  if (!vistas.length || vistas.some((v) => !v?.ok || !v.preview)) return null;
  const previa = vistas.reduce((a, v) => (Number(v.preview.descuento_total) < Number(a.preview.descuento_total) ? v : a));
  const p = previa.preview;
  const subtotalCentavos = centavos(p.subtotal);
  // El descuento que se dibuja es el que el registro restaría (ya acotado al subtotal).
  const descuentoCentavos = Math.min(centavos(p.descuento_total), subtotalCentavos);
  const promociones = (p.promociones || []).filter((x) => Number(x?.descuento) > 0)
    .map((x) => ({ nombre: String(x.nombre || '').trim(), descuentoCentavos: centavos(x.descuento) }));
  let explicacion = '';
  try {
    explicacion = await explicar(negocioId, previa.orden, { canal: 'whatsapp', promosAplicadas: p.promociones || [] }) || '';
  } catch { explicacion = ''; }
  const avisos = String(explicacion).split('\n').map((s) => s.trim()).filter(Boolean);
  for (const o of previa.orden?.promo_oportunidades || []) {
    // Si ya se explicó por qué no aplicó, la oportunidad sobra.
    if (o?.nombre && explicacion.includes(`"${o.nombre}"`)) continue;
    const texto = textoOportunidad(o, promociones.some((x) => x.nombre === o?.nombre));
    if (texto) avisos.push(texto);
  }
  return { subtotalCentavos, descuentoCentavos: Math.max(0, descuentoCentavos), promociones, avisos };
}

function conTope(promesa, ms) {
  return new Promise((resolver) => {
    const reloj = setTimeout(() => resolver(null), ms);
    promesa.then((v) => { clearTimeout(reloj); resolver(v); }, () => { clearTimeout(reloj); resolver(null); });
  });
}

/**
 * La promoción del borrador para dibujarla: {subtotalCentavos,
 * descuentoCentavos, promociones:[{nombre, descuentoCentavos}], avisos:[texto]}
 * o null (sin platillos, sin respuesta a tiempo o con cualquier error).
 */
export async function promoDelBorrador({ negocioId, foto, borrador, telefono = null,
  previsualizar = previsualizarPedido, explicar = explicarPromosNoAplicadas, esperaMs = ESPERA_PROMO_MS, ahora = Date.now } = {}) {
  if (!negocioId || !foto || !borrador?.filas?.length) return null;
  let clave;
  try {
    clave = JSON.stringify([negocioId, telefono, entregasPosibles(foto, borrador), ordenDelBorrador({ negocioId, foto, borrador }).items]);
  } catch { return null; }
  const t = ahora();
  for (const [k, v] of cache) if (v.vence <= t) cache.delete(k);
  let entrada = cache.get(clave);
  if (!entrada) {
    const promesa = calcular({ negocioId, foto, borrador, telefono, previsualizar, explicar }).catch((e) => {
      console.warn(`[FLOW] promoción del formulario no disponible negocio=${negocioId}: ${String(e?.message || e).slice(0, 120)}`);
      return null;
    });
    entrada = { vence: t + VIDA_CACHE_MS, promesa };
    // Un fallo no se recuerda: la siguiente pantalla vuelve a preguntar.
    const propia = entrada;
    promesa.then((v) => { if (v === null && cache.get(clave) === propia) cache.delete(clave); });
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(clave, entrada);
  }
  return conTope(entrada.promesa, esperaMs);
}

/** Solo pruebas: vacía la memoria de un minuto. */
export function olvidarPromosDelFormulario() { cache.clear(); }
