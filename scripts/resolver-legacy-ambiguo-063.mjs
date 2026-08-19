// Herramienta de operación para P0-11D/E: resuelve EXPLÍCITAMENTE una fila
// 'requiere_revision' que dejó el backfill de la 063 (pedido legacy no
// terminal -- nuevo/en_preparacion/listo -- sin evidencia inequívoca de
// que su comanda haya salido). Nunca automático, nunca por lote silencioso:
// cada fila se resuelve por su identidad exacta, con una decisión y una
// nota humanas que quedan DURABLES (resuelto_decision, resuelto_nota,
// resuelto_at) -- P0-11E: sin ellas, tras el recovery la DB no podría
// distinguir "confirmé que ya salió" de "ordené reimprimir".
//
// Uso:
//   node scripts/resolver-legacy-ambiguo-063.mjs \
//     --negocio=<uuid> --folio=<XAB-####> --creadoAt=<ISO exacto de la columna> \
//     --resolucion=confirmado_emitido|requiere_reimpresion \
//     --nota="por qué se decidió esto"   (OBLIGATORIA, no vacía)
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

function leerArgs() {
  const args = {};
  for (const raw of process.argv.slice(2)) {
    const m = raw.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

const { negocio, folio, creadoAt, resolucion, nota } = leerArgs();

// P0-11E: TODA la validación ocurre ANTES de importar database.js -- si algo
// falta, este proceso muere sin haber abierto una sola conexión ni tocado
// ninguna fila.
if (!negocio || !folio || !creadoAt || !resolucion) {
  console.error('[resolver-legacy-ambiguo-063] FALLO: faltan argumentos -- se requieren --negocio, --folio, --creadoAt, --resolucion y --nota');
  process.exit(1);
}
if (resolucion !== 'confirmado_emitido' && resolucion !== 'requiere_reimpresion') {
  console.error(`[resolver-legacy-ambiguo-063] FALLO: --resolucion invalida (${resolucion}); solo se aceptan 'confirmado_emitido' o 'requiere_reimpresion'`);
  process.exit(1);
}
if (typeof nota !== 'string' || !nota.trim()) {
  console.error('[resolver-legacy-ambiguo-063] FALLO: --nota es OBLIGATORIA y no puede estar vacía -- una decision manual sin razon escrita no es auditable (no se tocó la base)');
  process.exit(1);
}

const { resolverEmisionLegacyAmbigua, pool } = await import('../src/services/database.js');

try {
  const r = await resolverEmisionLegacyAmbigua(negocio, folio, creadoAt, resolucion, nota);
  console.log(`[resolver-legacy-ambiguo-063] Resuelto: negocio=${negocio} folio=${folio} creado=${creadoAt} -> estado=${r.estado}, decision=${r.decision}`);
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('[resolver-legacy-ambiguo-063] FALLO:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
}
