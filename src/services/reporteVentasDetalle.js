// Reportes → Ventas, lo que agrega la Fase 3 (3.8): venta por forma de pago,
// por usuario y por sucursal lado a lado. Detrás de la misma bandera que el
// reporte de Productos (reportes_productos_v1); sin ella, Ventas queda
// exactamente como estaba (este archivo ni se consulta).
//
// La definición de venta es la de Ventas: las cifras de cada sucursal salen de
// construirReporteVentas (reporteVentas.js) sobre las mismas filas, así que
// su venta neta es la de su pestaña Ventas al centavo.
//
// Forma de pago: con las MISMAS reglas que la Caja (cortesCaja.js):
// clasificarFormaPago + plataformaDePedido + partesDelCobro, con la lista de
// formas de cobro del negocio. Un cobro mixto se reparte entre sus partes.
// Σ por forma de pago = venta neta.
//
// Usuario: hoy solo las mesas registran quién vendió (el mesero de la cuenta
// y quién la cerró). Lo demás sale como «Sin registrar» (decisión del dueño,
// 24-nov-2026: la Fase 4.1 lo completa). Σ por mesero + sin registrar = venta
// neta.
import { pool } from './database.js';
import { rangoUtcDeFecha, esFechaValida, plataformaDePedido, partesDelCobro, claseDeVenta } from './cortesCaja.js';
import { catalogoFormasCobro } from './formasCobro.js';
import { esZonaValida } from './zonaHoraria.js';
import { clasificarPedido, importesDePedido, canalDeVenta, construirReporteVentas, porcentajes } from './reporteVentas.js';

const pesos = (c) => Math.round(c) / 100;
const centavos = (n) => Math.round((Number(n) || 0) * 100);

export const CLASES_PAGO = Object.freeze([
  Object.freeze({ clase: 'efectivo', etiqueta: 'Efectivo' }),
  Object.freeze({ clase: 'tarjeta', etiqueta: 'Tarjeta (terminal)' }),
  Object.freeze({ clase: 'enlace', etiqueta: 'Clip / enlace de pago' }),
  Object.freeze({ clase: 'plataformas', etiqueta: 'Plataformas' }),
  Object.freeze({ clase: 'dolares', etiqueta: 'Dólares (en pesos)' }),
  Object.freeze({ clase: 'otros', etiqueta: 'Otros' }),
]);
const ETIQUETA_CLASE = Object.fromEntries(CLASES_PAGO.map((c) => [c.clase, c.etiqueta]));

function formaVisible(datos) {
  const f = String(datos?.forma_pago ?? '').trim();
  if (f) return f;
  if (String(datos?.canal || '') === 'rappi') return 'rappi';
  return 'no especificado';
}

/**
 * Venta por forma de pago. filas: [{ folio, estado, datos }];
 * catalogo: la lista de formas de cobro del negocio (catalogoFormasCobro).
 */
