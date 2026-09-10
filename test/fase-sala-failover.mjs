// EL FAILOVER DE SALA, Y SU CONTRATO CON LA NUBE.
//
// La prueba que de verdad importa aquí es la de CONTRATO: que lo que el panel
// recibe del Edge tenga la MISMA forma que lo que recibe de la nube. Si esas
// dos formas divergen, el panel se rompe justo durante el corte de internet,
// que es el peor momento posible para depurar nada.
//
// Por eso no se comparan contra una forma escrita a mano: se levanta la nube
// de verdad (`listarMesas`, `obtenerCuenta` sobre Postgres) y el Edge de verdad
// (el motor local), se pasan por el adaptador y se comparan las claves.
//
// Uso: DATABASE_URL=... node test/fase-sala-failover.mjs
import assert from 'assert';
import { randomUUID } from 'node:crypto';

const { pool } = await import('../src/services/database.js');
const { listarMesas, abrirMesa, obtenerCuenta, agregarItems } = await import('../src/services/restauranteService.js');
const { crearSalaLocal } = await import('../edge/sala/operacionLocal.js');
const { traducirRuta, adaptarMesas, adaptarCuenta, descubrirEdge, crearClienteOffline, respuestaSimulada } =
  await import('../panel/offline-sala.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ── Fixture de nube ─────────────────────────────────────────────────────────
const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const NEG = (await q1(`INSERT INTO negocios (nombre, slug) VALUES ('Failover Sala','failover-sala')
   ON CONFLICT (slug) DO UPDATE SET nombre='Failover Sala' RETURNING id`)).id;
await pool.query(`DELETE FROM restaurante_cuenta_pagos WHERE negocio_id=$1`, [NEG]).catch(() => {});
await pool.query(`DELETE FROM restaurante_cuenta_items WHERE negocio_id=$1`, [NEG]).catch(() => {});
await pool.query(`DELETE FROM restaurante_cuentas WHERE negocio_id=$1`, [NEG]).catch(() => {});
await pool.query(`DELETE FROM usuario_negocios WHERE negocio_id=$1`, [NEG]).catch(() => {});
await pool.query(`DELETE FROM usuarios WHERE negocio_id=$1`, [NEG]).catch(() => {});
const MESERO = (await q1(`INSERT INTO usuarios (negocio_id,nombre,activo,pin_hash)
   VALUES ($1,'Ana Mesera',true,'salt:x') RETURNING id`, [NEG])).id;
await pool.query(`INSERT INTO usuario_negocios (usuario_id,negocio_id,rol,activo) VALUES ($1,$2,'mesero',true)
   ON CONFLICT DO NOTHING`, [MESERO, NEG]);
await pool.query(`INSERT INTO configuracion (negocio_id,clave,valor) VALUES ($1,'restaurante_num_mesas','5')
   ON CONFLICT (negocio_id,clave) DO UPDATE SET valor='5'`, [NEG]);

// ═══ A. Contrato: la misma forma con nube y sin ella ═══════════════════════
const claves = (o) => Object.keys(o).sort();

await t('A1. el tablero adaptado tiene las MISMAS claves que el de la nube', async () => {
  // Nube: una mesa ocupada con un item pendiente.
  const cta = await abrirMesa(NEG, { mesaNumero: 2, personas: 3, meseroUsuarioId: MESERO, abiertaPor: MESERO });
  await agregarItems(cta.id, NEG, [{ producto: 'Chilaquiles', cantidad: 1, precio_unitario: 195 }], MESERO);
  const deNube = await listarMesas(NEG);

  // Edge: la misma situación.
  const sala = crearSalaLocal({ uuid: randomUUID, ahora: () => new Date() });
  const local = sala.abrirMesa({ mesaNumero: 2, personas: 3, meseroUsuarioId: MESERO, meseroNombre: 'Ana Mesera' });
  sala.agregarItems(local.id, [{ producto: 'Chilaquiles', cantidad: 1, precio_unitario: 195 }]);
  const deEdge = adaptarMesas({ numMesas: 5, ocupadas: sala.listarMesasOcupadas() });

  assert.deepStrictEqual(claves(deEdge), claves(deNube), 'el objeto de nivel superior');
  assert.strictEqual(deEdge.numMesas, deNube.numMesas);
  assert.strictEqual(deEdge.mesas.length, deNube.mesas.length, 'la nube devuelve TODAS las mesas, no solo las ocupadas');

  const ocupadaNube = deNube.mesas.find((m) => m.ocupada);
  const ocupadaEdge = deEdge.mesas.find((m) => m.ocupada);
  assert.deepStrictEqual(claves(ocupadaEdge), claves(ocupadaNube),
    `una mesa ocupada debe traer lo mismo. nube=${claves(ocupadaNube)} edge=${claves(ocupadaEdge)}`);
  assert.strictEqual(ocupadaEdge.pendientes, ocupadaNube.pendientes, 'los pendientes son lo que pinta el aviso de comanda');
  assert.strictEqual(ocupadaEdge.total, ocupadaNube.total);
  assert.strictEqual(ocupadaEdge.saldo, ocupadaNube.saldo);
  assert.strictEqual(ocupadaEdge.mesero, ocupadaNube.mesero);

  const libreNube = deNube.mesas.find((m) => !m.ocupada);
  const libreEdge = deEdge.mesas.find((m) => !m.ocupada);
  assert.deepStrictEqual(claves(libreEdge), claves(libreNube), 'y una mesa libre también');
});

await t('A2. la cuenta adaptada tiene las MISMAS claves que la de la nube', async () => {
  const { rows: [abierta] } = await pool.query(
    `SELECT id FROM restaurante_cuentas WHERE negocio_id=$1 AND estado='abierta' LIMIT 1`, [NEG]);
  const deNube = await obtenerCuenta(abierta.id, NEG);

  const sala = crearSalaLocal({ uuid: randomUUID, ahora: () => new Date() });
  const local = sala.abrirMesa({ mesaNumero: 2, personas: 3, meseroUsuarioId: MESERO, meseroNombre: 'Ana Mesera' });
  sala.agregarItems(local.id, [{ producto: 'Chilaquiles', cantidad: 1, precio_unitario: 195 }]);
  const deEdge = adaptarCuenta(sala.obtenerCuenta(local.id));

  const faltan = claves(deNube).filter((k) => !claves(deEdge).includes(k));
  assert.deepStrictEqual(faltan, [],
    `al panel le faltarían campos que sí usa con enlace: ${faltan.join(', ')}`);
  assert.deepStrictEqual(claves(deEdge.mesero), claves(deNube.mesero));
  assert.strictEqual(typeof deEdge.total, typeof deNube.total);
  assert.strictEqual(deEdge.sinConexion, true, 'y queda marcada como nacida sin enlace');
});

// ═══ B. Traducción de rutas ════════════════════════════════════════════════
await t('B1. las rutas de sala se traducen; el resto NO', async () => {
  assert.strictEqual(traducirRuta('/api/restaurante/mesas', 'GET').local, '/local/mesas');
  assert.strictEqual(traducirRuta('/api/restaurante/mesas/abrir', 'POST').local, '/local/mesas/abrir');
  assert.strictEqual(traducirRuta('/api/restaurante/cuentas/abc-123', 'GET').local, '/local/cuentas/abc-123');
  assert.strictEqual(traducirRuta('/api/restaurante/cuentas/abc/items', 'POST').local, '/local/cuentas/abc/items');
  assert.strictEqual(traducirRuta('/api/restaurante/cuentas/abc/comanda', 'POST').local, '/local/cuentas/abc/comanda');
  assert.strictEqual(traducirRuta('/api/restaurante/cuentas/abc/items/i9/cancelar', 'POST').local,
    '/local/cuentas/abc/items/i9/cancelar');
  assert.strictEqual(traducirRuta('/api/restaurante/cuentas/abc/pagos', 'POST').local, '/local/cuentas/abc/pagos');
  assert.strictEqual(traducirRuta('/api/restaurante/cuentas/abc/cerrar', 'POST').local, '/local/cuentas/abc/cerrar');
});

await t('B2. lo que NO tiene equivalente local devuelve null y debe fallar', () => {
  for (const [u, m] of [
    ['/api/ventas', 'GET'], ['/api/config/operativa', 'GET'],
    ['/api/admin/menu/productos', 'POST'], ['/api/restaurante/meseros', 'GET'],
    ['/api/restaurante/cuentas/abc/dividir', 'GET'],
    ['/api/restaurante/mesas', 'DELETE'],
  ]) {
    assert.strictEqual(traducirRuta(u, m), null,
      `${m} ${u} no puede resolverse en local: es preferible decir "sin conexión" a fingir`);
  }
});

// ═══ C. Descubrimiento: solo un Edge de MI negocio ═════════════════════════
const fetchFalso = (respuestas) => async (url) => {
  const r = respuestas[String(url)];
  if (!r) throw new TypeError('Failed to fetch');
  return { ok: r.ok !== false, json: async () => r.cuerpo };
};

await t('C1. se acepta el Edge que declara MI negocio', async () => {
  const found = await descubrirEdge(['http://x:7071'], {
    negocioId: 'neg-1',
    fetchImpl: fetchFalso({ 'http://x:7071/local/salud': { cuerpo: { ok: true, negocioId: 'neg-1', numMesas: 5 } } }),
  });
  assert.ok(found);
  assert.strictEqual(found.base, 'http://x:7071');
});

await t('C2. un Edge de OTRO negocio se rechaza (wifi compartido)', async () => {
  const found = await descubrirEdge(['http://x:7071'], {
    negocioId: 'neg-1',
    fetchImpl: fetchFalso({ 'http://x:7071/local/salud': { cuerpo: { ok: true, negocioId: 'neg-2' } } }),
  });
  assert.strictEqual(found, null, 'operar en la sala del vecino sería peor que no operar');
});

await t('C3. sin negocio esperado NO se acepta ningún Edge', async () => {
  const found = await descubrirEdge(['http://x:7071'], {
    negocioId: null,
    fetchImpl: fetchFalso({ 'http://x:7071/local/salud': { cuerpo: { ok: true, negocioId: 'neg-1' } } }),
  });
  assert.strictEqual(found, null);
});

await t('C4. si ningún candidato responde, no hay Edge y no se rompe nada', async () => {
  const found = await descubrirEdge(['http://a:7071', 'http://b:7071'], {
    negocioId: 'neg-1', fetchImpl: fetchFalso({}),
  });
  assert.strictEqual(found, null);
});

// ═══ D. El cliente se comporta como un Response ════════════════════════════
await t('D1. `llamar` devuelve algo que el panel puede tratar como respuesta', async () => {
  const cliente = crearClienteOffline({
    base: 'http://x:7071', token: 'tk',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ numMesas: 2, ocupadas: [] }) }),
  });
  const r = await cliente.llamar('/api/restaurante/mesas', { method: 'GET' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.desdeEdge, true, 'la interfaz puede avisar que esto vino del Edge');
  const d = await r.json();
  assert.strictEqual(d.mesas.length, 2, 'y ya viene adaptado a la forma de la nube');
});

