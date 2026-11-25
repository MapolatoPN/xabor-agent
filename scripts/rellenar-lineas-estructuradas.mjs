#!/usr/bin/env node
// ─── Relleno histórico de líneas estructuradas (Fase 2.5) ───────────────────
//
// Qué hace. Lee las ventas guardadas (pedidos_activos, y Temporada) de un
// negocio y arma, con la MISMA lectura que el proceso de cada 5 minutos
// (src/services/lineasEstructuradas.js), el registro de cada línea: producto
// del menú, modificadores como registros (grupo, opción, cantidad, precio
// extra) y la nota libre aparte. Al final reporta cuántas líneas se pudieron
// estructurar y cuántas no, por negocio y por canal, y los textos que no se
// reconocieron.
//
// Garantías.
//   · La venta NUNCA se escribe: solo se leen pedidos_activos,
//     restaurante_cuenta_items y temporada_pedidos. Lo único que se escribe
//     (con --aplicar) es el registro derivado: pedido_lineas_pedidos,
//     pedido_lineas y pedido_linea_modificadores (migración 161).
//   · Modo de prueba por omisión: una transacción READ ONLY; Postgres rechaza
//     cualquier escritura. Funciona incluso en una base sin la 161 (para el
//     ensayo en producción antes de migrar).
//   · Idempotente: con --aplicar, un pedido cuyo registro ya está al día
//     (misma firma de artículos) no se vuelve a escribir. Correrlo dos veces
//     deja lo mismo.
//   · Cada consulta va filtrada por el negocio que se procesa.
//
// Uso:
//   DATABASE_URL=… node scripts/rellenar-lineas-estructuradas.mjs --negocio <uuid|slug|todos>
//       [--desde AAAA-MM-DD] [--hasta AAAA-MM-DD]   (días en hora de Matamoros; hasta = exclusivo)
//       [--top 20]                                  (cuántos textos no reconocidos se listan)
//       [--json]                                    (además, una línea JSON con el reporte)
//       [--aplicar]                                 (escribe el registro; sin esto, solo cuenta)
import pg from 'pg';
import { procesarNegocio, reporteVacio, hayTabla, sincronizarTipos } from '../src/services/lineasEstructuradasProceso.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const ZONA = 'America/Matamoros';

function argumento(nombre) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const negocioArg = argumento('negocio');
const desdeArg = argumento('desde');
const hastaArg = argumento('hasta');
const top = Math.max(0, Math.min(200, Number(argumento('top') ?? 20) || 20));
const aplicar = process.argv.includes('--aplicar');
const comoJson = process.argv.includes('--json');

function fallar(msg) {
  console.error(`[relleno-lineas] ${msg}`);
  process.exit(1);
}
if (!process.env.DATABASE_URL) fallar('DATABASE_URL requerida');
if (!negocioArg) fallar('--negocio <uuid|slug|todos> requerido');
if (desdeArg !== undefined && !FECHA.test(desdeArg)) fallar('--desde debe ser AAAA-MM-DD');
if (hastaArg !== undefined && !FECHA.test(hastaArg)) fallar('--hasta debe ser AAAA-MM-DD');

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function negociosAProcesar() {
  if (negocioArg === 'todos') {
    const { rows } = await db.query(
      `SELECT id::text AS id, nombre, slug FROM negocios WHERE activo IS NOT FALSE ORDER BY nombre`);
    return rows;
  }
  const { rows } = await db.query(
    UUID.test(negocioArg)
      ? 'SELECT id::text AS id, nombre, slug FROM negocios WHERE id = $1'
      : 'SELECT id::text AS id, nombre, slug FROM negocios WHERE slug = $1',
    [negocioArg]);
  if (!rows.length) fallar(`no existe el negocio «${negocioArg}»`);
  return rows;
}

// El día en hora de Matamoros (con su horario de verano), como instante.
async function inicioDelDia(fecha) {
  const { rows: [r] } = await db.query(`SELECT (($1::date)::timestamp AT TIME ZONE '${ZONA}') AS t`, [fecha]);
  return r.t;
}

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');

