// Modificadores de menú: resolución y validación en el SERVIDOR.
//
// El modelo ya existía (menu_modificadores_grupos / menu_modificadores_opciones,
// creadas en database.js e incluidas por obtenerMenuCompleto), lo usaba el
// editor de menú y el bot, pero ningún canal de venta lo validaba: POS
// mandaba "extras" con el precio que quisiera el frontend y el backend lo
// creía. Este módulo es la única fuente de verdad para todos los canales
// (POS envíos, POS presencial y Restaurante/Mesas), para que no existan dos
// implementaciones divergentes.
//
// Contrato: se recibe el producto y una lista de IDs de opciones elegidas;
// TODO lo demás (nombres, precios extra, mínimos, máximos, pertenencia y
// disponibilidad) sale de la base de datos del propio negocio. Nada de lo
// que mande el cliente HTTP influye en el precio.
import { pool } from './database.js';

export class ModificadoresError extends Error {
  constructor(mensaje, codigo) {
    super(mensaje);
    this.name = 'ModificadoresError';
    this.codigo = codigo;
  }
}

const num = (v) => Math.round(Number(v || 0) * 100) / 100;

// Carga los grupos (con sus opciones) de varios productos de un negocio.
// El WHERE negocio_id es la frontera de tenant: un grupo/opción de otro
// negocio simplemente no existe para esta consulta.
export async function cargarGruposDeProductos(negocioId, productoIds) {
  const ids = [...new Set(productoIds.map(Number).filter(Number.isFinite))];
  if (!ids.length) return new Map();
  const { rows: grupos } = await pool.query(
    `SELECT id, producto_id, nombre, requerido, minimo, maximo, orden
       FROM menu_modificadores_grupos
      WHERE producto_id = ANY($1::int[]) AND negocio_id = $2
      ORDER BY producto_id, orden, id`,
    [ids, negocioId]
  );
  const porProducto = new Map();
  if (!grupos.length) return porProducto;

  const { rows: opciones } = await pool.query(
    `SELECT id, grupo_id, nombre, precio_extra, disponible, orden
       FROM menu_modificadores_opciones
      WHERE grupo_id = ANY($1::int[]) AND negocio_id = $2
      ORDER BY grupo_id, orden, id`,
    [grupos.map(g => g.id), negocioId]
  );
  const porGrupo = new Map();
  for (const o of opciones) {
    if (!porGrupo.has(o.grupo_id)) porGrupo.set(o.grupo_id, []);
    porGrupo.get(o.grupo_id).push(o);
  }
  for (const g of grupos) {
    g.opciones = porGrupo.get(g.id) || [];
    if (!porProducto.has(g.producto_id)) porProducto.set(g.producto_id, []);
    porProducto.get(g.producto_id).push(g);
  }
  return porProducto;
}

