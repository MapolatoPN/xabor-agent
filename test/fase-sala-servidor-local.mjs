// EL EDGE ATENDIENDO A LA SALA POR LA RED LOCAL.
//
// Se prueba por HTTP real contra un puerto efímero: es el camino exacto que
// harán las computadoras de meseros y la caja cuando la nube no responda.
//
// Lo que protege, por orden de importancia:
//   1. Que el `pin_hash` NUNCA salga en una respuesta. La foto del catálogo lo
//      tiene para poder validar sin enlace; si además lo publicara, cualquiera
//      en la red del local se llevaría las credenciales de los meseros.
//   2. Que sin PIN no se pueda abrir una mesa ni cobrar.
//   3. Que un error de negocio llegue con el MISMO código que da la nube, para
//      que el panel no necesite dos formas de reaccionar.
//   4. Que nada se confirme sin haberse guardado en disco.
//
// Uso: node test/fase-sala-servidor-local.mjs
import assert from 'assert';
import { randomUUID } from 'node:crypto';

const { crearSalaLocal } = await import('../edge/sala/operacionLocal.js');
const { crearServidorLocal } = await import('../edge/sala/servidorLocal.js');
const { hashPin } = await import('../src/services/password.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const MESERO = randomUUID();
const PIN = '2468';
const catalogo = {
  version: 1, negocioId: randomUUID(), generadoAt: new Date().toISOString(),
  numMesas: 5, metodosPago: ['efectivo', 'terminal'],
  meseros: [{ id: MESERO, nombre: 'Ana Mesera', rol: 'mesero', pin_hash: hashPin(PIN) }],
  menu: [{ id: 1, nombre: 'FUERTES', orden: 0, productos: [
    { id: 10, nombre: 'Chilaquiles', precio: 195, categoria_id: 1, modificadores: [] }] }],
};

let guardados = 0, fallaPersistencia = false;
const sala = crearSalaLocal({ uuid: randomUUID, ahora: () => new Date() });
const servidor = crearServidorLocal({
  sala,
  obtenerCatalogo: () => catalogo,
  alCambiar: async () => {
    if (fallaPersistencia) throw new Error('disco lleno');
    guardados += 1;
  },
  puerto: 0, host: '127.0.0.1',
});
const puerto = await servidor.iniciar();
const base = `http://127.0.0.1:${puerto}`;

async function pedir(metodo, ruta, { cuerpo, token } = {}) {
  const r = await fetch(base + ruta, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    // `fetch` rechaza un GET con cuerpo; los casos que barren varias rutas
    // pasan el mismo objeto a todas.
    body: cuerpo && metodo !== 'GET' ? JSON.stringify(cuerpo) : undefined,
  });
  const texto = await r.text();
  let json = null;
  try { json = texto ? JSON.parse(texto) : null; } catch { /* se reporta abajo */ }
  return { estado: r.status, cuerpo: json, crudo: texto, cabeceras: r.headers };
}

// ═══ A. Descubrimiento y sesión ════════════════════════════════════════════
await t('A1. /local/salud responde SIN sesión: el panel debe poder descubrirlo', async () => {
  const r = await pedir('GET', '/local/salud');
  assert.strictEqual(r.estado, 200);
  assert.strictEqual(r.cuerpo.ok, true);
  assert.strictEqual(r.cuerpo.numMesas, 5);
  assert.strictEqual(r.cuerpo.negocioId, catalogo.negocioId, 'el panel comprueba que es SU negocio');
});

let token = null;
await t('A2. con el PIN correcto se abre sesión', async () => {
  const r = await pedir('POST', '/local/sesion', { cuerpo: { meseroId: MESERO, pin: PIN } });
  assert.strictEqual(r.estado, 200, r.crudo);
  assert.ok(r.cuerpo.token);
  assert.strictEqual(r.cuerpo.mesero.nombre, 'Ana Mesera');
  token = r.cuerpo.token;
});

await t('A3. un PIN equivocado y un mesero inexistente se ven IGUAL', async () => {
  const malo = await pedir('POST', '/local/sesion', { cuerpo: { meseroId: MESERO, pin: '9999' } });
  const fantasma = await pedir('POST', '/local/sesion', { cuerpo: { meseroId: randomUUID(), pin: PIN } });
  assert.strictEqual(malo.estado, 401);
  assert.strictEqual(fantasma.estado, 401);
  assert.deepStrictEqual(malo.cuerpo, fantasma.cuerpo,
    'distinguirlos le diría a un extraño qué ids de mesero existen');
});

