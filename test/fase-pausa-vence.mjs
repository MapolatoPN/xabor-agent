// ─── LAS PAUSAS DEL BOT VENCEN: LA POLÍTICA, SIN BASE ───────────────────────
//
// P3 (3-oct-2026): 63 pausas activas en Obispado que no iban a vencer nunca.
// Aquí se prueba la DECISIÓN pura (pausaVencePolitica.js) guarda por guarda,
// el resumen al encargado y el cableado (job en la sección de jobs, migración
// en el runner del predeploy). La parte con Postgres —candado, verificación
// optimista, escrituras, simulación deduplicada— está en
// fase-pausa-vence-db.mjs.
//
// Uso: node test/fase-pausa-vence.mjs   (CASOS=01,07 para correr solo esos)
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {
  horasDeVencimiento, banderaEncendida, soltarApagado, decidirVencimiento, clasificarOrigen,
  grupoDelMotivo, motivoDeDineroOIncierto, opcionesDeConfiguracion, textoDelResumen,
  HORAS_MINIMAS, MOTIVOS_DE_SOLTAR, MOTIVOS_PETICION, MOTIVOS_DE_SISTEMA, MOTIVOS_QUE_NUNCA_VENCEN,
} from '../src/services/pausaVencePolitica.js';
import { HORAS_PARA_REABRIR } from '../src/mesero-agente/cicloDelAgente.js';
import { SQL_CANDIDATAS, claveDelCandado } from '../src/services/vencimientoPausasWhatsapp.js';

const leer = (ruta) => readFileSync(new URL(`../${ruta}`, import.meta.url), 'utf8');
let n = 0; let fallidas = 0;
const SOLO = (process.env.CASOS || '').split(',').map((s) => s.trim()).filter(Boolean);
async function caso(nombre, fn) {
  if (SOLO.length && !SOLO.includes(nombre.split(' ')[0])) return;
  try { await fn(); console.log(`OK pausa-vence ${++n}: ${nombre}`); }
  catch (e) {
    fallidas++;
    console.log(`FALLA pausa-vence: ${nombre}\n  ${String(e?.message || e).split('\n')[0]}`);
  }
}

// Una revisión automática de 13 h, sin nada que la retenga: el caso base que
// cada prueba modifica en UNA sola cosa.
const base = Object.freeze({
  bot_whatsapp_activo: true, bot_pausado: true, updated_by: null, ultima_accion: null,
  requiere_revision: true, motivo: 'AGENTE_RESPUESTA_NO_ENTREGADA', minutos_soltar: null,
  solicitud_servicio: false, takeover_vigente: false, entradas_pendientes: 0, entradas_procesando: 0,
  cliente_esperando: false, humano_tras_revision: false, horas_sin_personal: '13.5',
  confirmacion_incierta: false, confirmacion_sin_resultado: false, handoff_motivo: null, motivos_agente: null,
  pedido_esperando_pago: false,
});
const DOCE = { horas: 12, incluirManuales: false, venceSinAtender: false };
const decide = (cambios, opciones = DOCE) => decidirVencimiento({ ...base, ...cambios }, opciones);

await caso('01 horas: vacío, 0, negativo o inválido apaga; menos de 6 sube a 6', () => {
  for (const v of [undefined, null, '', '  ', '0', 0, '-3', 'abc', 'Infinity', NaN]) {
    assert.equal(horasDeVencimiento(v), null, `«${v}» debía apagar`);
  }
  assert.equal(horasDeVencimiento('2'), 6);
  assert.equal(horasDeVencimiento('0.5'), 6);
  assert.equal(horasDeVencimiento(' 12 '), 12);
  assert.equal(horasDeVencimiento('24'), 24);
  assert.equal(decide({}, { ...DOCE, horas: null }).razon, 'apagado');
});

await caso('02 el mínimo de 6 h es el mismo corte con el que el agente abre ciclo nuevo', () => {
  assert.equal(HORAS_MINIMAS, HORAS_PARA_REABRIR);
});

