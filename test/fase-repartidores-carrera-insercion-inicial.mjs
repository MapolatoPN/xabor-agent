// Segunda corrección de la carrera de asignación de repartidores: cierra
// la ventana residual que quedaba tras el primer fix (ON CONFLICT (folio)
// DO NOTHING en guardarPedidoActivo). Esa primera corrección evitaba que
// una escritura tardía BORRARA una asignación ya hecha, pero no evitaba
// que asignarRepartidor() corriera ANTES de que la fila inicial siquiera
// existiera -- en ese caso su UPDATE condicionado afecta cero filas y
// rechaza una aceptación legítima como si el pedido no existiera.
//
// registrarPedido() (orderManager.js) ahora es async y espera (await) su
// propia persistencia inicial en pedidos_activos antes de devolver el
// pedido -- todo lo que depende de ese valor de retorno (ofrecer el
// pedido a repartidores, generar tokens, emitir WebSocket, confirmar al
// cliente) queda así estrictamente después de que la fila existe.
//
// Esta prueba NO depende de que la corrida "tenga suerte" con el timing:
// intercepta pool.query para retener deliberadamente el INSERT inicial
// hasta que el propio test decide liberarlo, y usa espera por evento
// (polling de una bandera) en vez de sleeps de duración fija.
//
// Uso: DATABASE_URL=... INTEGRATIONS_ENCRYPTION_KEY=... node test/fase-repartidores-carrera-insercion-inicial.mjs
// Requiere aplicar-migraciones.mjs y seed-datos-prueba.mjs ya corridos.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));

const { pool, registrarRepartidor, asignarRepartidor } = await import('../src/services/database.js');
const { registrarPedido, cargarPedidosDesdeDB } = await import('../src/orders/orderManager.js');

// registrarPedido() genera folios desde un contador en memoria
// (contadorPedidos) que arranca en 1 por proceso -- en producción,
// server.js siempre llama cargarPedidosDesdeDB() al iniciar para
// sincronizarlo con el folio más alto ya existente en la base. Este test
// se ejecuta como script standalone (sin levantar el servidor completo),
// así que debe hacer lo mismo explícitamente -- si no, y esta base ya
// tiene datos de una corrida anterior de este mismo archivo, el primer
// folio generado aquí (XAB-0001) colisionaría con una fila que ya existe
// y que ya tiene un repartidor_id asignado de esa corrida previa,
// dándole al test una falsa lectura por la razón equivocada.
await cargarPedidosDesdeDB();

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function esperarHasta(fn, { timeoutMs = 6000, intervaloMs = 50 } = {}) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const r = await fn();
    if (r) return r;
    await esperar(intervaloMs);
  }
  return null;
}

const sufijo = Date.now().toString().slice(-6);
const repA = await registrarRepartidor(`RT-InsA-${sufijo}`, `8992${sufijo}`, SEED.negocioA);
const repB = await registrarRepartidor(`RT-InsB-${sufijo}`, `8993${sufijo}`, SEED.negocioA);

