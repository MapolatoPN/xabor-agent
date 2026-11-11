// Descuento al abrir para quien escribió en horario habitual con el negocio
// cerrado: encender, apagar y revisar POR NEGOCIO. Ver docs/descuento-tras-cierre.md.
//
//   node scripts/ops/descuento-tras-cierre-2026-11/descuento.mjs estado
//   node scripts/ops/descuento-tras-cierre-2026-11/descuento.mjs estado --negocio=mapolato-acuna
//   node scripts/ops/descuento-tras-cierre-2026-11/descuento.mjs activar --negocio=mapolato-acuna              (simulacro)
//   node scripts/ops/descuento-tras-cierre-2026-11/descuento.mjs activar --negocio=mapolato-acuna --aplicar
//   node scripts/ops/descuento-tras-cierre-2026-11/descuento.mjs desactivar --negocio=mapolato-acuna --aplicar
//   node scripts/ops/descuento-tras-cierre-2026-11/descuento.mjs desactivar --negocio=mapolato-acuna --tambien-codigo --aplicar
//
// `activar` (por omisión --codigo=DOMINGO15 --porcentaje=15, decisión de
// Mario del 10-nov-2026):
//   1. Si el negocio ya tiene una promoción con ese código, la usa TAL CUAL;
//      si no la tiene, la crea: un uso por cliente, solo tienda en línea, no
//      acumulable (con otra promoción el cliente se queda con la que más le
//      conviene), sin vigencia ni límite total. Los mismos campos que guarda
//      la pantalla de Promociones (guardarPromocion).
//   2. Escribe `cerrado_descuento_codigo` en la configuración del negocio.
//   3. Dentro de la misma transacción pregunta al JOB REAL (evaluarNegocio)
//      si con eso mandaría; si el job no podría (sin horario propio, código
//      que no sirve, tienda sin publicar), aborta y no guarda nada.
// `desactivar` borra esa fila: el job deja de mandar. La promoción se queda
// activa para quien ya recibió el código, salvo con --tambien-codigo.
//
// SIMULACRO por omisión (la transacción termina en ROLLBACK); con --aplicar
// confirma y antes guarda lo anterior en --respaldo=<dir> (por omisión
// C:/xabor-respaldos/descuento-tras-cierre-2026-11). Nada de credenciales,
// mensajes, pagos ni pedidos: este script no manda nada a nadie.
import pg from 'pg';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CLAVE = 'cerrado_descuento_codigo';
const argv = process.argv.slice(2);
const valor = (k) => (argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3);
const comando = argv.find((a) => !a.startsWith('--')) || 'estado';
const aplicar = argv.includes('--aplicar');
const tambienCodigo = argv.includes('--tambien-codigo');
const negocioArg = valor('negocio').trim();
const codigo = (valor('codigo') || 'DOMINGO15').trim().toUpperCase();
const porcentaje = Number(valor('porcentaje') || 15);
const respaldo = valor('respaldo') || 'C:/xabor-respaldos/descuento-tras-cierre-2026-11';

if (!['estado', 'activar', 'desactivar'].includes(comando)) {
  console.error(`Comando desconocido: ${comando}. Usa estado | activar | desactivar`); process.exit(2);
}
if (comando !== 'estado' && !negocioArg) { console.error('Falta --negocio=<slug del negocio o de su tienda>'); process.exit(2); }
// El mismo formato que acepta la pantalla de Promociones.
if (!/^[A-Z0-9][A-Z0-9._-]{1,29}$/.test(codigo)) { console.error(`Código inválido: ${codigo}`); process.exit(2); }
if (!(porcentaje >= 1 && porcentaje <= 100)) { console.error('El porcentaje debe estar entre 1 y 100'); process.exit(2); }
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL requerida'); process.exit(2); }

// El job real: lo que diga aquí es lo que hará el servidor. Importarlo abre el
// pool de la app (lo usa para leer el horario y la tienda); se cierra al final.
const { evaluarNegocio, reglasPropias } = await import('../../../src/services/descuentoTrasCierre.js');
const { pool: poolApp } = await import('../../../src/services/database.js');

const host = new URL(process.env.DATABASE_URL).hostname;
const local = ['localhost', '127.0.0.1', '::1'].includes(host);
console.log(`[descuento-cierre] base: ${host}${local ? ' (local)' : ''}`);
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false } });
await c.connect();

