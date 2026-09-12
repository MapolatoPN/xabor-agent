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
// Se ancla a la DECLARACIÓN siguiente, no a un comentario: los comentarios se
// reescriben (este recorte ya se rompió una vez por eso) y las declaraciones no.
const hasta = CANAL.indexOf('const MENSAJE_REVISION_POR_DEFECTO');
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

await t('12. SILENCIO TOTAL hacia el cliente por defecto', async () => {
  // Decisión del dueño: cuando el bot no sabe, el cliente no recibe NADA. Una
  // línea automática sigue siendo el bot hablando, y contestar sin saber es
  // justo lo que lo obligaba a apagarlo todos los días.
  const i = CANAL.indexOf('const MENSAJE_REVISION_POR_DEFECTO');
  const linea = CANAL.slice(i, CANAL.indexOf(';', i));
  assert.match(linea, /=\s*''\s*$/, `el valor por defecto tiene que ser vacío — ${linea.trim()}`);
  // Pero sigue siendo configurable: un negocio puede querer acusar recibo.
  assert.match(CANAL, /bot_mensaje_revision/, 'la línea tiene que poder configurarse');
  // Y el envío tiene que estar guardado tras una comprobación de contenido: con
  // el valor vacío no puede colarse un mensaje en blanco al cliente.
  assert.match(CANAL, /if\s*\(\s*aviso\s*&&\s*aviso\.trim\(\)\s*\)/,
    'sin contenido no se manda nada');
});

