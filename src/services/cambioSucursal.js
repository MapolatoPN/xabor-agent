// ─── Cambio de sucursal en la misma sesión (21-nov-2026) ───────────────────
// Pedido de Mario: una cuenta que pertenece a varias sucursales (el dueño)
// elige la sucursal al entrar --eso ya existía en el login-- y, ya dentro del
// panel, la cambia con un botón sin volver a escribir la contraseña. Las
// cuentas de una sola sucursal (las encargadas) no ven el botón.
//
// Quién puede ir a qué sucursal lo deciden SOLO sus membresías: la misma
// regla del login (usuario_negocios activa, negocio activo) y además usuario
// activo y rol de panel (admin o staff). Nada que mande el navegador amplía
// esa lista; el negocio elegido se valida contra ella en el servidor.
//
// El riesgo nuevo que trae el botón es el de las pestañas: la sesión es UNA
// cookie por navegador, así que al cambiar en una pestaña las demás pestañas
// del mismo navegador quedan hablando con la sucursal nueva mientras siguen
// mostrando la anterior (una venta capturada en «Obispado» caería en Acuña).
// Dos defensas:
//   - el panel se avisa entre pestañas y se recarga (panel/cambio-sucursal.js);
//   - el candado de abajo: el panel manda en X-Xabor-Negocio el negocio con el
//     que se cargó, y si la cookie ya es de otro, la petición NO se atiende
//     (409 SUCURSAL_CAMBIADA) y el panel se recarga. Solo puede rechazar,
//     nunca autoriza nada.
import { pool } from './database.js';
import { etiquetasSucursal } from './pedidosTemporada.js';

export const CABECERA_NEGOCIO = 'x-xabor-negocio';
export const CODIGO_SUCURSAL_CAMBIADA = 'SUCURSAL_CAMBIADA';
export const MENSAJE_SUCURSAL_CAMBIADA = 'La sesión cambió de sucursal en otra pestaña de este navegador. Recarga el panel para seguir.';
const ROLES_DE_PANEL = ['admin', 'staff'];

/**
 * Las sucursales a las que puede ir el usuario, ordenadas por nombre, con la
 * etiqueta corta («Mapolato Obispado» → «Obispado») y su rol en cada una.
 * Sin usuario, o con el usuario apagado, la lista sale vacía.
 */
export async function sucursalesParaCambio(usuarioId, negocioActual, { db = pool } = {}) {
  if (!usuarioId) return [];
  const { rows } = await db.query(
    `SELECT n.id, n.nombre, un.rol
       FROM usuario_negocios un
       JOIN negocios n ON n.id = un.negocio_id
       JOIN usuarios u ON u.id = un.usuario_id
      WHERE un.usuario_id = $1 AND un.activo = true AND n.activo = true AND u.activo = true
        AND un.rol = ANY($2::text[])`,
    [usuarioId, ROLES_DE_PANEL]);
  rows.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  const etiquetas = etiquetasSucursal(rows.map((r) => r.nombre));
  return rows.map((r, i) => ({
    negocioId: r.id,
    nombre: r.nombre,
    etiqueta: etiquetas[i],
    rol: r.rol,
    actual: r.id === negocioActual,
  }));
}

/**
 * Middleware global (va antes de todas las rutas). Si la petición trae la
 * cabecera del panel y la cookie de sesión válida es de OTRO negocio, responde
 * 409. Sin cabecera, sin cookie o con una cookie inválida, sigue de largo: la
 * ruta responde lo de siempre (401, 403…).
 */
export function crearCandadoSucursal({ leerToken, verificarToken }) {
  return function candadoSucursal(req, res, next) {
    const esperado = req.headers[CABECERA_NEGOCIO];
    if (typeof esperado !== 'string' || !esperado) return next();
    const payload = verificarToken(leerToken(req));
    if (payload && payload.negocioId !== esperado) {
      return res.status(409).json({ error: MENSAJE_SUCURSAL_CAMBIADA, code: CODIGO_SUCURSAL_CAMBIADA });
    }
    next();
  };
}
