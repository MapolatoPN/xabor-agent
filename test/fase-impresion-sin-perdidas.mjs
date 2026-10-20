// ─── Impresión sin pérdidas: destinos de equipos desconectados ──────────────
//
// Del 5 al 13 de octubre de 2026, en Mapolato Acuña, todas las categorías
// apuntaban a una impresora de un equipo (PC-ACUNA-CAJA) apagado desde
// septiembre. ~53 pedidos mandaron su comanda SOLO ahí: el trabajo se quedó
// 'pendiente' para siempre, el navegador no imprimió de respaldo (había
// trabajos) y el panel no avisó. Esta suite fija:
//
//   1. un destino cuyo equipo no está disponible se desvía a «Cocina» de un
//      equipo disponible, sin duplicar lo que Cocina ya recibía;
//   2. sin Cocina disponible, el trabajo espera (como antes) y se AVISA;
//   3. un corte de red de segundos no desvía nada (2 min de gracia);
//   4. un trabajo de más de 60 min no se entrega al reconectar;
//   5. el panel pinta la alerta y la nota de desvío.
//
// Parte A sin base. Parte B con Postgres (DATABASE_URL a una base de prueba
// y test/.datos-prueba.json); se niega a correr contra Railway.
import assert from 'assert';
import vm from 'vm';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { aplicarDisponibilidad, avisosDeDisponibilidad, agruparItemsPorImpresora, indexarReglas, CLAVE_COMANDA }
  from '../src/printing/routingEngine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}

// ═══════════ A. Motor (sin base) ═══════════
// Las reglas de Acuña al 13-oct: categorías a la estación del equipo apagado,
// «Cocina» en el equipo conectado.
const reglasAcuna = () => indexarReglas([
  { ambito: 'categoria', clave: 'chilaquiles', impresora_id: 'EST', impresora_nombre: 'Series 2' },
  { ambito: 'categoria', clave: 'bebidas', impresora_id: 'EST', impresora_nombre: 'Series 2' },
  { ambito: 'documento', clave: 'comanda', impresora_id: 'COC', impresora_nombre: 'Series' },
]);
const chilaquiles = { producto: 'Chilaquiles Sencillos', categoria: 'Chilaquiles', cantidad: 1 };
const agua = { producto: 'Agua de horchata', categoria: 'Bebidas', cantidad: 2 };
const molletes = { producto: 'Molletes', categoria: 'Desayunos', cantidad: 1 };
const cocinaDe = (reglas) => reglas.documento.get(CLAVE_COMANDA) || [];

await t('MOTOR', '1. el caso de Acuña: estación apagada → todo sale en Cocina, en el orden capturado', async () => {
  const reglas = reglasAcuna();
  const items = [chilaquiles, molletes, agua];
  const { grupos } = agruparItemsPorImpresora(items, reglas);
  const r = aplicarDisponibilidad(grupos, { disponible: (id) => id !== 'EST', respaldo: cocinaDe(reglas), items });
  assert.deepStrictEqual(r.grupos.map(g => g.impresoraId), ['COC'], 'quedó un trabajo para el equipo apagado');
  assert.deepStrictEqual(r.grupos[0].items, [chilaquiles, molletes, agua], 'la cocina debe leerlo como se capturó');
  assert.deepStrictEqual(r.desviadas, [{ deId: 'EST', de: 'Series 2', a: ['Series'], items: 2 }]);
  assert.deepStrictEqual(r.enEspera, []);
});

await t('MOTOR', '2. un platillo que ya iba a Cocina (estación + cocina) no sale dos veces', async () => {
  const reglas = indexarReglas([
    { ambito: 'categoria', clave: 'chilaquiles', impresora_id: 'EST', impresora_nombre: 'Chilaquil' },
    { ambito: 'categoria', clave: 'chilaquiles', impresora_id: 'COC', impresora_nombre: 'COCINA' },
    { ambito: 'documento', clave: 'comanda', impresora_id: 'COC', impresora_nombre: 'COCINA' },
  ]);
  const items = [chilaquiles];
  const { grupos } = agruparItemsPorImpresora(items, reglas);
  const r = aplicarDisponibilidad(grupos, { disponible: (id) => id !== 'EST', respaldo: cocinaDe(reglas), items });
  assert.deepStrictEqual(r.grupos.map(g => [g.impresoraId, g.items.length]), [['COC', 1]]);
});

