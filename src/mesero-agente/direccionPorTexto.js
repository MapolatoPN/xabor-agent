// La dirección de entrega, capturada SIN el modelo.
//
// Con el pedido pidiendo la dirección («¿Cuál es la dirección completa para la
// entrega?»), solo el modelo interpretaba la respuesta. Una falla del
// proveedor la perdía callada (incidente 1-oct-2026) y con la IA apagada el
// pedido a domicilio se quedaba atorado en esa pregunta.
//
// Aquí el texto del cliente se guarda tal cual, por la misma herramienta y con
// las mismas validaciones que usaría el modelo (definir_entrega: respaldo
// textual, zona y tarifa). La respuesta sale del pedido ya guardado, nunca de
// un «anoté tu dirección» escrito antes de saber si se guardó.
//
// Solo toma un mensaje que es ÚNICAMENTE una dirección: cada tramo (línea o
// parte entre comas) tiene que ser parte de un domicilio —calle con número,
// colonia, CP, ciudad, una referencia como «frente al Oxxo»— o cortesía. Lo que
// traiga cualquier otra cosa (un platillo, una nota para la cocina, una hora,
// un pago, una pregunta, una zona como referencia) lo lee el camino de siempre.
// Dos revisiones adversariales del 1-oct encontraron, primero, 103 de 121 y,
// después, 193 de 230 mensajes que no eran solo una dirección aceptados por
// versiones que admitían lo que no estuviera prohibido. Un falso positivo es
// una comanda con la dirección equivocada o un platillo que nunca se agrega;
// un falso negativo es solo una vuelta por el modelo.
//
// La forma de fondo es la fase 1: la dirección en campos del formulario. Esto
// cubre el texto mientras tanto.
import { normalizarEleccion, contieneDecisionDePedido, politicaDelTurno } from './politicaDelTurno.js';
import { consultaInformativaHibrida, betaHibridaActiva } from './experienciaHibrida.js';
import { solicitaAtencionHumana } from '../utils/solicitudPersona.js';
import { autorizaCancelacion } from './contratoConversacional.js';
import { zonasEnDireccion } from './ejecutorDeHerramientas.js';
import { normalizarTipoModalidad } from '../orders/modalidadesDelPedido.js';
import { PENDIENTES } from './estadoCanonico.js';

/** Intentos sin el modelo mientras la pregunta sigue abierta; después, el camino de siempre. */
export const LIMITE_INTENTOS_DIRECCION = 2;
/** El mismo tope que la dirección libre de la tienda en línea. */
export const LARGO_MAXIMO_DIRECCION = 240;

const CONTROLES = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');

/**
 * APAGADA por omisión (decisión de Mario, 1-oct): tres revisiones adversariales
 * siguieron encontrando mensajes que no son solo una dirección y que esta
 * lectura aceptaba. La dirección va en el formulario (fase 1); esto queda para
 * el modo sin IA y solo se prende con `whatsapp_direccion_texto_v1 = 'true'`
 * en configuracion, dentro de la beta híbrida.
 */
export const direccionTextoActiva = (cfg, telefono) => betaHibridaActiva(cfg, telefono)
  && String(cfg?.whatsapp_direccion_texto_v1 ?? '').trim().toLowerCase() === 'true';

/** Saneado como la tienda en línea: sin controles, una línea por tramo, unidas con coma. */
export function limpiarDireccion(texto) {
  return String(texto ?? '').split(/\r?\n/)
    .map((l) => l.replace(CONTROLES, ' ').replace(/\s+/g, ' ').trim().replace(/[,;]+$/, ''))
    .filter(Boolean).join(', ');
}

