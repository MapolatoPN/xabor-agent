// Secretos que producción exige para arrancar.
//
// SESSION_SECRET firma las sesiones del panel y de él se derivan otras llaves
// (índice del PIN, pase y checadas sin conexión del Xecador, OTP de clientes,
// estado del alta de WhatsApp). Cada uno de esos módulos cae a un valor de
// respaldo escrito en el código si la variable falta. En producción eso no se
// acepta: el predeploy falla y el servidor se niega a arrancar, y Railway
// conserva el deployment anterior.
//
// META_APP_SECRET (Fase 1, bloque 1.3) es la llave con la que Meta firma los
// webhooks de WhatsApp. Sin ella, whatsapp-meta.js acepta cualquier POST como
// si viniera de Meta (comportamiento previo, pensado para desarrollo). En
// producción tampoco se acepta.
//
// Solo se reportan NOMBRES de variables, nunca sus valores.
//
// Recibe el entorno como argumento para poder probarlo con un objeto propio,
// sin tocar process.env (los chequeos del predeploy corren intercalados).
import { esEntornoProductivo } from './entornoProductivo.js';

// El mismo valor de respaldo que usan session.js, pinIndice.js,
// checadorService.js, sinConexionCripto.js, clienteAuth.js y
// embeddedSignupState.js. Se compara para rechazarlo, no para usarlo.
export const SESSION_SECRET_DE_RESPALDO = 'xabor-session-secret-temporal';
export const LONGITUD_MINIMA_RECOMENDADA = 32;

const vacia = (v) => !String(v ?? '').trim();

export function revisarSecretos(env = process.env) {
  const productivo = esEntornoProductivo(env);
  const bloqueantes = [];
  const avisos = [];

  const sesion = env.SESSION_SECRET;
  if (vacia(sesion)) {
    bloqueantes.push('SESSION_SECRET no está definida');
  } else if (String(sesion).trim() === SESSION_SECRET_DE_RESPALDO) {
    bloqueantes.push('SESSION_SECRET tiene el valor de respaldo escrito en el código');
  } else if (String(sesion).length < LONGITUD_MINIMA_RECOMENDADA) {
    avisos.push(`SESSION_SECRET mide menos de ${LONGITUD_MINIMA_RECOMENDADA} caracteres`);
  }

  if (vacia(env.META_APP_SECRET)) {
    bloqueantes.push('META_APP_SECRET no está definida: el webhook de WhatsApp aceptaría avisos sin firma de Meta');
  }

  // «Cancelar pedido» ya no la pide (bloque 1.1); queda para el acceso legado,
  // que en producción está apagado salvo XABOR_ACCESO_LEGADO=permitir.
  if (vacia(env.ADMIN_PASSWORD)) {
    avisos.push('ADMIN_PASSWORD no está definida: si se reactiva el acceso legado, acepta la contraseña de respaldo del código');
  }
  // Rappi: en 'registrar' (por omisión) una firma inválida solo se anota.
  // Se avisa; no se frena, porque un error aquí deja al restaurante sin
  // pedidos de Rappi.
  const firmaRappi = String(env.RAPPI_WEBHOOK_FIRMA || '').trim().toLowerCase();
  if (firmaRappi !== 'exigir') {
    avisos.push('RAPPI_WEBHOOK_FIRMA no está en «exigir»: un aviso de Rappi con firma inválida se procesa igual');
  } else if (vacia(String(env.RAPPI_WEBHOOK_SECRET || '').replace(/,/g, ''))) {
    avisos.push('RAPPI_WEBHOOK_FIRMA está en «exigir» pero RAPPI_WEBHOOK_SECRET no está definida: no se rechaza nada');
  }
  if (vacia(env.INTERNAL_SECRET)) {
    avisos.push('INTERNAL_SECRET no está definida: /internal/analizar-semana queda cerrada');
  }

  return {
    productivo,
    // Fuera de producción no se bloquea ni se avisa: el desarrollo local y las
    // suites arrancan sin estas variables a propósito.
    bloqueantes: productivo ? bloqueantes : [],
    avisos: productivo ? avisos : [],
  };
}

/**
 * Para el arranque del servidor. Devuelve true si puede seguir.
 * `log` y `logError` se inyectan para poder probarlo sin ensuciar la salida.
 */
export function secretosListosParaArrancar(env = process.env, { log = console.warn, logError = console.error } = {}) {
  const { bloqueantes, avisos } = revisarSecretos(env);
  for (const a of avisos) log(`[Secretos] AVISO: ${a}`);
  if (bloqueantes.length) {
    for (const b of bloqueantes) logError(`[Secretos] FALLO: ${b}`);
    logError('[Secretos] Producción no arranca sin sus secretos. Defínelos en Railway y vuelve a desplegar.');
    return false;
  }
  return true;
}
