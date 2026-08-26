// Texto + foto seguidos son UN turno, no dos.
//
// SMOKE C REAL (Nonna Maye, 2026-08-26T16:58Z, produccion 034c583):
//
//   16:58:31.268  entrante  cliente  texto   "Sigue vigente esta promocion?"
//   16:58:36.517  entrante  cliente  imagen  (+5.25s, DENTRO de la ventana)
//   16:58:41.618  saliente  bot      texto   "No veo la imagen que compartiste..."
//   16:58:45.616  saliente  bot      texto   "Recibi tu imagen pero no puedo verla..."
//
// Dos respuestas. La cola SI agrupa: el problema es que la foto llego tarde
// a la cola. manejarImagenEntrante devolvia el turno solo DESPUES de bajar
// la media de Meta y comprimirla (~7s medidos en produccion), asi que el
// timer del texto (31.268 + 6s = 37.27) vencio primero, con el texto solo.
// La imagen abrio entonces una entrada NUEVA y termino en el fallback.
//
// De ahi el invariante de esta suite: lo que llega dentro de la ventana se
// encola dentro de la ventana. Cualquier trabajo lento -- descargas, cache,
// compresion -- va despues de encolar, nunca antes.
//
// La forma del canal simulado NO esta escrita a mano: se LEE del codigo de
// produccion (ver DESCARGA_EN_SEGUNDO_PLANO abajo). Corriendo esta suite
// contra la version anterior del archivo, los casos C, D, F y H fallan.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { encolarMensaje, reiniciarCola, hayTurnoPendiente, VENTANA_AGRUPAMIENTO_MS }
  from '../src/utils/colaMensajes.js';
import { turnoDeImagen, soloImagenes, prepararTurnoParaIA, TEXTO_FALLBACK_IMAGEN }
  from '../src/utils/turnoImagen.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// FUENTE_WHATSAPP permite correr esta misma suite contra una version
// anterior del archivo, para comprobar que la prueba es ROJA alli.
const RUTA = process.env.FUENTE_WHATSAPP || join(__dirname, '..', 'src', 'channels', 'whatsapp-meta.js');
const FUENTE = readFileSync(RUTA, 'utf8').replace(/\r\n/g, '\n');
const manejador = FUENTE.slice(FUENTE.indexOf('async function manejarImagenEntrante'),
                               FUENTE.indexOf('// ─── Marcar mensaje como leído'));
if (!manejador.trim()) throw new Error('no se pudo aislar manejarImagenEntrante');

