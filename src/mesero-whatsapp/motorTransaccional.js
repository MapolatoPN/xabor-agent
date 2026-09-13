// ─── La frontera: el mesero propone, el motor autoriza ────────────────────
//
// Módulo puro. Recibe PROPUESTAS estructuradas y devuelve un carrito y una
// contabilidad de qué se aceptó, qué se rechazó y qué hay que preguntar.
//
// ── Qué es una propuesta ─────────────────────────────────────────────────
//
//   { accion, lid, campo, valorAnterior, valorNuevo, evidencia }
//
// La forma importa porque hace visible lo que hoy es invisible: hoy el modelo
// devuelve un pedido entero y nadie sabe qué quiso cambiar de él. Con esto, un
// turno deja escrito «cambiar cantidad del renglón L2 de 1 a 3, porque el
// cliente escribió hazlos tres», y eso se puede leer, medir y discutir.
//
// ── Y ESTE MÓDULO NO DECIDE ──────────────────────────────────────────────
//
// La tentación evidente era escribir aquí las reglas de autorización: son
// propuestas explícitas, cada una con su evidencia, sería fácil validarlas una
// por una. Sería también un SEGUNDO juego de reglas junto al del reconciliador,
// y a la segunda semana dirían cosas distintas — y la que decide de verdad
// sería la que corre última, no la que se revisó.
//
// Así que lo único que hace este módulo es TRADUCIR:
//
//   propuestas  ->  un borrador con los cambios pedidos
//               ->  `reconciliar`, que decide campo a campo como siempre
//               ->  qué de lo propuesto sobrevivió
//
// Toda la autoridad sigue en `carritoDelPedido.js`. Este archivo es una
// gramática, no un juez. Si una propuesta no sobrevive, la razón está en el
// `cambios` del reconciliador, que es donde ya estaba.
//
// ── La única capacidad nueva ─────────────────────────────────────────────
//
// Quitar por referencia (`quitarPorLid`). «Quita el otro» no nombra nada, y el
// reconciliador exige que la frase nombre. La resolución la hace
// `referenciasDelCliente` con la misma regla de siempre —uno se resuelve, dos
// se preguntan— y el reconciliador sigue exigiendo el verbo de quitar por su
// cuenta. Está documentado allá, en el sitio donde se aplica.
import { reconciliar, carritoVacio } from '../orders/carritoDelPedido.js';

export const ACCIONES = Object.freeze([
  'agregar', 'quitar', 'duplicar',
  'cambiar_cantidad', 'cambiar_modificador', 'agregar_nota',
  'definir_modalidad', 'definir_pago', 'definir_cliente',
]);

const norm = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Una propuesta bien formada. Devuelve `null` si le falta lo esencial. */
export function propuesta({ accion, lid = null, campo = null, valorAnterior = null,
  valorNuevo = null, evidencia = '', datos = null } = {}) {
  if (!ACCIONES.includes(accion)) return null;
  return {
    accion,
    lid: lid ? String(lid) : null,
    campo: campo ? String(campo) : null,
    valorAnterior,
    valorNuevo,
    evidencia: String(evidencia || ''),
    ...(datos ? { datos } : {}),
  };
}

const clonar = (x) => JSON.parse(JSON.stringify(x ?? null));

/** Los modificadores de un renglón con un grupo sustituido o agregado. */
function conGrupo(modificadores, grupo, opciones) {
  const otros = (Array.isArray(modificadores) ? modificadores : [])
    .filter((m) => norm(m?.grupo ?? '') !== norm(grupo));
  const lista = (Array.isArray(opciones) ? opciones : [opciones]).filter(Boolean);
  return lista.length ? [...otros, { grupo: String(grupo ?? ''), opciones: lista.map(String) }] : otros;
}

/**
 * Construye el BORRADOR que expresa las propuestas, partiendo del carrito.
 *
 * Se parte del carrito y no de cero a propósito: así una propuesta que no
 * menciona un renglón lo deja intacto, que es la invariante de todo esto. El
 * borrador lleva el `lid` de cada renglón para que el reconciliador empareje
 * por identidad y no por parecido — con dos platillos iguales, el parecido
 * empata y el desempate lo decidiría el orden del bucle.
 */
