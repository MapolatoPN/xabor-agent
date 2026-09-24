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

// Claves inequivocas del contrato de entrada de las herramientas. Se comparten
// entre la inspeccion de JSON valido y la guarda de JSON parcial: una respuesta
// cortada puede no tener llaves balanceadas ni ser parseable, pero sigue sin
// ser prosa publicable. Campos humanos como "nombre:" no son firma suficiente.
const CLAVES_ENTRADA_HERRAMIENTA = Object.freeze([
  'producto_id', 'linea_id', 'huella_resumen', 'forma_pago', 'paga_con',
  'sin_opciones', 'zona_entrega', 'fecha_hora',
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
  for (const conocida of CLAVES_ENTRADA_HERRAMIENTA) {
    if (claves.has(conocida)) return conocida;
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
  if (/```\s*json\b/i.test(limpio)) return 'estructura';

  // No dependemos de JSON.parse para reconocer argumentos truncados. Una
  // clave del contrato seguida de dos puntos ya identifica carga de maquina,
  // aunque falten la comilla final o la llave de cierre.
  for (const clave of CLAVES_ENTRADA_HERRAMIENTA) {
    const k = escapar(clave);
    if (new RegExp(`(?:["'“”‘’]${k}["'“”‘’]|\\b${k}\\b)\\s*:`, 'i').test(limpio)) return clave;
  }

  // Tambien falla cerrado ante el comienzo de cualquier objeto JSON-like.
  // Exige los dos puntos para conservar usos humanos de llaves, por ejemplo
  // "Usa {sin cebolla}" o "El costo usa {subtotal} como referencia.".
  if (/\{\s*(?:["“”](?:[^"“”\\\r\n]|\\.){1,80}["“”]|['‘’][^'‘’\\\r\n]{1,80}['‘’]|[a-z_$][\w$-]{0,79})\s*:/i.test(limpio)) {
    return 'estructura';
  }

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
  // Markdown puede escapar los guiones bajos de un código sin volverlo texto
  // público. Normalizamos solo para detectar; la respuesta original nunca se
  // reescribe ni se intenta "limpiar" parcialmente.
  const tecnicoNormalizado = bruto.replace(/\\_/g, '_');
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
  // El modelo a veces parafrasea un tool_result sin llaves ni comillas. La
  // pareja booleana/estado sigue siendo protocolo interno aunque venga como
  // «aplicado=false, estado=rechazada» en una oración aparentemente normal.
  const estructuraNormalizada = tecnicoNormalizado.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[“”‘’`*_<>|]/g, ' ')
    .replace(/(?:-{1,2}>|=>|→)/g, ' ')
    .replace(/\s+/g, ' ');
  const aplicadoEstructural = /\baplicado\b[^a-z0-9_]{0,24}(?:\b(?:true|false|si|no|verdadero|falso)\b|[01]\b)/i
    .test(estructuraNormalizada);
  const estadoEstructural = /\bestado\b[^a-z0-9_]{0,24}\b(?:ok|rechazad[oa]|ilegal|error|fallid[oa]|aplicad[oa]|pendiente)\b/i
    .test(estructuraNormalizada);
  if (aplicadoEstructural && estadoEstructural) {
    return { clase: 'resultado_herramienta', token: 'campos' };
  }
  if (/(?:["'](?:aplicado|huella|tool_use_id|is_error)["']|[{,]\s*(?:aplicado|huella|tool_use_id|is_error))\s*:/i.test(bruto)
      || (/["']pedido["']\s*:/i.test(bruto) && /["'](?:estado|resultado)["']\s*:/i.test(bruto))) {
    return { clase: 'resultado_herramienta', token: 'estructura' };
  }
  const entradaInterna = entradaJsonInterna(bruto);
  if (entradaInterna) return { clase: 'entrada_herramienta', token: entradaInterna };
  // Los motivos que viajan dentro de un tool_result usan identificadores de
  // máquina (`TENANT_CONTEXT_REQUIRED`, `resumen_caducado:`, etc.). Aunque el
  // modelo los convierta en una oración, siguen sin ser texto para clientes.
  // Se quitan primero las URL: firmas, rutas y query strings pueden contener
  // guiones bajos legítimos. Fuera de una URL, snake_case no es prosa pública
  // del Mesero y se retiene incluso si el modelo omite los dos puntos del
  // código. Se evalúa después de JSON para conservar el diagnóstico más
  // específico de argumentos filtrados.
  const sinCorreos = tecnicoNormalizado.replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g, '');
  // Los códigos de promociones sí son texto público y el contrato de cupones
  // permite guiones bajos. Solo se exceptúan cuando la propia prosa los
  // identifica como cupón/promoción; un error técnico suelto sigue cerrado.
  const sinCupones = sinCorreos.replace(
    /\b(?:cup[oó]n|c[oó]digo\s+(?:de\s+)?promocional|promoci[oó]n)\s*(?:es|:)?\s*([A-Z0-9][A-Z0-9._-]{1,29})\b/gi,
    (completo, codigo) => {
      // Sin la lista activa de cupones no se puede distinguir cualquier
      // identificador arbitrario. La excepción local se limita a códigos
      // promocionales con cifra y sin vocabulario inequívocamente técnico.
      const pareceTecnico = /(?:TENANT|CONTEXT|REQUIRED|ERROR|FAILED|INVALID|DATABASE|SQL|TOOL|AGENTE|SALIDA|RESPUESTA|PEDIDO|ORDEN)/i
        .test(codigo);
      return /\d/.test(codigo) && !pareceTecnico ? '' : completo;
    },
  );
  const codigoMayusculas = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/.exec(sinCupones)?.[0];
  if (codigoMayusculas) return { clase: 'codigo_interno', token: codigoMayusculas };
  const errorCamel = /\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]+)+Error\b/.exec(sinCupones)?.[0];
  if (errorCamel) return { clase: 'codigo_interno', token: errorCamel };
  const sinUrls = sinCupones
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>"']+/gi, '')
    .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g, '');
  const codigoMinusculas = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/.exec(sinUrls)?.[0];
  if (codigoMinusculas) return { clase: 'codigo_interno', token: codigoMinusculas };
  return null;
}

export class SalidaInternaNoPublicableError extends Error {
  constructor(hallazgo) {
    super(`salida_interna_no_publicable:${hallazgo?.clase || 'desconocida'}`);
    this.name = 'SalidaInternaNoPublicableError';
    this.codigo = 'SALIDA_INTERNA_NO_PUBLICABLE';
    this.hallazgo = hallazgo || null;
  }
}

/** Última puerta compartida para cualquier texto que vaya a una persona. */
export function exigirSalidaPublicable(texto) {
  const visible = String(texto ?? '');
  const hallazgo = detectarSalidaInterna(visible);
  if (hallazgo) throw new SalidaInternaNoPublicableError(hallazgo);
  return visible;
}
