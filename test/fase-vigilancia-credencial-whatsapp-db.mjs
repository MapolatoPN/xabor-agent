// Vigilancia de la credencial de WhatsApp (31-oct-2026).
//
// El 30-oct la credencial de Obispado venció a los 60 días de conectarse y
// el bot quedó mudo un día entero sin que nadie lo supiera. Esto defiende:
//   · un rechazo de Meta (401 / 190) se anota y pone la tarjeta en «Requiere
//     reconexión», SIN cortar la recepción ni el envío (estado sigue activo);
//   · el aviso sale por push, una vez, con recordatorios solo de día;
//   · una respuesta incierta (red, 5xx) no cambia nada; una buena lo limpia,
//     pero nunca borra un código de error ajeno;
//   · el vencimiento se guarda y se avisa 7, 3 y 1 días antes;
//   · «Verificar conexión» ya no dice «Todo listo» con la credencial vencida;
//   · ningún registro lleva la credencial.
//
// Base local (test_botones_*), Meta simulado: cero red, cero Meta real.
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { exigirBaseBotonesLocal } from './lib-botones-local.mjs';
import { arrancarServidor } from './lib-servidor.mjs';

process.env.META_EMBEDDED_SIGNUP_MOCK = 'true';
exigirBaseBotonesLocal();

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4987';