// ── Lo que hace de un tramo un domicilio ────────────────────────────────
// Palabras que solo aparecen en un domicilio. Las que también son de la
// conversación («casa», «local», «número», «entrada») no cuentan solas.
const CALLE = /\b(?:calle|avenida|av|blvd|boulevard|boulevar|bulevar|privada|priv|prolongacion|prol|carretera|libramiento|colonia|col|fracc|fraccionamiento|residencial|ejido|manzana|mz|mza|lote|lt|esquina|esq|andador|cerrada|circuito|calzada)\b/;
const EDIFICIO = /\b(?:edificio|edif|depto|departamento)\b/;
// Dentro de una zona (una planta, una escuela) o de un edificio: dónde exactamente.
const LUGAR_DENTRO = /\b(?:edificio|edif|puerta|caseta|acceso|entrada|planta|nave|area|oficina|oficinas|piso|salon|aula|cubiculo|modulo|almacen|bodega|recepcion|laboratorio|biblioteca|rectoria|cafeteria|gimnasio|auditorio|vigilancia|coordinacion|departamento|depto|consultorio|cuarto|local|int|interior)\b/;
// «Hidalgo 405», «Zaragoza No. 210», «Morelos #1205-A».
const NOMBRE_Y_NUMERO = /(?:^| )([a-z]{3,})(?: (numero|num|no|n))? (\d{1,5})(?: ?[a-z])?(?= |$)/g;
// Palabras que, seguidas de un número, NO son una calle: «sean 2», «traigo 500».
const NO_ES_CALLE = new Set(['son', 'sean', 'eran', 'somos', 'seran', 'mesa', 'orden', 'pedido', 'folio', 'total',
  'cambio', 'para', 'como', 'unos', 'unas', 'una', 'uno', 'dos', 'tres', 'otro', 'otra', 'mas', 'menos', 'cada',
  'solo', 'con', 'sin', 'los', 'las', 'del', 'que', 'por', 'casi', 'hace', 'desde', 'hasta', 'entre', 'llego',
  'paso', 'estoy', 'voy', 'ahi', 'aqui', 'numero', 'num', 'opcion', 'gracias', 'sale', 'okay', 'pero', 'pues',
  'este', 'esta', 'eso', 'esos', 'esas', 'nada', 'todo', 'todos', 'mis', 'tus', 'sus', 'hola', 'buenas',
  'traigo', 'llevo', 'tengo', 'doy', 'pago', 'pagamos', 'pagan', 'nomas', 'namas', 'puro', 'puros']);
// Un nombre con un número de 1 o 2 cifras solo es una calle si el mensaje
// habla de domicilio: «Quítenle 2 porfa» no; «Matamoros 61, col. Centro» sí.
const LOCALIDAD = /\b(?:col|colonia|centro|fracc|fraccionamiento|infonavit|entre|esquina|esq|frente|enfrente|junto|lado|cerca|atras|casa|porton|sur|norte|oriente|poniente|ote|pte|cp|km|calle|avenida|av|blvd|privada|priv)\b/;

// Vocabulario con el que un tramo es parte de un domicilio (cierre de la cola:
// un tramo sin ninguna de estas palabras, ni zona, ni CP, ni calle con número,
// no se sabe qué es y el mensaje lo lee el modelo).
const VOCABULARIO_DE_DOMICILIO = new RegExp('\\b(?:' + [
  'calle', 'avenida', 'av', 'blvd', 'boulevard', 'boulevar', 'bulevar', 'privada', 'priv', 'prolongacion', 'prol',
  'carretera', 'libramiento', 'colonia', 'col', 'fracc', 'fraccionamiento', 'residencial', 'ejido', 'manzana', 'mz',
  'mza', 'lote', 'lt', 'andador', 'cerrada', 'circuito', 'calzada', 'infonavit', 'rancho', 'granja', 'villas', 'lomas',
  'centro', 'sur', 'norte', 'oriente', 'poniente', 'ote', 'pte', 'cp', 'codigo postal', 'km', 'kilometro',
  'esquina', 'esq', 'entre', 'cruce', 'frente', 'enfrente', 'junto', 'lado', 'cerca', 'atras', 'detras', 'enseguida',
  'pasando', 'despues de', 'antes de la', 'antes del',
  'casa', 'porton', 'reja', 'barda', 'cochera', 'arbol', 'puerta', 'timbre', 'toquen', 'toque', 'tocar',
  'color', 'blanca', 'blanco', 'azul', 'verde', 'roja', 'rojo', 'amarilla', 'amarillo', 'gris', 'negra', 'negro',
  'cafe', 'naranja', 'rosa', 'morada', 'beige', 'piso', 'pisos', 'planta alta', 'planta baja', 'int', 'interior', 'ext',
  'exterior', 'numero', 'num', 'local', 'edificio', 'edif', 'depto', 'departamento', 'cuarto',
  'consultorio', 'oficina', 'area', 'salon', 'aula', 'modulo', 'planta', 'nave', 'caseta', 'acceso', 'entrada',
  'hospital', 'clinica', 'imss', 'issste', 'escuela', 'colegio', 'secundaria', 'primaria', 'preparatoria', 'prepa',
  'universidad', 'iglesia', 'parque', 'plaza', 'tienda', 'oxxo', 'soriana', 'walmart', 'heb', 'farmacia',
  'gasolinera', 'puente', 'cuadra', 'cuadras', 'metros', 'mts', 'aduana', 'maquiladora', 'empresa', 'fabrica',
  'oficinas', 'trabajo', 'toca', 'tocan', 'fuerte', 'via', 'urgencias', 'emergencias', 'sala', 'cama', 'habitacion',
].join('|') + ')\\b');
const CIUDAD = /^(?:(?:en )?(?:piedras negras|p negras|pn|coahuila|coah|nava|allende|villa union|eagle pass|mexico)(?: coahuila| coah| mexico)*)$/;
const CP_SOLO = /^(?:(?:cp|c p|codigo postal) )?\d{5}$/;
// Saludo y cortesía: «Hola buenas», «Mi dirección es», «gracias».
const CORTESIA = new Set(['hola', 'buenas', 'buenos', 'buen', 'dias', 'dia', 'tardes', 'noches', 'que', 'tal', 'gracias',
  'muchas', 'porfa', 'por', 'favor', 'porfavor', 'ok', 'okay', 'si', 'claro', 'listo', 'va', 'sale', 'amigo', 'amiga',
  'joven', 'senorita', 'mi', 'direccion', 'domicilio', 'es', 'la', 'el', 'de', 'seria', 'aqui', 'ahi', 'esta', 'este',
  'bendiciones', 'saludos', 'perfecto', 'excelente', 'buena', 'tarde', 'noche', 'mil', 'tengan', 'tenga']);