await caso('03 banderas: solo la cadena «true» enciende', () => {
  assert.equal(banderaEncendida('true'), true);
  assert.equal(banderaEncendida(' true '), true);
  for (const v of ['TRUE', '1', 'si', 'false', '', null, undefined, true]) {
    assert.equal(banderaEncendida(v), v === true ? true : false, `«${v}»`);
  }
  const o = opcionesDeConfiguracion({ whatsapp_pausa_vence_horas: '12', whatsapp_pausa_vence_manuales: 'true',
    whatsapp_pausa_vence_simular: 'si', whatsapp_pausa_vence_sin_atender: 'true' });
  assert.deepEqual(o, { horas: 12, incluirManuales: true, venceSinAtender: true, simular: false, avisoWhatsapp: false });
  assert.deepEqual(opcionesDeConfiguracion({}),
    { horas: null, incluirManuales: false, venceSinAtender: false, simular: false, avisoWhatsapp: false });
  // El resumen por WhatsApp al encargado va aparte y solo con «true».
  assert.equal(opcionesDeConfiguracion({ whatsapp_pausa_vence_aviso_whatsapp: 'true' }).avisoWhatsapp, true);
  assert.equal(opcionesDeConfiguracion({ whatsapp_pausa_vence_aviso_whatsapp: 'si' }).avisoWhatsapp, false);
});