await t('D2. una ruta sin equivalente devuelve null: el panel la deja fallar', async () => {
  const cliente = crearClienteOffline({ base: 'http://x:7071', fetchImpl: async () => { throw new Error('no debería llamarse'); } });
  assert.strictEqual(await cliente.llamar('/api/ventas', { method: 'GET' }), null);
});

await t('D3. un error del Edge llega con su código, sin adaptar', async () => {
  const cliente = crearClienteOffline({
    base: 'http://x:7071', token: 'tk',
    fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ error: 'ocupada', codigo: 'MESA_OCUPADA' }) }),
  });
  const r = await cliente.llamar('/api/restaurante/mesas/abrir', { method: 'POST', body: '{}' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual((await r.json()).codigo, 'MESA_OCUPADA', 'el panel ya sabe reaccionar a este código');
});

await t('D4. la respuesta simulada se puede clonar, como hace apiFetch', async () => {
  const r = respuestaSimulada(200, { a: 1 });
  const c = r.clone();
  assert.deepStrictEqual(await c.json(), { a: 1 });
  assert.deepStrictEqual(await r.json(), { a: 1 }, 'clonar no consume el cuerpo');
});

// ═══ E. La regla del navegador que decide la arquitectura ═════════════════
// Una página https no puede hacer fetch a http: se bloquea como contenido
// mixto, sin excepción posible por código. Solo localhost se salva. Si esto
// se ignora, el modo offline funciona en la caja y en ninguna otra estación.
const { candidatosDeEdge, bloqueadoPorNavegador, PUERTO_EDGE } = await import('../panel/offline-sala.js');