// ── Lo que hace que un mensaje NO sea solo una dirección ────────────────
// Preguntas sin signo: «llegan hasta la UTNC», «cuánto cobran a la Cervecera».
const PREGUNTA_SIN_SIGNO = new RegExp('^(?:(?:y|pero|oye|oiga|disculpa|disculpe|una pregunta|pregunta|hola|buenas'
  + '|buenos dias|buenas tardes|buenas noches|que tal) )*(?:si |a poco )?(?:llegan|entregan|reparten|hacen|cobran|cuanto'
  + '|cuanta|cuantos|cuantas|tardan|estan|tienen|manejan|ustedes|donde|como|cual|cuales|que(?! tal\\b)|quien|cuando|puedo'
  + '|pueden|podrian|podria|se puede|sera|seria|es posible)\\b'
  + '|\\b(?:llegan|llega|entregan|reparten|cobran|tardan|cuanto|cuanta|cuantos|cuantas|si llegan|hacen envios?'
  + '|tienen servicio|a que hora|que hora|mandaron|lo mandan|me confirmas|confirman)\\b|\\b(?:verdad|cierto|o no|correcto)$');
// Pedir, cambiar o corregir algo: «agrégale 2 más», «pónganle queso», «ocupo…».
const CAMBIO_DE_PEDIDO = new RegExp('\\b(?:agregas|agregues|agregar|agreguen|anades|traeme|traes|traigan|mandas|manda'
  + '|mandes|manden|enviame|quitas|quites|quiten|cambias|cambien|dame|deme|denme|me das|me da|me trae|incluye|incluyan'
  + '|encargo|encargar|pedir|ordenar|mejor|siempre no|en vez de|en lugar de|tambien|faltaron?|falto|quisiera'
  + '|me gustaria|ocupo|ocupamos|necesito|necesitamos|no le pongan|no le ponga|olvide|se me olvido|lo de siempre'
  + '|pon|pongan|suban|sumen|echen|saquen|traen|trae|traigas|mandan|mandaran)\\b'
  // Imperativos con pronombre: quítale, súbele, pónganle, mándame, tráiganme…
  + '|\\b(?:quit|sub|pon|pong|agreg|anad|sum|ech|mand|traig|trai|sac|borr|aument|cambi|dej)[a-z]*(?:le|les|me|nos)\\b');
