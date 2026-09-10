// OBISPADO — EL RECORRIDO COMPLETO SIN INTERNET.
//
// No prueba piezas: prueba el día. Nube real (Postgres), Edge real (arrancado
// como en el local, con su almacén en disco), servidor local real por HTTP, y
// dos estaciones distintas capturando a la vez.
//
// La instalación que replica:
//   · 1 PC de pedidos para llevar   · 1 caja (TODOS los cobros)
//   · 2 PCs de meseros              · red por cable
//
// Los siete escenarios, en orden y sobre el MISMO estado, porque encadenados
// es como fallan de verdad:
//   1. captura simultánea desde dos estaciones
//   2. se cae internet con mesas ya abiertas
//   3. captura, comandas y cobro durante el corte
//   4. se reinicia el Edge y se recarga el navegador
//   5. vuelve el enlace: sincronización, y repetida
//   6. se pierde la respuesta DESPUÉS de que la nube ya guardó
//   7. sincronización al día siguiente contra un corte ya cerrado
//
// Invariante único que todo esto protege: NADA se duplica, NADA se pierde y
// NINGÚN corte histórico cambia en silencio.
//
// Uso: DATABASE_URL=... node test/fase-obispado-recorrido-completo.mjs
import assert from 'assert';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { pool } = await import('../src/services/database.js');
const { hashPin } = await import('../src/services/password.js');
const { abrirMesa, agregarItems } = await import('../src/services/restauranteService.js');
const { construirCatalogoParaEdge } = await import('../src/services/catalogoParaEdge.js');
const { sincronizarLoteSala, CONFLICTOS } = await import('../src/services/sincronizacionSala.js');
const { cerrarCorte, calcularCorteVivo, zonaHorariaNegocio, fechaOperativaHoy, rangoUtcDeFecha } =
  await import('../src/services/cortesCaja.js');
const { crearEdge } = await import('../edge/index.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ── La nube: negocio, personal y carta ──────────────────────────────────────
const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const NEG = (await q1(`INSERT INTO negocios (nombre, slug) VALUES ('Obispado Recorrido','obispado-recorrido')
   ON CONFLICT (slug) DO UPDATE SET nombre='Obispado Recorrido' RETURNING id`)).id;

async function limpiarTodo() {
  for (const tb of ['restaurante_cuenta_pagos', 'restaurante_cuenta_items', 'restaurante_cuentas',
    'pedidos_activos', 'menu_modificadores_opciones', 'menu_modificadores_grupos',
    'menu_productos', 'menu_categorias', 'usuario_negocios']) {
    await pool.query(`DELETE FROM ${tb} WHERE negocio_id=$1`, [NEG]).catch(() => {});
  }
  await pool.query(`DELETE FROM usuarios WHERE negocio_id=$1`, [NEG]).catch(() => {});
  await pool.query(`DELETE FROM cortes_caja WHERE negocio_id=$1`, [NEG]).catch(() => {});
}
await limpiarTodo();

const persona = async (nombre, rol, pin) => {
  const u = await q1(`INSERT INTO usuarios (negocio_id,nombre,activo,pin_hash) VALUES ($1,$2,true,$3) RETURNING id`,
    [NEG, nombre, hashPin(pin)]);
  await pool.query(`INSERT INTO usuario_negocios (usuario_id,negocio_id,rol,activo) VALUES ($1,$2,$3,true)
     ON CONFLICT DO NOTHING`, [u.id, NEG, rol]);
  return u.id;
};
const MESERO_A = await persona('Mesero Uno', 'mesero', '1111');
const MESERO_B = await persona('Mesero Dos', 'mesero', '2222');
const CAJA = await persona('Caja Principal', 'cajero', '3333');

const cat = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,activa,orden) VALUES ($1,'FUERTES',TRUE,0) RETURNING id`, [NEG])).id;
await pool.query(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Chilaquiles',195)`, [NEG, cat]);
await pool.query(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Refresco',45)`, [NEG, cat]);
await pool.query(`INSERT INTO configuracion (negocio_id,clave,valor) VALUES ($1,'restaurante_num_mesas','12')
   ON CONFLICT (negocio_id,clave) DO UPDATE SET valor='12'`, [NEG]);

// ── El Edge, como en el local: almacén en disco, sin conectar a la nube ─────
const carpeta = mkdtempSync(join(tmpdir(), 'edge-obispado-'));
const CFG = {
  wsUrl: 'wss://xabor.mx/ws/print-agent', terminalId: randomUUID(), terminalToken: 'tk',
  rutaDatos: carpeta, almacen: 'auto', nivelLog: 'error',
  heartbeatMs: 60000, timeoutImpresoraMs: 1000, puertoSala: 0,
};
let edge = crearEdge({ config: { ...CFG }, transportes: {} });
await edge.iniciar({ conectar: false });
let base = `http://127.0.0.1:${edge.servidorSala.puerto}`;

async function api(metodo, ruta, { cuerpo, token, url = base } = {}) {
  const r = await fetch(url + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: cuerpo && metodo !== 'GET' ? JSON.stringify(cuerpo) : undefined,
  });
  const txt = await r.text();
  return { estado: r.status, cuerpo: txt ? JSON.parse(txt) : null, crudo: txt };
}
const sesion = async (id, pin) => (await api('POST', '/local/sesion', { cuerpo: { meseroId: id, pin } })).cuerpo.token;

