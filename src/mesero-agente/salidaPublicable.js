import { BLOQUES_CON_CIERRE } from '../agent/marcadoresTruncados.js';
import { NOMBRES } from './contratoDeHerramientas.js';

const MARCADORES_SUELTOS = Object.freeze([
  'ENVIAR_MENU',
  'ESCALAR_A_HUMANO',
  'CONSULTA_PENDIENTE',
  'BORRADOR_LISTO',
  'CATERING_DATOS_LISTOS',
  'DOCUMENTO_NO_CONFIABLE',
]);

const escapar = (valor) => String(valor).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const apareceComoTag = (texto, token) => {
  const t = escapar(token);
  return new RegExp(
    `(?:<|&lt;)\\s*\\/?\\s*${t}(?:\\s*:[^>&]*?)?\\s*(?:>|&gt;)`,
    'i',
  ).test(texto);
};

const clavesDeObjeto = (valor) => (valor && typeof valor === 'object' && !Array.isArray(valor)
  ? new Set(Object.keys(valor)) : new Set());

function firmaDeEntradaDeHerramienta(valor) {
  if (Array.isArray(valor)) {
    for (const elemento of valor) {
      const firma = firmaDeEntradaDeHerramienta(elemento);
      if (firma) return firma;
    }
    return null;
  }
  if (!valor || typeof valor !== 'object') return null;
  const claves = clavesDeObjeto(valor);
  for (const inequívoca of [
    'producto_id', 'linea_id', 'huella_resumen', 'forma_pago', 'paga_con',
    'sin_opciones', 'zona_entrega', 'fecha_hora',
  ]) {
    if (claves.has(inequívoca)) return inequívoca;
  }
  if (claves.has('fecha') && claves.has('hora')) return 'fecha+hora';
  for (const anidado of Object.values(valor)) {
    const firma = firmaDeEntradaDeHerramienta(anidado);
    if (firma) return firma;
  }
  return null;
}

const objetoJson = (texto) => {
  const candidato = String(texto || '').trim();
  if (!/^(?:\{|\[)/.test(candidato)) return null;
  try {
    const valor = JSON.parse(candidato);
    return valor && typeof valor === 'object' ? valor : null;
  } catch {
    return null;
  }
};

function bloquesJsonBalanceados(texto) {
  const bloques = [];
  let inicio = -1;
  let pila = [];
  let enCadena = false;
  let escapado = false;
  for (let i = 0; i < texto.length; i += 1) {
    const caracter = texto[i];
    if (enCadena) {
      if (escapado) escapado = false;
      else if (caracter === '\\') escapado = true;
      else if (caracter === '"') enCadena = false;
      continue;
    }
    if (caracter === '"' && inicio >= 0) {
      enCadena = true;
      continue;
    }
    if (caracter === '{' || caracter === '[') {
      if (inicio < 0) inicio = i;
      pila.push(caracter === '{' ? '}' : ']');
      continue;
    }
    if (inicio >= 0 && (caracter === '}' || caracter === ']')) {
      if (pila.at(-1) !== caracter) {
        inicio = -1;
        pila = [];
        continue;
      }
      pila.pop();
      if (!pila.length) {
        const valor = objetoJson(texto.slice(inicio, i + 1));
        if (valor) bloques.push(valor);
        inicio = -1;
      }
    }
  }
  return bloques;
}

function entradaJsonInterna(texto) {
  const limpio = String(texto || '').trim();
  const cerca = limpio.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const cuerpoFinal = (cerca ? cerca[1] : limpio).trim();

  // La salida final del Canario es prosa para el cliente. Un objeto/arreglo
  // JSON que ocupa toda la respuesta es carga de máquina aunque use claves
  // genéricas (o esté vacío); no hay un JSON público válido en este canal.
  if (objetoJson(cuerpoFinal)) return 'estructura';

  // Un bloque rotulado como JSON tampoco es prosa pública. Esta guarda cubre
  // cercas acompañadas de explicación y JSON inválido/parcial que no podría
  // analizarse con JSON.parse.
  if (/```\s*json\b[\s\S]*?```/i.test(limpio)) return 'estructura';

  // En prosa sí exigimos una firma inequívoca para no bloquear ejemplos o
  // importes normales que contienen llaves.
  for (const valor of bloquesJsonBalanceados(limpio)) {
    const firma = firmaDeEntradaDeHerramienta(valor);
    if (firma) return firma;
  }
  return null;
}

/**
 * Detecta carga de máquina en una respuesta final del agente nuevo.
 *
 * El agente de herramientas nunca necesita publicar XML, nombres de tools ni
 * bloques serializados del SDK. Si alguno aparece como texto, la respuesta se
 * entrega a una persona en vez de intentar "limpiarla": limpiar podría dejar
 * una promesa escrita antes de ejecutar el efecto.
 */
export function detectarSalidaInterna(texto = '') {
  const bruto = String(texto || '');
  for (const token of [...BLOQUES_CON_CIERRE, ...MARCADORES_SUELTOS]) {
    if (apareceComoTag(bruto, token)
        || new RegExp(`(^|[^a-z0-9_])${escapar(token)}(?=$|[^a-z0-9_])`, 'i').test(bruto)) {
      return { clase: 'marcador', token };
    }
  }
  for (const token of ['tool_use', 'tool_result']) {
    if (new RegExp(`(?:["'](?:type|content)["']\\s*:\\s*["']${token}["']|\\b${token}\\b)`, 'i').test(bruto)) {
      return { clase: 'protocolo', token };
    }
  }
  for (const nombre of NOMBRES) {
    if (new RegExp(`(^|[^a-z0-9_])${escapar(nombre)}(?=$|[^a-z0-9_])`, 'i').test(bruto)) {
      return { clase: 'herramienta', token: nombre };
    }
  }
  if (/(?:["'](?:aplicado|huella|tool_use_id|is_error)["']|[{,]\s*(?:aplicado|huella|tool_use_id|is_error))\s*:/i.test(bruto)
      || (/["']pedido["']\s*:/i.test(bruto) && /["'](?:estado|resultado)["']\s*:/i.test(bruto))) {
    return { clase: 'resultado_herramienta', token: 'estructura' };
  }
  const entradaInterna = entradaJsonInterna(bruto);
  if (entradaInterna) return { clase: 'entrada_herramienta', token: entradaInterna };
  return null;
}