export function ventaPorFormaDePago(filas = [], catalogo = null) {
  const porClase = new Map(CLASES_PAGO.map((c) => [c.clase, { venta: 0, folios: new Set() }]));
  const detalle = new Map(); // forma escrita (sin mayúsculas) → { formas, clase, pedidos, venta }
  let neta = 0, tickets = 0, mixtos = 0;
  for (const fila of filas) {
    const datos = fila?.datos && typeof fila.datos === 'object' ? fila.datos : {};
    if (clasificarPedido({ folio: fila?.folio, estado: fila?.estado, datos }) !== 'venta') continue;
    const total = importesDePedido(datos).neta;
    neta += total; tickets++;
    const plataforma = plataformaDePedido(datos, catalogo);
    const partes = partesDelCobro(datos, total / 100, catalogo);
    let clasesDeEsta;
    if (partes) {
      mixtos++;
      // Las partes vienen en pesos: se pasan a centavos y lo que el redondeo
      // deje (un centavo) va a la parte mayor, para que Σ = total exacto.
      const enCentavos = partes.map((p) => ({ clase: p.clase in ETIQUETA_CLASE ? p.clase : 'otros', monto: centavos(p.monto) }));
      const dif = total - enCentavos.reduce((s, p) => s + p.monto, 0);
      if (dif) enCentavos.reduce((a, b) => (b.monto > a.monto ? b : a)).monto += dif;
      clasesDeEsta = enCentavos;
    } else {
      const clase = claseDeVenta(datos.forma_pago, plataforma, catalogo);
      clasesDeEsta = [{ clase: clase in ETIQUETA_CLASE ? clase : 'otros', monto: total }];
    }
    for (const p of clasesDeEsta) {
      const c = porClase.get(p.clase);
      c.venta += p.monto; c.folios.add(fila.folio);
    }
    const forma = formaVisible(datos);
    const clave = forma.toLowerCase();
    const d = detalle.get(clave) || { formas: new Map(), clase: partes ? 'mixto' : clasesDeEsta[0].clase, pedidos: 0, venta: 0 };
    d.formas.set(forma, (d.formas.get(forma) || 0) + 1);
    d.pedidos++; d.venta += total;
    detalle.set(clave, d);
  }
  const clases = CLASES_PAGO.map((c) => ({ ...c, ...porClase.get(c.clase) })).filter((c) => c.folios.size || c.venta);
  const pct = porcentajes(clases.map((c) => Math.max(0, c.venta)));
  const filasDetalle = [...detalle.values()].sort((a, b) => b.venta - a.venta || b.pedidos - a.pedidos);
  return {
    venta_neta: pesos(neta),
    tickets,
    cobros_mixtos: mixtos,
    clases: clases.map((c, i) => ({ clase: c.clase, etiqueta: c.etiqueta, pedidos: c.folios.size, venta: pesos(c.venta), pct_venta: pct[i] })),
    detalle: filasDetalle.map((d) => ({
      forma: [...d.formas.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0],
      clase: d.clase, etiqueta_clase: d.clase === 'mixto' ? 'Repartido entre sus partes' : ETIQUETA_CLASE[d.clase],
      pedidos: d.pedidos, venta: pesos(d.venta),
    })),
  };
}

/**
 * Venta por usuario. cuentas: Map cuenta_id → { mesero_id, mesero, cerro_id, cerro }
 * (restaurante_cuentas del MISMO negocio).
 */
