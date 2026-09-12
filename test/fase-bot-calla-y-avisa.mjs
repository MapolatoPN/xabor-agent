// SI NO SÉ, NO INVENTO: el bot calla y le pasa la conversación a una persona.
//
// Antes, cuando el bot se quedaba sin saber qué contestar, contestaba igual --
// el modelo rellenaba el hueco-- y alguien tenía que APAGARLO después de que el
// cliente ya había leído la invención. Esta suite cubre la política nueva:
//
//   1. Los momentos de "no sé" están enumerados y son una lista CERRADA.
//   2. Uno de ellos manda la conversación a revisión humana.
//   3. La conversación marcada deja de ser contestada por el bot.
//   4. El equipo se entera, y puede devolverla al bot cuando la atienda.
//
// Los casos 1 y 2 son puros (se extrae la política del canal y se ejecuta). El
// 3 y el 4 son contra Postgres, porque el que calla al bot es el estado en la
// base, no una variable en memoria.
import assert from 'assert';
import { readFileSync } from 'fs';
import { crearContinuidad } from '../src/services/whatsappContinuidad.js';
import { pool } from '../src/services/database.js';

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ── La política, extraída del canal y ejecutada de verdad ──
// Se recorta del archivo REAL en vez de copiarla: si alguien la renombra o la
// mueve, esta suite truena en lugar de seguir validando una copia muerta.
const CANAL = readFileSync(new URL('../src/channels/whatsapp-meta.js', import.meta.url), 'utf8');
const desde = CANAL.indexOf('const MOTIVOS_REVISION = [');
const hasta = CANAL.indexOf('// La línea que recibe el cliente');
assert.ok(desde > 0 && hasta > desde, 'no se encontró la política en whatsapp-meta.js');
const { motivoDeRevision, MOTIVOS_REVISION } = new Function(
  CANAL.slice(desde, hasta) + '\nreturn { motivoDeRevision, MOTIVOS_REVISION };')();

await t('1. el modelo pide un humano -> a revisión', async () => {
  assert.strictEqual(motivoDeRevision({ escalar: true, texto: 'lo que sea' }), 'ESCALADA_MODELO');
});

await t('2. no se pudo verificar el pedido contra el menú -> a revisión', async () => {
  assert.strictEqual(
    motivoDeRevision({ texto: 'No pude verificar tu pedido con el menú en este momento. Tu pedido aún no está confirmado; por favor intenta de nuevo.' }),
    'SIN_VERIFICAR_MENU');
});

await t('3. el candado atajó una negativa falsa -> a revisión', async () => {
  assert.strictEqual(
    motivoDeRevision({ texto: 'De "Chilaquiles" tenemos ...', negativaInterceptada: [{ negado: 'Chilaquiles', existen: ['Chilaquiles Sencillos'] }] }),
    'NEGATIVA_INTERCEPTADA');
});

await t('4. un turno NORMAL no manda nada a revisión', async () => {
  // La otra mitad del contrato: mandar a revisión tiene un costo real -- el bot
  // deja de atender y alguien tiene que entrar. Si se disparara de más, el
  // equipo acabaría contestando todo a mano y la función se apagaría.
  for (const normal of [
    { texto: 'Claro que sí, ¿para recoger o a domicilio?' },
    { texto: 'Tu pedido XAB-0042 quedó registrado. ¡Gracias!', escalar: false },
    { texto: 'Una disculpa: no manejamos "Sushi de Kobe". ¿Te comparto lo que sí tenemos?' },
    { texto: '', orden: null },
    {},
    null,
  ]) {
    assert.strictEqual(motivoDeRevision(normal), null, `se mandó a revisión sin motivo: ${JSON.stringify(normal)}`);
  }
});

await t('5. una señal rota no puede decidir por su cuenta', async () => {
  const explota = { get escalar() { throw new Error('señal corrupta'); } };
  assert.doesNotThrow(() => motivoDeRevision(explota));
});

await t('6. la lista de motivos es cerrada y nombrada', async () => {
  assert.strictEqual(MOTIVOS_REVISION.length, 3, 'crecer esta lista es una decisión, no un descuido');
  assert.deepStrictEqual(MOTIVOS_REVISION.map((m) => m.motivo).sort(),
    ['ESCALADA_MODELO', 'NEGATIVA_INTERCEPTADA', 'SIN_VERIFICAR_MENU']);
});

// ── Contra la base: lo que de verdad calla al bot ──

