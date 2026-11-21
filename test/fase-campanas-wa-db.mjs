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
//   143 (saneamiento de Clientes, 21-nov): M4–M5 la migración; B2 a quién le
//      llega (la Lista, sin internos, teléfonos del negocio, repartidores ni
//      bajas); B18–B22 tandas, pausa, bajas anotadas y el número de la sucursal.
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
const META = { plantillas: [], envios: [], lecturas: 0, responder: null, tokens: new Set(), numeros: {} };
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
  if (!m[2]) return json(200, { quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K',
    ...(META.numeros[m[1]] ? { display_phone_number: META.numeros[m[1]] } : {}) });
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
    // La forma que Xabor acepta (143): liga a la tienda + botón de baja de Meta.
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Pedir en línea', url: 'https://tienda.example/pedir' },
      { type: 'QUICK_REPLY', text: 'Detener promociones' }] },
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
    await pool.query('INSERT INTO clientes_negocio(negocio_id,telefono,nombre) VALUES($1,$2,$3)', [r.id, t.slice(3), nombres[i % nombres.length]]);
  }
  return { id: r.id, phoneId, token: `token-${marca}`, telefonos };
}
// Un cliente más en la Lista; devuelve su número como lo manda Meta (521…).
async function cliente(neg, nombre, { interno = false } = {}) {
  const t = tel();
  await pool.query('INSERT INTO clientes_negocio(negocio_id,telefono,nombre,es_interno) VALUES($1,$2,$3,$4)', [neg.id, t.slice(3), nombre, interno]);
  return t;
}
const idDe = async (neg, t) => (await pool.query('SELECT id FROM clientes_negocio WHERE negocio_id=$1 AND telefono=$2', [neg.id, t.slice(3)])).rows[0]?.id;
async function consentimientos(neg, t) {
  const { rows } = await pool.query(`SELECT otorgado, fuente FROM cliente_consentimientos WHERE negocio_id=$1 AND canal='whatsapp'
      AND cliente_id=(SELECT id FROM clientes_negocio WHERE negocio_id=$1 AND telefono=$2) ORDER BY id`, [neg.id, t.slice(3)]);
  return rows.map((r) => [r.otorgado, r.fuente]);
}
const paraMeta = (t) => `52${t.slice(3)}`;
async function envios(campanaId) {
  const { rows } = await pool.query(`SELECT telefono, telefono_envio, estado, wamid, error_codigo, entregado_at, leido_at,
      no_entregado_at, respondio_at, cola_at, cliente_id, baja_at, intento_at FROM campana_envios WHERE campana_id=$1 ORDER BY id`, [campanaId]);
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
function predeploy(cual = '142-campanas-whatsapp-plantilla') {
  const r = spawnSync(process.execPath, [`scripts/predeploy-${cual}.mjs`],
    { env: process.env, encoding: 'utf8', timeout: 60000 });
  return { codigo: r.status, salida: `${r.stdout || ''}${r.stderr || ''}` };
}

META.plantillas = [PROMO, VIDEO];

try {
  // ── M. La migración 142 ────────────────────────────────────────────────────
  await caso('M1 la 142 se aplica sin tocar las campañas de texto que ya había', async () => {
    // La 143 va encima de la 142 (su índice de bajas usa error_codigo): se
    // revierte primero, o la reversa de la 142 le borra ese índice en silencio.
    const { rows: [con143] } = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name='negocio_telefonos_propios'`);
    if (con143) await pool.query(leer('migrations/143_clientes_saneamiento_down.sql'));
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
    // Sin la 143 todavía: solo las columnas de la 142.
    const { rows: [e] } = await pool.query('SELECT estado, cola_at, telefono_envio, wamid FROM campana_envios WHERE campana_id=$1', [c.id]);
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

  await caso('M4 la 143 se aplica encima: campañas, envíos y clientes que ya había quedan sin tocar', async () => {
    const neg = await negocio({ clientes: 2 });
    const { rows: [c] } = await pool.query(`INSERT INTO campanas(nombre,segmento,mensaje,total_destinatarios,estado,negocio_id,tipo)
      VALUES('De antes','todos','x',2,'enviando',$1,'plantilla') RETURNING id`, [neg.id]);
    await pool.query(`INSERT INTO campana_envios(campana_id,telefono,estado,cola_at,telefono_envio,error_codigo)
      VALUES($1,$2,'fallido',now(),$3,131050)`, [c.id, neg.telefonos[0], paraMeta(neg.telefonos[0])]);
    const r = predeploy('143-clientes-saneamiento');
    assert.equal(r.codigo, 0, r.salida);
    assert.match(r.salida, /\[predeploy-143\] Aplicada:/);
    const vieja = await campana(c.id);
    // Sin tope ni umbral: lo que ya iba mandándose sigue igual que antes.
    assert.deepEqual([vieja.estado, vieja.tope_24h, vieja.umbral_rechazo_pct, vieja.pausada_at], ['enviando', null, null, null]);
    const [e] = await envios(c.id);
    assert.deepEqual([e.estado, e.cliente_id, e.baja_at], ['fallido', null, null]);
    const { rows: [k] } = await pool.query('SELECT count(*) FILTER (WHERE es_interno)::int AS i, count(*)::int AS n FROM clientes_negocio WHERE negocio_id=$1', [neg.id]);
    assert.deepEqual([k.i, k.n], [0, 2]);
    const { rows: [ix] } = await pool.query("SELECT 1 AS si FROM pg_indexes WHERE indexname='campana_envios_baja_pendiente'");
    assert.ok(ix, 'falta el índice de bajas');
    await pool.query("UPDATE campanas SET estado='detenida', detenida_motivo='(prueba M4)' WHERE id=$1", [c.id]);
  });

  await caso('M5 la 143 otra vez no hace nada; a medias se repara', async () => {
    const r = predeploy('143-clientes-saneamiento');
    assert.equal(r.codigo, 0, r.salida);
    assert.match(r.salida, /\[predeploy-143\] Ya aplicada/);
    await pool.query('DROP INDEX campana_envios_baja_pendiente');
    const r2 = predeploy('143-clientes-saneamiento');
    assert.equal(r2.codigo, 0, r2.salida);
    assert.match(r2.salida, /\[predeploy-143\] Reparada \(faltaba: [^)]*campana_envios_baja_pendiente/);
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

  await caso('B2 la vista previa cuenta a SU Lista: sin internos, teléfonos del negocio, repartidores ni bajas', async () => {
    const neg = await negocio({ clientes: 3 });
    const otro = await negocio({ clientes: 2 });
    await cliente(neg, 'Cajera', { interno: true });
    const caja = await cliente(neg, 'Sucursal');
    await pool.query("INSERT INTO negocio_telefonos_propios(negocio_id,telefono,etiqueta,origen) VALUES($1,$2,'Caja','manual')", [neg.id, caja.slice(3)]);
    // Un teléfono del negocio DESACTIVADO vuelve a contar como cliente.
    const exCaja = await cliente(neg, 'Lupita');
    await pool.query("INSERT INTO negocio_telefonos_propios(negocio_id,telefono,etiqueta,origen,activo) VALUES($1,$2,'Vieja','manual',false)", [neg.id, exCaja.slice(3)]);
    // El repartidor se guarda con su número de WhatsApp (521…): igual se reconoce.
    const repa = await cliente(neg, 'Toño');
    await pool.query("INSERT INTO repartidores(negocio_id,nombre,telefono,token) VALUES($1,'Toño',$2,$3)", [neg.id, repa, `tk-${randomUUID()}`]);
    const baja = await cliente(neg, 'Rosa');
    await pool.query("INSERT INTO cliente_consentimientos(negocio_id,cliente_id,canal,otorgado,fuente) VALUES($1,$2,'whatsapp',false,'prueba')",
      [neg.id, await idDe(neg, baja)]);
    // El mismo número marcado «del negocio» en OTRO negocio no lo saca de aquí.
    await pool.query("INSERT INTO negocio_telefonos_propios(negocio_id,telefono,etiqueta,origen) VALUES($1,$2,'Ajeno','manual')", [otro.id, neg.telefonos[0].slice(3)]);
    const { resumen, lista } = await svc.prepararCampana(neg.id, DATOS);
    assert.equal(resumen.total, 4);
    assert.deepEqual(resumen.excluidos, { delNegocio: 1, internos: 1, repartidores: 1, sinNumero: 0, repetidos: 0, pidieronBaja: 1, recientes: 0 });
    assert.deepEqual(lista.map((d) => d.telefonoEnvio).sort(), [...neg.telefonos, exCaja].map(paraMeta).sort());
    assert.ok(lista.every((d) => /^[0-9a-f-]{36}$/.test(d.clienteId)), 'cada destinatario lleva su cliente');
    assert.equal(resumen.categoria, 'MARKETING');
    assert.equal(resumen.costo.totalUsd, 0.18);
    // La vista previa saluda al primero con nombre de verdad; el que no tiene va con el respaldo.
    assert.match(resumen.vista.cuerpo, /^Hola (Ana|Beto|Lupita), este jueves hay 2x1 en chilaquiles\.$/);
    assert.deepEqual([resumen.usaNombre, resumen.sinNombre], [true, 1]);
    assert.equal(resumen.vistaSinNombre.cuerpo, 'Hola cliente, este jueves hay 2x1 en chilaquiles.');
    assert.deepEqual(resumen.tandas, { tope24h: 250, umbralRechazoPct: 10, cuantas: 1 });
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
    // Cada envío sabe de qué cliente de la Lista es (ahí se anota la baja).
    const ids = await Promise.all(neg.telefonos.map((t) => idDe(neg, t)));
    assert.deepEqual(e.map((x) => x.cliente_id).sort(), ids.sort());
    assert.deepEqual([c.tope_24h, c.umbral_rechazo_pct, c.pausada_at], [250, 10, null]);
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

  // ── B18+. Saneamiento (143): tandas, pausa, bajas y el número de la sucursal ─
  await caso('B18 la tanda: con tope 10 manda 10 en 24 h, avisa que está llena y sigue sola al pasar el día', async () => {
    const neg = await negocio({ clientes: 12, nombres: ['Ana'] });
    const r = await crear(neg, { tope24h: 10 });
    assert.equal((await campana(r.campanaId)).tope_24h, 10);
    const antes = META.envios.length;
    await vuelta();
    assert.equal(META.envios.length, antes + 10);
    const [h] = (await svc.listarCampanasWa(neg.id)).filter((x) => x.id === r.campanaId);
    assert.deepEqual([h.tope24h, h.intentos24h, h.tandaLlena, h.enCola], [10, 10, true, 2]);
    await vuelta();
    assert.equal(META.envios.length, antes + 10, 'con la tanda llena no se manda más');
    assert.equal((await campana(r.campanaId)).estado, 'enviando');
    await pool.query("UPDATE campana_envios SET intento_at = intento_at - interval '25 hours' WHERE campana_id=$1 AND estado <> 'pendiente'", [r.campanaId]);
    await vuelta();
    assert.equal(META.envios.length, antes + 12);
    assert.equal((await campana(r.campanaId)).estado, 'completada');
    await rechaza(svc.prepararCampana(neg.id, { ...DATOS, tope24h: 5 }), 'TANDA_INVALIDA');
    await rechaza(svc.prepararCampana(neg.id, { ...DATOS, umbralRechazoPct: 90 }), 'TANDA_INVALIDA');
  });

  await caso('B19 si los rechazos pasan el umbral se pausa sola, dice por qué, y al reanudar mide desde cero', async () => {
    const neg = await negocio({ clientes: 26, nombres: ['Ana'] });
    const r = await crear(neg, { umbralRechazoPct: 10 });
    const antes = META.envios.length;
    // Los intentos 18, 19 y 20 los rechaza Meta (131026): 3 de 20 = 15 %.
    META.responder = (b, k) => (k - antes >= 18 && k - antes <= 20 ? { status: 400, datos: { error: { code: 131026 } } } : null);
    const res = await vuelta();
    META.responder = null;
    assert.equal(META.envios.length, antes + 20, 'se pausa en cuanto rebasa');
    assert.equal(res.pausadas, 1);
    const c = await campana(r.campanaId);
    assert.ok(c.estado === 'enviando' && c.pausada_at, JSON.stringify([c.estado, c.pausada_at]));
    assert.match(c.pausada_motivo, /Se pausó sola: 3 de 20 no llegaron \(15%, el tope es 10%\)/);
    await vuelta();
    assert.equal(META.envios.length, antes + 20, 'pausada no manda');
    // Pausada sigue ocupando el turno del negocio.
    await rechaza(crear(neg, { nombre: 'Otra', excluirRecientes: false }), 'OTRA_EN_CURSO');
    await svc.reanudarCampana(neg.id, r.campanaId);
    const c2 = await campana(r.campanaId);
    assert.ok(!c2.pausada_at && !c2.pausada_motivo && c2.reanudada_at);
    await vuelta();
    assert.equal(META.envios.length, antes + 26, 'tras reanudar, los 3 rechazos viejos ya no cuentan');
    assert.equal((await campana(r.campanaId)).estado, 'completada');
  });

  await caso('B20 pausar a mano: no manda hasta reanudar; otro negocio no la pausa ni la reanuda', async () => {
    const neg = await negocio({ clientes: 2 });
    const otro = await negocio({ clientes: 0 });
    const r = await crear(neg);
    await rechaza(svc.reanudarCampana(neg.id, r.campanaId), 'NO_PAUSADA');
    await rechaza(svc.pausarCampana(otro.id, r.campanaId), 'NO_EN_CURSO');
    await svc.pausarCampana(neg.id, r.campanaId);
    await rechaza(svc.pausarCampana(neg.id, r.campanaId), 'NO_EN_CURSO');
    assert.equal((await campana(r.campanaId)).pausada_motivo, 'Pausada desde el panel');
    const antes = META.envios.length;
    await vuelta();
    assert.equal(META.envios.length, antes);
    const [h] = (await svc.listarCampanasWa(neg.id)).filter((x) => x.id === r.campanaId);
    assert.ok(h.pausada, 'el historial dice desde cuándo está pausada');
    assert.equal(h.motivoPausa, 'Pausada desde el panel');
    await rechaza(svc.reanudarCampana(otro.id, r.campanaId), 'NO_PAUSADA');
    await svc.reanudarCampana(neg.id, r.campanaId);
    await vuelta();
    assert.equal(META.envios.length, antes + 2);
  });

  await caso('B21 las bajas quedan en el cliente con su fecha: por el rechazo 131050 y por el botón de la plantilla', async () => {
    const neg = await negocio({ clientes: 5, nombres: ['Ana'] });
    const otro = await negocio({ clientes: 0 });
    const r = await crear(neg);
    const [t0, t1, t2, t3, t4] = neg.telefonos;
    META.responder = (b) => (b.to === paraMeta(t0) ? { status: 400, datos: { error: { code: 131050 } } } : null);
    await vuelta();
    META.responder = null;
    const e = await envios(r.campanaId);
    const wamid = (t) => e.find((x) => x.telefono_envio === paraMeta(t)).wamid;
    // Lo que otras suites dejaron recién llegado no debe frenar al cursor aquí.
    await pool.query("UPDATE whatsapp_entradas SET recibido_at = recibido_at - interval '2 minutes' WHERE recibido_at > clock_timestamp() - interval '2 minutes'");
    // El trabajo ya corrió antes (cada 2 min): el cursor existe. Si no, la
    // primera vuelta arranca en «lo anterior a la primera campaña» y los
    // toques fechados «hace 2 minutos» quedarían antes de ese punto.
    await svc.registrarBajasCampanas({ log: sinLog });
    // Como el webhook: la conversación existe y la entrada cuelga de ella.
    const toque = async (t, texto, contexto, { negocioId = neg.id, hace = '2 minutes' } = {}) => {
      await pool.query('INSERT INTO whatsapp_conversaciones(negocio_id,telefono) VALUES($1,$2) ON CONFLICT DO NOTHING', [negocioId, t]);
      return pool.query(
        `INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,recibido_at)
         VALUES($1,$2,$3,$4,clock_timestamp() - $5::interval) RETURNING id`,
        [negocioId, t, `wamid.toque.${randomUUID()}`, JSON.stringify({ message: { from: t, type: 'button', context: { id: contexto },
          button: { text: texto, payload: texto } } }), hace]);
    };
    await toque(t1, 'Detener promociones', wamid(t1));
    await toque(t2, 'Sí, quiero', wamid(t2)); // otro botón: no es baja
    await toque(t3, 'Detener promociones', wamid(t3), { negocioId: otro.id }); // llegó a otro negocio: no cuenta aquí
    // Uno de hace segundos y DESPUÉS uno viejo: el cursor no debe brincar al reciente.
    const { rows: [reciente] } = await toque(t4, 'Detener promociones', wamid(t4), { hace: '0 seconds' });
    await toque(t3, 'Detener promociones', wamid(t3), { hace: '3 minutes' });
    await svc.registrarBajasCampanas({ log: sinLog });
    assert.deepEqual(await consentimientos(neg, t0), [[false, 'meta_131050']]);
    assert.deepEqual(await consentimientos(neg, t1), [[false, 'campana_boton_baja']]);
    assert.deepEqual(await consentimientos(neg, t2), []);
    assert.deepEqual(await consentimientos(neg, t3), [], 'lo posterior al reciente espera a la vuelta siguiente');
    assert.deepEqual(await consentimientos(neg, t4), []);
    await pool.query("UPDATE whatsapp_entradas SET recibido_at = recibido_at - interval '2 minutes' WHERE id=$1", [reciente.id]);
    await svc.registrarBajasCampanas({ log: sinLog });
    assert.deepEqual(await consentimientos(neg, t3), [[false, 'campana_boton_baja']]);
    assert.deepEqual(await consentimientos(neg, t4), [[false, 'campana_boton_baja']]);
    // Repetir no duplica nada, y la fecha queda en el envío.
    await svc.registrarBajasCampanas({ log: sinLog });
    for (const t of [t0, t1, t3, t4]) assert.equal((await consentimientos(neg, t)).length, 1);
    const e2 = await envios(r.campanaId);
    const conBaja = e2.filter((x) => x.baja_at).map((x) => x.telefono_envio).sort();
    assert.deepEqual(conBaja, [t0, t1, t3, t4].map(paraMeta).sort());
    const [h] = (await svc.listarCampanasWa(neg.id)).filter((x) => x.id === r.campanaId);
    assert.equal(h.bajas, 4);
    // Y ya no reciben la siguiente, aunque no se marque «no repetir».
    const sig = await svc.prepararCampana(neg.id, { ...DATOS, excluirRecientes: false });
    assert.deepEqual([sig.resumen.total, sig.resumen.excluidos.pidieronBaja], [1, 4]);
  });

  await caso('B22 el número del WhatsApp de la sucursal queda como teléfono del negocio y no recibe la campaña', async () => {
    const neg = await negocio({ clientes: 2 });
    const propio = await cliente(neg, 'Mostrador');
    META.numeros[neg.phoneId] = `+52 ${propio.slice(3, 6)} ${propio.slice(6, 9)} ${propio.slice(9)}`;
    try {
      const { resumen } = await svc.prepararCampana(neg.id, DATOS);
      assert.deepEqual([resumen.total, resumen.excluidos.delNegocio], [2, 1]);
      const { rows } = await pool.query('SELECT telefono, origen, activo FROM negocio_telefonos_propios WHERE negocio_id=$1', [neg.id]);
      assert.deepEqual(rows, [{ telefono: propio.slice(3), origen: 'whatsapp', activo: true }]);
      // Si el administrador lo desactivó, volver a leerlo de Meta NO lo reactiva.
      await pool.query('UPDATE negocio_telefonos_propios SET activo=false WHERE negocio_id=$1', [neg.id]);
      const otra = (await svc.prepararCampana(neg.id, DATOS)).resumen;
      assert.deepEqual([otra.total, otra.excluidos.delNegocio], [3, 0]);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM negocio_telefonos_propios WHERE negocio_id=$1', [neg.id])).rows[0].n, 1);
    } finally { delete META.numeros[neg.phoneId]; }
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
    pausar: async (nid, id) => { llamadas.push(['pausar', nid, id]); return { ok: true }; },
    reanudar: async (nid, id) => { llamadas.push(['reanudar', nid, id]); return { ok: true }; },
  } });
  const servidor = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}/api/admin/campanas-wa`;
  const pedir = (metodo, ruta, cuerpo, { rol = 'admin', modulo } = {}) => fetch(base + ruta, {
    method: metodo, headers: { 'content-type': 'application/json', ...(rol ? { 'x-rol': rol } : {}), ...(modulo ? { 'x-modulo': modulo } : {}) },
    body: metodo === 'GET' ? undefined : JSON.stringify(cuerpo || {}),
  });
  const TODAS = [['GET', ''], ['GET', '/plantillas'], ['POST', '/vista-previa'], ['POST', '/prueba'], ['POST', ''], ['POST', '/5/detener'],
    ['POST', '/5/pausar'], ['POST', '/5/reanudar']];
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
      await pedir('POST', '/9/pausar', { negocioId: 'otro' });
      await pedir('POST', '/9/reanudar', { negocioId: 'otro' });
      const [pl, prep, cr, det, pau, rea] = llamadas.slice(-6);
      assert.deepEqual([pau, rea], [['pausar', 'negocio-de-la-sesion', '9'], ['reanudar', 'negocio-de-la-sesion', '9']]);
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
