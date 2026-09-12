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
// ── La regla ─────────────────────────────────────────────────────────────
//
// EL MODELO PROPONE CAMBIOS; NO LOS AUTORIZA.
//
// La primera versión de este módulo protegía el ARTÍCULO y nada más adentro, y
// la segunda auditoría de Codex (12-sep, sobre esta misma rama) enseñó que eso
// no alcanza. Tres reproducciones, las tres con el cliente diciendo solo «Para
// recoger»:
//
//   · el mismo platillo volvía con cantidad 1 en vez de 2, sin su salsa y sin
//     su «sin cebolla» — el artículo se conservaba y su contenido no;
//   · «Quita los hotcakes tradicionales» borraba TAMBIÉN los hotcakes de
//     sartén, porque compartían una palabra;
//   · el modelo añadía tres Coca-Colas que nadie pidió y entraban al carrito.
//
// Así que la regla vive ahora a nivel de CAMPO, y cada cambio necesita
// autorización del cliente:
//
//   omitir            no borra nada: ni el artículo, ni su cantidad, ni sus
//                     modificadores, ni sus notas;
//   cambiar un campo  exige que lo que el cliente dijo lo sostenga;
//   agregar           exige que el cliente haya nombrado el producto;
//   quitar            exige un verbo de quitar Y que la frase identifique UN
//                     artículo: si dos caben igual de bien, no se quita
//                     ninguno y se pregunta;
//   datos operativos  —modalidad, pago, nombre, dirección— nunca tocan comida.
//
// Lo que no se autoriza no se aplica en silencio: sale en `cambios` para que
// quien redacta el turno pueda preguntar en vez de adivinar.
//
// Cada artículo lleva un identificador local estable (`lid`) que no sale nunca
// hacia el modelo: sirve para seguirle la pista entre turnos aunque cambie de
// nombre al elegir la presentación ("Chilaquiles" -> "Chilaquiles Sencillos").
import { palabrasQueLaSostienen, fuerzaDeEvidencia } from './evidenciaDeEleccion.js';

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
 * Los modificadores de un artículo, agrupados por grupo.
 *
 * Se compara y se fusiona POR GRUPO porque el grupo es la unidad de decisión
 * del cliente: cambiar la salsa no dice nada sobre la guarnición, y una
 * propuesta que solo trae la salsa no puede borrar la guarnición elegida.
 */
function porGrupo(modificadores) {
  const mapa = new Map();
  const mete = (g, o) => {
    const opcion = String(o || '').trim();
    if (!opcion) return;
    const clave = String(g ?? '');
    if (!mapa.has(clave)) mapa.set(clave, []);
    if (!mapa.get(clave).some((x) => norm(x) === norm(opcion))) mapa.get(clave).push(opcion);
  };
  for (const m of (Array.isArray(modificadores) ? modificadores : [])) {
    if (typeof m === 'string') { mete('', m); continue; }
    const g = m?.grupo ?? '';
    if (Array.isArray(m?.opciones)) { for (const o of m.opciones) mete(g, typeof o === 'string' ? o : o?.nombre); continue; }
    if (m?.opcion || m?.nombre) mete(g, m.opcion || m.nombre);
  }
  return mapa;
}

const desdeGrupos = (mapa) => [...mapa.entries()]
  .filter(([, opciones]) => opciones.length)
  .map(([grupo, opciones]) => ({ grupo, opciones }));

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

