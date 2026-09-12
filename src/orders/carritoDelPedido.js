// ─── El pedido es del cliente, no del último borrador del modelo ──────────
//
// Módulo puro: reconcilia lo que el modelo propone contra lo que el cliente ya
// había pedido. No consulta la base ni llama al modelo.
//
// ── Por qué existe ───────────────────────────────────────────────────────
//
// Hasta ahora, en cada turno el borrador que emitía el modelo ERA el pedido.
// Todo lo demás —identidad, cantidades, selecciones— se derivaba de esa
// emisión. Si el modelo omitía un artículo, el sistema lo tomaba por una
// decisión del cliente.
//
// Falla reproducida (auditoría Codex, 2026-09-12, prioridad alta):
//
//   cliente  «chilaquiles suizos con pollo... Además una orden de hotcakes»
//   cliente  «Los sencillos»
//   cliente  «Para recoger, efectivo, a nombre de Ana»
//   modelo   emite un borrador SOLO con los chilaquiles
//   sistema  presenta una preconfirmación de $255 en vez de $434
//
// El cliente contestó un dato operativo y perdió un platillo. Nunca dijo que lo
// quitaran. `session.aclaracionProducto` cubría el tramo de elegir presentación
// —y funcionaba— pero se limpia al pasar esa validación y el ciclo vuelve a
// depender de lo que el modelo recuerde.
//
// ── La regla ─────────────────────────────────────────────────────────────
//
// El modelo PROPONE; el carrito se reconcilia:
//
//   · Omitir un artículo NO lo borra. Es la invariante central.
//   · Un artículo que el modelo trae y el carrito no, se agrega.
//   · Un artículo que ambos tienen se actualiza con lo que trae el modelo:
//     ahí sí refleja la conversación más reciente sobre ESE artículo.
//   · Quitar exige evidencia en las palabras del cliente, no una omisión.
//   · Los datos operativos —modalidad, pago, nombre, dirección— nunca tocan
//     artículos.
//
// Cada artículo lleva un identificador local estable (`lid`) que no sale nunca
// hacia el modelo: sirve para seguirle la pista entre turnos aunque cambie de
// nombre al elegir la presentación ("Chilaquiles" -> "Chilaquiles Sencillos").

const norm = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Las opciones que trae un artículo, aplanadas, para comparar dos artículos. */
function opcionesDe(item) {
  const fuera = [];
  for (const m of (Array.isArray(item?.modificadores) ? item.modificadores : [])) {
    if (typeof m === 'string') { fuera.push(m); continue; }
    if (Array.isArray(m?.opciones)) { for (const o of m.opciones) fuera.push(typeof o === 'string' ? o : o?.nombre); continue; }
    if (m?.opcion || m?.nombre) fuera.push(m.opcion || m.nombre);
  }
  return fuera.filter(Boolean).map(norm);
}

/**
 * Qué tanto se parecen dos artículos, para emparejarlos entre turnos.
 *
 * El nombre pesa mucho más que las opciones porque es lo que identifica al
 * platillo; las opciones desempatan cuando hay DOS unidades del mismo producto
 * con preparaciones distintas ("uno con pollo y otro con cerdo"), que es un
 * caso real y no puede colapsar en uno solo.
 */
function parecido(a, b) {
  const na = norm(a?.nombre), nb = norm(b?.nombre);
  let puntos = 0;
  if (na && nb) {
    if (na === nb) puntos += 100;
    // Contención: así se reencuentra un artículo que cambió de nombre al
    // elegir la presentación. "Chilaquiles" y "Chilaquiles Sencillos" son el
    // mismo renglón del pedido, no dos.
    else if (na.includes(nb) || nb.includes(na)) puntos += 60;
    else return -1;                       // nombres ajenos: no son el mismo
  }
  const oa = opcionesDe(a), ob = opcionesDe(b);
  for (const o of oa) if (ob.includes(o)) puntos += 3;
  return puntos;
}

let contador = 0;
const nuevoLid = () => `it${Date.now().toString(36)}${(contador++).toString(36)}`;

function normalizarItem(item, lid) {
  const cantidad = Number(item?.cantidad);
  return {
    lid: lid || item?.lid || nuevoLid(),
    nombre: String(item?.nombre || '').trim(),
    ...(item?.id !== undefined ? { id: item.id } : {}),
    cantidad: Number.isFinite(cantidad) && cantidad > 0 ? cantidad : 1,
    modificadores: Array.isArray(item?.modificadores) ? item.modificadores : [],
    notas: String(item?.notas || ''),
  };
}