await caso('04 soltar(): mismos tres motivos y misma lectura de bot_revision_minutos que whatsappContinuidad', () => {
  const fuente = leer('src/services/whatsappContinuidad.js');
  const lista = fuente.match(/REVISIONES_RECUPERABLES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(lista, 'no encontré REVISIONES_RECUPERABLES');
  const motivos = [...lista[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(motivos, [...MOTIVOS_DE_SOLTAR].sort());
  assert.match(fuente, /const MINUTOS_POR_DEFECTO = 30;/);
  for (const v of [null, undefined, '', ' ', 'abc', '30', '1']) assert.equal(soltarApagado(v), false, `«${v}»`);
  for (const v of ['0', '-1', ' 0 ']) assert.equal(soltarApagado(v), true, `«${v}»`);
});

await caso('05 automática con más de N h sin personal vence; con menos, no', () => {
  const d = decide({});
  assert.equal(d.vence, true); assert.equal(d.origen, 'automatica'); assert.equal(d.grupo, 'sistema');
  assert.equal(decide({ horas_sin_personal: '11.9' }).razon, 'reciente');
  assert.equal(decide({ horas_sin_personal: null }).razon, 'reciente');
  assert.equal(decide({ horas_sin_personal: '24.1' }, { ...DOCE, horas: 24 }).vence, true);
});

await caso('06 interruptor maestro apagado o conversación sin pausa: nada que hacer', () => {
  assert.equal(decide({ bot_whatsapp_activo: false }).razon, 'bot_del_negocio_apagado');
  assert.equal(decide({ bot_whatsapp_activo: null }).razon, 'bot_del_negocio_apagado');
  assert.equal(decide({ bot_pausado: false, requiere_revision: false }).razon, 'sin_pausa');
});

await caso('07 manuales: con la bandera apagada no vencen; con «true» sí', () => {
  const manual = { requiere_revision: false, motivo: null, updated_by: 'u-1' };
  assert.equal(decide(manual).razon, 'manual_excluida');
  const d = decide(manual, { ...DOCE, incluirManuales: true });
  assert.equal(d.vence, true); assert.equal(d.origen, 'manual');
});

await caso('08 clasificación por evidencia positiva', () => {
  // El bot sobrescribió con NULL una pausa que una persona tomó.
  assert.equal(clasificarOrigen({ ...base, motivo: 'SOLICITUD_CLIENTE', ultima_accion: 'tomar_conversacion' }), 'manual');
  assert.equal(decide({ motivo: 'SOLICITUD_CLIENTE', ultima_accion: 'tomar_conversacion' }).razon, 'manual_excluida');
  // «Devolver al bot» también deja updated_by: sin pausa no prueba nada.
  assert.equal(clasificarOrigen({ ...base, bot_pausado: false, updated_by: 'u-1' }), 'automatica');
  assert.equal(decide({ bot_pausado: false, updated_by: 'u-1' }).vence, true);
  // Sin revisión: la huérfana de una solicitud del menú y el relleno de la 066.
  const sinRevision = { requiere_revision: false, motivo: null };
  assert.equal(clasificarOrigen({ ...base, ...sinRevision, solicitud_servicio: true }), 'huerfana');
  assert.equal(clasificarOrigen({ ...base, ...sinRevision }), 'desconocida');
  assert.equal(decide({ ...sinRevision, solicitud_servicio: true }).razon, 'manual_excluida');
  assert.equal(decide(sinRevision).razon, 'manual_excluida');
  assert.equal(decide(sinRevision, { ...DOCE, incluirManuales: true }).origen, 'desconocida');
  assert.equal(decide(sinRevision, { ...DOCE, incluirManuales: true }).vence, true);
});

await caso('09 lista cerrada de motivos: dinero, efecto incierto o desconocido nunca vencen', () => {
  for (const m of ['AGENTE_ESTADO_INCIERTO', 'COMPROBANTE_PAGO', 'EJECUCION_INTERRUMPIDA', 'REENTREGA_LEGADA',
    'AGENTE_CONFIRMACION_INCIERTA', 'AGENTE_ENLACE_PAGO_FALLO', 'PAGO_ALGO_NUEVO', 'MOTIVO_QUE_NADIE_CONOCE', null, '']) {
    assert.equal(decide({ motivo: m }).razon, 'motivo_no_vence', `«${m}»`);
    // Ni con todas las banderas encendidas.
    assert.equal(decide({ motivo: m, updated_by: 'u-1' }, { horas: 12, incluirManuales: true, venceSinAtender: true }).vence, false, `«${m}» manual`);
  }
  for (const s of [MOTIVOS_DE_SOLTAR, MOTIVOS_PETICION, MOTIVOS_DE_SISTEMA]) {
    for (const m of s) assert.ok(!MOTIVOS_QUE_NUNCA_VENCEN.has(m) && !motivoDeDineroOIncierto(m), `${m} está en dos listas`);
  }
  assert.equal(grupoDelMotivo('AGENTE_PIDE_HUMANO'), 'peticion');
  assert.equal(grupoDelMotivo('AGENTE_RESPUESTA_NO_ENTREGADA'), 'sistema');
});

await caso('10 los motivos que suelta soltar() no tienen segundo dueño', () => {
  for (const m of MOTIVOS_DE_SOLTAR) {
    assert.equal(decide({ motivo: m }).razon, 'la_suelta_continuidad', m);
    assert.equal(decide({ motivo: m, minutos_soltar: '30' }).razon, 'la_suelta_continuidad', m);
    // El negocio apagó soltar(): entonces sí.
    assert.equal(decide({ motivo: m, minutos_soltar: '0' }).vence, true, m);
  }
  // Tomada por una persona: soltar() no la toca nunca; queda tras la bandera de manuales.
  assert.equal(decide({ motivo: 'ESCALADA_MODELO', updated_by: 'u-1' }, { ...DOCE, incluirManuales: true }).vence, true);
});

await caso('11 dinero y estado del agente: fallo cerrado aunque la revisión diga otra cosa', () => {
  assert.equal(decide({ motivo: 'AGENTE_PIDE_HUMANO', humano_tras_revision: true, confirmacion_incierta: true }).razon, 'confirmacion_incierta');
  // Una confirmar_pedido 'pendiente' o 'error' en el libro, aunque el estado
  // del turno se haya perdido (sin confirmacionIncierta).
  assert.equal(decide({ confirmacion_sin_resultado: true }).razon, 'confirmacion_sin_resultado');
  assert.equal(decide({ motivo: 'AGENTE_NO_PUDO_ATENDER', humano_tras_revision: true, confirmacion_sin_resultado: true },
    { ...DOCE, venceSinAtender: true }).razon, 'confirmacion_sin_resultado');
  for (const h of ['AGENTE_ENLACE_PAGO_FALLO', 'AGENTE_CONFIRMACION_INCIERTA', 'PAGO_RARO',
    'El cliente dice que ya pagó y no le llegó el comprobante', 'quiere un reembolso', 'pregunta por su transferencia',
    // Revisión del 3-oct: estas cinco se escapaban.
    'el cliente dice que ya transfirió', 'transferí hace rato', 'cliente reporta cargo duplicado',
    'el repartidor no le dio cambio', 'manda foto del ticket',
    'pagará en efectivo', 'trae el voucher de la terminal', 'me cargaron dos veces', 'le pasé la CLABE',
    'pregunta si puede pagar en OXXO', 'dejó propina de más', 'quiere que le devuelvan lo de ayer']) {
    assert.equal(decide({ handoff_motivo: h }).razon, 'traspaso_de_dinero_o_incierto', h);
  }
  // Sin dinero: ni «cambiar» la dirección ni el horario.
  for (const h of ['quiere cambiar la dirección de entrega', 'pregunta por el horario del domingo']) {
    assert.equal(motivoDeDineroOIncierto(h), false, h);
  }
  assert.equal(decide({ motivos_agente: ['AGENTE_PIDE_HUMANO', 'AGENTE_RESPUESTA_INCIERTA'] }).razon, 'agente_marco_dinero_o_incierto');
  assert.equal(decide({ pedido_esperando_pago: true }).razon, 'pedido_esperando_pago');
  // Un traspaso en texto libre que no habla de dinero no retiene.
  assert.equal(decide({ handoff_motivo: 'El cliente quiere hablar con alguien del equipo' }).vence, true);
  assert.equal(decide({ motivos_agente: ['AGENTE_PIDE_HUMANO', 'AGENTE_RESPUESTA_NO_ENTREGADA'] }).vence, true);
});

await caso('12 takeover vigente: alguien atiende desde la Business App', () => {
  assert.equal(decide({ takeover_vigente: true }).razon, 'takeover_vigente');
});

await caso('13 entradas: con revisión lo pendiente se revisa; lo procesando nunca se pisa', () => {
  assert.equal(decide({ entradas_pendientes: '2' }).vence, true);
  assert.equal(decide({ entradas_procesando: '1' }).razon, 'turno_en_curso');
  const sinRevision = { requiere_revision: false, motivo: null, updated_by: 'u-1' };
  const manuales = { ...DOCE, incluirManuales: true };
  assert.equal(decide({ ...sinRevision, entradas_pendientes: 1 }, manuales).razon, 'lote_por_procesar');
  assert.equal(decide({ ...sinRevision, entradas_procesando: 1 }, manuales).razon, 'turno_en_curso');
});

await caso('14 cliente esperando respuesta de una persona dentro de la ventana: no se libera', () => {
  assert.equal(decide({ cliente_esperando: true }).razon, 'cliente_esperando');
  assert.equal(decide({ cliente_esperando: true, updated_by: 'u-1', requiere_revision: false, motivo: null },
    { ...DOCE, incluirManuales: true }).razon, 'cliente_esperando');
});

await caso('15 petición explícita: vence solo si alguien del equipo llegó a escribir', () => {
  for (const m of MOTIVOS_PETICION) {
    assert.equal(decide({ motivo: m }).razon, 'peticion_sin_atender', m);
    assert.equal(decide({ motivo: m, humano_tras_revision: true }).vence, true, m);
    assert.equal(decide({ motivo: m }, { ...DOCE, venceSinAtender: true }).vence, true, m);
  }
  // Una falla del sistema no exige que alguien haya escrito.
  for (const m of MOTIVOS_DE_SISTEMA) assert.equal(decide({ motivo: m }).vence, true, m);
  // Al cliente se le prometió una persona: el rescate de P2 y el turno que
  // reventó son PETICIONES, no fallas del sistema (revisión del 3-oct).
  for (const m of ['FORMULARIO_NO_CARGA', 'AGENTE_FALLO_REPETIDO', 'AGENTE_NO_PUDO_ATENDER']) {
    assert.equal(grupoDelMotivo(m), 'peticion', m);
    assert.ok(!MOTIVOS_DE_SISTEMA.has(m), `${m} sigue en la lista de sistema`);
    assert.equal(decide({ motivo: m }).razon, 'peticion_sin_atender', m);
    assert.equal(decide({ motivo: m, humano_tras_revision: true }).vence, true, m);
  }
});

await caso('16 revisión sin pausa (setBotPausado falló o REENTREGA sin pausa) también entra', () => {
  const d = decide({ bot_pausado: false });
  assert.equal(d.vence, true); assert.equal(d.origen, 'automatica');
});

await caso('17 resumen al encargado: un mensaje, últimos 4 dígitos, nunca el teléfono completo', () => {
  const tel = '520000123456';
  const liberadas = Array.from({ length: 18 }, (_, i) => ({ telefono: `${tel.slice(0, -2)}${String(i).padStart(2, '0')}`,
    nombre: i === 0 ? '  Cliente   de prueba ' : null, origen: i % 2 ? 'manual' : 'automatica',
    motivo: i % 2 ? null : 'SOLICITUD_CLIENTE', horas_sin_personal: '13.7' }));
  const t = textoDelResumen(liberadas, 12);
  assert.match(t, /18 conversaciones/); assert.match(t, /más de 12 h/);
  assert.match(t, /\*\*\*3400 · Cliente de prueba · revisión del bot: el cliente pidió una persona · 13 h/);
  assert.match(t, /pausa manual · 13 h/);
  assert.match(t, /… y 3 más\./);
  assert.doesNotMatch(t, /\d{6,}/, 'el resumen trae un teléfono completo');
  assert.match(textoDelResumen(liberadas.slice(0, 1), 12), /una conversación que llevaba más/);
});

await caso('18 la consulta mide en SQL con now() y usa el MISMO candado que la continuidad', () => {
  assert.match(SQL_CANDIDATAS, /now\(\) - GREATEST\(/);
  assert.match(SQL_CANDIDATAS, /m\.origen = 'humano'/);
  assert.match(SQL_CANDIDATAS, /'whatsapp_pausa_vence_horas'/);
  assert.equal(claveDelCandado('N', 'T'), 'wa:N:T');
  const fuente = leer('src/services/whatsappContinuidad.js');
  assert.match(fuente, /const clave = \(n, t\) => `wa:\$\{n\}:\$\{t\}`;/);
  assert.match(leer('src/server.js'), /\[`wa:\$\{negocioId\}:\$\{telefono\}`\]/);
});

await caso('19 cableado: job de 5 min en la sección de jobs, con guarda de reentrada, fuera de las rutas', () => {
  const server = leer('src/server.js');
  const job = server.indexOf('vencerPausasWhatsapp({');
  assert.ok(job > server.indexOf('// ─── Job: rescate de conversaciones en espera'), 'el job no está junto al de rescate');
  const tramo = server.slice(server.lastIndexOf('setInterval(() => {', job), server.indexOf('}, 5 * 60 * 1000);', job));
  assert.match(tramo, /if \(vencimientoPausasEnCurso\) return;/);
  assert.match(tramo, /broadcastNegocio\(negocioId, data\)/);
  assert.doesNotMatch(tramo, /app\.(get|post|patch|put)\(/);
  // Las rutas protegidas no lo mencionan.
  for (const ruta of ["app.patch('/pedidos/:id/estado'", "app.post('/pedidos'"]) {
    const i = server.indexOf(ruta);
    if (i < 0) continue;
    assert.doesNotMatch(server.slice(i, server.indexOf('\n});', i)), /vencerPausas|pausaVence/);
  }
});

await caso('20 migración 113: en el runner del predeploy, con su script y su reverso', () => {
  const runner = leer('scripts/predeploy-run-032-033.mjs');
  const i112 = runner.indexOf("'112-caja-correcciones'"); const i113 = runner.indexOf("'113-pausa-vencimientos'");
  assert.ok(i112 > 0 && i113 > i112, '113 no está después de la 112 en SCRIPTS');
  for (const f of ['scripts/predeploy-113-pausa-vencimientos.mjs', 'migrations/113_conversaciones_pausa_vencimientos.sql',
    'migrations/113_conversaciones_pausa_vencimientos_down.sql']) {
    assert.ok(existsSync(new URL(`../${f}`, import.meta.url)), `falta ${f}`);
  }
  const sql = leer('migrations/113_conversaciones_pausa_vencimientos.sql');
  assert.match(sql, /UNIQUE \(negocio_id, telefono, modo, identidad_pausa\)/);
  assert.match(sql, /horas_configuradas >= 6/);
  // Los dos conteos del predeploy salen de UNA foto: el tráfico en vivo del
  // binario viejo no puede abortar el despliegue. La prueba real, con un
  // mensaje entre los dos conteos, es el caso 36 de fase-pausa-vence-db.
  assert.match(leer('scripts/predeploy-113-pausa-vencimientos.mjs'), /BEGIN ISOLATION LEVEL REPEATABLE READ/);
});

console.log(`Pausa vence (pura): ${n} pasadas, ${fallidas} fallidas.`);
if (fallidas) process.exitCode = 1;
