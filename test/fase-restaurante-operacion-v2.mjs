// Restaurante operativo v2 — criterio de PRODUCTO, no solo de API.
//
// Lo que se prueba aquí no es "el endpoint responde", sino que un mesero
// pueda trabajar en hora pico: entra con su PIN y cae en Restaurante, ve un
// tablero de mesas con estado real, toca categorías y productos (sin
// desplegables), un producto simple entra con UN toque, uno con
// modificadores abre un wizard paso a paso, lo pendiente se distingue de lo
// que ya salió a cocina, y lo que su rol no puede hacer ni siquiera se le
// ofrece (aunque el backend lo siga rechazando por su cuenta).
//
// La pantalla se revisa como la interpreta un navegador: se extrae el script
// inline igual que el parser (hasta el primer "</script>") y se compila; el
// render real (viewports, toques, botones ocultos) se valida aparte con
// navegador headless.
import assert from 'assert';
import vm from 'vm';
import { arrancarServidor } from './lib-servidor.mjs';

const PUERTO = process.env.TEST_PORT || '4958';
const { pool } = await import('../src/services/database.js');
const { hashPin, hashPassword } = await import('../src/services/password.js');
const { crearTokenSesion } = await import('../src/services/session.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

const SLUG_A = 'opv2-restaurante-a', SLUG_B = 'opv2-restaurante-b';

async function limpiar() {
  const { rows } = await pool.query('SELECT id FROM negocios WHERE slug IN ($1,$2)', [SLUG_A, SLUG_B]);
  if (!rows.length) return;
  const ids = rows.map(r => r.id);
  await pool.query(`DELETE FROM restaurante_cuenta_pagos WHERE cuenta_id IN (SELECT id FROM restaurante_cuentas WHERE negocio_id = ANY($1))`, [ids]);
  await pool.query(`DELETE FROM restaurante_cuenta_items WHERE cuenta_id IN (SELECT id FROM restaurante_cuentas WHERE negocio_id = ANY($1))`, [ids]);
  await pool.query('DELETE FROM restaurante_cuentas WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM pedidos_activos WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM menu_modificadores_opciones WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM menu_modificadores_grupos WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM menu_productos WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM menu_categorias WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM metodos_pago WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM negocio_modulos WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM configuracion WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM usuario_negocios WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM usuarios WHERE negocio_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM negocios WHERE id = ANY($1)', [ids]);
}
await limpiar();

// Un restaurante como el del piloto: chilaquiles con salsa (1), proteína (1
// con extra de $30) y guarniciones (1–2), más una bebida sin opciones.
async function crearRestaurante(nombre, slug, pinMesero) {
  const { rows: [n] } = await pool.query('INSERT INTO negocios (nombre, slug) VALUES ($1,$2) RETURNING id', [nombre, slug]);
  for (const m of ['restaurante', 'menu', 'pos', 'usuarios', 'caja']) {
    await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,'activo')
                      ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [n.id, m]);
  }
  for (const tipo of ['efectivo', 'terminal']) {
    await pool.query(`INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden) VALUES ($1,$2,TRUE,0)
                      ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado=TRUE`, [n.id, tipo]);
  }
  const { rows: [admin] } = await pool.query(
    `INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [n.id, `Admin ${nombre}`, `admin-${slug}@test.local`, hashPassword('Xabor12345!')]);
  await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,'admin')`, [admin.id, n.id]);
  const { rows: [mesero] } = await pool.query(
    `INSERT INTO usuarios (negocio_id, nombre, email, pin_hash) VALUES ($1,$2,NULL,$3) RETURNING id`,
    [n.id, `Mesero ${nombre}`, hashPin(pinMesero)]);
  await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,'mesero')`, [mesero.id, n.id]);
  const { rows: [otro] } = await pool.query(
    `INSERT INTO usuarios (negocio_id, nombre, email, pin_hash) VALUES ($1,$2,NULL,$3) RETURNING id`,
    [n.id, `Compañero ${nombre}`, hashPin('9911')]);
  await pool.query(`INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,'mesero')`, [otro.id, n.id]);

  const cat = async (nom, orden) => (await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,$2,TRUE,$3) RETURNING id`, [n.id, nom, orden])).rows[0].id;
  const prod = async (categoria, nom, precio, orden) => (await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, codigo, nombre, descripcion, precio, disponible, orden)
     VALUES ($1,$2,$3,$4,'',$5,TRUE,$6) RETURNING id`,
    [n.id, categoria, `${slug}-${orden}`, nom, precio, orden])).rows[0].id;
  const grupo = async (producto, nom, req, min, max, orden) => (await pool.query(
    `INSERT INTO menu_modificadores_grupos (negocio_id, producto_id, nombre, requerido, minimo, maximo, orden)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [n.id, producto, nom, req, min, max, orden])).rows[0].id;
  const opcion = async (g, nom, extra, orden) => (await pool.query(
    `INSERT INTO menu_modificadores_opciones (negocio_id, grupo_id, nombre, precio_extra, disponible, orden)
     VALUES ($1,$2,$3,$4,TRUE,$5) RETURNING id`, [n.id, g, nom, extra, orden])).rows[0].id;

  const cChila = await cat('Chilaquiles', 0);
  const cBebidas = await cat('Bebidas', 1);
  const chilaquiles = await prod(cChila, 'Chilaquiles', 195, 0);
  const gSalsa = await grupo(chilaquiles, 'Salsa', true, 1, 1, 0);
  const salsas = {};
  for (const [i, nom] of ['Suiza', 'Verde', 'Roja'].entries()) salsas[nom] = await opcion(gSalsa, nom, 0, i);
  const gProte = await grupo(chilaquiles, 'Proteína', true, 1, 1, 1);
  const protes = {};
  for (const [i, [nom, extra]] of [['Pechuga', 0], ['Bistec', 30]].entries()) protes[nom] = await opcion(gProte, nom, extra, i);
  const gGuarn = await grupo(chilaquiles, 'Guarniciones', false, 1, 2, 2);
  const guarns = {};
  for (const [i, nom] of ['Frijoles', 'Papas', 'Chorizo'].entries()) guarns[nom] = await opcion(gGuarn, nom, 0, i);
  const refresco = await prod(cBebidas, 'Coca-Cola', 40, 1);

  return { id: n.id, slug, admin: admin.id, mesero: mesero.id, otro: otro.id, chilaquiles, refresco, salsas, protes, guarns, gGuarn };
}

