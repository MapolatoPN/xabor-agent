// Normaliza el formato de un mensaje saliente para WhatsApp.
//
// El modelo a veces devuelve Markdown (**negrita**) o escapa los asteriscos
// (\*), cosas que WhatsApp NO interpreta: el cliente termina viendo los
// símbolos literales ("**Resumen final:**"). WhatsApp solo entiende UN
// asterisco para negrita (*texto*), guion bajo para itálica (_texto_) y
// tilde para tachado (~texto~).
//
// Este normalizador es la última capa antes de guardar/enviar el texto del
// bot, así que el panel de chats y el cliente ven exactamente lo mismo. Es
// conservador a propósito: NO hace un replace global de "* → algo", solo
// arregla los dos defectos observados (Markdown de doble asterisco y
// escapes de barra invertida), para no alterar contenido legítimo.
//
// No introduce HTML: solo transforma caracteres de formato de WhatsApp.

export function normalizarFormatoWhatsApp(texto) {
  if (typeof texto !== 'string' || !texto) return texto;
  let t = texto;

  // 1) Des-escapar los caracteres de formato de WhatsApp que el modelo pudo
  //    anteponer con barra invertida. "\*" nunca es contenido legítimo que
  //    queramos mostrar a un cliente: es un intento fallido de escapar.
  t = t.replace(/\\([*_~`])/g, '$1');

  // 2) Colapsar la negrita Markdown (**texto**) a la negrita de WhatsApp
  //    (*texto*). Se exige contenido no vacío entre los pares y se evita
  //    tocar secuencias de 3+ asteriscos (separadores/decorados) para no
  //    romper contenido inusual. Un solo asterisco NO se toca.
  t = t.replace(/(?<!\*)\*\*(?!\*)([^\n*][^*\n]*?)\*\*(?!\*)/g, '*$1*');

  // 3) Itálica Markdown de doble guion bajo (__texto__) → itálica WhatsApp.
  t = t.replace(/(?<!_)__(?!_)([^\n_][^_\n]*?)__(?!_)/g, '_$1_');

  // 4) Encabezados Markdown al inicio de línea (#, ##, ### …): WhatsApp no
  //    los entiende. Se quita el prefijo de almohadillas y se deja el texto.
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');

  return t;
}
