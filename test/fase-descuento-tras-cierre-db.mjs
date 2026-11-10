// ─── DESCUENTO TRAS CIERRE, CONTRA POSTGRES ─────────────────────────────────
//
// Decisión de Mario (10-nov-2026): quien escribió en el horario habitual un
// día que estuvimos cerrados recibe, al abrir, un código para la tienda en
// línea. Por el JOB REAL (enviarDescuentosTrasCierre) contra una base local:
// las reglas del negocio leídas con cargarReglas, la fecha y el minuto locales
// calculados en SQL, la promoción viva de tienda_promociones, la tienda
// publicada, la bitácora 136 apartada antes de enviar y el mensaje en el chat.
// De mentira solo el envío a WhatsApp y el panel (dobles que anotan).
//
// Cada caso crea SU negocio. Horario de Acuña: lunes a sábado 7:30–14:00,
// domingo cerrado. «Ahora» es el lunes 16-nov-2026 a las 7:31 (CST, UTC-6).
// Base local test_botones_*, red solo local. Sin teléfonos reales.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, actualizarConfiguracion } from '../src/services/database.js';
import { exigirBaseBotonesLocal } from './lib-botones-local.mjs';
import {
  enviarDescuentosTrasCierre, evaluarNegocio, decisionesDelNegocio, reglasPropias,
} from '../src/services/descuentoTrasCierre.js';

exigirBaseBotonesLocal();
const telefonoFalso = () => `52100${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`;

let n = 0; let fallidas = 0;
const creados = [];
const SOLO = (process.env.CASOS || '').split(',').map((s) => s.trim()).filter(Boolean);
async function caso(nombre, fn) {
  if (SOLO.length && !SOLO.includes(nombre.split(' ')[0])) return;
  try { await fn(); console.log(`OK descuento-cierre-db ${++n}: ${nombre}`); }
  catch (e) {
    fallidas++;
    const detalle = e?.code === 'ERR_ASSERTION' && e.generatedMessage
      ? ` · obtenido=${JSON.stringify(e.actual)?.slice(0, 200)} · esperado=${JSON.stringify(e.expected)?.slice(0, 120)}` : '';
    console.log(`FALLA ${nombre.split(' ')[0]} descuento-cierre-db: ${nombre}\n  ${String(e?.message || e).split('\n')[0]}${detalle}`);
  }
}

// ── Fixtures ───────────────────────────────────────────────────────────────
const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const REGLAS = {
  restaurante: 'Descuento tras cierre',
  horarios: { ...Object.fromEntries(DIAS.map((d) => [d, { abierto: true, apertura: '07:30', cierre: '14:00' }])),
    domingo: { abierto: false, apertura: null, cierre: null } },
  pedidos: { modalidades: ['recoger en tienda'], tiempo_preparacion_minutos: 20, pedido_minimo_entrega: 0, costo_envio: 0, pago_aceptado: ['efectivo'] },
  cierres_especiales: [], promociones: [], politicas: [],
};
// Hora local de Matamoros en noviembre (CST, UTC-6) → instante.
const local = (fecha, h, m = 0, s = 0) => new Date(`${fecha}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}-06:00`);
const DOM = '2026-11-15', LUN = '2026-11-16', SAB = '2026-11-14';
const LUNES_731 = local(LUN, 7, 31);