const NEG = (await pool.query(`INSERT INTO negocios (nombre, slug) VALUES ('CallaYAvisa','calla-y-avisa')
  ON CONFLICT (slug) DO UPDATE SET nombre='CallaYAvisa' RETURNING id`)).rows[0].id;
const TEL = '5219990001122';
await pool.query('DELETE FROM whatsapp_entradas WHERE negocio_id=$1', [NEG]).catch(() => {});
await pool.query('DELETE FROM whatsapp_conversaciones WHERE negocio_id=$1', [NEG]).catch(() => {});

const avisados = [];
const cont = crearContinuidad({
  pool,
  locks: { connect: () => pool.connect() },
  procesar: async () => {},
  cargarSesion: async () => {},
  leerSesion: async () => ({}),
  alRevision: async (n, tel, motivo) => { avisados.push({ n, tel, motivo }); },
});

await t('7. enviarARevision marca la conversación y dispara el aviso', async () => {
  const marcada = await cont.enviarARevision(NEG, TEL, 'SIN_VERIFICAR_MENU');
  assert.strictEqual(marcada, true, 'debió marcarla');
  const { rows:[c] } = await pool.query(
    'SELECT requiere_revision, motivo FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2', [NEG, TEL]);
  assert.strictEqual(c.requiere_revision, true, 'el bot tiene que quedarse callado en esta conversación');
  assert.strictEqual(c.motivo, 'SIN_VERIFICAR_MENU', 'el equipo necesita saber POR QUÉ');
  assert.strictEqual(avisados.length, 1, 'el equipo tiene que enterarse');
  assert.strictEqual(avisados[0].motivo, 'SIN_VERIFICAR_MENU');
});

await t('8. no se avisa dos veces de la misma conversación', async () => {
  // Si cada mensaje del cliente repitiera el aviso, el encargado dejaría de
  // leerlos y la alerta valdría cero.
  const otra = await cont.enviarARevision(NEG, TEL, 'ESCALADA_MODELO');
  assert.strictEqual(otra, false, 'ya estaba en revisión');
  assert.strictEqual(avisados.length, 1, 'no puede repetir el aviso');
});

await t('9. funciona aunque la conversación no existiera todavía', async () => {
  // Sin fila, el UPDATE no afectaría nada y el bot seguiría contestando: un
  // fallo mudo, justo lo que esta política existe para evitar.
  const nuevo = '5219990003344';
  assert.strictEqual(await cont.enviarARevision(NEG, nuevo, 'ESCALADA_MODELO'), true);
  const { rows:[c] } = await pool.query(
    'SELECT requiere_revision FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2', [NEG, nuevo]);
  assert.strictEqual(c?.requiere_revision, true);
});

await t('10. sin datos suficientes no marca nada, y nunca lanza', async () => {
  assert.strictEqual(await cont.enviarARevision(null, TEL, 'X'), false);
  assert.strictEqual(await cont.enviarARevision(NEG, null, 'X'), false);
  assert.strictEqual(await cont.enviarARevision(NEG, TEL, null), false);
});

await t('11. el equipo puede devolverla al bot', async () => {
  // El camino de vuelta es el del panel: limpiar requiere_revision. Se
  // comprueba que el estado sea reversible -- una conversación atrapada para
  // siempre en revisión sería peor que el bot equivocándose.
  await pool.query(`UPDATE whatsapp_conversaciones SET requiere_revision=false, motivo=NULL
    WHERE negocio_id=$1 AND telefono=$2`, [NEG, TEL]);
  assert.strictEqual(await cont.enviarARevision(NEG, TEL, 'ESCALADA_MODELO'), true,
    'tras atenderla, una nueva duda vuelve a poder mandarla a revisión');
});

// ── El mensaje al cliente ──

await t('12. la línea al cliente no afirma nada del menú ni del pedido', async () => {
  const i = CANAL.indexOf('const MENSAJE_REVISION_POR_DEFECTO');
  const texto = CANAL.slice(i, CANAL.indexOf(';', i));
  assert.doesNotMatch(texto, /no manejamos|no tenemos|precio|\$/i,
    'la línea de entrega no puede afirmar nada que haya que verificar');
  assert.match(texto, /equipo/i, 'tiene que decirle al cliente que alguien lo va a atender');
  // Y se puede apagar: hay negocios que preferirán silencio absoluto.
  assert.match(CANAL, /bot_mensaje_revision/, 'la línea tiene que ser configurable');
});

console.log(`\n${fallidas === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
await pool.end().catch(() => {});
process.exit(fallidas === 0 ? 0 : 1);