const SQL_NEGOCIOS = `
  SELECT n.id, n.slug, n.nombre, tc.slug_publico, tc.estado AS tienda,
         (SELECT valor FROM configuracion WHERE negocio_id = n.id AND clave = '${CLAVE}') AS codigo
    FROM negocios n LEFT JOIN tienda_config tc ON tc.negocio_id = n.id
   WHERE ($1 = '' AND tc.negocio_id IS NOT NULL) OR n.slug = $1 OR tc.slug_publico = $1
   ORDER BY n.nombre`;
const SQL_PROMO = `
  SELECT id, nombre, tipo, codigo, valor, activa, automatica, usos, limite_usos, limite_por_cliente
    FROM tienda_promociones WHERE negocio_id = $1 AND lower(codigo) = lower($2)
   ORDER BY created_at DESC LIMIT 1`;
// Lo que el job no podría arreglar solo. «cerrado_ahora» no está: es lo
// normal si se activa en domingo, y el job mandará al abrir.
const BLOQUEAN = {
  sin_horario_propio: 'el negocio no tiene su horario guardado: el job no sabría cuándo estuvo cerrado',
  codigo_no_vigente: 'la promoción del código no sirve (inactiva, automática, de otro canal, vencida o sin cupo)',
  promocion_que_no_se_dice: 'la promoción no es de porcentaje ni de monto fijo: el mensaje no podría decir cuánto descuenta',
  tienda_sin_publicar: 'la tienda en línea no está publicada: el código no se podría usar',
};

const descPromo = (p) => (p ? `${p.codigo} · ${p.tipo === 'porcentaje' ? `${Number(p.valor)} %` : `${p.tipo} ${Number(p.valor)}`} · `
  + `${p.activa ? 'activa' : 'INACTIVA'}${p.automatica ? ' · AUTOMÁTICA' : ''} · usos ${p.usos}${p.limite_usos != null ? `/${p.limite_usos}` : ''} · `
  + `${p.limite_por_cliente ?? 'sin límite'} por cliente` : 'no existe');

async function hayTabla136() {
  const { rows: [r] } = await c.query("SELECT to_regclass('public.descuento_tras_cierre_envios') IS NOT NULL AS hay");
  return r.hay === true;
}

/** Lo que haría el job ahora mismo con ese negocio. */
async function vistaDelJob(f) {
  if (!f.codigo) return { razon: 'apagado', texto: 'apagado' };
  const ev = await evaluarNegocio(c, f.id, String(f.codigo).trim().toUpperCase());
  const mandaria = ev.decisiones.filter((d) => d.enviar).length;
  const texto = ev.listo
    ? `listo; si corriera ahora mandaría a ${mandaria} (de ${ev.decisiones.length} que escribieron en el cierre)`
    : ev.razon === 'cerrado_ahora' ? 'listo; el negocio está cerrado ahora: manda al abrir'
      : `NO MANDARÍA: ${BLOQUEAN[ev.razon] || ev.razon}`;
  return { razon: ev.razon, texto, mandaria };
}

async function pintar(filas, tabla136) {
  for (const f of filas) {
    const p = f.codigo ? (await c.query(SQL_PROMO, [f.id, f.codigo])).rows[0] : null;
    const envios = tabla136 ? (await c.query(`SELECT estado, COUNT(*)::int n FROM descuento_tras_cierre_envios
        WHERE negocio_id = $1 GROUP BY estado ORDER BY estado`, [f.id])).rows : null;
    const horario = (await reglasPropias(c, f.id)) ? 'propio' : 'SIN HORARIO PROPIO';
    console.log(`- ${f.nombre} (${f.slug}${f.slug_publico && f.slug_publico !== f.slug ? ` / tienda ${f.slug_publico}` : ''})`
      + `\n    tienda ${f.tienda || 'sin tienda'} · horario ${horario}`
      + `\n    descuento: ${f.codigo ? `ENCENDIDO con ${f.codigo} (${descPromo(p)})` : 'apagado'}`
      + `\n    job: ${(await vistaDelJob(f)).texto}`
      + `\n    enviados: ${envios ? (envios.map((e) => `${e.estado} ${e.n}`).join(', ') || 'ninguno') : 'falta la migración 136'}`);
  }
}

