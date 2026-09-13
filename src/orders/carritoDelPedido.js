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
// La primera versión protegía el ARTÍCULO y nada más adentro, y la segunda
// auditoría enseñó que eso no alcanza: con el cliente diciendo solo «Para
// recoger», el platillo volvía con cantidad 1 en vez de 2, sin su salsa y sin
// su «sin cebolla»; «quita los hotcakes tradicionales» borraba también los de
// sartén; y el modelo colaba tres Coca-Colas que nadie pidió.
//
// Así que la regla vive a nivel de CAMPO, y cada cambio necesita autorización:
//
//   omitir            no borra nada: ni el artículo, ni su cantidad, ni sus
//                     modificadores, ni sus notas;
//   cambiar un campo  exige que lo que el cliente dijo lo sostenga;
//   agregar           exige que el cliente haya pedido el producto;
//   quitar            exige un verbo de quitar Y que la frase identifique UN
//                     artículo: si dos caben igual de bien, no se quita
//                     ninguno y se pregunta;
//   datos operativos  —modalidad, pago, nombre, dirección— nunca tocan comida.
//
// ── Y de DÓNDE sale el respaldo ──────────────────────────────────────────
//
// Tercera vuelta. «Lo que el cliente dijo» no era una sola cosa: cuando llega
// una foto, el canal sustituye la marca de la imagen por el bloque de análisis
// DENTRO del mensaje del cliente, así que la percepción del modelo de visión
// viajaba pegada a sus palabras y autorizaba igual que ellas. Un producto que
// la visión creyó ver entraba al pedido con su cantidad, su modificador y su
// nota, sin que nadie lo hubiera nombrado.
//
//   DICHO       lo escribió (o lo dictó) el cliente  → autoriza
//   PERCIBIDO   sale de su foto, pero lo interpretó el modelo → se pregunta
//   INVENTADO   no está en ninguna de las dos → ni entra ni se menciona
//
// La separación la hace `procedenciaDeEvidencia.js`, por la FORMA del bloque.
//
// ── Y los términos del catálogo ──────────────────────────────────────────
//
// «Ponme un refresco» no comparte una letra con «Coca Cola». Resolverlo dentro
// del modelo sería devolverle la autoridad; resolverlo con una lista de
// sinónimos escrita a mano sería una lista que envejece. Se resuelve con el
// catálogo del propio negocio —los nombres de sus categorías y de sus
// productos, que ya construye `terminosDelCatalogo`— y con una regla:
//
//   el término cubre UN producto     → puede identificarlo
//   el término cubre VARIOS          → no se escoge: se pregunta
//
// Cada artículo lleva un identificador local estable (`lid`) que no sale nunca
// hacia el modelo: sirve para seguirle la pista entre turnos aunque cambie de
// nombre al elegir la presentación ("Chilaquiles" -> "Chilaquiles Sencillos").
import { palabrasQueLaSostienen, fuerzaDeEvidencia } from './evidenciaDeEleccion.js';
import { procedenciaDelCiclo } from './procedenciaDeEvidencia.js';

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

/**
 * ¿Algún término del catálogo que el cliente dijo cubre este producto?
 *
 * `terminos` es lo que ya construye `terminosDelCatalogo`: cada nombre de
 * categoría, producto y opción, con los productos que ofrece. Los que sirven
 * aquí son los de categoría, que es la forma que tiene un término genérico en
 * la carta de cada negocio: «Refrescos», «Bebidas», «Postres».
 *
 * No hay lista de sinónimos en el código: si un negocio quiere que «refresco»
 * funcione, así se llama su categoría. Es configuración suya.
 *
 * Devuelve el término MÁS específico que lo cubre (el que ofrece menos), para
 * que «refrescos» gane sobre «bebidas» cuando existan los dos.
 */
function terminoQueLoCubre(nombreProducto, dicho, terminos) {
  if (!Array.isArray(terminos) || !terminos.length) return null;
  const objetivo = norm(nombreProducto);
  let mejor = null;
  for (const t of terminos) {
    const ofrece = (t?.ofrece || []).filter(Boolean);
    if (!ofrece.length) continue;
    // Un término que es EL PROPIO nombre del producto no aporta nada: si el
    // cliente lo dijo, la comprobación directa ya lo resolvió.
    if (ofrece.length === 1 && norm(ofrece[0]) === norm(t?.nombre || '')) continue;
    if (!ofrece.some((p) => norm(p) === objetivo)) continue;
    if (!nombradoPorElCliente(t.nombre, dicho)) continue;
    if (!mejor || ofrece.length < mejor.ofrece.length) mejor = { nombre: t.nombre, ofrece };
  }
  return mejor;
}

