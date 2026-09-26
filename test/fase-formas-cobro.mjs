// Formas de cobro configurables — Fase 1: tabla, siembra, Caja y ruta de cobro.
//
// Lo que esta suite protege (diseño aprobado por Mario el 25-sep-2026):
//   1. La tabla formas_cobro (097): ninguna forma puede ser ni llamarse
//      «efectivo» ni repetir una fija; clave y nombre únicos por negocio.
//   2. La siembra: cada negocio con Rappi, Transferencia y Uber Eats / DiDi
//      Food inactivas, y nunca pisa la lista de un negocio que ya la tiene.
//   3. La Caja clasifica con la lista del negocio y, con la lista inicial, da
//      EXACTAMENTE lo mismo que antes de la tabla.
//   4. La ruta de cobro acepta las fijas y las configurables activas con POS,
//      y rechaza las desactivadas y las desconocidas.
//   5. Si la lista no se puede leer, todo sigue con la lista inicial.
//   6. El bot y la tienda en línea no leen esta lista.
//
// Uso: mismas env vars que la batería (DATABASE_URL, PANEL_SECRET, …). La
// suite aplica la 097 al arrancar (idempotente), así que corre en cualquier
// copia de la base.
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const MIGRACION = readFileSync(join(RAIZ, 'migrations', '097_formas_cobro.sql'), 'utf8');
const PUERTO = process.env.TEST_PORT_FORMAS_COBRO || process.env.TEST_PORT || '4198';

const { pool } = await import('../src/services/database.js');
const { crearTokenSesion } = await import('../src/services/session.js');
const {
  listarFormasCobro, catalogoFormasCobro, formasCobroDelPOS, FORMAS_COBRO_INICIALES, FORMAS_COBRO_FIJAS,
} = await import('../src/services/formasCobro.js');
const {
  calcularCorteVivo, clasificarFormaPago, plataformaDePedido, claseDeVenta, partesDelCobro,
  propinasPorClase, rangoUtcDeFecha,
} = await import('../src/services/cortesCaja.js');
const { ventasDeSemana } = await import('../src/services/ajustesCierre.js');