// Notas para la cocina: «sin cebolla», «que no pique», «bien doraditos».
const COCINA = /\bsin (?!numero\b|num\b|nombre\b|timbre\b|n\b|pintar\b)[a-z]|\baparte\b|\bcubiertos\b|\bque no (?:pique|lleve|traiga|tenga)\b|\b(?:cebolla|aguacate|crema|cilantro|chiles?|picante|pique|hielo|azucar|popote|popotes|servilleta|doradit[oa]s?|calientes?|frio|fria|poc[oa]|poquit[oa])\b/;
// Corregir o dar dos números: «antes era 407», «ya no vivo en…», «el número de la casa es 407».
const CORRECCION = /\b(?:perdon|perdona|disculpa|disculpe|me equivoque|corrijo|correccion|no es|no era|esta mal|estaba mal|ah no|ya no|el numero (?:de la casa )?es)\b|\bantes\b(?! (?:de|del)\b)|(?:^| )no$/;
// Dos destinos o uno condicional: «Hidalgo 405 o en la UTNC», «si no estoy…».
const ALTERNATIVA = /(?:^| )o(?! sea\b)(?= )|\bsi no (?:estoy|esta|estamos|me encuentras?)\b|\by luego\b|\buno aqui\b/;
const MESES = '(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)';
// Las referencias del domicilio no son cantidades: «y un portón negro», «del
// otro lado», «entre Morelos y 5 de Mayo».
const RASGO_DE_CASA = '(?:porton|reja|barda|arbol|palmera|cochera|barandal|zaguan|camioneta|carro|ventana|puerta|cerca|malla|toldo|jardin)';
const CANTIDAD_O_CORRECCION = new RegExp('\\b(?:sean|eran|son|seran|fueron|somos|seremos|van a ser)\\b'
  + '|\\b(?:otro|otra|otros|otras)\\b(?! (?:lado|cuadra|esquina|casa|acera|calle|banqueta)\\b)'
  + '|\\b(?:personas?|cuentas?|ordenes|platos?|piezas?|porcion|porciones|litros?|ml|vasos?|tenedores?|cucharas?'
  + '|servilletas?|desechables?)\\b|\\b\\d+ mas\\b|\\bnada mas\\b|\\bde cada\\b|\\bextra\\b'
  + `|\\by (?:un|una|unos|unas|dos|tres|cuatro|cinco)\\b(?! ${RASGO_DE_CASA}\\b)|\\by \\d+\\b(?! de ${MESES}\\b)`);
const MODALIDAD = new RegExp('\\b(?:recoger|recojo|recogerlo|recogerla|recogemos|recoge|paso por|pasamos por|voy por'
  + '|vamos por|ir por|paso a traer|lo paso a traer|paso yo|voy yo|vamos nosotros|para llevar|comer|no a domicilio'
  + '|en tienda|estoy en el local)\\b'
  // «frente a la sucursal Banorte» es una referencia, no recoger en sucursal.
  + '|(?<!\\b(?:frente|enfrente|lado|junto|cerca|atras|detras|enseguida)\\b(?: [a-z]+){0,2} )\\bsucursal\\b'
  + '|\\ben el local\\b(?! (?:numero |num |no |n )?\\d)');
const PAGO = /\b(?:efectivo|tarjeta|transferencia|transferir|enlace|link|pago|pagar|pagaria|pagare|cobrame|cobren|cobras|billete|billetes|pesos|dolares|dolar|dlls|dls|usd|cash|spei|qr|voucher|quinientos|vuelto|cambio|feria|total|cuesta|cuestan|precio)\b|\b(?:traiga|traer|traigan|con) (?:la )?terminal\b|\b(?:llevo|traigo|tengo|doy|pagamos|pagan|con) (?:uno )?(?:de |con |a )?\d{3,}\b/;
const NUMERO_EN_LETRA = '(?:una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)';
const HORA = new RegExp('\\b(?:a|para|como a|tipo|antes de|despues de|como para|entre) (?:la|las) (?:\\d+|' + NUMERO_EN_LETRA + ')(?! ?(?:cuadras?|calles?|casas?|metros?|mts|km)\\b)'
  + '|\\b\\d{1,2} ?(?:am|pm|hrs?|horas?)\\b|\\b\\d+ ?(?:min|mins|minutos)\\b'
  + '|\\b(?:manana|hoy|ahorita|al rato|mas tarde|en un rato|mediodia|temprano|fin de semana|entre semana)\\b'
  // «Av. Santo Domingo», «Calle Noche Buena» y «Buenas tarde» no son horas.
  + '|(?<!\\b(?:calle|av|avenida|santo|san|blvd|privada|priv|col|colonia) )\\b(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)\\b'
  + '|(?<!\\bbuenas? )\\b(?:tarde|noche)\\b(?! ?buena\\b)'
  + '|\\b(?:en|dentro de) (?:un|una|media|dos|tres|un par de) (?:horas?|horitas?)\\b|\\bhora y media\\b'
  + '|\\b(?:llego|llegamos|llegare|paso|pasamos|estoy|estare|salgo|voy) (?:yo |como |ahi )?en \\d+'
  + `|\\b(?:para|el dia|dia|hasta|desde) (?:el )?\\d{1,2} de ${MESES}\\b|\\b\\d{1,2} y (?:el )?\\d{1,2} de ${MESES}\\b`
  + '|\\bpara el \\d{1,2}\\b|\\bentre \\d+ y \\d+\\b');
