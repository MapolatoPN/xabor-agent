// ─── ACTIVACIÓN DEL MODO FORMULARIO (PARTE 1) ──────────────────────────────
//
// scripts/activar-modo-ia.mjs y su lógica pura (activacionModoIA.js):
//   · cada precondición que bloquea, por separado (y las que solo avisan);
//   · `plan` no escribe; `activar` escribe las claves y el respaldo juntos;
//   · --prueba → --todos conserva el «antes» original;
//   · revertir restaura y no pisa un cambio ajeno; claves a mano sin respaldo → error.
// La parte pura corre sin base; la de la base, con DATABASE_URL a una test_botones_*.
// --faqs (validación, reemplazo y reversa por sha1) y --publicar-selector.
import assert from 'node:assert/strict';
import * as F from '../scripts/fixture-tienda-plomeria.mjs';
import { precondicionesDeActivacion, planActivacionModoIA, planReversaModoIA, CLAVE_RESPALDO_MODO_IA, CLAVES_ACTIVACION }
  from '../src/mesero-agente/activacionModoIA.js';
import { CLAVES_IA, modoIA } from '../src/mesero-agente/recepcionista.js';
Object.assign(process.env, { MESERO_AGENTE_MODE: 'true', WHATSAPP_INTERACTIVOS: 'true', WHATSAPP_FLOW_ENDPOINT: 'true',
  WHATSAPP_FLOW_PRIVATE_KEY: 'solo-local', META_APP_SECRET: 'solo-local' });

let pasadas = 0, fallidas = 0;
const SOLO = (process.env.CASOS || '').split(',').map((s) => s.trim()).filter(Boolean);
const t = async (nombre, fn) => {
  if (SOLO.length && !SOLO.some((p) => nombre.startsWith(p))) return;
  try { await fn(); pasadas++; console.log(`  ok  ${nombre}`); } catch (e) { fallidas++; console.log(`FALLA ${nombre}: ${String(e.message).split('\n')[0]}`); }
};

const T = F.TELEFONO, T2 = '5218789999999';
const HECHOS = { carta: F.carta(), modalidades: F.modalidades, metodosPago: F.metodosPago, reglas: F.reglas,
  configTienda: { estado: 'publicada', aceptaProgramados: true, slug: 'mapolato' }, menuAutomaticoActivo: false, comercialCatering: false };
const cfgListo = (extra = {}) => ({ ...F.cfgTienda('true'), whatsapp_interactivos_v1: 'true', whatsapp_interactivos_elecciones_v1: 'true',
  whatsapp_rescate_humano_v1: 'true', whatsapp_beta_hibrido_v1: 'true', whatsapp_eventos_formulario_v1: 'true',
  whatsapp_flow_evento_id: '77777777777', mesero_agente_v1: 'true', mesero_agente_porcentaje: '100', mesero_agente_telefonos: '',
  bot_whatsapp_solo_prueba: 'false', whatsapp_pausa_vence_horas: '12', ...extra });
const plan = (cfg, o = {}) => planActivacionModoIA(cfg, { modo: 'formulario', alcance: 'todos', hechos: HECHOS, ...o });
const aplicar = (cfg, cambios) => {
  const fuera = { ...cfg };
  for (const [k, v] of Object.entries(cambios)) { if (v === null) delete fuera[k]; else fuera[k] = v; }
  return fuera;
};