// ── ¿LO NOMBRÓ EL CLIENTE? ───────────────────────────────────────────────
//
// Un producto que el cliente no ha nombrado en ningún turno del ciclo no entra
// al carrito. Es lo que separa una petición de una invención del modelo.
//
// La comparación tolera la errata de una letra en palabras largas ("gyosas" por
// "Gyozas", "chilakiles" por "Chilaquiles") porque la gente escribe rápido en
// WhatsApp y negarle su pedido por una tecla es peor que el problema que
// resolvemos. Una distancia de UNO no acerca "Coca" a "recoger": la invención
// sigue cayendo.
function distanciaCorta(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 1) return 2;
  let fila = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const sig = [i];
    for (let j = 1; j <= b.length; j++) {
      sig[j] = Math.min(fila[j] + 1, sig[j - 1] + 1, fila[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    fila = sig;
  }
  return fila[b.length];
}

const VACIAS = new Set(['de', 'con', 'sin', 'en', 'la', 'el', 'los', 'las', 'y', 'a', 'al', 'del', 'para', 'un', 'una', 'unos', 'unas']);

export function nombradoPorElCliente(nombre, texto) {
  if (fuerzaDeEvidencia(nombre, texto) > 0) return true;
  // Segunda pasada, solo para la errata: palabras propias de al menos cinco
  // letras contra palabras del cliente de longitud parecida.
  const propias = norm(nombre).split(' ').filter((w) => w.length >= 5 && !VACIAS.has(w));
  const dichas = norm(texto).split(' ').filter((w) => w.length >= 5);
  return propias.some((p) => dichas.some((d) => distanciaCorta(p, d) <= 1));
}

// ── ¿AUTORIZÓ EL CLIENTE ESTA CANTIDAD? ──────────────────────────────────
//
// Cambiar la cantidad de un platillo es un cambio en la comida, así que necesita
// que el cliente lo haya dicho. Se exige que el NÚMERO PROPUESTO aparezca en su
// mensaje, en cifra o en letra.
//
// Esa exigencia es lo que distingue «mejor que sean tres» —donde el tres está—
// de «Nogal 900 acoros ai», donde hay un número que no es una cantidad y el
// modelo propone otro distinto. Y cuando el backend acaba de preguntar un dato
// de logística, ningún número de esa respuesta es una cantidad: es el mismo
// razonamiento que ya aplica `menciones_sin_acusacion` en brain.js.
const NUMERO_EN_LETRA = new Map([
  [1, ['un', 'uno', 'una']], [2, ['dos']], [3, ['tres']], [4, ['cuatro']], [5, ['cinco']],
  [6, ['seis', 'media docena']], [7, ['siete']], [8, ['ocho']], [9, ['nueve']], [10, ['diez']],
  [11, ['once']], [12, ['doce', 'docena']], [13, ['trece']], [14, ['catorce']], [15, ['quince']],
  [16, ['dieciseis']], [17, ['diecisiete']], [18, ['dieciocho']], [19, ['diecinueve']], [20, ['veinte']],
]);

// Tope de cordura. Por encima de esto no es una cantidad que alguien teclee en
// una conversación, es un número de casa o un teléfono que el modelo leyó mal.
const CANTIDAD_PLAUSIBLE = 50;

// Las preguntas del backend cuya RESPUESTA trae números que no son cantidades.
// Mientras una de ellas está en el aire, ningún número del mensaje autoriza
// cambiar cuánta comida hay: «Nogal 900» es una calle, no novecientos platillos.
// La modalidad y la forma de pago no entran —sus respuestas no llevan cifras—
// y dejarlas fuera es lo que permite «mejor que sean tres» justo después de que
// el backend pregunte si es para recoger.
const PREGUNTAS_CON_NUMEROS = new Set(['direccion', 'telefono', 'codigo_postal', 'numero_exterior']);

const respuestaConNumerosAjenos = (dato) => dato === true
  || (typeof dato === 'string' && PREGUNTAS_CON_NUMEROS.has(dato));

function elClienteDijoElNumero(n, mensaje) {
  const t = ` ${norm(mensaje)} `;
  if (t.includes(` ${n} `)) return true;
  return (NUMERO_EN_LETRA.get(n) || []).some((w) => t.includes(` ${w} `));
}

/**
 * ¿Puede esta propuesta cambiar la cantidad de ESTE artículo?
 *
 * Hacen falta las dos cosas: que el número esté en lo que el cliente acaba de
 * decir, y que la frase deje claro de qué artículo habla. «Mejor tres» con dos
 * platillos distintos en el carrito no dice cuál, así que no cambia ninguno.
 */
function autorizaCantidad(nueva, previa, ctx, item, hermanos) {
  if (nueva === previa) return true;
  if (!Number.isFinite(nueva) || nueva < 1 || nueva > CANTIDAD_PLAUSIBLE) return false;
  if (respuestaConNumerosAjenos(ctx.datoOperativoPendiente)) return false;
  if (!elClienteDijoElNumero(nueva, ctx.mensaje)) return false;
  if (!hermanos.length) return true;
  const mias = palabrasQueLaSostienen(item.nombre, ctx.mensaje);
  if (!mias.size) return false;
  for (const h of hermanos) {
    const suyas = palabrasQueLaSostienen(h.nombre, ctx.mensaje);
    let explicaTodoLoMio = true;
    for (const w of mias) if (!suyas.has(w)) { explicaTodoLoMio = false; break; }
    if (explicaTodoLoMio) return false;          // la frase no separa un platillo del otro
  }
  return true;
}

/**
 * Fusiona un artículo del carrito con lo que la propuesta dice de él.
 *
 * Campo por campo. Lo que la propuesta omite se conserva; lo que cambia se
 * aplica solo si el cliente lo respalda. Devuelve también qué se rechazó, para
 * poder preguntarlo.
 */
function fusionar(previo, propuesto, ctx, hermanos, cambios) {
  const p = normalizarItem(propuesto, previo.lid);
  const salida = { ...previo };

  // NOMBRE. Solo avanza hacia uno más específico —elegir la presentación— o se
  // queda. Una propuesta que lo generaliza no deshace lo que el cliente concretó.
  if (p.nombre && norm(p.nombre) !== norm(previo.nombre)) {
    const concreta = norm(p.nombre).includes(norm(previo.nombre));
    if (concreta || nombradoPorElCliente(p.nombre, ctx.textoCiclo)) {
      salida.nombre = p.nombre;
      if (p.id !== undefined) salida.id = p.id;
    } else {
      cambios.congelados.push({ lid: previo.lid, nombre: previo.nombre, campo: 'nombre', propuesto: p.nombre });
    }
  } else if (p.id !== undefined) {
    salida.id = p.id;
  }

  // CANTIDAD.
  if (autorizaCantidad(p.cantidad, previo.cantidad, ctx, previo, hermanos)) {
    salida.cantidad = p.cantidad;
  } else if (p.cantidad !== previo.cantidad) {
    cambios.congelados.push({ lid: previo.lid, nombre: previo.nombre, campo: 'cantidad',
      propuesto: p.cantidad, conservado: previo.cantidad });
  }

  // MODIFICADORES, grupo por grupo. Un grupo que la propuesta no menciona se
  // conserva; uno que cambia necesita respaldo en lo que el cliente ha dicho.
  const viejos = porGrupo(previo.modificadores);
  const nuevos = porGrupo(p.modificadores);
  const fusionados = new Map(viejos);
  for (const [grupo, opciones] of nuevos) {
    const iguales = viejos.has(grupo)
      && viejos.get(grupo).map(norm).sort().join('|') === opciones.map(norm).sort().join('|');
    if (iguales) continue;
    // DÓNDE se busca el respaldo depende de qué es el cambio, y esta distinción
    // es la que ata cada cambio al mensaje que lo justifica:
    //
    //   rellenar un grupo vacío  -> vale todo el ciclo: el cliente ya lo dijo y
    //                               el modelo apenas ahora lo estructura;
    //   cambiar uno ya elegido   -> vale SOLO este turno, porque cambiar de
    //                               idea es algo que se hace en un momento.
    //
    // Sin esa separación, «dos ramen con cerdo chashu y unas gyozas de verdura»
    // dejaba la palabra "cerdo" suelta en el ciclo, y tres turnos después el
    // modelo podía cambiarle el relleno a las gyozas con ese respaldo prestado.
    const yaElegido = viejos.has(grupo);
    // Una opción que el cliente nunca respaldó no la eligió él: fue del modelo,
    // y no merece la protección que se le da a lo que el cliente sí dijo. Si no,
    // el primer error del modelo quedaría cementado en el carrito.
    const loViejoEraSuyo = yaElegido
      && viejos.get(grupo).some((o) => fuerzaDeEvidencia(o, ctx.textoCiclo) > 0);
    const donde = (yaElegido && loViejoEraSuyo) ? ctx.mensaje : ctx.textoCiclo;
    const respaldadas = opciones.every((o) => fuerzaDeEvidencia(o, donde) > 0);
    if (respaldadas) fusionados.set(grupo, opciones);
    else if (viejos.has(grupo)) {
      cambios.congelados.push({ lid: previo.lid, nombre: previo.nombre, campo: `modificador:${grupo}`,
        propuesto: opciones, conservado: viejos.get(grupo) });
    } else {
      cambios.sinRespaldo.push({ lid: previo.lid, nombre: previo.nombre, campo: `modificador:${grupo}`,
        propuesto: opciones });
    }
  }
  salida.modificadores = desdeGrupos(fusionados);

  // NOTAS. Una nota se escribió porque el cliente la pidió; el silencio del
  // modelo no la retira. Se reemplaza solo por otra que el cliente sostenga.
  if (p.notas && norm(p.notas) !== norm(previo.notas)) {
    if (fuerzaDeEvidencia(p.notas, ctx.textoCiclo) > 0) salida.notas = p.notas;
    else cambios.congelados.push({ lid: previo.lid, nombre: previo.nombre, campo: 'notas',
      propuesto: p.notas, conservado: previo.notas });
  }

  return salida;
}

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
 * Qué artículos señala el cliente al pedir que se quite algo.
 *
 * Devuelve `{ fuera, ambiguos }`. Hacen falta un verbo de quitar Y que la frase
 * identifique UN artículo dentro de su alcance.
 *
 * Identificar no es compartir una palabra. «Quita los hotcakes tradicionales»
 * con "Hotcakes Tradicionales" y "Hotcakes de Sartén" en el carrito señala a
 * uno solo, aunque la palabra "hotcakes" esté en los dos: se compara QUÉ
 * palabras sostienen a cada candidato, igual que se hace con las opciones
 * hermanas de un grupo. Si otro candidato explica TODO lo que explica este, la
 * frase no los separa —«quita los hotcakes», a secas— y entonces no se quita
 * ninguno: se pregunta. Borrar de más es el error caro; preguntar, no.
 */
export function articulosQueElClientePidioQuitar(carrito, mensaje) {
  const bruto = String(mensaje || '');
  const verbo = PIDE_QUITAR.exec(bruto);
  if (!verbo) return { fuera: [], ambiguos: [] };
  const resto = bruto.slice(verbo.index + verbo[0].length);
  const corte = EMPIEZA_A_PEDIR.exec(resto);
  const tramo = corte ? resto.slice(0, corte.index) : resto;
  if (!norm(tramo)) return { fuera: [], ambiguos: [] };

  const candidatos = [];
  for (const it of (carrito?.items || [])) {
    const sostienen = palabrasQueLaSostienen(it.nombre, tramo);
    if (sostienen.size) candidatos.push({ it, sostienen });
  }
  if (!candidatos.length) return { fuera: [], ambiguos: [] };

  const fuera = [], ambiguos = [];
  for (const c of candidatos) {
    const empatan = candidatos.filter((o) => o !== c
      && [...c.sostienen].every((w) => o.sostienen.has(w)));
    if (empatan.length) ambiguos.push({ lid: c.it.lid, nombre: c.it.nombre, frase: tramo.trim(), empatan: empatan.map((o) => o.it.nombre) });
    else fuera.push(c.it.lid);
  }
  return { fuera, ambiguos };
}

/**
 * Reconcilia la propuesta del modelo contra el carrito que ya existía.
 *
 * `opciones`:
 *   mensaje                  lo que el cliente dijo en ESTE turno. Un CAMBIO
 *                            —quitar, otra cantidad— es un acto de este turno.
 *   textoCiclo               todo lo que el cliente lleva dicho en el ciclo. Lo
 *                            que el pedido ES se sostiene con toda la conversación,
 *                            no solo con el último mensaje.
 *   datoOperativoPendiente   QUÉ preguntó el backend ('direccion', 'modalidad'…).
 *                            Si su respuesta lleva números que no son cantidades
 *                            —una dirección, un teléfono— ningún número de ese
 *                            mensaje cambia cuánta comida hay.
 *
 * Devuelve `{ carrito, cambios }`. `cambios` no es solo observabilidad: lleva lo
 * que NO se aplicó (`congelados`, `sinRespaldo`, `ambiguos`) para que el turno
 * pueda preguntar en vez de adivinar.
 */
export function reconciliar(carritoPrevio, propuesta, opciones = {}) {
  const mensaje = String(opciones.mensaje || '');
  const ctx = {
    mensaje,
    // Sin ciclo explícito, el mensaje del turno es todo lo que sabemos del
    // cliente. Es el modo en que corren las pruebas de unidad del módulo.
    textoCiclo: String(opciones.textoCiclo || mensaje),
    datoOperativoPendiente: opciones.datoOperativoPendiente ?? false,
  };
  const previo = (carritoPrevio && Array.isArray(carritoPrevio.items))
    ? { items: carritoPrevio.items.map((i) => normalizarItem(i, i.lid)), datos: { ...(carritoPrevio.datos || {}) } }
    : carritoVacio();

  const propuestos = Array.isArray(propuesta?.items)
    ? propuesta.items.filter((i) => String(i?.nombre || '').trim() || i?.id !== undefined)
    : [];

  const cambios = { agregados: [], actualizados: [], conservados: [], quitados: [],
    congelados: [], sinRespaldo: [], ambiguos: [] };

  // 1) Emparejar cada artículo propuesto con uno del carrito. Voraz por mejor
  //    parecido, uno a uno: dos renglones del mismo producto no se fusionan.
  const libres = new Set(previo.items.map((i) => i.lid));
  const porLid = new Map(previo.items.map((i) => [i.lid, i]));
  const nuevos = [];
  const emparejados = new Map();
  for (const p of propuestos) {
    let mejor = null, mejorPuntos = 0;
    for (const lid of libres) {
      const puntos = parecido(porLid.get(lid), p);
      if (puntos > mejorPuntos) { mejor = lid; mejorPuntos = puntos; }
    }
    if (mejor) { libres.delete(mejor); emparejados.set(mejor, p); }
    else nuevos.push(p);
  }

  // 2) Recorrer el carrito EN SU ORDEN: lo emparejado se fusiona campo a campo,
  //    lo que el modelo no mencionó se conserva tal cual. Aquí vive la invariante.
  const items = [];
  for (const it of previo.items) {
    const p = emparejados.get(it.lid);
    if (p) {
      const hermanos = previo.items.filter((o) => o.lid !== it.lid);
      const fusionado = fusionar(it, p, ctx, hermanos, cambios);
      items.push(fusionado);
      cambios.actualizados.push(fusionado.nombre);
    } else {
      items.push(it);
      cambios.conservados.push(it.nombre);
    }
  }

  // 3) Artículos NUEVOS: solo entran los que el cliente nombró.
  //
  //    El modelo añadía tres Coca-Colas mientras el cliente contestaba «Para
  //    recoger». Decir que el cliente lo vería en el resumen no es una
  //    protección: el resumen confirma una interpretación respaldada, no le
  //    traslada al cliente la tarea de descubrir invenciones.
  //    La puerta se aplica cuando YA hay pedido que proteger. La primera
  //    propuesta de un ciclo es la lectura que hace el modelo de lo que el
  //    cliente acaba de pedir, y puede venir de una foto o de un audio, donde
  //    el texto del cliente no nombra nada; exigir ahí la palabra escrita
  //    dejaría sin pedido a quien manda el menú fotografiado. Esa primera
  //    lectura ya la auditan las menciones y el validador.
  const hayPedidoQueProteger = previo.items.length > 0;
  for (const p of nuevos) {
    const item = normalizarItem(p);
    if (!hayPedidoQueProteger || nombradoPorElCliente(item.nombre, ctx.textoCiclo)) {
      items.push(item);
      cambios.agregados.push(item.nombre);
    } else {
      cambios.sinRespaldo.push({ nombre: item.nombre, campo: 'articulo', cantidad: item.cantidad });
    }
  }

  // 4) Quitar SOLO lo que el cliente pidió quitar con sus palabras, y solo
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
  const senalados = articulosQueElClientePidioQuitar({ items }, mensaje);
  cambios.ambiguos.push(...senalados.ambiguos.filter((a) => quitables.has(a.lid)));
  const aQuitar = new Set(senalados.fuera.filter((lid) => quitables.has(lid)));
  const finales = items.filter((i) => {
    if (!aQuitar.has(i.lid)) return true;
    cambios.quitados.push(i.nombre);
    return false;
  });

  // 5) Datos operativos: se acumulan, nunca se pierden por omisión, y JAMÁS
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

/**
 * Lo que el reconciliador NO aplicó, en una frase para el cliente.
 *
 * Solo se pregunta por lo AMBIGUO —dos artículos caben en su «quita»— porque
 * ahí la duda es sobre lo que el cliente dijo y él es el único que puede
 * resolverla.
 *
 * Lo INVENTADO por el modelo no se menciona. Preguntarle «¿querías una Coca?»
 * a alguien que nunca la pidió es ofrecerle un producto en su propia voz, y un
 * «sí» de cortesía lo acaba pagando. Se descarta y queda en el log del negocio,
 * que es de quien es el problema.
 */
export function preguntaPorLoNoAplicado(cambios) {
  return (cambios?.ambiguos || []).slice(0, 2)
    .map((a) => `¿Cuál quito, "${a.nombre}" o "${a.empatan[0]}"? Los dejo los dos hasta que me digas.`)
    .join(' ');
}