// Fecha al inicio de un tramo: «…, el 15 de octubre». «Esquina con el 5 de Mayo» no.
const FECHA_AL_INICIO = new RegExp(`^el \\d{1,2} de ${MESES}\\b`);
const TELEFONO_EN_BRUTO = /\d{7,}|(?:\d[\s.\-/()]?){10,}|\b\d{3}[\s.-]\d{2}[\s.-]?\d{2}\b/;
const TELEFONO = /\b(?:telefono|tel|celular|cel|whatsapp|whats|llamame|llamar|marcame|marcar|marca al|mi numero|numero de (?:tel|cel|contacto))\b/;
const NO_LA_TENGO = /\b(?:no|ni) (?:tengo|se|me se|recuerdo|me acuerdo|cuento con)\b/;
const OTRO_PEDIDO = /\b(?:pedido|pedidos|orden|folio|ticket|mesa|xab|vez pasada|anterior|la misma|el mismo|lo mismo)\b/;
const PERSONA_O_FACTURA = /\b(?:factura|facturas|facturar|rfc|cfdi|razon social|regimen|a nombre de|mi nombre|me llamo|lo recibe|la recibe|recibe mi|recibe el|recibe la|es para mi|es para el|es para la|de parte de)\b/;

// ── Platillos ───────────────────────────────────────────────────────────
// Bebidas que se piden aunque no estén escritas así en la carta.
const BEBIDAS = ['coca', 'cocas', 'coquita', 'coquitas', 'pepsi', 'sprite', 'fanta', 'refresco', 'refrescos', 'soda',
  'sodas', 'agua', 'aguas', 'jugo', 'jugos', 'cafe', 'cafes', 'cerveza', 'cervezas', 'licuado', 'malteada', 'latte',
  'capuchino', 'cappuccino', 'frappe', 'te'];
const RELLENO_DE_PRODUCTO = new Set(['orden', 'ordenes', 'chico', 'chica', 'grande', 'mediano', 'mediana',
  'extra', 'sencillo', 'sencilla', 'doble', 'especial', 'casa', 'natural', 'normal', 'tradicional', 'tradicionales',
  'combo', 'pieza', 'para', 'con', 'sin']);
// Antes de un platillo, lo que lo vuelve un pedido: «un café», «y 2 hotcakes»,
// «el café sin azúcar», «nomás chilaquiles». Sin esto, «casa verde» o «portón
// café» son referencias.
const ANTES_DE_PLATILLO = new Set(['un', 'una', 'unos', 'unas', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete',
  'ocho', 'nueve', 'diez', 'once', 'doce', 'quince', 'veinte', 'docena', 'medio', 'media', 'otro', 'otra', 'otros',
  'otras', 'mas', 'el', 'la', 'los', 'las', 'y', 'tambien', 'sin', 'con', 'mi', 'mis', 'al', 'del', 'nomas', 'namas',
  'solo', 'puro', 'puros', 'pero', 'ademas', 'aparte', 'igual', 'luego', 'porfa', 'ah', 'olvide', 'tomar', 'beber']);
// «frente a los tacos», «a lado del café»: un lugar, no un pedido.
const LUGAR_ANTES = new Set(['frente', 'enfrente', 'lado', 'junto', 'cerca', 'atras', 'detras', 'enseguida', 'esquina']);
// Palabras de la carta que también son colores, calles o colonias («casa
// verde», «Col. Santa Fe», «César López de Lara»): nunca cuentan solas.
const PLATILLO_AMBIGUO = new Set(['santa', 'cesar', 'verde', 'verdes', 'naranja', 'rosa', 'papa', 'americano',
  'americana', 'mexicana', 'mexicano', 'infantil', 'comida', 'completo', 'clasico', 'ranch', 'rancheros', 'mole',
  'menudo', 'claras', 'envio']);
// Las que también son un lugar («por los tacos», «la casa café»): cuentan solo
// tras un artículo, una cantidad o al inicio del tramo.
const PLATILLO_CON_ARTICULO = new Set(['cafe', 'cafes', 'agua', 'aguas', 'taco', 'tacos', 'barbacoa', 'tortillas',
  'tortilla', 'fruta', 'pan']);

function palabrasDePlatillo(catalogo) {
  const palabras = new Set(BEBIDAS.filter((w) => w.length >= 3));
  for (const p of (catalogo || []).flatMap((c) => c?.productos || [])) {
    for (const w of normalizarEleccion(p?.nombre).split(' ')) {
      if (w.length >= 4 && !/\d/.test(w) && !RELLENO_DE_PRODUCTO.has(w)) palabras.add(w);
    }
  }
  return palabras;
}

