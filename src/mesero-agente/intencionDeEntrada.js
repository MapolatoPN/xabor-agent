// Clasifica únicamente la navegación inicial, nunca productos, cantidades ni
// efectos comerciales. Un mensaje mixto/no reconocido conserva su ruta normal.
// La frase completa debe encajar: buscar solo «ordenar» capturaría negaciones,
// cancelaciones, consultas y pedidos con detalles que no se deben descartar.
const palabraExpresiva = palabra => [...palabra].map(letra => `${letra}+`).join('');
const saludo = [
  'hola', 'buenos dias', 'buen dia', 'buenas tardes', 'buenas noches', 'buenas',
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
const accion = `(?:(?:ordenar|pedir)(?: ${objeto})?|(?:hacer|realizar|levantar) ${objeto})`;
const voluntad = '(?:(?:yo )?(?:quiero|quisiera|querria|deseo|desearia|necesito)|queremos|quisieramos|me gustaria|nos gustaria)';
const pedir = new RegExp(`^(?:${accion}|${voluntad} (?:${accion}|${objeto})|`
  + `(?:puedo|podemos) ${accion}|me (?:puedes|podrias|pueden) tomar ${objeto}|`
  + 'ya se que (?:quiero )?(?:ordenar|pedir))$');

export function intencionDeEntrada(mensaje) {
  let texto = normalizarEntrada(mensaje);
  if (!texto) return null;
  if (/^(?:inicio|menu principal|opciones de atencion)$/.test(texto)) return 'inicio';
  let huboSaludo = false;
  // Permite saludo + petición en un mismo mensaje o lote, sin quedarse solo
  // con el saludo ni pedir al cliente que repita su intención de ordenar.
  while (prefijoSaludo.test(texto)) {
    huboSaludo = true;
    texto = texto.replace(prefijoSaludo, '').trim();
  }
  if (!texto) return huboSaludo ? 'saludo' : null;
  texto = texto.replace(cortesiasInicio, '');
  while (cortesiasFinal.test(texto)) texto = texto.replace(cortesiasFinal, '');
  return pedir.test(texto) ? 'ordenar' : null;
}