export function ventaPorUsuario(filas = [], cuentas = new Map()) {
  const usuarios = new Map();
  const sin = { tickets: 0, venta: 0 };
  const mesasSinCierre = { tickets: 0, venta: 0 };
  let neta = 0;
  const fila = (clave, nombre) => {
    let u = usuarios.get(clave);
    if (!u) { u = { clave, nombre, atendidas: { tickets: 0, venta: 0 }, cerradas: { tickets: 0, venta: 0 } }; usuarios.set(clave, u); }
    if (!u.nombre && nombre) u.nombre = nombre;
    return u;
  };
  for (const f of filas) {
    const datos = f?.datos && typeof f.datos === 'object' ? f.datos : {};
    if (clasificarPedido({ folio: f?.folio, estado: f?.estado, datos }) !== 'venta') continue;
    const total = importesDePedido(datos).neta;
    neta += total;
    if (canalDeVenta(datos).clave !== 'restaurante') { sin.tickets++; sin.venta += total; continue; }
    const cuenta = cuentas.get(String(datos.cuenta_id || ''));
    const meseroNombre = cuenta?.mesero || (typeof datos.mesero === 'string' ? datos.mesero.trim() : '') || null;
    const meseroClave = cuenta?.mesero_id ? `u:${cuenta.mesero_id}` : (meseroNombre ? `n:${meseroNombre.toLowerCase()}` : null);
    if (meseroClave) {
      const u = fila(meseroClave, meseroNombre);
      u.atendidas.tickets++; u.atendidas.venta += total;
    } else { sin.tickets++; sin.venta += total; }
    if (cuenta?.cerro_id) {
      const u = fila(`u:${cuenta.cerro_id}`, cuenta.cerro || null);
      u.cerradas.tickets++; u.cerradas.venta += total;
    } else { mesasSinCierre.tickets++; mesasSinCierre.venta += total; }
  }
  const lista = [...usuarios.values()]
    .sort((a, b) => b.atendidas.venta - a.atendidas.venta || b.cerradas.venta - a.cerradas.venta
      || String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es'));
  const pct = porcentajes([...lista.map((u) => Math.max(0, u.atendidas.venta)), Math.max(0, sin.venta)]);
  return {
    venta_neta: pesos(neta),
    usuarios: lista.map((u, i) => ({
      clave: u.clave, nombre: u.nombre || 'Usuario sin nombre',
      atendidas: { tickets: u.atendidas.tickets, venta: pesos(u.atendidas.venta), pct_venta: pct[i] },
      cerradas: { tickets: u.cerradas.tickets, venta: pesos(u.cerradas.venta) },
    })),
    sin_registrar: { tickets: sin.tickets, venta: pesos(sin.venta), pct_venta: pct[lista.length] },
    mesas_sin_quien_cerro: { tickets: mesasSinCierre.tickets, venta: pesos(mesasSinCierre.venta) },
  };
}

/** Lo que se muestra de una sucursal: las cifras de Ventas más pago y usuario. */
export function detalleDeSucursal(negocio, filas, { catalogo = null, cuentas = new Map() } = {}) {
  const r = construirReporteVentas(filas, null, {});
  return {
    negocio,
    resumen: r.resumen,
    desglose: {
      venta_bruta: r.desglose.venta_bruta, descuentos: r.desglose.descuentos,
      envios_cobrados: r.desglose.envios_cobrados, venta_neta: r.desglose.venta_neta,
      propinas: r.desglose.propinas,
    },
    por_canal: r.por_canal,
    por_forma_pago: ventaPorFormaDePago(filas, catalogo),
    por_usuario: ventaPorUsuario(filas, cuentas),
  };
}

/** Suma de las sucursales, para la columna «Todas». */
export function sumarSucursales(detalles = []) {
  const s = { venta_neta: 0, num_pedidos: 0, venta_bruta: 0, descuentos: 0, envios_cobrados: 0 };
  const clases = new Map(CLASES_PAGO.map((c) => [c.clase, { pedidos: 0, venta: 0 }]));
  for (const d of detalles) {
    s.venta_neta += centavos(d.desglose.venta_neta);
    s.num_pedidos += d.resumen.num_pedidos;
    s.venta_bruta += centavos(d.desglose.venta_bruta);
    s.descuentos += centavos(d.desglose.descuentos);
    s.envios_cobrados += centavos(d.desglose.envios_cobrados);
    for (const c of d.por_forma_pago.clases) {
      const x = clases.get(c.clase);
      x.pedidos += c.pedidos; x.venta += centavos(c.venta);
    }
  }
  return {
    venta_neta: pesos(s.venta_neta), num_pedidos: s.num_pedidos,
    promedio: s.num_pedidos ? pesos(s.venta_neta / s.num_pedidos) : 0,
    venta_bruta: pesos(s.venta_bruta), descuentos: pesos(s.descuentos), envios_cobrados: pesos(s.envios_cobrados),
    por_forma_pago: CLASES_PAGO.map((c) => ({ ...c, pedidos: clases.get(c.clase).pedidos, venta: pesos(clases.get(c.clase).venta) }))
      .filter((c) => c.pedidos || c.venta),
  };
}

// ─── Lectura ────────────────────────────────────────────────────────────────

function exigirNegocio(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    const e = new Error('negocioId requerido'); e.code = 'TENANT_CONTEXT_REQUIRED'; throw e;
  }
  return negocioId.trim();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Los campos que usan la definición de venta, la Caja (forma de pago, cobro
// mixto, plataformas) y la mesa (cuenta y mesero). Del MISMO negocio.
async function leerVentasDetalle(db, nid, desde, hasta, tz) {
  const inicio = rangoUtcDeFecha(desde, tz).inicio;
  const fin = rangoUtcDeFecha(hasta, tz).fin;
  const { rows } = await db.query(`
    SELECT folio, estado, (created_at AT TIME ZONE 'UTC') AS creado_at,
           jsonb_build_object(
             'total', datos->'total', 'subtotal', datos->'subtotal',
             'costo_envio', datos->'costo_envio', 'descuento', datos->'descuento',
             'forma_pago', datos->'forma_pago', 'pago_confirmado', datos->'pago_confirmado',
             'canal', datos->'canal', 'origen', datos->'origen', 'modalidad', datos->'modalidad',
             'items', datos->'items', 'propinas', datos->'propinas', 'propina', datos->'propina',
             'pagos', datos->'pagos', 'mixto_terminal', datos->'mixto_terminal',
             'cuenta_id', datos->'cuenta_id', 'mesero', datos->'mesero'
           ) AS datos
      FROM pedidos_activos
     WHERE negocio_id = $1 AND created_at >= $2 AND created_at < $3
     ORDER BY created_at, folio
  `, [nid, inicio.toISOString(), fin.toISOString()]);
  return rows;
}

async function leerCuentas(db, nid, filas) {
  const ids = [...new Set(filas.map((f) => String(f?.datos?.cuenta_id || '')).filter((id) => UUID.test(id)))];
  const cuentas = new Map();
  if (!ids.length) return cuentas;
  const { rows } = await db.query(`
    SELECT c.id::text AS id, c.mesero_usuario_id::text AS mesero_id, um.nombre AS mesero,
           c.cerrada_por::text AS cerro_id, uc.nombre AS cerro
      FROM restaurante_cuentas c
      LEFT JOIN usuarios um ON um.id = c.mesero_usuario_id
      LEFT JOIN usuarios uc ON uc.id = c.cerrada_por
     WHERE c.negocio_id = $1 AND c.id = ANY($2::uuid[])`, [nid, ids]);
  for (const r of rows) cuentas.set(r.id, r);
  return cuentas;
}

/**
 * Detalle de Ventas de una o varias sucursales. negocios: [{ id, nombre, tz }]
 * — quién puede ver cuáles lo decide la ruta. Cada una se lee con su
 * negocio_id, su zona, su lista de formas de cobro y sus cuentas de mesa.
 */
export async function obtenerDetalleVentas({ negocios = [], desde, hasta, db = pool } = {}) {
  if (!Array.isArray(negocios) || !negocios.length) {
    const e = new Error('negocioId requerido'); e.code = 'TENANT_CONTEXT_REQUIRED'; throw e;
  }
  if (!esFechaValida(desde) || !esFechaValida(hasta) || desde > hasta) {
    const e = new Error('rango inválido'); e.code = 'RANGO_INVALIDO'; throw e;
  }
  const detalles = await Promise.all(negocios.map(async (n) => {
    const nid = exigirNegocio(n?.id);
    if (!esZonaValida(n.tz)) { const e = new Error('zona horaria inválida'); e.code = 'ZONA_INVALIDA'; throw e; }
    const [filas, catalogo] = await Promise.all([
      leerVentasDetalle(db, nid, desde, hasta, n.tz),
      catalogoFormasCobro(nid),
    ]);
    const cuentas = await leerCuentas(db, nid, filas);
    return detalleDeSucursal({ id: nid, nombre: n.nombre || '' }, filas, { catalogo, cuentas });
  }));
  return {
    rango: { desde, hasta },
    // «detalles», no «sucursales»: la ruta ya usa «sucursales» para la lista
    // de las que se pueden elegir.
    detalles,
    ...(detalles.length > 1 ? { total: sumarSucursales(detalles) } : {}),
  };
}