export function borradorDesdePropuestas(carrito, propuestas = []) {
  const items = (carrito?.items || []).map((i) => ({ ...clonar(i), lid: i.lid }));
  const porLid = new Map(items.map((i) => [i.lid, i]));
  const datos = {};
  const quitarPorLid = [];
  const noAplicables = [];

  for (const p of propuestas) {
    if (!p || !ACCIONES.includes(p.accion)) { noAplicables.push({ propuesta: p, motivo: 'accion_desconocida' }); continue; }
    const destino = p.lid ? porLid.get(p.lid) : null;
    if (['quitar', 'duplicar', 'cambiar_cantidad', 'cambiar_modificador', 'agregar_nota'].includes(p.accion)
        && !destino) {
      noAplicables.push({ propuesta: p, motivo: 'renglon_inexistente' });
      continue;
    }
    switch (p.accion) {
      case 'agregar': {
        const nuevo = {
          nombre: String(p.valorNuevo?.nombre ?? p.valorNuevo ?? ''),
          cantidad: Number(p.valorNuevo?.cantidad) > 0 ? Number(p.valorNuevo.cantidad) : 1,
          modificadores: Array.isArray(p.valorNuevo?.modificadores) ? p.valorNuevo.modificadores : [],
          notas: String(p.valorNuevo?.notas || ''),
          ...(p.valorNuevo?.id !== undefined ? { id: p.valorNuevo.id } : {}),
        };
        if (!nuevo.nombre) { noAplicables.push({ propuesta: p, motivo: 'sin_nombre' }); break; }
        items.push(nuevo);
        break;
      }
      case 'duplicar': {
        // El renglón nuevo va SIN `lid`: es otro renglón, y darle el del
        // original haría que el reconciliador los tomara por el mismo.
        const { lid, ...copia } = destino;
        items.push({ ...clonar(copia), cantidad: 1 });
        break;
      }
      case 'quitar':
        quitarPorLid.push(destino.lid);
        break;
      case 'cambiar_cantidad': {
        const n = Number(p.valorNuevo);
        if (!Number.isFinite(n) || n <= 0) { noAplicables.push({ propuesta: p, motivo: 'cantidad_invalida' }); break; }
        destino.cantidad = n;
        break;
      }
      case 'cambiar_modificador':
        destino.modificadores = conGrupo(destino.modificadores, p.campo, p.valorNuevo);
        break;
      case 'agregar_nota':
        destino.notas = String(p.valorNuevo || '');
        break;
      case 'definir_modalidad': datos.modalidad = p.valorNuevo; break;
      case 'definir_pago': datos.forma_pago = p.valorNuevo; break;
      case 'definir_cliente': datos.cliente = { ...(datos.cliente || {}), ...(p.valorNuevo || {}) }; break;
      default: break;
    }
  }

  const borrador = { items };
  if (datos.modalidad !== undefined) borrador.modalidad = datos.modalidad;
  if (datos.forma_pago !== undefined) borrador.forma_pago = datos.forma_pago;
  if (datos.cliente) borrador.cliente = datos.cliente;
  return { borrador, quitarPorLid, noAplicables };
}

/**
 * APLICA las propuestas: las traduce y deja que el reconciliador decida.
 *
 * `opciones` son las de `reconciliar` —`mensaje`, `textoCiclo`, `terminos`,
 * `datoOperativoPendiente`— más las propuestas. La evidencia extra que produce
 * un «sí» a una sugerencia entra por `textoCiclo`, que es como el reconciliador
 * sabe qué autorizó el cliente; no hay una puerta trasera para eso.
 *
 * Devuelve `{ carrito, cambios, decisiones }`. `decisiones` dice, propuesta por
 * propuesta, si sobrevivió — leyendo el resultado, no adivinándolo.
 */
