/**
 * lineasEstructuradasRutas.js — Menú → Rappi → «Opciones sin clasificar»
 * (panel/rappi-sin-clasificar.js), Fase 2.2.
 *
 * Lo que de Rappi no se pudo emparejar con el menú de Xabor (un producto o
 * una opción) se lista aquí con cuántas veces salió, y el administrador elige
 * a qué corresponde. El emparejamiento se guarda por negocio
 * (rappi_emparejamientos) y rehace el registro de líneas de los pedidos de
 * Rappi afectados. La venta no se toca: solo el registro aparte.
 *
 * Solo administradores (requireAdminSeguro): test/fase-permisos-operador.mjs
 * vigila que el operador no llegue. El negocio sale SIEMPRE de la sesión,
 * nunca del cuerpo ni de la dirección; cada producto, grupo y opción que se
 * elige se comprueba contra el menú de ESE negocio.
 */
import { pool } from './database.js';
import { CANAL_RAPPI, claveEmparejamiento, normalizarTexto } from './lineasEstructuradas.js';
import { banderaEncendida, procesarNegocio, hayTabla } from './lineasEstructuradasProceso.js';

export class ErrorEmparejamiento extends Error {
  constructor(mensaje, codigo, http = 400) { super(mensaje); this.codigo = codigo; this.http = http; }
}

const LIMITE_FILAS = 200;

function responderError(res, e, que) {
  if (e instanceof ErrorEmparejamiento) return res.status(e.http).json({ error: e.message, codigo: e.codigo });
  console.error(`[Lineas] ${que}:`, e.message);
  return res.status(500).json({ error: 'No pudimos completar esto. Recarga la página e intenta otra vez.' });
}

const quienEs = (req) => String(req.usuarioId ?? req.usuario?.id ?? '') || null;

export async function sinClasificarRappi(negocioId, { db = pool } = {}) {
  const activo = await banderaEncendida(negocioId, db);
  const vacio = { activo, productos: [], opciones: [], emparejamientos: [], menu: [] };
  if (!activo || !(await hayTabla(db, 'pedido_lineas'))) return vacio;
  const { rows: productos } = await db.query(
    `SELECT l.nombre AS producto_rappi, COUNT(*)::int AS veces
       FROM pedido_lineas l
      WHERE l.negocio_id = $1 AND l.canal = $2 AND l.estado = 'sin_estructurar'
      GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${LIMITE_FILAS}`, [negocioId, CANAL_RAPPI]);
  const { rows: opciones } = await db.query(
    `SELECT l.nombre AS producto_rappi, l.producto_id, m.opcion AS opcion_rappi, COUNT(*)::int AS veces
       FROM pedido_linea_modificadores m
       JOIN pedido_lineas l ON l.id = m.linea_id AND l.negocio_id = m.negocio_id
      WHERE m.negocio_id = $1 AND l.canal = $2 AND NOT m.clasificado AND l.producto_id IS NOT NULL
      GROUP BY 1, 2, 3 ORDER BY 4 DESC, 1, 3 LIMIT ${LIMITE_FILAS}`, [negocioId, CANAL_RAPPI]);
  const { rows: menu } = await db.query(
    `SELECT p.id, p.nombre FROM menu_productos p WHERE p.negocio_id = $1 ORDER BY p.nombre`, [negocioId]);
  const ids = [...new Set(opciones.map((o) => o.producto_id))];
  const { rows: grupos } = ids.length ? await db.query(
    `SELECT g.producto_id, g.id AS grupo_id, g.nombre AS grupo, o.id AS opcion_id, o.nombre AS opcion
       FROM menu_modificadores_grupos g
       JOIN menu_modificadores_opciones o ON o.grupo_id = g.id AND o.negocio_id = g.negocio_id
      WHERE g.negocio_id = $1 AND g.producto_id = ANY($2::int[])
      ORDER BY g.producto_id, g.orden, g.id, o.orden, o.id`, [negocioId, ids]) : { rows: [] };
  const opcionesDe = new Map();
  for (const g of grupos) {
    if (!opcionesDe.has(g.producto_id)) opcionesDe.set(g.producto_id, []);
    opcionesDe.get(g.producto_id).push({ opcion_id: g.opcion_id, texto: `${g.grupo}: ${g.opcion}` });
  }
  const nombreDe = new Map(menu.map((p) => [p.id, p.nombre]));
  const { rows: emparejamientos } = await db.query(
    `SELECT e.id, e.producto_rappi, e.opcion_rappi, e.producto_id, p.nombre AS producto,
            g.nombre AS grupo, o.nombre AS opcion, e.creado_at
       FROM rappi_emparejamientos e
       JOIN menu_productos p ON p.id = e.producto_id AND p.negocio_id = e.negocio_id
       LEFT JOIN menu_modificadores_grupos g ON g.id = e.grupo_id AND g.negocio_id = e.negocio_id
       LEFT JOIN menu_modificadores_opciones o ON o.id = e.opcion_id AND o.negocio_id = e.negocio_id
      WHERE e.negocio_id = $1 ORDER BY e.creado_at DESC LIMIT ${LIMITE_FILAS}`, [negocioId]);
  return {
    activo,
    productos,
    opciones: opciones.map((o) => ({ ...o, producto: nombreDe.get(o.producto_id) || null, elegibles: opcionesDe.get(o.producto_id) || [] })),
    emparejamientos,
    menu,
  };
}