await t('A4. sin sesión no se abre una mesa ni se cobra', async () => {
  for (const [m, ruta] of [['GET', '/local/mesas'], ['POST', '/local/mesas/abrir'],
    ['POST', '/local/cuentas/x/pagos'], ['POST', '/local/cuentas/x/cerrar']]) {
    const r = await pedir(m, ruta, { cuerpo: {} });
    assert.strictEqual(r.estado, 401, `${m} ${ruta} quedó abierto`);
    assert.strictEqual(r.cuerpo.codigo, 'SESION_REQUERIDA');
  }
  const inventado = await pedir('GET', '/local/mesas', { token: 'token-inventado' });
  assert.strictEqual(inventado.estado, 401, 'un token que nadie emitió no vale');
});

// ═══ B. El secreto que no puede salir ══════════════════════════════════════
await t('B1. el pin_hash NO aparece en NINGUNA respuesta', async () => {
  const rutas = [
    await pedir('GET', '/local/salud'),
    await pedir('GET', '/local/catalogo', { token }),
    await pedir('POST', '/local/sesion', { cuerpo: { meseroId: MESERO, pin: PIN } }),
  ];
  for (const r of rutas) {
    assert.ok(!r.crudo.includes('pin_hash'), `una respuesta filtró el campo: ${r.crudo.slice(0, 120)}`);
    assert.ok(!r.crudo.includes(catalogo.meseros[0].pin_hash.slice(0, 20)),
      'ni el valor del hash por otro nombre');
  }
});

await t('B2. el catálogo sí trae lo necesario para capturar', async () => {
  const r = await pedir('GET', '/local/catalogo', { token });
  assert.strictEqual(r.estado, 200);
  assert.strictEqual(r.cuerpo.menu[0].productos[0].nombre, 'Chilaquiles');
  assert.deepStrictEqual(r.cuerpo.meseros, [{ id: MESERO, nombre: 'Ana Mesera', rol: 'mesero' }]);
});

// ═══ C. Una mesa completa, toda por HTTP y sin nube ════════════════════════
let cuentaId = null;
await t('C1. abrir mesa, capturar, comandar, cobrar y cerrar', async () => {
  const abierta = await pedir('POST', '/local/mesas/abrir', { token, cuerpo: { mesa: 3, personas: 2 } });
  assert.strictEqual(abierta.estado, 201, abierta.crudo);
  cuentaId = abierta.cuerpo.cuenta.id;
  assert.strictEqual(abierta.cuerpo.cuenta.mesero.nombre, 'Ana Mesera', 'la cuenta queda a nombre de quien tiene la sesión');

  const items = await pedir('POST', `/local/cuentas/${cuentaId}/items`, {
    token, cuerpo: { items: [{ producto: 'Chilaquiles', precio_unitario: 195, cantidad: 2 }] } });
  assert.strictEqual(items.estado, 200, items.crudo);
  assert.strictEqual(items.cuerpo.cuenta.total, 390);

  const comanda = await pedir('POST', `/local/cuentas/${cuentaId}/comanda`, { token });
  assert.strictEqual(comanda.cuerpo.comanda.comanda, 1);
  assert.strictEqual(comanda.cuerpo.comanda.items.length, 1, 'solo lo de esta ronda va a cocina');

  const pago = await pedir('POST', `/local/cuentas/${cuentaId}/pagos`, {
    token, cuerpo: { metodo: 'efectivo', monto: 390, propina: 40 } });
  assert.strictEqual(pago.cuerpo.cuenta.saldo, 0);

  const cerrada = await pedir('POST', `/local/cuentas/${cuentaId}/cerrar`, { token });
  assert.strictEqual(cerrada.estado, 200, cerrada.crudo);
  assert.match(cerrada.cuerpo.ventaFolio, /^RM-[0-9A-F]{8}-0$/, 'el ticket ya lleva folio definitivo');
});

await t('C2. el tablero muestra lo que hay abierto', async () => {
  await pedir('POST', '/local/mesas/abrir', { token, cuerpo: { mesa: 1, personas: 4 } });
  const r = await pedir('GET', '/local/mesas', { token });
  assert.strictEqual(r.estado, 200);
  assert.deepStrictEqual(r.cuerpo.ocupadas.map((m) => m.mesa), [1], 'la 3 ya se cobró y quedó libre');
  assert.strictEqual(r.cuerpo.numMesas, 5);
});