await t('MOTOR', '3. sin ninguna Cocina disponible el trabajo se queda (saldrá si vuelve) y se reporta', async () => {
  const reglas = reglasAcuna();
  const items = [chilaquiles, agua];
  const { grupos } = agruparItemsPorImpresora(items, reglas);
  const r = aplicarDisponibilidad(grupos, { disponible: () => false, respaldo: cocinaDe(reglas), items });
  assert.deepStrictEqual(r.grupos.map(g => [g.impresoraId, g.items.length]), [['EST', 2]], 'no se descarta nada');
  assert.deepStrictEqual(r.enEspera, [{ impresoraId: 'EST', impresoraNombre: 'Series 2', items: 2 }]);
  assert.deepStrictEqual(r.desviadas, []);
});

await t('MOTOR', '4. con todo disponible, el reparto queda idéntico al de siempre', async () => {
  const reglas = reglasAcuna();
  const items = [chilaquiles, molletes, agua];
  const { grupos } = agruparItemsPorImpresora(items, reglas);
  const r = aplicarDisponibilidad(grupos, { disponible: () => true, respaldo: cocinaDe(reglas), items });
  assert.deepStrictEqual(r.grupos.map(g => [g.impresoraId, g.items]), grupos.map(g => [g.impresoraId, g.items]));
  assert.deepStrictEqual([r.desviadas, r.enEspera], [[], []]);
  // Y sin función de disponibilidad (scripts, pruebas viejas): lo mismo.
  assert.strictEqual(aplicarDisponibilidad(grupos, {}).grupos, grupos);
});

await t('MOTOR', '5. un documento entero nunca cae en Cocina: solo en otra impresora del mismo documento', async () => {
  const cajas = [{ impresoraId: 'CAJA1', impresoraNombre: 'Caja 1' }, { impresoraId: 'CAJA2', impresoraNombre: 'Caja 2' }];
  const r = aplicarDisponibilidad(cajas, { disponible: (id) => id === 'CAJA1', respaldo: cajas });
  assert.deepStrictEqual(r.grupos.map(g => g.impresoraId), ['CAJA1'], 'el ticket saldría doble o se perdería');
  assert.deepStrictEqual(r.desviadas.map(d => [d.de, d.a]), [['Caja 2', ['Caja 1']]]);
  const ninguna = aplicarDisponibilidad(cajas, { disponible: () => false, respaldo: cajas });
  assert.deepStrictEqual(ninguna.grupos.map(g => g.impresoraId), ['CAJA1', 'CAJA2']);
  assert.strictEqual(ninguna.enEspera.length, 2);
});

await t('MOTOR', '6. los avisos se leen en español y dicen a dónde fue el papel', async () => {
  const a = avisosDeDisponibilidad({
    desviadas: [{ de: 'Series 2', a: ['Series'] }],
    enEspera: [{ impresoraNombre: 'Bebidas' }],
  }, { vigenciaMin: 60 });
  assert.deepStrictEqual(a, [
    'Series 2 no está conectada: se imprimió en Series',
    'Bebidas no está conectada y no hay otra disponible: saldrá cuando su equipo vuelva (hasta 60 min)',
  ]);
});

// ═══════════ A2. Panel: la alerta se ve (sin base) ═══════════
const panel = readFileSync(join(__dirname, '../panel/index.html'), 'utf8');
function funcionesDelPanel() {
  const desde = panel.indexOf('const escAtributo');
  const hasta = panel.indexOf('// Aviso no bloqueante arriba del tablero');
  assert.ok(desde > 0 && hasta > desde, 'no se encontró badgeImpresionEdge en el panel');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(panel.slice(desde, hasta) + '\nthis.badgeImpresionEdge = badgeImpresionEdge;', ctx);
  return ctx;
}
const P = funcionesDelPanel();