try {
  await c.query('BEGIN');
  await c.query("SET LOCAL lock_timeout = '5s'");
  const tabla136 = await hayTabla136();
  const { rows } = await c.query(SQL_NEGOCIOS, [negocioArg]);
  if (!rows.length) throw new Error(negocioArg ? `no existe el negocio ${negocioArg}` : 'no hay negocios con tienda');
  if (comando === 'estado') {
    await pintar(rows, tabla136);
    await c.query('ROLLBACK');
  } else {
    if (rows.length !== 1) throw new Error(`--negocio=${negocioArg} resuelve a ${rows.length} negocios: debe ser uno`);
    // Primero el despliegue (que trae la 136 y el job), después encender.
    if (!tabla136) throw new Error('falta la migración 136: primero se despliega, después se enciende');
    const [n] = rows;
    console.log('ANTES:'); await pintar(rows, tabla136);
    const registro = { negocio_id: n.id, slug: n.slug, comando, clave: CLAVE, valor_anterior: n.codigo ?? null };
    if (comando === 'activar') {
      if (n.tienda !== 'publicada') throw new Error(`la tienda de ${n.slug} está «${n.tienda || 'sin tienda'}»: el código no se podría usar`);
      const { rows: [existente] } = await c.query(SQL_PROMO, [n.id, codigo]);
      if (existente) {
        console.log(`Se usa la promoción que ya existía: ${descPromo(existente)}`);
        registro.promocion = { id: existente.id, creada: false };
      } else {
        const { rows: [nueva] } = await c.query(`
          INSERT INTO tienda_promociones (negocio_id, nombre, tipo, codigo, automatica, valor, minimo_compra,
                 limite_por_cliente, solo_primera_compra, canales, acumulable, prioridad, activa)
          VALUES ($1, $2, 'porcentaje', $3, false, $4, 0, 1, false, '["tienda_online"]'::jsonb, false, 100, true)
          RETURNING id`, [n.id, `Disculpa por cierre (${porcentaje} %)`, codigo, porcentaje]);
        console.log(`Se crea la promoción ${codigo}: ${porcentaje} %, un uso por cliente, solo tienda en línea.`);
        registro.promocion = { id: nueva.id, creada: true };
      }
      await c.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,$2,$3)
                     ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $3`, [n.id, CLAVE, codigo]);
      registro.valor_nuevo = codigo;
      const vista = await vistaDelJob({ ...n, codigo });
      if (BLOQUEAN[vista.razon]) throw new Error(`el job no podría mandar: ${BLOQUEAN[vista.razon]}`);
      if (vista.mandaria) console.log(`OJO: el negocio está abierto y hay ${vista.mandaria} por mandar: el job los manda en su siguiente minuto.`);
    } else {
      await c.query('DELETE FROM configuracion WHERE negocio_id = $1 AND clave = $2', [n.id, CLAVE]);
      registro.valor_nuevo = null;
      if (tambienCodigo && n.codigo) {
        const { rows: [p] } = await c.query(SQL_PROMO, [n.id, n.codigo]);
        if (p?.activa) {
          await c.query('UPDATE tienda_promociones SET activa = false, updated_at = NOW() WHERE id = $1', [p.id]);
          registro.promocion_desactivada = p.id;
          console.log(`Se desactiva la promoción ${p.codigo}: quien ya recibió el código ya no podrá usarlo.`);
        }
      }
    }
    const { rows: despues } = await c.query(SQL_NEGOCIOS, [n.slug]);
    console.log('DESPUÉS:'); await pintar(despues, tabla136);
    if (aplicar) {
      mkdirSync(respaldo, { recursive: true });
      const ruta = join(respaldo, `${comando}-${n.slug}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      writeFileSync(ruta, JSON.stringify(registro, null, 2));
      console.log(`respaldo: ${ruta}`);
      await c.query('COMMIT');
      console.log('[descuento-cierre] APLICADO. El job lo lee en su siguiente corrida (cada minuto): no requiere despliegue.');
    } else {
      await c.query('ROLLBACK');
      console.log('[descuento-cierre] SIMULACRO: nada se guardó. Repite con --aplicar para confirmar.');
    }
  }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`[descuento-cierre] ABORTADO, nada se guardó: ${e.message}`);
  process.exitCode = 1;
} finally {
  await c.end().catch(() => {});
  await poolApp.end().catch(() => {});
}