// La regla de ANTES de la 097 (cortesCaja.js en b9ed9bb), copiada tal cual:
// es la vara contra la que se mide que, con la lista inicial, nada cambie.
// No se actualiza nunca: si esta copia y el código nuevo discrepan, cambió
// la clasificación de ventas que ya existen.
const LEGADO = (() => {
  const SIN_ACENTOS = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const textoNormal = (t) => SIN_ACENTOS(String(t || '').trim().toLowerCase());
  const dinero = (n) => Math.round((Number(n) || 0) * 100) / 100;
  function clasificarFormaPago(forma) {
    const f = SIN_ACENTOS(String(forma || '').trim().toLowerCase());
    if (!f) return 'otros';
    if (f.includes('efectivo')) return 'efectivo';
    if (f.includes('terminal') || f.includes('tarjeta')) return 'tarjeta';
    if (f.includes('enlace') || f.includes('clip') || f.includes('mercado') ||
        f.includes('pago_online') || f.includes('pago en linea')) return 'enlace';
    return 'otros';
  }
  const PLATAFORMAS = [
    { clave: 'rappi', nombre: 'Rappi', canales: ['rappi'] },
    { clave: 'uber_eats', nombre: 'Uber Eats', canales: ['uber_eats', 'ubereats', 'uber eats'] },
    { clave: 'didi_food', nombre: 'DiDi Food', canales: ['didi_food', 'didifood', 'didi food'] },
  ];
  function plataformaDePedido(datos = {}) {
    const d = datos && typeof datos === 'object' ? datos : {};
    const canal = textoNormal(d.canal);
    const origen = textoNormal(d.origen);
    const forma = textoNormal(d.forma_pago);
    for (const p of PLATAFORMAS) {
      if (p.canales.includes(canal) || p.canales.includes(origen)) return p;
      if (forma && p.canales.includes(forma)) return p;
    }
    return null;
  }
  function claseDeVenta(formaPago, plataforma) {
    const clase = clasificarFormaPago(formaPago);
    return plataforma && (clase === 'enlace' || clase === 'otros') ? 'plataformas' : clase;
  }
  function partesDelCobro(datos = {}, total = 0) {
    const d = datos && typeof datos === 'object' ? datos : {};
    if (textoNormal(d.forma_pago) !== 'mixto') return null;
    const t = dinero(total);
    if (Array.isArray(d.pagos) && d.pagos.length) {
      const partes = {};
      for (const p of d.pagos) {
        const monto = dinero(p?.monto);
        if (monto <= 0) continue;
        const clase = clasificarFormaPago(p?.metodo);
        partes[clase] = dinero((partes[clase] || 0) + monto);
      }
      const suma = dinero(Object.values(partes).reduce((s, x) => s + x, 0));
      if (!Object.keys(partes).length || Math.abs(suma - t) > 0.01) return null;
      return Object.entries(partes).map(([clase, monto]) => ({ clase, monto }));
    }
    const terminal = dinero(d.mixto_terminal);
    if (terminal > 0 && terminal <= t + 0.005) {
      return [{ clase: 'efectivo', monto: dinero(t - terminal) }, { clase: 'tarjeta', monto: terminal }]
        .filter(p => p.monto > 0);
    }
    return null;
  }
  function propinasPorClase(datos = {}) {
    const d = datos && typeof datos === 'object' ? datos : {};
    const r = { efectivo: 0, tarjeta: 0, enlace: 0, otros: 0 };
    if (Array.isArray(d.pagos) && d.pagos.length) {
      for (const p of d.pagos) {
        const propina = dinero(Math.max(0, Number(p?.propina) || 0));
        if (propina > 0) { const c = clasificarFormaPago(p?.metodo); r[c] = dinero(r[c] + propina); }
      }
      return r;
    }
    const propina = dinero(Math.max(0, Number(d.propinas ?? d.propina) || 0));
    if (propina > 0) { const c = clasificarFormaPago(d.forma_pago); r[c] = dinero(r[c] + propina); }
    return r;
  }
  return { clasificarFormaPago, plataformaDePedido, claseDeVenta, partesDelCobro, propinasPorClase };
})();

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const NEG = SEED.negocioA;
const NEG_B = SEED.negocioB;
const TZ = 'America/Matamoros';
const D1 = '2025-07-21';   // días propios de esta suite: nadie más siembra en julio de 2025
const suf = Date.now().toString().slice(-6);
const n2 = (n) => Math.round(n * 100) / 100;
const cookie = (usuarioId, negocioId, rol) =>
  `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;
const ADMIN_A = cookie(SEED.adminNegocioAUsuarioId, NEG, 'admin');

async function del(sql, params) { try { await pool.query(sql, params); } catch { /* ignorado */ } }
async function forma(negocioId, clave, nombre, tarjeta, extra = {}) {
  const f = { clave_sat: null, en_pos: true, en_mesas: false, activo: true, orden: 90, ...extra };
  await pool.query(
    `INSERT INTO formas_cobro (negocio_id, clave, nombre, tarjeta_caja, clave_sat, en_pos, en_mesas, activo, orden)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [negocioId, clave, nombre, tarjeta, f.clave_sat, f.en_pos, f.en_mesas, f.activo, f.orden]);
}
async function rechaza(sql, params, codigo, mensaje) {
  try { await pool.query(sql, params); }
  catch (e) { assert.strictEqual(e.code, codigo, `${mensaje}: se esperaba ${codigo} y llegó ${e.code} (${e.message})`); return; }
  throw new Error(`${mensaje}: la base lo aceptó`);
}
function instante(fecha, hora) {
  const { inicio } = rangoUtcDeFecha(fecha, TZ);
  return new Date(inicio.getTime() + hora * 3600000);
}
async function venta(folio, fecha, hora, datos) {
  await pool.query(
    `INSERT INTO pedidos_activos (folio, negocio_id, estado, datos, created_at) VALUES ($1,$2,'entregado',$3::jsonb,$4)`,
    [folio, NEG, JSON.stringify({ pago_confirmado: true, items: [], ...datos }), instante(fecha, hora).toISOString()]);
}
const CAMPOS = ['clave', 'nombre', 'tarjeta_caja', 'clave_sat', 'en_pos', 'en_mesas', 'activo', 'orden'];
const filasDe = async (negocioId) => (await pool.query(
  `SELECT ${CAMPOS.join(', ')} FROM formas_cobro WHERE negocio_id = $1 ORDER BY orden, clave`, [negocioId])).rows;