// Valida la selección de un producto contra sus grupos reales y devuelve el
// detalle con los precios de la base. Lanza ModificadoresError (→ 400) ante
// cualquier inconsistencia; nunca 500.
//
//   seleccion: [12, 45]  (ids de opción) — también acepta
//              [{ opcionId: 12 }] por comodidad del frontend.
//
// Devuelve: { modificadores: [{ grupo_id, grupo, opcion_id, opcion,
//             precio_extra }], precioExtras, texto }
export function resolverSeleccion(producto, grupos, seleccion) {
  const idsElegidos = (Array.isArray(seleccion) ? seleccion : [])
    .map(s => Number(s && typeof s === 'object' ? (s.opcionId ?? s.id) : s))
    .filter(Number.isFinite);

  if (new Set(idsElegidos).size !== idsElegidos.length) {
    throw new ModificadoresError(`Hay opciones repetidas en "${producto.nombre}"`, 'OPCION_DUPLICADA');
  }

  const opcionesValidas = new Map();
  for (const g of grupos) for (const o of g.opciones) opcionesValidas.set(o.id, { grupo: g, opcion: o });

  const porGrupo = new Map(grupos.map(g => [g.id, []]));
  for (const id of idsElegidos) {
    const encontrada = opcionesValidas.get(id);
    // Cubre a la vez: opción inexistente, de otro grupo/producto y de otro
    // negocio -- todas se ven igual desde aquí, que es justo lo que se
    // quiere (no revelar qué existe en otro tenant).
    if (!encontrada) {
      throw new ModificadoresError(`La opción seleccionada no pertenece a "${producto.nombre}"`, 'OPCION_INVALIDA');
    }
    if (encontrada.opcion.disponible === false) {
      throw new ModificadoresError(`La opción "${encontrada.opcion.nombre}" no está disponible`, 'OPCION_NO_DISPONIBLE');
    }
    porGrupo.get(encontrada.grupo.id).push(encontrada.opcion);
  }

  for (const g of grupos) {
    const elegidas = porGrupo.get(g.id);
    const minimo = g.requerido ? Math.max(1, Number(g.minimo) || 1) : (Number(g.minimo) || 0);
    const maximo = Number(g.maximo) > 0 ? Number(g.maximo) : Infinity;
    if (elegidas.length < minimo) {
      throw new ModificadoresError(
        `"${g.nombre}" requiere al menos ${minimo} opción(es) en "${producto.nombre}"`,
        g.requerido && elegidas.length === 0 ? 'GRUPO_REQUERIDO' : 'MINIMO_NO_ALCANZADO'
      );
    }
    if (elegidas.length > maximo) {
      throw new ModificadoresError(
        `"${g.nombre}" admite como máximo ${maximo} opción(es) en "${producto.nombre}"`,
        'MAXIMO_EXCEDIDO'
      );
    }
  }

  const modificadores = [];
  for (const g of grupos) {
    for (const o of porGrupo.get(g.id)) {
      modificadores.push({
        grupo_id: g.id, grupo: g.nombre,
        opcion_id: o.id, opcion: o.nombre,
        precio_extra: num(o.precio_extra), // SIEMPRE el de la base
      });
    }
  }
  return {
    modificadores,
    precioExtras: num(modificadores.reduce((s, m) => s + m.precio_extra, 0)),
    texto: textoModificadores(modificadores),
  };
}

// Texto para comanda/ticket: "Salsas: Verde · Proteína: Bistec en Salsa".
// Es lo que ve la cocina, así que agrupa por grupo y respeta el orden.
export function textoModificadores(modificadores) {
  if (!Array.isArray(modificadores) || !modificadores.length) return '';
  const porGrupo = new Map();
  for (const m of modificadores) {
    if (!porGrupo.has(m.grupo)) porGrupo.set(m.grupo, []);
    porGrupo.get(m.grupo).push(m.opcion);
  }
  return [...porGrupo.entries()].map(([grupo, opciones]) => `${grupo}: ${opciones.join(', ')}`).join(' · ');
}

// Resuelve un solo producto (usado por Restaurante/Mesas, que agrega de uno
// en uno). Verifica pertenencia al negocio y disponibilidad antes de mirar
// los modificadores.
export async function resolverProductoConModificadores(negocioId, productoId, seleccion) {
  const { rows } = await pool.query(
    `SELECT id, nombre, precio, disponible, agotado FROM menu_productos
      WHERE id = $1 AND negocio_id = $2`,
    [Number(productoId), negocioId]
  );
  const producto = rows[0];
  if (!producto) {
    throw new ModificadoresError('El producto no pertenece a este negocio o no existe', 'PRODUCTO_AJENO');
  }
  if (producto.disponible === false || producto.agotado === true) {
    throw new ModificadoresError(`El producto "${producto.nombre}" no está disponible`, 'PRODUCTO_NO_DISPONIBLE');
  }
  const grupos = (await cargarGruposDeProductos(negocioId, [producto.id])).get(producto.id) || [];
  const r = resolverSeleccion(producto, grupos, seleccion);
  return {
    producto,
    precioBase: num(producto.precio),
    precioUnitario: num(num(producto.precio) + r.precioExtras),
    ...r,
  };
}