// ═══ ANTES DEL CORTE: la nube tiene una mesa abierta ═══════════════════════
let cuentaEnCurso = null;
await t('0. antes del corte, la Mesa 4 ya está abierta EN LA NUBE con consumo', async () => {
  const c = await abrirMesa(NEG, { mesaNumero: 4, personas: 2, meseroUsuarioId: MESERO_A, abiertaPor: MESERO_A });
  await agregarItems(c.id, NEG, [{ producto: 'Chilaquiles', cantidad: 1, precio_unitario: 195 }], MESERO_A);
  // Y esos chilaquiles YA salieron a cocina antes del corte: es lo que hace
  // que la prueba 5 signifique algo.
  const { enviarComanda } = await import('../src/services/restauranteService.js');
  await enviarComanda(c.id, NEG, MESERO_A);
  cuentaEnCurso = c.id;
  assert.ok(cuentaEnCurso);
});

await t('1. el Edge recibe la foto y HEREDA la mesa que ya estaba abierta', async () => {
  const foto = await construirCatalogoParaEdge(NEG);
  assert.strictEqual(foto.cuentasAbiertas.length, 1, 'la foto lleva las mesas en curso');
  const r = edge.aplicarCatalogo(foto);
  assert.strictEqual(r.aplicado, true, JSON.stringify(r));
  assert.strictEqual(r.traidas, 1);

  const cta = edge.sala.obtenerCuenta(cuentaEnCurso);
  assert.ok(cta, 'sin esto, al caerse el internet la mesa desaparecería y el mesero la reabriría duplicada');
  assert.strictEqual(cta.mesa, 4);
  assert.strictEqual(cta.total, 195, 'con su consumo, no vacía');
});

// ═══ SE CAE INTERNET. De aquí en adelante, todo por el Edge ════════════════
let tokA, tokB, tokCaja;
await t('2. las tres estaciones abren sesión con su PIN contra el Edge', async () => {
  tokA = await sesion(MESERO_A, '1111');
  tokB = await sesion(MESERO_B, '2222');
  tokCaja = await sesion(CAJA, '3333');
  assert.ok(tokA && tokB && tokCaja);
});