const { pool, obtenerCredencialesWhatsappNegocio, obtenerIntegracionCanal } = await import('../src/services/database.js');
const { guardarCredencialesCifradas, completarActivacionWhatsapp } = await import('../src/services/integracionesService.js');
const { estadoWhatsappNegocio, buscarFugas } = await import('../src/services/whatsappAutoservicio.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const V = await import('../src/services/vigilanciaCredencialWhatsapp.js');
const P = await import('../src/services/credencialWhatsappPolitica.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// Todo lo que se registra, para comprobar al final que la credencial no sale.
const registros = [];
for (const k of ['log', 'error', 'warn']) {
  const original = console[k].bind(console);
  console[k] = (...a) => { registros.push(a.map(String).join(' ')); original(...a); };
}

const NEG = SEED.negocioA;
const ACTOR = SEED.superadminUsuarioId;
const suf = Date.now().toString().slice(-6);
const PNID = 'PNID_COEX_OK';
const TOKEN = `EAAG_vigilancia_${suf}_${'z'.repeat(40)}`;
const TOKEN_NUEVO = `EAAG_reconexion_${suf}_${'w'.repeat(40)}`;
const ZONA = 'America/Matamoros';
const H = 60 * 60 * 1000, D = 24 * H;
// Lunes 2-nov-2026, 09:00 en Matamoros (ya sin horario de verano: UTC-6).
const T0 = Date.parse('2026-11-02T15:00:00Z');

const pushes = [];
const enviarPush = async (negocioId, titulo, cuerpo, data, opciones) => { pushes.push({ negocioId, titulo, cuerpo, data, opciones }); };
let respuesta = { ok: true, status: 200 };
const sondeos = [];
const sondear = async (cred) => { sondeos.push(cred); return respuesta; };
let vence = { ok: true, valida: true, venceAt: null, nunca: true };
let consultas = 0;
const consultarVence = async () => { consultas++; return vence; };
const correr = async (ahora) => (await V.vigilarCredencialesWhatsapp({
  enviarPush, sondear, consultarVence, ahora: () => ahora, negocioId: NEG })).find((r) => r.negocioId === NEG) || null;

const RECHAZO = { ok: false, status: 401, resumen: { codigo: 190, tipo: 'OAuthException' } };

async function fila() {
  const { rows: [r] } = await pool.query(
    `SELECT ic.id, ic.estado, ic.activo, ic.ultimo_error_codigo, ic.ultimo_error_at, ic.configuracion,
            cc.token_expira_at
       FROM integraciones_canal ic JOIN integraciones_canal_credenciales cc ON cc.integracion_id = ic.id
      WHERE ic.negocio_id = $1 AND ic.canal = 'whatsapp' AND ic.proveedor = 'meta'`, [NEG]);
  return r;
}
async function limpiar() {
  await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN
    (SELECT id FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'whatsapp')`, [NEG]);
  await pool.query(`DELETE FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'whatsapp'`, [NEG]);
  await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2`, [NEG, P.CLAVE_APAGAR]);
}
async function conectar(token) {
  await guardarCredencialesCifradas(NEG, 'whatsapp', 'meta', { phoneNumberId: PNID, wabaId: `WABAVIG${suf}`, accessToken: token }, ACTOR);
  const r = await completarActivacionWhatsapp(NEG, ACTOR);
  assert.equal(r.ok, true, `la activación simulada falló: ${JSON.stringify(r)}`);
}

let srv = null;
try {
  // ═══ Reglas puras ═══════════════════════════════════════════════════════
  await t('01. clasificarSonda: 401 o 190/102 es rechazo; red, 5xx, límites y permisos son inciertos', () => {
    assert.equal(P.clasificarSonda({ ok: true, status: 200 }), 'ok');
    assert.equal(P.clasificarSonda(RECHAZO), 'rechazada');
    assert.equal(P.clasificarSonda({ ok: false, status: 400, resumen: { codigo: 190 } }), 'rechazada');
    assert.equal(P.clasificarSonda({ ok: false, status: 400, resumen: { codigo: 102 } }), 'rechazada');
    for (const s of [{ ok: false, status: 500, resumen: { codigo: 2 } }, { ok: false, status: null, resumen: { tipo: 'red' } },
      { ok: false, status: 429, resumen: { codigo: 4 } }, { ok: false, status: 403, resumen: { codigo: 10 } }, null]) {
      assert.equal(P.clasificarSonda(s), 'incierta', JSON.stringify(s));
    }
    assert.equal(P.codigoDeRechazo(RECHAZO), 'credencial:190');
    assert.ok(P.esCodigoDeRechazo('credencial:401') && !P.esCodigoDeRechazo('registro:190') && !P.esCodigoDeRechazo(null));
  });

  await t('02. umbralDeVencimiento: 7, 3 y 1 días antes, cada uno una vez por vencimiento', () => {
    const v = new Date(T0 + 30 * D).toISOString();
    const a = (dias) => T0 + 30 * D - dias * D;
    assert.equal(P.umbralDeVencimiento({ venceAt: v, ahora: a(10) }), null, 'a 10 días no se avisa');
    assert.equal(P.umbralDeVencimiento({ venceAt: v, ahora: a(5) }), 7);
    assert.equal(P.umbralDeVencimiento({ venceAt: v, ahora: a(2) }), 3);
    assert.equal(P.umbralDeVencimiento({ venceAt: v, ahora: a(0.5) }), 1);
    assert.equal(P.umbralDeVencimiento({ venceAt: v, ahora: a(5), avisado: { para: v, umbral: 7 } }), null, 'el de 7 días se repitió');
    assert.equal(P.umbralDeVencimiento({ venceAt: v, ahora: a(2), avisado: { para: v, umbral: 7 } }), 3);
    assert.equal(P.umbralDeVencimiento({ venceAt: v, ahora: a(5), avisado: { para: new Date(T0).toISOString(), umbral: 1 } }), 7,
      'un vencimiento nuevo (se reconectó) debe volver a avisar');
    assert.equal(P.umbralDeVencimiento({ venceAt: v, ahora: a(-1) }), null, 'una vencida la detecta la consulta, no esto');
    assert.equal(P.umbralDeVencimiento({ venceAt: null, ahora: T0 }), null, 'sin vencimiento (nunca) no hay aviso');
  });

  await t('03. debeAvisarRechazo: el primero siempre; recordatorio cada 4 h y solo de día', () => {
    const noche = Date.parse('2026-11-03T09:30:00Z'); // 03:30 en Matamoros
    const det = new Date(T0 - H).toISOString();
    assert.equal(P.debeAvisarRechazo({ detectadoAt: det, ultimoAvisoAt: null, ahora: noche, zona: ZONA }), true, 'el primer aviso no espera al día');
    assert.equal(P.debeAvisarRechazo({ detectadoAt: det, ultimoAvisoAt: new Date(T0).toISOString(), ahora: T0 + H, zona: ZONA }), false);
    assert.equal(P.debeAvisarRechazo({ detectadoAt: det, ultimoAvisoAt: new Date(T0).toISOString(), ahora: T0 + 4 * H, zona: ZONA }), true);
    assert.equal(P.debeAvisarRechazo({ detectadoAt: det, ultimoAvisoAt: new Date(T0).toISOString(), ahora: noche, zona: ZONA }), false,
      'un recordatorio de madrugada');
    assert.equal(P.debeAvisarRechazo({ detectadoAt: new Date(T0 + 2 * H).toISOString(), ultimoAvisoAt: new Date(T0).toISOString(),
      ahora: T0 + 2 * H + 60e3, zona: ZONA }), true, 'un rechazo NUEVO (posterior al último aviso) no se avisó');
  });

  await t('04. los textos dicen qué hacer y la hora del negocio', () => {
    const r = P.textoRechazo('Mapolato Obispado');
    assert.match(r.cuerpo, /Reconectar/);
    assert.match(r.cuerpo, /Configuración → Integraciones → WhatsApp/);
    assert.match(r.cuerpo, /Mapolato Obispado/);
    const v = P.textoVencimiento('2026-12-08T17:06:11.000Z', ZONA, 'Mapolato Acuña');
    assert.match(v.cuerpo, /vence el martes 8 de diciembre a las 11:06 a\.\s?m\. Antes/);
    assert.ok(!/\.\./.test(v.cuerpo), `doble punto: ${v.cuerpo}`);
  });

  // ═══ Contra la base ═════════════════════════════════════════════════════
  await limpiar();
  await pool.query(`UPDATE negocios SET activo = TRUE WHERE id = $1`, [NEG]);
  await conectar(TOKEN);

  await t('05. credencial viva: consulta con la credencial descifrada, sin marca ni aviso', async () => {
    const r = await correr(T0);
    assert.equal(r?.resultado, 'ok', JSON.stringify(r));
    assert.equal(sondeos.length, 1);
    assert.equal(sondeos[0].accessToken, TOKEN, 'no consultó con la credencial del negocio');
    assert.equal(sondeos[0].phoneNumberId, PNID);
    assert.equal(pushes.length, 0);
    const f = await fila();
    assert.equal(f.ultimo_error_codigo, null);
    assert.equal(consultas, 1, 'la primera corrida debe preguntar el vencimiento');
    assert.equal(f.token_expira_at, null, 'Meta dijo «nunca» y quedó una fecha');
  });

  await t('06. rechazo: se anota, la tarjeta pide reconectar y sale UN push; recepción y envío siguen', async () => {
    respuesta = RECHAZO;
    const r = await correr(T0 + 10 * 60e3);
    assert.equal(r?.resultado, 'rechazada', JSON.stringify(r));
    assert.equal(r.nuevo, true);
    assert.equal(r.avisado, true);
    const f = await fila();
    assert.equal(f.ultimo_error_codigo, 'credencial:190');
    assert.ok(f.ultimo_error_at, 'sin fecha del rechazo');
    assert.equal(f.estado, 'activo', 'el rechazo cambió el estado: eso corta la recepción');
    assert.equal(f.activo, true);
    const e = await estadoWhatsappNegocio(NEG);
    assert.equal(e.estadoVisible, 'requiere_reconexion');
    assert.equal(e.credencialRechazada, true);
    assert.deepEqual(buscarFugas(e), []);
    assert.ok(await obtenerCredencialesWhatsappNegocio(NEG), 'el envío dejó de encontrar la credencial');
    assert.equal((await obtenerIntegracionCanal('whatsapp', PNID))?.negocioId, NEG, 'la recepción dejó de enrutar');
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].negocioId, NEG);
    assert.equal(pushes[0].opciones?.tag, V.TAG_PUSH);
    assert.match(pushes[0].cuerpo, /Reconectar/);
  });

  await t('07. el mismo rechazo 10 min después: ni push ni fecha nueva', async () => {
    const antes = (await fila()).ultimo_error_at;
    const r = await correr(T0 + 20 * 60e3);
    assert.equal(r?.resultado, 'rechazada');
    assert.equal(r.nuevo, false);
    assert.equal(pushes.length, 1, 'avisó dos veces en 10 minutos');
    assert.equal((await fila()).ultimo_error_at.getTime(), antes.getTime(), 'la fecha del rechazo se movió');
  });

  await t('08. recordatorio a las 4 h de día; de madrugada no', async () => {
    await correr(T0 + 10 * 60e3 + 4 * H + 60e3); // 13:11 local
    assert.equal(pushes.length, 2, 'no salió el recordatorio');
    await correr(Date.parse('2026-11-03T09:30:00Z')); // 03:30 local, >4 h después
    assert.equal(pushes.length, 2, 'salió un recordatorio de madrugada');
  });

  await t('09. una respuesta incierta no cambia nada', async () => {
    respuesta = { ok: false, status: 503, resumen: { codigo: 2 } };
    const r = await correr(Date.parse('2026-11-03T16:00:00Z'));
    assert.equal(r?.resultado, 'incierta');
    assert.equal((await fila()).ultimo_error_codigo, 'credencial:190', 'un 503 borró el rechazo');
    assert.equal(pushes.length, 2);
  });

  await t('10. la credencial vuelve a funcionar: se borra la marca sin avisar', async () => {
    respuesta = { ok: true, status: 200 };
    const r = await correr(Date.parse('2026-11-03T16:10:00Z'));
    assert.equal(r?.resultado, 'ok');
    assert.equal((await fila()).ultimo_error_codigo, null);
    assert.notEqual((await estadoWhatsappNegocio(NEG)).estadoVisible, 'requiere_reconexion');
    assert.equal(pushes.length, 2);
  });

  await t('11. un código de error ajeno no lo borra una consulta buena', async () => {
    await pool.query(`UPDATE integraciones_canal SET ultimo_error_codigo = 'verificacion:numero_no_en_biz_app', ultimo_error_at = NOW()
      WHERE negocio_id = $1 AND canal = 'whatsapp'`, [NEG]);
    await correr(Date.parse('2026-11-03T16:20:00Z'));
    assert.equal((await fila()).ultimo_error_codigo, 'verificacion:numero_no_en_biz_app');
    assert.notEqual((await estadoWhatsappNegocio(NEG)).estadoVisible, 'requiere_reconexion', 'un código ajeno pidió reconectar');
    await pool.query(`UPDATE integraciones_canal SET ultimo_error_codigo = NULL, ultimo_error_at = NULL WHERE negocio_id = $1 AND canal = 'whatsapp'`, [NEG]);
  });

  // Vencimiento. La última consulta fue en la corrida 10 (T0 + 25 h 10 min).
  const VENCE = new Date(T0 + 5 * D).toISOString();
  await t('12. a 4 días del vencimiento: se guarda la fecha y avisa una vez (7 días)', async () => {
    vence = { ok: true, valida: true, venceAt: VENCE, nunca: false };
    const antes = consultas;
    const r = await correr(T0 + D + 8 * H); // martes 17:00 local
    assert.equal(consultas, antes + 1, 'no preguntó el vencimiento');
    assert.equal(r?.avisoVence, 7, JSON.stringify(r));
    assert.equal((await fila()).token_expira_at?.toISOString(), VENCE);
    assert.equal(pushes.length, 3);
    assert.match(pushes[2].titulo, /vence/);
    assert.match(pushes[2].cuerpo, /Reconectar/);
  });

  await t('13. otra corrida al rato: ni consulta (6 h) ni aviso repetido', async () => {
    const antes = consultas;
    await correr(T0 + D + 8 * H + 10 * 60e3);
    assert.equal(consultas, antes, 'preguntó el vencimiento otra vez antes de 6 h');
    assert.equal(pushes.length, 3);
  });

  await t('14. a menos de un día: el aviso de 1 día', async () => {
    const r = await correr(T0 + 4 * D + 3 * H); // viernes 12:00 local, faltan 21 h
    assert.equal(r?.avisoVence, 1, JSON.stringify(r));
    assert.equal(pushes.length, 4);
  });

  await t('15. si cambió la credencial se pregunta de nuevo aunque no hayan pasado 6 h', async () => {
    const NUEVO = new Date(T0 + 64 * D).toISOString();
    vence = { ok: true, valida: true, venceAt: NUEVO, nunca: false };
    await pool.query(`UPDATE integraciones_canal_credenciales SET actualizado_at = $2
      WHERE integracion_id = (SELECT id FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'whatsapp')`,
    [NEG, new Date(T0 + 4 * D + 4 * H)]);
    const antes = consultas;
    await correr(T0 + 4 * D + 5 * H);
    assert.equal(consultas, antes + 1, 'una credencial nueva no se volvió a consultar');
    assert.equal((await fila()).token_expira_at?.toISOString(), NUEVO);
    assert.equal(pushes.length, 4, 'avisó un vencimiento a 59 días');
  });

  await t('16. «nunca vence»: la fecha guardada se borra', async () => {
    vence = { ok: true, valida: true, venceAt: null, nunca: true };
    await correr(T0 + 4 * D + 12 * H);
    assert.equal((await fila()).token_expira_at, null);
  });

  await t('17. la bandera en «false» apaga la vigilancia de ese negocio', async () => {
    await pool.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1, $2, 'false')
      ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = 'false'`, [NEG, P.CLAVE_APAGAR]);
    const antes = sondeos.length;
    const r = await correr(T0 + 5 * D);
    assert.equal(r?.resultado, 'apagada');
    assert.equal(sondeos.length, antes, 'consultó a Meta con la vigilancia apagada');
    await pool.query(`DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2`, [NEG, P.CLAVE_APAGAR]);
  });

  await t('18. una integración que no está activa no se vigila', async () => {
    await pool.query(`UPDATE integraciones_canal SET estado = 'pendiente_activacion', activo = FALSE WHERE negocio_id = $1 AND canal = 'whatsapp'`, [NEG]);
    const antes = sondeos.length;
    assert.equal(await correr(T0 + 5 * D), null);
    assert.equal(sondeos.length, antes);
    await pool.query(`UPDATE integraciones_canal SET estado = 'activo', activo = TRUE WHERE negocio_id = $1 AND canal = 'whatsapp'`, [NEG]);
  });

  await t('19. reconectar borra la marca de rechazo', async () => {
    respuesta = RECHAZO;
    await correr(T0 + 5 * D + H);
    assert.equal((await fila()).ultimo_error_codigo, 'credencial:190');
    await conectar(TOKEN_NUEVO);
    assert.equal((await fila()).ultimo_error_codigo, null, 'la reconexión no borró el rechazo');
    assert.notEqual((await estadoWhatsappNegocio(NEG)).estadoVisible, 'requiere_reconexion');
    respuesta = { ok: true, status: 200 };
  });

  await t('20. registrarSondaDeNegocio (Verificar conexión) anota y borra igual que el job', async () => {
    assert.equal(await V.registrarSondaDeNegocio(NEG, RECHAZO), 'rechazada');
    assert.equal((await fila()).ultimo_error_codigo, 'credencial:190');
    assert.equal(await V.registrarSondaDeNegocio(NEG, { ok: false, status: 500, resumen: { codigo: 1 } }), 'incierta');
    assert.equal((await fila()).ultimo_error_codigo, 'credencial:190');
    assert.equal(await V.registrarSondaDeNegocio(NEG, { ok: true, status: 200 }), 'ok');
    assert.equal((await fila()).ultimo_error_codigo, null);
  });

  // ═══ «Verificar conexión» con el servidor ════════════════════════════════
  srv = await arrancarServidor({ PORT: PUERTO, META_EMBEDDED_SIGNUP_MOCK: 'true' }, { timeoutMs: 45000 });
  const cookie = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: NEG, rol: 'admin' }))}`;
  const verificar = async () => {
    const r = await fetch(`${srv.base}/api/integraciones/whatsapp/verificar`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  await t('21. «Verificar conexión» con la credencial vencida: no dice «Todo listo» y pide reconectar', async () => {
    await pool.query(`UPDATE integraciones_canal SET identificador = 'PNID_CREDENCIAL_VENCIDA' WHERE negocio_id = $1 AND canal = 'whatsapp'`, [NEG]);
    const r = await verificar();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, false, `dijo «${r.body.mensaje}» con la credencial vencida`);
    assert.ok(r.body.acciones.includes(P.FALTANTE_CREDENCIAL), JSON.stringify(r.body.acciones));
    assert.equal(r.body.estado?.estadoVisible, 'requiere_reconexion', 'la tarjeta no pasó a «Requiere reconexión»');
    assert.deepEqual(buscarFugas(r.body), []);
    assert.equal((await fila()).ultimo_error_codigo, 'credencial:190');
  });

  await t('22. «Verificar conexión» con la credencial viva borra la marca', async () => {
    await pool.query(`UPDATE integraciones_canal SET identificador = $2 WHERE negocio_id = $1 AND canal = 'whatsapp'`, [NEG, PNID]);
    const r = await verificar();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!r.body.acciones.includes(P.FALTANTE_CREDENCIAL), JSON.stringify(r.body.acciones));
    assert.notEqual(r.body.estado?.estadoVisible, 'requiere_reconexion');
    assert.equal((await fila()).ultimo_error_codigo, null);
  });

  await t('23. ningún registro lleva la credencial; el rechazo sí queda registrado', async () => {
    const todo = registros.join('\n') + '\n' + (srv?.obtenerSalida() || '');
    assert.ok(!todo.includes(TOKEN) && !todo.includes(TOKEN_NUEVO), 'un registro trae la credencial');
    assert.match(todo, /\[WA-CREDENCIAL\] RECHAZADA negocio=\S+ codigo=credencial:190/);
  });
} finally {
  srv?.detener();
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas) { for (const f of fallos) console.log(` - ${f}`); process.exit(1); }
process.exit(0);
