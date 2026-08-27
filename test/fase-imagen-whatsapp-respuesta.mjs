// Un cliente que manda una foto NUNCA se queda sin respuesta.
//
// CASO REAL (Nonna Maye, 2026-08-26T00:18Z), reconstruido de producción:
//
//   entrante  cliente  texto   "Hola"
//   saliente  bot      texto   "Buenas tardes, Mario. ¿En qué te puedo ayudar…"
//   entrante  cliente  imagen  "📷 Tienen este combo?"
//   entrante  cliente  imagen  "📷 Tienen disponible este combo?"
//   ← nada más: fin de la conversación
//
// El bot contestó el "Hola" y enmudeció con las dos fotos, aunque venían
// CON pregunta escrita. La causa era estructural, no una excepción: el
// webhook hacía `return` después de archivar la imagen para el chat del
// panel, y el agente nunca se enteraba.
//
// Xabor no interpreta imágenes (el cerebro es de texto). Eso no autoriza el
// silencio: o el caption se contesta como la pregunta que es, o sale un
// fallback honesto que no inventa qué hay en la foto.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FUENTE = readFileSync(join(__dirname, '..', 'src', 'channels', 'whatsapp-meta.js'), 'utf8').replace(/\r\n/g, '\n');

const { turnoDeImagen, soloImagenes, prepararTurnoParaIA, TEXTO_FALLBACK_IMAGEN } =
  await import('../src/utils/turnoImagen.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
function t(nombre, fn) {
  try { fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// El cuerpo del webhook y del manejador, para los contratos estructurales.
// El manejador del webhook va desde que se lee el mensaje hasta su catch.
// (El marcador de "Enrutamiento repartidor" aparece ANTES en el archivo:
//  usarlo como fin daba un corte vacío y los contratos pasaban en falso.)
const webhook = FUENTE.slice(FUENTE.indexOf("const message = value?.messages?.[0];"), FUENTE.indexOf("console.error('[Meta WA] Error:', error.message);"));
if (!webhook.trim()) throw new Error('no se pudo aislar el manejador del webhook');
const manejador = FUENTE.slice(FUENTE.indexOf('async function manejarImagenEntrante'), FUENTE.indexOf('// ─── Marcar mensaje como leído'));

// ── 1-4. El turno se arma con el contexto que traiga ────────────────────────
t('1. imagen CON caption: el caption viaja como la pregunta del cliente', () => {
  const turno = turnoDeImagen('Tienen este combo?');
  assert.ok(turno.includes('Tienen este combo?'), 'se perdió el caption');
  assert.ok(!soloImagenes(turno), 'con caption hay pregunta real: no es el caso de fallback');
  assert.ok(prepararTurnoParaIA(turno).includes('Tienen este combo?'));
});

t('2. imagen SIN caption: no hay nada que contestar salvo preguntar', () => {
  const turno = turnoDeImagen(null);
  assert.ok(soloImagenes(turno), 'una foto sola debe resolverse con el fallback');
  assert.ok(soloImagenes(turnoDeImagen('')));
  assert.ok(soloImagenes(turnoDeImagen('   ')));
});

t('3. imagen y DESPUÉS un mensaje: se agrupan en un solo turno', () => {
  // Es lo que hace la cola de 6s: junta las líneas.
  const combinado = [turnoDeImagen(null), '¿Sigue vigente?'].join('\n');
  assert.ok(!soloImagenes(combinado), 'con un texto después ya no es una foto muda');
  const paraIA = prepararTurnoParaIA(combinado);
  assert.ok(paraIA.includes('¿Sigue vigente?'), 'se perdió el mensaje posterior');
  assert.ok(/foto/i.test(paraIA), 'el modelo debe saber que hubo una foto');
});

t('4. texto y DESPUÉS imagen: tampoco se pierde el contexto', () => {
  const combinado = ['Vi esta promoción', turnoDeImagen(null)].join('\n');
  assert.ok(!soloImagenes(combinado));
  assert.ok(prepararTurnoParaIA(combinado).includes('Vi esta promoción'));
});

t('5. el caso real completo: dos fotos con caption', () => {
  const combinado = [turnoDeImagen('Tienen este combo?'), turnoDeImagen('Tienen disponible este combo?')].join('\n');
  assert.ok(!soloImagenes(combinado), 'el caso real habría caído en fallback en vez de contestarse');
  const paraIA = prepararTurnoParaIA(combinado);
  assert.ok(paraIA.includes('Tienen este combo?') && paraIA.includes('Tienen disponible este combo?'));
});

// ── 6-9. Veracidad: no inventar lo que no se ve ─────────────────────────────
t('6. al modelo se le dice explícitamente que NO puede ver la foto', () => {
  const paraIA = prepararTurnoParaIA(turnoDeImagen('¿Todavía tienen esta promoción?'));
  assert.ok(/no puedo ver/i.test(paraIA), 'sin esa nota el modelo puede describir una foto que no vio');
  assert.ok(!/\[\[xabor:imagen\]\]/.test(paraIA), 'la marca interna no puede llegar al modelo');
});

t('7. la nota prohíbe confirmar promociones por una imagen', () => {
  const paraIA = prepararTurnoParaIA(turnoDeImagen('¿Sigue esta promo?'));
  assert.ok(/no confirmes promociones/i.test(paraIA) || /no supongas/i.test(paraIA),
    'debe instruir explícitamente a no confirmar vigencia por la foto');
});

t('8. el fallback no afirma qué hay en la foto ni que algo esté vigente', () => {
  const f = TEXTO_FALLBACK_IMAGEN;
  assert.ok(/no puedo verla|no puedo ver/i.test(f), 'debe admitir que no ve la imagen');
  assert.ok(/\?/.test(f), 'debe terminar preguntando, no cerrando');
  assert.ok(!/(sigue vigente|está vigente|sí tenemos|disponible hasta)/i.test(f),
    'el fallback no puede afirmar vigencia de nada');
  assert.ok(f.length < 260, 'un fallback larguísimo se lee como muro de texto');
});

t('9. la marca interna nunca se le muestra al cliente', () => {
  assert.ok(!TEXTO_FALLBACK_IMAGEN.includes('[['), 'se filtró la marca interna al texto del cliente');
});

// ── 10-14. Contratos estructurales: el silencio ya no es posible ────────────
t('10. el webhook YA NO corta el flujo al recibir una imagen', () => {
  // Este es el bug: `manejarImagenEntrante(...); return;` incondicional.
  assert.ok(!/if \(message\.type === 'image'\) \{\s*\n\s*await manejarImagenEntrante\([^)]*\);\s*\n\s*return;/.test(webhook),
    'la imagen vuelve a terminar en un return incondicional: el cliente queda mudo');
  assert.ok(/turnoImagen = await manejarImagenEntrante\(/.test(webhook),
    'el manejador debe devolver el turno para que siga al bot');
  // Contrato smoke C: el manejador ya no tiene un camino "yo respondí,
  // corta" -- devuelve turno SIEMPRE y la única que responde es la cola al
  // vencer la ventana.
  assert.ok(!/if \(turnoImagen === null\) return;/.test(webhook),
    'reapareció el corte por respuesta paralela del manejador');
});

t('11. el turno de la imagen entra a la MISMA cola que el texto', () => {
  assert.ok(/const texto\s+= turnoImagen !== null \? turnoImagen : message\.text\.body;/.test(webhook),
    'el turno de imagen debe seguir el mismo camino que un texto');
  assert.ok(/encolarMensaje\(`\$\{negocioId\}:\$\{telefono\}`, texto,/.test(webhook),
    'debe reutilizar la cola de 6s -- es lo que agrupa foto + texto');
});

t('12. la cola garantiza respuesta: agente o fallback, nunca nada', () => {
  const cola = webhook.slice(webhook.indexOf('encolarMensaje(`${negocioId}'));
  // Política nueva (foto muda con visión ON se analiza): la rama del
  // fallback exige foto muda Y visión sin resultado.
  assert.ok(/const esFotoMuda = soloImagenes\(textoCombinado\);/.test(cola), 'falta la clasificación de foto muda');
  assert.ok(/if \(esFotoMuda && !\(contextosVisuales && contextosVisuales\.size\)\)/.test(cola), 'falta la rama del fallback');
  assert.ok(/TEXTO_FALLBACK_IMAGEN/.test(cola), 'el fallback debe enviarse de verdad');
  // Vision V1: el turno puede llevar ademas los contextos visuales del
  // analisis (segundo argumento); la limpieza de la marca es la misma.
  assert.ok(/procesarConClaude\(telefono, prepararTurnoParaIA\(textoCombinado, contextosVisuales\)/.test(cola),
    'el turno debe limpiarse antes de ir al modelo');
  // El fallback se ENVÍA una sola vez (aparece dos veces en el código: al
  // enviarlo y al guardarlo en el chat, que es lo correcto).
  assert.strictEqual((cola.match(/enviarMensaje\([^)]*TEXTO_FALLBACK_IMAGEN/g) || []).length, 1,
    'el fallback se envía más de una vez en la cola: respuesta duplicada');
  assert.strictEqual((cola.match(/guardarMensaje\([^)]*TEXTO_FALLBACK_IMAGEN/g) || []).length, 1,
    'el fallback debe quedar registrado en el chat exactamente una vez');
  // Y es un if con return: el modelo no se llama además del fallback.
  assert.ok(/esFotoMuda && !\(contextosVisuales && contextosVisuales\.size\)\)[\s\S]*?return;[\s\S]*?procesarConClaude/.test(cola),
    'el fallback debe cortar antes de llamar al modelo');
});

t('13. módulo apagado y MIME no soportado responden, ya no descartan', () => {
  assert.ok(!/chat_imagenes no está habilitado[\s\S]{0,140}?\n\s*return;\n/.test(manejador),
    'con el módulo apagado se vuelve a descartar en silencio');
  // Contrato smoke C: esas salidas ya no contestan por su cuenta (eso era
  // una respuesta paralela con la ventana de 6s todavía abierta) --
  // devuelven el turno y la cola decide al vencer, igual que el camino
  // normal. Lo único que cambia entre caminos es si la foto se archiva.
  // Vision V1: el camino archivado lleva el id del documento en la marca
  // (turnoDeImagen(caption, documento.id)); los que no archivan, no.
  assert.strictEqual((manejador.match(/return turnoDeImagen\(caption(?:, documento\.id)?\);/g) || []).length, 3,
    'módulo apagado, MIME no soportado y camino normal deben devolver turno');
  assert.ok(!/responderYCortar/.test(manejador), 'el helper de respuesta paralela debe estar eliminado');
  assert.ok(!/return null;/.test(manejador), 'ya no existe el camino "ya contesté yo"');
});

t('14. un fallo de descarga NO se lleva la respuesta por delante', () => {
  // Antes: `return` dentro del try/catch de descarga -> silencio. Ahora la
  // descarga vive en un IIFE en segundo plano: sus `return` internos cortan
  // la DESCARGA, nunca el turno, porque el turno se devuelve fuera del IIFE.
  const iife = manejador.slice(manejador.indexOf('(async () => {'), manejador.indexOf('})();'));
  assert.ok(/descargarMediaDeMeta/.test(iife), 'la descarga debe vivir en el segundo plano');
  assert.ok(/sin_credenciales/.test(iife), 'el fallo de credenciales se maneja dentro del segundo plano');
  assert.ok(/return turnoDeImagen\(caption, documento\.id\);/.test(manejador.slice(manejador.indexOf('})();'))),
    'pase lo que pase con la descarga, el turno debe seguir al bot');
  // Y el error queda observable y sanitizado (sin teléfono ni media_id).
  assert.ok(/FALLO_DESCARGA_IMAGEN negocio=/.test(manejador), 'el fallo debe dejar rastro buscable');
  const log = (manejador.match(/FALLO_DESCARGA_IMAGEN[^`]*/) || [''])[0];
  assert.ok(!/telefono|mediaId|accessToken/.test(log), 'el log no puede llevar datos sensibles');
});

// ── 15-16. Aislamiento e idempotencia ───────────────────────────────────────
t('15. la cola es por negocio+teléfono: A no ve el turno de B', () => {
  assert.ok(/encolarMensaje\(`\$\{negocioId\}:\$\{telefono\}`/.test(webhook),
    'la clave de la cola debe incluir el negocio, o dos tenants se mezclarían');
  // Y el negocio se resuelve del phone_number_id del propio payload.
  assert.ok(/obtenerIntegracionCanal\('whatsapp', phoneNumberId\)/.test(webhook));
});

t('16. el dedupe existente sigue en pie: webhook repetido no responde dos veces', () => {
  // La idempotencia real vive en el índice único de message_id_externo al
  // guardar el mensaje; este cambio no la toca.
  assert.ok(/guardarMensaje\(telefono, nombreMeta, 'entrante', caption \? `📷 \$\{caption\}` : '📷 Imagen', negocioId, 'cliente', wamid/.test(manejador),
    'el mensaje entrante debe seguir guardándose con su wamid');
  assert.ok(FUENTE.includes('message_id_externo') || FUENTE.includes('wamid'),
    'el mecanismo de dedupe debe seguir presente');
});

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
