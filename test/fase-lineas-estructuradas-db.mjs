// ─── Fase 2: líneas estructuradas — contra Postgres ─────────────────────────
//
// Contra una COPIA local test_botones_* (nunca producción). Lo que se protege:
//   M. la 161: el tipo nace «platillo» y sus reglas frenan lo inválido.
//   P. el proceso de cada 5 minutos: solo negocios con la bandera, solo los
//      últimos 14 días, idempotente, rehace lo que cambió, y la VENTA queda
//      byte por byte igual (pedidos_activos y la cuenta de mesa).
//   N. multi-negocio: el menú, los emparejamientos y el registro de un negocio
//      nunca se mezclan con los de otro.
//   X. Mesas: el renglón guarda producto_id y los modificadores como datos.
//   R. Rappi › Opciones sin clasificar: emparejar a mano rehace los pedidos
//      afectados; nada de otro negocio se puede leer, ligar ni borrar.
//   S. el relleno histórico: modo de prueba que no escribe, --aplicar
//      idempotente, reporte por canal, un negocio a la vez.
//   T. la marca inicial de tipos: reglas aprobadas, no pisa lo marcado a mano,
//      no toca otro negocio, idempotente; el registro toma el tipo de hoy.
//   E. el envío como cargo: con la bandera, ni el catálogo de captura ni el de
//      la tienda lo ofrecen y el servidor lo rechaza como producto; sin ella,
//      todo como antes.
//   H. por HTTP: /api/menu, /api/pedido-presencial y el editor del menú.
//
// Con LINEAS_SIN_161=1 corre contra una base SIN la 161 (la de producción
// antes de migrar) y comprueba que nada de lo de hoy se rompe.
//
// Uso: correr-suite.ps1 -Suite fase-lineas-estructuradas-db -Plantilla <tpl con o sin 161>
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

{
  const url = new URL(process.env.DATABASE_URL);
  assert(['127.0.0.1', 'localhost'].includes(url.hostname), 'solo base local');
  assert.match(url.pathname, /^\/test_botones_/, 'solo una base test_botones_*');
}
const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const A = SEED.negocioA;
const B = SEED.negocioB;
const USUARIO = SEED.adminNegocioAUsuarioId;
const SIN_161 = process.env.LINEAS_SIN_161 === '1';
const PUERTO = process.env.TEST_PORT_LINEAS || '4781';

const { pool, actualizarConfiguracion, crearProducto, actualizarProducto, ERROR_TIPO_PRODUCTO } = await import('../src/services/database.js');
const proceso = await import('../src/services/lineasEstructuradasProceso.js');
const rutas = await import('../src/services/lineasEstructuradasRutas.js');
const { agregarItems } = await import('../src/services/restauranteService.js');
const { recalcularItemsDesdeMenu, POSValidacionError } = await import('../src/services/posEnvios.js');
const { catalogoPublico } = await import('../src/services/tiendaOnline.js');
const { rechazarEnvioComoProducto, EnvioComoProductoError } = await import('../src/services/envioComoCargo.js');

let pasadas = 0, fallidas = 0;
const SOLO = (process.env.CASOS || '').split(',').map((s) => s.trim()).filter(Boolean);
async function t(nombre, fn) {
  if (SOLO.length && !SOLO.some((p) => nombre.startsWith(p))) return;
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) {
    fallidas++;
    const detalle = e?.code === 'ERR_ASSERTION' && e.generatedMessage
      ? ` · obtenido=${JSON.stringify(e.actual)?.slice(0, 300)} · esperado=${JSON.stringify(e.expected)?.slice(0, 200)}` : '';
    console.log(`FALLO ${nombre}: ${String(e?.message || e).split('\n')[0]}${detalle}`);
  }
}
async function rechaza(promesa, prueba) {
  let e = null;
  try { await promesa; } catch (x) { e = x; }
  assert.ok(e, 'debía rechazar y no rechazó');
  prueba(e);
}
const q = (sql, params) => pool.query(sql, params);
const uno = async (sql, params) => (await q(sql, params)).rows[0];

// ─── Fixtures ────────────────────────────────────────────────────────────
const TAG = 'L2' + (Date.now() % 1e8).toString(36);
const fol = (s) => `${TAG}-${s}`;
const nombreChil = `${TAG} Chilaquiles`;
const nombreChilB = `${TAG} Chilaquiles B`;
const nombreCombo = `${TAG} Combo misterioso`;

