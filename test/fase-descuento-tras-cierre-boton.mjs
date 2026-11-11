// ─── DESCUENTO TRAS CIERRE: EL BOTÓN DEL PANEL ──────────────────────────────
//
// Pedido de Mario (11-nov-2026): «deberías poner un botón, nada en código».
// Tienda → Promociones trae una tarjeta con «Encender» / «Apagar»
// (panel/descuento-cierre.js) que habla con /api/admin/descuento-cierre
// (src/services/descuentoTrasCierreRutas.js → descuentoTrasCierreAdmin.js).
//
// Lo que cuida:
//   B. el servicio contra Postgres: encender crea (o reutiliza, o reactiva) la
//      promoción con lo que decidió Mario y escribe la clave; si el job no
//      podría mandar, no queda NADA guardado, también en domingo; apagar deja
//      la promoción viva; lo que enciende el botón es lo que lee el job.
//   R. las rutas: solo administradores, el negocio sale de la sesión, y los
//      errores se dicen sin filtrar detalles internos.
//   S. el cableado: server.js monta las rutas con requireAdminSeguro, el panel
//      carga la tarjeta con su huella, y el botón crea la MISMA promoción que el
//      script de operación.
//
// Horario de Acuña: lunes a sábado 7:30–14:00, domingo cerrado. Base local
// test_botones_*, red solo local. Sin teléfonos reales.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import express from 'express';
import { pool, actualizarConfiguracion } from '../src/services/database.js';
import { exigirBaseBotonesLocal } from './lib-botones-local.mjs';
import { enviarDescuentosTrasCierre } from '../src/services/descuentoTrasCierre.js';
import {
  ErrorDescuentoCierre, apagarDescuentoTrasCierre, encenderDescuentoTrasCierre, estadoDescuentoTrasCierre,
} from '../src/services/descuentoTrasCierreAdmin.js';
import { registrarRutasDescuentoTrasCierre } from '../src/services/descuentoTrasCierreRutas.js';

exigirBaseBotonesLocal();
const leer = (r) => readFileSync(new URL(`../${r}`, import.meta.url), 'utf8');
const telefonoFalso = () => `52100${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`;

let n = 0; let fallidas = 0;
const creados = [];
const SOLO = (process.env.CASOS || '').split(',').map((s) => s.trim()).filter(Boolean);
async function caso(nombre, fn) {
  if (SOLO.length && !SOLO.includes(nombre.split(' ')[0])) return;
  try { await fn(); console.log(`OK descuento-boton ${++n}: ${nombre}`); }
  catch (e) {
    fallidas++;
    const detalle = e?.code === 'ERR_ASSERTION' && e.generatedMessage
      ? ` · obtenido=${JSON.stringify(e.actual)?.slice(0, 200)} · esperado=${JSON.stringify(e.expected)?.slice(0, 120)}` : '';
    console.log(`FALLA ${nombre.split(' ')[0]} descuento-boton: ${nombre}\n  ${String(e?.message || e).split('\n')[0]}${detalle}`);
  }
}

// ── Fixtures ───────────────────────────────────────────────────────────────
const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const REGLAS = {
  restaurante: 'Botón del descuento',
  horarios: { ...Object.fromEntries(DIAS.map((d) => [d, { abierto: true, apertura: '07:30', cierre: '14:00' }])),
    domingo: { abierto: false, apertura: null, cierre: null } },
  pedidos: { modalidades: ['recoger en tienda'], tiempo_preparacion_minutos: 20, pedido_minimo_entrega: 0, costo_envio: 0, pago_aceptado: ['efectivo'] },
  cierres_especiales: [], promociones: [], politicas: [],
};
const local = (fecha, h, m = 0) => new Date(`${fecha}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-06:00`);
const DOMINGO_11 = local('2026-11-15', 11);
const LUNES_731 = local('2026-11-16', 7, 31);

