// Herramienta de operación para P0-11D: resuelve EXPLÍCITAMENTE una fila
// 'requiere_revision' que dejó el backfill de la 063 (pedido legacy no
// terminal -- nuevo/en_preparacion/listo -- sin evidencia inequívoca de
// que su comanda haya salido). Nunca automático, nunca por lote silencioso:
// cada fila se resuelve por su identidad exacta, con una nota humana.
//
// Uso:
//   node scripts/resolver-legacy-ambiguo-063.mjs \
//     --negocio=<uuid> --folio=<XAB-####> --creadoAt=<ISO exacto de la columna> \
//     --resolucion=confirmado_emitido|requiere_reimpresion \
//     --nota="por qué se decidió esto"
//
// 'confirmado_emitido'   -- un operador verificó por otra vía que la comanda
//                           SÍ salió -- cierra la deuda como 'saldada'.
// 'requiere_reimpresion' -- no hay evidencia de que haya salido -- la
//                           convierte en 'pendiente' EJECUTABLE; el
//                           reconciliador normal la recoge y la imprime por
//                           el camino real.
//
// Para ver qué filas siguen pendientes de una decisión:
//   SELECT negocio_id, folio, pedido_creado_at, created_at
//     FROM pedido_emisiones WHERE estado = 'requiere_revision';
import { resolverEmisionLegacyAmbigua, pool } from '../src/services/database.js';

function leerArgs() {
  const args = {};
  for (const raw of process.argv.slice(2)) {
    const m = raw.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

const { negocio, folio, creadoAt, resolucion, nota } = leerArgs();

try {
  if (!negocio || !folio || !creadoAt || !resolucion) {
    throw new Error('faltan argumentos -- se requieren --negocio, --folio, --creadoAt y --resolucion');
  }
  const r = await resolverEmisionLegacyAmbigua(negocio, folio, creadoAt, resolucion, nota || null);
  console.log(`[resolver-legacy-ambiguo-063] Resuelto: negocio=${negocio} folio=${folio} creado=${creadoAt} -> estado=${r.estado}`);
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[resolver-legacy-ambiguo-063] FALLO:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