async function categoria(neg, nombre) {
  return (await uno('INSERT INTO menu_categorias (nombre, negocio_id, activa, orden) VALUES ($1,$2,TRUE,999) RETURNING id', [nombre, neg])).id;
}
async function producto(neg, cat, nombre, precio, { opciones = null, codigo = null } = {}) {
  return (await uno(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, opciones, codigo)
     VALUES ($1,$2,$3,$4,TRUE,$5,$6) RETURNING id`,
    [neg, cat, nombre, precio, opciones ? JSON.stringify(opciones) : null, codigo])).id;
}
async function grupo(neg, productoId, nombre, opciones) {
  const g = (await uno('INSERT INTO menu_modificadores_grupos (producto_id, nombre, negocio_id) VALUES ($1,$2,$3) RETURNING id',
    [productoId, nombre, neg])).id;
  const ids = {};
  for (const [i, [op, precio]] of opciones.entries()) {
    ids[op] = (await uno(
      'INSERT INTO menu_modificadores_opciones (grupo_id, nombre, precio_extra, negocio_id, orden) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [g, op, precio, neg, i])).id;
  }
  return { id: g, ...ids };
}
async function venta(neg, folio, canal, items, { dias = 1, extra = {} } = {}) {
  await q(`INSERT INTO pedidos_activos (folio, estado, datos, created_at, updated_at, negocio_id)
           VALUES ($1, 'entregado', $2, now() - make_interval(days => $3), now(), $4)`,
  [folio, JSON.stringify({ canal, items, ...extra }), dias, neg]);
}
const fijar = (neg, clave, valor) => actualizarConfiguracion({ [clave]: valor }, neg);

const M = {};
// Menú del negocio A
M.catDes = await categoria(A, `${TAG} Desayunos`);
M.chil = await producto(A, M.catDes, nombreChil, 120);
M.salsa = await grupo(A, M.chil, 'Salsa', [['Verde', 0], ['Roja', 0], ['Mole', 15]]);
M.prot = await grupo(A, M.chil, 'Proteína', [['Pollo', 20], ['Huevo', 15], ['Pechuga de pollo', 25]]);
M.ench = await producto(A, M.catDes, `${TAG} Enchiladas`, 110, { codigo: `${TAG}-ENC` });
M.catEnvio = await categoria(A, 'ENVIO');
M.envio60 = await producto(A, M.catEnvio, 'ENVIO 60', 60);
M.catBeb = await categoria(A, 'BEBIDAS');
M.agua = await producto(A, M.catBeb, `${TAG} Agua`, 30);
M.catExt = await categoria(A, 'EXTRAS');
M.extra20 = await producto(A, M.catExt, 'EXTRA 20', 20);
M.tortillas = await producto(A, M.catExt, 'TORTILLAS', 10);
M.queso = await producto(A, M.catExt, `${TAG} EXTRA QUESO`, 15);
M.fruta = await producto(A, M.catExt, 'EXTRA FRUTA', 15);
M.catTacos = await categoria(A, `${TAG} Tacos`);
M.tacos = await producto(A, M.catTacos, 'TACOS', 0);
// Menú del negocio B (mismos nombres de envío y extra, para ver que no se tocan)
M.catDesB = await categoria(B, `${TAG} Desayunos`);
M.chilB = await producto(B, M.catDesB, nombreChilB, 100);
M.salsaB = await grupo(B, M.chilB, 'Salsa', [['Verde', 0]]);
M.catEnvioB = await categoria(B, 'ENVIO');
M.envio60B = await producto(B, M.catEnvioB, 'ENVIO 60', 60);
M.catExtB = await categoria(B, 'EXTRAS');
M.extra20B = await producto(B, M.catExtB, 'EXTRA 20', 20);
// La tienda publica el envío (como en Obispado antes de esta fase).
await q(`INSERT INTO tienda_productos (negocio_id, producto_id, publicado) VALUES ($1,$2,TRUE), ($1,$3,TRUE)
         ON CONFLICT DO NOTHING`, [A, M.envio60, M.chil]);

// Banderas apagadas al empezar (la plantilla podría traerlas de otra suite).
for (const neg of [A, B]) {
  await fijar(neg, 'lineas_estructuradas', 'false');
  await fijar(neg, 'envio_solo_como_cargo', 'false');
}

// Ventas de A y de B (folios de prueba, no XAB-: no tocan la secuencia)
const modMole = { grupo_id: M.salsa.id, grupo: 'Salsa', opcion_id: M.salsa.Mole, opcion: 'Mole', precio_extra: 15 };
await venta(A, fol('A1'), 'pos', [{ producto_id: M.chil, nombre: nombreChil, cantidad: 2, precio_unitario: 135,
  modificadores: [modMole], notas: 'Salsa: Mole · T HARINA' }]);
await venta(A, fol('A2'), 'rappi', [
  { nombre: nombreChil, cantidad: 1, precio_unitario: 140, notas: 'Pechuga de pollo: 1, Salsa Diabla: 2' },
  { nombre: nombreCombo, cantidad: 1, precio_unitario: 99, notas: '' }]);
await venta(A, fol('A4'), 'pos', [{ producto_id: M.chil, nombre: nombreChil, cantidad: 1, precio_unitario: 120 }], { dias: 30 });
await venta(A, fol('A5'), 'tienda_online', [{ producto_id: M.chil, nombre: nombreChil, cantidad: 1, precio_unitario: 135,
  modificadores: [modMole], notas: 'Salsa: Mole · Para Juan' }]);
await venta(A, fol('A6'), 'presencial', [{ producto_id: M.envio60, nombre: 'ENVIO 60', cantidad: 1, precio_unitario: 60 }]);
await venta(B, fol('B1'), 'pos', [{ nombre: nombreChil, cantidad: 1, precio_unitario: 100 }]);
await venta(B, fol('B2'), 'pos', [{ producto_id: M.chilB, nombre: nombreChilB, cantidad: 1, precio_unitario: 100,
  modificadores: [{ grupo_id: M.salsaB.id, grupo: 'Salsa', opcion_id: M.salsaB.Verde, opcion: 'Verde', precio_extra: 0 }] }]);

// Mesa de A: la cuenta guarda nota y opciones aparte; la venta cerrada las pega.
const { n: mesa } = await uno(`SELECT n FROM generate_series(300, 500) n
  WHERE NOT EXISTS (SELECT 1 FROM restaurante_cuentas c WHERE c.negocio_id = $1 AND c.mesa_numero = n AND c.estado = 'abierta') LIMIT 1`, [A]);
const cuenta = (await uno(`INSERT INTO restaurante_cuentas (negocio_id, mesa_numero, mesero_usuario_id, abierta_por)
  VALUES ($1,$2,$3,$3) RETURNING id`, [A, mesa, USUARIO])).id;
const detVerde = [{ grupo_id: M.salsa.id, grupo: 'Salsa', opcion_id: M.salsa.Verde, opcion: 'Verde', precio_extra: 0 }];
await agregarItems(cuenta, A, [
  { producto: nombreChil, cantidad: 1, precio_unitario: 150, modificadores: ['Salsa: Verde'], notas: 'Para Ana',
    producto_id: M.chil, modificadores_det: detVerde },
  // Renglón libre: aunque traiga datos de catálogo, no se guardan (no hay producto del menú).
  { producto: `${TAG} Pastel de la casa`, cantidad: 1, precio_unitario: 80, modificadores_det: detVerde },
], USUARIO);
await venta(A, fol('A3'), 'restaurante_mesa', [
  { nombre: nombreChil, cantidad: 1, precio_unitario: 150, notas: 'Para Ana, Salsa: Verde' },
  { nombre: `${TAG} Pastel de la casa`, cantidad: 1, precio_unitario: 80, notas: null }], { extra: { cuenta_id: cuenta } });

// Temporada de A
const camp = (await uno(`INSERT INTO temporada_campanas (negocio_id, clave, titulo, producto, prefijo, fecha, hora_inicio, hora_fin,
    cupo_platillos, cupo_domicilio, max_platillos_pedido, precio)
  VALUES ($1, $2, 'Thanksgiving prueba', 'Pavo de prueba', 'TG', current_date + 10, '10:00', '14:00', 100, 10, 10, 1200) RETURNING id`,
[A, `${TAG.toLowerCase()}-tg`])).id;
const tempo = (await uno(`INSERT INTO temporada_pedidos (campana_id, negocio_id, numero, nombre, telefono, platillos, modalidad,
    ventana_inicio, ventana_fin, clave_envio, notas, creado_en)
  VALUES ($1,$2,1,'Cliente prueba','8780000000',3,'recoger','10:00','11:00',$3,'recoge 5 pm', now() - interval '1 day') RETURNING id`,
[camp, A, `${TAG}-clave-envio`])).id;
const FOLIO_TEMPORADA = `temporada-${tempo}`;

const FOLIOS_A = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'].map(fol);
// Los de la ventana de 14 días (A4 es de hace 30: solo lo llena el relleno).
const FOLIOS_VENTANA = ['A1', 'A2', 'A3', 'A5', 'A6'].map(fol);
const FOLIOS_B = ['B1', 'B2'].map(fol);
const huellaVentas = async () => (await uno(
  `SELECT md5(string_agg(folio || negocio_id::text || datos::text || estado, '|' ORDER BY folio)) AS h FROM pedidos_activos WHERE folio LIKE $1`,
  [`${TAG}-%`])).h;
const huellaCuenta = async () => (await uno(
  `SELECT md5(string_agg(to_jsonb(i)::text, '|' ORDER BY i.created_at, i.id)) AS h FROM restaurante_cuenta_items i WHERE cuenta_id = $1`, [cuenta])).h;
const HUELLA_VENTAS = await huellaVentas();
const HUELLA_CUENTA = await huellaCuenta();

async function lineasDe(folios) {
  const { rows } = await q(
    `SELECT l.id, l.negocio_id::text, l.folio, l.linea, l.producto_id, l.nombre, l.tipo, l.cantidad::float8 AS cantidad,
            l.precio_unitario::float8 AS precio, l.nota, l.estado,
            COALESCE((SELECT json_agg(json_build_object('grupo_id', m.grupo_id, 'grupo', m.grupo, 'opcion_id', m.opcion_id,
                     'opcion', m.opcion, 'cantidad', m.cantidad::float8, 'precio_extra', m.precio_extra::float8,
                     'clasificado', m.clasificado, 'negocio_id', m.negocio_id::text) ORDER BY m.orden)
                FROM pedido_linea_modificadores m WHERE m.linea_id = l.id), '[]') AS mods
       FROM pedido_lineas l WHERE l.folio = ANY($1) ORDER BY l.folio, l.linea`, [folios]);
  return rows;
}
const porFolio = (lineas, f, n = 1) => lineas.find((l) => l.folio === f && l.linea === n);
const cabeceras = async (folios) => (await q('SELECT folio, negocio_id::text, origen, canal, lineas, completas, parciales, sin_estructurar FROM pedido_lineas_pedidos WHERE folio = ANY($1) ORDER BY folio', [folios])).rows;

function correrScript(script, args) {
  const r = spawnSync(process.execPath, [join(RAIZ, 'scripts', script), ...args], {
    cwd: RAIZ, env: process.env, encoding: 'utf8', timeout: 120000 });
  return { codigo: r.status, salida: `${r.stdout || ''}${r.stderr || ''}` };
}
const jsonDe = (salida) => JSON.parse((salida.split('\n').find((l) => l.startsWith('JSON ')) || 'JSON null').slice(5));

if (SIN_161) {
  // ══════════ Sin la 161: lo de hoy no se rompe ══════════
  console.log('\nN — base SIN la 161');
  await t('N1 la base de verdad no tiene la 161', async () => {
    assert.equal((await uno("SELECT to_regclass('pedido_lineas') AS r")).r, null);
    assert.equal((await uno("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='menu_productos' AND column_name='tipo'")).n, 0);
  });
  await t('N2 Mesas agrega renglones igual (sin guardar las columnas nuevas)', async () => {
    const r = await agregarItems(cuenta, A, [{ producto: nombreChil, cantidad: 1, precio_unitario: 120, producto_id: M.chil, modificadores_det: detVerde }], USUARIO);
    assert.equal(r.length, 1);
  });
  await t('N3 el modo de prueba lee y cuenta; escribir se niega con un mensaje claro', async () => {
    const rep = await proceso.procesarNegocio(A, { escribir: false, todas: true, folios: FOLIOS_A });
    assert.equal(rep.pedidos, FOLIOS_A.length);
    assert.ok(rep.porCanal.rappi && rep.porCanal.restaurante_mesa && rep.porCanal.pos);
    await rechaza(proceso.procesarNegocio(A, { escribir: true }), (e) => assert.match(e.message, /falta la migración 161/));
  });
  await t('N4 el proceso de cada 5 minutos no hace nada y no truena', async () => {
    await fijar(A, 'lineas_estructuradas', 'true');
    assert.deepEqual(await proceso.procesarNegociosConBandera(), { negocios: 0, escritos: 0, fallos: 0 });
    assert.deepEqual((await rutas.sinClasificarRappi(A)).opciones, []);
    await fijar(A, 'lineas_estructuradas', 'false');
  });
  await t('N5 POS, tienda y el freno del envío funcionan sin la columna tipo', async () => {
    const r = await recalcularItemsDesdeMenu(A, [{ producto_id: M.chil, cantidad: 1 }]);
    assert.equal(r.items[0].producto_id, M.chil);
    await fijar(A, 'envio_solo_como_cargo', 'true');
    await rechazarEnvioComoProducto(A, [{ producto_id: M.envio60 }]); // sin marca de envío: no se frena
    await fijar(A, 'envio_solo_como_cargo', 'false');
    assert.ok(Array.isArray(await catalogoPublico(A)));
  });
  await t('N6 los scripts: prueba corre; --aplicar se niega sin la 161', async () => {
    const r1 = correrScript('rellenar-lineas-estructuradas.mjs', ['--negocio', A, '--json']);
    assert.equal(r1.codigo, 0, r1.salida.slice(-500));
    assert.match(r1.salida, /base sin la 161/);
    assert.ok(jsonDe(r1.salida).negocios[0].pedidos >= FOLIOS_A.length);
    const r2 = correrScript('rellenar-lineas-estructuradas.mjs', ['--negocio', A, '--aplicar']);
    assert.equal(r2.codigo, 1);
    assert.match(r2.salida, /falta la migración 161/);
    const r3 = correrScript('marcar-tipo-producto.mjs', ['--negocio', A]);
    assert.equal(r3.codigo, 0, r3.salida.slice(-500));
    assert.match(r3.salida, new RegExp(`#${M.envio60}\\s+ENVIO 60`));
    const r4 = correrScript('marcar-tipo-producto.mjs', ['--negocio', A, '--aplicar']);
    assert.equal(r4.codigo, 1);
  });
  await t('N7 la venta quedó intacta', async () => {
    assert.equal(await huellaVentas(), HUELLA_VENTAS);
  });
} else {
  // ══════════ Con la 161 ══════════
  console.log('\nM — migración 161');
  await t('M1 los productos nacen «platillo» y un tipo inválido se rechaza en la base', async () => {
    assert.equal((await uno('SELECT tipo FROM menu_productos WHERE id = $1', [M.chil])).tipo, 'platillo');
    await rechaza(q("UPDATE menu_productos SET tipo = 'postre' WHERE id = $1", [M.chil]), (e) => assert.match(e.message, /menu_productos_tipo/));
  });
  await t('M2 un emparejamiento de opción sin la opción del menú se rechaza', async () => {
    await rechaza(q(`INSERT INTO rappi_emparejamientos (negocio_id, producto_rappi, opcion_rappi, producto_id) VALUES ($1,'x','y',$2)`, [A, M.chil]),
      (e) => assert.match(e.message, /rappi_emparejamientos_forma/));
  });
  await t('M3 crear y editar el tipo; un tipo inválido no llega a la base; no se edita el de otro negocio', async () => {
    const p = await crearProducto({ categoria_id: M.catBeb, nombre: `${TAG} Refresco`, precio: 25, tipo: 'bebida' }, A);
    assert.equal(p.tipo, 'bebida');
    const sinTipo = await crearProducto({ categoria_id: M.catBeb, nombre: `${TAG} Jugo`, precio: 25 }, A);
    assert.equal(sinTipo.tipo, 'platillo');
    await rechaza(crearProducto({ categoria_id: M.catBeb, nombre: `${TAG} Malo`, precio: 1, tipo: 'postre' }, A),
      (e) => assert.equal(e.message, ERROR_TIPO_PRODUCTO));
    await actualizarProducto(sinTipo.id, { tipo: 'otro' }, A);
    assert.equal((await uno('SELECT tipo FROM menu_productos WHERE id = $1', [sinTipo.id])).tipo, 'otro');
    await actualizarProducto(M.chilB, { tipo: 'envio' }, A); // desde A, un producto de B
    assert.equal((await uno('SELECT tipo FROM menu_productos WHERE id = $1', [M.chilB])).tipo, 'platillo');
    await q('DELETE FROM menu_productos WHERE id = ANY($1)', [[p.id, sinTipo.id]]);
  });

  console.log('\nX — Mesas');
  await t('X1 el renglón del menú guarda producto_id y modificadores_det; el libre, nada', async () => {
    const { rows } = await q(`SELECT producto, producto_id, modificadores_det FROM restaurante_cuenta_items WHERE cuenta_id = $1 ORDER BY producto`, [cuenta]);
    const chil = rows.find((r) => r.producto === nombreChil);
    const libre = rows.find((r) => r.producto !== nombreChil);
    assert.equal(chil.producto_id, M.chil);
    assert.deepEqual(chil.modificadores_det, detVerde);
    assert.equal(libre.producto_id, null);
    assert.equal(libre.modificadores_det, null);
  });

  console.log('\nP — el proceso de cada 5 minutos');
  await t('P1 con la bandera apagada no escribe nada', async () => {
    await proceso.procesarNegociosConBandera();
    assert.deepEqual(await cabeceras([...FOLIOS_A, ...FOLIOS_B]), []);
  });
  await t('P2 con la bandera solo en A: A queda estructurado, B no', async () => {
    await fijar(A, 'lineas_estructuradas', 'true');
    const r = await proceso.procesarNegociosConBandera();
    assert.equal(r.fallos, 0);
    const cab = await cabeceras([...FOLIOS_A, ...FOLIOS_B, FOLIO_TEMPORADA]);
    assert.deepEqual(cab.map((c) => c.folio).sort(), [fol('A1'), fol('A2'), fol('A3'), fol('A5'), fol('A6'), FOLIO_TEMPORADA].sort(),
      'A4 es de hace 30 días (fuera de la ventana) y B no tiene la bandera');
    assert.ok(cab.every((c) => c.negocio_id === A));
  });
  await t('P3 POS y tienda: opciones como registros y la nota aparte', async () => {
    const l = await lineasDe([fol('A1'), fol('A5')]);
    const a1 = porFolio(l, fol('A1'));
    assert.deepEqual([a1.producto_id, a1.cantidad, a1.precio, a1.nota, a1.estado, a1.tipo], [M.chil, 2, 135, 'T HARINA', 'completa', 'platillo']);
    assert.deepEqual(a1.mods.map((m) => [m.grupo_id, m.opcion_id, m.cantidad, m.precio_extra, m.clasificado, m.negocio_id]),
      [[M.salsa.id, M.salsa.Mole, 1, 15, true, A]]);
    assert.equal(porFolio(l, fol('A5')).nota, 'Para Juan');
  });
  await t('P4 Mesas: la nota y las opciones salen de la cuenta, con la referencia al menú', async () => {
    const l = await lineasDe([fol('A3')]);
    const chil = porFolio(l, fol('A3'), 1);
    assert.deepEqual([chil.producto_id, chil.nota, chil.estado], [M.chil, 'Para Ana', 'completa']);
    assert.deepEqual(chil.mods.map((m) => [m.opcion_id, m.opcion]), [[M.salsa.Verde, 'Verde']]);
    const libre = porFolio(l, fol('A3'), 2);
    assert.deepEqual([libre.producto_id, libre.estado], [null, 'sin_estructurar']);
  });
  await t('P5 Rappi: «Pechuga de pollo: 1» a su grupo, lo demás a «Sin clasificar»', async () => {
    const l = await lineasDe([fol('A2')]);
    const chil = porFolio(l, fol('A2'), 1);
    assert.equal(chil.estado, 'parcial');
    assert.deepEqual(chil.mods.map((m) => [m.grupo, m.opcion, m.opcion_id, m.cantidad, m.clasificado]),
      [['Proteína', 'Pechuga de pollo', M.prot['Pechuga de pollo'], 1, true], ['Sin clasificar', 'Salsa Diabla', null, 2, false]]);
    assert.equal(porFolio(l, fol('A2'), 2).estado, 'sin_estructurar');
  });
  await t('P6 Temporada: una línea con los platillos del pedido', async () => {
    const [l] = await lineasDe([FOLIO_TEMPORADA]);
    assert.deepEqual([l.nombre, l.cantidad, l.precio, l.nota, l.estado], ['Pavo de prueba', 3, 1200, 'recoge 5 pm', 'completa']);
  });
  await t('P7 idempotente: la segunda corrida no escribe y no cambia nada', async () => {
    const antes = await lineasDe(FOLIOS_VENTANA);
    const r = await proceso.procesarNegocio(A, { folios: FOLIOS_VENTANA });
    assert.equal(r.escritos, 0);
    assert.deepEqual(await lineasDe(FOLIOS_VENTANA), antes);
  });
  await t('P8 si cambian los artículos de una venta, su registro se rehace', async () => {
    await q(`UPDATE pedidos_activos SET datos = jsonb_set(datos, '{items,0,cantidad}', '3') WHERE folio = $1`, [fol('A1')]);
    const r = await proceso.procesarNegocio(A, { folios: FOLIOS_VENTANA });
    assert.equal(r.escritos, 1);
    assert.equal(porFolio(await lineasDe([fol('A1')]), fol('A1')).cantidad, 3);
    await q(`UPDATE pedidos_activos SET datos = jsonb_set(datos, '{items,0,cantidad}', '2') WHERE folio = $1`, [fol('A1')]);
    await proceso.procesarNegocio(A, { folios: FOLIOS_VENTANA });
  });
  await t('N1 multi-negocio: B con la bandera usa SOLO su menú', async () => {
    await fijar(B, 'lineas_estructuradas', 'true');
    await proceso.procesarNegociosConBandera();
    const l = await lineasDe(FOLIOS_B);
    assert.ok(l.every((x) => x.negocio_id === B && x.mods.every((m) => m.negocio_id === B)));
    assert.deepEqual([porFolio(l, fol('B1')).producto_id, porFolio(l, fol('B1')).estado], [null, 'sin_estructurar'],
      'el nombre de un producto de A no se liga en B');
    assert.deepEqual([porFolio(l, fol('B2')).producto_id, porFolio(l, fol('B2')).estado], [M.chilB, 'completa']);
  });
  await t('P9 la venta y la cuenta de mesa quedaron byte por byte iguales', async () => {
    assert.equal(await huellaVentas(), HUELLA_VENTAS);
    assert.equal(await huellaCuenta(), HUELLA_CUENTA);
  });
  await t('P10 una venta que la base no acepta se salta y se anota; las demás del lote sí se guardan', async () => {
    const rara = `${TAG}Z7`, normal = `${TAG}Z8`;
    await venta(A, rara, 'pos', [{ producto_id: M.chil, nombre: nombreChil, cantidad: 1, precio_unitario: 1e12 }]);
    await venta(A, normal, 'pos', [{ producto_id: M.chil, nombre: nombreChil, cantidad: 1, precio_unitario: 120 }]);
    const r = await proceso.procesarNegocio(A, { folios: [rara, normal] });
    assert.equal(r.escritos, 1);
    assert.deepEqual(r.fallidos.map((f) => f.folio), [rara]);
    assert.deepEqual((await cabeceras([rara, normal])).map((c) => c.folio), [normal]);
  });

  console.log('\nR — Rappi › Opciones sin clasificar');
  const app = express();
  app.use(express.json());
  const negocioDe = (req, res, next) => { req.negocioId = req.get('x-negocio'); req.usuarioId = 'u-prueba'; next(); };
  rutas.registrarRutasLineasEstructuradas(app, { requireAdminSeguro: negocioDe });
  const appFalla = express();
  appFalla.use(express.json());
  rutas.registrarRutasLineasEstructuradas(appFalla, { requireAdminSeguro: negocioDe,
    servicio: { leer: async () => { throw new Error('detalle interno secreto'); } } });
  const servidor = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  const servidorFalla = await new Promise((ok) => { const s = appFalla.listen(0, '127.0.0.1', () => ok(s)); });
  const llamar = async (srv, metodo, ruta, neg, cuerpo) => {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}${ruta}`, { method: metodo,
      headers: { 'content-type': 'application/json', 'x-negocio': neg }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  let idEmparejamiento = null;
  await t('R1 A ve sus opciones y productos sin clasificar, con las opciones elegibles de su menú', async () => {
    const r = await llamar(servidor, 'GET', '/api/admin/lineas/rappi/sin-clasificar', A);
    assert.equal(r.status, 200);
    assert.equal(r.body.activo, true);
    const op = r.body.opciones.find((o) => o.producto_rappi === nombreChil && o.opcion_rappi === 'Salsa Diabla');
    assert.ok(op, 'falta «Salsa Diabla»');
    assert.ok(op.elegibles.some((e) => e.opcion_id === M.salsa.Mole && e.texto === 'Salsa: Mole'));
    assert.ok(r.body.productos.some((p) => p.producto_rappi === nombreCombo));
  });
  await t('R2 B no ve nada de A', async () => {
    const r = await llamar(servidor, 'GET', '/api/admin/lineas/rappi/sin-clasificar', B);
    assert.equal(r.status, 200);
    assert.ok(!JSON.stringify(r.body).includes(TAG + ' Chilaquiles"'), 'B no debe ver productos de Rappi de A');
    assert.ok(!r.body.menu.some((p) => p.id === M.chil));
  });
  await t('R3 emparejar una opción rehace el pedido y la línea queda completa', async () => {
    const r = await llamar(servidor, 'PUT', '/api/admin/lineas/rappi/emparejamientos', A,
      { producto_rappi: nombreChil, opcion_rappi: 'Salsa Diabla', producto_id: M.chil, opcion_id: M.salsa.Mole });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.rehechos >= 1);
    const chil = porFolio(await lineasDe([fol('A2')]), fol('A2'), 1);
    assert.equal(chil.estado, 'completa');
    assert.deepEqual(chil.mods[1], { grupo_id: M.salsa.id, grupo: 'Salsa', opcion_id: M.salsa.Mole, opcion: 'Mole', cantidad: 2,
      precio_extra: 15, clasificado: true, negocio_id: A });
    idEmparejamiento = (await uno(`SELECT id FROM rappi_emparejamientos WHERE negocio_id = $1 AND opcion_rappi = 'salsa diabla'`, [A])).id;
  });
  await t('R4 emparejar un producto de Rappi con uno del menú', async () => {
    const r = await llamar(servidor, 'PUT', '/api/admin/lineas/rappi/emparejamientos', A,
      { producto_rappi: nombreCombo, opcion_rappi: '', producto_id: M.ench });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const combo = porFolio(await lineasDe([fol('A2')]), fol('A2'), 2);
    assert.deepEqual([combo.producto_id, combo.estado], [M.ench, 'completa']);
  });
  await t('R5 no se liga a un producto ni a una opción de otro negocio; datos malos dan 400', async () => {
    let r = await llamar(servidor, 'PUT', '/api/admin/lineas/rappi/emparejamientos', A,
      { producto_rappi: nombreChil, opcion_rappi: '', producto_id: M.chilB });
    assert.deepEqual([r.status, r.body.codigo], [404, 'PRODUCTO_AJENO']);
    r = await llamar(servidor, 'PUT', '/api/admin/lineas/rappi/emparejamientos', A,
      { producto_rappi: nombreChil, opcion_rappi: 'Algo', producto_id: M.chil, opcion_id: M.salsaB.Verde });
    assert.deepEqual([r.status, r.body.codigo], [404, 'OPCION_AJENA']);
    r = await llamar(servidor, 'PUT', '/api/admin/lineas/rappi/emparejamientos', A, { producto_id: M.chil });
    assert.equal(r.status, 400);
  });
  await t('R6 B no puede borrar el emparejamiento de A', async () => {
    const r = await llamar(servidor, 'DELETE', `/api/admin/lineas/rappi/emparejamientos/${idEmparejamiento}`, B);
    assert.deepEqual([r.status, r.body.codigo], [404, 'NO_ENCONTRADO']);
    assert.ok(await uno('SELECT 1 AS x FROM rappi_emparejamientos WHERE id = $1', [idEmparejamiento]));
  });
  await t('R7 quitarlo regresa la opción a «Sin clasificar»', async () => {
    const r = await llamar(servidor, 'DELETE', `/api/admin/lineas/rappi/emparejamientos/${idEmparejamiento}`, A);
    assert.equal(r.status, 200);
    assert.equal(porFolio(await lineasDe([fol('A2')]), fol('A2'), 1).estado, 'parcial');
  });
  await t('R8 un error interno responde 500 sin detalles', async () => {
    const r = await llamar(servidorFalla, 'GET', '/api/admin/lineas/rappi/sin-clasificar', A);
    assert.equal(r.status, 500);
    assert.ok(!JSON.stringify(r.body).includes('secreto'));
  });
  servidor.close(); servidorFalla.close();

  console.log('\nS — relleno histórico');
  const cuentaRegistro = async (neg) => (await uno('SELECT count(*)::int AS n FROM pedido_lineas_pedidos WHERE negocio_id = $1', [neg])).n;
  await t('S1 el modo de prueba reporta por canal y no escribe nada', async () => {
    const antesA = await cuentaRegistro(A);
    const antesLineas = await lineasDe(FOLIOS_A);
    const r = correrScript('rellenar-lineas-estructuradas.mjs', ['--negocio', A, '--json']);
    assert.equal(r.codigo, 0, r.salida.slice(-800));
    assert.match(r.salida, /MODO DE PRUEBA/);
    const rep = jsonDe(r.salida).negocios[0];
    for (const canal of ['pos', 'rappi', 'restaurante_mesa', 'tienda_online', 'presencial', 'temporada']) {
      assert.ok(rep.porCanal[canal]?.lineas >= 1, `falta el canal ${canal}`);
    }
    assert.ok(rep.porCanal.rappi.sin_clasificar >= 1);
    assert.equal(await cuentaRegistro(A), antesA);
    assert.deepEqual(await lineasDe(FOLIOS_A), antesLineas);
    assert.equal(porFolio(await lineasDe([fol('A4')]), fol('A4')), undefined, 'A4 sigue sin registro');
  });
  await t('S2 --aplicar llena lo histórico (A4) y es idempotente; no toca a B', async () => {
    const antesB = await cuentaRegistro(B);
    const r1 = correrScript('rellenar-lineas-estructuradas.mjs', ['--negocio', A, '--aplicar', '--json']);
    assert.equal(r1.codigo, 0, r1.salida.slice(-800));
    assert.ok(jsonDe(r1.salida).negocios[0].escritos >= 1);
    assert.equal(porFolio(await lineasDe([fol('A4')]), fol('A4')).estado, 'completa');
    const r2 = correrScript('rellenar-lineas-estructuradas.mjs', ['--negocio', A, '--aplicar', '--json']);
    assert.equal(r2.codigo, 0, r2.salida.slice(-800));
    assert.equal(jsonDe(r2.salida).negocios[0].escritos, 0);
    assert.equal(await cuentaRegistro(B), antesB);
    assert.equal(await huellaVentas(), HUELLA_VENTAS);
  });
  await t('S3 argumentos malos: sale con error sin tocar nada', async () => {
    assert.equal(correrScript('rellenar-lineas-estructuradas.mjs', []).codigo, 1);
    assert.equal(correrScript('rellenar-lineas-estructuradas.mjs', ['--negocio', A, '--desde', 'ayer']).codigo, 1);
    assert.equal(correrScript('rellenar-lineas-estructuradas.mjs', ['--negocio', 'no-existe']).codigo, 1);
  });

  console.log('\nT — marca inicial de tipos');
  await q(`UPDATE menu_productos SET tipo = 'otro' WHERE id = $1`, [M.fruta]); // marcado a mano antes
  const tipos = async (ids) => Object.fromEntries((await q('SELECT id, tipo FROM menu_productos WHERE id = ANY($1)', [ids])).rows.map((r) => [r.id, r.tipo]));
  const MIS = [M.envio60, M.extra20, M.tortillas, M.queso, M.fruta, M.agua, M.tacos, M.chil, M.envio60B, M.extra20B];
  await t('T1 el modo de prueba lista lo propuesto y no cambia nada', async () => {
    const antes = await tipos(MIS);
    const r = correrScript('marcar-tipo-producto.mjs', ['--negocio', A]);
    assert.equal(r.codigo, 0, r.salida.slice(-800));
    assert.match(r.salida, new RegExp(`#${M.envio60}\\s+ENVIO 60`));
    assert.match(r.salida, new RegExp(`#${M.queso}\\s+${TAG} EXTRA QUESO`), 'lo no marcado de EXTRAS se lista');
    assert.deepEqual(await tipos(MIS), antes);
  });
  await t('T2 --aplicar marca según las reglas, respeta lo marcado a mano y no toca B', async () => {
    const r = correrScript('marcar-tipo-producto.mjs', ['--negocio', A, '--aplicar']);
    assert.equal(r.codigo, 0, r.salida.slice(-800));
    const d = await tipos(MIS);
    assert.deepEqual([d[M.envio60], d[M.extra20], d[M.tortillas], d[M.agua]], ['envio', 'extra', 'extra', 'bebida']);
    assert.deepEqual([d[M.queso], d[M.tacos], d[M.chil], d[M.fruta]], ['platillo', 'platillo', 'platillo', 'otro']);
    assert.deepEqual([d[M.envio60B], d[M.extra20B]], ['platillo', 'platillo']);
  });
  await t('T3 la segunda corrida no tiene nada que marcar', async () => {
    const r = correrScript('marcar-tipo-producto.mjs', ['--negocio', A, '--aplicar']);
    assert.equal(r.codigo, 0, r.salida.slice(-800));
    assert.match(r.salida, /Nada que marcar/);
  });
  await t('T4 el registro toma el tipo de hoy: la venta vieja de ENVIO 60 pasa a «envío»', async () => {
    assert.equal(porFolio(await lineasDe([fol('A6')]), fol('A6')).tipo, 'platillo', 'antes de sincronizar');
    const r = await proceso.procesarNegociosConBandera();
    assert.ok(r.tipos >= 1);
    assert.equal(porFolio(await lineasDe([fol('A6')]), fol('A6')).tipo, 'envio');
    assert.ok((await lineasDe(FOLIOS_B)).every((l) => l.tipo === 'platillo'), 'B no cambia');
  });

  console.log('\nE — el envío como cargo');
  await t('E1 sin la bandera, el envío entra como antes (POS, tienda, mostrador)', async () => {
    const r = await recalcularItemsDesdeMenu(A, [{ producto_id: M.envio60, cantidad: 1 }]);
    assert.equal(r.items[0].producto_id, M.envio60);
    await rechazarEnvioComoProducto(A, [{ producto_id: M.envio60 }]);
    assert.ok((await catalogoPublico(A)).some((c) => c.productos.some((p) => p.id === M.envio60)));
  });
  await t('E2 con la bandera, POS y tienda lo rechazan con un mensaje que dice dónde cobrarlo', async () => {
    await fijar(A, 'envio_solo_como_cargo', 'true');
    for (const canal of ['pos', 'tienda_online']) {
      await rechaza(recalcularItemsDesdeMenu(A, [{ producto_id: M.envio60, cantidad: 1 }], { canal }), (e) => {
        assert.ok(e instanceof POSValidacionError);
        assert.equal(e.codigo, 'ENVIO_COMO_PRODUCTO');
        assert.match(e.message, /campo de envío/);
      });
    }
    const ok = await recalcularItemsDesdeMenu(A, [{ producto_id: M.chil, cantidad: 1 }]);
    assert.equal(ok.items.length, 1, 'lo demás sigue entrando');
  });
  await t('E3 con la bandera, el mostrador lo frena; el `id` de la línea no confunde', async () => {
    await rechaza(rechazarEnvioComoProducto(A, [{ producto_id: M.chil }, { producto_id: String(M.envio60) }]),
      (e) => assert.ok(e instanceof EnvioComoProductoError));
    await rechazarEnvioComoProducto(A, [{ id: M.envio60, producto: 'Algo libre' }]);
    await rechazarEnvioComoProducto(A, [{ producto_id: M.envio60B }]); // de B: no es de este menú
  });
  await t('E4 con la bandera, la tienda no lo ofrece; B sigue igual', async () => {
    assert.ok(!(await catalogoPublico(A)).some((c) => c.productos.some((p) => p.id === M.envio60)));
    assert.ok((await catalogoPublico(A)).some((c) => c.productos.some((p) => p.id === M.chil)));
    const r = await recalcularItemsDesdeMenu(B, [{ producto_id: M.envio60B, cantidad: 1 }]);
    assert.equal(r.items.length, 1, 'B no tiene la bandera');
  });

  console.log('\nH — por HTTP');
  const { arrancarServidor } = await import('./lib-servidor.mjs');
  const { crearTokenSesion } = await import('../src/services/session.js');
  const cookie = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: USUARIO, negocioId: A, rol: 'admin' }))}`;
  let srv = null;
  try { srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 45000 }); }
  catch (e) { fallidas++; console.log(`FALLO H0 el servidor no arrancó: ${e.message.split('\n')[0]}`); }
  if (srv) {
    const http = async (metodo, ruta, cuerpo) => {
      const r = await fetch(srv.base + ruta, { method: metodo, headers: { 'content-type': 'application/json', cookie },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const tieneEnvio = (menu) => menu.some((c) => (c.productos || []).some((p) => p.id === M.envio60));
    try {
      await t('H1 /api/menu: con la bandera no trae el envío; sin ella, sí', async () => {
        await fijar(A, 'envio_solo_como_cargo', 'true');
        let r = await http('GET', '/api/menu');
        assert.equal(r.status, 200);
        assert.ok(!tieneEnvio(r.body));
        assert.ok(r.body.some((c) => (c.productos || []).some((p) => p.id === M.chil)));
        await fijar(A, 'envio_solo_como_cargo', 'false');
        r = await http('GET', '/api/menu');
        assert.ok(tieneEnvio(r.body));
      });
      await t('H2 /api/pedido-presencial: con la bandera, el envío como producto da 400 y no crea pedido', async () => {
        await fijar(A, 'envio_solo_como_cargo', 'true');
        const antes = (await uno('SELECT count(*)::int AS n FROM pedidos_activos WHERE negocio_id = $1', [A])).n;
        const r = await http('POST', '/api/pedido-presencial', { items: [{ producto_id: M.envio60, cantidad: 1 }], nombre: 'Prueba', total: 60 });
        assert.deepEqual([r.status, r.body?.codigo], [400, 'ENVIO_COMO_PRODUCTO'], JSON.stringify(r.body));
        assert.equal((await uno('SELECT count(*)::int AS n FROM pedidos_activos WHERE negocio_id = $1', [A])).n, antes);
        await fijar(A, 'envio_solo_como_cargo', 'false');
      });
      await t('H3 el editor del menú guarda el tipo y rechaza uno inválido con 400', async () => {
        let r = await http('PATCH', `/api/admin/menu/productos/${M.queso}`, { tipo: 'extra' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal((await uno('SELECT tipo FROM menu_productos WHERE id = $1', [M.queso])).tipo, 'extra');
        r = await http('PATCH', `/api/admin/menu/productos/${M.queso}`, { tipo: 'postre' });
        assert.deepEqual([r.status, r.body?.error], [400, 'Tipo de producto inválido']);
        r = await http('POST', '/api/admin/menu/productos', { categoria_id: M.catExt, nombre: `${TAG} Malo`, precio: 1, tipo: 'postre' });
        assert.equal(r.status, 400);
        r = await http('GET', '/api/admin/menu');
        const p = r.body.flatMap((c) => c.productos || []).find((x) => x.id === M.queso);
        assert.equal(p?.tipo, 'extra', 'el editor recibe el tipo (si no, guardar lo regresaría a platillo)');
      });
    } finally {
      srv.detener();
    }
  }
}

for (const neg of [A, B]) {
  await fijar(neg, 'lineas_estructuradas', 'false').catch(() => {});
  await fijar(neg, 'envio_solo_como_cargo', 'false').catch(() => {});
}
await pool.end().catch(() => {});
console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
process.exit(fallidas ? 1 : 0);