try {
  await t('A1 todas las precondiciones: activa, el modo queda encendido y completo', () => {
    const p = plan(cfgListo());
    assert(!p.error, p.error);
    assert.deepEqual(p.cambios, { [CLAVES_IA.MODO]: 'formulario', [CLAVES_IA.ALCANCE]: 'todos', [CLAVES_IA.TELEFONOS]: null, [CLAVES_IA.PUBLICAR_SELECTOR]: null });
    const despues = aplicar({ ...cfgListo(), [CLAVE_RESPALDO_MODO_IA]: JSON.stringify(p.respaldo) }, p.cambios);
    assert.equal(modoIA(despues, T)?.completo, true);
    assert.deepEqual(p.respaldo.antes, Object.fromEntries(CLAVES_ACTIVACION.map((k) => [k, null])));
    assert(p.avisos.some((a) => a.startsWith('proceso:')), 'falta el aviso de las variables de proceso');
  });
  await t('A2 cada precondición que bloquea, por separado', () => {
    const caidas = {
      mesero: { mesero_agente_v1: 'false' },
      alcance_mesero: { mesero_agente_porcentaje: '99' },
      'alcance_mesero (lista)': { mesero_agente_telefonos: T },
      'alcance_mesero (solo prueba)': { bot_whatsapp_solo_prueba: 'true' },
      interactivos_negocio: { whatsapp_interactivos_v1: 'false' },
      formularios: { whatsapp_flows_v1: 'false' },
      elecciones: { whatsapp_interactivos_elecciones_v1: 'false' },
      rescate: { whatsapp_rescate_humano_v1: '' },
      inicio_mapo: { whatsapp_inicio_mapo_v1: 'false' },
      beta_hibrida: { whatsapp_beta_hibrido_v1: 'false' },
      eventos_formulario: { whatsapp_eventos_formulario_v1: 'false' },
    };
    for (const [nombre, extra] of Object.entries(caidas)) {
      const id = nombre.split(' ')[0];
      const p = plan(cfgListo(extra));
      assert.match(String(p.error), new RegExp(`\\b${id}\\b`), `${nombre}: ${p.error}`);
      assert.equal(p.cambios, undefined);
    }
    assert.match(String(plan(cfgListo(), { hechos: { ...HECHOS, carta: [] } }).error), /formulario_pedido/);
    assert.match(String(plan(cfgListo({ whatsapp_flow_categorias_id: '', whatsapp_flow_tienda_v1: '' })).error), /formulario_pedido/);
    // Revisión 3: el catering heredado bloquea (brain.js le contestaría con texto del modelo).
    const catering = plan(cfgListo(), { hechos: { ...HECHOS, comercialCatering: true } });
    assert.match(String(catering.error), /\bcatering_legado\b/); assert.equal(catering.cambios, undefined);
  });
  await t('A3 las que solo avisan no bloquean', () => {
    const p = plan(cfgListo({ whatsapp_pausa_vence_horas: '', whatsapp_flow_nota_v1: 'true' }),
      { hechos: { ...HECHOS, menuAutomaticoActivo: true, configTienda: null } });
    assert(!p.error, p.error);
    for (const id of ['pausa_vence', 'menu_imagen', 'tienda_programados', 'proceso', 'nota_libre']) {
      assert(p.avisos.some((a) => a.startsWith(`${id}:`)), id);
    }
    // La nota libre avisa con la nota del pedido o con la tienda (su nota para cocina); sin ninguna, no.
    const sinNota = plan(cfgListo({ whatsapp_flow_tienda_v1: '', whatsapp_flow_nota_v1: 'false' }));
    assert(!sinNota.error, sinNota.error); assert(!sinNota.avisos.some((a) => a.startsWith('nota_libre:')), 'avisó sin nota');
    assert(plan(cfgListo({ whatsapp_flow_tienda_v1: '', whatsapp_flow_nota_v1: 'true' })).avisos.some((a) => a.startsWith('nota_libre:')));
    assert(plan(cfgListo({ whatsapp_flow_tienda_v1: 'prueba', whatsapp_flow_nota_v1: 'false' }), { alcance: 'prueba', telefonos: T })
      .avisos?.some((a) => a.startsWith('nota_libre:')), 'la tienda (nota para cocina) no avisó');
  });
  await t('A4 --prueba: los teléfonos deben estar en el alcance del Mesero; valida el formato', () => {
    const conLista = cfgListo({ bot_whatsapp_solo_prueba: 'true', mesero_agente_telefonos: `${T},${T2}`, whatsapp_atencion_general_v1: 'false',
      whatsapp_flows_telefonos: `${T},${T2}`, whatsapp_beta_telefonos: `${T},${T2}` });
    const ok = planActivacionModoIA(conLista, { modo: 'formulario', alcance: 'prueba', telefonos: `${T}, ${T2}`, hechos: HECHOS });
    assert(!ok.error, ok.error);
    assert.equal(ok.cambios[CLAVES_IA.TELEFONOS], `${T},${T2}`);
    const fuera = planActivacionModoIA(conLista, { modo: 'formulario', alcance: 'prueba', telefonos: '5218780001111', hechos: HECHOS });
    assert.match(String(fuera.error), /alcance_mesero/);
    assert.match(String(planActivacionModoIA(conLista, { modo: 'formulario', alcance: 'prueba', telefonos: 'abc', hechos: HECHOS }).error), /teléfonos/);
    assert.match(String(planActivacionModoIA(cfgListo(), { modo: 'Formulario', alcance: 'todos', hechos: HECHOS }).error), /modo/);
    assert.match(String(planActivacionModoIA(cfgListo(), { modo: 'formulario', alcance: 'true', hechos: HECHOS }).error), /alcance/);
  });
  await t('A5 respaldo: prueba → todos conserva el «antes»; cambio ajeno → no sobrescribe; claves a mano → error', () => {
    const conLista = cfgListo({ mesero_agente_porcentaje: '100' });
    const p1 = planActivacionModoIA(conLista, { modo: 'formulario', alcance: 'prueba', telefonos: T, hechos: HECHOS });
    assert(!p1.error, p1.error);
    const tras1 = aplicar({ ...conLista, [CLAVE_RESPALDO_MODO_IA]: JSON.stringify(p1.respaldo) }, p1.cambios);
    const p2 = plan(tras1);
    assert(!p2.error, p2.error); assert.equal(p2.reemplazaRespaldo, true);
    assert.deepEqual(p2.respaldo.antes, p1.respaldo.antes, 'perdió el antes original');
    const ajeno = { ...tras1, [CLAVES_IA.TELEFONOS]: `${T},${T2}` };
    assert.match(String(plan(ajeno).error), /cambió después de activar/);
    assert.match(String(plan(cfgListo({ [CLAVES_IA.MODO]: 'formulario' })).error), /puestas a mano/);
    assert.match(String(plan(cfgListo({ [CLAVES_IA.ALCANCE]: 'todos' })).error), /puestas a mano/);
  });
  await t('A6 reversa: restaura lo de antes, acepta lo ya quitado a mano, no pisa un cambio ajeno', () => {
    const p = plan(cfgListo());
    const tras = aplicar({ ...cfgListo(), [CLAVE_RESPALDO_MODO_IA]: JSON.stringify(p.respaldo) }, p.cambios);
    const r = planReversaModoIA(tras);
    assert(!r.error, r.error);
    const revertido = aplicar(tras, r.aplicar);
    assert.equal(modoIA(revertido, T), null);
    assert(CLAVES_ACTIVACION.every((k) => revertido[k] === undefined));
    const aMano = { ...tras }; delete aMano[CLAVES_IA.MODO];
    assert(!planReversaModoIA(aMano).error, 'no aceptó lo ya quitado a mano');
    assert.match(String(planReversaModoIA({ ...tras, [CLAVES_IA.MODO]: 'recepcionista' }).error), /cambió después/);
    assert.match(String(planReversaModoIA(cfgListo()).error), /Sin respaldo/);
  });
  await t('A7 --publicar-selector: solo con recepcionista; sin él, el aviso de sombra', () => {
    assert.match(String(plan(cfgListo(), { publicarSelector: true }).error), /solo va con --recepcionista/);
    const pub = plan(cfgListo(), { modo: 'recepcionista', publicarSelector: true });
    assert(!pub.error, pub.error); assert.equal(pub.cambios[CLAVES_IA.PUBLICAR_SELECTOR], 'true');
    assert.equal(modoIA(aplicar({ ...cfgListo(), [CLAVE_RESPALDO_MODO_IA]: JSON.stringify(pub.respaldo) }, pub.cambios), T)?.publicarSelector, true);
    const sombra = plan(cfgListo(), { modo: 'recepcionista' });
    assert.equal(sombra.cambios[CLAVES_IA.PUBLICAR_SELECTOR], null); assert(sombra.avisos.some((a) => a.startsWith('selector:')));
    // De sombra a publicado: otra activación sobre el mismo respaldo.
    const tras = aplicar({ ...cfgListo(), [CLAVE_RESPALDO_MODO_IA]: JSON.stringify(sombra.respaldo) }, sombra.cambios);
    const p2 = plan(tras, { modo: 'recepcionista', publicarSelector: true });
    assert(!p2.error, p2.error); assert.deepEqual(p2.respaldo.antes, sombra.respaldo.antes);
  });

  // ── Preguntas frecuentes (--faqs) ──────────────────────────────────────
  const REGLAS = { ...F.reglas, horarios: Object.fromEntries(['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']
    .map((d) => [d, { abierto: true, apertura: '07:30', cierre: '15:00' }])), cierres_especiales: [], promociones: [], politicas: [],
  pedidos: { ...F.reglas.pedidos, costo_envio: 60, pedido_minimo_entrega: 0 },
  bot: { tono: 'cálido', faqs: [{ pregunta: '¿Tienen mesas?', respuesta: 'Para información, márcanos.' }] } };
  const cfgConReglas = (extra = {}) => cfgListo({ reglas_atencion: JSON.stringify(REGLAS), ...extra });
  const BUENAS = [{ pregunta: '¿Tienen mesas? ¿Puedo comer en el local?', respuesta: 'Sí, tenemos mesas en el local. No tomamos reservaciones.' },
    { pregunta: 'Cumpleaños', respuesta: 'El día de tu cumpleaños desayunas gratis en el local, con identificación.' },
    { pregunta: 'Sucursales', respuesta: 'Estamos en Piedras Negras. Muy pronto abrimos en Ciudad Acuña.' }];
  const { validarArchivoFaqs, shaDeFaqs } = await import('../src/mesero-agente/activacionModoIA.js');
  const contexto = { cfg: cfgConReglas(), metodosPago: F.metodosPago, modalidades: F.modalidades };
  await t('F1 validarArchivoFaqs: marcas, tarifa, largo, repetidas, tema de la configuración, campos de más, cantidad', () => {
    assert.deepEqual(validarArchivoFaqs(BUENAS, REGLAS, contexto), { faqs: BUENAS });
    const rechazo = (lista, re, nombre) => {
      const r = validarArchivoFaqs(lista, REGLAS, contexto);
      assert(r.errores, `${nombre}: aceptó`); assert(r.errores.some((e) => re.test(e)), `${nombre}: ${r.errores}`);
    };
    rechazo([{ pregunta: 'Rosas', respuesta: 'Las rosas cuestan [CONFIRMAR CON MARIO: precio].' }], /CONFIRMAR/, 'marca');
    rechazo([{ pregunta: 'Envío a la UTNC', respuesta: 'A la UTNC el envío cuesta $150.' }], /tarifa de envío/, 'tarifa');
    rechazo([{ pregunta: 'Larga', respuesta: 'x'.repeat(1001) }], /de 2 a 1000/, 'largo');
    rechazo([{ pregunta: 'x', respuesta: 'Hola' }], /de 2 a 120/, 'pregunta corta');
    rechazo([BUENAS[1], { pregunta: 'cumpleaños', respuesta: 'Otra.' }], /repite la pregunta/, 'repetida');
    rechazo([{ pregunta: '¿A qué hora abren?', respuesta: 'A las 7.' }], /duplica el tema «horario»/, 'tema horario');
    rechazo([{ pregunta: '¿Aceptan tarjeta?', respuesta: 'Sí.' }], /duplica el tema «pagos»/, 'tema pagos');
    rechazo([{ pregunta: 'Cumpleaños', respuesta: 'Sí.', id: 'x' }], /campos de más/, 'campos');
    rechazo([], /de 1 a 30/, 'vacía');
    rechazo(Array.from({ length: 31 }, (_, i) => ({ pregunta: `Pregunta ${i}`, respuesta: 'R.' })), /de 1 a 30/, 'muchas');
    rechazo({ pregunta: 'x' }, /arreglo/, 'no arreglo');
    rechazo([{ pregunta: 'Pizza', respuesta: 'Ya agregué tu pizza al pedido.' }], /afirma un cambio/, 'afirma');
    // 16 faqs + los temas de la configuración no caben en 9 + 10.
    rechazo(Array.from({ length: 16 }, (_, i) => ({ pregunta: `Tema extra número ${i}`, respuesta: `Respuesta ${i}.` })), /caben 19/, 'no caben');
  });
  await t('F2 plan con faqs: reglas_atencion lleva las nuevas y lo demás intacto; el respaldo guarda las de antes y el sha1', () => {
    const p = plan(cfgConReglas(), { faqs: BUENAS });
    assert(!p.error, p.error);
    const nuevas = JSON.parse(p.extra.reglas_atencion);
    assert.deepEqual(nuevas.bot.faqs, BUENAS); assert.equal(nuevas.bot.tono, 'cálido');
    assert.deepEqual({ ...nuevas, bot: null }, { ...REGLAS, bot: null }, 'tocó algo más de reglas_atencion');
    assert.deepEqual(p.respaldo.faqs_antes, REGLAS.bot.faqs); assert.equal(p.respaldo.faqs_despues_sha, shaDeFaqs(BUENAS));
    assert.match(String(plan(cfgConReglas(), { faqs: [{ pregunta: 'Rosas', respuesta: '[CONFIRMAR] $50' }] }).error), /rechazadas.*CONFIRMAR/);
    // Sin --faqs: reglas_atencion no se escribe.
    assert.deepEqual(plan(cfgConReglas()).extra, {});
  });
  await t('F3 reversa: restaura las de antes por sha1; editadas en el panel → error; ya restauradas → solo las claves', () => {
    const p = plan(cfgConReglas(), { faqs: BUENAS });
    const tras = aplicar({ ...cfgConReglas(), [CLAVE_RESPALDO_MODO_IA]: JSON.stringify(p.respaldo) }, { ...p.cambios, ...p.extra });
    const r = planReversaModoIA(tras);
    assert(!r.error, r.error);
    const revertidas = JSON.parse(r.extra.reglas_atencion);
    assert.deepEqual(revertidas, REGLAS, 'no dejó las reglas de antes');
    const editadas = JSON.parse(tras.reglas_atencion); editadas.bot.faqs[0].respuesta = 'Editada en el panel.';
    assert.match(String(planReversaModoIA({ ...tras, reglas_atencion: JSON.stringify(editadas) }).error), /cambiaron después de activar/);
    const yaRestauradas = planReversaModoIA({ ...tras, reglas_atencion: JSON.stringify(REGLAS) });
    assert(!yaRestauradas.error && !yaRestauradas.extra, JSON.stringify(yaRestauradas));
    // Sin faqs antes: la reversa quita bot.faqs.
    const sinFaqs = { ...REGLAS, bot: { tono: 'cálido' } };
    const p2 = plan(cfgListo({ reglas_atencion: JSON.stringify(sinFaqs) }), { faqs: BUENAS });
    const tras2 = aplicar({ ...cfgListo({ reglas_atencion: JSON.stringify(sinFaqs) }), [CLAVE_RESPALDO_MODO_IA]: JSON.stringify(p2.respaldo) }, { ...p2.cambios, ...p2.extra });
    assert.deepEqual(JSON.parse(planReversaModoIA(tras2).extra.reglas_atencion), sinFaqs);
  });
  await t('F4 una segunda carga conserva las faqs de ANTES de la primera; con las cargadas editadas no sobrescribe', () => {
    const p1 = plan(cfgConReglas(), { alcance: 'prueba', telefonos: T, faqs: BUENAS });
    assert(!p1.error, p1.error);
    const tras1 = aplicar({ ...cfgConReglas(), [CLAVE_RESPALDO_MODO_IA]: JSON.stringify(p1.respaldo) }, { ...p1.cambios, ...p1.extra });
    const otras = [BUENAS[0], { pregunta: 'Facturación', respuesta: 'Toca «Facturación» en el menú de inicio.' }];
    const p2 = plan(tras1, { faqs: otras });
    assert(!p2.error, p2.error);
    assert.deepEqual(p2.respaldo.faqs_antes, REGLAS.bot.faqs, 'perdió las faqs originales');
    assert.equal(p2.respaldo.faqs_despues_sha, shaDeFaqs(otras));
    // Sin --faqs, el respaldo arrastra lo de la primera carga.
    const p3 = plan(tras1);
    assert.deepEqual([p3.respaldo.faqs_antes, p3.respaldo.faqs_despues_sha], [REGLAS.bot.faqs, shaDeFaqs(BUENAS)]);
    const editadas = JSON.parse(tras1.reglas_atencion); editadas.bot.faqs.pop();
    assert.match(String(plan({ ...tras1, reglas_atencion: JSON.stringify(editadas) }, { faqs: otras }).error), /cambiaron después/);
  });

  // ── Contra la base ──────────────────────────────────────────────────────
  if (process.env.DATABASE_URL && /\/test_botones_/.test(process.env.DATABASE_URL)) {
    const { pool, actualizarConfiguracion } = await import('../src/services/database.js');
    const { prepararNegocioMixtos } = await import('./lib-botones-local.mjs');
    const { operarModoIA } = await import('../scripts/activar-modo-ia.mjs');
    const SHA = 'a'.repeat(40);
    const leer = async (negocioId) => Object.fromEntries((await pool.query('SELECT clave,valor FROM configuracion WHERE negocio_id=$1', [negocioId]))
      .rows.map((r) => [r.clave, r.valor]));
    const preparar = async () => {
      const f = await prepararNegocioMixtos();
      await actualizarConfiguracion({ whatsapp_inicio_mapo_v1: 'true', whatsapp_atencion_general_v1: 'true', bot_whatsapp_solo_prueba: 'false',
        mesero_agente_porcentaje: '100', mesero_agente_telefonos: '', whatsapp_flows_v1: 'true', whatsapp_beta_hibrido_v1: 'true',
        whatsapp_interactivos_elecciones_v1: 'true', whatsapp_flow_categorias_id: '11111111111', whatsapp_flow_carrito_id: '22222222222',
        whatsapp_carrito_unificado_v1: 'true', whatsapp_flow_evento_id: '77777777777', whatsapp_eventos_formulario_v1: 'true',
        whatsapp_rescate_humano_v1: 'true' }, f.negocioId);
      return f;
    };
    await t('B1 plan no escribe; activar escribe las claves y el respaldo; revertir los quita', async () => {
      const f = await preparar();
      const antes = await leer(f.negocioId);
      const p = await operarModoIA({ negocioId: f.negocioId, sha: SHA, accion: 'plan', modo: 'formulario', alcance: 'prueba', telefonos: f.telefono });
      assert.equal(p.error, null, p.error); assert.equal(p.escrituras, 0);
      assert.deepEqual(await leer(f.negocioId), antes, 'plan escribió');
      await operarModoIA({ negocioId: f.negocioId, sha: SHA, accion: 'activar', modo: 'formulario', alcance: 'prueba', telefonos: f.telefono });
      let cfg = await leer(f.negocioId);
      assert.equal(cfg[CLAVES_IA.MODO], 'formulario'); assert.equal(cfg[CLAVES_IA.ALCANCE], 'prueba'); assert.equal(cfg[CLAVES_IA.TELEFONOS], f.telefono);
      assert.equal(JSON.parse(cfg[CLAVE_RESPALDO_MODO_IA]).build, SHA);
      assert.equal(modoIA(cfg, f.telefono)?.completo, true);
      await operarModoIA({ negocioId: f.negocioId, sha: SHA, accion: 'activar', modo: 'formulario', alcance: 'todos' });
      cfg = await leer(f.negocioId);
      assert.equal(cfg[CLAVES_IA.ALCANCE], 'todos'); assert.equal(cfg[CLAVES_IA.TELEFONOS], undefined);
      assert.deepEqual(JSON.parse(cfg[CLAVE_RESPALDO_MODO_IA]).antes, Object.fromEntries(CLAVES_ACTIVACION.map((k) => [k, null])));
      await operarModoIA({ negocioId: f.negocioId, sha: SHA, accion: 'revertir' });
      assert.deepEqual(await leer(f.negocioId), antes, 'revertir no dejó la configuración de antes');
    });
    await t('B2 activar se niega sin una precondición y no escribe nada; revertir no pisa un cambio ajeno', async () => {
      const f = await preparar();
      await actualizarConfiguracion({ whatsapp_rescate_humano_v1: 'false' }, f.negocioId);
      const antes = await leer(f.negocioId);
      await assert.rejects(operarModoIA({ negocioId: f.negocioId, sha: SHA, accion: 'activar', modo: 'formulario', alcance: 'todos' }), /rescate/);
      assert.deepEqual(await leer(f.negocioId), antes);
      await actualizarConfiguracion({ whatsapp_rescate_humano_v1: 'true' }, f.negocioId);
      await operarModoIA({ negocioId: f.negocioId, sha: SHA, accion: 'activar', modo: 'formulario', alcance: 'todos' });
      await actualizarConfiguracion({ [CLAVES_IA.MODO]: 'recepcionista' }, f.negocioId);
      await assert.rejects(operarModoIA({ negocioId: f.negocioId, sha: SHA, accion: 'revertir' }), /cambió después/);
      assert.equal((await leer(f.negocioId))[CLAVES_IA.MODO], 'recepcionista');
      await assert.rejects(operarModoIA({ negocioId: f.negocioId, sha: 'corto', accion: 'plan' }));
    });
    await t('B3 --faqs y --publicar-selector contra la base: plan muestra el cambio por pregunta sin escribir; activar y revertir', async () => {
      const f = await preparar();
      await actualizarConfiguracion({ reglas_atencion: JSON.stringify(REGLAS) }, f.negocioId);
      const antes = await leer(f.negocioId);
      const args = { negocioId: f.negocioId, sha: SHA, modo: 'recepcionista', alcance: 'todos', publicarSelector: true, faqs: BUENAS };
      const p = await operarModoIA({ ...args, accion: 'plan' });
      assert.equal(p.error, null, p.error); assert.equal(p.escrituras, 0);
      assert.deepEqual(p.faqs, { quedan: [], cambian: [], nuevas: BUENAS.map((x) => x.pregunta), salen: ['¿Tienen mesas?'] });
      assert.deepEqual(await leer(f.negocioId), antes, 'plan escribió');
      await operarModoIA({ ...args, accion: 'activar' });
      let cfg = await leer(f.negocioId);
      assert.equal(cfg[CLAVES_IA.PUBLICAR_SELECTOR], 'true'); assert.deepEqual(JSON.parse(cfg.reglas_atencion).bot.faqs, BUENAS);
      assert.equal(modoIA(cfg, f.telefono)?.publicarSelector, true);
      // Un archivo con marcas no escribe nada.
      await assert.rejects(operarModoIA({ ...args, accion: 'activar', faqs: [{ pregunta: 'Rosas', respuesta: '[CONFIRMAR CON MARIO] $50' }] }), /CONFIRMAR/);
      assert.deepEqual(await leer(f.negocioId), cfg);
      await operarModoIA({ negocioId: f.negocioId, sha: SHA, accion: 'revertir' });
      assert.deepEqual(await leer(f.negocioId), antes, 'revertir no dejó la configuración (ni las faqs) de antes');
      // Editadas en el panel después de activar: revertir se niega y no toca nada.
      await operarModoIA({ ...args, accion: 'activar' });
      const r = JSON.parse((await leer(f.negocioId)).reglas_atencion); r.bot.faqs[0].respuesta = 'Editada en el panel.';
      await actualizarConfiguracion({ reglas_atencion: JSON.stringify(r) }, f.negocioId);
      const editada = await leer(f.negocioId);
      await assert.rejects(operarModoIA({ negocioId: f.negocioId, sha: SHA, accion: 'revertir' }), /cambiaron después de activar/);
      assert.deepEqual(await leer(f.negocioId), editada);
    });
    await pool.end();
  } else console.log('(sin base test_botones_*: solo la parte pura)');
} finally {
  console.log(`\nactivación del modo formulario: ${pasadas} pasadas, ${fallidas} fallidas`);
  if (fallidas) process.exitCode = 1;
}
