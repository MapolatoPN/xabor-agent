// 134: Xecador, PIN + cara (fase 1). Va ANTES del binario nuevo: el panel
// guarda el consentimiento y la cara, y la tablet anota en cada checada cómo
// salió la cara.
//
// Aditiva y fail-closed, con el mismo contrato que el predeploy-132:
//   - Necesita la 132 (checar solo con el PIN): si no está, se detiene.
//   - "Ya aplicada" solo si están TODAS sus garantías: las columnas, sus
//     reglas, la tabla de caras con sus llaves y los dos triggers que borran
//     la cara sin consentimiento.
//   - Si falta algo, dice qué y aplica el SQL en una transacción; lo que no se
//     pueda reconstruir hace fallar la verificación posterior y se revierte.
//   - Aborta si cambia el número de expedientes, de checadas, de eventos o de
//     avisos, o cualquier PIN guardado (pin_hash).
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL requerida');
const host = new URL(process.env.DATABASE_URL).hostname;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL,
  ssl: ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false } });

// [tabla, columna, tipo, admite NULL, valor por omisión (fragmento) o null]
const COLUMNAS = [
  ['xecador_empleados', 'consentimiento_cara_fecha', 'date', 'YES', null],
  ['xecador_config', 'cara_al_checar', 'text', 'NO', "'apagado'"],
  ['xecador_checadas', 'cara', 'text', 'NO', "'no_requerida'"],
  ['xecador_checadas', 'cara_detalle', 'text', 'YES', null],
  ['xecador_checadas', 'cara_similitud', 'real', 'YES', null],
  ['xecador_caras', 'negocio_id', 'uuid', 'NO', null],
  ['xecador_caras', 'empleado_id', 'uuid', 'NO', null],
  ['xecador_caras', 'modelo', 'text', 'NO', null],
  ['xecador_caras', 'llave', 'text', 'NO', null],
  ['xecador_caras', 'vectores', 'bytea', 'NO', null],
  ['xecador_caras', 'muestras', 'smallint', 'NO', null],
  ['xecador_caras', 'foto', 'bytea', 'NO', null],
  ['xecador_caras', 'foto_mime', 'text', 'NO', null],
];

// [tabla, restricción, tipo, fragmentos que su definición debe traer]
const REGLAS = [
  ['xecador_empleados', 'xecador_empleados_consentimiento_cara_check', 'c', ["estatus = 'activo'::text", 'consentimiento_cara_fecha IS NULL']],
  ['xecador_caras', 'xecador_caras_pkey', 'p', ['PRIMARY KEY (negocio_id, empleado_id)']],
  ['xecador_caras', 'xecador_caras_empleado_fkey', 'f',
    ['FOREIGN KEY (negocio_id, empleado_id) REFERENCES xecador_empleados(negocio_id, id) ON DELETE CASCADE']],
  ['xecador_caras', 'xecador_caras_creado_por_fkey', 'f', ['REFERENCES usuarios(id) ON DELETE SET NULL']],
  ['xecador_caras', 'xecador_caras_modelo_check', 'c', ['modelo']],
  ['xecador_caras', 'xecador_caras_llave_check', 'c', ['llave']],
  ['xecador_caras', 'xecador_caras_muestras_check', 'c', ['muestras']],
  ['xecador_caras', 'xecador_caras_vectores_check', 'c', ['octet_length(vectores)']],
  ['xecador_caras', 'xecador_caras_foto_check', 'c', ['octet_length(foto)']],
  ['xecador_caras', 'xecador_caras_foto_mime_check', 'c', ['foto_mime']],
  ['xecador_empleado_eventos', 'xecador_empleado_eventos_tipo_check', 'c', ["'consentimiento_cara'::text", "'cara'::text", "'pin'::text"]],
  ['xecador_config', 'xecador_config_cara_al_checar_check', 'c', ["'apagado'::text", "'confirmar'::text"]],
  ['xecador_checadas', 'xecador_checadas_cara_check', 'c', ["'coincide'::text", "'no_coincide'::text", "'no_verificada'::text"]],
  ['xecador_checadas', 'xecador_checadas_cara_detalle_check', 'c', ["cara = 'no_verificada'::text", "'sin_giro'::text"]],
  ['xecador_checadas', 'xecador_checadas_cara_similitud_check', 'c', ['cara_similitud']],
  ['xecador_checadas', 'xecador_checadas_revision_check', 'c', ["'cara_no_coincide'::text", "'cara_no_verificada'::text", "'ip_distinta'::text"]],
  ['xecador_avisos', 'xecador_avisos_tipo_check', 'c', ["'cara_no_coincide'::text", "'checada_sin_empleado'::text"]],
];