/** Un carrito vacío, con la forma que espera el resto del módulo. */
export const carritoVacio = () => ({ items: [], datos: {} });

/** ¿El cliente pidió quitar algo en ESTE mensaje? */
const PIDE_QUITAR = /\b(quita|quitar|quitame|qu[ií]tame|elimina|eliminar|borra|borrar|cancela|cancelar|saca|sacar|ya no quiero|mejor no|sin el|sin la|sin los|sin las|remueve|remover)\b/i;

// Dónde DEJA de alcanzar. Un mensaje puede quitar y pedir a la vez —es la forma
// normal de sustituir algo— y entonces el verbo de quitar solo manda hasta que
// el cliente empieza a pedir lo nuevo.
//
// Sin este límite, «quita los hotcakes y mejor ponme un bowl de chilaquiles»
// vaciaba el pedido entero: el mensaje traía un verbo de quitar y nombraba
// todos los artículos, así que todos se iban.
const EMPIEZA_A_PEDIR = /\b(ponme|p[oó]nme|pon|agrega|ag[rR]égame|agregame|a[ñn]ade|a[ñn][aá]deme|dame|quiero|mejor dame|mandame|m[aá]ndame|traeme|tr[aá]eme|sumale|s[uú]male|en su lugar|cambialo|c[aá]mbialo)\b/i;

/**
 * Los artículos del carrito que el cliente pidió quitar en este mensaje.
 *
 * Conservador a propósito: hace falta un verbo de quitar Y que el artículo esté
 * nombrado DENTRO de su alcance. «Mejor no» a secas no quita nada, porque no
 * dice qué. Preferimos preguntar de más a borrar de menos: un artículo que sobra
 * se ve en el resumen y el cliente lo corrige; uno que falta se descubre al
 * recogerlo.
 */
export function articulosQueElClientePidioQuitar(carrito, mensaje) {
  const bruto = String(mensaje || '');
  const verbo = PIDE_QUITAR.exec(bruto);
  if (!verbo) return [];
  const resto = bruto.slice(verbo.index + verbo[0].length);
  const corte = EMPIEZA_A_PEDIR.exec(resto);
  const texto = norm(corte ? resto.slice(0, corte.index) : resto);
  if (!texto) return [];
  const fuera = [];
  for (const it of (carrito?.items || [])) {
    const palabras = norm(it.nombre).split(' ').filter((w) => w.length >= 4);
    if (palabras.length && palabras.some((w) => texto.includes(w))) fuera.push(it.lid);
  }
  return fuera;
}
/**
 * Reconcilia la propuesta del modelo contra el carrito que ya existía.
 *
 * Devuelve `{ carrito, cambios }`. `cambios` es para observabilidad: qué se
 * agregó, qué se actualizó, qué se conservó pese a no venir en la propuesta y
 * qué se quitó por petición del cliente.
 */
