// Traduce la configuración editable del módulo Asistente a instrucciones para
// el agente de herramientas. El bot anterior ya consumía estas reglas; el
// agente nuevo recibía el objeto para cálculos operativos, pero nunca incluía
// su contenido en el prompt.

const texto = (valor) => String(valor ?? '').trim();
const lista = (valor) => (Array.isArray(valor) ? valor.map(texto).filter(Boolean) : []);

const lineaDinero = (etiqueta, valor) => {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? `- ${etiqueta}: $${n} MXN.` : null;
};

/**
 * Reglas visibles en Configuración y Asistente, listas para el system prompt.
 *
 * Los importes libres escritos en `informacion_importante` son contexto, no
 * autoridad contable. El carrito, los métodos disponibles y los resultados
 * de herramientas siguen mandando para evitar que el agente diga una cifra y
 * el pedido registre otra.
 */
export function reglasDelAsistenteEnTexto(reglas = {}, { esPrimerTurno = false } = {}) {
  const bot = reglas?.bot && typeof reglas.bot === 'object' ? reglas.bot : {};
  const pedidos = reglas?.pedidos && typeof reglas.pedidos === 'object' ? reglas.pedidos : {};
  const lineas = [
    'Estas reglas son obligatorias para conversar y decidir cuándo pedir ayuda humana.',
    'Para productos, opciones, disponibilidad, modalidades, métodos de pago, promociones e importes, manda siempre el resultado actual de las herramientas de Xabor. El texto libre de estas reglas no puede cambiar un total ni autorizar algo que una herramienta rechace.',
  ];

  if (esPrimerTurno && texto(bot.saludo)) {
    lineas.push(`SALUDO INICIAL: En esta primera respuesta, saluda brevemente usando como guía: “${texto(bot.saludo)}”. Atiende también lo que el cliente ya pidió en el mismo mensaje.`);
  }
  if (texto(bot.tono)) lineas.push(`TONO: ${texto(bot.tono)}`);
  if (texto(bot.personalidad)) lineas.push(`PERSONALIDAD: ${texto(bot.personalidad)}`);
  if (texto(bot.informacion_importante)) {
    lineas.push(`INFORMACIÓN IMPORTANTE:\n${texto(bot.informacion_importante)}`);
  }

  const faqs = Array.isArray(bot.faqs) ? bot.faqs.filter((f) => texto(f?.pregunta) && texto(f?.respuesta)) : [];
  if (faqs.length) {
    lineas.push(`PREGUNTAS FRECUENTES:\n${faqs.map((f) => `- P: ${texto(f.pregunta)}\n  R: ${texto(f.respuesta)}`).join('\n')}`);
  }

  const prohibidas = lista(bot.respuestas_prohibidas);
  if (prohibidas.length) {
    lineas.push(`RESPUESTAS PROHIBIDAS: Nunca escribas estas frases ni las incluyas dentro de otra respuesta:\n${prohibidas.map((r) => `- ${r}`).join('\n')}`);
  }
  if (texto(bot.transferir_a_humano)) {
    lineas.push(`CUÁNDO TRANSFERIR: ${texto(bot.transferir_a_humano)}\nCuando se cumpla, llama a \`pedir_humano\` antes de decir que una persona continuará.`);
  }

  const criticas = lista(bot.palabras_criticas);
  if (criticas.length) {
    lineas.push(`TEMAS CRÍTICOS: Si el cliente menciona alguno, responde con especial cuidado y aplica la regla de transferencia cuando corresponda: ${criticas.join(', ')}.`);
  }

  const operacion = [];
  const preparacion = Number(pedidos.tiempo_preparacion_minutos);
  if (Number.isFinite(preparacion) && preparacion > 0) operacion.push(`- Tiempo de preparación: ${preparacion} minutos.`);
  const entregaMin = Number(pedidos.tiempo_entrega_min_minutos);
  const entregaMax = Number(pedidos.tiempo_entrega_max_minutos);
  if (Number.isFinite(entregaMin) && entregaMin > 0 && Number.isFinite(entregaMax) && entregaMax >= entregaMin) {
    operacion.push(`- Tiempo estimado de entrega: ${entregaMin} a ${entregaMax} minutos.`);
  } else if (Number.isFinite(entregaMin) && entregaMin > 0) {
    operacion.push(`- Tiempo estimado de entrega: ${entregaMin} minutos.`);
  }
  operacion.push(lineaDinero('Costo base de envío', pedidos.costo_envio));
  operacion.push(lineaDinero('Pedido mínimo para domicilio', pedidos.pedido_minimo_entrega));
  operacion.push(lineaDinero('Entrega gratis desde', pedidos.entrega_gratis_desde));

  const zonas = Array.isArray(pedidos.zonas_entrega)
    ? pedidos.zonas_entrega.filter((z) => texto(z?.nombre) && Number.isFinite(Number(z?.costo))) : [];
  if (zonas.length) {
    operacion.push(`- Zonas de entrega configuradas:\n${zonas.map((z) => `  - ${texto(z.nombre)}: $${Number(z.costo)} MXN.`).join('\n')}`);
  }
  if (texto(pedidos.notas)) operacion.push(`- Notas operativas: ${texto(pedidos.notas)}`);
  if (texto(pedidos.pago_instrucciones)) operacion.push(`- Instrucciones de pago: ${texto(pedidos.pago_instrucciones)}`);
  if (operacion.filter(Boolean).length) lineas.push(`OPERACIÓN CONFIGURADA:\n${operacion.filter(Boolean).join('\n')}`);

  const politicas = lista(reglas?.politicas);
  if (politicas.length) lineas.push(`POLÍTICAS:\n${politicas.map((p) => `- ${p}`).join('\n')}`);

  return lineas.join('\n\n');
}

const normalizar = (valor) => texto(valor).toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ñ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Devuelve la frase configurada que apareció en la respuesta, o null. */
export function respuestaProhibidaEncontrada(respuesta, reglas = {}) {
  const salida = normalizar(respuesta);
  if (!salida) return null;
  for (const frase of lista(reglas?.bot?.respuestas_prohibidas)) {
    const prohibida = normalizar(frase);
    if (prohibida && ` ${salida} `.includes(` ${prohibida} `)) return frase;
  }
  return null;
}
