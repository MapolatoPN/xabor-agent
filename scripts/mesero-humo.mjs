// ─── EL HUMO REAL: una conversación con el modelo de verdad ───────────────
//
//   ANTHROPIC_API_KEY=... node scripts/mesero-humo.mjs --negocio <uuid>
//   ... --guion "quiero unos chilaquiles|el bowl|salsa verde y pollo|para recoger|efectivo|sí"
//
// Esto es lo que separa «el replay pasa» de «esto funciona». El replay corre el
// sistema con un modelo de guion: prueba que XABOR decide bien, y no prueba
// nada sobre si el modelo entiende a una persona. Eso solo lo dice una
// conversación de verdad.
//
// ── Qué toca y qué no ────────────────────────────────────────────────────
//
//   · lee la carta REAL del negocio desde la base;
//   · llama al modelo REAL, con las herramientas reales;
//   · ejecuta contra el reconciliador REAL;
//   · y NO registra el pedido, NO escala, NO imprime y NO cobra: los efectos
//     son grabadoras, igual que en la sombra. Este script nunca registra.
//
// El libro de operaciones es de MEMORIA: un humo no deja filas en la auditoría
// del agente productivo.
import pg from 'pg';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';
import { estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { libroDeOperaciones, almacenEnMemoria } from '../src/mesero-agente/libroDeOperaciones.js';
import { recolectorDeTraza } from '../src/mesero-agente/trazas.js';

const args = process.argv.slice(2);
const opt = (n, d = null) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const negocioId = opt('--negocio');
if (args.includes('--registrar')) {
  console.error('--registrar no está disponible en el humo. Usa el flujo de canario autorizado para crear pedidos reales.');
  process.exit(2);
}
if (!opt('--guion')) {
  console.error('Falta --guion. Usa productos y opciones existentes del negocio elegido.');
  process.exit(2);
}
const guion = String(opt('--guion'))
  .split('|').map((s) => s.trim()).filter(Boolean);

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Falta ANTHROPIC_API_KEY. Es la credencial del modelo; sin ella este script\n'
    + 'no puede probar lo único que existe para probar. No se simula: se sale.');
  process.exit(2);
}
if (!negocioId) { console.error('Falta --negocio <uuid>.'); process.exit(2); }
const cadena = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!cadena) { console.error('Falta DATABASE_URL (o DATABASE_PUBLIC_URL para producción).'); process.exit(2); }

const host = new URL(cadena).hostname;
const ssl = ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false };
const db = new pg.Client({ connectionString: cadena, ssl });
await db.connect();

const { rows: cats } = await db.query(
  'SELECT * FROM menu_categorias WHERE activa = TRUE AND negocio_id = $1 ORDER BY orden', [negocioId]);
const { rows: prods } = await db.query(
  `SELECT p.* FROM menu_productos p JOIN menu_categorias c ON c.id = p.categoria_id
    WHERE c.activa = TRUE AND p.negocio_id = $1 ORDER BY p.orden`, [negocioId]);
const { rows: grupos } = await db.query(
  'SELECT * FROM menu_modificadores_grupos WHERE negocio_id = $1 ORDER BY producto_id, orden', [negocioId]);
const { rows: opciones } = await db.query(
  'SELECT * FROM menu_modificadores_opciones WHERE negocio_id = $1 AND disponible = TRUE ORDER BY grupo_id, orden',
  [negocioId]);
const { rows: cfgRows } = await db.query('SELECT clave, valor FROM configuracion WHERE negocio_id = $1', [negocioId]);
await db.end();

const cfg = Object.fromEntries(cfgRows.map((r) => [r.clave, r.valor]));
for (const g of grupos) g.opciones = opciones.filter((o) => o.grupo_id === g.id);
for (const p of prods) p.modificadores = grupos.filter((g) => g.producto_id === p.id);
const catalogo = cats.map((c) => ({ ...c, productos: prods.filter((p) => p.categoria_id === c.id) }));
const precios = Object.fromEntries(prods.map((p) => [p.nombre, Number(p.precio)]));