// ── La forma real del codigo de produccion ──────────────────────────────────
// 1) La descarga de media, en segundo plano o bloqueando al turno?
const DESCARGA_EN_SEGUNDO_PLANO =
  /\(async \(\) => \{[\s\S]*?descargarMediaDeMeta[\s\S]*?\}\)\(\);/.test(manejador) &&
  !/await \(async \(\) => \{/.test(manejador);
// 2) El manejador le contesta al cliente por su cuenta, en paralelo a la cola?
const FALLBACK_INMEDIATO = /enviarMensaje\([^)]*TEXTO_FALLBACK_IMAGEN/.test(manejador);

const VENTANA  = 150;          // ms; en produccion son 6000
const DESCARGA = VENTANA * 2;  // la descarga tarda mas que la ventana, como en prod
const dormir = ms => new Promise(r => setTimeout(r, ms));

// Canal simulado: replica el ORDEN DE OPERACIONES del webhook. Las decisiones
// (agrupar, agente vs fallback, limpiar el turno) son las de produccion --
// encolarMensaje, soloImagenes y prepararTurnoParaIA son los modulos reales.
function crearCanal(negocioId = 'neg-1', telefono = '5218780000000') {
  const clave = `${negocioId}:${telefono}`;
  const outbounds = [];
  const entregar = async (textoCombinado) => {
    if (soloImagenes(textoCombinado)) { outbounds.push({ tipo: 'fallback', texto: TEXTO_FALLBACK_IMAGEN }); return; }
    outbounds.push({ tipo: 'agente', texto: prepararTurnoParaIA(textoCombinado) });
  };
  return {
    outbounds,
    get fallbacks() { return outbounds.filter(o => o.tipo === 'fallback').length; },
    get agentes()   { return outbounds.filter(o => o.tipo === 'agente').length; },
    texto(t) { encolarMensaje(clave, t, entregar, VENTANA); },
    async imagen(caption = null) {
      if (DESCARGA_EN_SEGUNDO_PLANO) {
        encolarMensaje(clave, turnoDeImagen(caption), entregar, VENTANA);
        dormir(DESCARGA);                       // se archiva sin bloquear el turno
      } else {
        await dormir(DESCARGA);                 // forma de 034c583: el turno espera
        encolarMensaje(clave, turnoDeImagen(caption), entregar, VENTANA);
      }
    },
    async imagenModuloApagado(caption = null) {
      // El modulo esta suspendido: la foto no se archiva. La respuesta al
      // cliente NO cambia por eso -- y sobre todo no se adelanta.
      if (FALLBACK_INMEDIATO) { outbounds.push({ tipo: 'fallback', texto: TEXTO_FALLBACK_IMAGEN }); return; }
      encolarMensaje(clave, turnoDeImagen(caption), entregar, VENTANA);
    }
  };
}

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  reiniciarCola();
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
  finally { reiniciarCola(); }
}

// ── Casos obligatorios del gate ─────────────────────────────────────────────
await t('A. imagen CON caption: una sola respuesta del agente', async () => {
  const c = crearCanal();
  await c.imagen('Tienen este combo?');
  await dormir(VENTANA * 3);
  assert.strictEqual(c.outbounds.length, 1, `salieron ${c.outbounds.length} respuestas`);
  assert.strictEqual(c.fallbacks, 0, 'un caption es una pregunta real: no es caso de fallback');
  assert.ok(c.outbounds[0].texto.includes('Tienen este combo?'), 'se perdio el caption');
});

await t('B. imagen sola: un fallback, ni antes ni dos veces', async () => {
  const c = crearCanal();
  await c.imagen(null);
  assert.strictEqual(c.outbounds.length, 0, 'el fallback salio ANTES de vencer la ventana');
  await dormir(VENTANA * 3);
  assert.strictEqual(c.outbounds.length, 1, `salieron ${c.outbounds.length} respuestas`);
  assert.strictEqual(c.fallbacks, 1, 'una foto muda se contesta con el fallback determinista');
});

await t('C. texto y enseguida imagen: UNA respuesta (el smoke C)', async () => {
  const c = crearCanal();
  c.texto('Sigue vigente esta promocion?');
  await dormir(Math.round(VENTANA * 0.6));   // los 5.25s reales, a escala
  await c.imagen(null);
  await dormir(VENTANA * 5);
  assert.strictEqual(c.outbounds.length, 1,
    `el cliente recibio ${c.outbounds.length} respuestas; esperaba 1`);
  assert.strictEqual(c.fallbacks, 0, 'el fallback se disparo aunque habia texto en el turno');
  assert.ok(c.outbounds[0].texto.includes('Sigue vigente esta promocion?'), 'se perdio el texto');
  assert.ok(/no puedo ver/i.test(c.outbounds[0].texto), 'el modelo debe saber que hubo una foto');
});

await t('D. imagen y enseguida texto: UNA respuesta (orden inverso)', async () => {
  const c = crearCanal();
  await c.imagen(null);
  c.texto('Es de la promocion de la foto');
  await dormir(VENTANA * 5);
  assert.strictEqual(c.outbounds.length, 1, `salieron ${c.outbounds.length} respuestas`);
  assert.strictEqual(c.fallbacks, 0, 'el texto llego dentro de la ventana: no es una foto muda');
  assert.ok(c.outbounds[0].texto.includes('Es de la promocion de la foto'));
});

await t('E. imagen, vence la ventana, luego texto: dos turnos legitimos', async () => {
  const c = crearCanal();
  await c.imagen(null);
  await dormir(VENTANA * 3);                  // la ventana vence de verdad
  assert.strictEqual(c.fallbacks, 1, 'la foto muda debe haberse contestado ya');
  c.texto('Hola, queria preguntar otra cosa');
  await dormir(VENTANA * 3);
  assert.strictEqual(c.outbounds.length, 2, 'son dos turnos distintos: dos respuestas es lo correcto');
  assert.strictEqual(c.agentes, 1, 'el texto nuevo debe ir al agente, no a otro fallback');
});

await t('F. dos imagenes y un texto dentro de la ventana: UNA respuesta', async () => {
  const c = crearCanal();
  await c.imagen(null);
  await c.imagen('y este?');
  c.texto('Siguen disponibles?');
  await dormir(VENTANA * 5);
  assert.strictEqual(c.outbounds.length, 1, `salieron ${c.outbounds.length} respuestas`);
  assert.strictEqual(c.fallbacks, 0);
  assert.ok(c.outbounds[0].texto.includes('y este?') && c.outbounds[0].texto.includes('Siguen disponibles?'),
    'el turno debe llevar todo el contexto que mando el cliente');
});

await t('G. webhook repetido: no duplica la respuesta', async () => {
  const c = crearCanal();
  await c.imagen('Tienen este combo?');
  await c.imagen('Tienen este combo?');        // reentrega de Meta, mismo wamid
  await dormir(VENTANA * 5);
  assert.strictEqual(c.outbounds.length, 1, 'una reentrega no puede producir una segunda respuesta');
});

await t('H. modulo de imagenes apagado: tampoco responde en paralelo', async () => {
  const c = crearCanal();
  c.texto('Sigue vigente esta promocion?');
  await c.imagenModuloApagado(null);
  await dormir(VENTANA * 5);
  assert.strictEqual(c.outbounds.length, 1,
    'con el modulo apagado la foto sigue sin archivarse, pero la respuesta sigue siendo una sola');
  assert.strictEqual(c.fallbacks, 0, 'habia texto en el turno: no corresponde el fallback');
});

// ── Invariantes de la cola ──────────────────────────────────────────────────
await t('I. la cola es por negocio+telefono: dos negocios no se mezclan', async () => {
  const a = crearCanal('neg-1', '5218780000000');
  const b = crearCanal('neg-2', '5218780000000');   // el MISMO numero
  a.texto('Hola A');
  b.texto('Hola B');
  await dormir(VENTANA * 3);
  assert.strictEqual(a.outbounds.length, 1);
  assert.strictEqual(b.outbounds.length, 1);
  assert.ok(a.outbounds[0].texto.includes('Hola A') && !a.outbounds[0].texto.includes('Hola B'),
    'se filtro la conversacion de otro negocio en el turno');
});

await t('J. hay un solo turno pendiente por conversacion', async () => {
  const c = crearCanal();
  c.texto('uno');
  c.texto('dos');
  assert.ok(hayTurnoPendiente('neg-1:5218780000000'), 'el turno pendiente debe ser observable');
  await dormir(VENTANA * 3);
  assert.ok(!hayTurnoPendiente('neg-1:5218780000000'), 'el turno debe cerrarse al vencer');
  assert.strictEqual(c.outbounds.length, 1, 'dos mensajes seguidos son un turno');
});

await t('K. en produccion la ventana sigue siendo la de 6 segundos', () => {
  assert.strictEqual(VENTANA_AGRUPAMIENTO_MS, 6000, 'esta correccion no cambia la ventana');
  assert.ok(/encolarMensaje\(`\$\{negocioId\}:\$\{telefono\}`, texto,/.test(FUENTE),
    'el webhook debe seguir usando la cola compartida con la clave por negocio');
  assert.ok(/from '\.\.\/utils\/colaMensajes\.js'/.test(FUENTE),
    'la cola debe ser la unica fuente de verdad, importada, no una copia local');
});

// ── Contratos estructurales: la causa exacta del smoke C ────────────────────
await t('L. la descarga de media NO bloquea la entrada del turno a la cola', () => {
  assert.ok(DESCARGA_EN_SEGUNDO_PLANO,
    'descargarMediaDeMeta vuelve a correr antes de devolver el turno: la foto llegara tarde a la cola');
  const antesDelIIFE = manejador.slice(0, manejador.indexOf('(async () => {'));
  assert.ok(!/await descargarMediaDeMeta/.test(antesDelIIFE),
    'la descarga quedo en el camino del turno');
  assert.ok(!/await procesarImagenEntranteDescargada/.test(antesDelIIFE),
    'la compresion de la imagen quedo en el camino del turno');
});

await t('M. el manejador nunca responde por su cuenta: decide la cola', () => {
  assert.ok(!FALLBACK_INMEDIATO,
    'manejarImagenEntrante vuelve a enviar el fallback en paralelo, con la ventana todavia abierta');
  assert.ok(!/return null;/.test(manejador),
    'ya no existe el camino "ya conteste yo": el manejador siempre devuelve turno');
  // Vision V1: el camino archivado devuelve la marca CON el id del
  // documento (turnoDeImagen(caption, documento.id)) para que el analisis
  // sepa que archivo mirar; los otros dos caminos no archivan nada y
  // siguen sin id. El contrato real es el mismo: TRES returns de turno.
  assert.strictEqual((manejador.match(/return turnoDeImagen\(caption(?:, documento\.id)?\);/g) || []).length, 3,
    'los tres caminos (modulo apagado, mime no soportado, normal) deben devolver turno');
});

await t('N. no se resolvio con sleeps ni con esperas artificiales', () => {
  const webhook = FUENTE.slice(FUENTE.indexOf('const message = value?.messages?.[0];'),
                               FUENTE.indexOf("console.error('[Meta WA] Error:', error.message);"));
  assert.ok(!/setTimeout\(\s*\(\)\s*=>\s*resolve/.test(webhook + manejador), 'aparecio un sleep en el camino del mensaje');
  assert.ok(!/await new Promise\(/.test(webhook + manejador), 'aparecio una espera artificial');
  assert.ok(!/setTimeout/.test(manejador), 'el manejador de imagen no debe programar timers propios');
});

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