async function negocio({ reglas = true, tienda = 'publicada', promo = null } = {}) {
  const slug = `descuento-boton-${randomUUID()}`;
  const { rows: [r] } = await pool.query('INSERT INTO negocios(nombre,slug,bot_whatsapp_activo) VALUES($1,$2,true) RETURNING id',
    ['Botón del descuento', slug]);
  creados.push(r.id);
  await actualizarConfiguracion({ timezone: 'America/Matamoros', ...(reglas ? { reglas_atencion: JSON.stringify(REGLAS) } : {}) }, r.id);
  if (tienda) await pool.query('INSERT INTO tienda_config(negocio_id,estado,slug_publico) VALUES($1,$2,$3)', [r.id, tienda, `t-${slug}`]);
  if (promo) {
    const p = { codigo: 'DOMINGO15', tipo: 'porcentaje', valor: 15, activa: true, automatica: false, canales: ['tienda_online'], ...promo };
    await pool.query(`INSERT INTO tienda_promociones(negocio_id,nombre,tipo,codigo,automatica,valor,activa,canales,limite_por_cliente)
      VALUES($1,'Ya existía',$2,$3,$4,$5,$6,$7::jsonb,1)`, [r.id, p.tipo, p.codigo, p.automatica, p.valor, p.activa, JSON.stringify(p.canales)]);
  }
  return { id: r.id, slug: `t-${slug}` };
}
async function clave(negocioId) {
  const { rows: [r] } = await pool.query("SELECT valor FROM configuracion WHERE negocio_id=$1 AND clave='cerrado_descuento_codigo'", [negocioId]);
  return r?.valor ?? null;
}
async function promos(negocioId) {
  const { rows } = await pool.query(`SELECT id, nombre, tipo, codigo, valor, activa, automatica, limite_por_cliente, limite_usos,
      canales, acumulable, solo_primera_compra, minimo_compra, vigencia_hasta FROM tienda_promociones WHERE negocio_id=$1 ORDER BY created_at`, [negocioId]);
  return rows;
}
const sinLog = { log: () => {} };
async function esperarError(fn, codigo) {
  let e = null;
  try { await fn(); } catch (x) { e = x; }
  assert.ok(e, 'debía rechazar el encendido');
  assert.ok(e instanceof ErrorDescuentoCierre, `error inesperado: ${e?.message}`);
  assert.equal(e.codigo, codigo);
  return e;
}