await t('E1. desde https NO se ofrece una IP de la LAN: el navegador la bloquearía', () => {
  const c = candidatosDeEdge({
    guardado: 'http://192.168.1.50:7071', host: '192.168.1.50',
    origen: 'https://xabor.mx', protocolo: 'https:',
  });
  assert.ok(!c.some((u) => u.includes('192.168.1.50')),
    'intentarlo solo gasta tiempo: el fetch nunca sale del navegador');
  assert.ok(c.includes(`http://localhost:${PUERTO_EDGE}`), 'localhost sí es origen seguro');
  assert.strictEqual(c[0], 'https://xabor.mx', 'el propio origen va primero');
});

await t('E2. desde el panel servido por el Edge, la LAN sí vale', () => {
  const c = candidatosDeEdge({
    guardado: 'http://192.168.1.50:7071', host: '192.168.1.50',
    origen: 'http://192.168.1.50:7071', protocolo: 'http:',
  });
  assert.strictEqual(c[0], 'http://192.168.1.50:7071',
    'abierto desde el Edge, todo es del mismo origen y no hay contenido mixto');
});

await t('E3. se detecta el bloqueo para poder DECIR a dónde ir', () => {
  // Un fetch bloqueado rechaza igual que uno que no encontró a nadie, así que
  // el bloqueo se deduce; si no, la estación se queda con un "sin conexión"
  // sin salida teniendo el Edge a dos metros.
  assert.strictEqual(
    bloqueadoPorNavegador({ guardado: 'http://192.168.1.50:7071', protocolo: 'https:' }),
    'http://192.168.1.50:7071');
  assert.strictEqual(bloqueadoPorNavegador({ guardado: 'http://localhost:7071', protocolo: 'https:' }), null,
    'localhost no está bloqueado');
  assert.strictEqual(bloqueadoPorNavegador({ guardado: 'http://192.168.1.50:7071', protocolo: 'http:' }), null,
    'desde http no hay contenido mixto');
  assert.strictEqual(bloqueadoPorNavegador({ guardado: null, protocolo: 'https:' }), null,
    'sin un Edge conocido no hay nada que avisar');
});

await pool.query(`DELETE FROM restaurante_cuenta_items WHERE negocio_id=$1`, [NEG]).catch(() => {});
await pool.query(`DELETE FROM restaurante_cuentas WHERE negocio_id=$1`, [NEG]).catch(() => {});
console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
