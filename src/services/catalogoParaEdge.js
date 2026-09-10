// EL CATÁLOGO QUE EL EDGE NECESITA PARA OPERAR SOLO.
//
// Sin esto no hay modo sin conexión: no se puede pintar la pantalla de captura
// si no se sabe qué productos hay, cuánto cuestan y qué modificadores admiten.
// El Edge guarda esta foto mientras HAY enlace, para poder trabajar cuando no
// lo haya. Se regenera entera cada vez: es pequeña y una foto completa no puede
// quedar a medias como sí puede un diff.
//
// ── Qué NO lleva, y por qué ────────────────────────────────────────────────
// Nada de las cuentas administrativas: ni `email` ni `password_hash`. La foto
// viaja a una PC del restaurante, y esa máquina no tiene por qué poder
// convertirse en un administrador del negocio.
//
// ── El PIN de los meseros: una contrapartida tomada a propósito ────────────
// Sí lleva `pin_hash` de los meseros, y eso merece decirse en voz alta. Es
// scrypt con salt aleatorio (`services/password.js`), no el PIN en claro, pero
// un PIN de 4 dígitos tiene 10 000 combinaciones: quien se lleve el archivo
// puede probarlas todas, aunque scrypt se lo cobre en minutos y no en
// milisegundos.
//
// Se acepta porque la alternativa es peor para el negocio: sin el hash, durante
// un corte no se podría verificar quién abre una mesa, y la responsabilidad
// sobre las ventas de cada mesero —que es justo lo que un restaurante usa para
// cuadrar— se perdería. Además esa PC ya custodia el token de la terminal, las
// impresoras y, en modo offline, las ventas del día. El hash del PIN no es lo
// más valioso que hay ahí.
//
// Lo que sí exige: que `XABOR_TERMINAL_TOKEN` y la carpeta de datos del Edge
// estén tan protegidos como una caja registradora.
import { pool } from './database.js';
import { obtenerMenuCompleto } from './database.js';

export const VERSION_CATALOGO = 1;

function exigirNegocio(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    const e = new Error('catalogoParaEdge: negocioId requerido');
    e.code = 'TENANT_CONTEXT_REQUIRED';
    throw e;
  }
  return negocioId.trim();
}

/**
 * La foto completa para un negocio.
 *
 * @param {object} opts.incluirPines  false deja fuera los `pin_hash`. El Edge
 *        entonces no puede validar PIN sin enlace: quien lo apague acepta
 *        operar sin esa comprobación durante el corte.
 */
export async function construirCatalogoParaEdge(negocioId, { incluirPines = true } = {}) {
  const nid = exigirNegocio(negocioId);

  const [menu, meserosQ, mesasQ, metodosQ] = await Promise.all([
    obtenerMenuCompleto(nid),
    // Solo miembros ACTIVOS de ESTE negocio. Un usuario dado de baja no puede
    // seguir abriendo mesas porque su hash quedó en una foto vieja.
    pool.query(
      `SELECT u.id, u.nombre, un.rol, u.pin_hash
         FROM usuarios u
         JOIN usuario_negocios un ON un.usuario_id = u.id AND un.negocio_id = $1
        WHERE un.activo = true AND u.activo = true AND u.pin_hash IS NOT NULL
        ORDER BY u.nombre`,
      [nid]
    ),
    pool.query(
      `SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = 'restaurante_num_mesas'`,
      [nid]
    ),
    pool.query(
      `SELECT tipo FROM metodos_pago
        WHERE negocio_id = $1 AND habilitado = true ORDER BY orden, tipo`,
      [nid]
    ).catch(() => ({ rows: [] })),
  ]);

  const numMesas = parseInt(mesasQ.rows[0]?.valor, 10);

  return {
    version: VERSION_CATALOGO,
    negocioId: nid,
    generadoAt: new Date().toISOString(),
    // El número de mesas vive en `configuracion`, no en una tabla: una mesa sin
    // cuenta abierta ES una mesa libre. El Edge necesita el número para pintar
    // el tablero.
    numMesas: Number.isInteger(numMesas) && numMesas > 0 ? numMesas : 12,
    metodosPago: metodosQ.rows.map((m) => m.tipo),
    meseros: meserosQ.rows.map((u) => ({
      id: u.id, nombre: u.nombre, rol: u.rol,
      ...(incluirPines ? { pin_hash: u.pin_hash } : {}),
    })),
    // Se reusa `obtenerMenuCompleto` a propósito: si el Edge armara el menú con
    // otra consulta, tendríamos dos definiciones del catálogo y offline vería
    // cosas distintas que online. Ya pasó con la cardinalidad de los grupos.
    menu: (menu || []).map((cat) => ({
      id: cat.id, nombre: cat.nombre, orden: cat.orden,
      productos: (cat.productos || [])
        .filter((p) => p.disponible !== false && !p.agotado)
        .map((p) => ({
          id: p.id, nombre: p.nombre, precio: Number(p.precio),
          categoria_id: cat.id,
          modificadores: (p.modificadores || []).map((g) => ({
            id: g.id, nombre: g.nombre,
            requerido: g.requerido, minimo: g.minimo, maximo: g.maximo,
            opciones: (g.opciones || [])
              .filter((o) => o.disponible !== false)
              .map((o) => ({ id: o.id, nombre: o.nombre, precio_extra: Number(o.precio_extra || 0) })),
          })),
        })),
    })),
  };
}

/**
 * ¿Esta foto sirve para operar? Se comprueba ANTES de guardarla en el Edge:
 * una foto vacía o corrupta reemplazando a una buena dejaría al restaurante
 * sin poder capturar justo cuando más falta hace.
 */
export function catalogoUtilizable(catalogo) {
  if (!catalogo || typeof catalogo !== 'object') return { ok: false, motivo: 'catalogo_ausente' };
  if (catalogo.version !== VERSION_CATALOGO) return { ok: false, motivo: 'version_desconocida' };
  if (!catalogo.negocioId) return { ok: false, motivo: 'sin_negocio' };
  if (!Array.isArray(catalogo.menu)) return { ok: false, motivo: 'menu_invalido' };
  const productos = catalogo.menu.reduce((n, c) => n + (c.productos?.length || 0), 0);
  if (!productos) return { ok: false, motivo: 'sin_productos' };
  if (!Array.isArray(catalogo.meseros) || !catalogo.meseros.length) {
    return { ok: false, motivo: 'sin_meseros' };
  }
  return { ok: true, productos, meseros: catalogo.meseros.length };
}