if (!catalogo.length) { console.error('Ese negocio no tiene carta activa: no hay nada que probar.'); process.exit(2); }
console.log(`Carta: ${catalogo.length} categorías, ${prods.length} productos.\n`);

const { llamarModeloDelAgente, MODELO } = await import('../src/mesero-agente/modeloDelAgente.js');
const llamarModeloLocal = (params) => llamarModeloDelAgente(params, { clave: process.env.ANTHROPIC_API_KEY });
const estado = estadoNuevo({ negocioId, conversacionId: `humo-${Date.now()}` });
const libro = libroDeOperaciones(almacenEnMemoria());
const grabadas = [];
const efectos = {
    confirmar: async ({ pedido }) => { grabadas.push({ tipo: 'confirmar', pedido }); return { ok: true, folio: 'HUMO-0001', simulado: true }; },
    escalar: async ({ motivo }) => { grabadas.push({ tipo: 'escalar', motivo }); return { ok: true, simulado: true }; },
};

const historial = [];
let fallos = 0;
for (const [i, mensaje] of guion.entries()) {
  const { traza, cerrar } = recolectorDeTraza({
    negocioId, conversacionId: estado.conversacionId, turnoId: `t${i + 1}`,
    mensaje, modo: 'humo', modelo: MODELO, estadoAntes: null });

  const salida = await atenderTurnoConHerramientas({
    negocioId, conversacionId: estado.conversacionId, turnoId: `t${i + 1}`,
    mensaje, historial: historial.slice(-12),
    catalogo, precios,
    requierePago: String(cfg?.pedido_requiere_pago ?? 'true').toLowerCase() !== 'false',
    estado, libro, llamarModelo: llamarModeloLocal, efectos,
    contexto: { nombreNegocio: cfg?.nombre_negocio || 'el restaurante',
      textoCiclo: [...historial.filter((h) => h.rol === 'user').map((h) => h.texto), mensaje].join('\n') },
    modo: 'humo', traza,
  });
  cerrar({ salida });

  historial.push({ rol: 'user', texto: mensaje });
  if (salida.texto) historial.push({ rol: 'assistant', texto: salida.texto });

  console.log(`\n── turno ${i + 1} ─────────────────────────────────────────`);
  console.log(`cliente  ${mensaje}`);
  for (const o of salida.operaciones) {
    const marca = o.resultado?.aplicado ? '  ok ' : (o.resultado?.estado === 'ilegal' ? 'ILEG' : 'rech');
    console.log(`  ${marca} ${o.herramienta}(${JSON.stringify(o.argumentos).slice(0, 90)})`
      + (o.resultado?.motivo ? `  -> ${String(o.resultado.motivo).slice(0, 80)}` : ''));
    if (o.resultado?.estado === 'ilegal') fallos += 1;
  }
  console.log(`mesero   ${salida.texto}`);
  console.log(`estado   ${salida.pedido.estado} · renglones=${salida.pedido.lineas.length}`
    + ` · total=${salida.pedido.total ?? '—'} · falta=[${salida.pedido.falta.join(', ')}]`
    + ` · ${salida.duracionMs}ms · ${salida.llamadasAlModelo} llamadas`);
}

console.log('\n══ PEDIDO FINAL ══');
for (const l of (estado.carrito.items || [])) {
  console.log(`  ${l.cantidad}x ${l.nombre}`
    + ((l.modificadores || []).length
      ? ` (${l.modificadores.map((g) => `${g.grupo}: ${g.opciones.join('/')}`).join(', ')})` : ''));
}
console.log(`  modalidad=${estado.carrito.datos?.modalidad ?? '—'} pago=${estado.carrito.datos?.forma_pago ?? '—'}`);
console.log(`  confirmado=${estado.hechos.confirmado} escalado=${estado.hechos.escalado} folio=${estado.folio ?? '—'}`);
console.log(`  efectos simulados: ${JSON.stringify(grabadas.map((g) => g.tipo))}`);
console.log(`\n  llamadas ilegales del modelo: ${fallos}`);

// Un humo NO falla por una llamada ilegal —el sistema la frenó, que es lo que
// tenía que pasar— pero sí se cuenta, porque muchas seguidas son un prompt que
// no está diciendo lo que hace falta.
process.exit(0);
