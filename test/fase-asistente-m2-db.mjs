// ASISTENTE DEL RESTAURANTE, Mejora 2: recomendaciones concretas, contra
// Postgres. Sin red externa: la IA es un cliente simulado.
//
// Dos sucursales y sus ventas INVENTADAS, creadas aquí y borradas al final.
// Cubre:
//   B. la bandera es por sucursal y solo «true» la enciende;
//   D. la revisión de la mañana con la bandera guarda la recomendación con
//      su dato y las cifras chicas; la otra sucursal, la de siempre;
//   O. la pestaña ordena en tres grupos (decisión, buenas noticias,
//      informativo) solo donde está encendida;
//   I. la IA: con la bandera recibe los grupos y los datos del aviso, y su
//      recomendación sin dato concreto se descarta; sin la bandera, igual que
//      en la Fase 3;
//   X. ninguna sucursal ve lo de la otra;
//   R. la reversa: apagar la bandera devuelve todo como antes.
import assert from 'node:assert/strict';

// ── Guardas: solo base local de pruebas, solo red local ──────────────────────
if (!process.env.DATABASE_URL) { console.error('Falta DATABASE_URL'); process.exit(2); }
{
  const url = new URL(process.env.DATABASE_URL);
  assert(['127.0.0.1', 'localhost'].includes(url.hostname), 'solo base local');
  assert.match(url.pathname, /^\/test_botones_/, 'solo una base test_botones_*');
  assert.match(process.env.NODE_OPTIONS || '', /red-solo-local/, 'corre con NODE_OPTIONS=--import=./test/red-solo-local.mjs');
}

const { pool, actualizarConfiguracion } = await import('../src/services/database.js');
const { instanteLocal, fechaOperativaDe } = await import('../src/services/cortesCaja.js');
const R = await import('../src/asistenteRestaurante/reglas.js');
const P = await import('../src/asistenteRestaurante/proceso.js');
const AV = await import('../src/asistenteRestaurante/avisos.js');
const PA = await import('../src/asistenteRestaurante/pantalla.js');
const C = await import('../src/asistenteRestaurante/configuracion.js');
const RD = await import('../src/asistenteRestaurante/redaccion.js');
const M2 = await import('../src/asistenteRestaurante/recomendaciones.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  if (process.env.CASOS && !new RegExp(process.env.CASOS).test(nombre)) return;
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const TZ = 'America/Matamoros';
const HOY = fechaOperativaDe(new Date(), TZ);
const AYER = R.sumarDias(HOY, -1);
const a = (fecha, h, mi = 0) => { const [y, mo, d] = fecha.split('-').map(Number); return instanteLocal(y, mo, d, h, mi, 0, TZ); };
const TAG = 'AN' + (Date.now() % 1e8).toString(36).toUpperCase();
const SLUG = (l) => `${TAG.toLowerCase()}-asis-m2-${l}`;
const q = (sql, params) => pool.query(sql, params);
const uno = async (sql, params) => (await q(sql, params)).rows[0];

async function limpiar() {
  const { rows } = await q(`SELECT id FROM negocios WHERE slug LIKE '%-asis-m2-_'`);
  for (const { id } of rows) {
    const del = (sql) => q(sql, [id]).catch(() => {});
    await del('DELETE FROM asistente_restaurante_acciones WHERE negocio_id = $1');
    await del('DELETE FROM avisos_panel WHERE negocio_id = $1');
    await del('DELETE FROM asistente_restaurante_gasto_ia WHERE negocio_id = $1');
    await del('DELETE FROM asistente_restaurante_silenciados WHERE negocio_id = $1');
    await del('DELETE FROM asistente_restaurante_opiniones WHERE negocio_id = $1');
    await del('DELETE FROM asistente_restaurante_hallazgos WHERE negocio_id = $1');
    await del('DELETE FROM asistente_restaurante_corridas WHERE negocio_id = $1');
    await del('DELETE FROM pedidos_activos WHERE negocio_id = $1');
    await del('DELETE FROM configuracion WHERE negocio_id = $1');
    await del('DELETE FROM negocio_modulos WHERE negocio_id = $1');
    await del('DELETE FROM usuario_negocios WHERE negocio_id = $1');
  }
  for (const { id } of rows) {
    await q('DELETE FROM usuario_negocios WHERE usuario_id IN (SELECT id FROM usuarios WHERE negocio_id = $1)', [id]).catch(() => {});
    await q('DELETE FROM usuarios WHERE negocio_id = $1', [id]).catch(() => {});
    await q('DELETE FROM negocios WHERE id = $1', [id]).catch(() => {});
  }
}

function iaQue(responder) {
  const pedidas = [];
  return {
    pedidas,
    messages: {
      create: async (body) => {
        pedidas.push(body);
        const datos = JSON.parse(body.messages[0].content);
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(responder(datos)) }], usage: { input_tokens: 1000, output_tokens: 500 } };
      },
    },
  };
}