const A = await crearRestaurante('Cocina A', SLUG_A, '4821');
const B = await crearRestaurante('Cocina B', SLUG_B, '4821');

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const base = srv.base;

function cliente() {
  let cookie = null;
  return {
    get cookie() { return cookie; },
    async pedir(path, { method = 'GET', body } = {}) {
      const h = { 'Content-Type': 'application/json' };
      if (cookie) h['Cookie'] = cookie;
      const r = await fetch(base + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
      const set = r.headers.get('set-cookie');
      if (set) { const v = set.split(';')[0]; cookie = v.endsWith('=') ? null : v; }
      let json = null; try { json = await r.json(); } catch {}
      return { status: r.status, body: json };
    },
  };
}
const traer = async (ruta) => {
  const r = await fetch(base + ruta);
  return { status: r.status, texto: await r.text() };
};
// Igual que el navegador: el <script> inline termina en el primer
// "</script>", esté o no dentro de un string de JavaScript.
function scriptsInline(htmlOriginal) {
  const html = htmlOriginal.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
  const out = [];
  const abre = /<script\b([^>]*)>/gi;
  let m;
  while ((m = abre.exec(html)) !== null) {
    const ini = abre.lastIndex;
    const fin = html.indexOf('</script>', ini);
    if (!/\bsrc\s*=/i.test(m[1] || '')) out.push(fin === -1 ? html.slice(ini) : html.slice(ini, fin));
    if (fin === -1) break;
    abre.lastIndex = fin + '</script>'.length;
  }
  return out;
}

// ── 1-2. El mesero entra por su puerta y aterriza en Restaurante ───────────
const estacion = cliente();
let cuentaMesa1 = null;

await t('ENTRADA', '1. el mesero entra con su PIN y la sesión lo deja operando Restaurante', async () => {
  const r = await estacion.pedir('/api/auth/mesero/login', { method: 'POST', body: { negocio: SLUG_A, meseroUsuarioId: A.mesero, pin: '4821' } });
  assert.strictEqual(r.status, 200);
  assert.ok(estacion.cookie, 'la estación recibe sesión');
  const mesas = await estacion.pedir('/api/restaurante/mesas');
  assert.strictEqual(mesas.status, 200, 'y con esa sesión ya ve las mesas');
});

await t('ENTRADA', '2. esa sesión no abre nada administrativo (el candado está en el backend)', async () => {
  for (const ruta of ['/api/auth/me', '/api/usuarios', '/api/admin/menu/categorias', '/api/ventas', '/api/config/operativa']) {
    const r = await estacion.pedir(ruta);
    assert.ok(r.status === 403 || r.status === 401 || r.status === 404,
      `${ruta} debería cerrarse al mesero y respondió ${r.status}`);
  }
});

await t('ENTRADA', '3. la pantalla de acceso lleva al mismo espacio de trabajo, no a otro sitio', async () => {
  const { texto } = await traer('/mesero/' + SLUG_A);
  assert.ok(texto.includes("/restaurante"), 'tras el PIN entra a /restaurante');
  const { status, texto: rest } = await traer('/restaurante');
  assert.strictEqual(status, 200, '/restaurante se sirve');
  const { texto: mesas } = await traer('/mesas.html');
  assert.strictEqual(rest, mesas, 'es exactamente la misma pantalla que /mesas.html');
});

// ── 4-5. Tablero de mesas ──────────────────────────────────────────────────
await t('TABLERO', '4. el tablero trae lo que hace falta para decidir: mesero, personas, importe y hora', async () => {
  const { body } = await estacion.pedir('/api/restaurante/mesas');
  assert.ok(Array.isArray(body.mesas) && body.mesas.length >= 12, 'lista de mesas');
  assert.ok(body.mesas.every(m => m.ocupada === false), 'todas libres al empezar');
});

await t('TABLERO', '5. abrir mesa autoasigna al mesero autenticado y no acepta abrir a nombre de otro', async () => {
  const r = await estacion.pedir('/api/restaurante/mesas/abrir', { method: 'POST', body: { mesa: 1, personas: 2, meseroUsuarioId: A.otro } });
  assert.strictEqual(r.status, 201);
  cuentaMesa1 = r.body.cuenta.id;
  const { body } = await estacion.pedir('/api/restaurante/mesas');
  const m1 = body.mesas.find(m => m.mesa === 1);
  assert.strictEqual(m1.ocupada, true);
  assert.strictEqual(m1.meseroUsuarioId, A.mesero, 'queda el mesero de la sesión, no el que mandó el cliente');
  assert.strictEqual(m1.personas, 2);
  assert.ok(m1.abiertaAt, 'trae desde cuándo está abierta (para los minutos)');
});

// ── 6-8. Menú táctil ───────────────────────────────────────────────────────
await t('MENU', '6. las categorías vienen con sus productos disponibles y su precio', async () => {
  const { status, body } = await estacion.pedir('/api/menu');
  assert.strictEqual(status, 200);
  const nombres = body.map(c => c.nombre);
  assert.deepStrictEqual(nombres, ['Chilaquiles', 'Bebidas']);
  assert.ok(body[0].productos.length >= 1 && body[1].productos.length >= 1);
});

await t('MENU', '7. la pantalla pinta productos en rejilla y ya no usa el desplegable de productos', async () => {
  const { texto } = await traer('/restaurante');
  assert.ok(/<div[^>]*id="prods"/.test(texto), 'existe la rejilla de productos');
  assert.ok(/<nav[^>]*id="cats"/.test(texto), 'existen las categorías como botones');
  assert.ok(texto.includes('class="prod"'), 'los productos son botones/tarjetas');
  assert.ok(!/id="it-menu"/.test(texto), 'ya no existe el <select> de productos del flujo anterior');
  assert.ok(!texto.includes('Selecciona un producto'), 'ni su texto de marcador');
});

await t('MENU', '8. un producto sin modificadores entra con un solo toque: el servidor lo resuelve', async () => {
  const r = await estacion.pedir(`/api/restaurante/cuentas/${cuentaMesa1}/items`, {
    method: 'POST', body: { items: [{ producto_id: A.refresco, cantidad: 1 }] },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.items[0].producto, 'Coca-Cola');
  assert.strictEqual(Number(r.body.items[0].precio_unitario), 40);
});

// ── 9-15. Wizard de modificadores ──────────────────────────────────────────
await t('WIZARD', '9. el producto con opciones trae sus grupos en orden, con sus reglas', async () => {
  const { body } = await estacion.pedir('/api/menu');
  const chila = body[0].productos.find(p => p.nombre === 'Chilaquiles');
  const grupos = chila.modificadores.map(g => ({ nombre: g.nombre, min: g.minimo, max: g.maximo, req: g.requerido }));
  assert.deepStrictEqual(grupos, [
    { nombre: 'Salsa', min: 1, max: 1, req: true },
    { nombre: 'Proteína', min: 1, max: 1, req: true },
    { nombre: 'Guarniciones', min: 1, max: 2, req: false },
  ], 'tres pasos: salsa, proteína y guarniciones');
});

await t('WIZARD', '10. la pantalla usa el wizard secuencial compartido, no un formulario largo', async () => {
  const { texto } = await traer('/restaurante');
  assert.ok(texto.includes('XaborModificadores.abrirWizard'), 'Restaurante abre el wizard');
  const { texto: js } = await traer('/modificadores.js');
  new vm.Script(js, { filename: 'modificadores.js' });
  assert.ok(js.includes('abrirWizard') && js.includes('abrirModal'), 'el módulo expone las dos formas, sin duplicar reglas');
  assert.ok(js.includes('Paso ${paso + 1} de ${grupos.length}'), 'muestra en qué paso va');
});

await t('WIZARD', '11. con max=1 elegir avanza solo; con varios se avanza al llegar al máximo', async () => {
  const { texto: js } = await traer('/modificadores.js');
  assert.ok(/if \(!multiple\) \{\s*set\.clear\(\); set\.add\(oid\);[\s\S]*?paso\+\+;/.test(js), 'una sola opción: avanza al elegir');
  assert.ok(js.includes('if (set.size === maximo && maximo !== Infinity) { paso++; }'), 'múltiple: avanza al completar el máximo');
});

await t('WIZARD', '12. el resumen y el total salen del mismo cálculo, y el precio real lo pone el servidor', async () => {
  const { texto: js } = await traer('/modificadores.js');
  assert.ok(js.includes('Agregar a la mesa'), 'el resumen cierra con el botón grande');
  assert.ok(js.includes('precioUnitario()'), 'el total mostrado usa el cálculo compartido');
  const r = await estacion.pedir(`/api/restaurante/cuentas/${cuentaMesa1}/items`, {
    method: 'POST',
    body: { items: [{ producto_id: A.chilaquiles, cantidad: 1, modificadores: [A.salsas.Verde, A.protes.Bistec, A.guarns.Frijoles], precio_unitario: 1 }] },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(Number(r.body.items[0].precio_unitario), 225, '195 + 30 de bistec, ignorando el precio que mande el frontend');
});

await t('WIZARD', '13. las reglas mínimas y máximas las hace valer el servidor, no la pantalla', async () => {
  const sinSalsa = await estacion.pedir(`/api/restaurante/cuentas/${cuentaMesa1}/items`, {
    method: 'POST', body: { items: [{ producto_id: A.chilaquiles, cantidad: 1, modificadores: [A.protes.Pechuga, A.guarns.Papas] }] },
  });
  assert.strictEqual(sinSalsa.status, 400, 'falta un grupo obligatorio');
  const deMas = await estacion.pedir(`/api/restaurante/cuentas/${cuentaMesa1}/items`, {
    method: 'POST',
    body: { items: [{ producto_id: A.chilaquiles, cantidad: 1, modificadores: [A.salsas.Roja, A.protes.Pechuga, A.guarns.Frijoles, A.guarns.Papas, A.guarns.Chorizo] }] },
  });
  assert.strictEqual(deMas.status, 400, 'tres guarniciones cuando el máximo es dos');
});

await t('WIZARD', '14. el extra de $30 queda escrito en la línea, no solo en el total', async () => {
  const { body } = await estacion.pedir(`/api/restaurante/cuentas/${cuentaMesa1}`);
  const chila = body.items.find(i => i.producto === 'Chilaquiles');
  assert.ok(chila.modificadores.includes('Proteína: Bistec'), 'la línea dice qué proteína lleva');
  assert.ok(chila.modificadores.includes('Salsa: Verde'));
});

await t('WIZARD', '15. una opción de otro negocio no se puede colar en la cuenta', async () => {
  const r = await estacion.pedir(`/api/restaurante/cuentas/${cuentaMesa1}/items`, {
    method: 'POST', body: { items: [{ producto_id: A.chilaquiles, cantidad: 1, modificadores: [B.salsas.Verde, A.protes.Pechuga, A.guarns.Papas] }] },
  });
  assert.strictEqual(r.status, 400, 'los ids se validan contra el menú de ESTE negocio');
});

// ── 16-19. Rondas: pendiente vs enviado ────────────────────────────────────
await t('RONDAS', '16. lo capturado queda pendiente y el tablero lo avisa', async () => {
  const { body } = await estacion.pedir(`/api/restaurante/cuentas/${cuentaMesa1}`);
  assert.ok(body.items.every(i => i.estado === 'pendiente'), 'nada ha salido a cocina');
  const { body: mesas } = await estacion.pedir('/api/restaurante/mesas');
  assert.strictEqual(mesas.mesas.find(m => m.mesa === 1).pendientes, 2, 'la mesa muestra cuántos faltan por enviar');
});

await t('RONDAS', '17. enviar comanda es la acción principal y manda SOLO lo pendiente', async () => {
  const { texto } = await traer('/restaurante');
  assert.ok(texto.includes('class="accion-principal"') && texto.includes('Enviar comanda'), 'botón principal de la cuenta');
  const r = await estacion.pedir(`/api/restaurante/cuentas/${cuentaMesa1}/comanda`, { method: 'POST' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.comanda, 1);
  assert.strictEqual(r.body.items.length, 2);
});

await t('RONDAS', '18. tras enviar, lo pendiente pasa a ronda 1 y ya no hay nada por mandar', async () => {
  const { body } = await estacion.pedir(`/api/restaurante/cuentas/${cuentaMesa1}`);
  assert.ok(body.items.every(i => i.estado === 'enviado' && i.comanda_num === 1));
  const { body: mesas } = await estacion.pedir('/api/restaurante/mesas');
  assert.strictEqual(mesas.mesas.find(m => m.mesa === 1).pendientes, 0);
  const repetir = await estacion.pedir(`/api/restaurante/cuentas/${cuentaMesa1}/comanda`, { method: 'POST' });
  assert.strictEqual(repetir.status, 409, 'no se puede mandar dos veces lo mismo');
  assert.strictEqual(repetir.body.code, 'SIN_ITEMS_PENDIENTES');
});

await t('RONDAS', '19. una segunda ronda no reimprime la primera y la pantalla las separa', async () => {
  await estacion.pedir(`/api/restaurante/cuentas/${cuentaMesa1}/items`, { method: 'POST', body: { items: [{ producto_id: A.refresco, cantidad: 2 }] } });
  const r = await estacion.pedir(`/api/restaurante/cuentas/${cuentaMesa1}/comanda`, { method: 'POST' });
  assert.strictEqual(r.body.comanda, 2);
  assert.strictEqual(r.body.items.length, 1, 'solo lo nuevo va a cocina');
  const { texto } = await traer('/restaurante');
  assert.ok(texto.includes('Pendiente de enviar') && texto.includes('Ronda ${k}'), 'la cuenta separa rondas de lo pendiente');
  assert.ok(texto.includes('✓ Cocina'), 'marca lo que ya salió');
});

// ── 20-23. Lo que el mesero no debe ver ni poder ───────────────────────────
await t('PERMISOS', '20. cobrar está cerrado para el mesero', async () => {
  const r = await estacion.pedir(`/api/restaurante/cuentas/${cuentaMesa1}/pagos`, { method: 'POST', body: { metodo: 'efectivo', monto: 10 } });
  assert.strictEqual(r.status, 403);
});

await t('PERMISOS', '21. cerrar la cuenta también', async () => {
  const r = await estacion.pedir(`/api/restaurante/cuentas/${cuentaMesa1}/cerrar`, { method: 'POST' });
  assert.strictEqual(r.status, 403);
});

await t('PERMISOS', '22. la pantalla no le ofrece pago, cierre ni captura libre a una sesión de mesero', async () => {
  const { texto } = await traer('/restaurante');
  const js = scriptsInline(texto).join('\n');
  assert.ok(js.includes('const puedeCobrar    = () => !SESION_MESERO;'), 'el permiso de UI sale del tipo de sesión');
  // Los tres botones se agregan dentro del if (puedeCobrar()), nunca fuera.
  const bloque = js.slice(js.indexOf('if (puedeCobrar())'), js.indexOf('$(\'cu-secundarias\')'));
  for (const accion of ['abrirPago()', 'cerrarCuenta()', 'dlg-libre']) {
    assert.ok(bloque.includes(accion), `${accion} solo se ofrece a quien sí puede`);
  }
  const antes = js.slice(js.indexOf('const botones = ['), js.indexOf('if (puedeCobrar())'));
  for (const accion of ['abrirPago()', 'cerrarCuenta()', 'dlg-libre']) {
    assert.ok(!antes.includes(accion), `${accion} no debe aparecer para todos`);
  }
});

await t('PERMISOS', '23. el administrador conserva sus operaciones en la MISMA pantalla', async () => {
  const admin = cliente();
  const login = await admin.pedir('/api/auth/negocio/login', { method: 'POST', body: { email: `admin-${SLUG_A}@test.local`, password: 'Xabor12345!' } });
  assert.strictEqual(login.status, 200);
  const pago = await admin.pedir(`/api/restaurante/cuentas/${cuentaMesa1}/pagos`, { method: 'POST', body: { metodo: 'efectivo', monto: 25 } });
  assert.strictEqual(pago.status, 200, 'la caja sí cobra');
  const me = await admin.pedir('/api/auth/me');
  assert.strictEqual(me.body.rol, 'admin');
  const { body } = await admin.pedir('/api/restaurante/mesas');
  assert.ok(body.mesas.find(m => m.mesa === 1).pagado > 0, 'y el tablero refleja el cobro');
});

// ── 24-27. Render y tamaño táctil ──────────────────────────────────────────
await t('RENDER', '24. la pantalla compila como la lee el navegador (sin SyntaxError ni código suelto)', async () => {
  for (const ruta of ['/restaurante', '/mesas.html', `/mesero/${SLUG_A}`, '/app']) {
    const { texto } = await traer(ruta);
    for (const [i, cuerpo] of scriptsInline(texto).entries()) {
      try { new vm.Script(cuerpo, { filename: `${ruta}#${i}` }); }
      catch (e) { assert.fail(`${ruta}: script inline ${i} no compila: ${e.message}`); }
    }
    const visible = texto.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ');
    assert.ok(!/document\.getElementById\(|=>\s*\{/.test(visible), `${ruta} pinta código como texto`);
  }
});

await t('RENDER', '25. los controles son de dedo, no de ratón: nada depende de hover ni de tamaños diminutos', async () => {
  const { texto } = await traer('/restaurante');
  assert.ok(/\.mesa \{[^}]*min-height:118px/.test(texto), 'las mesas son botones grandes');
  assert.ok(/\.prod \{[^}]*min-height:92px/.test(texto), 'los productos también');
  assert.ok(/\.accion-principal \{[^}]*min-height:58px/.test(texto), 'la acción principal es la más grande');
  assert.ok(!/:hover[^{]*\{[^}]*display\s*:\s*(block|flex|grid)/.test(texto), 'nada se revela solo con hover');
});

await t('RENDER', '26. la hoja está pensada para tablet y celular, y nunca desborda a lo ancho', async () => {
  const { texto } = await traer('/restaurante');
  assert.ok(texto.includes('overflow-x:hidden'), 'el cuerpo no scrollea de lado');
  assert.ok(/@media \(max-width:1200px\)/.test(texto), 'tablet horizontal conserva la cuenta al lado');
  assert.ok(/@media \(max-width:960px\)/.test(texto), 'debajo de eso la cuenta pasa a hoja inferior');
  assert.ok(/@media \(max-width:720px\)/.test(texto), 'y en celular las categorías se vuelven una tira');
  assert.ok(texto.includes('name="viewport"'), 'declara viewport');
});

await t('RENDER', '27. el panel abre Restaurante como parte de Xabor, con el mismo módulo gateado', async () => {
  const { texto } = await traer('/app');
  assert.match(texto, /id="tab-restaurante"[^>]*data-modulo="restaurante"/);
  assert.ok(texto.includes("location.href='/restaurante'"));
  const { texto: rest } = await traer('/restaurante');
  // La marca es el isotipo canónico + "Xabor" (ver docs/branding.md): la
  // barra tiene que identificar al producto, no solo decir "Restaurante".
  assert.ok(rest.includes('/public/brand/xabor-icono.svg') && rest.includes('Xabor') && rest.includes('Restaurante'),
    'la barra es de Xabor, no de otro producto');
});

// ── 28-30. Aislamiento, turnos y estado compartido ─────────────────────────
await t('AISLAMIENTO', '28. el mesero de un restaurante no ve ni toca el otro', async () => {
  const otra = cliente();
  await otra.pedir('/api/auth/mesero/login', { method: 'POST', body: { negocio: SLUG_B, meseroUsuarioId: B.mesero, pin: '4821' } });
  const cuentaAjena = await otra.pedir(`/api/restaurante/cuentas/${cuentaMesa1}`);
  assert.strictEqual(cuentaAjena.status, 404, 'una cuenta de otro negocio no existe para él');
  const { body } = await otra.pedir('/api/restaurante/mesas');
  assert.ok(body.mesas.every(m => !m.ocupada), 'su tablero está vacío: la mesa 1 abierta es del otro negocio');
  const menu = await otra.pedir('/api/menu');
  assert.ok(menu.body.every(c => c.productos.every(p => String(p.id) !== String(A.chilaquiles))), 'ni el menú se mezcla');
});

await t('TURNOS', '29. al salir, la sesión deja de servir aunque alguien conserve la cookie', async () => {
  const cookieVieja = estacion.cookie;
  const salida = await estacion.pedir('/api/auth/mesero/logout', { method: 'POST' });
  assert.strictEqual(salida.status, 200);
  const r = await fetch(base + '/api/restaurante/mesas', { headers: { Cookie: cookieVieja } });
  assert.ok(r.status === 401 || r.status === 403, 'la cookie copiada ya no abre nada');
});

await t('TURNOS', '30. la siguiente persona entra en la misma tablet y ve el estado actualizado', async () => {
  const maria = cliente();
  const login = await maria.pedir('/api/auth/mesero/login', { method: 'POST', body: { negocio: SLUG_A, meseroUsuarioId: A.otro, pin: '9911' } });
  assert.strictEqual(login.status, 200);
  const { body } = await maria.pedir('/api/restaurante/mesas');
  const m1 = body.mesas.find(m => m.mesa === 1);
  assert.strictEqual(m1.ocupada, true, 'la mesa que dejó su compañero sigue abierta');
  assert.strictEqual(m1.meseroUsuarioId, A.mesero, 'con su mesero responsable');
  const quien = await maria.pedir('/api/restaurante/meseros');
  assert.strictEqual(quien.body.sesionMesero, true);
  assert.strictEqual(quien.body.yo.id, A.otro, 'y la barra ya dice quién está trabajando ahora');
  assert.ok(quien.body.negocio, 'con el nombre del restaurante');
});

await limpiar();

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await srv.detener();
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