function imprimirNegocio(neg, rep) {
  console.log(`\n══ ${neg.nombre} (${neg.slug || neg.id}) ══`);
  console.log(`   pedidos leídos: ${rep.pedidos}${aplicar ? ` · registros escritos: ${rep.escritos} · tipos actualizados: ${rep.tiposActualizados ?? 0}` : ''}`);
  if (rep.fallidos.length) {
    console.log(`   ⚠ ${rep.fallidos.length} pedido(s) no se pudieron guardar (la venta no se tocó): `
      + rep.fallidos.slice(0, 10).map((f) => `${f.folio} (${f.error})`).join(' · '));
  }
  const filas = Object.entries(rep.porCanal).sort((a, b) => b[1].lineas - a[1].lineas);
  if (!filas.length) { console.log('   (sin ventas en el periodo)'); return; }
  const encabezado = ['canal', 'pedidos', 'líneas', 'completas', 'parciales', 'sin estructurar', '% con producto', 'opciones', 'sin clasificar'];
  const tabla = filas.map(([canal, c]) => [canal, c.pedidos, c.lineas, c.completas, c.parciales, c.sin_estructurar,
    pct(c.completas + c.parciales, c.lineas), c.modificadores, c.sin_clasificar]);
  const tot = filas.reduce((s, [, c]) => {
    for (const k of ['pedidos', 'lineas', 'completas', 'parciales', 'sin_estructurar', 'modificadores', 'sin_clasificar']) s[k] += c[k];
    return s;
  }, { pedidos: 0, lineas: 0, completas: 0, parciales: 0, sin_estructurar: 0, modificadores: 0, sin_clasificar: 0 });
  tabla.push(['TOTAL', tot.pedidos, tot.lineas, tot.completas, tot.parciales, tot.sin_estructurar,
    pct(tot.completas + tot.parciales, tot.lineas), tot.modificadores, tot.sin_clasificar]);
  const anchos = encabezado.map((h, i) => Math.max(h.length, ...tabla.map((f) => String(f[i]).length)));
  const linea = (f) => '   ' + f.map((v, i) => (i === 0 ? String(v).padEnd(anchos[i]) : String(v).padStart(anchos[i]))).join('  ');
  console.log(linea(encabezado));
  for (const f of tabla) console.log(linea(f));
  console.log('   completas = producto del menú y todas sus opciones reconocidas; parciales = producto reconocido');
  console.log('   con alguna opción en «Sin clasificar»; sin estructurar = producto que no está (o ya no está) en el menú.');
  const lista = (titulo, mapa) => {
    if (!mapa.size || !top) return;
    console.log(`   ${titulo} (los ${Math.min(top, mapa.size)} más frecuentes de ${mapa.size}):`);
    for (const [texto, n] of [...mapa.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`     ${String(n).padStart(5)}  ${texto}`);
  };
  lista('Productos que no se encontraron en el menú', rep.productosNoEncontrados);
  lista('Opciones que quedaron en «Sin clasificar»', rep.opcionesSinClasificar);
}

async function main() {
  await db.connect();
  const conRegistro = await hayTabla(db, 'pedido_lineas_pedidos');
  if (aplicar && !conRegistro) fallar('falta la migración 161 (pedido_lineas_pedidos): aplícala antes de --aplicar');
  const desde = desdeArg ? await inicioDelDia(desdeArg) : undefined;
  const hasta = hastaArg ? await inicioDelDia(hastaArg) : undefined;
  const negocios = await negociosAProcesar();
  console.log(`[relleno-lineas] ${aplicar ? 'APLICANDO' : 'MODO DE PRUEBA (solo lectura, no se escribe nada)'}`
    + ` · ${negocios.length} negocio(s) · periodo ${desdeArg || 'desde siempre'} → ${hastaArg ? `antes de ${hastaArg}` : 'hoy'}`
    + `${conRegistro ? '' : ' · base sin la 161: se cuenta todo como pendiente'}`);

  const salida = [];
  for (const neg of negocios) {
    const reporte = reporteVacio();
    if (aplicar) {
      // Escribe por lotes, cada lote en su transacción (guardarLote). Solo
      // los pedidos cuyo registro falta o quedó viejo.
      await procesarNegocio(neg.id, { desde, hasta, escribir: true, todas: false, db, reporte });
      // Y el tipo de las líneas que ya estaban, al del menú de hoy.
      reporte.tiposActualizados = await sincronizarTipos(neg.id, { db });
    } else {
      // READ ONLY: Postgres rechaza cualquier escritura en esta transacción.
      // `todas` cuenta también los pedidos que ya tienen registro al día.
      await db.query('BEGIN TRANSACTION READ ONLY');
      try {
        await procesarNegocio(neg.id, { desde, hasta, escribir: false, todas: true, db, reporte });
      } finally {
        await db.query('ROLLBACK');
      }
    }
    imprimirNegocio(neg, reporte);
    salida.push({
      negocio: neg.slug || neg.id, pedidos: reporte.pedidos, escritos: reporte.escritos,
      tiposActualizados: reporte.tiposActualizados ?? 0, fallidos: reporte.fallidos, porCanal: reporte.porCanal,
      productosNoEncontrados: [...reporte.productosNoEncontrados.entries()].sort((a, b) => b[1] - a[1]).slice(0, top),
      opcionesSinClasificar: [...reporte.opcionesSinClasificar.entries()].sort((a, b) => b[1] - a[1]).slice(0, top),
    });
  }
  if (!aplicar) console.log('\n[relleno-lineas] MODO DE PRUEBA: no se escribió nada. Repite con --aplicar para guardar el registro.');
  if (comoJson) console.log(`\nJSON ${JSON.stringify({ aplicar, desde: desdeArg || null, hasta: hastaArg || null, negocios: salida })}`);
}

main()
  .catch((e) => { console.error(`[relleno-lineas] ABORTADO: ${e.message}`); process.exitCode = 1; })
  .finally(() => db.end().catch(() => {}));