export function aplicarPropuestas(carritoPrevio, propuestas = [], opciones = {}) {
  const previo = carritoPrevio && Array.isArray(carritoPrevio.items) ? carritoPrevio : carritoVacio();
  const { borrador, quitarPorLid, noAplicables } = borradorDesdePropuestas(previo, propuestas);
  const { carrito, cambios } = reconciliar(previo, borrador, { ...opciones, quitarPorLid });

  const antesPorLid = new Map((previo.items || []).map((i) => [i.lid, i]));
  const despuesPorLid = new Map((carrito.items || []).map((i) => [i.lid, i]));
  const nombresDespues = (carrito.items || []).map((i) => norm(i.nombre));

  const decisiones = [];
  for (const p of propuestas) {
    if (noAplicables.some((n) => n.propuesta === p)) {
      decisiones.push({ propuesta: p, decision: 'rechazada',
        motivo: noAplicables.find((n) => n.propuesta === p).motivo });
      continue;
    }
    let aplicada = false;
    switch (p.accion) {
      case 'agregar':
        aplicada = nombresDespues.includes(norm(p.valorNuevo?.nombre ?? p.valorNuevo));
        break;
      case 'quitar':
        aplicada = !despuesPorLid.has(p.lid);
        break;
      case 'duplicar': {
        const antes = (previo.items || []).filter((i) => norm(i.nombre) === norm(antesPorLid.get(p.lid)?.nombre)).length;
        const despues = (carrito.items || []).filter((i) => norm(i.nombre) === norm(antesPorLid.get(p.lid)?.nombre)).length;
        aplicada = despues > antes;
        break;
      }
      case 'cambiar_cantidad':
        aplicada = Number(despuesPorLid.get(p.lid)?.cantidad) === Number(p.valorNuevo);
        break;
      case 'cambiar_modificador': {
        const grupos = despuesPorLid.get(p.lid)?.modificadores || [];
        const esperados = (Array.isArray(p.valorNuevo) ? p.valorNuevo : [p.valorNuevo]).filter(Boolean).map(norm);
        const puestas = grupos.filter((g) => norm(g?.grupo ?? '') === norm(p.campo))
          .flatMap((g) => (g.opciones || []).map((o) => norm(typeof o === 'string' ? o : o?.nombre)));
        aplicada = esperados.length > 0 && esperados.every((e) => puestas.includes(e));
        break;
      }
      case 'agregar_nota':
        aplicada = norm(despuesPorLid.get(p.lid)?.notas) === norm(p.valorNuevo);
        break;
      case 'definir_modalidad': aplicada = carrito.datos?.modalidad === p.valorNuevo; break;
      case 'definir_pago': aplicada = carrito.datos?.forma_pago === p.valorNuevo; break;
      case 'definir_cliente': aplicada = !!carrito.datos?.cliente; break;
      default: aplicada = false;
    }
    decisiones.push({ propuesta: p, decision: aplicada ? 'aceptada' : 'rechazada',
      motivo: aplicada ? null : 'sin_respaldo_del_reconciliador' });
  }

  return { carrito, cambios, decisiones };
}

/** Las que no pasaron, para poder decirlo en el log y en las métricas. */
export const rechazadas = (decisiones) => (decisiones || []).filter((d) => d.decision === 'rechazada');

// ── DEL BORRADOR DEL MODELO A PROPUESTAS ─────────────────────────────────
//
// El extractor sigue devolviendo lo que devuelve: un pedido entero. Esta
// función lo compara con el carrito y escribe QUÉ quiso cambiar. Es lo que
// convierte «el modelo emitió esto» en «el modelo propone subir la cantidad del
// renglón L2 de 1 a 3», que es lo que se puede auditar y medir.
//
// UN ERROR AQUÍ NO AUTORIZA NADA. Lo que sale de aquí vuelve a pasar por
// `reconciliar`, que decide con sus reglas de siempre. Si esta comparación
// se equivoca de renglón, el reconciliador lo empareja bien por su cuenta; lo
// que se pierde es precisión en el log, no protección.

const opcionesPorGrupo = (item) => {
  const mapa = new Map();
  for (const m of (Array.isArray(item?.modificadores) ? item.modificadores : [])) {
    if (typeof m === 'string') { mapa.set('', [...(mapa.get('') || []), m]); continue; }
    const g = String(m?.grupo ?? '');
    const lista = Array.isArray(m?.opciones) ? m.opciones : [m?.opcion || m?.nombre].filter(Boolean);
    mapa.set(g, [...(mapa.get(g) || []), ...lista.map((o) => String(typeof o === 'string' ? o : o?.nombre || ''))]);
  }
  return mapa;
};