export function reconciliar(carritoPrevio, propuesta, opciones = {}) {
  const mensaje = String(opciones.mensaje || '');
  const previo = (carritoPrevio && Array.isArray(carritoPrevio.items))
    ? { items: carritoPrevio.items.map((i) => normalizarItem(i, i.lid)), datos: { ...(carritoPrevio.datos || {}) } }
    : carritoVacio();

  const propuestos = Array.isArray(propuesta?.items)
    ? propuesta.items.filter((i) => String(i?.nombre || '').trim() || i?.id !== undefined)
    : [];

  const cambios = { agregados: [], actualizados: [], conservados: [], quitados: [] };

  // 1) Emparejar cada artículo propuesto con uno del carrito. Voraz por mejor
  //    parecido, uno a uno: dos renglones del mismo producto no se fusionan.
  const libres = new Set(previo.items.map((i) => i.lid));
  const porLid = new Map(previo.items.map((i) => [i.lid, i]));
  const resultado = [];
  const emparejados = new Map();
  for (const p of propuestos) {
    let mejor = null, mejorPuntos = 0;
    for (const lid of libres) {
      const puntos = parecido(porLid.get(lid), p);
      if (puntos > mejorPuntos) { mejor = lid; mejorPuntos = puntos; }
    }
    if (mejor) { libres.delete(mejor); emparejados.set(mejor, p); }
    else resultado.push({ nuevo: normalizarItem(p) });
  }

  // 2) Recorrer el carrito EN SU ORDEN: lo emparejado se actualiza, lo que el
  //    modelo no mencionó se conserva tal cual. Aquí vive la invariante.
  const items = [];
  for (const it of previo.items) {
    const p = emparejados.get(it.lid);
    if (p) {
      const actualizado = normalizarItem({ ...p, lid: it.lid }, it.lid);
      // El nombre solo avanza hacia uno más específico (al elegir presentación)
      // o se queda: una propuesta que lo generaliza no puede deshacer lo que el
      // cliente ya concretó.
      if (!actualizado.nombre) actualizado.nombre = it.nombre;
      items.push(actualizado);
      cambios.actualizados.push(actualizado.nombre);
    } else {
      items.push(it);
      cambios.conservados.push(it.nombre);
    }
  }
  for (const { nuevo } of resultado) { items.push(nuevo); cambios.agregados.push(nuevo.nombre); }

  // 3) Quitar SOLO lo que el cliente pidió quitar con sus palabras, y solo
  //    aquello que este turno no acaba de cambiar.
  //
  //    «Quita las gyozas de cerdo y ponme unas de verdura» nombra las gyozas
  //    DOS veces: una para quitarlas y otra para pedirlas de otra forma. Si el
  //    renglón se quitara, el cliente se quedaría sin lo que acaba de pedir.
  //    Que la propuesta traiga ese renglón CAMBIADO es la señal de que el
  //    «quita» hablaba de la forma vieja, no del artículo.
  //
  //    Un renglón que la propuesta repite IGUAL no es señal de nada —hay
  //    modelos que reescriben el pedido entero cada turno— y sigue siendo
  //    quitable: si no, el cliente no podría quitar nada cuando el modelo
  //    insiste en repetirlo.
  const huella = (i) => JSON.stringify([norm(i?.nombre), Number(i?.cantidad) || 1,
    opcionesDe(i).slice().sort(), norm(i?.notas)]);
  const huellaPrevia = new Map(previo.items.map((i) => [i.lid, huella(i)]));
  const intacto = (i) => huellaPrevia.has(i.lid) && huellaPrevia.get(i.lid) === huella(i);
  const quitables = new Set(items.filter(intacto).map((i) => i.lid));
  const aQuitar = new Set(articulosQueElClientePidioQuitar({ items }, mensaje)
    .filter((lid) => quitables.has(lid)));
  const finales = items.filter((i) => {
    if (!aQuitar.has(i.lid)) return true;
    cambios.quitados.push(i.nombre);
    return false;
  });

  // 4) Datos operativos: se acumulan, nunca se pierden por omisión, y JAMÁS
  //    tocan artículos.
  const datos = { ...previo.datos };
  for (const clave of ['modalidad', 'forma_pago', 'formaPago', 'costo_envio']) {
    if (propuesta?.[clave] !== undefined && propuesta[clave] !== null && propuesta[clave] !== '') {
      datos[clave === 'formaPago' ? 'forma_pago' : clave] = propuesta[clave];
    }
  }
  if (propuesta?.cliente && typeof propuesta.cliente === 'object') {
    datos.cliente = { ...(previo.datos.cliente || {}) };
    for (const [k, v] of Object.entries(propuesta.cliente)) {
      if (v !== undefined && v !== null && String(v).trim() !== '') datos.cliente[k] = v;
    }
  }

  return { carrito: { items: finales, datos }, cambios };
}

/**
 * El carrito, con la forma de borrador que consume el validador.
 *
 * El `lid` NO viaja: es identidad interna. Lo que sale es lo que el resto del
 * sistema ya sabe leer, así que nada aguas abajo cambia.
 */
export function carritoABorrador(carrito) {
  const datos = carrito?.datos || {};
  return {
    items: (carrito?.items || []).map(({ lid, ...resto }) => resto),
    ...(datos.modalidad !== undefined ? { modalidad: datos.modalidad } : {}),
    ...(datos.forma_pago !== undefined ? { forma_pago: datos.forma_pago } : {}),
    ...(datos.costo_envio !== undefined ? { costo_envio: datos.costo_envio } : {}),
    ...(datos.cliente ? { cliente: datos.cliente } : {}),
  };
}

/** ¿Tiene algo que valga la pena validar? */
export const carritoConItems = (c) => Array.isArray(c?.items) && c.items.length > 0;
