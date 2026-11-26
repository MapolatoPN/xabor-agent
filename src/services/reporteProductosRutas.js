/**
 * reporteProductosRutas.js — Reportes → Productos y lo nuevo de Ventas
 * (Fase 3, nov-2026). El panel: panel/reportes-productos.js.
 *
 * Solo administradores con el módulo POS (lo mismo que Reportes → Ventas) y
 * solo con la bandera `reportes_productos_v1` encendida en el negocio de la
 * sesión: apagada, las rutas responden 403 y el panel no muestra nada nuevo.
 *
 * El negocio sale SIEMPRE de la sesión. «Todas las sucursales» son las que el
 * MISMO usuario administra (usuario_negocios con rol admin, activo), activas,
 * con POS y con la bandera encendida; una sesión de soporte o el acceso legado
 * solo ven su propio negocio. Una sucursal pedida por id que no esté en esa
 * lista se rechaza con 403, nunca se lee.
 *
 * El consejero de Ventas (/api/reportes/consejero, 25-nov-2026) pide además
 * la bandera `reportes_consejero_v1`. Con `reportes_consejero_v2` encendida en
 * el negocio de la sesión sale la versión corregida (reporteConsejeroV2.js),
 * que sigue el periodo de arriba; sin ella, la versión 1 de siempre.
 */
import { pool, negocioEstaActivo, obtenerEstadoModulo } from './database.js';
import { zonaHorariaNegocio, fechaOperativaHoy } from './cortesCaja.js';
import { rangoDeReporte } from './reporteVentas.js';
import { banderaReportesProductos, filtrosDeReporte, obtenerReporteProductos } from './reporteProductos.js';
import { obtenerDetalleVentas } from './reporteVentasDetalle.js';
import { banderaConsejero, obtenerConsejos } from './reporteConsejero.js';
import { banderaConsejeroV2, obtenerConsejosV2 } from './reporteConsejeroV2.js';

