// Clasifica únicamente la navegación inicial, nunca productos, cantidades ni
// efectos comerciales. Un mensaje mixto/no reconocido conserva su ruta normal.
// La frase completa debe encajar: buscar solo «ordenar» capturaría negaciones,
// cancelaciones, consultas y pedidos con detalles que no se deben descartar.
const palabraExpresiva = palabra => [...palabra].map(letra => `${letra}+`).join('');
const saludo = [
  'hola', 'buenos dias', 'buen dia', 'buenas tardes', 'buenas noches', 'buenas',
  'buentas tardes',
].map(frase => frase.split(' ').map(palabraExpresiva).join('\\s+')).join('|');
const prefijoSaludo = new RegExp(`^(?:muy\\s+)?(?:${saludo})(?:\\s+|$)`);
const cortesiasInicio = /^(?:por favor|porfa)\s+/;
const cortesiasFinal = /\s+(?:por favor|porfa|gracias)$/;

function normalizarEntrada(mensaje) {
  if (typeof mensaje !== 'string' || mensaje.length > 512) return '';
  return mensaje.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    // Solo cortesía visual conocida; no borrar emojis que expresen productos.
    .replace(/[👋😊🙂☀\uFE0F]/gu, ' ')
    .replace(/[!¡?¿,.;:…\s]+/g, ' ').trim();
}

const objeto = '(?:un pedido|una orden|pedido)';
// Intención general sin producto concreto (incidente 1-oct: «Me gustaría
// ordenar un platillo», «Le podría encargar un platillo de desayuno»).
const generico = '(?:un platillo|unos platillos|algo|comida)(?: (?:de|para) (?:desayuno|desayunar|comer|almorzar|cenar))?';
const accion = `(?:(?:ordenar|pedir|encargar)(?: (?:${objeto}|${generico}))?|(?:hacer|realizar|levantar) ${objeto})`;
const voluntad = '(?:(?:yo )?(?:quiero|quisiera|querria|deseo|desearia|necesito)|queremos|quisieramos|me gustaria|nos gustaria)';
// La petición cortés a la tienda: «le podría encargar…», «¿les puedo pedir…?».
const cortesia = '(?:(?:le|les|te) )?(?:podria|podriamos|puedo|podemos)';
const pedir = new RegExp(`^(?:${accion}|${voluntad} (?:${accion}|${objeto})|`
  + `${cortesia} ${accion}|me (?:puedes|podrias|pueden) tomar ${objeto}|`
  + `para ${accion}|ya se que (?:quiero )?(?:ordenar|pedir))$`);

// «¿Hablo a Mapolato Obispado?» abre la conversación igual que un saludo. Lo
// nombrado debe ser el negocio (o parte de su nombre): «hablo a mapolato para
// pedir unos chilaquiles» trae un pedido y conserva su ruta.
const quienHabla = /^(?:con quien (?:hablo|tengo el gusto)|quien (?:habla|eres))$/;
const hablaA = /^(?:(?:hablo|estoy hablando|me comunico|me estoy comunicando|escribo) (?:a|al|con|en)|es|este es|aqui es|son) (.+)$/;
const RELLENO = new Set(['el','la','los','las','al','de','del','restaurante','sucursal','numero','telefono','whatsapp']);
function preguntaDeIdentidad(texto, nombreNegocio) {
  if (quienHabla.test(texto)) return true;
  const nombre = new Set(normalizarEntrada(String(nombreNegocio || '')).split(' ')
    .filter(p => p.length >= 3 && !RELLENO.has(p)));
  const nombrado = texto.match(hablaA)?.[1].split(' ');
  return !!nombrado && nombre.size > 0 && nombrado.some(p => nombre.has(p))
    && nombrado.every(p => nombre.has(p) || RELLENO.has(p));
}

export function solicitudDeEntrada(mensaje, { nombreNegocio = null } = {}) {
  let texto = normalizarEntrada(mensaje);
  if (!texto) return null;
  if (/^(?:inicio|menu principal|opciones de atencion)$/.test(texto)) return {intencion:'inicio'};
  let huboSaludo = false;
  // Permite saludo + petición en un mismo mensaje o lote, sin quedarse solo
  // con el saludo ni pedir al cliente que repita su intención de ordenar.
  while (prefijoSaludo.test(texto)) {
    huboSaludo = true;
    texto = texto.replace(prefijoSaludo, '').trim();
  }
  if (!texto) return huboSaludo ? {intencion:'saludo'} : null;
  texto = texto.replace(cortesiasInicio, '');
  while (cortesiasFinal.test(texto)) texto = texto.replace(cortesiasFinal, '');
  if (preguntaDeIdentidad(texto, nombreNegocio)) return {intencion:'saludo'};
  const entrega=texto.match(/ (a domicilio|para recoger(?: en tienda)?|para llevar|para comer aqui)$/);
  const solicitud=entrega?texto.slice(0,-entrega[0].length):texto;
  return pedir.test(solicitud)?{intencion:'ordenar',...(entrega?{modalidad:entrega[1]}:{})}:null;
}

export const intencionDeEntrada=(mensaje,opciones)=>solicitudDeEntrada(mensaje,opciones)?.intencion || null;