const mismasOpciones = (a = [], b = []) =>
  JSON.stringify(a.map(norm).sort()) === JSON.stringify(b.map(norm).sort());

/**
 * Empareja cada renglón del borrador con uno del carrito.
 *
 * Mismo criterio de nombres que usa el reconciliador —igualdad y después
 * contención, que es lo que reencuentra «Chilaquiles» tras volverse
 * «Chilaquiles Sencillos»— y voraz uno a uno, para que dos renglones del mismo
 * producto no se fusionen en uno.
 */
function emparejar(itemsCarrito, itemsBorrador) {
  const libres = itemsCarrito.slice();
  const pares = new Map();
  const nuevos = [];
  for (const b of itemsBorrador) {
    const nb = norm(b?.nombre);
    let i = libres.findIndex((c) => norm(c.nombre) === nb);
    if (i < 0) {
      i = libres.findIndex((c) => {
        const nc = norm(c.nombre);
        return nb && nc && (nc.includes(nb) || nb.includes(nc));
      });
    }
    if (i >= 0) { pares.set(libres[i].lid, b); libres.splice(i, 1); }
    else nuevos.push(b);
  }
  return { pares, nuevos, sinMencionar: libres };
}

/**
 * Las propuestas que expresa este borrador frente a este carrito.
 *
 * Lo que el borrador NO menciona no produce propuesta: omitir no es una acción,
 * y esa es la invariante que costó media cuenta el 12 de septiembre.
 */
export function propuestasDesdeBorrador(carrito, borrador, { evidencia = '' } = {}) {
  const itemsCarrito = (carrito?.items || []);
  const itemsBorrador = (borrador?.items || []).filter((i) => String(i?.nombre || '').trim() || i?.id !== undefined);
  const { pares, nuevos } = emparejar(itemsCarrito, itemsBorrador);
  const fuera = [];

  for (const nuevo of nuevos) {
    fuera.push(propuesta({ accion: 'agregar', valorNuevo: {
      nombre: nuevo.nombre, cantidad: nuevo.cantidad, modificadores: nuevo.modificadores,
      notas: nuevo.notas, ...(nuevo.id !== undefined ? { id: nuevo.id } : {}),
    }, evidencia }));
  }

  for (const actual of itemsCarrito) {
    const b = pares.get(actual.lid);
    if (!b) continue;                                   // omitido: no es un acto

    const cantB = Number(b.cantidad);
    if (Number.isFinite(cantB) && cantB > 0 && cantB !== Number(actual.cantidad)) {
      fuera.push(propuesta({ accion: 'cambiar_cantidad', lid: actual.lid, campo: 'cantidad',
        valorAnterior: Number(actual.cantidad), valorNuevo: cantB, evidencia }));
    }

    const gruposB = opcionesPorGrupo(b);
    const gruposA = opcionesPorGrupo(actual);
    for (const [grupo, opciones] of gruposB) {
      if (mismasOpciones(gruposA.get(grupo) || [], opciones)) continue;
      fuera.push(propuesta({ accion: 'cambiar_modificador', lid: actual.lid, campo: grupo,
        valorAnterior: gruposA.get(grupo) || [], valorNuevo: opciones, evidencia }));
    }

    const notaB = String(b.notas || '');
    if (notaB && norm(notaB) !== norm(actual.notas)) {
      fuera.push(propuesta({ accion: 'agregar_nota', lid: actual.lid, campo: 'notas',
        valorAnterior: actual.notas || null, valorNuevo: notaB, evidencia }));
    }
  }

  for (const [clave, accion] of [['modalidad', 'definir_modalidad'], ['forma_pago', 'definir_pago'],
    ['formaPago', 'definir_pago']]) {
    const v = borrador?.[clave];
    if (v === undefined || v === null || v === '') continue;
    if (carrito?.datos?.[clave === 'formaPago' ? 'forma_pago' : clave] === v) continue;
    fuera.push(propuesta({ accion, campo: clave, valorNuevo: v, evidencia }));
  }
  if (borrador?.cliente && typeof borrador.cliente === 'object') {
    fuera.push(propuesta({ accion: 'definir_cliente', campo: 'cliente', valorNuevo: borrador.cliente, evidencia }));
  }

  return fuera.filter(Boolean);
}