try {
  // ── B. El servicio contra Postgres ─────────────────────────────────────
  await caso('B1 apagado: la tarjeta dice apagado, el código que se usaría y que no se ha mandado nada', async () => {
    const neg = await negocio();
    const e = await estadoDescuentoTrasCierre(neg.id, { ahora: LUNES_731 });
    assert.deepEqual({ encendido: e.encendido, codigo: e.codigo, porcentajeNuevo: e.porcentajeNuevo, diasVigencia: e.diasVigencia,
      tiendaPublicada: e.tiendaPublicada, horarioPropio: e.horarioPropio, promo: e.promo, job: e.job, enviados: e.enviados },
    { encendido: false, codigo: 'DOMINGO15', porcentajeNuevo: 15, diasVigencia: 7, tiendaPublicada: true, horarioPropio: true,
      promo: null, job: null, enviados: { aceptados: 0, fallidos: 0, ultimo: null } });
  });

  await caso('B2 encender crea la promoción que decidió Mario y enciende el envío', async () => {
    const neg = await negocio(); const logs = [];
    const r = await encenderDescuentoTrasCierre(neg.id, { ahora: LUNES_731, usuarioId: 'u-prueba', log: (t) => logs.push(t) });
    assert.deepEqual(r.promocion.creada, true);
    assert.equal(await clave(neg.id), 'DOMINGO15');
    const [p, ...otras] = await promos(neg.id);
    assert.equal(otras.length, 0);
    assert.deepEqual({ tipo: p.tipo, codigo: p.codigo, valor: Number(p.valor), activa: p.activa, automatica: p.automatica,
      limite_por_cliente: p.limite_por_cliente, limite_usos: p.limite_usos, canales: p.canales, acumulable: p.acumulable,
      solo_primera_compra: p.solo_primera_compra, minimo_compra: Number(p.minimo_compra), vigencia_hasta: p.vigencia_hasta },
    { tipo: 'porcentaje', codigo: 'DOMINGO15', valor: 15, activa: true, automatica: false, limite_por_cliente: 1, limite_usos: null,
      canales: ['tienda_online'], acumulable: false, solo_primera_compra: false, minimo_compra: 0, vigencia_hasta: null });
    assert.equal(r.estado.encendido, true);
    assert.equal(r.estado.job.listo, true);
    assert.equal(r.estado.job.problema, null);
    assert.ok(logs.some((l) => /ENCENDIDO desde el panel por usuario=u-prueba/.test(l)), logs.join('\n'));
  });

  await caso('B3 encender otra vez, o con la promoción ya hecha a mano, la reutiliza tal cual', async () => {
    const neg = await negocio({ promo: { valor: 20 } });
    const r = await encenderDescuentoTrasCierre(neg.id, { ahora: LUNES_731, ...sinLog });
    assert.equal(r.promocion.creada, false);
    await encenderDescuentoTrasCierre(neg.id, { ahora: LUNES_731, ...sinLog });
    const lista = await promos(neg.id);
    assert.equal(lista.length, 1);
    assert.equal(Number(lista[0].valor), 20, 'el porcentaje que puso el negocio no se toca');
    assert.equal(lista[0].nombre, 'Ya existía');
  });

  await caso('B4 si la promoción estaba desactivada, «Encender» la reactiva', async () => {
    const neg = await negocio({ promo: { activa: false } });
    const r = await encenderDescuentoTrasCierre(neg.id, { ahora: LUNES_731, ...sinLog });
    assert.equal(r.promocion.reactivada, true);
    assert.equal((await promos(neg.id))[0].activa, true);
    assert.equal(r.estado.job.listo, true);
  });

  await caso('B5 sin horario propio: no enciende y no guarda nada (ni la clave ni la promoción)', async () => {
    const neg = await negocio({ reglas: false });
    const e = await esperarError(() => encenderDescuentoTrasCierre(neg.id, { ahora: LUNES_731, ...sinLog }), 'sin_horario_propio');
    assert.match(e.message, /horario de atención/);
    assert.equal(await clave(neg.id), null);
    assert.deepEqual(await promos(neg.id), []);
  });

  await caso('B6 con la tienda en borrador no enciende, tampoco en domingo con el negocio cerrado', async () => {
    for (const ahora of [DOMINGO_11, LUNES_731]) {
      const neg = await negocio({ tienda: 'borrador' });
      await esperarError(() => encenderDescuentoTrasCierre(neg.id, { ahora, ...sinLog }), 'tienda_sin_publicar');
      assert.equal(await clave(neg.id), null);
      assert.deepEqual(await promos(neg.id), []);
    }
  });

  await caso('B7 una DOMINGO15 que no sirve (automática, de otro canal) no se enciende, tampoco en domingo; queda intacta', async () => {
    for (const [promo, ahora] of [[{ automatica: true }, DOMINGO_11], [{ canales: ['pos'] }, DOMINGO_11], [{ automatica: true }, LUNES_731]]) {
      const neg = await negocio({ promo: { ...promo, activa: false } });
      await esperarError(() => encenderDescuentoTrasCierre(neg.id, { ahora, ...sinLog }), 'codigo_no_vigente');
      assert.equal(await clave(neg.id), null);
      const [p] = await promos(neg.id);
      assert.equal(p.activa, false, 'la reactivación se deshace junto con todo lo demás');
    }
  });

  await caso('B8 apagar borra la clave y deja viva la promoción; apagar otra vez no hace nada', async () => {
    const neg = await negocio(); const logs = [];
    await encenderDescuentoTrasCierre(neg.id, { ahora: LUNES_731, ...sinLog });
    const r = await apagarDescuentoTrasCierre(neg.id, { ahora: LUNES_731, usuarioId: 'u-prueba', log: (t) => logs.push(t) });
    assert.equal(await clave(neg.id), null);
    assert.equal((await promos(neg.id))[0].activa, true, 'a quien ya lo recibió le sigue valiendo');
    assert.equal(r.estado.encendido, false);
    assert.equal(logs.filter((l) => /APAGADO desde el panel/.test(l)).length, 1);
    await apagarDescuentoTrasCierre(neg.id, { ahora: LUNES_731, log: (t) => logs.push(t) });
    assert.equal(logs.filter((l) => /APAGADO desde el panel/.test(l)).length, 1);
  });

  await caso('B9 lo que enciende el botón es lo que manda el job, y la tarjeta cuenta el envío', async () => {
    const neg = await negocio(); const tel = telefonoFalso();
    await pool.query(`INSERT INTO mensajes(telefono,nombre,direccion,texto,negocio_id,origen,"timestamp")
      VALUES($1,'Cliente de prueba','entrante','¿Están abiertos?',$2,'cliente',($3::timestamptz AT TIME ZONE 'UTC'))`,
    [tel, neg.id, local('2026-11-15', 10).toISOString()]);
    // Se enciende el domingo (cerrado): no manda nada todavía.
    const r = await encenderDescuentoTrasCierre(neg.id, { ahora: DOMINGO_11, ...sinLog });
    assert.equal(r.estado.job.razon, 'cerrado_ahora'); assert.equal(r.estado.job.problema, null);
    const enviados = [];
    const res = await enviarDescuentosTrasCierre({ negocioId: neg.id, ahora: LUNES_731, log: () => {},
      enviar: async (_nid, numero, texto) => { enviados.push({ numero, texto }); return `wamid.local.${randomUUID()}`; } });
    assert.equal(res.enviados, 1, JSON.stringify(res));
    assert.equal(enviados[0].numero, tel);
    assert.ok(enviados[0].texto.includes('código DOMINGO15:\n') && enviados[0].texto.includes('⏰ Válido hasta el lunes 23 de noviembre.'));
    const e = await estadoDescuentoTrasCierre(neg.id, { ahora: local('2026-11-16', 7, 32) });
    assert.equal(e.enviados.aceptados, 1); assert.ok(e.enviados.ultimo);
    assert.equal(e.promo.vigenciaHasta, '2026-11-24T05:59:59.999Z');
  });

  await caso('B10 encender un negocio no toca a otro', async () => {
    const a = await negocio(); const b = await negocio();
    await encenderDescuentoTrasCierre(a.id, { ahora: LUNES_731, ...sinLog });
    assert.equal(await clave(b.id), null);
    assert.deepEqual(await promos(b.id), []);
    assert.equal((await estadoDescuentoTrasCierre(b.id, { ahora: LUNES_731 })).encendido, false);
  });

  await caso('B11 encendido pero con la promoción desactivada en la lista: la tarjeta avisa, también en domingo', async () => {
    const neg = await negocio();
    await encenderDescuentoTrasCierre(neg.id, { ahora: LUNES_731, ...sinLog });
    await pool.query("UPDATE tienda_promociones SET activa=false WHERE negocio_id=$1", [neg.id]);
    for (const ahora of [LUNES_731, DOMINGO_11]) {
      const e = await estadoDescuentoTrasCierre(neg.id, { ahora });
      assert.equal(e.encendido, true);
      assert.match(e.job.problema || '', /DOMINGO15 está desactivada/, `a las ${ahora.toISOString()}`);
    }
    await pool.query("UPDATE tienda_config SET estado='borrador' WHERE negocio_id=$1", [neg.id]);
    await pool.query("UPDATE tienda_promociones SET activa=true WHERE negocio_id=$1", [neg.id]);
    const e = await estadoDescuentoTrasCierre(neg.id, { ahora: DOMINGO_11 });
    assert.match(e.job.problema || '', /Publica tu tienda/, 'la tienda despublicada se avisa en domingo');
  });

  // ── R. Las rutas ───────────────────────────────────────────────────────
  const llamadas = [];
  let respuesta = async () => ({ promocion: { creada: true }, estado: { encendido: true } });
  const app = express();
  app.use(express.json());
  const requireAdminSeguro = (req, res, next) => {
    if (req.get('x-rol') !== 'admin') return res.status(403).json({ error: 'Permiso insuficiente' });
    req.negocioId = 'negocio-de-la-sesion'; req.usuarioId = 'u-sesion'; next();
  };
  registrarRutasDescuentoTrasCierre(app, { requireAdminSeguro, servicio: {
    estado: async (nid) => { llamadas.push(['estado', nid]); return { encendido: false, codigo: 'DOMINGO15' }; },
    encender: async (nid, o) => { llamadas.push(['encender', nid, o.usuarioId]); return respuesta(); },
    apagar: async (nid, o) => { llamadas.push(['apagar', nid, o.usuarioId]); return { estado: { encendido: false } }; },
  } });
  const servidor = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}/api/admin/descuento-cierre`;
  const pedir = (metodo, cuerpo, rol = 'admin') => fetch(base + (metodo === 'GET' && cuerpo ? `?negocioId=${cuerpo}` : ''), {
    method: metodo, headers: { 'content-type': 'application/json', ...(rol ? { 'x-rol': rol } : {}) },
    body: metodo === 'GET' ? undefined : JSON.stringify(cuerpo),
  });
  try {
    await caso('R1 el operador no lee ni cambia nada (403) y el servicio ni se entera', async () => {
      const antes = llamadas.length;
      assert.equal((await pedir('GET', null, 'staff')).status, 403);
      assert.equal((await pedir('PUT', { encendido: true }, 'staff')).status, 403);
      assert.equal((await pedir('PUT', { encendido: false }, null)).status, 403);
      assert.equal(llamadas.length, antes);
    });

    await caso('R2 el administrador lee y cambia SU negocio, el de la sesión, nunca el del cuerpo o la dirección', async () => {
      const g = await pedir('GET', 'otro-negocio');
      assert.equal(g.status, 200); assert.equal((await g.json()).codigo, 'DOMINGO15');
      const p = await pedir('PUT', { encendido: true, negocioId: 'otro-negocio' });
      assert.equal(p.status, 200); assert.equal((await p.json()).ok, true);
      const q = await pedir('PUT', { encendido: false, negocio_id: 'otro-negocio' });
      assert.equal(q.status, 200);
      assert.deepEqual(llamadas.slice(-3), [['estado', 'negocio-de-la-sesion'], ['encender', 'negocio-de-la-sesion', 'u-sesion'],
        ['apagar', 'negocio-de-la-sesion', 'u-sesion']]);
    });

    await caso('R3 «encendido» tiene que ser true o false: «si», 1 o nada es 400 y no se toca nada', async () => {
      const antes = llamadas.length;
      for (const c of [{ encendido: 'si' }, { encendido: 1 }, {}, { encendido: 'true' }]) {
        assert.equal((await pedir('PUT', c)).status, 400, JSON.stringify(c));
      }
      assert.equal(llamadas.length, antes);
    });

    await caso('R4 si el job no podría mandar es 409 con el porqué; un error interno es 500 sin detalles', async () => {
      respuesta = async () => { throw new ErrorDescuentoCierre('tienda_sin_publicar', 'Publica tu tienda en línea: el código solo se puede usar ahí.'); };
      const r = await pedir('PUT', { encendido: true });
      assert.equal(r.status, 409);
      assert.deepEqual(await r.json(), { error: 'Publica tu tienda en línea: el código solo se puede usar ahí.', codigo: 'tienda_sin_publicar' });
      respuesta = async () => { throw new Error('connection terminated: pg 10.0.0.7 password authentication'); };
      const original = console.error; console.error = () => {};
      let q;
      try { q = await pedir('PUT', { encendido: true }); } finally { console.error = original; }
      assert.equal(q.status, 500);
      const cuerpo = JSON.stringify(await q.json());
      assert.ok(!/10\.0\.0\.7|password|pg /.test(cuerpo), cuerpo);
    });
  } finally {
    await new Promise((ok) => servidor.close(ok));
  }

  // ── S. Cableado ────────────────────────────────────────────────────────
  await caso('S1 server.js monta las rutas con requireAdminSeguro, y las dos rutas lo exigen', async () => {
    const server = leer('src/server.js');
    assert.match(server, /^import \{ registrarRutasDescuentoTrasCierre \} from '\.\/services\/descuentoTrasCierreRutas\.js';$/m);
    assert.match(server, /^registrarRutasDescuentoTrasCierre\(app, \{ requireAdminSeguro \}\);$/m);
    const rutas = leer('src/services/descuentoTrasCierreRutas.js');
    const declaradas = [...rutas.matchAll(/app\.(get|put|post|patch|delete)\('([^']+)', ([^,]+),/g)].map((m) => `${m[1]} ${m[2]} ${m[3]}`);
    assert.deepEqual(declaradas, ['get /api/admin/descuento-cierre requireAdminSeguro', 'put /api/admin/descuento-cierre requireAdminSeguro']);
  });

  await caso('S2 el panel carga la tarjeta con su huella y la pone arriba de las promociones', async () => {
    const panel = leer('panel/index.html');
    const js = readFileSync(new URL('../panel/descuento-cierre.js', import.meta.url));
    const huella = createHash('sha256').update(js).digest('hex').slice(0, 8);
    const m = panel.match(/<script src="\/descuento-cierre\.js\?v=([0-9a-f]+)"><\/script>/);
    assert.ok(m, 'el panel no carga /descuento-cierre.js');
    assert.equal(m[1], huella, `panel: actualiza la etiqueta a ?v=${huella}`);
    const promos = panel.slice(panel.indexOf('async function tndPromociones()'), panel.indexOf('function tndTarjetaPromo('));
    assert.match(promos, /<div id="tnd-descuento-cierre"><\/div>/);
    assert.match(promos, /window\.XaborDescuentoCierre\?\.abrir\(document\.getElementById\('tnd-descuento-cierre'\)\);/);
    const texto = js.toString('utf8');
    assert.ok(!/onclick=/i.test(texto), 'sin onclick en línea');
    assert.deepEqual([...texto.matchAll(/window\.(\w+)\s*=(?!=)/g)].map((x) => x[1]), ['XaborDescuentoCierre']);
    assert.deepEqual([...new Set([...texto.matchAll(/apiFetch\('([^']+)'/g)].map((x) => x[1]))], ['/api/admin/descuento-cierre']);
  });

  await caso('S3 el botón y el script de operación crean la MISMA promoción', async () => {
    const insert = (t) => (t.match(/INSERT INTO tienda_promociones \(([\s\S]*?)RETURNING id/) || [])[1]?.replace(/\s+/g, ' ').trim();
    const delBoton = insert(leer('src/services/descuentoTrasCierreAdmin.js'));
    const delScript = insert(leer('scripts/ops/descuento-tras-cierre-2026-11/descuento.mjs'));
    assert.ok(delBoton && delScript);
    assert.equal(delBoton, delScript);
  });

  console.log(`Descuento tras cierre (botón): ${n} pasadas, ${fallidas} fallidas. Sin red externa ni teléfonos reales.`);
  if (fallidas) process.exitCode = 1;
} finally {
  // Apagados al terminar: un servidor de otra suite contra esta base pondría
  // a trabajar el job sobre cada negocio que esta suite dejó encendido.
  await pool.query(`DELETE FROM configuracion WHERE clave = 'cerrado_descuento_codigo' AND negocio_id = ANY($1::uuid[])`, [creados])
    .catch((e) => console.log(`(limpieza: ${e.message})`));
  await pool.end();
}