const MODULO_ESTADOS_DISPONIBLES = ['activo', 'configurado'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Las sucursales que esta sesión puede ver en los reportes, la suya primero.
 * sesion: { negocioId, usuarioId, esSoporte }.
 */
export async function sucursalesDelReporte(sesion, { db = pool } = {}) {
  const actual = String(sesion?.negocioId || '').trim();
  if (!actual) { const e = new Error('negocioId requerido'); e.code = 'TENANT_CONTEXT_REQUIRED'; throw e; }
  const { rows: [propio] } = await db.query('SELECT id::text AS id, nombre FROM negocios WHERE id = $1', [actual]);
  const lista = [{ id: actual, nombre: propio?.nombre || '', actual: true }];
  const usuarioId = String(sesion?.usuarioId || '').trim();
  if (sesion?.esSoporte || !UUID.test(usuarioId)) return lista;
  const { rows } = await db.query(
    `SELECT n.id::text AS id, n.nombre
       FROM usuario_negocios un
       JOIN negocios n ON n.id = un.negocio_id
       JOIN usuarios u ON u.id = un.usuario_id
      WHERE un.usuario_id = $1 AND un.activo = true AND n.activo = true AND u.activo = true
        AND un.rol = 'admin' AND n.id <> $2
      ORDER BY n.nombre`, [usuarioId, actual]);
  for (const r of rows) {
    if (!(await negocioEstaActivo(r.id))) continue;
    if (!MODULO_ESTADOS_DISPONIBLES.includes(await obtenerEstadoModulo(r.id, 'pos'))) continue;
    if (!(await banderaReportesProductos(r.id, db))) continue;
    lista.push({ id: r.id, nombre: r.nombre, actual: false });
  }
  return lista;
}

/** Las sucursales pedidas: '' o 'actual' → la de la sesión; 'todas'; o un id de la lista. */
export function elegirSucursales(lista, pedido) {
  const p = typeof pedido === 'string' ? pedido.trim() : '';
  if (!p || p === 'actual') return { elegidas: [lista[0]], modo: 'actual' };
  if (p === 'todas') return { elegidas: lista, modo: lista.length > 1 ? 'todas' : 'actual' };
  const una = lista.find((s) => s.id === p);
  if (!una) return { error: 'No tienes acceso a esa sucursal', http: 403 };
  return { elegidas: [una], modo: una.actual ? 'actual' : 'otra' };
}

const sesionDe = (req) => ({ negocioId: req.negocioId, usuarioId: req.usuarioId ?? req.usuario?.id ?? null, esSoporte: !!req.esSoporte });

async function conZona(sucursales) {
  return Promise.all(sucursales.map(async (s) => ({ ...s, tz: await zonaHorariaNegocio(s.id) })));
}

// El rango se calcula con el «hoy» del negocio de la sesión, como en Ventas.
async function rangoPedido(req) {
  const tz = await zonaHorariaNegocio(req.negocioId);
  const hoy = fechaOperativaHoy(tz);
  const rango = rangoDeReporte({ periodo: req.query.periodo, desde: req.query.desde, hasta: req.query.hasta }, hoy);
  return { tz, hoy, rango };
}

export function registrarRutasReporteProductos(app, { requireAdminSeguro, requireModulo }) {
  const puerta = [requireAdminSeguro, requireModulo('pos')];

  // ¿Se muestran las pestañas nuevas? Y, si sí, qué sucursales puede elegir.
  app.get('/api/reportes/productos/estado', ...puerta, async (req, res) => {
    try {
      const activo = await banderaReportesProductos(req.negocioId);
      if (!activo) return res.json({ activo: false, sucursales: [] });
      const sucursales = await sucursalesDelReporte(sesionDe(req));
      // El consejero (25-nov-2026) tiene su propia bandera, encima de esta, y
      // su versión 2 otra más: con ella el panel le manda el periodo.
      const consejero = await banderaConsejero(req.negocioId);
      const consejeroV2 = consejero && await banderaConsejeroV2(req.negocioId);
      res.json({ activo: true, sucursales, consejero, ...(consejero ? { consejero_v2: consejeroV2 } : {}) });
    } catch (e) {
      console.error('[Reportes] productos/estado:', e.message);
      res.status(500).json({ error: 'No se pudo leer la configuración de reportes' });
    }
  });

  app.get('/api/reportes/productos', ...puerta, async (req, res) => {
    try {
      if (!(await banderaReportesProductos(req.negocioId))) {
        return res.status(403).json({ error: 'El reporte de productos no está activado en este negocio', code: 'REPORTE_APAGADO' });
      }
      const { tz, hoy, rango } = await rangoPedido(req);
      if (rango.error) return res.status(400).json({ error: rango.error });
      const f = filtrosDeReporte(req.query);
      if (f.error) return res.status(400).json({ error: f.error });
      const lista = await sucursalesDelReporte(sesionDe(req));
      const eleccion = elegirSucursales(lista, req.query.sucursal);
      if (eleccion.error) return res.status(eleccion.http).json({ error: eleccion.error, code: 'SUCURSAL_NO_PERMITIDA' });
      const reporte = await obtenerReporteProductos({
        negocios: await conZona(eleccion.elegidas), desde: rango.desde, hasta: rango.hasta,
        filtros: f.filtros, minimo: f.minimo,
      });
      res.json({
        timezone: tz, hoy, sucursal: eleccion.modo,
        sucursales: lista, elegidas: eleccion.elegidas.map((s) => s.id),
        ...reporte,
      });
    } catch (e) {
      console.error('[Reportes] productos:', e.message);
      res.status(500).json({ error: 'No se pudo cargar el reporte de productos' });
    }
  });

  app.get('/api/reportes/ventas/detalle', ...puerta, async (req, res) => {
    try {
      if (!(await banderaReportesProductos(req.negocioId))) {
        return res.status(403).json({ error: 'El detalle de ventas no está activado en este negocio', code: 'REPORTE_APAGADO' });
      }
      const { tz, hoy, rango } = await rangoPedido(req);
      if (rango.error) return res.status(400).json({ error: rango.error });
      const lista = await sucursalesDelReporte(sesionDe(req));
      const eleccion = elegirSucursales(lista, req.query.sucursal);
      if (eleccion.error) return res.status(eleccion.http).json({ error: eleccion.error, code: 'SUCURSAL_NO_PERMITIDA' });
      const detalle = await obtenerDetalleVentas({
        negocios: await conZona(eleccion.elegidas), desde: rango.desde, hasta: rango.hasta,
      });
      res.json({ timezone: tz, hoy, sucursal: eleccion.modo, sucursales: lista, ...detalle });
    } catch (e) {
      console.error('[Reportes] ventas/detalle:', e.message);
      res.status(500).json({ error: 'No se pudo cargar el detalle de ventas' });
    }
  });

  // «Lo que te diría un consejero» (reporteConsejero.js): los últimos 28 días
  // sin contar hoy, con el «hoy» del negocio de la sesión. Solo lectura. Hace
  // falta la bandera de Productos Y la del consejero; «Todas» son las
  // sucursales del reporte que además tienen el consejero encendido.
  app.get('/api/reportes/consejero', ...puerta, async (req, res) => {
    try {
      if (!(await banderaReportesProductos(req.negocioId)) || !(await banderaConsejero(req.negocioId))) {
        return res.status(403).json({ error: 'El consejero no está activado en este negocio', code: 'REPORTE_APAGADO' });
      }
      const tz = await zonaHorariaNegocio(req.negocioId);
      const hoy = fechaOperativaHoy(tz);
      // La versión la decide el negocio de la sesión. En la 2, «Todas» son las
      // sucursales que también la tienen encendida: nunca se mezclan versiones.
      const v2 = await banderaConsejeroV2(req.negocioId);
      let pedido = null;
      if (v2 && [req.query.periodo, req.query.desde, req.query.hasta].some((x) => typeof x === 'string' && x.trim())) {
        const r = rangoDeReporte({ periodo: req.query.periodo, desde: req.query.desde, hasta: req.query.hasta }, hoy);
        if (r.error) return res.status(400).json({ error: r.error });
        pedido = r;
      }
      const delReporte = await sucursalesDelReporte(sesionDe(req));
      const lista = [];
      for (const s of delReporte) {
        if (s.actual || (await banderaConsejero(s.id) && (!v2 || await banderaConsejeroV2(s.id)))) lista.push(s);
      }
      const eleccion = elegirSucursales(lista, req.query.sucursal);
      if (eleccion.error) return res.status(eleccion.http).json({ error: eleccion.error, code: 'SUCURSAL_NO_PERMITIDA' });
      const negocios = await conZona(eleccion.elegidas);
      const consejos = v2 ? await obtenerConsejosV2({ negocios, hoy, pedido }) : await obtenerConsejos({ negocios, hoy });
      res.json({
        timezone: tz, hoy, sucursal: eleccion.modo,
        sucursales: lista, elegidas: eleccion.elegidas.map((s) => s.id),
        ...consejos,
      });
    } catch (e) {
      console.error('[Reportes] consejero:', e.message);
      res.status(500).json({ error: 'No se pudo cargar el consejero' });
    }
  });
}