/**
 * De dónde sale el permiso para meter este producto al pedido.
 *
 *   dicho             el cliente lo nombró                   → entra
 *   termino_unico     dijo un término que solo puede ser ese → entra
 *   termino_ambiguo   dijo un término que cubre varios       → se pregunta cuál
 *   percibido         solo aparece en el análisis de su foto → se pregunta
 *   ninguna           nadie lo pidió                         → ni entra ni se menciona
 */
function procedenciaDelArticulo(nombre, ctx) {
  if (nombradoPorElCliente(nombre, ctx.dicho)) return { autoriza: true, via: 'dicho' };
  const termino = terminoQueLoCubre(nombre, ctx.dicho, ctx.terminos);
  if (termino) {
    if (termino.ofrece.length === 1) return { autoriza: true, via: 'termino_unico', termino: termino.nombre };
    return { autoriza: false, via: 'termino_ambiguo', termino: termino.nombre, candidatos: termino.ofrece };
  }
  if (nombradoPorElCliente(nombre, ctx.percibido)) return { autoriza: false, via: 'percibido' };
  return { autoriza: false, via: 'ninguna' };
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

// Quitar un INGREDIENTE no se dice como quitar un platillo: «sin cebolla» no
// lleva verbo. Se mira el mismo tramo —desde la señal hasta donde el cliente
// empieza a pedir otra cosa— y se exige que la opción esté nombrada ahí.
const QUITA_OPCION = new RegExp('\\b(' + [
  'sin', 'quita', 'quitar', 'quitame', 'qu[ií]tame', 'quitale', 'qu[ií]tale',
  'elimina', 'borra', 'saca', 'retira', 'ya no', 'no le pongas', 'no le ponga',
  'd[ée]jalo sin', 'dejalo sin', 'd[ée]jala sin', 'dejala sin',
].join('|') + ')\\b', 'i');

function elClientePidioQuitarLaOpcion(opcion, mensaje) {
  const bruto = String(mensaje || '');
  const senal = QUITA_OPCION.exec(bruto);
  if (!senal) return false;
  const resto = bruto.slice(senal.index + senal[0].length);
  const corte = EMPIEZA_A_PEDIR.exec(resto);
  const tramo = corte ? resto.slice(0, corte.index) : resto;
  return palabrasQueLaSostienen(opcion, tramo).size > 0;
}
/**
 * ¿La frase separa a ESTE artículo de los demás del carrito?
 *
 * Misma regla que desempata las opciones hermanas de un grupo: si otro artículo
 * explica TODO lo que explica este, la frase no los separa. Sirve para tres
 * preguntas distintas —de cuál es esta cantidad, de cuál es este ingrediente,
 * cuál quitar— y por eso vive una sola vez.
 */
function laFraseLoSenala(item, hermanos, texto) {
  const mias = palabrasQueLaSostienen(item.nombre, texto);
  if (!mias.size) return false;
  for (const h of hermanos) {
    const suyas = palabrasQueLaSostienen(h.nombre, texto);
    let explicaTodoLoMio = true;
    for (const w of mias) if (!suyas.has(w)) { explicaTodoLoMio = false; break; }
    if (explicaTodoLoMio) return false;
  }
  return true;
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
  if (!elClienteDijoElNumero(nueva, ctx.mensajeDicho)) return false;
  if (!hermanos.length) return true;
  // «Mejor dos» no nombra nada, y sin embargo dice de cuál: del que se venía
  // hablando. Esa atribución no la puede hacer esta función —no sabe qué
  // renglón está en foco ni desde cuándo— y la hace `referenciasDelCliente`,
  // con su regla de siempre: uno se resuelve, varios se preguntan, y el foco
  // solo cuenta si es reciente.
  //
  // Lo que NO se relaja es el número: sigue teniendo que estar en lo que el
  // cliente acaba de escribir, y seguir siendo plausible, y el turno no puede
  // ser la respuesta a una pregunta con números ajenos. Se sustituye la
  // atribución por otra atribución, no se quita la comprobación.
  if (ctx.atribuidos?.has(item.lid)) return true;
  return laFraseLoSenala(item, hermanos, ctx.mensajeDicho);
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
    if (concreta || procedenciaDelArticulo(p.nombre, ctx).autoriza) {
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
    if (p.cantidad !== previo.cantidad) {
      cambios.autorizados.push({ lid: previo.lid, nombre: previo.nombre, campo: 'cantidad',
        via: 'numero_en_el_mensaje', valor: p.cantidad });
    }
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
      && viejos.get(grupo).some((o) => fuerzaDeEvidencia(o, ctx.dicho) > 0);
    const donde = (yaElegido && loViejoEraSuyo) ? ctx.mensajeDicho : ctx.dicho;
    // Agregar y quitar dentro de un grupo se autorizan distinto:
    //
    //   algo entra   -> basta con que el cliente lo haya dicho («mejor la roja»
    //                   sustituye la suiza: lo nuevo es la autorización);
    //   solo se va    -> hace falta que pidiera QUITARLO («sin cebolla»). Si no,
    //                   una propuesta que se come una guarnición en silencio la
    //                   borraría, que es justo la falla que esto cierra.
    const previas = viejos.get(grupo) || [];
    const agregadas = opciones.filter((o) => !previas.some((v) => norm(v) === norm(o)));
    const quitadas = previas.filter((v) => !opciones.some((o) => norm(o) === norm(v)));
    // Con varios artículos en el carrito, un ingrediente cambia el que la frase
    // señala: lo que el cliente dijo del plato A no vacía el grupo del B. Solo
    // se exige cuando OTRO artículo compite por esa misma frase.
    const compiteOtro = yaElegido && hermanos.some((h) => palabrasQueLaSostienen(h.nombre, donde).size > 0);
    const esMio = !compiteOtro || laFraseLoSenala(previo, hermanos, donde);
    // Opción por opción, no el grupo entero: si el cliente pidió cebolla y el
    // modelo añadió pepinillos, entra la cebolla y se queda fuera el pepinillo.
    // Rechazar el grupo completo castigaba lo que el cliente sí había pedido.
    const agregadasOk = esMio ? agregadas.filter((o) => fuerzaDeEvidencia(o, donde) > 0) : [];
    // Un intercambio 1:1 —una opción sale, otra entra, y el grupo tenía una
    // sola— es cambiar de idea: «mejor la salsa roja». Lo nuevo autoriza que lo
    // viejo salga, sin pedir además un «quita la suiza» que nadie dice.
    // En cualquier otro caso, quitar necesita su propia evidencia: si no, una
    // propuesta que se come una guarnición en silencio la borraría.
    const esIntercambio = previas.length === 1 && opciones.length === 1 && agregadasOk.length === 1;
    const quitadasOk = esIntercambio ? quitadas
      : (esMio ? quitadas.filter((o) => elClientePidioQuitarLaOpcion(o, ctx.mensajeDicho)) : []);
    const resultado = previas
      .filter((v) => !quitadasOk.some((x) => norm(x) === norm(v)))
      .concat(agregadasOk);
    const rechazadas = [
      ...agregadas.filter((o) => !agregadasOk.some((x) => norm(x) === norm(o))),
      ...quitadas.filter((o) => !quitadasOk.some((x) => norm(x) === norm(o))),
    ];
    if (resultado.length) fusionados.set(grupo, resultado);
    if (agregadasOk.length || quitadasOk.length) {
      cambios.autorizados.push({ lid: previo.lid, nombre: previo.nombre, campo: `modificador:${grupo}`,
        via: donde === ctx.mensajeDicho ? 'este_turno' : 'ciclo' });
    }
    if (rechazadas.length) {
      const donde_ = yaElegido ? cambios.congelados : cambios.sinRespaldo;
      donde_.push({ lid: previo.lid, nombre: previo.nombre, campo: `modificador:${grupo}`,
        propuesto: rechazadas, conservado: previas });
    }
  }

  salida.modificadores = desdeGrupos(fusionados);

  // NOTAS. Una nota se escribió porque el cliente la pidió; el silencio del
  // modelo no la retira. Se reemplaza solo por otra que el cliente sostenga.
  if (p.notas && norm(p.notas) !== norm(previo.notas)) {
    if (fuerzaDeEvidencia(p.notas, ctx.dicho) > 0) {
      salida.notas = p.notas;
      cambios.autorizados.push({ lid: previo.lid, nombre: previo.nombre, campo: 'notas', via: 'ciclo' });
    }
    else cambios.congelados.push({ lid: previo.lid, nombre: previo.nombre, campo: 'notas',
      propuesto: p.notas, conservado: previo.notas });
  }

  return salida;
}

/**
 * Un artículo NUEVO, con sus campos depurados.
 *
 * Que el cliente haya pedido el producto no le da permiso al modelo para
 * decidir cuántos, con qué y con qué nota. Cada campo se queda solo si algo de
 * lo que el cliente dijo lo sostiene; si no, cae al valor neutro. Es la misma
 * regla del artículo ya existente, aplicada desde el primer turno: aparecer en
 * la primera salida del modelo no da autoridad.
 */
function depurarNuevo(item, ctx, cambios) {
  const salida = { ...item };
  if (item.cantidad !== 1 && !elClienteDijoElNumero(item.cantidad, ctx.dicho)) {
    cambios.congelados.push({ nombre: item.nombre, campo: 'cantidad', propuesto: item.cantidad, conservado: 1 });
    salida.cantidad = 1;
  }
  const grupos = porGrupo(item.modificadores);
  const limpios = new Map();
  for (const [grupo, opciones] of grupos) {
    const respaldadas = opciones.filter((o) => fuerzaDeEvidencia(o, ctx.dicho) > 0);
    if (respaldadas.length) limpios.set(grupo, respaldadas);
    const fuera = opciones.filter((o) => !respaldadas.includes(o));
    if (fuera.length) cambios.sinRespaldo.push({ nombre: item.nombre, campo: `modificador:${grupo}`, propuesto: fuera });
  }
  salida.modificadores = desdeGrupos(limpios);
  if (item.notas && fuerzaDeEvidencia(item.notas, ctx.dicho) === 0) {
    cambios.sinRespaldo.push({ nombre: item.nombre, campo: 'notas', propuesto: item.notas });
    salida.notas = '';
  }
  return salida;
}

// ── QUITAR ───────────────────────────────────────────────────────────────
//
// Formas de pedir que algo salga del pedido. La lista es de VERBOS y giros, no
// de productos: lo que decide QUÉ se va no es el verbo, es la identificación.
// Por eso se puede ser generoso aquí y estricto allá.
const PIDE_QUITAR = new RegExp('\\b(' + [
  'quita', 'quitar', 'quitame', 'qu[ií]tame', 'quitale', 'qu[ií]tale',
  'elimina', 'eliminar', 'borra', 'borrar', 'cancela', 'cancelar',
  'saca', 'sacar', 'remueve', 'remover', 'retira', 'retirar',
  'ya no quiero', 'ya no', 'mejor no', 'olvida', 'olvidate de', 'olv[ií]date de',
  'd[ée]jalo sin', 'dejalo sin', 'd[ée]jala sin', 'dejala sin',
  'sin el', 'sin la', 'sin los', 'sin las',
].join('|') + ')\\b', 'i');

// Dónde DEJA de alcanzar. Un mensaje puede quitar y pedir a la vez —es la forma
// normal de sustituir algo— y entonces el verbo de quitar solo manda hasta que
// el cliente empieza a pedir lo nuevo.
//
// Sin este límite, «quita los hotcakes y mejor ponme un bowl de chilaquiles»
// vaciaba el pedido entero: el mensaje traía un verbo de quitar y nombraba
// todos los artículos, así que todos se iban.
const EMPIEZA_A_PEDIR = new RegExp('\\b(' + [
  'ponme', 'p[oó]nme', 'pon', 'agrega', 'agregame', 'ag[rR][ée]game', 'a[ñn]ade', 'a[ñn][aá]deme',
  'dame', 'quiero', 'mejor dame', 'mandame', 'm[aá]ndame', 'traeme', 'tr[aá]eme',
  'sumale', 's[uú]male', 'en su lugar', 'cambialo', 'c[aá]mbialo',
].join('|') + ')\\b', 'i');

// Las dos preguntas anteriores, sueltas, para quien necesite CLASIFICAR sin
// resolver. El clasificador de intenciones del mesero las usa: escribir una
// segunda lista de verbos de quitar sería garantizar que las dos se separen, y
// que el bot entienda «sácalo» en un módulo y no en el otro.
export const hayVerboDeQuitar = (texto) => PIDE_QUITAR.test(String(texto || ''));
export const hayVerboDePedir = (texto) => EMPIEZA_A_PEDIR.test(String(texto || ''));

/**
 * Qué artículos señala el cliente al pedir que se quite algo.
 *
 * Devuelve `{ fuera, ambiguos }`. Hacen falta un verbo de quitar Y que la frase
 * identifique UN artículo dentro de su alcance.
 *
 * Identificar no es compartir una palabra. «Quita los hotcakes tradicionales»
 * con "Hotcakes Tradicionales" y "Hotcakes de Sartén" en el carrito señala a
 * uno solo, aunque la palabra "hotcakes" esté en los dos. Si otro candidato
 * explica TODO lo que explica este, la frase no los separa —«quita los
 * hotcakes», a secas— y entonces no se quita ninguno: se pregunta. Borrar de
 * más es el error caro; preguntar, no.
 *
 * Un pronombre —«ya no quiero ese», «el otro no»— no nombra ningún artículo, así
 * que no hay candidatos y no se quita nada. No hace falta una regla aparte para
 * los pronombres: caen solos, que es la señal de que la regla es la correcta.
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
 *   mensaje                  lo que llegó en ESTE turno. Un CAMBIO —quitar, otra
 *                            cantidad— es un acto de este turno.
 *   textoCiclo               todo lo que ha llegado en el ciclo. Lo que el pedido
 *                            ES se sostiene con toda la conversación.
 *   datoOperativoPendiente   QUÉ preguntó el backend ('direccion', 'modalidad'…).
 *                            Si su respuesta lleva números que no son cantidades
 *                            —una dirección, un teléfono— ningún número de ese
 *                            mensaje cambia cuánta comida hay.
 *   terminos                 el catálogo visto como términos (`terminosDelCatalogo`):
 *                            permite que «refresco» identifique un producto cuando
 *                            la categoría del negocio se llama así.
 *
 * Los dos textos se parten por procedencia: lo que el cliente escribió autoriza;
 * lo que el sistema percibió de su foto, no.
 *
 * Devuelve `{ carrito, cambios }`. `cambios` no es solo observabilidad: lleva lo
 * que NO se aplicó (`congelados`, `sinRespaldo`, `ambiguos`, `porConfirmar`)
 * para que el turno pueda preguntar en vez de adivinar.
 */
export function reconciliar(carritoPrevio, propuesta, opciones = {}) {
  const mensaje = String(opciones.mensaje || '');
  const textoCiclo = String(opciones.textoCiclo || mensaje);
  const deEsteTurno = procedenciaDelCiclo([mensaje]);
  const delCiclo = procedenciaDelCiclo([textoCiclo]);
  const ctx = {
    mensaje,
    mensajeDicho: deEsteTurno.dicho,
    // Sin ciclo explícito, el mensaje del turno es todo lo que sabemos del
    // cliente. Es el modo en que corren las pruebas de unidad del módulo.
    dicho: delCiclo.dicho,
    percibido: [delCiclo.percibido, deEsteTurno.percibido].filter(Boolean).join(' \n '),
    datoOperativoPendiente: opciones.datoOperativoPendiente ?? false,
    terminos: Array.isArray(opciones.terminos) ? opciones.terminos : [],
    // Renglones que una capa de arriba identificó sin que la frase los nombre
    // («mejor dos» → el que está en foco). Vacío por defecto: sin esto, el
    // comportamiento es exactamente el de antes del mesero.
    atribuidos: new Set(Array.isArray(opciones.atribuidoPorLid) ? opciones.atribuidoPorLid.map(String) : []),
  };
  const previo = (carritoPrevio && Array.isArray(carritoPrevio.items))
    ? { items: carritoPrevio.items.map((i) => normalizarItem(i, i.lid)), datos: { ...(carritoPrevio.datos || {}) } }
    : carritoVacio();

  const propuestos = Array.isArray(propuesta?.items)
    ? propuesta.items.filter((i) => String(i?.nombre || '').trim() || i?.id !== undefined)
    : [];

  // `autorizados` es la otra mitad de la contabilidad: no solo qué se bloqueó,
  // también QUÉ evidencia dejó pasar cada cambio que sí se aplicó. Es lo que
  // permite auditar un turno real sin volver a razonarlo a mano.
  const cambios = { agregados: [], actualizados: [], conservados: [], quitados: [],
    congelados: [], sinRespaldo: [], ambiguos: [], porConfirmar: [], autorizados: [] };

  // 1) Emparejar cada artículo propuesto con uno del carrito. Voraz por mejor
  //    parecido, uno a uno: dos renglones del mismo producto no se fusionan.
  const libres = new Set(previo.items.map((i) => i.lid));
  const porLid = new Map(previo.items.map((i) => [i.lid, i]));
  const nuevos = [];
  const emparejados = new Map();

  // 1a) UN `lid` EXPLÍCITO MANDA SOBRE EL PARECIDO.
  //
  // El modelo nunca ve el `lid`, así que un borrador suyo jamás lo trae y esta
  // vuelta no hace nada — el emparejamiento por parecido sigue siendo el de
  // siempre para todo lo que existía antes del mesero.
  //
  // Quien sí lo trae es el mesero, que resolvió «el primero» o «el otro» con
  // `referenciasDelCliente` y sabe EXACTAMENTE de qué renglón habla. Dejar que
  // el parecido reinterprete eso es cómo «quítale la cebolla al segundo» acaba
  // en el primero cuando los dos platillos son iguales: por parecido empatan, y
  // el desempate lo decide el orden del bucle.
  //
  // Esto no relaja nada: un `lid` que no existe se ignora y el artículo cae al
  // camino normal. Solo permite señalar mejor, no autorizar más.
  for (const p of propuestos) {
    const lid = p?.lid ? String(p.lid) : null;
    if (lid && libres.has(lid)) { libres.delete(lid); emparejados.set(lid, p); }
  }

  for (const p of propuestos) {
    if ([...emparejados.values()].includes(p)) continue;
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

  // 3) Artículos NUEVOS: solo entran los que el cliente pidió, y con los campos
  //    que el cliente sostiene.
  //
  //    El modelo añadía tres Coca-Colas mientras el cliente contestaba «Para
  //    recoger». Decir que el cliente lo vería en el resumen no es una
  //    protección: el resumen confirma una interpretación respaldada, no le
  //    traslada al cliente la tarea de descubrir invenciones.
  for (const p of nuevos) {
    const item = normalizarItem(p);
    const proc = procedenciaDelArticulo(item.nombre, ctx);
    if (proc.autoriza) {
      const limpio = depurarNuevo(item, ctx, cambios);
      items.push(limpio);
      cambios.agregados.push(limpio.nombre);
      cambios.autorizados.push({ nombre: limpio.nombre, campo: 'articulo', via: proc.via,
        ...(proc.termino ? { termino: proc.termino } : {}) });
    } else if (proc.via === 'percibido' || proc.via === 'termino_ambiguo') {
      // Sale de algo que el cliente mandó, pero lo interpretó el sistema. No
      // entra solo; se le pregunta, que es lo que él sí puede resolver.
      cambios.porConfirmar.push({ nombre: item.nombre, motivo: proc.via,
        ...(proc.termino ? { termino: proc.termino } : {}),
        ...(proc.candidatos ? { candidatos: proc.candidatos } : {}) });
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
  //
  //    Se mira SOLO lo que el cliente escribió en ESTE turno: una foto no quita
  //    nada, y lo que dijo hace tres turnos ya se atendió cuando lo dijo.
  const huella = (i) => JSON.stringify([norm(i?.nombre), Number(i?.cantidad) || 1,
    opcionesDe(i).slice().sort(), norm(i?.notas)]);
  const huellaPrevia = new Map(previo.items.map((i) => [i.lid, huella(i)]));
  const intacto = (i) => huellaPrevia.has(i.lid) && huellaPrevia.get(i.lid) === huella(i);
  const quitables = new Set(items.filter(intacto).map((i) => i.lid));
  const senalados = articulosQueElClientePidioQuitar({ items }, ctx.mensajeDicho);
  cambios.ambiguos.push(...senalados.ambiguos.filter((a) => quitables.has(a.lid)));
  const aQuitar = new Set(senalados.fuera.filter((lid) => quitables.has(lid)));

  // QUITAR LO QUE EL CLIENTE SEÑALÓ SIN NOMBRARLO.
  //
  // «Quita el otro» y «ese ya no» son bajas legítimas que esta función no puede
  // ver: `articulosQueElClientePidioQuitar` necesita que la frase NOMBRE el
  // artículo, y un pronombre no nombra nada. Hasta el mesero eso estaba bien —
  // nadie sabía a qué apuntaba el pronombre, así que no quitar era lo correcto.
  //
  // Ahora `referenciasDelCliente` sí lo sabe, y con la misma regla de siempre:
  // un candidato se resuelve, dos se preguntan. Lo que llega aquí es el
  // resultado de esa resolución, no una excusa para saltarse nada:
  //
  //   · el verbo de quitar se sigue exigiendo, y lo comprueba esta función
  //     sobre lo DICHO en este turno — una foto no quita;
  //   · el renglón tiene que existir y estar intacto, igual que los demás;
  //   · si la referencia no resolvió, aquí no llega nada.
  //
  // Sin `quitarPorLid` el comportamiento es exactamente el anterior.
  const porReferencia = Array.isArray(opciones.quitarPorLid) ? opciones.quitarPorLid.map(String) : [];
  if (porReferencia.length && PIDE_QUITAR.test(ctx.mensajeDicho)) {
    for (const lid of porReferencia) {
      if (quitables.has(lid)) aQuitar.add(lid);
    }
  }
  const finales = items.filter((i) => {
    if (!aQuitar.has(i.lid)) return true;
    cambios.quitados.push(i.nombre);
    cambios.autorizados.push({ lid: i.lid, nombre: i.nombre, campo: 'quitar',
      via: porReferencia.includes(i.lid) ? 'la_referencia_lo_identifica' : 'la_frase_lo_identifica' });
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
 * ¿Quedó algún artículo sin respaldo directo?
 *
 * Cuando esto es cierto vale la pena pagar una consulta al catálogo y volver a
 * reconciliar con sus términos: puede que el cliente dijera «un refresco» y el
 * negocio tenga una categoría que se llame así. Mientras sea falso —el caso
 * normal— no se toca la base.
 */
export const podriaResolverloElCatalogo = (cambios) =>
  (cambios?.sinRespaldo || []).some((s) => s.campo === 'articulo');

/**
 * Lo que el reconciliador NO aplicó, en una frase para el cliente.
 *
 * Se pregunta por lo que el cliente PUEDE resolver y de lo que hay rastro suyo:
 *
 *   · dos artículos caben en su «quita» → cuál;
 *   · dijo un término que cubre varios productos → cuál;
 *   · mandó una foto y el sistema creyó ver un producto → si lo quiere.
 *
 * Lo INVENTADO por el modelo no se menciona. Preguntarle «¿querías una Coca?»
 * a alguien que nunca la pidió es ofrecerle un producto en su propia voz, y un
 * «sí» de cortesía lo acaba pagando. Se descarta y queda en el log del negocio,
 * que es de quien es el problema.
 */
export function preguntaPorLoNoAplicado(cambios) {
  const partes = [];
  for (const a of (cambios?.ambiguos || []).slice(0, 2)) {
    partes.push(`¿Cuál quito, "${a.nombre}" o "${a.empatan[0]}"? Los dejo los dos hasta que me digas.`);
  }
  for (const c of (cambios?.porConfirmar || []).slice(0, 2)) {
    if (c.motivo === 'termino_ambiguo') {
      partes.push(`De ${c.termino} tenemos ${c.candidatos.slice(0, 4).join(', ')}. ¿Cuál te sirve?`);
    } else {
      partes.push(`En la foto veo algo parecido a "${c.nombre}". ¿Te lo agrego al pedido?`);
    }
  }
  return partes.join(' ');
}