await t('PANEL', '7. una comanda esperando a un equipo desconectado se pinta en ROJO', async () => {
  const html = P.badgeImpresionEdge({ id: 'XAB-1', impresion_edge: {
    estado: 'creado', impresoras: ['Series 2'], en_espera: ['Series 2'], alerta: true } });
  assert.ok(html.includes('⚠ 🖨 Edge sin conexión') && html.includes('#b91c1c'), html);
  assert.ok(html.includes('Series 2'), 'el detalle debe nombrar la impresora');
});

await t('PANEL', '8. una comanda desviada sale en azul con la nota de qué impresora faltó', async () => {
  const html = P.badgeImpresionEdge({ id: 'XAB-2', impresion_edge: {
    estado: 'creado', impresoras: ['Series'], desviadas: [{ de: 'Series 2', a: ['Series'] }], alerta: false } });
  assert.ok(html.includes('🖨 Edge · Series') && html.includes('↪'), html);
  assert.ok(html.includes('en lugar de Series 2 (sin conexión)'), html);
  assert.ok(!html.includes('#b91c1c'), 'un desvío que sí imprimió no es una alerta roja');
});

await t('PANEL', '9. el panel atiende el aviso nuevo y lo sube al resumen de la tarjeta', async () => {
  assert.ok(panel.includes("if (msg.tipo === 'impresion_desviada') avisarImpresionDesviada(msg);"), 'falta el manejador del evento');
  assert.strictEqual((panel.match(/function avisarImpresionDesviada\(/g) || []).length, 1, 'función duplicada: la última pisaría a la otra');
  assert.ok(/\(p\.impresion_edge\.en_espera \|\| \[\]\)\.length > 0/.test(panel), 'la alerta de espera no sube al resumen');
});

await t('SERVIDOR', '18. server.js inyecta la conexión viva (sin esto la regla nunca se enciende en producción)', async () => {
  const server = readFileSync(join(__dirname, '../src/server.js'), 'utf8');
  assert.ok(server.includes('setConexionTerminal((terminalId) => socketDeTerminal(terminalId) !== null);'),
    'server.js no inyecta setConexionTerminal con el mismo predicado que la entrega');
  assert.ok(/estadoImpresion, listarTrabajos, setConexionTerminal,/.test(server), 'server.js no importa setConexionTerminal');
});

// ═══════════ B. Con Postgres ═══════════
const SEED_PATH = join(__dirname, '.datos-prueba.json');
const url = process.env.DATABASE_URL || '';
if (!url || /railway|rlwy/.test(url) || !existsSync(SEED_PATH)) {
  console.log('\n(Parte B omitida: hace falta DATABASE_URL local y test/.datos-prueba.json)');
} else {
  const SEED = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
  const { pool } = await import('../src/services/database.js');
  const S = await import('../src/services/impresionService.js');
  const { crearEdge } = await import('../src/services/edgeService.js');
  const E = await import('../src/printing/edgeComanda.js');
  const nid = SEED.negocioA;
  const sufijo = randomUUID().slice(0, 8);
  const { rows: [suc] } = await pool.query(
    `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1, $2) RETURNING id`, [nid, `Sin perdidas ${sufijo}`]);
  const sid = suc.id;
  const viva = await crearEdge(nid, { nombre: `VIVA-${sufijo}`, sucursalId: sid });
  const apagada = await crearEdge(nid, { nombre: `APAGADA-${sufijo}`, sucursalId: sid });
  const cocina = await S.crearImpresora(nid, { terminalId: viva.id, nombre: `COCINA-${sufijo}`, transporte: 'mock' });
  const caja = await S.crearImpresora(nid, { terminalId: viva.id, nombre: `CAJA-${sufijo}`, transporte: 'mock' });
  const estacion = await S.crearImpresora(nid, { terminalId: apagada.id, nombre: `ESTACION-${sufijo}`, transporte: 'mock' });
  const caja2 = await S.crearImpresora(nid, { terminalId: apagada.id, nombre: `CAJA2-${sufijo}`, transporte: 'mock' });
  const cat = `chilaquiles-${sufijo}`;
  await S.crearRuta(nid, { impresoraId: estacion.id, ambito: 'categoria', clave: cat });
  await S.crearRuta(nid, { impresoraId: cocina.id, ambito: 'documento', clave: 'comanda' });
  await S.crearRuta(nid, { impresoraId: caja.id, ambito: 'documento', clave: 'cuenta' });
  await S.crearRuta(nid, { impresoraId: caja2.id, ambito: 'documento', clave: 'cuenta' });

  const latido = (terminalId, sql) => pool.query(`UPDATE terminales SET ultima_conexion = ${sql} WHERE id = $1`, [terminalId]);
  const conectadas = new Set();
  S.setConexionTerminal((tid) => conectadas.has(tid));
  const enchufar = async ({ viva: v, apagada: a, latidoApagada = "NOW() - INTERVAL '3 days'" }) => {
    conectadas.clear();
    if (v) conectadas.add(viva.id);
    if (a) conectadas.add(apagada.id);
    await latido(viva.id, v ? 'NOW()' : "NOW() - INTERVAL '3 days'");
    await latido(apagada.id, latidoApagada);
  };
  const plato = (n = 1) => ({ producto: `Chilaquiles prueba ${sufijo}`, categoria: cat, cantidad: n });
  const pedido = (items) => ({ id: `XAB-T${randomUUID().slice(0, 6)}`, negocioId: nid, canal: 'pos', items });
  const nombres = (r) => r.creados.map(c => c.impresora_nombre);

  try {
    await t('DB', '10. pedido: la estación del equipo apagado se desvía a Cocina del equipo conectado', async () => {
      await enchufar({ viva: true, apagada: false });
      const r = await S.crearTrabajosDePedido({ negocioId: nid, sucursalId: sid, pedido: pedido([plato()]) });
      assert.deepStrictEqual(nombres(r), [cocina.nombre], `trabajos: ${nombres(r)}`);
      assert.strictEqual(r.creados[0].terminal_id, viva.id);
      assert.deepStrictEqual(r.desviadas.map(d => [d.de, d.a]), [[estacion.nombre, [cocina.nombre]]]);
      assert.ok(r.avisos.some(a => a.includes('se imprimió en')), r.avisos.join(' | '));
    });

    await t('DB', '11. un corte de segundos (latido hace 30 s, sin socket) NO desvía: espera en cola', async () => {
      await enchufar({ viva: true, apagada: false, latidoApagada: "NOW() - INTERVAL '30 seconds'" });
      const r = await S.crearTrabajosDePedido({ negocioId: nid, sucursalId: sid, pedido: pedido([plato()]) });
      assert.deepStrictEqual(nombres(r), [estacion.nombre]);
      assert.deepStrictEqual([r.desviadas, r.enEspera], [[], []]);
    });

    await t('DB', '12. sin ningún equipo disponible: trabajo en espera, alerta en el pedido y aviso al panel', async () => {
      await enchufar({ viva: false, apagada: false });
      const eventos = [];
      E.setAvisoImpresionEdge((negocioId, msg) => eventos.push(msg));
      try {
        const p = pedido([plato()]);
        const r = await E.emitirComandaDePedidoPorEdge(p);
        assert.strictEqual(r.seHizoCargo, true, 'el trabajo existe: el navegador no debe imprimir doble cuando el equipo vuelva');
        assert.deepStrictEqual(r.resumen.en_espera, [estacion.nombre]);
        assert.strictEqual(r.resumen.alerta, true, 'papel que no sale sin alerta: el caso de Acuña');
        const ev = eventos.find(e => e.tipo === 'impresion_desviada');
        assert.ok(ev && ev.folio === p.id && ev.enEspera.includes(estacion.nombre), JSON.stringify(eventos));
      } finally { E._resetAvisoImpresionEdgeParaPruebas(); }
    });

    await t('DB', '13. sin inyección (scripts, pruebas viejas) el reparto queda como antes', async () => {
      await enchufar({ viva: true, apagada: false });
      S._resetConexionTerminalParaPruebas();
      try {
        const r = await S.crearTrabajosDePedido({ negocioId: nid, sucursalId: sid, pedido: pedido([plato()]) });
        assert.deepStrictEqual(nombres(r), [estacion.nombre]);
        assert.deepStrictEqual([r.desviadas, r.enEspera], [[], []]);
      } finally { S.setConexionTerminal((tid) => conectadas.has(tid)); }
    });

    await t('DB', '14. mesa: la ronda también se desvía a Cocina', async () => {
      await enchufar({ viva: true, apagada: false });
      const r = await S.crearTrabajosDeComanda({ negocioId: nid, sucursalId: sid, cuentaId: randomUUID(),
        comanda: { mesa: 7, comanda: 1, mesero: 'ANGEL', items: [plato(2)] } });
      assert.deepStrictEqual(nombres(r), [cocina.nombre]);
      assert.ok(r.avisos.some(a => a.includes(estacion.nombre)), 'la respuesta a Mesas debe decir qué faltó');
    });

    await t('DB', '15. cancelación: si la estación no está, el aviso sale en Cocina', async () => {
      await enchufar({ viva: true, apagada: false });
      const r = await S.crearTrabajosDeCancelacion({ negocioId: nid, sucursalId: sid, cuentaId: randomUUID(), eventoId: randomUUID(),
        cancelacion: { mesa: 7, items: [plato()], motivo: 'prueba' } });
      assert.deepStrictEqual(nombres(r), [cocina.nombre]);
    });

    await t('DB', '16. ticket con dos cajas: si una no está, sale solo en la otra (nunca en Cocina)', async () => {
      await enchufar({ viva: true, apagada: false });
      const r = await S.crearTrabajosDeDocumento({ negocioId: nid, sucursalId: sid, documento: 'cuenta',
        origenTipo: 'prueba_sin_perdidas', origenId: randomUUID(), payload: { total: 1 } });
      assert.deepStrictEqual(nombres(r), [caja.nombre]);
      await enchufar({ viva: false, apagada: false });
      const nadie = await S.crearTrabajosDeDocumento({ negocioId: nid, sucursalId: sid, documento: 'cuenta',
        origenTipo: 'prueba_sin_perdidas', origenId: randomUUID(), payload: { total: 1 } });
      assert.deepStrictEqual(nombres(nadie).sort(), [caja.nombre, caja2.nombre].sort(), 'sin nadie, esperan las dos como antes');
      assert.strictEqual(nadie.enEspera.length, 2);
    });

    await t('DB', '17. al reconectar, un trabajo de más de 60 min ya no se entrega; uno reciente sí', async () => {
      const viejo = await S.crearTrabajoDePrueba(nid, estacion.id);
      const reciente = await S.crearTrabajoDePrueba(nid, estacion.id);
      const idViejo = viejo.trabajo?.id ?? viejo.id;
      const idReciente = reciente.trabajo?.id ?? reciente.id;
      assert.ok(idViejo && idReciente, `crearTrabajoDePrueba devolvió ${JSON.stringify(viejo).slice(0, 120)}`);
      await pool.query(`UPDATE impresion_trabajos SET created_at = NOW() - INTERVAL '61 minutes' WHERE id = $1`, [idViejo]);
      await pool.query(`UPDATE impresion_trabajos SET created_at = NOW() - INTERVAL '59 minutes' WHERE id = $1`, [idReciente]);
      const ids = [];
      let cursor = null;
      for (;;) {
        const lote = await S.trabajosPendientesDeTerminal(apagada.id, { limite: 50, desde: cursor });
        ids.push(...lote.map(f => f.id));
        if (lote.length < 50) break;
        cursor = S.cursorDeTrabajo(lote[lote.length - 1]);
      }
      assert.ok(!ids.includes(idViejo), 'el trabajo vencido se entregaría de golpe al reconectar');
      assert.ok(ids.includes(idReciente), 'un trabajo de 59 min todavía debe salir');
      const { rows: [v] } = await pool.query(`SELECT estado FROM impresion_trabajos WHERE id = $1`, [idViejo]);
      assert.strictEqual(v.estado, 'pendiente', 'el vencido se queda como evidencia, sin reescribirlo');
    });
  } finally {
    S._resetConexionTerminalParaPruebas();
    await pool.query(`DELETE FROM impresion_trabajos WHERE sucursal_id = $1`, [sid]).catch(() => {});
    await pool.query(`DELETE FROM sucursales WHERE id = $1`, [sid]).catch(() => {});
    await pool.end();
  }
}

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exitCode = fallidas > 0 ? 1 : 0;