let mesaB = null;
await t('3. captura SIMULTÁNEA desde dos estaciones distintas', async () => {
  // A sigue la mesa heredada; B abre una nueva. A la vez, no en fila.
  const [rA, rB] = await Promise.all([
    api('POST', `/local/cuentas/${cuentaEnCurso}/items`, {
      token: tokA, cuerpo: { items: [{ producto: 'Refresco', precio_unitario: 45, cantidad: 2 }] } }),
    api('POST', '/local/mesas/abrir', { token: tokB, cuerpo: { mesa: 7, personas: 4 } }),
  ]);
  assert.strictEqual(rA.estado, 200, rA.crudo);
  assert.strictEqual(rB.estado, 201, rB.crudo);
  mesaB = rB.cuerpo.cuenta.id;
  assert.strictEqual(edge.sala.obtenerCuenta(cuentaEnCurso).total, 285, '195 + 45*2');
});

await t('4. dos estaciones NO pueden abrir la misma mesa', async () => {
  const [x, y] = await Promise.all([
    api('POST', '/local/mesas/abrir', { token: tokA, cuerpo: { mesa: 9, personas: 2 } }),
    api('POST', '/local/mesas/abrir', { token: tokB, cuerpo: { mesa: 9, personas: 3 } }),
  ]);
  const estados = [x.estado, y.estado].sort();
  assert.deepStrictEqual(estados, [201, 409], 'exactamente una gana; la otra recibe MESA_OCUPADA');
});

await t('5. comandas a cocina durante el corte, sin reimprimir lo anterior', async () => {
  const c1 = await api('POST', `/local/cuentas/${cuentaEnCurso}/comanda`, { token: tokA });
  assert.strictEqual(c1.estado, 200, c1.crudo);
  // La mesa venía de la nube con un item YA enviado; la comanda local solo
  // saca lo pendiente.
  assert.deepStrictEqual(c1.cuerpo.comanda.items.map((i) => i.producto), ['Refresco'],
    'los chilaquiles ya habían salido a cocina antes del corte');
});

await t('6. el mesero NO cobra; la caja SÍ', async () => {
  const porMesero = await api('POST', `/local/cuentas/${cuentaEnCurso}/pagos`, {
    token: tokA, cuerpo: { metodo: 'efectivo', monto: 285 } });
  assert.strictEqual(porMesero.estado, 403, 'todos los cobros pasan por la caja principal');

  const porCaja = await api('POST', `/local/cuentas/${cuentaEnCurso}/pagos`, {
    token: tokCaja, cuerpo: { metodo: 'efectivo', monto: 285, propina: 30 } });
  assert.strictEqual(porCaja.estado, 200, porCaja.crudo);
  const cierre = await api('POST', `/local/cuentas/${cuentaEnCurso}/cerrar`, { token: tokCaja });
  assert.strictEqual(cierre.estado, 200, cierre.crudo);
  assert.match(cierre.cuerpo.ventaFolio, /^RM-[0-9A-F]{8}-0$/);
});

// ═══ REINICIO DEL EDGE (corte de luz) y recarga del navegador ══════════════
await t('7. se reinicia el Edge: mesas, cobros y cola pendiente sobreviven', async () => {
  const antes = {
    pendientes: edge.sala.pendientesDeSincronizar(),
    abiertas: edge.sala.listarMesasOcupadas().length,
    venta: edge.sala.obtenerCuenta(cuentaEnCurso).ventaFolio,
  };
  await edge.detener();

  edge = crearEdge({ config: { ...CFG }, transportes: {} });
  await edge.iniciar({ conectar: false });
  base = `http://127.0.0.1:${edge.servidorSala.puerto}`;

  assert.strictEqual(edge.sala.pendientesDeSincronizar(), antes.pendientes, 'no se pierde nada por subir');
  assert.strictEqual(edge.sala.listarMesasOcupadas().length, antes.abiertas, 'las mesas siguen abiertas');
  assert.strictEqual(edge.sala.obtenerCuenta(cuentaEnCurso).ventaFolio, antes.venta,
    'y el folio de la venta cobrada es el mismo que se imprimió');
});