await t('CARRERA-INSERCION-INICIAL', 'NO-SE-PUEDE-OFRECER-NI-ACEPTAR-ANTES-DE-QUE-TERMINE-LA-INSERCION-INICIAL', async () => {
  const origQuery = pool.query.bind(pool);
  let folioCapturado = null;
  let liberarInsert;
  const insertRetenido = new Promise((resolve) => { liberarInsert = resolve; });

  // Interceptar pool.query para retener artificialmente SOLO el INSERT
  // inicial de este pedido en pedidos_activos -- simula una escritura
  // lenta (carga real de producción, red, contención de conexiones) de
  // forma determinista y reproducible, sin depender de que la corrida
  // "tenga suerte" con el timing real de esta máquina.
  pool.query = async (...args) => {
    const sql = args[0];
    if (typeof sql === 'string' && sql.includes('INSERT INTO pedidos_activos')) {
      folioCapturado = args[1][0]; // primer parámetro del INSERT = folio
      await insertRetenido; // no continúa hasta que el test lo libere
    }
    return origQuery(...args);
  };

  try {
    const promesaPedido = registrarPedido({
      cliente: { nombre: 'Carrera Insercion Inicial', telefono: '8781119998' },
      modalidad: 'entrega a domicilio', items: [], subtotal: 100, costo_envio: 0, descuento: 0, total: 100,
      canal: 'test', negocioId: SEED.negocioA,
    }, 'test');
    // Nota: a propósito NO se hace await de promesaPedido todavía -- por
    // diseño (registrarPedido ahora async), esa promesa no puede resolver
    // hasta que guardarPedidoActivo termine, que es justo lo que estamos
    // reteniendo.

    // Espera determinista (por evento) a que la escritura haya arrancado y
    // capturado el folio, sin dejar que termine.
    await esperarHasta(() => folioCapturado !== null);
    assert.ok(folioCapturado, 'debía capturarse el folio del INSERT antes de liberarlo');

    // Esta suite comparte la base de datos con el resto de la batería
    // (misma convención que las demás pruebas obligatorias) -- el
    // contador de folios en memoria (contadorPedidos, orderManager.js)
    // solo se sincroniza una vez al arrancar (cargarPedidosDesdeDB), así
    // que si otro archivo de prueba ya dejó una fila con este mismo folio
    // (p. ej. un pedido histórico marcado 'entregado' de otra suite), el
    // INSERT real (ON CONFLICT DO NOTHING) sería un no-op contra esa fila
    // ajena en vez de crear la nuestra -- un problema de aislamiento entre
    // archivos de prueba, no del código bajo prueba. Se limpia
    // explícitamente cualquier fila preexistente para este folio exacto
    // ANTES de liberar el INSERT retenido, para que la prueba sea
    // determinista sin importar el orden de ejecución de la batería.
    await origQuery('DELETE FROM pedidos_activos WHERE folio = $1', [folioCapturado]);

    // Con la fila TODAVÍA sin existir en pedidos_activos, un intento de
    // asignación (equivalente a que un repartidor acepte, o a que el
    // sistema intente ofrecer el pedido) debe fallar -- nunca debe poder
    // ofrecerse ni aceptarse un pedido cuya inserción inicial no ha
    // terminado.
    const okAntes = await asignarRepartidor(folioCapturado, repA.id, repA.nombre, SEED.negocioA);
    assert.strictEqual(okAntes, false, 'no debe poder asignarse un pedido cuya inserción inicial sigue pendiente');

    // Liberar el INSERT retenido -- ahora sí termina de escribirse, y
    // registrarPedido() puede resolver.
    liberarInsert();
    const pedido = await promesaPedido;
    assert.strictEqual(pedido.id, folioCapturado, 'el folio devuelto debe coincidir con el capturado durante la retención');

    // Ahora que la inserción terminó (registrarPedido ya resolvió),
    // exactamente un repartidor puede aceptar el pedido.
    const ok1 = await asignarRepartidor(pedido.id, repA.id, repA.nombre, SEED.negocioA);
    assert.strictEqual(ok1, true, 'tras terminar la inserción inicial, la primera asignación debe tener éxito');
    const ok2 = await asignarRepartidor(pedido.id, repB.id, repB.nombre, SEED.negocioA);
    assert.strictEqual(ok2, false, 'un segundo repartidor nunca debe poder tomar el mismo pedido');
  } finally {
    pool.query = origQuery;
  }
});

await t('CARRERA-INSERCION-INICIAL', 'ERROR-DE-BASE-DE-DATOS-EN-LA-INSERCION-INICIAL-RECHAZA-EL-PEDIDO-SIN-COLGAR-EL-FLUJO', async () => {
  const origQuery = pool.query.bind(pool);
  pool.query = async (...args) => {
    const sql = args[0];
    if (typeof sql === 'string' && sql.includes('INSERT INTO pedidos_activos')) {
      throw new Error('conexión simulada caída');
    }
    return origQuery(...args);
  };

  try {
    // guardarPedidoActivo() nunca relanza (atrapa su propio error y
    // devuelve { ok:false }) -- registrarPedido() debe convertir ese error
    // en un rechazo explícito y propio, nunca en una promesa que se cuelga,
    // en un pedido "confirmado" sin fila real, ni en un reintento con otro
    // folio (un error de base de datos no es un conflicto de folio).
    await assert.rejects(
      () => registrarPedido({
        cliente: { nombre: 'Fallo DB', telefono: '8781119997' },
        modalidad: 'entrega a domicilio', items: [], subtotal: 50, costo_envio: 0, descuento: 0, total: 50,
        canal: 'test', negocioId: SEED.negocioA,
      }, 'test'),
      /PEDIDO_NO_PERSISTIDO/
    );
  } finally {
    pool.query = origQuery;
  }
});

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) {
  console.log('\nFallos:');
  fallos.forEach(f => console.log(` - ${f}`));
}
await pool.end();
process.exit(fallidas > 0 ? 1 : 0);
