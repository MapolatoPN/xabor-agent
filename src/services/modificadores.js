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

// Normaliza un nombre para matching tolerante: sin acentos, minúsculas, sin
// espacios repetidos. Solo para EMPAREJAR, nunca para mostrar.
function normNombre(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Resolución de modificadores para el PATH DEL LLM (WhatsApp/voz): el modelo
// emite NOMBRES de opciones, no IDs. Empareja cada nombre contra las opciones
// REALES del producto (por nombre normalizado) y toma el precio_extra CANÓNICO
// de la base — el LLM nunca decide el importe. Es LENIENTE a propósito (no
// impone min/max de grupos como la UI): un nombre no reconocido NO se cobra y
// se reporta en `noReconocidos`; nunca inventa un precio ni tumba el pedido.
// Reutiliza el mismo catálogo (cargarGruposDeProductos) y la misma regla de
// precio que POS/Restaurante — no hay una segunda implementación de precios.
//
// LA IDENTIDAD DE UNA OPCIÓN ES (grupo, opción), NUNCA EL NOMBRE SUELTO.
// Incidente XAB-0230: "Bistec en Salsa" y "Queso Panela en Salsa" existen en
// DOS grupos del mismo producto (Proteína y Guarniciones). El índice anterior
// era nombre→PRIMER grupo hallado, así que las guarniciones del cliente se
// registraron como proteínas: la línea quedó con 3 proteínas y 0 guarniciones,
// las condiciones de la promo fallaron y la cocina recibió datos falsos.
// Ahora: con grupo explícito se resuelve DENTRO del grupo; sin grupo solo se
// resuelve si el nombre es único en el producto; si es ambiguo se devuelve en
// `ambiguos` y NO se adivina.
//
//   grupos:  los del producto (de cargarGruposDeProductos), cada uno con .opciones
//   entradas admitidas (mezclables):
//     "Salchicha americana"                              (legacy: nombre suelto)
//     { opcion: "Salchicha americana" }                  (legacy: objeto)
//     { grupo: "Guarniciones", opciones: ["A", "B"] }    (estructurado por grupo)
//     { grupo_id: 12, opcion_id: 88 }                    (IDs, sin ambigüedad)
// Devuelve { modificadores, precioExtras, texto, noReconocidos, ambiguos }.
export function resolverModificadoresLLM(grupos, nombres) {
  const listaGrupos = Array.isArray(grupos) ? grupos : [];
  const disponibles = (g) => (g.opciones || []).filter((o) => o.disponible !== false);

  // Índice por (grupo normalizado → nombre opción normalizado → opción) y
  // conteo global de cada nombre para detectar ambigüedad.
  const porGrupo = new Map();   // clave grupo → { g, ops: Map(nombre → o) }
  const porGrupoId = new Map(); // id grupo   → mismo objeto
  const global = new Map();     // nombre op  → [{g,o}, ...]  (todas las coincidencias)
  for (const g of listaGrupos) {
    const entrada = { g, ops: new Map() };
    for (const o of disponibles(g)) {
      const clave = normNombre(o.nombre);
      if (!entrada.ops.has(clave)) entrada.ops.set(clave, o);
      if (!global.has(clave)) global.set(clave, []);
      global.get(clave).push({ g, o });
    }
    porGrupo.set(normNombre(g.nombre), entrada);
    porGrupoId.set(Number(g.id), entrada);
  }

  // Aplana la entrada a peticiones { nombre?, opcion_id?, grupo?, grupo_id? }.
  const peticiones = [];
  for (const n of (Array.isArray(nombres) ? nombres : [])) {
    if (n && typeof n === 'object') {
      const grupoNombre = n.grupo ?? n.grupo_nombre ?? null;
      const grupoId = n.grupo_id != null ? Number(n.grupo_id) : null;
      // Forma estructurada: un grupo con varias opciones.
      if (Array.isArray(n.opciones)) {
        for (const op of n.opciones) {
          const esObj = op && typeof op === 'object';
          peticiones.push({
            nombre: String((esObj ? (op.opcion ?? op.nombre) : op) || '').trim(),
            opcion_id: esObj && op.opcion_id != null ? Number(op.opcion_id) : (n.opcion_id != null ? null : null),
            grupoNombre, grupoId,
          });
        }
        continue;
      }
      peticiones.push({
        nombre: String(n.opcion ?? n.nombre ?? '').trim(),
        opcion_id: n.opcion_id != null ? Number(n.opcion_id) : null,
        grupoNombre, grupoId,
      });
      continue;
    }
    peticiones.push({ nombre: String(n || '').trim(), opcion_id: null, grupoNombre: null, grupoId: null });
  }

  const modificadores = [];
  const noReconocidos = [];
  const ambiguos = [];
  const noDisponibles = [];
  const yaTomadas = new Set();
  for (const p of peticiones) {
    if (!p.nombre && p.opcion_id == null) continue;
    // 1) Grupo explícito (por id o por nombre): la búsqueda se acota al grupo.
    let entrada = null;
    if (p.grupoId != null && porGrupoId.has(p.grupoId)) entrada = porGrupoId.get(p.grupoId);
    else if (p.grupoNombre) entrada = porGrupo.get(normNombre(p.grupoNombre)) || null;

    let hit = null;
    if (entrada) {
      const o = p.opcion_id != null
        ? disponibles(entrada.g).find((x) => Number(x.id) === p.opcion_id)
        : entrada.ops.get(normNombre(p.nombre));
      if (o) hit = { g: entrada.g, o };
      else {
        // SELECCIÓN ESTRUCTURADA que no existe: el cliente pidió un atributo
        // concreto DENTRO de un grupo real ("Sabor: Mango") y ese valor no está
        // en el catálogo. Antes se descartaba en silencio y el pedido seguía sin
        // sabor: así se vendió un licuado que la cocina no podía preparar
        // (XAB-0234). Ahora se reporta con las alternativas REALES del grupo
        // para que el canal pueda ofrecerlas; el pedido NO avanza.
        //
        // Solo cae aquí lo que viene con GRUPO explícito: un texto libre sin
        // grupo ("sin cebolla", "bien tostado") sigue el camino leniente de
        // `noReconocidos` — una nota de preparación no es una opción de menú.
        noDisponibles.push({
          grupo: entrada.g.nombre,
          solicitado: p.nombre || `#${p.opcion_id}`,
          alternativas: disponibles(entrada.g).map((x) => x.nombre),
        });
        continue;
      }
    } else if (p.opcion_id != null) {
      // 2) Sin grupo pero con id de opción: el id ya es identidad única.
      for (const g of listaGrupos) {
        const o = disponibles(g).find((x) => Number(x.id) === p.opcion_id);
        if (o) { hit = { g, o }; break; }
      }
      if (!hit) { noReconocidos.push(p.nombre || `#${p.opcion_id}`); continue; }
    } else {
      // 3) Legacy: nombre suelto. Solo se acepta si es ÚNICO en el producto.
      const coincidencias = global.get(normNombre(p.nombre)) || [];
      if (!coincidencias.length) { noReconocidos.push(p.nombre); continue; }
      if (coincidencias.length > 1) {
        // FAIL-CLOSED: no se adivina. El canal pedirá aclaración.
        ambiguos.push({ nombre: p.nombre, grupos: coincidencias.map((c) => c.g.nombre) });
        continue;
      }
      hit = coincidencias[0];
    }

    if (yaTomadas.has(hit.o.id)) continue; // mismo extra repetido: se cuenta una vez
    yaTomadas.add(hit.o.id);
    modificadores.push({
      grupo_id: hit.g.id, grupo: hit.g.nombre,
      opcion_id: hit.o.id, opcion: hit.o.nombre,
      precio_extra: num(hit.o.precio_extra), // SIEMPRE el de la base
    });
  }
  return {
    modificadores,
    precioExtras: num(modificadores.reduce((s, m) => s + m.precio_extra, 0)),
    texto: textoModificadores(modificadores),
    noReconocidos,
    ambiguos,
    noDisponibles,
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