async function negocio({ codigo = 'DOMINGO15', cfg = {}, tienda = 'publicada', promo = {} } = {}) {
  const slug = `descuento-cierre-${randomUUID()}`;
  const { rows: [r] } = await pool.query('INSERT INTO negocios(nombre,slug,bot_whatsapp_activo) VALUES($1,$2,true) RETURNING id',
    ['Descuento tras cierre', slug]);
  creados.push(r.id);
  await actualizarConfiguracion({ reglas_atencion: JSON.stringify(REGLAS), timezone: 'America/Matamoros',
    ...(codigo === null ? {} : { cerrado_descuento_codigo: codigo }), ...cfg }, r.id);
  if (tienda) await pool.query('INSERT INTO tienda_config(negocio_id,estado,slug_publico) VALUES($1,$2,$3)', [r.id, tienda, `t-${slug}`]);
  if (promo !== null) {
    const p = { codigo: 'DOMINGO15', tipo: 'porcentaje', valor: 15, activa: true, automatica: false, canales: ['tienda_online'],
      vigencia_hasta: null, limite_usos: null, usos: 0, ...promo };
    await pool.query(`INSERT INTO tienda_promociones(negocio_id,nombre,tipo,codigo,automatica,valor,activa,canales,vigencia_hasta,limite_usos,usos,limite_por_cliente)
      VALUES($1,'Disculpa por cierre',$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,1)`,
    [r.id, p.tipo, p.codigo, p.automatica, p.valor, p.activa, JSON.stringify(p.canales), p.vigencia_hasta, p.limite_usos, p.usos]);
  }
  return { id: r.id, slug: `t-${slug}` };
}
/** Un mensaje en `mensajes` con la hora en UTC sin zona, como lo guarda la app. */
async function mensaje(negocioId, telefono, cuando, { dir = 'entrante', origen = null, texto = null } = {}) {
  await pool.query(`INSERT INTO mensajes(telefono,nombre,direccion,texto,negocio_id,origen,"timestamp")
    VALUES($1,$2,$3,$4,$5,$6,($7::timestamptz AT TIME ZONE 'UTC'))`,
  [telefono, dir === 'entrante' ? 'Cliente de prueba' : null, dir, texto || (dir === 'entrante' ? '📍 ¿Dónde están ubicados?' : 'Hola'),
    negocioId, origen || (dir === 'entrante' ? 'cliente' : 'bot'), cuando.toISOString()]);
}
function dobles({ falla = null, sinWhatsapp = false, espera = 0 } = {}) {
  const enviados = []; const panel = []; const logs = [];
  return {
    enviados, panel, logs,
    enviar: async (negocioId, telefono, texto) => {
      if (espera) await new Promise((r) => setTimeout(r, espera));
      if (falla) throw new Error(falla);
      if (sinWhatsapp) return null;
      enviados.push({ negocioId, telefono, texto });
      return `wamid.local.${randomUUID()}`;
    },
    broadcastPanel: (negocioId, data) => panel.push({ negocioId, data }),
    log: (t) => logs.push(t),
  };
}
const correr = (negocioId, d, ahora = LUNES_731) =>
  enviarDescuentosTrasCierre({ negocioId, ahora, enviar: d.enviar, broadcastPanel: d.broadcastPanel, log: d.log });
async function bitacora(negocioId) {
  const { rows } = await pool.query('SELECT telefono, codigo, estado, wamid, error, mensaje_cliente_at FROM descuento_tras_cierre_envios WHERE negocio_id=$1 ORDER BY id', [negocioId]);
  return rows;
}
async function razones(negocioId, ahora = LUNES_731) {
  const ev = await evaluarNegocio(pool, negocioId, 'DOMINGO15', { ahora });
  return ev.listo ? ev.decisiones.map((d) => d.razon) : ev.razon;
}