try {
  await limpiar();
  async function negocio(l, nombre) {
    const n = await uno('INSERT INTO negocios (nombre, slug, bot_whatsapp_activo) VALUES ($1, $2, true) RETURNING id', [nombre, SLUG(l)]);
    for (const m of ['pos', 'caja']) await q(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')`, [n.id, m]);
    await actualizarConfiguracion({ timezone: TZ }, n.id);
    return n.id;
  }
  async function usuario(neg, nombre, rol) {
    const u = await uno(`INSERT INTO usuarios (negocio_id, nombre, email, password_hash, activo) VALUES ($1,$2,$3,'x',true) RETURNING id`,
      [neg, nombre, `${TAG.toLowerCase()}-${nombre.replace(/\W+/g, '').toLowerCase()}@test.local`]);
    await q('INSERT INTO usuario_negocios (usuario_id, negocio_id, rol, activo) VALUES ($1,$2,$3,true)', [u.id, neg, rol]);
    return u.id;
  }
  async function cfg(neg, clave, valor) {
    await q('DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2', [neg, clave]);
    if (valor !== undefined) await q('INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,$2,$3)', [neg, clave, valor]);
  }
  async function venta(neg, folio, instante, total, extra = {}) {
    await q('INSERT INTO pedidos_activos (folio, estado, datos, negocio_id, created_at) VALUES ($1,$2,$3,$4,$5::timestamp)',
      [folio, 'entregado', JSON.stringify({ id: folio, canal: 'pos', modalidad: 'recoger en tienda', forma_pago: 'efectivo', subtotal: total, total,
        items: [{ nombre: 'Café', cantidad: 1, precio_unitario: total }], ...extra }), neg, instante.toISOString()]);
  }

  const NOMBRE_A = `${TAG} Sucursal A`, NOMBRE_B = `${TAG} Sucursal B`;
  const A = await negocio('a', NOMBRE_A);
  const B = await negocio('b', NOMBRE_B);
  const NA = { id: A, nombre: NOMBRE_A, tz: TZ };
  const NB = { id: B, nombre: NOMBRE_B, tz: TZ };
  const ADMIN_A = await usuario(A, `${TAG} Dueño A`, 'admin');
  const ADMIN_B = await usuario(B, `${TAG} Dueño B`, 'admin');
  for (const [n, quienes] of [[A, [ADMIN_A]], [B, [ADMIN_B]]]) {
    await cfg(n, AV.BANDERA, 'true');
    await cfg(n, AV.CLAVE_MODO, 'visible');
    await cfg(n, AV.CLAVE_DESTINATARIOS, JSON.stringify(quienes));
  }
  // Las dos sucursales, iguales: ayer 5 ventas normales y 3 sin forma de pago
  // ($150 + $200 + $250 = $600).
  for (const [n, L] of [[A, 'A'], [B, 'B']]) {
    for (let i = 1; i <= 5; i++) await venta(n, `ACN-${TAG}-${L}OK${i}`, a(AYER, 9 + i), 120);
    for (let i = 1; i <= 3; i++) await venta(n, `ACN-${TAG}-${L}SF${i}`, a(AYER, 10 + i, 30), 100 + i * 50, { forma_pago: undefined });
  }

  const correr = async (neg, clienteIA) => {
    await q('DELETE FROM asistente_restaurante_corridas WHERE negocio_id = $1', [neg.id]);
    const r = await P.correrSucursal({ negocio: neg, modo: 'visible', hoy: HOY, ahora: a(HOY, 7), clienteIA });
    assert.ok(r.corridaId, `la corrida no corrió: ${JSON.stringify(r)}`);
    return r;
  };
  const hallazgos = async (neg) => (await q(`SELECT id::text AS id, tipo, elegido, motivo, titulo, contenido FROM asistente_restaurante_hallazgos
    WHERE negocio_id = $1 ORDER BY id`, [neg])).rows;
  const sinPagoDe = async (neg) => (await hallazgos(neg)).find((h) => h.tipo === 'ventas_sin_forma_pago');
  const CONCRETA = 'Captura la forma de pago de esas 3 ventas ($600) para que el corte cuadre.';
  let GENERICA = null;

  // ═══ B. La bandera ═════════════════════════════════════════════════════
  await t('B1. la bandera es por sucursal y solo «true» la enciende; sin sucursal no lee nada', async () => {
    assert.equal(M2.BANDERA_REGLAS_V2, 'asistente_restaurante_reglas_v2');
    assert.equal(await M2.reglasV2Encendidas(pool, A), false, 'nace encendida');
    for (const v of ['1', 'si', 'TRUE', 'True', 'false', '', 'verdadero']) {
      await cfg(A, M2.BANDERA_REGLAS_V2, v);
      assert.equal(await M2.reglasV2Encendidas(pool, A), false, `«${v}» la encendió`);
    }
    await cfg(A, M2.BANDERA_REGLAS_V2, ' true ');
    assert.equal(await M2.reglasV2Encendidas(pool, A), true);
    await cfg(A, M2.BANDERA_REGLAS_V2, 'true');
    assert.equal(await M2.reglasV2Encendidas(pool, A), true);
    assert.equal(await M2.reglasV2Encendidas(pool, B), false, 'encender A encendió B');
    for (const malo of [null, '', 'x', `${A}' OR 1=1 --`]) {
      await assert.rejects(M2.reglasV2Encendidas(pool, malo), (e) => e.code === 'TENANT_CONTEXT_REQUIRED');
    }
  });

  // ═══ D. La revisión de la mañana ═══════════════════════════════════════
  await t('D1. con la bandera, la recomendación nombra lo que hay que hacer y con cuánto; la otra sucursal sigue igual', async () => {
    await correr(NA);
    await correr(NB);
    const ha = await sinPagoDe(A), hb = await sinPagoDe(B);
    assert.ok(ha && ha.elegido && hb && hb.elegido, 'no salió el aviso de ventas sin forma de pago en las dos');
    assert.equal(ha.contenido.sugerencia, CONCRETA);
    GENERICA = hb.contenido.sugerencia;
    assert.ok(GENERICA && GENERICA !== CONCRETA && !/\d/.test(GENERICA), `B no tiene la de siempre: ${GENERICA}`);
    // Lo de las reglas no cambia: mismo título, mismas cifras, mismo botón.
    assert.equal(ha.titulo.replace(NOMBRE_A, ''), hb.titulo.replace(NOMBRE_B, ''));
    // (los folios son de cada sucursal: ACN-<tag>-A… y ACN-<tag>-B…)
    const sinSucursal = (x) => JSON.stringify(x).replaceAll(`-${TAG}-A`, '-X').replaceAll(`-${TAG}-B`, '-X');
    assert.equal(sinSucursal(ha.contenido.detalle), sinSucursal(hb.contenido.detalle));
    assert.deepEqual(ha.contenido.accion ?? null, hb.contenido.accion ?? null);
    // Nada de la Mejora 2 en B (ni cifras chicas ni «concretos» guardados).
    for (const h of await hallazgos(B)) assert.ok(!('datos' in (h.contenido.pantalla || {})) && !('concretos' in h.contenido), `${h.tipo} de B trae algo nuevo`);
    for (const h of await hallazgos(A)) assert.ok(!('concretos' in h.contenido), 'se guardó la lista interna de «concretos»');
  });

  await t('D2. en la pestaña: la tarjeta de A lleva la recomendación concreta; la de B, la de siempre', async () => {
    const ra = await PA.leerPantalla(pool, { negocioId: A, usuarioId: ADMIN_A, ahora: a(HOY, 14) });
    const rb = await PA.leerPantalla(pool, { negocioId: B, usuarioId: ADMIN_B, ahora: a(HOY, 14) });
    const ta = ra.tarjetas.find((x) => x.tipo === 'ventas_sin_forma_pago');
    const tb = rb.tarjetas.find((x) => x.tipo === 'ventas_sin_forma_pago');
    assert.equal(ta.sugerencia, CONCRETA);
    assert.equal(tb.sugerencia, GENERICA);
    assert.equal(ra.orden, 'decision');
    assert.equal(rb.orden, 'control');
  });

  // ═══ O. El orden de la pestaña ═════════════════════════════════════════
  const ins = async (neg, tipo, impacto, contenido = {}) => {
    const corrida = (await uno(`SELECT id FROM asistente_restaurante_corridas WHERE negocio_id = $1 AND fecha = $2`, [neg, HOY])).id;
    return (await uno(`INSERT INTO asistente_restaurante_hallazgos (negocio_id, corrida_id, tipo, firma, impacto, titulo, contenido, elegido, motivo, mostrado)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, true, 'elegido', true) RETURNING id::text AS id`,
    [neg, corrida, tipo, `${tipo}:prueba`, impacto, `Prueba ${tipo}`, JSON.stringify({ sugerencia: `Revisa los $${impacto}.`, detalle: { numeros: [] }, ...contenido })])).id;
  };

  await t('O1. tres grupos: lo que pide decisión por pesos, luego las buenas noticias y al final lo informativo; sin la bandera, control primero', async () => {
    const sinPago = Number((await uno(`SELECT impacto FROM asistente_restaurante_hallazgos WHERE negocio_id = $1 AND tipo = 'ventas_sin_forma_pago'`, [A])).impacto);
    assert.ok(sinPago > 300 && sinPago < 4200, `el impacto de las ventas sin forma de pago (${sinPago}) no deja probar el orden`);
    for (const neg of [A, B]) {
      await ins(neg, 'producto_sube', 9000);
      await ins(neg, 'producto_baja', 4200);
      await ins(neg, 'clientes_cambiaron', 50000);
      await ins(neg, 'descuentos_altos', 300);
    }
    const tipos = async (neg, u) => (await PA.leerPantalla(pool, { negocioId: neg, usuarioId: u, ahora: a(HOY, 14) })).tarjetas.map((x) => x.tipo);
    assert.deepEqual(await tipos(A, ADMIN_A), ['producto_baja', 'ventas_sin_forma_pago', 'descuentos_altos', 'producto_sube', 'clientes_cambiaron']);
    assert.deepEqual(await tipos(B, ADMIN_B), ['ventas_sin_forma_pago', 'descuentos_altos', 'clientes_cambiaron', 'producto_sube', 'producto_baja'],
      'B dejó de ordenar como en la Fase 4');
  });

  await t('O2. si la bandera no se puede leer, la pestaña abre con el orden de siempre (no se cae)', async () => {
    const db = { query: (sql, p) => (/asistente_restaurante_reglas_v2/.test(JSON.stringify(p || [])) ? Promise.reject(new Error('sin base')) : pool.query(sql, p)),
      connect: () => pool.connect() };
    const r = await PA.leerPantalla(db, { negocioId: A, usuarioId: ADMIN_A, ahora: a(HOY, 14) });
    assert.equal(r.orden, 'control');
    assert.equal(r.tarjetas[0].tipo, 'ventas_sin_forma_pago');
  });

  // ═══ I. La IA ══════════════════════════════════════════════════════════
  await t('I1. con la bandera, la IA recibe los grupos y su recomendación sin dato concreto se descarta; en B la de siempre pasa', async () => {
    for (const n of [A, B]) await cfg(n, C.CLAVE_RESUMEN, JSON.stringify({ ...C.RESUMEN_DE_SIEMPRE, ia: true }));
    const generica = (d) => ({ avisos: d.avisos.map((x) => ({ id: x.id, titulo: 'Hubo ventas sin forma de pago.', explicacion: 'Algunos cobros de ayer quedaron sin registrar.',
      sugerencia: 'Pide al cajero que registre la forma de pago de cada venta.' })) });
    const iaA = iaQue(generica), iaB = iaQue(generica);
    const ra = await correr(NA, iaA);
    const rb = await correr(NB, iaB);
    assert.equal(iaA.pedidas[0].system, RD.SISTEMA_AVISOS_V2);
    assert.equal(iaB.pedidas[0].system, RD.SISTEMA_AVISOS);
    const entradaA = JSON.parse(iaA.pedidas[0].messages[0].content);
    const avisoA = entradaA.avisos.find((x) => x.tipo === 'ventas_sin_forma_pago');
    assert.equal(avisoA.grupo, 'pide_decision');
    assert.ok(Array.isArray(avisoA.concretos));
    assert.ok(entradaA.obligatorios.includes(avisoA.id));
    assert.ok(JSON.parse(iaB.pedidas[0].messages[0].content).avisos.every((x) => !('concretos' in x)));
    for (const p of [...iaA.pedidas, ...iaB.pedidas]) {
      const texto = p.messages[0].content;
      assert.ok(!texto.includes('@') && !texto.includes(p === iaA.pedidas[0] ? NOMBRE_B : NOMBRE_A), 'a la IA le llegó algo de otra sucursal o un correo');
    }
    assert.equal(ra.ia, 'parcial', `A: ${ra.ia}`);
    assert.equal(rb.ia, 'ok', `B: ${rb.ia}`);
    const ha = await sinPagoDe(A), hb = await sinPagoDe(B);
    assert.ok(!('ia' in ha.contenido), 'A guardó el texto genérico de la IA');
    assert.equal(ha.contenido.sugerencia, CONCRETA, 'se perdió la de Xabor');
    assert.equal(hb.contenido.ia.sugerencia, 'Pide al cajero que registre la forma de pago de cada venta.');
    const ta = (await PA.leerPantalla(pool, { negocioId: A, usuarioId: ADMIN_A, ahora: a(HOY, 14) })).tarjetas.find((x) => x.tipo === 'ventas_sin_forma_pago');
    assert.equal(ta.sugerencia, CONCRETA);
  });

  await t('I2. con la bandera, una recomendación de la IA con su dato sí se queda', async () => {
    const ia = iaQue((d) => ({ avisos: d.avisos.map((x) => ({ id: x.id, titulo: 'Hubo ventas sin forma de pago.', explicacion: 'Algunos cobros de ayer quedaron sin registrar.',
      sugerencia: 'Registra cómo se pagaron las 3 ventas de ayer.' })) }));
    const r = await correr(NA, ia);
    assert.equal(r.ia, 'ok');
    const h = await sinPagoDe(A);
    assert.equal(h.contenido.ia.sugerencia, 'Registra cómo se pagaron las 3 ventas de ayer.');
    assert.equal(h.contenido.sugerencia, CONCRETA, 'el texto de las reglas se perdió');
    for (const n of [A, B]) await cfg(n, C.CLAVE_RESUMEN, undefined);
    await q('DELETE FROM asistente_restaurante_gasto_ia WHERE negocio_id = ANY($1::uuid[])', [[A, B]]);
  });

  // ═══ X. Una sucursal no ve lo de la otra ═══════════════════════════════
  await t('X1. la pestaña de cada sucursal solo trae sus avisos, aunque la otra tenga la bandera', async () => {
    await cfg(B, M2.BANDERA_REGLAS_V2, 'true');
    await cfg(A, M2.BANDERA_REGLAS_V2, undefined);
    await correr(NA);
    const ra = await PA.leerPantalla(pool, { negocioId: A, usuarioId: ADMIN_A, ahora: a(HOY, 14) });
    const rb = await PA.leerPantalla(pool, { negocioId: B, usuarioId: ADMIN_B, ahora: a(HOY, 14) });
    assert.equal(ra.orden, 'control', 'encender B encendió A');
    assert.equal(rb.orden, 'decision');
    const idsA = new Set((await hallazgos(A)).map((h) => h.id));
    const idsB = new Set((await hallazgos(B)).map((h) => h.id));
    assert.ok(ra.tarjetas.every((x) => idsA.has(String(x.id))) && rb.tarjetas.every((x) => idsB.has(String(x.id))), 'una pestaña trae avisos de la otra sucursal');
    assert.ok(!JSON.stringify(ra).includes(NOMBRE_B) && !JSON.stringify(rb).includes(NOMBRE_A));
    // Con la usuaria de B pidiendo la pestaña de A, nada de B.
    const cruzada = await PA.leerPantalla(pool, { negocioId: A, usuarioId: ADMIN_B, ahora: a(HOY, 14) });
    assert.ok(!cruzada || !JSON.stringify(cruzada).includes(NOMBRE_B));
    await cfg(B, M2.BANDERA_REGLAS_V2, undefined);
  });

  // ═══ R. La reversa ═════════════════════════════════════════════════════
  await t('R1. apagar la bandera devuelve la recomendación y el orden de siempre desde la siguiente revisión', async () => {
    await cfg(A, M2.BANDERA_REGLAS_V2, 'true');
    await correr(NA);
    assert.equal((await sinPagoDe(A)).contenido.sugerencia, CONCRETA);
    await cfg(A, M2.BANDERA_REGLAS_V2, undefined);
    // La pestaña cambia de orden en ese momento; el texto, con la siguiente revisión.
    assert.equal((await PA.leerPantalla(pool, { negocioId: A, usuarioId: ADMIN_A, ahora: a(HOY, 14) })).orden, 'control');
    await correr(NA);
    const h = await sinPagoDe(A);
    assert.equal(h.contenido.sugerencia, GENERICA);
    assert.ok(!('datos' in (h.contenido.pantalla || {})));
    // No hay migración: ninguna tabla nueva.
    assert.equal((await uno(`SELECT to_regclass('public.asistente_restaurante_reglas_v2') IS NULL AS no`)).no, true);
  });
} finally {
  await limpiar().catch((e) => console.error('limpieza:', e.message));
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallidas) console.log(fallos.map((f) => ` - ${f}`).join('\n'));
await pool.end().catch(() => {});
process.exit(fallidas ? 1 : 0);