// ═══ D. Los errores llegan como los de la nube ═════════════════════════════
await t('D1. cada error de negocio trae su código y su HTTP', async () => {
  const ocupada = await pedir('POST', '/local/mesas/abrir', { token, cuerpo: { mesa: 1, personas: 2 } });
  assert.strictEqual(ocupada.estado, 409);
  assert.strictEqual(ocupada.cuerpo.codigo, 'MESA_OCUPADA');

  const mala = await pedir('POST', '/local/mesas/abrir', { token, cuerpo: { mesa: 999 } });
  assert.strictEqual(mala.estado, 400);
  assert.strictEqual(mala.cuerpo.codigo, 'MESA_INVALIDA');

  const fantasma = await pedir('GET', '/local/cuentas/no-existe', { token });
  assert.strictEqual(fantasma.estado, 404);
  assert.strictEqual(fantasma.cuerpo.codigo, 'CUENTA_NO_ENCONTRADA');

  const abierta = await pedir('GET', '/local/mesas', { token });
  const viva = abierta.cuerpo.ocupadas[0].id;
  await pedir('POST', `/local/cuentas/${viva}/items`, {
    token, cuerpo: { items: [{ producto: 'Chilaquiles', precio_unitario: 195 }] } });
  const saldo = await pedir('POST', `/local/cuentas/${viva}/cerrar`, { token });
  assert.strictEqual(saldo.estado, 409);
  assert.strictEqual(saldo.cuerpo.codigo, 'SALDO_PENDIENTE');
});

await t('D2. un JSON roto no tumba el servidor', async () => {
  const r = await fetch(`${base}/local/mesas/abrir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: '{esto no es json',
  });
  assert.strictEqual(r.status, 400);
  const sigue = await pedir('GET', '/local/salud');
  assert.strictEqual(sigue.estado, 200, 'y el Edge sigue atendiendo');
});

// ═══ E. Nada se confirma sin haberse guardado ══════════════════════════════
await t('E1. cada mutación persiste antes de responder', async () => {
  const antes = guardados;
  await pedir('POST', '/local/mesas/abrir', { token, cuerpo: { mesa: 2, personas: 1 } });
  assert.strictEqual(guardados, antes + 1, 'abrir mesa tiene que haber tocado el disco');
});

await t('E2. si el disco falla, NO se responde ok', async () => {
  fallaPersistencia = true;
  const r = await pedir('POST', '/local/mesas/abrir', { token, cuerpo: { mesa: 4, personas: 1 } });
  fallaPersistencia = false;
  assert.strictEqual(r.estado, 500, 'confirmar algo que no se guardó es mentirle a la cajera');
  assert.ok(!r.crudo.includes('disco lleno'), 'y el detalle interno no se le cuenta al cliente');
});

// ═══ F. El navegador tiene que poder llamarlo ══════════════════════════════
await t('F1. responde CORS: el panel se sirvió desde la nube y llama a esta IP', async () => {
  const r = await pedir('GET', '/local/salud');
  assert.strictEqual(r.cabeceras.get('access-control-allow-origin'), '*');
  const previo = await fetch(`${base}/local/mesas`, { method: 'OPTIONS' });
  assert.strictEqual(previo.status, 204, 'el preflight debe pasar');
});

// ═══ G. El Edge sirve el panel: sin esto, tres de las cuatro estaciones no
//        pueden operar durante un corte ═════════════════════════════════════
// Una página https NO puede hacer fetch a http (contenido mixto), y no hay
// forma de pedir permiso desde el código. Solo `localhost` se salva. Si el
// panel se abre DESDE el Edge, todo es del mismo origen y el problema
// desaparece -- por eso esto no es un extra.
await t('G1. sirve el panel en / y en /app', async () => {
  for (const ruta of ['/', '/app']) {
    const r = await fetch(base + ruta);
    assert.strictEqual(r.status, 200, ruta);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    const html = await r.text();
    assert.ok(html.includes('<script'), `${ruta} debe entregar el panel de verdad`);
  }
});

await t('G2. sirve los archivos que el panel necesita, con su tipo', async () => {
  const r = await fetch(`${base}/offline-sala.js`);
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /javascript/);
  assert.ok((await r.text()).includes('candidatosDeEdge'));
});

await t('G3. no se puede salir de la carpeta del panel', async () => {
  // Esta PC guarda el token de la terminal y las ventas del día: nadie en la
  // red del local puede pedirle un archivo de fuera.
  for (const intento of ['/../edge/config.js', '/..%2f..%2fpackage.json', '/../../dev-local.env.cmd']) {
    const r = await fetch(base + intento);
    assert.ok(r.status === 403 || r.status === 404, `${intento} devolvió ${r.status}`);
    const cuerpo = await r.text();
    assert.ok(!cuerpo.includes('DATABASE_URL'), 'jamás debe salir un archivo de configuración');
  }
});

await t('G4. servir el panel NO tapa la API local', async () => {
  const r = await pedir('GET', '/local/salud');
  assert.strictEqual(r.estado, 200);
  assert.strictEqual(r.cuerpo.ok, true, '/local/* sigue siendo API, no un archivo');
  const inventada = await fetch(`${base}/local/no-existe`);
  assert.strictEqual(inventada.status, 404);
});

await servidor.detener();
console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exitCode = fallidas > 0 ? 1 : 0;
