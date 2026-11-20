// ─── CAMPAÑAS DE WHATSAPP CON PLANTILLA: CONTRA POSTGRES ────────────────────
//
// Pedido de Mario (20-nov-2026, «sí, prepáralas»). src/services/campanasWa.js
// contra una base local test_botones_* y una Graph API SIMULADA en 127.0.0.1
// (META_GRAPH_BASE_URL). Sin red externa ni teléfonos reales.
//
//   M. la 142: se aplica sin tocar campañas viejas, es repetible, y sus reglas
//      frenan lo que no debe entrar.
//   B. el servicio: plantillas, a quién le llega, la cola, el trabajo que la
//      manda (horario, rechazos de Meta, red caída, detener), los acuses y el
//      historial; siempre dentro del negocio de la sesión.
//   R. las rutas: solo administradores con el módulo, el negocio de la sesión
//      y errores sin detalles internos.
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import express from 'express';

// ── Guardas: solo base local de pruebas, solo red local ──────────────────────
{
  const url = new URL(process.env.DATABASE_URL);
  assert(['127.0.0.1', 'localhost'].includes(url.hostname), 'solo base local');
  assert.match(url.pathname, /^\/test_botones_/, 'solo una base test_botones_*');
  assert.match(process.env.NODE_OPTIONS || '', /red-solo-local/, 'corre con NODE_OPTIONS=--import=./test/red-solo-local.mjs');
}