await t('13. el equipo se entera igual: el silencio es solo hacia el cliente', async () => {
  // La contraparte del silencio. Si esto se rompiera, una conversación quedaría
  // muda para el cliente Y invisible para el negocio: lo peor de los dos mundos.
  assert.match(CANAL, /avisarEquipoRevision\(negocioId, telefono, motivoRevision/,
    'el aviso al encargado no puede depender de que haya mensaje al cliente');
  const i = CANAL.indexOf('async function avisarEquipoRevision');
  const cuerpo = CANAL.slice(i, i + 1200);
  assert.match(cuerpo, /wa_admin_numero/, 'va al número del encargado');
  assert.match(cuerpo, /Cliente:/, 'tiene que decir a QUIÉN hay que atender');
  assert.match(cuerpo, /Motivo:/, 'y por qué');
});

// ── La pausa no puede ser eterna ─────────────────────────────────────────
//
// Incidente 2026-09-11: una conversación entró en revisión, nadie la atendió, y
// el cliente escribió tres veces sin recibir NADA -- ni un saludo. Encima el
// botón para devolverla al bot estaba roto, así que no había salida.
//
// Un bot que contesta imperfecto es mejor que un cliente ignorado media noche.
// Pero soltar de más es peor: si una persona del equipo tomó la conversación a
// mano, el bot NO puede ponerse a contestar encima de ella.

const liberados = [];
const contLib = crearContinuidad({
  pool,
  locks: { connect: () => pool.connect() },
  procesar: async () => {},
  cargarSesion: async () => {},
  leerSesion: async () => ({}),
  alRevision: async () => {},
  alLiberar: async (n, tel, motivo, edad) => { liberados.push({ tel, motivo, edad }); },
});

const TEL_VIEJA = '5219990007001';
const TEL_FRESCA = '5219990007002';
const TEL_TOMADA = '5219990007003';
const enRevisionDesdeHace = async (tel, minutos, quien = null) => {
  await pool.query(`INSERT INTO whatsapp_conversaciones(negocio_id,telefono,requiere_revision,motivo,actualizado_at)
    VALUES ($1,$2,TRUE,'ESCALADA_MODELO', now() - ($3 || ' minutes')::interval)
    ON CONFLICT (negocio_id,telefono) DO UPDATE
      SET requiere_revision=TRUE, motivo='ESCALADA_MODELO', actualizado_at = now() - ($3 || ' minutes')::interval`,
    [NEG, tel, String(minutos)]);
  await pool.query(`INSERT INTO conversaciones_control(negocio_id,telefono,bot_pausado,updated_by)
    VALUES ($1,$2,TRUE,$3)
    ON CONFLICT (negocio_id,telefono) DO UPDATE SET bot_pausado=TRUE, updated_by=$3`,
    [NEG, tel, quien]);
};
const sigueEnRevision = async (tel) => (await pool.query(
  'SELECT requiere_revision FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2', [NEG, tel]
)).rows[0]?.requiere_revision;

await t('14. una revisión vieja que nadie atendió vuelve al bot', async () => {
  await enRevisionDesdeHace(TEL_VIEJA, 45);
  await contLib.liberarRevisionesOlvidadas();
  assert.strictEqual(await sigueEnRevision(TEL_VIEJA), false,
    'a los 45 minutos sin que nadie entre, el cliente ya esperó demasiado');
  const ctrl = (await pool.query(
    'SELECT bot_pausado FROM conversaciones_control WHERE negocio_id=$1 AND telefono=$2', [NEG, TEL_VIEJA])).rows[0];
  assert.strictEqual(ctrl.bot_pausado, false, 'y el bot vuelve a poder contestarle');
  assert.ok(liberados.some((l) => l.tel === TEL_VIEJA), 'el equipo tiene que enterarse de que pasó');
});

await t('15. una recién marcada NO se suelta: hay que darle tiempo al equipo', async () => {
  await enRevisionDesdeHace(TEL_FRESCA, 2);
  await contLib.liberarRevisionesOlvidadas();
  assert.strictEqual(await sigueEnRevision(TEL_FRESCA), true,
    'soltar a los dos minutos le quitaría al equipo la oportunidad de atender');
});

await t('16. una que TOMÓ una persona no se toca jamás', async () => {
  // La protección es DOBLE a propósito y hay que dejarlo dicho: un filtro al
  // leer las candidatas y otro DENTRO de la transacción, por si alguien toma la
  // conversación entre una cosa y la otra. Quitar uno solo no hace fallar esta
  // prueba -- lo comprobé-- pero deja la carrera abierta. No es código muerto.
  //
  // El riesgo de este mecanismo: que el bot se ponga a contestar encima de
  // alguien del equipo que está atendiendo a mano. `updated_by` distingue quién
  // pausó, y es lo único que impide ese desastre.
  const { rows:[u] } = await pool.query(
    `INSERT INTO usuarios (negocio_id, email, nombre, password_hash)
     VALUES ($1,'toma-conv@test.local','Quien Atiende','x')
     ON CONFLICT (email) DO UPDATE SET nombre='Quien Atiende' RETURNING id`, [NEG]);
  await enRevisionDesdeHace(TEL_TOMADA, 120, u.id);
  await contLib.liberarRevisionesOlvidadas();
  assert.strictEqual(await sigueEnRevision(TEL_TOMADA), true,
    'una persona la está atendiendo: el bot no puede contestarle encima');
  assert.ok(!liberados.some((l) => l.tel === TEL_TOMADA), 'ni avisar de algo que no pasó');
});

await t('17. el negocio puede desactivar el rescate, o cambiarle el tiempo', async () => {
  const fijar = (v) => pool.query(`INSERT INTO configuracion (negocio_id,clave,valor) VALUES ($1,'bot_revision_minutos',$2)
    ON CONFLICT (negocio_id,clave) DO UPDATE SET valor=$2`, [NEG, v]);
  const TEL_CFG = '5219990007004';

  await fijar('0');                       // 0 = que se quede en revisión para siempre
  await enRevisionDesdeHace(TEL_CFG, 500);
  await contLib.liberarRevisionesOlvidadas();
  assert.strictEqual(await sigueEnRevision(TEL_CFG), true, 'con 0 nunca se suelta');

  await fijar('10');                      // y con un tiempo propio, se respeta
  await contLib.liberarRevisionesOlvidadas();
  assert.strictEqual(await sigueEnRevision(TEL_CFG), false, 'con 10 minutos, 500 ya es tarde');
  await pool.query(`DELETE FROM configuracion WHERE negocio_id=$1 AND clave='bot_revision_minutos'`, [NEG]);
});

await t('18. al soltar NO se reprocesa el atasco', async () => {
  // Reprocesar los mensajes atorados podría registrar dos veces un pedido. Lo
  // que se recupera es la conversación hacia adelante, no lo que quedó atrás:
  // misma semántica que el botón del panel.
  const TEL_ENT = '5219990007005';
  await enRevisionDesdeHace(TEL_ENT, 60);
  await pool.query(`INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado)
    VALUES ($1,$2,$3,'{}','revision') ON CONFLICT DO NOTHING`, [NEG, TEL_ENT, 'wamid-atascado-1']);
  await contLib.liberarRevisionesOlvidadas();
  const { rows } = await pool.query(
    `SELECT estado FROM whatsapp_entradas WHERE negocio_id=$1 AND telefono=$2`, [NEG, TEL_ENT]);
  assert.ok(rows.length && rows.every((r) => r.estado === 'revisado'),
    `las entradas atascadas quedan como atendidas, no pendientes — ${JSON.stringify(rows)}`);
});


await t('19. el tiempo no resuelve un efecto incierto ni una solicitud humana',async()=>{
  const tel='5219990007006';
  for(const motivo of ['EJECUCION_INTERRUMPIDA','REENTREGA_LEGADA','SOLICITUD_CLIENTE']){
    await enRevisionDesdeHace(tel,120);
    await pool.query('UPDATE whatsapp_conversaciones SET motivo=$3 WHERE negocio_id=$1 AND telefono=$2',[NEG,tel,motivo]);
    await contLib.liberarRevisionesOlvidadas();
    assert.equal(await sigueEnRevision(tel),true,motivo);
  }
});

await t('20. el rescate no se cruza con un turno que aún sostiene el bloqueo',async()=>{
  const tel='5219990007007', db=await pool.connect();
  await enRevisionDesdeHace(tel,120);
  try{
    await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[`wa:${NEG}:${tel}`]);
    await contLib.liberarRevisionesOlvidadas();
    assert.equal(await sigueEnRevision(tel),true);
  }finally{
    await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[`wa:${NEG}:${tel}`]);db.release();
  }
});