// Los pedidos de Rappi de ESTE negocio con ese producto de Rappi: son los que
// cambian con un emparejamiento.
async function foliosAfectados(db, negocioId, productoRappi) {
  const clave = normalizarTexto(productoRappi);
  const { rows } = await db.query(
    `SELECT DISTINCT folio, nombre FROM pedido_lineas WHERE negocio_id = $1 AND canal = $2`, [negocioId, CANAL_RAPPI]);
  return [...new Set(rows.filter((r) => normalizarTexto(r.nombre) === clave).map((r) => r.folio))];
}

async function rehacer(db, negocioId, productoRappi) {
  if (!(await banderaEncendida(negocioId, db))) return 0;
  const folios = await foliosAfectados(db, negocioId, productoRappi);
  if (!folios.length) return 0;
  const r = await procesarNegocio(negocioId, { folios, todas: true, escribir: true, db });
  return r.escritos;
}

export async function guardarEmparejamiento(negocioId, { productoRappi, opcionRappi, productoId, opcionId }, quien, { db = pool } = {}) {
  const producto = String(productoRappi ?? '').trim();
  const opcion = String(opcionRappi ?? '').trim();
  if (!producto || producto.length > 200 || opcion.length > 200) {
    throw new ErrorEmparejamiento('Falta el producto de Rappi', 'DATOS_INVALIDOS');
  }
  const pid = Number(productoId);
  if (!Number.isInteger(pid) || pid < 1) throw new ErrorEmparejamiento('Elige el producto del menú', 'DATOS_INVALIDOS');
  const { rows: [p] } = await db.query('SELECT id FROM menu_productos WHERE id = $1 AND negocio_id = $2', [pid, negocioId]);
  if (!p) throw new ErrorEmparejamiento('Ese producto no es del menú de este negocio', 'PRODUCTO_AJENO', 404);
  let grupoId = null;
  let oid = null;
  if (opcion) {
    oid = Number(opcionId);
    if (!Number.isInteger(oid) || oid < 1) throw new ErrorEmparejamiento('Elige la opción del menú', 'DATOS_INVALIDOS');
    const { rows: [o] } = await db.query(
      `SELECT o.id, o.grupo_id FROM menu_modificadores_opciones o
         JOIN menu_modificadores_grupos g ON g.id = o.grupo_id AND g.negocio_id = o.negocio_id
        WHERE o.id = $1 AND o.negocio_id = $2 AND g.producto_id = $3`, [oid, negocioId, pid]);
    if (!o) throw new ErrorEmparejamiento('Esa opción no es de ese producto', 'OPCION_AJENA', 404);
    grupoId = o.grupo_id;
  }
  // Por separado (no partiendo la clave por «|»: un nombre podría traerlo).
  const claveProducto = normalizarTexto(producto);
  const claveOpcion = normalizarTexto(opcion);
  await db.query(
    `INSERT INTO rappi_emparejamientos (negocio_id, producto_rappi, opcion_rappi, producto_id, grupo_id, opcion_id, creado_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (negocio_id, producto_rappi, opcion_rappi)
     DO UPDATE SET producto_id = EXCLUDED.producto_id, grupo_id = EXCLUDED.grupo_id, opcion_id = EXCLUDED.opcion_id,
                   creado_por = EXCLUDED.creado_por, creado_at = now()`,
    [negocioId, claveProducto, claveOpcion, pid, grupoId, oid, quien]);
  return { rehechos: await rehacer(db, negocioId, producto) };
}

export async function borrarEmparejamiento(negocioId, id, { db = pool } = {}) {
  const eid = Number(id);
  if (!Number.isInteger(eid) || eid < 1) throw new ErrorEmparejamiento('Emparejamiento inválido', 'DATOS_INVALIDOS');
  const { rows: [e] } = await db.query(
    'DELETE FROM rappi_emparejamientos WHERE id = $1 AND negocio_id = $2 RETURNING producto_rappi', [eid, negocioId]);
  if (!e) throw new ErrorEmparejamiento('No existe ese emparejamiento', 'NO_ENCONTRADO', 404);
  return { rehechos: await rehacer(db, negocioId, e.producto_rappi) };
}

export function registrarRutasLineasEstructuradas(app, { requireAdminSeguro, servicio = {} }) {
  if (typeof requireAdminSeguro !== 'function') throw new Error('registrarRutasLineasEstructuradas: falta requireAdminSeguro');
  const s = { leer: sinClasificarRappi, guardar: guardarEmparejamiento, borrar: borrarEmparejamiento, ...servicio };

  app.get('/api/admin/lineas/rappi/sin-clasificar', requireAdminSeguro, async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      res.json(await s.leer(req.negocioId));
    } catch (e) { responderError(res, e, 'leer opciones de Rappi sin clasificar'); }
  });

  app.put('/api/admin/lineas/rappi/emparejamientos', requireAdminSeguro, async (req, res) => {
    try {
      const b = req.body || {};
      const r = await s.guardar(req.negocioId, {
        productoRappi: b.producto_rappi, opcionRappi: b.opcion_rappi, productoId: b.producto_id, opcionId: b.opcion_id,
      }, quienEs(req));
      res.json({ ok: true, ...r });
    } catch (e) { responderError(res, e, 'guardar emparejamiento de Rappi'); }
  });

  app.delete('/api/admin/lineas/rappi/emparejamientos/:id', requireAdminSeguro, async (req, res) => {
    try {
      res.json({ ok: true, ...(await s.borrar(req.negocioId, req.params.id)) });
    } catch (e) { responderError(res, e, 'borrar emparejamiento de Rappi'); }
  });
}