await t('8. tras el reinicio hay que volver a identificarse (la sesión no sobrevive)', async () => {
  const vieja = await api('GET', '/local/mesas', { token: tokCaja });
  assert.strictEqual(vieja.estado, 401, 'un token de antes del reinicio no puede seguir sirviendo');
  tokCaja = await sesion(CAJA, '3333');
  tokB = await sesion(MESERO_B, '2222');
  const ok = await api('GET', '/local/mesas', { token: tokCaja });
  assert.strictEqual(ok.estado, 200);
});

await t('9. "recargar el navegador": el catálogo y el tablero siguen ahí', async () => {
  // Es lo que hace una estación al recargar: pedir salud, catálogo y mesas.
  const salud = await api('GET', '/local/salud');
  assert.strictEqual(salud.cuerpo.ok, true);
  assert.strictEqual(salud.cuerpo.negocioId, NEG, 'la estación comprueba que es SU negocio');
  const catalogo = await api('GET', '/local/catalogo', { token: tokCaja });
  assert.ok(catalogo.cuerpo.menu[0].productos.length >= 2, 'el catálogo sobrevivió al reinicio en disco');
  const mesas = await api('GET', '/local/mesas', { token: tokCaja });
  assert.ok(mesas.cuerpo.ocupadas.length >= 2);
});

// ═══ VUELVE EL ENLACE ══════════════════════════════════════════════════════
let reporte1 = null;
await t('10. sincronización: todo lo del corte entra a la nube', async () => {
  const r = await edge.sincronizarSala((lote) => sincronizarLoteSala(NEG, lote));
  reporte1 = r;
  assert.strictEqual(r.conflictos, 0, JSON.stringify(r.reporte));
  assert.strictEqual(edge.sala.pendientesDeSincronizar(), 0, 'la cola queda vacía');

  const venta = await q1(`SELECT datos FROM pedidos_activos WHERE negocio_id=$1 AND folio LIKE 'RM-%'`, [NEG]);
  assert.ok(venta, 'la venta cobrada sin enlace está en la nube');
  assert.strictEqual(Number(venta.datos.total), 285);

  const abiertas = await q1(`SELECT COUNT(*)::int n FROM restaurante_cuentas WHERE negocio_id=$1 AND estado='abierta'`, [NEG]);
  assert.ok(abiertas.n >= 2, 'las mesas que siguen vivas suben como abiertas, no se pierden');
});

await t('11. sincronizar OTRA VEZ no duplica nada (el caso del ACK perdido)', async () => {
  const ventasAntes = (await q1(`SELECT COUNT(*)::int n FROM pedidos_activos WHERE negocio_id=$1`, [NEG])).n;
  const pagosAntes = (await q1(`SELECT COUNT(*)::int n FROM restaurante_cuenta_pagos WHERE negocio_id=$1`, [NEG])).n;

  // El Edge ya vació su cola, así que se reenvía el MISMO lote a mano: es lo
  // que pasa cuando la nube guardó y la respuesta se perdió en el camino.
  await sincronizarLoteSala(NEG, reporte1.loteReenviado || { cuentas: [], eventos: [] });
  const foto = await construirCatalogoParaEdge(NEG);
  await sincronizarLoteSala(NEG, { cuentas: foto.cuentasAbiertas.map(aFormaEdge), eventos: [] });

  const ventasDespues = (await q1(`SELECT COUNT(*)::int n FROM pedidos_activos WHERE negocio_id=$1`, [NEG])).n;
  const pagosDespues = (await q1(`SELECT COUNT(*)::int n FROM restaurante_cuenta_pagos WHERE negocio_id=$1`, [NEG])).n;
  assert.strictEqual(ventasDespues, ventasAntes, 'ni una venta de más');
  assert.strictEqual(pagosDespues, pagosAntes, 'ni un cobro contado dos veces');
});