// ═══ S — NO HAY BORRADOR NO ES BORRADOR ROTO ══════════════════════════════
//
// Incidente 2026-09-11, 11:11 p.m., con el bot ya desplegado: un cliente
// escribió "Quiero unos chilaquiles" y NO recibió nada. En el log:
//
//   [Meta WA] Mario Cantú: Quiero unos chilaquiles
//   [brain] validación conversacional de catálogo: BORRADOR_ILEGIBLE
//   [Meta WA] conversación a revisión humana motivo=ESCALADA_MODELO
//
// El extractor de borrador pide al modelo un JSON con el pedido. Si el modelo
// contesta en prosa --que es lo normal cuando todavía no hay pedido que
// extraer-- no venía ningún JSON, y eso se trataba como error fatal: tumbaba el
// turno, escalaba, y con la política de silencio el cliente se quedaba
// esperando sin respuesta.
//
// "No extrajo pedido" es el resultado más común y es benigno. "Extrajo algo que
// no se puede leer" sí es un error. Confundirlos costó la conversación entera.
await t('S1. sin nada con forma de JSON: no hay borrador, y el turno sigue', async () => {
  const { _extraerBorradorForzadoDeTexto } = await import('../src/agent/brain.js').catch(() => ({}));
  // Si el helper no está exportado se comprueba por contrato sobre la fuente:
  // lo que importa es que el caso "sin JSON" NO lance.
  const fuente = readFileSync(new URL('../src/agent/brain.js', import.meta.url), 'utf8');
  const i = fuente.indexOf('async function extraerBorradorForzado');
  const cuerpo = fuente.slice(i, fuente.indexOf('\n}', i));
  assert.ok(!/if\s*\(!m\)\s*throw/.test(cuerpo),
    'un modelo que contesta en prosa no puede tumbar el turno: eso dejó a un cliente sin respuesta');
  assert.match(cuerpo, /if\s*\(!m\)\s*return null;/,
    'sin JSON = no hay borrador, y la conversación sigue su curso');
});

await t('S2. lo que SÍ es un borrador roto se sigue tratando como error', async () => {
  // La otra mitad: relajar el caso benigno no puede volver ciego al caso malo.
  const fuente = readFileSync(new URL('../src/agent/brain.js', import.meta.url), 'utf8');
  const i = fuente.indexOf('async function extraerBorradorForzado');
  const cuerpo = fuente.slice(i, fuente.indexOf('\n}', i));
  assert.match(cuerpo, /JSON\.parse\(m\[0\]\)/,
    'si vino algo con forma de JSON y no se puede leer, JSON.parse lanza y se falla cerrado');
  assert.match(cuerpo, /BORRADOR_SIN_ITEMS/,
    'un JSON sin `items` sigue siendo una respuesta malformada');
});

await t('S3. el panel explica el motivo REAL, no uno fijo', async () => {
  // El panel mostraba "se interrumpió un turno" para los cinco motivos. Quien
  // abría la conversación se ponía a buscar un pedido a medias cuando lo que
  // había pasado era que el bot no reconoció un platillo.
  const panel = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8');
  assert.match(panel, /explicarMotivoRevision\(btn\.dataset\.motivo\)/,
    'el texto tiene que salir del motivo, no estar escrito a mano');
  for (const motivo of ['ESCALADA_MODELO', 'SIN_VERIFICAR_MENU', 'NEGATIVA_INTERCEPTADA',
    'REENTREGA_LEGADA', 'EJECUCION_INTERRUMPIDA']) {
    assert.ok(panel.includes(motivo + ':'), `falta qué decirle al equipo ante ${motivo}`);
  }
});

await t('S4. el motivo llega al panel por los dos caminos', async () => {
  const servidor = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(servidor, /motivoRevision: control\?\.motivo/,
    'al abrir la conversación (HTTP)');
  const canal = readFileSync(new URL('../src/channels/whatsapp-meta.js', import.meta.url), 'utf8');
  assert.match(canal, /requiereRevision:true,motivo\}/,
    'y en vivo, cuando ocurre (WebSocket)');
});


console.log(`\n${fallidas === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
await pool.end().catch(() => {});
process.exit(fallidas === 0 ? 0 : 1);