async function reponer(negocioId, filas) {
  await pool.query('DELETE FROM formas_cobro WHERE negocio_id = $1', [negocioId]);
  for (const f of filas) {
    await pool.query(
      `INSERT INTO formas_cobro (negocio_id, ${CAMPOS.join(', ')}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [negocioId, ...CAMPOS.map(c => f[c])]);
  }
}
const catalogo = (filas) => new Map(filas.map(f => [f.clave, f]));

// La 097 es idempotente: aplicarla aquí deja la suite correr en cualquier base.
await pool.query(MIGRACION);

// Estado previo que la suite toca y restaura: la lista del negocio B y su
// Transferencia en metodos_pago (M4/M5). Rappi del negocio A (R4) lo
// devuelve limpiar().
let listaPreviaB = null;
const { rows: [transferenciaPreviaB] } = await pool.query(
  `SELECT habilitado FROM metodos_pago WHERE negocio_id = $1 AND tipo = 'transferencia'`, [NEG_B]);

async function limpiar() {
  await del(`DELETE FROM pedidos_activos WHERE negocio_id = $1 AND folio LIKE 'FC-%'`, [NEG]);
  await del(`DELETE FROM formas_cobro WHERE negocio_id = ANY($1::uuid[]) AND clave LIKE '%\\_fc' ESCAPE '\\'`, [[NEG, NEG_B]]);
  await del(`UPDATE formas_cobro SET activo = true, nombre = 'Rappi' WHERE negocio_id = $1 AND clave = 'rappi'`, [NEG]);
}

let srv = null;
try {
  await limpiar();
  listaPreviaB = await filasDe(NEG_B);

  // ── 1. La tabla ───────────────────────────────────────────────────────────
  await t('M1. la tabla rechaza formas que se confundirían con el efectivo o con una fija', async () => {
    const ins = `INSERT INTO formas_cobro (negocio_id, clave, nombre, tarjeta_caja, clave_sat) VALUES ($1,$2,$3,$4,$5)`;
    await rechaza(ins, [NEG, 'efectivo_usd_fc', 'Dólares', 'otros', null], '23514', 'clave con «efectivo»');
    await rechaza(ins, [NEG, 'mixto', 'Mixto 2', 'otros', null], '23514', 'clave de una fija');
    await rechaza(ins, [NEG, 'Uber Eats', 'Uber 2', 'plataformas', null], '23514', 'clave que no es slug');
    await rechaza(ins, [NEG, 'dolares_fc', 'Efectivo USD', 'otros', null], '23514', 'nombre con «efectivo»');
    await rechaza(ins, [NEG, 'caja_fc', 'Caja chica', 'efectivo', null], '23514', 'tarjeta de Caja «efectivo»');
    await rechaza(ins, [NEG, 'sat_fc', 'SAT raro', 'otros', '01'], '23514', 'clave SAT fuera de 03/04/28');
    await rechaza(ins, [NEG, 'vacio_fc', '   ', 'otros', null], '23514', 'nombre vacío');
    await rechaza(ins, [NEG, 'largo_fc', 'x'.repeat(25), 'otros', null], '23514', 'nombre de 25 caracteres');
  });

  await t('M2. clave y nombre son únicos por negocio, sin importar mayúsculas', async () => {
    await forma(NEG, 'vales_fc', 'Vales FC', 'otros');
    await rechaza(`INSERT INTO formas_cobro (negocio_id, clave, nombre, tarjeta_caja) VALUES ($1,'vales_fc','Otro nombre','otros')`,
      [NEG], '23505', 'clave repetida');
    await rechaza(`INSERT INTO formas_cobro (negocio_id, clave, nombre, tarjeta_caja) VALUES ($1,'vales2_fc','  VALES fc ','otros')`,
      [NEG], '23505', 'nombre repetido con otras mayúsculas');
    await forma(NEG_B, 'vales_fc', 'Vales FC', 'otros');   // otro negocio: sí puede
  });

  // ── 2. La siembra ─────────────────────────────────────────────────────────
  await t('M3. cada negocio tiene la siembra de hoy, idéntica a la lista inicial del código', async () => {
    const { rows: [sinLista] } = await pool.query(
      `SELECT count(*)::int AS n FROM negocios n WHERE NOT EXISTS (SELECT 1 FROM formas_cobro f WHERE f.negocio_id = n.id)`);
    assert.strictEqual(sinLista.n, 0, 'hay negocios sin formas de cobro');
    const sembradas = (await filasDe(NEG)).filter(f => !f.clave.endsWith('_fc'));
    const sinMesas = ({ en_mesas, ...resto }) => resto;
    assert.deepStrictEqual(sembradas.map(sinMesas), FORMAS_COBRO_INICIALES.map(f => sinMesas({ ...f })),
      'la siembra de la 097 y FORMAS_COBRO_INICIALES dicen cosas distintas');
    assert.deepStrictEqual(sembradas.filter(f => f.activo).map(f => f.clave), ['rappi', 'transferencia']);
  });

  await t('M4. Transferencia entra a Mesas solo si el negocio la tiene habilitada hoy', async () => {
    for (const habilitada of [true, false]) {
      await pool.query(
        `INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden) VALUES ($1,'transferencia',$2,4)
         ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = EXCLUDED.habilitado`, [NEG_B, habilitada]);
      await pool.query('DELETE FROM formas_cobro WHERE negocio_id = $1', [NEG_B]);
      await pool.query(MIGRACION);
      const tr = (await filasDe(NEG_B)).find(f => f.clave === 'transferencia');
      assert.strictEqual(tr.en_mesas, habilitada, `habilitada=${habilitada} sembró en_mesas=${tr.en_mesas}`);
    }
  });

  await t('M5. la siembra nunca toca a un negocio que ya tiene su lista', async () => {
    await pool.query(`UPDATE formas_cobro SET activo = false, nombre = 'Rappi MX' WHERE negocio_id = $1 AND clave = 'rappi'`, [NEG_B]);
    await pool.query(MIGRACION);
    const rappi = (await filasDe(NEG_B)).find(f => f.clave === 'rappi');
    assert.deepStrictEqual([rappi.activo, rappi.nombre], [false, 'Rappi MX'], 'la siembra pisó lo que el negocio cambió');
    await pool.query('DELETE FROM formas_cobro WHERE negocio_id = $1', [NEG_B]);
    await forma(NEG_B, 'solo_fc', 'Solo esta', 'otros');
    await pool.query(MIGRACION);
    assert.deepStrictEqual((await filasDe(NEG_B)).map(f => f.clave), ['solo_fc'],
      'la siembra le agregó formas a un negocio que ya tenía su lista');
  });

  // ── 3. El servicio ────────────────────────────────────────────────────────
  await t('S1. un negocio sin renglones usa la lista inicial; si la tabla no se lee, también', async () => {
    const conTabla = await listarFormasCobro(NEG);
    assert.strictEqual(conTabla.origen, 'tabla');
    const sinRenglones = await listarFormasCobro(randomUUID());
    assert.strictEqual(sinRenglones.origen, 'iniciales');
    assert.deepStrictEqual(sinRenglones.filas, FORMAS_COBRO_INICIALES.map(f => ({ ...f })));
    const roto = { query: async () => { throw new Error('relation "formas_cobro" does not exist'); } };
    const respaldo = await listarFormasCobro(NEG, { ejecutor: roto });
    assert.strictEqual(respaldo.origen, 'respaldo');
    assert.deepStrictEqual(respaldo.filas, FORMAS_COBRO_INICIALES.map(f => ({ ...f })));
    assert.deepStrictEqual((await formasCobroDelPOS(NEG, { ejecutor: roto })).aceptadas,
      [...FORMAS_COBRO_FIJAS, 'rappi', 'transferencia'], 'sin tabla, el cobro debe seguir aceptando lo de hoy');
    await assert.rejects(() => listarFormasCobro(''), e => e.code === 'TENANT_CONTEXT_REQUIRED');
  });

  await t('S2. el POS acepta las fijas y las configurables ACTIVAS CON POS, y cada negocio ve solo la suya', async () => {
    await forma(NEG, 'inactiva_fc', 'Inactiva FC', 'otros', { activo: false });
    await forma(NEG, 'mesas_fc', 'Solo mesas FC', 'otros', { en_pos: false, en_mesas: true });
    await forma(NEG, 'amex_fc', 'Amex FC', 'tarjeta');
    const { aceptadas } = await formasCobroDelPOS(NEG);
    for (const f of [...FORMAS_COBRO_FIJAS, 'rappi', 'transferencia', 'amex_fc', 'vales_fc']) {
      assert.ok(aceptadas.includes(f), `no acepta ${f}`);
    }
    for (const f of ['inactiva_fc', 'mesas_fc', 'uber_eats', 'didi_food']) {
      assert.ok(!aceptadas.includes(f), `acepta ${f}`);
    }
    assert.ok(!(await formasCobroDelPOS(NEG_B)).aceptadas.includes('amex_fc'), 'el negocio B ve la lista del A');
  });

  // ── 4. La Caja ────────────────────────────────────────────────────────────
  const CAT = catalogo([
    { clave: 'amex', nombre: 'Amex', tarjeta_caja: 'tarjeta' },
    { clave: 'mp_qr', nombre: 'MP QR', tarjeta_caja: 'enlace' },
    { clave: 'vales', nombre: 'Vales', tarjeta_caja: 'otros' },
    { clave: 'clip_mostrador', nombre: 'Clip mostrador', tarjeta_caja: 'tarjeta' },
    { clave: 'pedidos_ya', nombre: 'PedidosYa', tarjeta_caja: 'plataformas' },
  ]);

  await t('U1. una forma de la lista suma en la tarjeta que el negocio le puso, y la lista gana sobre el texto', () => {
    assert.strictEqual(clasificarFormaPago('amex'), 'otros', 'sin lista, «amex» no dice nada');
    assert.strictEqual(clasificarFormaPago('amex', CAT), 'tarjeta');
    assert.strictEqual(clasificarFormaPago('mp_qr', CAT), 'enlace');
    assert.strictEqual(clasificarFormaPago('vales', CAT), 'otros');
    assert.strictEqual(clasificarFormaPago('clip_mostrador'), 'enlace', 'por el texto, «clip» es enlace');
    assert.strictEqual(clasificarFormaPago('clip_mostrador', CAT), 'tarjeta', 'el negocio dijo tarjeta: gana la lista');
    assert.strictEqual(clasificarFormaPago('efectivo', CAT), 'efectivo', 'las fijas no dependen de la lista');
    assert.strictEqual(clasificarFormaPago('terminal (tarjeta presente)', CAT), 'tarjeta');
  });

  await t('U2. una plataforma de la lista se separa con el nombre que le puso el negocio', () => {
    const py = plataformaDePedido({ forma_pago: 'pedidos_ya' }, CAT);
    assert.deepStrictEqual(py, { clave: 'pedidos_ya', nombre: 'PedidosYa' });
    assert.strictEqual(claseDeVenta('pedidos_ya', py, CAT), 'plataformas');
    const renombrada = catalogo([{ clave: 'rappi', nombre: 'Rappi Turbo', tarjeta_caja: 'plataformas' }]);
    assert.deepStrictEqual(plataformaDePedido({ forma_pago: 'rappi' }, renombrada), { clave: 'rappi', nombre: 'Rappi Turbo' });
    // Un pedido de la integración (canal) sale con el MISMO nombre: si no, la
    // Caja agruparía la misma plataforma bajo dos nombres según qué llegó primero.
    assert.deepStrictEqual(plataformaDePedido({ canal: 'rappi', forma_pago: 'enlace de pago' }, renombrada),
      { clave: 'rappi', nombre: 'Rappi Turbo' });
    // Si el negocio dice que su «rappi» NO es plataforma, manda la lista...
    const comoOtros = catalogo([{ clave: 'rappi', nombre: 'Rappi', tarjeta_caja: 'otros' }]);
    assert.strictEqual(plataformaDePedido({ forma_pago: 'rappi' }, comoOtros), null);
    assert.strictEqual(claseDeVenta('rappi', null, comoOtros), 'otros');
    // ...pero el canal de una integración sigue mandando, y el dinero cobrado
    // en el mostrador sigue en su tarjeta.
    const integracion = plataformaDePedido({ canal: 'rappi', forma_pago: 'efectivo' }, comoOtros);
    assert.strictEqual(integracion?.clave, 'rappi');
    assert.strictEqual(claseDeVenta('efectivo', integracion, comoOtros), 'efectivo');
  });

  await t('U3. un mixto de mesa y sus propinas usan la misma lista', () => {
    const datos = { forma_pago: 'mixto', pagos: [{ metodo: 'efectivo', monto: 100 }, { metodo: 'amex', monto: 50, propina: 10 }] };
    assert.deepStrictEqual(partesDelCobro(datos, 150, CAT), [{ clase: 'efectivo', monto: 100 }, { clase: 'tarjeta', monto: 50 }]);
    assert.strictEqual(propinasPorClase(datos, CAT).tarjeta, 10);
    assert.strictEqual(propinasPorClase(datos).tarjeta, 0, 'sin lista, «amex» no es tarjeta');
  });

  await t('I1. con la lista inicial, cada texto conocido se clasifica EXACTAMENTE como antes de la tabla', () => {
    // Tres lecturas que tienen que coincidir: la regla de antes (LEGADO), el
    // código nuevo sin lista y el código nuevo con la lista inicial.
    const inicial = catalogo(FORMAS_COBRO_INICIALES);
    const soloClaveNombre = (p) => p && { clave: p.clave, nombre: p.nombre };
    const formas = ['efectivo', 'Efectivo', ' EFECTIVO ', 'terminal (tarjeta presente)', 'terminal', 'tarjeta',
      'Tarjeta de crédito', 'enlace de pago', 'enlace_pago', 'clip', 'mercado pago', 'pago_online', 'pago en línea',
      'transferencia', 'Transferencia', 'rappi', 'Rappi', 'RAPPI', 'uber_eats', 'ubereats', 'uber eats', 'didi_food',
      'didifood', 'didi food', 'mixto', 'sin pago', 'por_cobrar', 'pendiente', '', null, undefined, 'contra entrega',
      'transferencia de rappi', 'otro'];
    const canales = [undefined, 'pos', 'whatsapp', 'rappi', 'uber_eats', 'restaurante_mesa', 'tienda_online'];
    let casos = 0;
    for (const forma_pago of formas) {
      for (const canal of canales) {
        for (const origen of [undefined, canal]) {
          const d = { forma_pago, canal, origen };
          const antes = LEGADO.plataformaDePedido(d);
          const sinLista = plataformaDePedido(d);
          const conLista = plataformaDePedido(d, inicial);
          assert.deepStrictEqual(soloClaveNombre(sinLista), soloClaveNombre(antes), `plataforma sin lista de ${JSON.stringify(d)}`);
          assert.deepStrictEqual(soloClaveNombre(conLista), soloClaveNombre(antes), `plataforma con lista de ${JSON.stringify(d)}`);
          const claseAntes = LEGADO.claseDeVenta(forma_pago, antes);
          assert.strictEqual(claseDeVenta(forma_pago, sinLista), claseAntes, `clase sin lista de ${JSON.stringify(d)}`);
          assert.strictEqual(claseDeVenta(forma_pago, conLista, inicial), claseAntes, `clase con lista de ${JSON.stringify(d)}`);
          casos++;
        }
      }
      const naturaleza = LEGADO.clasificarFormaPago(forma_pago);
      assert.strictEqual(clasificarFormaPago(forma_pago), naturaleza, `naturaleza sin lista de ${forma_pago}`);
      assert.strictEqual(clasificarFormaPago(forma_pago, inicial), naturaleza, `naturaleza con lista de ${forma_pago}`);
      const mixto = { forma_pago: 'mixto', propinas: 7, pagos: [{ metodo: forma_pago, monto: 30, propina: 4 }, { metodo: 'efectivo', monto: 70 }] };
      assert.deepStrictEqual(partesDelCobro(mixto, 100, inicial), LEGADO.partesDelCobro(mixto, 100), `mixto con ${forma_pago}`);
      assert.deepStrictEqual(propinasPorClase(mixto, inicial), LEGADO.propinasPorClase(mixto), `propinas con ${forma_pago}`);
      const suelta = { forma_pago, propina: 5 };
      assert.deepStrictEqual(propinasPorClase(suelta, inicial), LEGADO.propinasPorClase(suelta), `propina suelta con ${forma_pago}`);
    }
    assert.ok(casos >= 400, `solo ${casos} casos`);
  });

  // Ventas reales en la base, con formas que el negocio A configuró.
  await forma(NEG, 'mpqr_fc', 'MP QR FC', 'enlace');
  await forma(NEG, 'pedidosya_fc', 'PedidosYa FC', 'plataformas');
  await venta(`FC-${suf}-E`, D1, 9, { total: 100, forma_pago: 'efectivo', cliente: { nombre: 'Mostrador' } });
  await venta(`FC-${suf}-A`, D1, 10, { total: 200, propina: 15, forma_pago: 'amex_fc', cliente: { nombre: 'Amex' } });
  await venta(`FC-${suf}-Q`, D1, 11, { total: 300, forma_pago: 'mpqr_fc', cliente: { nombre: 'QR' } });
  await venta(`FC-${suf}-V`, D1, 12, { total: 50, forma_pago: 'vales_fc', cliente: { nombre: 'Vales' } });
  await venta(`FC-${suf}-P`, D1, 13, { total: 400, forma_pago: 'pedidosya_fc', cliente: { nombre: 'PedidosYa' } });
  await venta(`FC-${suf}-R`, D1, 14, { total: 120, forma_pago: 'rappi', cliente: { nombre: 'Rappi' } });
  await venta(`FC-${suf}-T`, D1, 15, { total: 80, forma_pago: 'transferencia', cliente: { nombre: 'Transfer' } });

  await t('C1. la Caja suma cada forma configurada en su tarjeta y Ventas del día sigue cuadrando', async () => {
    const c = await calcularCorteVivo(NEG, D1);
    assert.strictEqual(c.ventas_efectivo, 100);
    assert.strictEqual(c.ventas_tarjeta, 200, 'Amex (tarjeta) no llegó a Tarjeta');
    assert.strictEqual(c.ventas_enlace, 300, 'MP QR (enlace) no llegó a Clip / enlace');
    assert.strictEqual(c.ventas_otros, n2(50 + 80), 'Vales y Transferencia van a Otros');
    assert.strictEqual(c.ventas_plataformas, n2(400 + 120));
    assert.strictEqual(c.ventas_totales, n2(100 + 200 + 300 + 50 + 400 + 120 + 80), 'se perdió o se duplicó una venta');
    assert.strictEqual(c.ventas_totales,
      n2(c.ventas_efectivo + c.ventas_tarjeta + c.ventas_enlace + c.ventas_plataformas + c.ventas_otros));
    assert.deepStrictEqual(c.plataformas.find(p => p.clave === 'pedidosya_fc'),
      { clave: 'pedidosya_fc', nombre: 'PedidosYa FC', num: 1, total: 400 });
    assert.deepStrictEqual(c.plataformas.find(p => p.clave === 'rappi'), { clave: 'rappi', nombre: 'Rappi', num: 1, total: 120 });
    assert.strictEqual(c.propinas_tarjeta, 15, 'la propina de Amex es de tarjeta');
    assert.strictEqual(c.efectivo_esperado, 100, 'solo la forma fija Efectivo entra al esperado');
  });

  await t('C2. desactivar o renombrar una forma no le cambia la tarjeta a lo ya vendido', async () => {
    await pool.query(`UPDATE formas_cobro SET activo = false WHERE negocio_id = $1 AND clave = 'amex_fc'`, [NEG]);
    await pool.query(`UPDATE formas_cobro SET nombre = 'Rappi Turbo' WHERE negocio_id = $1 AND clave = 'rappi'`, [NEG]);
    try {
      const c = await calcularCorteVivo(NEG, D1);
      assert.strictEqual(c.ventas_tarjeta, 200);
      assert.strictEqual(c.plataformas.find(p => p.clave === 'rappi')?.nombre, 'Rappi Turbo', 'la Caja no usa el nombre de la lista');
    } finally {
      // Siempre: las rutas de abajo cobran con estas dos formas.
      await pool.query(`UPDATE formas_cobro SET activo = true WHERE negocio_id = $1 AND clave = 'amex_fc'`, [NEG]);
      await pool.query(`UPDATE formas_cobro SET nombre = 'Rappi' WHERE negocio_id = $1 AND clave = 'rappi'`, [NEG]);
    }
  });

  await t('C3. los ajustes de cierre clasifican igual que la Caja', async () => {
    const semana = await ventasDeSemana(NEG, D1);
    const lista = semana.ventas || semana;
    const amex = lista.find(v => v.folio === `FC-${suf}-A`);
    assert.ok(amex, 'la venta no aparece en la semana');
    assert.strictEqual(amex.clase_pago, 'tarjeta');
    assert.strictEqual(lista.find(v => v.folio === `FC-${suf}-Q`).clase_pago, 'enlace');
  });

  // ── 5. La ruta de cobro ───────────────────────────────────────────────────
  await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'pos','activo')
    ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = 'activo'`, [NEG]);
  const { rows: [cat] } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, activa, orden) VALUES ($1,'Formas de cobro (test)',TRUE,986) RETURNING id`, [NEG]);
  const { rows: [prod] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, precio, disponible, agotado, orden)
     VALUES ($1,$2,'Taco formas',50,TRUE,FALSE,1) RETURNING id`, [NEG, cat.id]);
  srv = await arrancarServidor({ PORT: PUERTO, TZ }, { timeoutMs: 60000 });
  const api = (ruta, opts = {}) => fetch(srv.base + ruta, {
    ...opts, headers: { 'Content-Type': 'application/json', Cookie: ADMIN_A, ...(opts.headers || {}) },
  });
  async function cobrar(formaPago) {
    const r0 = await api('/api/pedido-presencial', { method: 'POST',
      body: JSON.stringify({ items: [{ producto_id: prod.id, cantidad: 1 }], nombre: 'Cliente formas' }) });
    const d0 = await r0.json();
    assert.strictEqual(r0.status, 200, `no se pudo abrir el pedido: ${JSON.stringify(d0)}`);
    const r = await api(`/pedidos/${d0.pedido.id}/cobro`, { method: 'PATCH', body: JSON.stringify({ forma_pago: formaPago }) });
    return { status: r.status, d: await r.json(), folio: d0.pedido.id };
  }

  await t('R1. Transferencia ya se puede cobrar desde el POS: es de la lista', async () => {
    const { status, d, folio } = await cobrar('transferencia');
    assert.strictEqual(status, 200, JSON.stringify(d));
    const { rows: [fila] } = await pool.query(`SELECT datos FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2`, [folio, NEG]);
    assert.deepStrictEqual([fila.datos.forma_pago, fila.datos.pago_confirmado, Number(fila.datos.cambio)], ['transferencia', true, 0]);
  });

  await t('R2. una forma configurada y activa con POS se cobra (Rappi y una nueva)', async () => {
    for (const f of ['rappi', 'amex_fc']) {
      const { status, d } = await cobrar(f);
      assert.strictEqual(status, 200, `${f}: ${JSON.stringify(d)}`);
    }
  });

  await t('R3. una forma desactivada se rechaza y el mensaje dice cuál', async () => {
    const { status, d } = await cobrar('uber_eats');
    assert.strictEqual(status, 400);
    assert.match(d.error, /Uber Eats está desactivada/);
  });

  await t('R4. desactivar Rappi en la lista lo saca del cobro sin redesplegar, y activarlo lo regresa', async () => {
    await pool.query(`UPDATE formas_cobro SET activo = false WHERE negocio_id = $1 AND clave = 'rappi'`, [NEG]);
    const apagado = await cobrar('rappi');
    assert.strictEqual(apagado.status, 400, 'se cobró un Rappi desactivado');
    assert.match(apagado.d.error, /Rappi está desactivada/);
    await pool.query(`UPDATE formas_cobro SET activo = true WHERE negocio_id = $1 AND clave = 'rappi'`, [NEG]);
    assert.strictEqual((await cobrar('rappi')).status, 200);
  });

  await t('R5. una forma que no es del POS no se cobra desde el POS', async () => {
    const { status, d } = await cobrar('mesas_fc');
    assert.strictEqual(status, 400);
    assert.match(d.error, /no se cobra desde el POS/);
  });

  await t('R6. una forma que no existe se rechaza y la respuesta dice cuáles sí', async () => {
    const { status, d } = await cobrar('bitcoin');
    assert.strictEqual(status, 400);
    assert.match(d.error, /transferencia/);
    for (const fija of ['efectivo', 'mixto']) assert.ok(d.error.includes(fija), `no menciona ${fija}`);
  });

  // ── 6. Quién NO lee la lista ──────────────────────────────────────────────
  await t('G1. el bot y la tienda en línea no leen esta lista', () => {
    const archivos = [
      ...['agent', 'channels', 'mesero-agente', 'mesero-whatsapp'].flatMap(dir =>
        readdirSync(join(RAIZ, 'src', dir)).filter(a => a.endsWith('.js')).map(a => join('src', dir, a))),
      join('src', 'orders', 'validadorOrden.js'),
      join('src', 'services', 'tiendaOnline.js'),
      join('src', 'services', 'tiendaRutasCore.js'),
      join('src', 'services', 'tiendaCheckout.js'),
    ];
    assert.ok(archivos.length >= 20, `solo ${archivos.length} archivos revisados`);
    for (const a of archivos) {
      const texto = readFileSync(join(RAIZ, a), 'utf8');
      assert.ok(!/formas_cobro|formasCobro/.test(texto), `${a} lee la lista del mostrador`);
    }
  });

  await t('G2. el predeploy corre la 097 después de la 096', () => {
    const runner = readFileSync(join(RAIZ, 'scripts', 'predeploy-run-032-033.mjs'), 'utf8');
    const i096 = runner.indexOf("'096-facturacion-servicios'");
    const i097 = runner.indexOf("'097-formas-cobro'");
    assert.ok(i096 > 0 && i097 > i096, 'la 097 no está en la lista del predeploy, o va antes de la 096');
  });

} catch (e) {
  console.error('ERROR FATAL EN LA SUITE:', e);
  fallidas++; fallos.push(`fatal: ${e.message}`);
} finally {
  if (srv) srv.detener();
  await limpiar().catch(() => {});
  if (listaPreviaB) {
    await reponer(NEG_B, listaPreviaB).catch(e => console.error('No se pudo reponer la lista del negocio B:', e.message));
  }
  if (transferenciaPreviaB) {
    await del(`UPDATE metodos_pago SET habilitado = $2 WHERE negocio_id = $1 AND tipo = 'transferencia'`, [NEG_B, transferenciaPreviaB.habilitado]);
  } else {
    await del(`DELETE FROM metodos_pago WHERE negocio_id = $1 AND tipo = 'transferencia'`, [NEG_B]);
  }
  await del(`DELETE FROM menu_productos WHERE negocio_id = $1 AND nombre = 'Taco formas'`, [NEG]);
  await del(`DELETE FROM menu_categorias WHERE negocio_id = $1 AND nombre = 'Formas de cobro (test)'`, [NEG]);
  await pool.end();
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