await t('12. la respuesta se pierde DESPUÉS de que la nube guardó: se reintenta sin duplicar', async () => {
  // Mesa nueva, cobrada sin enlace.
  const abierta = await api('POST', '/local/mesas/abrir', { token: tokB, cuerpo: { mesa: 11, personas: 2 } });
  const id = abierta.cuerpo.cuenta.id;
  await api('POST', `/local/cuentas/${id}/items`, {
    token: tokB, cuerpo: { items: [{ producto: 'Refresco', precio_unitario: 45 }] } });
  await api('POST', `/local/cuentas/${id}/pagos`, { token: tokCaja, cuerpo: { metodo: 'efectivo', monto: 45 } });
  const cierre = await api('POST', `/local/cuentas/${id}/cerrar`, { token: tokCaja });
  const folio = cierre.cuerpo.ventaFolio;

  // Primer intento: la nube GUARDA, pero la respuesta se pierde.
  await edge.sincronizarSala(async (lote) => {
    await sincronizarLoteSala(NEG, lote);
    throw new Error('se cayó la red al recibir la respuesta');
  });
  assert.ok(edge.sala.pendientesDeSincronizar() > 0, 'sin confirmación, la cola NO se vacía');
  const tras1 = (await q1(`SELECT COUNT(*)::int n FROM pedidos_activos WHERE folio=$1`, [folio])).n;
  assert.strictEqual(tras1, 1);

  // Segundo intento, ahora sí completo.
  const r = await edge.sincronizarSala((lote) => sincronizarLoteSala(NEG, lote));
  assert.strictEqual(r.conflictos, 0, JSON.stringify(r.reporte));
  const tras2 = (await q1(`SELECT COUNT(*)::int n FROM pedidos_activos WHERE folio=$1`, [folio])).n;
  assert.strictEqual(tras2, 1, 'una sola venta, aunque el lote viajó dos veces');
  const pagos = (await q1(`SELECT COUNT(*)::int n FROM restaurante_cuenta_pagos WHERE cuenta_id=$1`, [id])).n;
  assert.strictEqual(pagos, 1, 'y un solo cobro');
  assert.strictEqual(edge.sala.pendientesDeSincronizar(), 0);
});

