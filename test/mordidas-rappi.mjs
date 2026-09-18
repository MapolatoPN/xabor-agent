// Prueba de mordida: desactiva UNA garantía, corre la suite, restaura, y
// reporta qué casos cayeron. Uso: node test/mordidas-rappi.mjs A B C
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const f = (p) => join(RAIZ, p);

const MORDIDAS = {
  A: { desc: 'ledger: reclamar SIEMPRE devuelve procesar (sin dedupe)', archivo: f('src/services/pedidosExternos.js'),
    de: `  if (r.insertado) return { accion: 'procesar', registro: r };`, a: `  return { accion: 'procesar', registro: r };`,
    suites: ['fase-rappi-mapeo.mjs', 'fase-rappi-pos-obispado.mjs'] },
  B: { desc: 'canal: un error interno vuelve a RECHAZAR la orden en Rappi', archivo: f('src/channels/rappi.js'),
    de: `    avisarNegocio(negocioId, { tipo: 'rappi_orden_fallida'`,
    a: `    try { const cl = await crearClienteRappiParaIntegracion(integracion); await cl.rechazarOrden(orderId, 'Error interno'); } catch {}\n    avisarNegocio(negocioId, { tipo: 'rappi_orden_fallida'`,
    suites: ['fase-rappi-pos-obispado.mjs'] },
  C: { desc: 'firma: se acepta cualquier firma (sin comparar HMAC)', archivo: f('src/channels/rappiFirma.js'),
    de: `  if (a.length !== b.length || a.length === 0 || !timingSafeEqual(a, b)) return { valida: false, motivo: 'no_coincide' };`, a: ``,
    suites: ['fase-rappi-mapeo.mjs', 'fase-rappi-pos-obispado.mjs'] },
  D: { desc: 'canal: store desconocido cae al negocio A por defecto', archivo: f('src/channels/rappi.js'),
    de: `  const integracion = sobre.storeId ? await obtenerIntegracionRappiPorStore(sobre.storeId) : null;`,
    a: `  const integracion = (sobre.storeId ? await obtenerIntegracionRappiPorStore(sobre.storeId) : null) || await obtenerIntegracionRappi('${SEED.negocioA}');`,
    suites: ['fase-rappi-pos-obispado.mjs'] },
  E: { desc: 'mapeo: se ignora el SKU (solo nombre)', archivo: f('src/channels/rappiMapeo.js'),
    de: `    const p = catalogo.productosPorSku.get(sku.toUpperCase());`, a: `    const p = null;`,
    suites: ['fase-rappi-mapeo.mjs', 'fase-rappi-pos-obispado.mjs'] },
  F: { desc: 'ready: sin candado de una sola notificación', archivo: f('src/channels/rappi.js'),
    de: `  if (!gano) return { enviado: false, razon: 'ya_notificado_o_sin_registro' };`, a: ``,
    suites: ['fase-rappi-pos-obispado.mjs'] },
  G: { desc: 'impresión: la cancelación NO cae a las impresoras de la comanda', archivo: f('src/services/impresionService.js'),
    de: `      destinos = rows.map(r => r.impresora_id);`, a: `      destinos = [];`,
    suites: ['fase-rappi-pos-obispado.mjs'] },
  H: { desc: 'credenciales: se ignoran las propias del negocio (todo por el entorno)', archivo: f('src/services/rappiIntegracion.js'),
    de: `  if (integracion.tieneCredencialesPropias) {`, a: `  if (false) {`,
    suites: ['fase-rappi-pos-obispado.mjs'] },
  I: { desc: 'catálogo: el cliente publica en cualquier store', archivo: f('src/services/rappi-api.js'),
    de: `      if (!catalogoRappi || String(catalogoRappi.storeId) !== sid) {`, a: `      if (false) {`,
    suites: ['fase-rappi-mapeo.mjs'] },
};

const pedidas = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(MORDIDAS);
const resumen = [];
for (const clave of pedidas) {
  const m = MORDIDAS[clave];
  const original = readFileSync(m.archivo, 'utf8');
  const partes = original.split(m.de);
  if (partes.length !== 2) { resumen.push(`${clave}: NO SE PUDO MUTAR (${partes.length - 1} coincidencias)`); continue; }
  writeFileSync(m.archivo, partes.join(m.a));
  try {
    for (const suite of m.suites) {
      const r = spawnSync(process.execPath, [join(__dirname, suite)], { cwd: RAIZ, env: process.env, encoding: 'utf8', timeout: 240000 });
      const salida = (r.stdout || '') + (r.stderr || '');
      const fallos = salida.split('\n').filter(l => l.startsWith('FALLO')).map(l => l.slice(6, 110));
      const res = (salida.match(/(\d+) pasadas, (\d+) fallidas/) || []).slice(1, 3).join('/');
      resumen.push(`${clave} [${m.desc}] → ${suite}: exit=${r.status} pasadas/fallidas=${res}\n` + fallos.map(x => '      ✗ ' + x).join('\n'));
    }
    if (!m.suites.length) resumen.push(`${clave} [${m.desc}] → sin suite que la muerda (documentar)`);
  } finally {
    writeFileSync(m.archivo, original);
  }
}
console.log('\n=== MORDIDAS ===\n' + resumen.join('\n'));