const raiz = (w, platillos) => [w, w.replace(/es$/, ''), w.replace(/s$/, '')].find((v) => platillos.has(v));

/**
 * «y 2 hotcakes», «el café sin azúcar», «Hidalgo 405 chilaquiles verdes»: un
 * platillo de la carta en algún tramo. Un nombre propio de la carta
 * (chilaquiles, hotcakes, refresco) cuenta en cualquier lugar; uno que también
 * es lugar (café, tacos), solo tras artículo o cantidad; uno que también es
 * color o calle (verde, Santa Fe), nunca.
 */
function pidePlatillo(tramos, platillos) {
  return tramos.some((tramo) => {
    const w = tramo.split(' ').filter(Boolean);
    return w.some((p, i) => {
      const r = raiz(p, platillos);
      if (!r || PLATILLO_AMBIGUO.has(r) || PLATILLO_AMBIGUO.has(p)) return false;
      if (w.slice(Math.max(0, i - 3), i).some((x) => LUGAR_ANTES.has(x))) return false;
      if (i > 0 && CALLE.test(w[i - 1])) return false; // «Calle Moka 12»
      const pedido = i === 0 || ANTES_DE_PLATILLO.has(w[i - 1]) || /^\d+$/.test(w[i - 1]);
      return pedido || !(PLATILLO_CON_ARTICULO.has(r) || PLATILLO_CON_ARTICULO.has(p));
    });
  });
}

// Un tramo que empieza con una cantidad pide algo, esté o no en la carta
// («2 burritos», «dos tortas»). Las medidas del domicilio no: «2 cuadras al norte».
const CANTIDAD_AL_INICIO = /^(?:\d{1,2}|un|una|unos|unas|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez) (?!(?:cuadras?|casas?|calles?|metros?|mts|km|pisos?|cuartos?)\b)[a-z]{3,}/;

// ── Zonas ───────────────────────────────────────────────────────────────
const nombresDeZona = (z) => [z?.nombre, ...String(z?.nombre || '').split('/')].map(normalizarEleccion).filter(Boolean);
const patronDeNombre = (n) => n.split(' ').join(' *');

/** Una zona que también es platillo («Coca Cola»): no se distingue del refresco sin el modelo. */
const zonaQueEsPlatillo = (z, platillos) => nombresDeZona(z).some((n) => n.split(' ').some((w) => raiz(w, platillos)));

function sinZonas(t, zonas) {
  let resto = ` ${t} `;
  for (const z of zonas) for (const n of nombresDeZona(z)) {
    resto = resto.replace(new RegExp(` ${patronDeNombre(n)}(?= )`, 'g'), ' ');
  }
  return resto.replace(/\s+/g, ' ').trim();
}

const SIN_NUMERO = /\b(?:s n|sn|sin numero|sin num)\b/;
/**
 * Una calle con número (o S/N) o un nombre con número de casa. Con `lugares`
 * en falso no cuenta «edificio 3» ni «puerta 2»: dentro de una zona eso es el
 * lugar, no una calle.
 */
function calleConNumero(tramo, enMensaje, { lugares = true } = {}) {
  if (CALLE.test(tramo) && (/\d/.test(tramo) || SIN_NUMERO.test(tramo))) return true;
  for (const m of tramo.matchAll(NOMBRE_Y_NUMERO)) {
    if (NO_ES_CALLE.has(m[1]) || (!lugares && LUGAR_DENTRO.test(m[1]))) continue;
    if (numeroDeCasa(m) || LOCALIDAD.test(enMensaje) || LUGAR_DENTRO.test(enMensaje)) return true;
  }
  return false;
}

/** «Hidalgo 405», «Pino #45», «Pino No. 45»: el número es claramente de casa. */
const numeroDeCasa = (m) => !!m[2] || (m[3].length >= 3 && m[3].length <= 4);

/** Un mensaje de dos palabras solo es una dirección si es nombre y número de casa: «Hidalgo 405». */
const anclaCorta = (tramo) => [...tramo.matchAll(NOMBRE_Y_NUMERO)]
  .some((m) => !NO_ES_CALLE.has(m[1]) && !LUGAR_DENTRO.test(m[1]) && numeroDeCasa(m));

/** El tramo tiene forma de domicilio: calle con número, nombre con número de casa o edificio con número. */
const esAncla = (tramo, enMensaje) => calleConNumero(tramo, enMensaje) || (EDIFICIO.test(tramo) && /\d/.test(tramo));

