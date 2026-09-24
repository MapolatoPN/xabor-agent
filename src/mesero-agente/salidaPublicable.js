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
  return null;
}
