// ─── LA LLAMADA AL MODELO, PARA EL AGENTE ─────────────────────────────────
//
// Cliente propio y política de reintento propia, a propósito, en vez de
// reutilizar la de `brain.js`. Dos razones y las dos son de fondo:
//
//   · `brain.js` es un componente PROTEGIDO y el camino único a la respuesta
//     del cliente hoy. Exportarle algo para que lo use un experimento es
//     empezar a tocarlo por la puerta de atrás.
//   · la política no debe ser la misma. `brain.js` hace UNA llamada por turno
//     con un cliente esperando; el agente hace varias, y un reintento largo en
//     la tercera iteración gasta el presupuesto de tiempo del turno entero.
//     Aquí los reintentos son más cortos y el tope lo pone el bucle.
//
// El resto —la llave, el proveedor— sí se comparte: `getIntegracion` es el
// mismo sitio donde ya vive la credencial del negocio.
import Anthropic from '@anthropic-ai/sdk';

// ── La llave se lee TARDE, y por eso con import dinámico ─────────────────
//
// `getIntegracion` vive en `server.js`, que además de exportarla ARRANCA la
// aplicación. Importarlo arriba ataría este módulo —y a cualquier prueba que
// lo toque— al servidor entero. Se resuelve en la primera llamada real, que
// siempre ocurre con el servidor ya en pie, y si no está se cae al entorno.
let _leerIntegracion = null;
async function claveDelProveedor() {
  if (_leerIntegracion === null) {
    try { _leerIntegracion = (await import('../server.js')).getIntegracion; }
    catch { _leerIntegracion = false; }
  }
  return (_leerIntegracion && _leerIntegracion('anthropic_api_key')) || process.env.ANTHROPIC_API_KEY;
}

// El modelo del agente NO es el de `brain.js`. El bucle de herramientas pide
// decidir qué llamar, leer resultados estructurados y corregirse; ahí la
// capacidad se nota más que la latencia, y una herramienta mal elegida cuesta
// una iteración entera. Se puede cambiar por entorno sin tocar código.
export const MODELO = process.env.MESERO_AGENTE_MODELO || 'claude-sonnet-5';

let _cliente = null;
let _clave = null;

export async function clienteDelAgente() {
  const clave = await claveDelProveedor();
  if (!_cliente || _clave !== clave) {
    _cliente = new Anthropic({ apiKey: clave, timeout: 15000, maxRetries: 0 });
    _clave = clave;
  }
  return _cliente;
}

const esSobrecarga = (e) => e?.status === 529 || e?.status === 429
  || /overloaded|rate.?limit/i.test(String(e?.message || ''));

/**
 * Una llamada, con un reintento corto si el proveedor está saturado.
 *
 * UN solo reintento, y de 300 ms: el bucle del agente puede hacer seis
 * llamadas y tiene su propio tope de tiempo. Dos reintentos largos por llamada
 * convertirían un pico del proveedor en un turno que se escala por reloj.
 */
export async function llamarModeloDelAgente(params) {
  const conModelo = { ...params, model: params.model || MODELO };
  const cliente = await clienteDelAgente();
  try {
    return await cliente.messages.create(conModelo);
  } catch (e) {
    if (!esSobrecarga(e)) throw e;
    console.warn(`[AGENTE-LLM] status=${e?.status || '529'} — un reintento corto`);
    await new Promise((r) => setTimeout(r, 300 + Math.floor(Math.random() * 150)));
    return cliente.messages.create(conModelo);
  }
}