/** El tramo es parte de un domicilio, cortesía, CP o ciudad. Lo demás no se sabe qué es. */
function tramoDeDomicilio(tramo, zonas, enMensaje) {
  const palabras = tramo.split(' ').filter(Boolean);
  if (!palabras.length || palabras.every((w) => CORTESIA.has(w))) return true;
  if (CP_SOLO.test(tramo) || CIUDAD.test(tramo)) return true;
  if (zonasEnDireccion({ pedidos: { zonas_entrega: zonas } }, tramo).length) return true;
  return VOCABULARIO_DE_DOMICILIO.test(tramo) || LUGAR_DENTRO.test(tramo) || esAncla(tramo, enMensaje);
}

// Tramos: líneas y partes entre comas, punto y coma o puntos que terminan una
// oración (no los de «Col.», «Av.», «No.»). Sin perder el número de «No. 210».
const ABREVIATURAS = /\b(c|cll|calz|col|av|no|num|n|ext|int|fracc|mz|mza|lt|blvd|prol|priv|depto|edif|esq|cp|c\.p|sr|sra|dr|ing|lic|gral|nte|ote|pte)\.(?=\s)/gi;
function tramosDe(direccion) {
  return direccion.replace(ABREVIATURAS, '$1').replace(/#\s*(?=\d)/g, ' num ')
    .split(/[,;!¡+]|\.(?=\s|$)|[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u)
    .map(normalizarEleccion).filter(Boolean);
}

/**
 * ¿El mensaje es, completo, una dirección de entrega? Sin estado: solo el
 * texto, las zonas y la carta. Devuelve `{ direccion }` saneada o
 * `{ direccion: null, motivo }` con la primera regla que la descartó.
 */
export function evaluarDireccion(mensaje, { reglas = null, catalogo = [] } = {}) {
  const no = (motivo) => ({ direccion: null, motivo });
  const bruto = String(mensaje ?? '');
  if (!bruto.trim()) return no('vacio');
  if (/[?¿]/.test(bruto)) return no('pregunta');
  if (/\$/.test(bruto)) return no('pago');
  if (TELEFONO_EN_BRUTO.test(bruto)) return no('telefono');
  if (/\b\d{1,2}:\d{2}\b/.test(bruto)) return no('hora');
  const direccion = limpiarDireccion(bruto);
  if (!direccion) return no('vacio');
  if (direccion.length > LARGO_MAXIMO_DIRECCION) return no('largo');
  const t = normalizarEleccion(direccion);
  const palabras = t.split(' ').filter(Boolean);
  if (palabras.length < 2) return no('corto');
  if (PREGUNTA_SIN_SIGNO.test(t)) return no('pregunta');
  if (contieneDecisionDePedido(bruto) || CAMBIO_DE_PEDIDO.test(t)) return no('decision');
  if (politicaDelTurno(bruto).soloLectura || consultaInformativaHibrida(bruto)) return no('consulta');
  if (solicitaAtencionHumana(bruto)) return no('persona');
  if (autorizaCancelacion(bruto)) return no('cancelacion');
  if (CORRECCION.test(t)) return no('correccion');
  if (ALTERNATIVA.test(t)) return no('alternativa');
  if (COCINA.test(t)) return no('cocina');
  if (CANTIDAD_O_CORRECCION.test(t)) return no('cantidad');
  if (MODALIDAD.test(t)) return no('modalidad');
  if (PAGO.test(t)) return no('pago');
  if (HORA.test(t)) return no('hora');
  if (TELEFONO.test(t)) return no('telefono');
  if (NO_LA_TENGO.test(t)) return no('sin_dato');
  if (OTRO_PEDIDO.test(t)) return no('otro_pedido');
  if (PERSONA_O_FACTURA.test(t)) return no('persona_o_factura');
  const tramos = tramosDe(direccion);
  if (tramos.some((tramo) => FECHA_AL_INICIO.test(tramo))) return no('hora');
  const platillos = palabrasDePlatillo(catalogo);
  const zonas = Array.isArray(reglas?.pedidos?.zonas_entrega) ? reglas.pedidos.zonas_entrega : [];
  const mencionadas = zonasEnDireccion(reglas, t);
  if (mencionadas.some((z) => zonaQueEsPlatillo(z, platillos))) return no('zona_platillo');
  if (pidePlatillo(tramos, platillos)) return no('producto');
  if (tramos.some((tramo) => CANTIDAD_AL_INICIO.test(tramo))) return no('cantidad');
  if (!palabras.some((w) => /^[a-z]{4,}$/.test(w) && !NO_ES_CALLE.has(w))) return no('sin_nombre');
  // Una zona solo se toma como destino cuando es lo único: una zona, con el
  // lugar dentro de ella y sin calle al lado ni negación («UTNC edificio 3»).
  // Como referencia («frente a la Comisión Federal»), negada («ya no estoy en
  // la UTNC») o junto a otra, decide el modelo: la tarifa depende de eso.
  if (mencionadas.length) {
    const resto = sinZonas(t, mencionadas);
    const unaSola = new Set(mencionadas.map((z) => String(z.nombre))).size === 1;
    if (!unaSola || tramos.some((tramo) => calleConNumero(sinZonas(tramo, mencionadas), resto, { lugares: false }))
      || /\b(?:no(?! \d)|ni|nada|sali|salgo|cambie|antes)\b/.test(t)) return no('zona_dudosa');
    if (!LUGAR_DENTRO.test(resto)) return no('solo_zona');
  } else if (!tramos.some((tramo) => esAncla(tramo, t))) {
    return no('sin_ancla');
  }
  // Dos palabras: «Hidalgo 405», «Pino #45», «UTNC biblioteca». «Sean 2» no.
  if (palabras.length === 2 && !mencionadas.length && !tramos.some(anclaCorta)) return no('corto');
  if (!tramos.every((tramo) => tramoDeDomicilio(tramo, zonas, t))) return no('tramo_ajeno');
  return { direccion };
}

export const leerDireccion = (mensaje, opciones) => evaluarDireccion(mensaje, opciones).direccion;

/** La pregunta abierta es la dirección de un pedido a domicilio en curso. */
export function preguntaDeDireccionAbierta(estado) {
  return estado?.pendiente?.tipo === PENDIENTES.DIRECCION
    && !!estado.carrito?.items?.length
    && normalizarTipoModalidad(estado.carrito?.datos?.modalidad) === 'domicilio'
    && !estado.folio && !estado.evento && !estado.confirmacionIncierta && !estado.programacionRequerida
    && !Object.values(estado.hechos || {}).some(Boolean);
}

/**
 * El contador vive mientras la pregunta de dirección siga abierta, aunque en
 * medio conteste el modelo o llegue un toque: así el tope no se reinicia y cada
 * turno del modelo suma su repregunta hasta llegar a una persona (revisión del
 * 1-oct). Si la pregunta se cerró y se abrió otra entre toques, el contador
 * viejo a lo más adelanta el camino de siempre.
 */
export function olvidarDireccionTexto(estado) {
  if (estado?.direccionTexto && estado.pendiente?.tipo !== PENDIENTES.DIRECCION) delete estado.direccionTexto;
}

/**
 * Interpreta el turno contra la pregunta de dirección. Lleva su propio
 * contador en `estado.direccionTexto`: una respuesta de sistema cuenta como
 * avance y no suma repreguntas, así que sin él un tropiezo se repetiría.
 *
 *   null                                 no aplica: el turno sigue su camino
 *   { tipo: 'aceptada', direccion }
 *   { tipo: 'no_es_direccion', motivo }  la pregunta sigue abierta y el texto no es solo una dirección
 *   { tipo: 'agotado' }                  ya hubo LIMITE_INTENTOS_DIRECCION intentos con la pregunta abierta
 */
export function direccionPorTexto({ estado, mensaje, reglas = null, catalogo = [] } = {}) {
  olvidarDireccionTexto(estado);
  if (!preguntaDeDireccionAbierta(estado)) return null;
  const intentos = Number(estado.direccionTexto?.intentos) || 0;
  if (intentos >= LIMITE_INTENTOS_DIRECCION) return { tipo: 'agotado' };
  const { direccion, motivo } = evaluarDireccion(mensaje, { reglas, catalogo });
  if (!direccion) return { tipo: 'no_es_direccion', motivo };
  estado.direccionTexto = { intentos: intentos + 1 };
  return { tipo: 'aceptada', direccion };
}

/** Los tipos de respuesta de sistema que salen de aquí. */
export const RESPUESTAS_DE_DIRECCION = Object.freeze(['direccion_texto']);

/** Lo que el canal entrega como respuesta de sistema. `null` deja el turno como estaba. */
export function respuestaDeDireccion(resultado) {
  if (resultado?.tipo !== 'aceptada') return null;
  return {
    tipo: 'direccion_texto', sinSaludo: true, desdePedido: true, texto: '',
    acciones: [{ herramienta: 'definir_entrega', motivo: 'direccion_por_texto',
      argumentos: { direccion: resultado.direccion } }],
  };
}