// [tabla, trigger, función, fragmentos que su definición debe traer]
const TRIGGERS = [
  ['xecador_caras', 'xecador_caras_consentimiento', 'xecador_caras_con_consentimiento',
    ['BEFORE INSERT OR UPDATE ON public.xecador_caras FOR EACH ROW']],
  ['xecador_empleados', 'xecador_empleados_cara', 'xecador_empleados_cara_al_cambiar',
    ['BEFORE UPDATE ON public.xecador_empleados FOR EACH ROW WHEN', 'old.consentimiento_cara_fecha IS NOT NULL']],
];
// Lo que cada función debe hacer: sin esto, una función vacía pasaría.
const FUNCIONES = {
  xecador_caras_con_consentimiento: ['consentimiento_cara_fecha IS NOT NULL', 'FOR SHARE', 'RAISE EXCEPTION'],
  xecador_empleados_cara_al_cambiar: ['DELETE FROM xecador_caras', 'NEW.consentimiento_cara_fecha := NULL', 'xecador_empleado_eventos'],
};

async function estado() {
  const faltan = [];
  for (const [tabla, columna, tipo, nulos, omision] of COLUMNAS) {
    const { rows: [c] } = await db.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [tabla, columna]);
    if (!c) faltan.push(`columna ${tabla}.${columna}`);
    else if (c.data_type !== tipo) faltan.push(`columna ${tabla}.${columna} de tipo ${c.data_type}`);
    else if (c.is_nullable !== nulos) faltan.push(`columna ${tabla}.${columna} ${nulos === 'NO' ? 'admite NULL' : 'sin NULL'}`);
    else if (omision && !String(c.column_default || '').includes(omision)) faltan.push(`columna ${tabla}.${columna} sin su valor por omisión`);
  }
  for (const [tabla, nombre, tipo, fragmentos] of REGLAS) {
    const { rows: [r] } = await db.query(
      `SELECT c.contype, c.convalidated, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
         JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
        WHERE n.nspname = 'public' AND cl.relname = $1 AND c.conname = $2`, [tabla, nombre]);
    if (!r || r.contype !== tipo || !r.convalidated || !fragmentos.every((f) => r.def.includes(f))) faltan.push(`restricción ${nombre}`);
  }
  for (const [tabla, nombre, funcion, fragmentos] of TRIGGERS) {
    const { rows: [t] } = await db.query(
      `SELECT pg_get_triggerdef(t.oid) AS def, t.tgenabled, p.proname, pg_get_functiondef(p.oid) AS cuerpo
         FROM pg_trigger t JOIN pg_class cl ON cl.oid = t.tgrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE n.nspname = 'public' AND cl.relname = $1 AND t.tgname = $2 AND NOT t.tgisinternal`, [tabla, nombre]);
    if (!t) { faltan.push(`trigger ${nombre}`); continue; }
    if (t.tgenabled !== 'O' || t.proname !== funcion || !fragmentos.every((f) => t.def.includes(f))) faltan.push(`trigger ${nombre} con otra definición`);
    else if (!FUNCIONES[funcion].every((f) => t.cuerpo.includes(f))) faltan.push(`función ${funcion} con otro cuerpo`);
  }
  return faltan;
}

const CONTEOS = `SELECT (SELECT COUNT(*) FROM xecador_empleados)::int AS empleados,
                        (SELECT COUNT(*) FROM xecador_checadas)::int AS checadas,
                        (SELECT COUNT(*) FROM xecador_empleado_eventos)::int AS eventos,
                        (SELECT COUNT(*) FROM xecador_avisos)::int AS avisos,
                        (SELECT COALESCE(md5(string_agg(id::text || ':' || estatus || ':' || COALESCE(pin_hash, '-'), ',' ORDER BY id)), '')
                           FROM xecador_empleados) AS expedientes`;
try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='3s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('migracion-134-xecador-cara',0))");
  const { rows: [base] } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'xecador_empleados' AND column_name = 'pin_indice') AS pin_indice`);
  if (!base.pin_indice) {
    throw Error('La 134 necesita la 132 (checar solo con el PIN). El runner aplica la 132 antes; revisa por qué no está.');
  }
  const antes = await estado();
  if (!antes.length) {
    await db.query('COMMIT');
    console.log('[predeploy-134] Ya aplicada -- no se ejecuta nada.');
  } else {
    console.log(`[predeploy-134] Aplicando migrations/134_xecador_cara.sql (faltaba: ${antes.join('; ')})...`);
    const { rows: [conteoAntes] } = await db.query(CONTEOS);
    await db.query(await readFile(new URL('../migrations/134_xecador_cara.sql', import.meta.url), 'utf8'));
    const despues = await estado();
    if (despues.length) {
      throw Error(`Tras aplicar la 134 sigue faltando: ${despues.join('; ')}. Requiere revisión manual. Se revierte.`);
    }
    const { rows: [conteoDespues] } = await db.query(CONTEOS);
    if (JSON.stringify(conteoAntes) !== JSON.stringify(conteoDespues)) {
      throw Error(`La 134 cambió filas existentes (${conteoAntes.empleados}/${conteoAntes.checadas}/${conteoAntes.eventos} → `
        + `${conteoDespues.empleados}/${conteoDespues.checadas}/${conteoDespues.eventos}): se revierte`);
    }
    await db.query('COMMIT');
    console.log(`[predeploy-134] Aplicada: PIN + cara listo y apagado; ${conteoDespues.empleados} expediente(s) sin cambios.`);
  }
} catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error(`[predeploy-134] FALLO: ${e.message}`); process.exitCode = 1; }
finally { await db.end().catch(() => {}); }