// ── Graph API simulada (antes de importar los módulos) ───────────────────────
const META = { plantillas: [], envios: [], lecturas: 0, responder: null, tokens: new Set() };
const servidorMeta = http.createServer(async (req, res) => {
  let cuerpo = '';
  for await (const c of req) cuerpo += c;
  META.tokens.add(req.headers.authorization || '');
  const json = (s, d) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  const m = new URL(req.url, 'http://x').pathname.match(/^\/v20\.0\/([^/]+)(\/[a-z_]+)?$/);
  if (!m) return json(404, { error: { code: 100 } });
  if (m[2] === '/message_templates') {
    META.lecturas++;
    return json(200, { data: META.plantillas, ...(META.siguiente ? { paging: { next: META.siguiente } } : {}) });
  }
  if (m[2] === '/messages' && req.method === 'POST') {
    const b = JSON.parse(cuerpo);
    META.envios.push({ phoneId: m[1], ...b });
    const r = META.responder ? META.responder(b, META.envios.length) : null;
    if (r === 'cortar') { req.socket.destroy(); return; }
    if (r) return json(r.status, r.datos);
    return json(200, { messages: [{ id: `wamid.prueba.${randomUUID()}` }] });
  }
  if (!m[2]) return json(200, { quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K' });
  return json(404, {});
});
await new Promise((ok) => servidorMeta.listen(0, '127.0.0.1', ok));
process.env.META_GRAPH_BASE_URL = `http://127.0.0.1:${servidorMeta.address().port}`;

const { pool, actualizarConfiguracion, marcarRespuestaCampana } = await import('../src/services/database.js');
const svc = await import('../src/services/campanasWa.js');
const { registrarRutasCampanasWa } = await import('../src/services/campanasWaRutas.js');
const { ErrorCampana } = svc;

const leer = (r) => readFileSync(new URL(`../${r}`, import.meta.url), 'utf8');
let n = 0; let fallidas = 0;
const SOLO = (process.env.CASOS || '').split(',').map((s) => s.trim()).filter(Boolean);
async function caso(nombre, fn) {
  if (SOLO.length && !SOLO.includes(nombre.split(' ')[0])) return;
  META.responder = null;
  try { await fn(); console.log(`OK campanas-wa-db ${++n}: ${nombre}`); }
  catch (e) {
    fallidas++;
    const detalle = e?.code === 'ERR_ASSERTION' && e.generatedMessage
      ? ` · obtenido=${JSON.stringify(e.actual)?.slice(0, 240)} · esperado=${JSON.stringify(e.expected)?.slice(0, 160)}` : '';
    console.log(`FALLA ${nombre.split(' ')[0]} campanas-wa-db: ${nombre}\n  ${String(e?.message || e).split('\n')[0]}${detalle}`);
  }
}
async function rechaza(promesa, codigo) {
  let e = null;
  try { await promesa; } catch (x) { e = x; }
  assert.ok(e instanceof ErrorCampana, `debía rechazar con ${codigo}: ${e?.message || 'no rechazó'}`);
  assert.equal(e.codigo, codigo, e.message);
  return e;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const PROMO = {
  id: '111', name: 'promo_jueves', status: 'APPROVED', category: 'MARKETING', language: 'es_MX',
  components: [
    { type: 'BODY', text: 'Hola {{1}}, este jueves hay {{2}}.', example: { body_text: [['Ana', '2x1']] } },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Quiero' }] },
  ],
};
const VIDEO = { id: '222', name: 'con_video', status: 'APPROVED', category: 'MARKETING', language: 'es_MX',
  components: [{ type: 'HEADER', format: 'VIDEO' }, { type: 'BODY', text: 'Mira' }] };
const VARS = { 'cuerpo:1': { fuente: 'nombre' }, 'cuerpo:2': { fuente: 'fijo', texto: '2x1 en chilaquiles' } };
const DATOS = { nombre: 'Jueves 2x1', plantilla: 'promo_jueves', idioma: 'es_MX', variables: VARS, respaldoNombre: 'cliente',
  segmento: 'todos', excluirRecientes: true };
const MEDIODIA = () => new Date('2026-11-20T18:00:00Z'); // 12:00 en Matamoros
const MADRUGADA = () => new Date('2026-11-20T09:00:00Z'); // 3:00
const sinLog = { error: () => {} };
const vuelta = (extra = {}) => svc.procesarColaCampanas({ ahora: MEDIODIA, esperaMs: 0, log: sinLog, ...extra });
const tel = () => `52100${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`;

const creados = [];
async function negocio({ waba = true, trazabilidad = true, clientes = 3, nombres = ['ana lucía', 'Beto', null] } = {}) {
  const marca = randomUUID();
  const { rows: [r] } = await pool.query("INSERT INTO negocios(nombre,slug,bot_whatsapp_activo) VALUES('Campañas WA',$1,true) RETURNING id",
    [`campanas-wa-${marca}`]);
  creados.push(r.id);
  await pool.query("INSERT INTO negocio_modulos(negocio_id,modulo,estado) VALUES($1,'whatsapp','activo')", [r.id]);
  const phoneId = `pn-${marca}`;
  await pool.query(`INSERT INTO integraciones_canal(negocio_id,canal,proveedor,identificador,estado,activo,waba_id)
    VALUES($1,'whatsapp','meta',$2,'activo',true,$3)`, [r.id, phoneId, waba ? `waba-${marca}` : null]);
  await actualizarConfiguracion({ timezone: 'America/Matamoros', int_wa_phone_id: phoneId, int_wa_token: `token-${marca}`,
    ...(trazabilidad ? { whatsapp_trazabilidad_formularios_v1: 'true' } : {}) }, r.id);
  const telefonos = [];
  for (let i = 0; i < clientes; i++) {
    const t = tel();
    telefonos.push(t);
    await pool.query('INSERT INTO clientes(negocio_id,telefono,nombre) VALUES($1,$2,$3)', [r.id, t, nombres[i % nombres.length]]);
  }
  return { id: r.id, phoneId, token: `token-${marca}`, telefonos };
}
const paraMeta = (t) => `52${t.slice(3)}`;
async function envios(campanaId) {
  const { rows } = await pool.query(`SELECT telefono, telefono_envio, estado, wamid, error_codigo, entregado_at, leido_at,
      no_entregado_at, respondio_at, cola_at FROM campana_envios WHERE campana_id=$1 ORDER BY id`, [campanaId]);
  return rows;
}
async function campana(id) {
  const { rows: [r] } = await pool.query('SELECT * FROM campanas WHERE id=$1', [id]);
  return r;
}
// La cola manda TODAS las campañas activas de la base: cada caso deja viva solo la suya.
async function soloEsta(id) {
  await pool.query(`UPDATE campanas SET estado='detenida', detenida_motivo='(otra prueba)'
     WHERE tipo='plantilla' AND estado='enviando' AND id <> $1`, [id]);
}
async function crear(neg, extra = {}) {
  const prep = await svc.prepararCampana(neg.id, { ...DATOS, ...extra });
  const r = await svc.crearCampanaPlantilla(neg.id, { ...DATOS, ...extra, totalVisto: prep.resumen.total }, { usuarioId: 'u-prueba' });
  await soloEsta(r.campanaId);
  return r;
}
function predeploy() {
  const r = spawnSync(process.execPath, ['scripts/predeploy-142-campanas-whatsapp-plantilla.mjs'],
    { env: process.env, encoding: 'utf8', timeout: 60000 });
  return { codigo: r.status, salida: `${r.stdout || ''}${r.stderr || ''}` };
}

META.plantillas = [PROMO, VIDEO];

try {
  // ── M. La migración 142 ────────────────────────────────────────────────────
  await caso('M1 la 142 se aplica sin tocar las campañas de texto que ya había', async () => {
    const { rows: [ya] } = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name='campanas' AND column_name='tipo'`);
    if (ya) await pool.query(leer('migrations/142_campanas_whatsapp_plantilla_down.sql'));
    const neg = await negocio({ clientes: 1 });
    const { rows: [c] } = await pool.query(`INSERT INTO campanas(nombre,segmento,mensaje,total_destinatarios,enviados,estado,negocio_id)
      VALUES('Vieja','todos','Hola {nombre}',1,1,'completada',$1) RETURNING id`, [neg.id]);
    await pool.query("INSERT INTO campana_envios(campana_id,telefono,nombre,estado,enviado_at) VALUES($1,$2,'Ana','enviado',now())", [c.id, neg.telefonos[0]]);
    const r = predeploy();
    assert.equal(r.codigo, 0, r.salida);
    assert.match(r.salida, /\[predeploy-142\] Aplicada/);
    const vieja = await campana(c.id);
    assert.equal(vieja.tipo, 'texto');
    assert.equal(vieja.enviados, 1);
    const [e] = await envios(c.id);
    assert.deepEqual([e.estado, e.cola_at, e.telefono_envio, e.wamid], ['enviado', null, null, null]);
  });

  await caso('M2 correrla otra vez no hace nada', async () => {
    const r = predeploy();
    assert.equal(r.codigo, 0, r.salida);
    assert.match(r.salida, /Ya aplicada/);
  });

  await caso('M3 sus reglas: un estado inventado o el mismo cliente dos veces en la cola no entran', async () => {
    const neg = await negocio({ clientes: 0 });
    const { rows: [c] } = await pool.query(`INSERT INTO campanas(nombre,segmento,mensaje,estado,negocio_id,tipo)
      VALUES('Reglas','todos','x','detenida',$1,'plantilla') RETURNING id`, [neg.id]);
    await assert.rejects(pool.query("INSERT INTO campana_envios(campana_id,telefono,estado) VALUES($1,'5210000000000','raro')", [c.id]),
      (e) => e.code === '23514');
    await assert.rejects(pool.query("INSERT INTO campanas(nombre,segmento,mensaje,negocio_id,tipo) VALUES('x','todos','x',$1,'otro')", [neg.id]),
      (e) => e.code === '23514');
    const fila = "INSERT INTO campana_envios(campana_id,telefono,estado,cola_at,telefono_envio) VALUES($1,'5210000000000','pendiente',now(),'520000000000')";
    await pool.query(fila, [c.id]);
    await assert.rejects(pool.query(fila, [c.id]), (e) => e.code === '23505');
  });

  // Ninguna campaña de otra corrida debe mandarse durante esta suite.
  await pool.query("UPDATE campanas SET estado='detenida', detenida_motivo='(corrida anterior)' WHERE tipo='plantilla' AND estado='enviando'");

  // ── B. El servicio ─────────────────────────────────────────────────────────
  await caso('B1 las plantillas salen de la cuenta del negocio, con su token, y lo no compatible se dice', async () => {
    const neg = await negocio({ clientes: 0 });
    const p = await svc.plantillasDelNegocio(neg.id, { sinCache: true });
    assert.equal(p.conectado, true); assert.equal(p.motivo, null);
    assert.deepEqual(p.plantillas.map((x) => [x.nombre, x.compatible]), [['promo_jueves', true], ['con_video', false]]);
    assert.deepEqual(p.numero, { calidad: 'GREEN', limite: 'TIER_1K' });
    assert.ok(META.tokens.has(`Bearer ${neg.token}`));
    // Una «página siguiente» que no es del mismo Graph no se pide: llevaría el token.
    META.siguiente = 'https://otro.example/v20.0/x/message_templates?after=1';
    try {
      const q = await svc.plantillasDelNegocio(neg.id, { sinCache: true });
      assert.equal(q.motivo, null); assert.equal(q.plantillas.length, 2);
    } finally { META.siguiente = null; }
    const sinWaba = await negocio({ clientes: 0, waba: false });
    const s = await svc.plantillasDelNegocio(sinWaba.id, { sinCache: true });
    assert.equal(s.conectado, false); assert.match(s.motivo, /cuenta de WhatsApp Business/);
    const { rows: [x] } = await pool.query("INSERT INTO negocios(nombre,slug) VALUES('Sin WA',$1) RETURNING id", [`sin-wa-${randomUUID()}`]);
    creados.push(x.id);
    const sinWa = await svc.plantillasDelNegocio(x.id, { sinCache: true });
    assert.equal(sinWa.conectado, false); assert.match(sinWa.motivo, /no tiene su WhatsApp conectado/);
  });

  await caso('B2 la vista previa cuenta a SUS clientes: sin internos, sin repetidos, sin los de otro negocio', async () => {
    const neg = await negocio({ clientes: 3 });
    const otro = await negocio({ clientes: 2 });
    // El mismo número a 10 dígitos (como lo guarda el POS) cuenta una sola vez.
    await pool.query('INSERT INTO clientes(negocio_id,telefono,nombre) VALUES($1,$2,$3)', [neg.id, neg.telefonos[0].slice(3), 'Ana POS']);
    await pool.query('INSERT INTO clientes(negocio_id,telefono,nombre,es_interno) VALUES($1,$2,$3,true)', [neg.id, tel(), 'Cajera']);
    const { resumen } = await svc.prepararCampana(neg.id, DATOS);
    assert.equal(resumen.total, 3);
    assert.deepEqual(resumen.excluidos, { sinNumero: 0, repetidos: 1, pidieronBaja: 0, recientes: 0 });
    assert.equal(resumen.categoria, 'MARKETING');
    assert.equal(resumen.costo.totalUsd, 0.14);
    assert.match(resumen.vista.cuerpo, /^Hola (Ana|Beto|cliente), este jueves hay 2x1 en chilaquiles\.$/);
    const delOtro = await svc.prepararCampana(otro.id, DATOS);
    assert.equal(delOtro.resumen.total, 2);
    assert.ok(!delOtro.lista.some((d) => neg.telefonos.includes(d.telefono)));
    await rechaza(svc.prepararCampana(neg.id, { ...DATOS, segmento: "todos' OR 1=1 --" }), 'SEGMENTO_INVALIDO');
    await rechaza(svc.prepararCampana(neg.id, { ...DATOS, plantilla: 'con_video' }), 'PLANTILLA_NO_COMPATIBLE');
    await rechaza(svc.prepararCampana(neg.id, { ...DATOS, plantilla: 'no_existe' }), 'PLANTILLA_NO_EXISTE');
    await rechaza(svc.prepararCampana(neg.id, { ...DATOS, variables: { 'cuerpo:1': { fuente: 'nombre' } } }), 'VARIABLE_FALTA');
  });

  await caso('B3 crear deja la cola y NO manda nada; si la lista cambió, no crea nada', async () => {
    const neg = await negocio({ clientes: 3 });
    const antes = META.envios.length;
    await rechaza(svc.crearCampanaPlantilla(neg.id, { ...DATOS, totalVisto: 2 }), 'LISTA_CAMBIO');
    const { rows: [cuantas] } = await pool.query('SELECT COUNT(*)::int AS n FROM campanas WHERE negocio_id=$1', [neg.id]);
    assert.equal(cuantas.n, 0);
    await rechaza(svc.crearCampanaPlantilla(neg.id, { ...DATOS, nombre: '  ', totalVisto: 3 }), 'NOMBRE_FALTA');
    const r = await crear(neg);
    assert.equal(r.total, 3);
    const c = await campana(r.campanaId);
    assert.deepEqual([c.tipo, c.estado, c.total_destinatarios, c.creada_por, c.plantilla.analisis.nombre], ['plantilla', 'enviando', 3, 'u-prueba', 'promo_jueves']);
    const e = await envios(r.campanaId);
    assert.deepEqual(e.map((x) => x.estado), ['pendiente', 'pendiente', 'pendiente']);
    assert.deepEqual(e.map((x) => x.telefono_envio).sort(), neg.telefonos.map(paraMeta).sort());
    assert.equal(META.envios.length, antes, 'crear no debe llamar a Meta para mandar');
    await svc.detenerCampana(neg.id, r.campanaId);
  });

  await caso('B4 una sola campaña mandándose a la vez por negocio', async () => {
    const neg = await negocio({ clientes: 2 });
    const r = await crear(neg);
    // Sin la casilla de «no repetir»: con ella, los que ya están en la cola ni cuentan.
    await rechaza(crear(neg, { nombre: 'Otra', excluirRecientes: false }), 'OTRA_EN_CURSO');
    await svc.detenerCampana(neg.id, r.campanaId);
    // Lo cancelado no cuenta como «ya la recibió».
    const r2 = await crear(neg, { nombre: 'Otra' });
    assert.equal(r2.total, 2);
    assert.ok(r2.campanaId > r.campanaId);
    await svc.detenerCampana(neg.id, r2.campanaId);
  });

  await caso('B5 la cola manda solo en horario, con la plantilla y el primer nombre, y termina sola', async () => {
    const neg = await negocio({ clientes: 3 });
    const r = await crear(neg);
    const antes = META.envios.length;
    await vuelta({ ahora: MADRUGADA });
    assert.equal(META.envios.length, antes, 'a las 3:00 no se manda');
    const res = await vuelta();
    assert.equal(res.enviados, 3);
    const mios = META.envios.slice(antes);
    assert.deepEqual(mios.map((m) => m.phoneId), [neg.phoneId, neg.phoneId, neg.phoneId]);
    assert.deepEqual(mios.map((m) => m.to).sort(), neg.telefonos.map(paraMeta).sort());
    assert.deepEqual(mios[0].template.name, 'promo_jueves');
    assert.deepEqual(mios[0].template.language, { code: 'es_MX' });
    const nombres = mios.map((m) => m.template.components[0].parameters[0].text).sort();
    assert.deepEqual(nombres, ['Ana', 'Beto', 'cliente']);
    assert.ok(mios.every((m) => m.template.components[0].parameters[1].text === '2x1 en chilaquiles'));
    const e = await envios(r.campanaId);
    assert.ok(e.every((x) => x.estado === 'enviado' && x.wamid?.startsWith('wamid.prueba.')), JSON.stringify(e.map((x) => x.estado)));
    const c = await campana(r.campanaId);
    assert.deepEqual([c.estado, c.enviados], ['completada', 3]);
    assert.ok(c.completada_at);
    await vuelta();
    assert.equal(META.envios.length, antes + 3, 'una campaña terminada no vuelve a mandar');
  });

  await caso('B6 un cliente que Meta rechaza se anota con su código y la campaña sigue', async () => {
    const neg = await negocio({ clientes: 3 });
    const r = await crear(neg);
    const malo = paraMeta(neg.telefonos[1]);
    META.responder = (b) => (b.to === malo ? { status: 400, datos: { error: { code: 131026, message: 'x' } } } : null);
    await vuelta();
    const e = await envios(r.campanaId);
    const fila = e.find((x) => x.telefono_envio === malo);
    assert.deepEqual([fila.estado, fila.error_codigo, fila.wamid], ['fallido', 131026, null]);
    assert.equal(e.filter((x) => x.estado === 'enviado').length, 2);
    assert.equal((await campana(r.campanaId)).estado, 'completada');
  });

  await caso('B7 un rechazo de cuenta o plantilla detiene la campaña con su motivo y no sigue mandando', async () => {
    const neg = await negocio({ clientes: 4 });
    const r = await crear(neg);
    const antes = META.envios.length;
    META.responder = () => ({ status: 400, datos: { error: { code: 132001 } } });
    const res = await vuelta();
    assert.equal(res.detenidas, 1);
    assert.equal(META.envios.length, antes + 1, 'solo el primer intento');
    const c = await campana(r.campanaId);
    assert.equal(c.estado, 'detenida');
    assert.match(c.detenida_motivo, /La plantilla no existe en ese idioma/);
    assert.deepEqual((await envios(r.campanaId)).map((x) => x.estado), ['cancelado', 'cancelado', 'cancelado', 'cancelado']);
  });

  await caso('B8 «baja la velocidad»: el cliente vuelve a la fila y la campaña espera antes de seguir', async () => {
    const neg = await negocio({ clientes: 2 });
    const r = await crear(neg);
    const antes = META.envios.length;
    META.responder = () => ({ status: 400, datos: { error: { code: 130429 } } });
    await vuelta();
    META.responder = null;
    assert.equal(META.envios.length, antes + 1);
    const c = await campana(r.campanaId);
    assert.equal(c.estado, 'enviando');
    assert.ok(c.reanudar_at && new Date(c.reanudar_at) > new Date());
    assert.deepEqual((await envios(r.campanaId)).map((x) => x.estado), ['pendiente', 'pendiente']);
    await vuelta();
    assert.equal(META.envios.length, antes + 1, 'antes de reanudar_at no se toca');
    await pool.query('UPDATE campanas SET reanudar_at = now() - interval \'1 second\' WHERE id=$1', [r.campanaId]);
    await vuelta();
    assert.equal(META.envios.length, antes + 3);
    assert.equal((await campana(r.campanaId)).estado, 'completada');
  });

  await caso('B9 si se cae la red a medio envío queda «sin confirmar» y NUNCA se reintenta solo', async () => {
    const neg = await negocio({ clientes: 2 });
    const r = await crear(neg);
    const antes = META.envios.length;
    const primero = paraMeta(neg.telefonos[0]);
    META.responder = (b) => (b.to === primero ? 'cortar' : null);
    const res = await vuelta();
    META.responder = null;
    assert.equal(res.inciertos, 1);
    await vuelta();
    const intentos = META.envios.slice(antes).filter((m) => m.to === primero).length;
    assert.equal(intentos, 1, 'el incierto no se vuelve a mandar');
    const e = await envios(r.campanaId);
    assert.deepEqual(e.map((x) => [x.telefono_envio === primero, x.estado]).sort(), [[false, 'enviado'], [true, 'incierto']]);
    assert.equal((await campana(r.campanaId)).estado, 'completada');
  });

  await caso('B10 lo que quedó «enviando» de una vuelta que se murió pasa a «sin confirmar», no se reenvía', async () => {
    const neg = await negocio({ clientes: 2 });
    const r = await crear(neg);
    const { rows: [f] } = await pool.query(`UPDATE campana_envios SET estado='enviando', intento_at=now()-interval '6 minutes'
      WHERE id=(SELECT id FROM campana_envios WHERE campana_id=$1 ORDER BY id LIMIT 1) RETURNING telefono_envio`, [r.campanaId]);
    const antes = META.envios.length;
    await vuelta();
    assert.ok(!META.envios.slice(antes).some((m) => m.to === f.telefono_envio));
    assert.equal(META.envios.length, antes + 1);
    const e = await envios(r.campanaId);
    assert.equal(e.find((x) => x.telefono_envio === f.telefono_envio).estado, 'incierto');
  });

  await caso('B11 si los primeros 5 fallan con el MISMO código y ninguno salió, se detiene sola', async () => {
    const neg = await negocio({ clientes: 7 });
    const r = await crear(neg);
    const antes = META.envios.length;
    META.responder = () => ({ status: 400, datos: { error: { code: 100 } } });
    await vuelta();
    assert.equal(META.envios.length, antes + 5);
    const c = await campana(r.campanaId);
    assert.equal(c.estado, 'detenida');
    assert.match(c.detenida_motivo, /Se detuvo sola: Meta rechazó un dato/);
    const e = await envios(r.campanaId);
    assert.deepEqual([e.filter((x) => x.estado === 'fallido').length, e.filter((x) => x.estado === 'cancelado').length], [5, 2]);
  });

  await caso('B12 detener cancela lo que falta; otro negocio no puede detenerla', async () => {
    const neg = await negocio({ clientes: 3 });
    const otro = await negocio({ clientes: 0 });
    const r = await crear(neg);
    await rechaza(svc.detenerCampana(otro.id, r.campanaId), 'NO_EN_CURSO');
    assert.equal((await campana(r.campanaId)).estado, 'enviando');
    const d = await svc.detenerCampana(neg.id, r.campanaId);
    assert.deepEqual(d, { ok: true, cancelados: 3 });
    const antes = META.envios.length;
    await vuelta();
    assert.equal(META.envios.length, antes);
    await rechaza(svc.detenerCampana(neg.id, r.campanaId), 'NO_EN_CURSO');
    await rechaza(svc.detenerCampana(neg.id, 'abc'), 'NO_EXISTE');
  });

  await caso('B13 los acuses de Meta: entregado, leído (implica entregado) y «no llegó» con su código', async () => {
    const neg = await negocio({ clientes: 3 });
    const r = await crear(neg);
    await vuelta();
    const [a, b, c] = await envios(r.campanaId);
    const estado = (wamid, dest, est, hace, codigo = null) => pool.query(
      `INSERT INTO whatsapp_estados_mensaje(negocio_id,wamid,destinatario,estado,ocurrido_at,error_codigo)
       VALUES($1,$2,$3,$4,now()-make_interval(secs=>$5),$6)`, [neg.id, wamid, dest, est, hace, codigo]);
    await estado(a.wamid, a.telefono_envio, 'delivered', 50);
    await estado(b.wamid, b.telefono_envio, 'read', 40);
    await estado(c.wamid, c.telefono_envio, 'failed', 30, 131049);
    // Un «failed» tardío no borra la entrega de a.
    await estado(a.wamid, a.telefono_envio, 'failed', 10, 131000);
    // El mismo wamid en OTRO negocio no cuenta.
    const otro = await negocio({ clientes: 0 });
    await pool.query(`INSERT INTO whatsapp_estados_mensaje(negocio_id,wamid,destinatario,estado,ocurrido_at) VALUES($1,$2,$3,'read',now())`,
      [otro.id, a.wamid, a.telefono_envio]);
    assert.ok(await svc.sincronizarEntregas({ log: sinLog }) >= 3);
    const [a2, b2, c2] = await envios(r.campanaId);
    assert.ok(a2.entregado_at && !a2.leido_at && !a2.no_entregado_at && a2.error_codigo === null, JSON.stringify(a2));
    assert.ok(b2.entregado_at && b2.leido_at && !b2.no_entregado_at, JSON.stringify(b2));
    assert.ok(!c2.entregado_at && c2.no_entregado_at && c2.error_codigo === 131049, JSON.stringify(c2));
    assert.equal(await svc.sincronizarEntregas({ log: sinLog }), 0, 'repetir no cambia nada');
    const [h] = (await svc.listarCampanasWa(neg.id)).filter((x) => x.id === r.campanaId);
    assert.deepEqual([h.total, h.enviados, h.entregados, h.leidos, h.noLlegaron, h.enCola], [3, 3, 2, 1, 1, 0]);
    assert.deepEqual(h.motivos, [{ codigo: 131049, n: 1, explicacion: 'Meta no lo entregó para no saturar al cliente de promociones' }]);
    assert.ok(!(await svc.listarCampanasWa(otro.id)).some((x) => x.id === r.campanaId), 'el historial es por negocio');
  });

  await caso('B14 las respuestas del cliente se cuentan (el webhook ya llama a marcarRespuestaCampana)', async () => {
    const neg = await negocio({ clientes: 2 });
    const r = await crear(neg);
    await vuelta();
    await marcarRespuestaCampana(neg.telefonos[0]);
    const [h] = (await svc.listarCampanasWa(neg.id)).filter((x) => x.id === r.campanaId);
    assert.equal(h.respondieron, 1);
  });

  await caso('B15 no se repite a quien ya la recibió esta semana, y nunca a quien pidió no recibir promociones', async () => {
    const neg = await negocio({ clientes: 3 });
    const r = await crear(neg);
    const baja = paraMeta(neg.telefonos[2]);
    META.responder = (b) => (b.to === baja ? { status: 400, datos: { error: { code: 131050 } } } : null);
    await vuelta();
    META.responder = null;
    // La baja que dio el mismo número en OTRO negocio no cuenta aquí.
    const otro = await negocio({ clientes: 0 });
    const { rows: [co] } = await pool.query(`INSERT INTO campanas(nombre,segmento,mensaje,total_destinatarios,estado,negocio_id,tipo)
      VALUES('otra','todos','x',1,'completada',$1,'plantilla') RETURNING id`, [otro.id]);
    await pool.query(`INSERT INTO campana_envios(campana_id,telefono,estado,cola_at,telefono_envio,error_codigo)
      VALUES($1,$2,'fallido',now(),$3,131050)`, [co.id, neg.telefonos[0], paraMeta(neg.telefonos[0])]);
    const conCasilla = await svc.prepararCampana(neg.id, DATOS);
    assert.deepEqual([conCasilla.resumen.total, conCasilla.resumen.excluidos.recientes, conCasilla.resumen.excluidos.pidieronBaja], [0, 2, 1]);
    await rechaza(svc.crearCampanaPlantilla(neg.id, { ...DATOS, totalVisto: 0 }), 'SIN_DESTINATARIOS');
    const sinCasilla = await svc.prepararCampana(neg.id, { ...DATOS, excluirRecientes: false });
    assert.deepEqual([sinCasilla.resumen.total, sinCasilla.resumen.excluidos.pidieronBaja], [2, 1]);
    assert.ok(!sinCasilla.lista.some((d) => d.telefonoEnvio === baja));
    assert.ok(r.campanaId);
  });

  await caso('B16 la prueba al administrador: su número, sin nombre de cliente, y máximo 5 cada 10 minutos', async () => {
    const neg = await negocio({ clientes: 0 });
    await rechaza(svc.enviarPrueba(neg.id, { ...DATOS, telefono: '12' }), 'TELEFONO_INVALIDO');
    const antes = META.envios.length;
    const ahora = Date.now();
    for (let i = 0; i < 5; i++) await svc.enviarPrueba(neg.id, { ...DATOS, telefono: '8780000001' }, { ahora: ahora + i });
    assert.equal(META.envios.length, antes + 5);
    assert.equal(META.envios.at(-1).to, '528780000001');
    assert.equal(META.envios.at(-1).template.components[0].parameters[0].text, 'cliente');
    await rechaza(svc.enviarPrueba(neg.id, { ...DATOS, telefono: '8780000001' }, { ahora: ahora + 10 }), 'DEMASIADAS_PRUEBAS');
    await svc.enviarPrueba(neg.id, { ...DATOS, telefono: '8780000001' }, { ahora: ahora + 11 * 60_000 });
    META.responder = () => ({ status: 400, datos: { error: { code: 131026 } } });
    const e = await rechaza(svc.enviarPrueba(neg.id, { ...DATOS, telefono: '8780000002' }, { ahora: ahora + 12 * 60_000 }), 'META_RECHAZO');
    assert.match(e.message, /no tiene WhatsApp/);
    const { rows: [c] } = await pool.query('SELECT COUNT(*)::int AS n FROM campanas WHERE negocio_id=$1', [neg.id]);
    assert.equal(c.n, 0, 'la prueba no crea campañas');
  });

  await caso('B17 si el WhatsApp se desconecta a media campaña, se detiene sola y lo dice', async () => {
    const neg = await negocio({ clientes: 2 });
    const r = await crear(neg);
    await pool.query("DELETE FROM configuracion WHERE negocio_id=$1 AND clave IN ('int_wa_phone_id','int_wa_token')", [neg.id]);
    await pool.query("UPDATE integraciones_canal SET estado='no_configurado' WHERE negocio_id=$1", [neg.id]);
    const antes = META.envios.length;
    await vuelta();
    assert.equal(META.envios.length, antes);
    const c = await campana(r.campanaId);
    assert.equal(c.estado, 'detenida');
    assert.match(c.detenida_motivo, /desconectado/);
  });

  // ── R. Las rutas ───────────────────────────────────────────────────────────
  const llamadas = [];
  let respuesta = async () => ({ campanaId: 7, total: 3 });
  const app = express();
  app.use(express.json());
  const requireAdminSeguro = (req, res, next) => {
    if (req.get('x-rol') !== 'admin') return res.status(403).json({ error: 'Permiso insuficiente' });
    req.negocioId = 'negocio-de-la-sesion'; req.usuarioId = 'u-sesion'; next();
  };
  const modulos = [];
  const requireModulo = (m) => { modulos.push(m); return (req, res, next) => (req.get('x-modulo') === 'no'
    ? res.status(403).json({ error: 'modulo_no_contratado' }) : next()); };
  registrarRutasCampanasWa(app, { requireAdminSeguro, requireModulo, servicio: {
    listar: async (nid) => { llamadas.push(['listar', nid]); return []; },
    plantillas: async (nid, o) => { llamadas.push(['plantillas', nid, o.sinCache]); return { conectado: true, plantillas: [] }; },
    trazabilidad: async () => true,
    preparar: async (nid, d) => { llamadas.push(['preparar', nid, d]); return { resumen: { total: 3 } }; },
    crear: async (nid, d, o) => { llamadas.push(['crear', nid, d, o.usuarioId]); return respuesta(); },
    prueba: async (nid) => { llamadas.push(['prueba', nid]); throw new ErrorCampana('Ya mandaste 5 pruebas en 10 minutos. Espera un poco.', 'DEMASIADAS_PRUEBAS'); },
    detener: async (nid, id) => { llamadas.push(['detener', nid, id]); return { ok: true, cancelados: 2 }; },
  } });
  const servidor = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}/api/admin/campanas-wa`;
  const pedir = (metodo, ruta, cuerpo, { rol = 'admin', modulo } = {}) => fetch(base + ruta, {
    method: metodo, headers: { 'content-type': 'application/json', ...(rol ? { 'x-rol': rol } : {}), ...(modulo ? { 'x-modulo': modulo } : {}) },
    body: metodo === 'GET' ? undefined : JSON.stringify(cuerpo || {}),
  });
  const TODAS = [['GET', ''], ['GET', '/plantillas'], ['POST', '/vista-previa'], ['POST', '/prueba'], ['POST', ''], ['POST', '/5/detener']];
  try {
    await caso('R1 el operador, sin sesión o sin el módulo de WhatsApp: 403 y el servicio ni se entera', async () => {
      const antes = llamadas.length;
      for (const [m, r] of TODAS) {
        assert.equal((await pedir(m, r, {}, { rol: 'staff' })).status, 403, `${m} ${r} staff`);
        assert.equal((await pedir(m, r, {}, { rol: null })).status, 403, `${m} ${r} sin sesión`);
        assert.equal((await pedir(m, r, {}, { modulo: 'no' })).status, 403, `${m} ${r} sin módulo`);
      }
      assert.equal(llamadas.length, antes);
      assert.deepEqual([...new Set(modulos)], ['whatsapp']);
    });

    await caso('R2 todo va al negocio de la sesión; lo que no es del formulario se tira', async () => {
      await pedir('GET', '/plantillas?recargar=1&negocioId=otro');
      await pedir('POST', '/vista-previa', { ...DATOS, negocioId: 'otro', negocio_id: 'otro' });
      const c = await pedir('POST', '', { ...DATOS, totalVisto: 3, negocioId: 'otro' });
      assert.deepEqual(await c.json(), { ok: true, campanaId: 7, total: 3 });
      await pedir('POST', '/9/detener', { negocioId: 'otro' });
      const [pl, prep, cr, det] = llamadas.slice(-4);
      assert.deepEqual(pl, ['plantillas', 'negocio-de-la-sesion', true]);
      assert.equal(prep[1], 'negocio-de-la-sesion');
      assert.ok(!('negocioId' in prep[2]) && !('negocio_id' in prep[2]));
      assert.deepEqual([cr[1], cr[3], cr[2].totalVisto], ['negocio-de-la-sesion', 'u-sesion', 3]);
      assert.deepEqual(det, ['detener', 'negocio-de-la-sesion', '9']);
    });

    await caso('R3 los errores del servicio se dicen con su código HTTP; los internos no se filtran', async () => {
      respuesta = async () => { throw new ErrorCampana('La lista cambió mientras la revisabas: ahora son 4.', 'LISTA_CAMBIO', { total: 4 }); };
      const r1 = await pedir('POST', '', DATOS);
      assert.equal(r1.status, 409);
      assert.deepEqual(await r1.json(), { error: 'La lista cambió mientras la revisabas: ahora son 4.', codigo: 'LISTA_CAMBIO', total: 4 });
      const r2 = await pedir('POST', '/prueba', DATOS);
      assert.equal(r2.status, 429);
      respuesta = async () => { throw new Error('relation "campanas" password=secreto does not exist'); };
      const orig = console.error; console.error = () => {};
      const r3 = await pedir('POST', '', DATOS);
      console.error = orig;
      assert.equal(r3.status, 500);
      const t = await r3.text();
      assert.ok(!/secreto|relation/.test(t), t);
    });
  } finally {
    await new Promise((ok) => servidor.close(ok));
  }

  console.log(`Campañas WA (base): ${n} pasadas, ${fallidas} fallidas. Graph API simulada en 127.0.0.1; sin teléfonos reales.`);
  if (fallidas) process.exitCode = 1;
} finally {
  // Nada queda mandándose: otra suite con servidor contra esta base pondría a
  // trabajar la cola sobre lo que esta dejó.
  await pool.query(`UPDATE campanas SET estado='detenida', detenida_motivo='(fin de la prueba)'
     WHERE tipo='plantilla' AND estado='enviando' AND negocio_id = ANY($1::uuid[])`, [creados]).catch(() => {});
  await pool.end();
  await new Promise((ok) => servidorMeta.close(ok));
}