try {
  const { rows: [tabla] } = await pool.query("SELECT to_regclass('public.descuento_tras_cierre_envios') IS NOT NULL AS ok");
  assert.equal(tabla.ok, true, 'falta la 136 (descuento_tras_cierre_envios) en la base de prueba');

  await caso('C1 escribió el domingo a las 10:00: el lunes a las 7:31 recibe UNA vez el código, queda en la bitácora y en el chat', async () => {
    const neg = await negocio(); const tel = telefonoFalso(); const d = dobles();
    await mensaje(neg.id, tel, local(DOM, 10));
    await mensaje(neg.id, tel, local(DOM, 10, 0, 5), { dir: 'saliente', texto: 'Recibimos tu mensaje. 🙂 Ahora estamos cerrados…' });
    const r = await correr(neg.id, d);
    assert.equal(r.enviados, 1);
    assert.equal(d.enviados.length, 1);
    assert.equal(d.enviados[0].telefono, tel);
    assert.equal(d.enviados[0].texto, '¡Hola! 👋 Lamentamos no haberte atendido ayer: estábamos cerrados. '
      + 'Para compensarte, aquí tienes un descuento de 15 % en nuestra tienda en línea con el código DOMINGO15:\n'
      + `https://xabor.mx/t/${neg.slug}\n\n¡Ya estamos en servicio! ☀️`);
    const [b] = await bitacora(neg.id);
    assert.equal(b.estado, 'aceptado'); assert.equal(b.codigo, 'DOMINGO15'); assert.match(b.wamid, /^wamid\.local\./);
    assert.equal(new Date(b.mensaje_cliente_at).toISOString(), local(DOM, 10).toISOString());
    const { rows: [chat] } = await pool.query(`SELECT origen, message_id_externo, texto FROM mensajes
      WHERE negocio_id=$1 AND telefono=$2 AND direccion='saliente' AND texto LIKE '¡Hola! 👋 Lamentamos%'`, [neg.id, tel]);
    assert.equal(chat.origen, 'bot'); assert.equal(chat.message_id_externo, b.wamid);
    assert.equal(d.panel.length, 1); assert.equal(d.panel[0].data.tipo, 'nuevo_mensaje');
    // Otra corrida un minuto después: nada.
    const r2 = await correr(neg.id, d, local(LUN, 7, 32));
    assert.equal(r2.enviados, 0); assert.equal(d.enviados.length, 1);
  });

  await caso('C2 fuera del horario habitual (sábado 15:00, domingo 6:00, domingo 14:30) no se manda', async () => {
    const neg = await negocio(); const d = dobles();
    const [a, b, c] = [telefonoFalso(), telefonoFalso(), telefonoFalso()];
    await mensaje(neg.id, a, local(SAB, 15));
    await mensaje(neg.id, b, local(DOM, 6));
    await mensaje(neg.id, c, local(DOM, 14, 30));
    const r = await correr(neg.id, d);
    assert.equal(r.enviados, 0); assert.equal(d.enviados.length, 0);
    assert.deepEqual(await bitacora(neg.id), []);
  });

  await caso('C3 con el negocio cerrado (domingo 11:00) no se manda nada', async () => {
    const neg = await negocio(); const tel = telefonoFalso(); const d = dobles();
    await mensaje(neg.id, tel, local(DOM, 10));
    const r = await correr(neg.id, d, local(DOM, 11));
    assert.equal(r.enviados, 0); assert.equal(r.omitidos.cerrado_ahora, 1);
    assert.deepEqual(await bitacora(neg.id), []);
  });

  await caso('C4 si el personal ya le contestó (mensaje del panel o eco de la Business App), no', async () => {
    const neg = await negocio(); const d = dobles();
    const [a, b] = [telefonoFalso(), telefonoFalso()];
    await mensaje(neg.id, a, local(DOM, 10));
    await mensaje(neg.id, a, local(DOM, 12), { dir: 'saliente', origen: 'humano', texto: 'Hola, mañana abrimos' });
    await mensaje(neg.id, b, local(DOM, 10));
    await pool.query("INSERT INTO clientes(telefono,negocio_id,nombre,last_business_app_message_at) VALUES($1,$2,'Cliente',$3)",
      [b, neg.id, local(DOM, 11).toISOString()]);
    assert.deepEqual((await razones(neg.id)).sort(), ['ya_lo_atendio_el_personal', 'ya_lo_atendio_el_personal']);
    const r = await correr(neg.id, d);
    assert.equal(r.enviados, 0);
  });

  await caso('C5 si ya pidió (tienda o programado) después de escribir, no', async () => {
    const neg = await negocio(); const d = dobles();
    const [a, b] = [telefonoFalso(), telefonoFalso()];
    await mensaje(neg.id, a, local(DOM, 10));
    await mensaje(neg.id, b, local(DOM, 10));
    await pool.query(`INSERT INTO pedidos_activos(folio,datos,estado,negocio_id,created_at)
      VALUES($1,$2,'nuevo',$3,($4::timestamptz AT TIME ZONE 'UTC'))`,
    [`DTC-${randomUUID().slice(0, 8)}`, JSON.stringify({ canal: 'tienda_online', cliente: { telefono: a.slice(-10) } }), neg.id, local(DOM, 10, 30).toISOString()]);
    await pool.query(`INSERT INTO pedidos_programados(folio,datos,programado_para,negocio_id,created_at)
      VALUES($1,$2,'2026-11-16 15:00',$3,($4::timestamptz AT TIME ZONE 'UTC'))`,
    [`DTC-${randomUUID().slice(0, 8)}`, JSON.stringify({ cliente: { telefono: `+${b}` } }), neg.id, local(DOM, 11).toISOString()]);
    assert.deepEqual(await razones(neg.id), ['ya_pidio', 'ya_pidio']);
    assert.equal((await correr(neg.id, d)).enviados, 0);
  });

  await caso('C6 una conversación en pausa, tomada o en revisión la decide el personal', async () => {
    const neg = await negocio(); const d = dobles();
    const [a, b, c] = [telefonoFalso(), telefonoFalso(), telefonoFalso()];
    for (const t of [a, b, c]) await mensaje(neg.id, t, local(DOM, 10));
    await pool.query('INSERT INTO conversaciones_control(negocio_id,telefono,bot_pausado,updated_at) VALUES($1,$2,true,now())', [neg.id, a]);
    await pool.query("INSERT INTO clientes(telefono,negocio_id,nombre,human_takeover_until) VALUES($1,$2,'Cliente',$3)",
      [b, neg.id, local(LUN, 8).toISOString()]);
    await pool.query("INSERT INTO whatsapp_conversaciones(negocio_id,telefono,requiere_revision,motivo) VALUES($1,$2,true,'PRUEBA')", [neg.id, c]);
    assert.deepEqual(await razones(neg.id), ['conversacion_con_el_personal', 'conversacion_con_el_personal', 'conversacion_con_el_personal']);
    assert.equal((await correr(neg.id, d)).enviados, 0);
  });

  await caso('C7 a su ventana de 24 h le quedan 4 min (escribió el domingo a las 7:35): no se manda', async () => {
    const neg = await negocio(); const tel = telefonoFalso(); const d = dobles();
    await mensaje(neg.id, tel, local(DOM, 7, 35));
    assert.deepEqual(await razones(neg.id), ['ventana_vencida']);
    assert.equal((await correr(neg.id, d)).enviados, 0);
    assert.deepEqual(await bitacora(neg.id), []);
  });

  await caso('C8 si volvió a escribir el lunes ya abierto, no (lo está atendiendo el bot)', async () => {
    const neg = await negocio(); const tel = telefonoFalso(); const d = dobles();
    await mensaje(neg.id, tel, local(DOM, 10));
    await mensaje(neg.id, tel, local(LUN, 7, 30, 30));
    assert.deepEqual(await razones(neg.id), ['ya_escribio_abierto']);
    assert.equal((await correr(neg.id, d)).enviados, 0);
  });

  await caso('C9 sin la promoción viva (no existe, inactiva, vencida, sin cupo o solo para otro canal) no se manda ni se aparta', async () => {
    for (const promo of [null, { activa: false }, { vigencia_hasta: local(DOM, 23).toISOString() },
      { limite_usos: 5, usos: 5 }, { canales: ['whatsapp'] }, { automatica: true }, { codigo: 'OTRO10' }]) {
      const neg = await negocio({ promo }); const tel = telefonoFalso(); const d = dobles();
      await mensaje(neg.id, tel, local(DOM, 10));
      const r = await correr(neg.id, d);
      assert.equal(r.enviados, 0, `promo ${JSON.stringify(promo)}`);
      assert.equal(r.omitidos.codigo_no_vigente, 1, `promo ${JSON.stringify(promo)}: ${JSON.stringify(r.omitidos)}`);
      assert.deepEqual(await bitacora(neg.id), []);
      assert.ok(d.logs.some((l) => /codigo_no_vigente/.test(l)), 'el log no dice por qué');
    }
  });

  await caso('C10 una promoción que no se dice con un número (2x1) o una tienda sin publicar: no se manda', async () => {
    const dosPorUno = await negocio({ promo: { tipo: '2x1', valor: 0 } }); const d1 = dobles();
    await mensaje(dosPorUno.id, telefonoFalso(), local(DOM, 10));
    assert.equal((await correr(dosPorUno.id, d1)).omitidos.promocion_que_no_se_dice, 1);
    const borrador = await negocio({ tienda: 'borrador' }); const d2 = dobles();
    await mensaje(borrador.id, telefonoFalso(), local(DOM, 10));
    assert.equal((await correr(borrador.id, d2)).omitidos.tienda_sin_publicar, 1);
    assert.equal(d1.enviados.length + d2.enviados.length, 0);
  });

  await caso('C11 sin la bandera, o con un código mal escrito, el negocio no participa', async () => {
    const sin = await negocio({ codigo: null }); const mal = await negocio({ codigo: 'DOS PALABRAS' }); const d = dobles();
    await mensaje(sin.id, telefonoFalso(), local(DOM, 10));
    await mensaje(mal.id, telefonoFalso(), local(DOM, 10));
    assert.equal((await correr(sin.id, d)).negocios, 0);
    assert.equal((await correr(mal.id, d)).negocios, 0);
    assert.equal(d.enviados.length, 0);
  });

  await caso('C12 Meta lo rechaza: queda «fallido», no entra al chat y no se reintenta', async () => {
    const neg = await negocio(); const tel = telefonoFalso(); const d = dobles({ falla: 'Meta API: {"code":131047}' });
    await mensaje(neg.id, tel, local(DOM, 10));
    const r = await correr(neg.id, d);
    assert.equal(r.fallidos, 1);
    const [b] = await bitacora(neg.id);
    assert.equal(b.estado, 'fallido'); assert.match(b.error, /131047/);
    const { rows: [{ c }] } = await pool.query("SELECT COUNT(*)::int c FROM mensajes WHERE negocio_id=$1 AND direccion='saliente' AND texto LIKE '¡Hola! 👋 Lamentamos%'", [neg.id]);
    assert.equal(c, 0);
    const ok = dobles();
    assert.equal((await correr(neg.id, ok, local(LUN, 7, 40))).enviados, 0);
    assert.equal(ok.enviados.length, 0);
  });

  await caso('C13 sin WhatsApp propio del negocio: «fallido» sin_whatsapp_propio', async () => {
    const neg = await negocio(); const d = dobles({ sinWhatsapp: true });
    await mensaje(neg.id, telefonoFalso(), local(DOM, 10));
    assert.equal((await correr(neg.id, d)).fallidos, 1);
    const [b] = await bitacora(neg.id);
    assert.equal(b.estado, 'fallido'); assert.equal(b.error, 'sin_whatsapp_propio');
  });

  await caso('C14 dos corridas a la vez (dos instancias durante un despliegue): un solo envío', async () => {
    const neg = await negocio(); const tel = telefonoFalso(); const d = dobles({ espera: 150 });
    await mensaje(neg.id, tel, local(DOM, 10));
    const [r1, r2] = await Promise.all([correr(neg.id, d), correr(neg.id, d)]);
    assert.equal(r1.enviados + r2.enviados, 1);
    assert.equal(d.enviados.length, 1);
    assert.equal((await bitacora(neg.id)).length, 1);
    // La carrera exacta: la otra instancia aparta DESPUÉS de que esta decidió
    // enviar y ANTES de que aparte. Lo que la frena es el UNIQUE, no la lectura.
    const neg2 = await negocio(); const otro = telefonoFalso(); const d2 = dobles();
    await mensaje(neg2.id, otro, local(DOM, 11));
    const r3 = await enviarDescuentosTrasCierre({ negocioId: neg2.id, ahora: LUNES_731, enviar: d2.enviar, log: d2.log,
      antesDeApartar: (nid, tel) => pool.query(`INSERT INTO descuento_tras_cierre_envios(negocio_id,telefono,codigo,mensaje_cliente_at,estado)
        VALUES($1,$2,'DOMINGO15',now(),'aceptado')`, [nid, tel]) });
    assert.equal(r3.enviados, 0);
    assert.equal(r3.omitidos.ya_enviado, 1);
    assert.equal(d2.enviados.length, 0);
  });

  await caso('C15 cada negocio con su código y su tienda: el de otro negocio no se mezcla', async () => {
    const a = await negocio(); const b = await negocio({ codigo: 'PERDON50', promo: { codigo: 'PERDON50', tipo: 'monto_fijo', valor: 50 } });
    const ta = telefonoFalso(); const tb = telefonoFalso(); const d = dobles();
    await mensaje(a.id, ta, local(DOM, 10));
    await mensaje(b.id, tb, local(DOM, 11));
    await correr(a.id, d); await correr(b.id, d);
    assert.equal(d.enviados.length, 2);
    const [ea, eb] = d.enviados;
    assert.equal(ea.negocioId, a.id); assert.match(ea.texto, /DOMINGO15:\nhttps:\/\/xabor\.mx\/t\/t-descuento/); assert.ok(ea.texto.includes(a.slug));
    assert.equal(eb.negocioId, b.id); assert.match(eb.texto, /descuento de \$50 .* PERDON50/); assert.ok(eb.texto.includes(b.slug));
  });

  await caso('C16 un domingo con varios mensajes (10:00 y 18:00): uno solo, contado desde el primero', async () => {
    const neg = await negocio(); const tel = telefonoFalso(); const d = dobles();
    await mensaje(neg.id, tel, local(DOM, 10));
    await mensaje(neg.id, tel, local(DOM, 18));
    await mensaje(neg.id, tel, local(DOM, 18, 1));
    assert.equal((await correr(neg.id, d)).enviados, 1);
    const [b] = await bitacora(neg.id);
    assert.equal(new Date(b.mensaje_cliente_at).toISOString(), local(DOM, 10).toISOString());
  });

  await caso('C17 sin SU horario guardado (o mal formado) no se manda: el genérico de 9:00 a 20:00 no es el del negocio', async () => {
    for (const reglas of [null, '{"horarios":', JSON.stringify({ horarios: {} })]) {
      const neg = await negocio(); const d = dobles();
      if (reglas === null) await pool.query("DELETE FROM configuracion WHERE negocio_id=$1 AND clave='reglas_atencion'", [neg.id]);
      else await actualizarConfiguracion({ reglas_atencion: reglas }, neg.id);
      await mensaje(neg.id, telefonoFalso(), local(DOM, 10));
      const r = await correr(neg.id, d);
      assert.equal(r.enviados, 0, `reglas ${reglas}`);
      assert.equal(r.omitidos.sin_horario_propio, 1, `reglas ${reglas}: ${JSON.stringify(r.omitidos)}`);
    }
  });

  await caso('C18 el repaso de un día pasado no ve lo que pasó después de «ahora» (el personal contestó a las 7:44)', async () => {
    const neg = await negocio(); const tel = telefonoFalso();
    await mensaje(neg.id, tel, local(DOM, 10));
    await mensaje(neg.id, tel, local(LUN, 7, 44), { dir: 'saliente', origen: 'humano', texto: 'Buen día' });
    const reglas = await reglasPropias(pool, neg.id);
    assert.deepEqual((await decisionesDelNegocio(pool, neg.id, reglas, { ahora: LUNES_731 })).map((d) => d.razon), ['enviar']);
    assert.deepEqual((await decisionesDelNegocio(pool, neg.id, reglas, { ahora: local(LUN, 7, 50) })).map((d) => d.razon),
      ['ya_lo_atendio_el_personal']);
  });

  console.log(`Descuento tras cierre DB: ${n} pasadas, ${fallidas} fallidas. Sin red externa ni teléfonos reales.`);
  if (fallidas) process.exitCode = 1;
} finally {
  // Los negocios quedan (historial de la base de pruebas), pero APAGADOS: si
  // no, todo servidor que otra suite levante contra esta base pondría a
  // trabajar el job sobre cada negocio que esta suite dejó encendido.
  await pool.query(`DELETE FROM configuracion WHERE clave = 'cerrado_descuento_codigo' AND negocio_id = ANY($1::uuid[])`, [creados])
    .catch((e) => console.log(`(limpieza: ${e.message})`));
  await pool.end();
}
