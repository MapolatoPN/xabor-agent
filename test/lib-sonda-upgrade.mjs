// Sonda de PRUEBAS de test/fase-upgrade-errores.mjs, cargada SOLO en el
// proceso del servidor con NODE_OPTIONS=--import. Nada de src/ la importa: en
// producción no existe.
//
// Hace fallar la consulta de autorización del upgrade —la membresía del panel
// o el privilegio de Superadmin— para dos usuarios de prueba. Falla DESPUÉS de
// que la consulta real terminó, así un bloqueo de la prueba sobre la tabla
// puede sostener la espera y el fallo llega cuando el cliente ya se fue.
//   - USUARIO_FALLA_BASE: un error normal de la base. La capa de datos lo
//     atrapa y falla cerrado (sin membresía, sin privilegio): 403.
//   - USUARIO_FALLA_ESCAPA: un error cuyo .message lanza al leerse. La capa de
//     datos lo lee en su catch, así que la excepción ESCAPA de ella: es el
//     «error inesperado» que solo el catch del upgrade puede contener (503).
import { createRequire } from 'node:module';

export const USUARIO_FALLA_BASE = '00000000-0000-4000-8000-00000000db01';
export const USUARIO_FALLA_ESCAPA = '00000000-0000-4000-8000-00000000db02';
// esSuperadmin une con usuarios desde la 116 (la cuenta tiene que seguir
// activa); se aceptan las dos formas de la consulta.
const CONSULTA_AUTORIZACION = /sesiones_invalidas_antes[\s\S]*FROM usuario_negocios|FROM administradores_plataforma(?: ap JOIN usuarios u ON u\.id = ap\.usuario_id)?\s+WHERE (?:ap\.)?usuario_id/;

const require = createRequire(import.meta.url);
const pg = require('pg');
const consultaOriginal = pg.Client.prototype.query;
pg.Client.prototype.query = function consultaConFalla(config, valores, alTerminar) {
  const sql = typeof config === 'string' ? config : (config?.text ?? '');
  const usuario = Array.isArray(valores) ? valores[0] : undefined;
  if (typeof alTerminar === 'function' && CONSULTA_AUTORIZACION.test(sql)
      && (usuario === USUARIO_FALLA_BASE || usuario === USUARIO_FALLA_ESCAPA)) {
    return consultaOriginal.call(this, config, valores, () => {
      const e = new Error('falla de base inyectada por la sonda');
      if (usuario === USUARIO_FALLA_ESCAPA) {
        Object.defineProperty(e, 'message', { get() { throw new TypeError('falla inyectada que escapa de la capa de datos'); } });
      }
      alTerminar(e);
    });
  }
  return consultaOriginal.apply(this, arguments);
};

process.stdout.write('[SONDA-UPGRADE] cargada en el servidor\n');