// ═══ AL DÍA SIGUIENTE, CONTRA UN CORTE YA CERRADO ══════════════════════════
await t('13. una venta de ayer NO cambia en silencio un corte ya cerrado: se reporta', async () => {
  // La fecha se calcula con los MISMOS ayudantes que usa el corte, no con
  // `toISOString()`: la fecha operativa va en la zona del negocio, y a ciertas
  // horas el día UTC y el del local no son el mismo. Esa confusión ya costó un
  // diagnóstico equivocado hoy.
  const tz = await zonaHorariaNegocio(NEG);
  const hoyOp = fechaOperativaHoy(tz);
  const d = new Date(`${hoyOp}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  const fechaAyer = d.toISOString().slice(0, 10);
  // Un instante que cae con holgura DENTRO de ayer, en la zona del negocio.
  const { inicio: inicioAyer } = rangoUtcDeFecha(fechaAyer, tz);
  const instanteAyer = new Date(inicioAyer.getTime() + 12 * 60 * 60 * 1000).toISOString();

  // Se cierra el corte de ayer, con lo que hubiera.
  await cerrarCorte(NEG, { fecha: fechaAyer, efectivoContado: 0, usuarioId: CAJA });
  const corteAntes = await q1(
    `SELECT * FROM cortes_caja WHERE negocio_id=$1 AND fecha_operativa=$2`, [NEG, fechaAyer]);
  assert.ok(corteAntes, 'el corte de ayer quedó cerrado');

  // Aparece una venta de AYER que estuvo atrapada en un Edge sin enlace.
  const sala = edge.sala;
  const tardia = sala.abrirMesa({ mesaNumero: 12, personas: 1, meseroUsuarioId: CAJA, meseroNombre: 'Caja Principal' });
  sala.agregarItems(tardia.id, [{ producto: 'Refresco', precio_unitario: 45 }]);
  sala.registrarPago(tardia.id, { metodo: 'efectivo', monto: 45, usuarioId: CAJA });
  const cerrada = sala.cerrarCuenta(tardia.id, { usuarioId: CAJA });
  // Se fuerza la fecha de cobro a ayer, que es lo que haría un Edge que estuvo
  // desconectado desde entonces.
  const lote = sala.exportarLote();
  const cuentaTardia = lote.cuentas.find((c) => c.id === tardia.id);
  cuentaTardia.cerrada_at = instanteAyer;

  const r = await sincronizarLoteSala(NEG, { cuentas: [cuentaTardia], eventos: [] });
  const fila = r.reporte[0];
  assert.strictEqual(fila.estado, 'aplicada', 'el dinero existió: la venta entra');
  assert.strictEqual(fila.conflicto, CONFLICTOS.CORTE_YA_CERRADO,
    'y se avisa, porque callarlo dejaría dinero fuera de la caja de su día sin que nadie se entere');

  const corteDespues = await q1(
    `SELECT * FROM cortes_caja WHERE negocio_id=$1 AND fecha_operativa=$2`, [NEG, fechaAyer]);
  assert.strictEqual(Number(corteDespues.ventas_efectivo), Number(corteAntes.ventas_efectivo),
    'el corte cerrado es una foto firmada: NO se recalcula solo');
  assert.ok(cerrada.ventaFolio);
});

await t('14. el corte de HOY sí refleja lo cobrado durante el apagón', async () => {
  // Sin fecha: `calcularCorteVivo` resuelve la operativa de hoy en la zona del
  // negocio, que es lo correcto y no siempre coincide con el día UTC.
  const corte = await calcularCorteVivo(NEG);
  // 285 (mesa heredada) + 45 (mesa 11). La venta tardía es de ayer.
  assert.strictEqual(Number(corte.ventas_efectivo), 330,
    `el efectivo cobrado sin enlace tiene que estar en la caja de hoy; vino ${corte.ventas_efectivo}`);
});

// La forma que espera la sincronización (la del Edge), a partir de la de la nube.
function aFormaEdge(c) {
  return {
    id: c.id, mesa_numero: c.mesa, personas: c.personas,
    mesero_usuario_id: c.mesero?.id, mesero_nombre: c.mesero?.nombre,
    estado: c.estado, abierta_por: c.mesero?.id, abierta_at: c.abiertaAt,
    cerrada_por: null, cerrada_at: c.cerradaAt, comandas_emitidas: c.comandasEmitidas,
    reversos: 0, venta_folio: c.ventaFolio, notas: c.notas,
    items: (c.items || []).map((i) => ({
      id: i.id, producto: i.producto, cantidad: i.cantidad,
      precio_unitario_centavos: Math.round(Number(i.precio_unitario) * 100),
      modificadores: i.modificadores || [], notas: i.notas, estado: i.estado,
      comanda_num: i.comanda_num, agregado_por: c.mesero?.id,
      cancelado_por: null, motivo_cancelacion: null, cancelado_at: null, created_at: i.created_at,
    })),
    pagos: (c.pagos || []).map((p) => ({
      id: p.id, metodo: p.metodo,
      monto_centavos: Math.round(Number(p.monto) * 100),
      propina_centavos: Math.round(Number(p.propina) * 100),
      cubre: p.cubre, referencia: p.referencia, registrado_por: c.mesero?.id, created_at: p.created_at,
    })),
  };
}

await edge.detener().catch(() => {});
try { rmSync(carpeta, { recursive: true, force: true }); } catch {}
await limpiarTodo();
console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
await pool.end();
process.exit(fallidas === 0 ? 0 : 1);
