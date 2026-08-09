// Motor de routing de impresión: decide QUÉ item se imprime EN QUÉ impresora.
//
// Función pura y sin base de datos a propósito. Recibe los items de una ronda
// y las reglas ya cargadas, y devuelve los grupos por destino. Así se puede
// probar el caso real de Mapolato -- "chilaquiles salen en su estación Y en
// cocina general" -- sin Postgres, sin WebSocket y sin impresora.
//
// El motor no sabe qué es una mesa, un mesero ni un folio: eso viaja en el
// snapshot que arma quien lo llama. Aquí solo hay productos, categorías y
// destinos.

// Las reglas se guardan y se comparan normalizadas: "Bebidas", "bebidas" y
// "BEBIDAS " son la misma regla. Sin acentos porque nadie va a escribir
// "Café" igual dos veces al configurar.
export function normalizarClave(valor) {
  if (typeof valor !== 'string') return '';
  return valor
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim().toLowerCase().replace(/\s+/g, ' ');
}

// ─── Precedencia ────────────────────────────────────────────────────────────
//
// Para cada item se resuelve así, y en este orden:
//
//   1. Destinos de su CATEGORÍA (reglas ambito='categoria').
//   2. Reglas de su PRODUCTO (ambito='producto'):
//        · modo 'exclusivo' → SUSTITUYEN por completo a las de la categoría.
//          Sirve para la excepción: "las quesadillas de la carta de niños no
//          van a la plancha, van a cocina general y punto".
//        · modo 'agregar'   → SE SUMAN a las de la categoría.
//          Sirve para el caso Mapolato: los chilaquiles son de la categoría
//          "Fuertes" (→ cocina general) y además tienen su propia estación.
//
//   Si un producto tiene reglas de los dos modos, 'exclusivo' gana: la
//   intención de excluir es más específica que la de añadir, y mezclarlas
//   daría un resultado que nadie sabría explicar. Se registra un aviso.
//
//   3. Duplicados: si dos reglas apuntan a la MISMA impresora, el destino
//      aparece UNA vez. Nunca dos papeles idénticos por una configuración
//      redundante.
//
// Un item sin ninguna ruta NO es un error: se devuelve en `sinRuta` y quien
// llama decide (la comanda ya está guardada; lo que falta es papel).
export function resolverDestinosDeItem(item, reglas) {
  const producto = normalizarClave(item.producto ?? item.nombre);
  const categoria = normalizarClave(item.categoria);

  const deCategoria = categoria ? (reglas.categoria.get(categoria) || []) : [];
  const delProducto = producto ? (reglas.producto.get(producto) || []) : [];

  const exclusivas = delProducto.filter(r => r.modo === 'exclusivo');
  const aditivas   = delProducto.filter(r => r.modo !== 'exclusivo');

  const avisos = [];
  let base;
  if (exclusivas.length) {
    base = exclusivas;
    if (aditivas.length) {
      avisos.push(`"${item.producto ?? item.nombre}" tiene reglas exclusivas y aditivas a la vez: mandan las exclusivas`);
    }
  } else {
    base = [...deCategoria, ...aditivas];
  }

  // Una impresora, un destino -- aunque la categoría y el producto apunten
  // las dos al mismo sitio.
  const porImpresora = new Map();
  for (const r of base) {
    if (!porImpresora.has(r.impresoraId)) porImpresora.set(r.impresoraId, r);
  }

  return { destinos: [...porImpresora.values()], avisos };
}

// Convierte las filas de impresion_rutas en los índices que usa el motor.
// Se hace una vez por ronda, no una vez por item.
export function indexarReglas(filas) {
  const reglas = { categoria: new Map(), producto: new Map(), documento: new Map() };
  for (const f of filas) {
    if (f.activa === false) continue;
    const mapa = reglas[f.ambito];
    if (!mapa) continue;                      // ámbito desconocido: se ignora
    const clave = normalizarClave(f.clave);
    if (!clave) continue;
    if (!mapa.has(clave)) mapa.set(clave, []);
    mapa.get(clave).push({
      impresoraId: f.impresora_id ?? f.impresoraId,
      impresoraNombre: f.impresora_nombre ?? f.impresoraNombre ?? null,
      modo: f.modo || 'agregar',
    });
  }
  return reglas;
}

// ─── Agrupación por destino ─────────────────────────────────────────────────
//
// Entrada: los items de UNA ronda (solo los nuevos -- eso ya lo garantiza
// enviarComanda) y las reglas indexadas.
//
// Salida: un grupo por impresora, con los items que le tocan EN EL ORDEN
// ORIGINAL de la ronda. El orden importa en cocina: el mesero canta la
// comanda como la capturó.
//
// Cada grupo es un trabajo de impresión distinto. No hay transacción entre
// ellos: si la impresora de bebidas está apagada, la de cocina imprime igual.
// Es el requisito explícito del negocio y la razón de que esto no sea un
// "documento único con varias copias".
export function agruparItemsPorImpresora(items, reglas) {
  const grupos = new Map();     // impresoraId -> { impresoraId, impresoraNombre, items }
  const sinRuta = [];
  const avisos = [];

  for (const item of Array.isArray(items) ? items : []) {
    const { destinos, avisos: avisosItem } = resolverDestinosDeItem(item, reglas);
    avisos.push(...avisosItem);

    if (!destinos.length) {
      sinRuta.push(item.producto ?? item.nombre ?? '(sin nombre)');
      continue;
    }

    for (const d of destinos) {
      if (!grupos.has(d.impresoraId)) {
        grupos.set(d.impresoraId, { impresoraId: d.impresoraId, impresoraNombre: d.impresoraNombre, items: [] });
      }
      // El MISMO item entra en varios grupos: no se parte la cantidad ni se
      // reparte. Los chilaquiles se imprimen enteros en las dos impresoras
      // porque las dos estaciones necesitan verlos completos.
      grupos.get(d.impresoraId).items.push(item);
    }
  }

  if (sinRuta.length) {
    const unicos = [...new Set(sinRuta)];
    avisos.push(`sin impresora configurada: ${unicos.join(', ')}`);
  }

  return { grupos: [...grupos.values()], sinRuta: [...new Set(sinRuta)], avisos };
}

// Destinos de un documento completo (la cuenta, una cancelación). No se
// reparte por items: el documento entero va a las impresoras declaradas para
// ese tipo. La cuenta NUNCA debe caer en cocina, y eso se consigue no
// heredando las reglas de categoría -- solo mira ambito='documento'.
export function destinosDeDocumento(tipoDocumento, reglas) {
  const clave = normalizarClave(tipoDocumento);
  const lista = reglas.documento.get(clave) || [];
  const porImpresora = new Map();
  for (const r of lista) if (!porImpresora.has(r.impresoraId)) porImpresora.set(r.impresoraId, r);
  return [...porImpresora.values()];
}
