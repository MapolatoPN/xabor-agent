// Barrera de solo lectura para liberar Xabor a producción.
//
// Uso completo (incluye login real, menú e historial):
//   DATABASE_URL=... XABOR_SMOKE_NEGOCIO_ID=... XABOR_BASE_URL=https://xabor.mx \
//   XABOR_SMOKE_EMAIL=... XABOR_SMOKE_PASSWORD=... npm run release:gate
//
// Diagnóstico de base sin credenciales HTTP:
//   ... npm run release:gate -- --db-only
//
// No crea pedidos, no cambia estados y no imprime. Todas las consultas de DB
// corren dentro de una transacción READ ONLY. La sesión de humo se cierra al
// final. Cualquier invariante rota termina con exit 1 para bloquear la salida.
import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = new Set(process.argv.slice(2));
const dbOnly = args.has('--db-only');
const todosLosAgentes = args.has('--all-agent-businesses');
const databaseUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
const negocioId = String(process.env.XABOR_SMOKE_NEGOCIO_ID || '').trim();
const baseUrl = String(process.env.XABOR_BASE_URL || 'https://xabor.mx').replace(/\/+$/, '');
const email = process.env.XABOR_SMOKE_EMAIL;
const password = process.env.XABOR_SMOKE_PASSWORD;
const fallos = [];
const exitos = [];

const exigir = (condicion, mensaje) => {
  if (condicion) exitos.push(mensaje);
  else fallos.push(mensaje);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

if (!databaseUrl) fallos.push('Falta DATABASE_URL o DATABASE_PUBLIC_URL');

// El predeploy no depende de una variable por negocio: descubre todos los que
// tienen el agente encendido y ejecuta este mismo gate, aislado, para cada uno.
// La modalidad completa HTTP sí exige un negocio concreto y credenciales.
if (todosLosAgentes) {
  if (!dbOnly) fallos.push('--all-agent-businesses solo se permite con --db-only');
  if (!fallos.length) {
    const host = new URL(databaseUrl).hostname;
    const ssl = ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false };
    const db = new pg.Client({ connectionString: databaseUrl, ssl });
    try {
      await db.connect();
      const { rows } = await db.query(`
        SELECT DISTINCT negocio_id::text
          FROM configuracion
         WHERE clave='mesero_agente_v1' AND lower(trim(valor))='true'
         ORDER BY negocio_id::text`);
      if (!rows.length) throw new Error('no hay ningún negocio con mesero_agente_v1=true');
      console.log(`Gate DB para ${rows.length} negocio(s) con agente activo.`);
      for (const row of rows) {
        execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--db-only'], {
          stdio: 'inherit',
          env: { ...process.env, XABOR_SMOKE_NEGOCIO_ID: row.negocio_id },
        });
      }
      await db.end();
      process.exit(0);
    } catch (e) {
      await db.end().catch(() => {});
      console.error(`FALLO  gate de negocios con agente: ${e.message}`);
      process.exit(1);
    }
  }
  for (const mensaje of fallos) console.error(`FALLO  ${mensaje}`);
  process.exit(1);
}

if (!uuid.test(negocioId)) fallos.push('Falta XABOR_SMOKE_NEGOCIO_ID válido');

if (!fallos.length) {
  const host = new URL(databaseUrl).hostname;
  const ssl = ['localhost', '127.0.0.1', '::1'].includes(host) ? false : { rejectUnauthorized: false };
  const db = new pg.Client({ connectionString: databaseUrl, ssl });
  try {
    await db.connect();
    await db.query('BEGIN READ ONLY');

    const { rows: [schema] } = await db.query(`
      SELECT
        to_regclass('public.agente_operaciones') IS NOT NULL AS operaciones,
        to_regclass('public.agente_outbox') IS NOT NULL AS outbox,
        to_regclass('public.whatsapp_entradas') IS NOT NULL AS entradas,
        EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
          AND indexname='uq_agente_confirmacion_conversacion' AND indexdef ILIKE '%UNIQUE%') AS confirmacion_unica,
        EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
          AND tablename='whatsapp_entradas' AND indexdef ILIKE '%UNIQUE%negocio_id%wamid%') AS entrada_unica,
        EXISTS (SELECT 1 FROM pg_trigger
          WHERE tgrelid='pedidos_activos'::regclass
            AND tgname='trg_pedidos_activos_estado_json'
            AND NOT tgisinternal AND tgenabled <> 'D') AS estado_pedido_autoritativo
    `);
    exigir(schema.operaciones && schema.outbox && schema.entradas,
      'tablas durables del agente, outbox y WhatsApp');
    exigir(schema.confirmacion_unica, 'confirmación única por ciclo de conversación');
    exigir(schema.entrada_unica, 'deduplicación durable por wamid');
    exigir(schema.estado_pedido_autoritativo,
      'estado SQL autoritativo protegido en pedidos activos');

    const { rows: estadosDesalineados } = await db.query(`
      SELECT folio, estado, datos->>'estado' AS estado_json
        FROM pedidos_activos
       WHERE negocio_id=$1
         AND (estado IS NULL OR datos->>'estado' IS DISTINCT FROM estado)
       LIMIT 10`, [negocioId]);
    exigir(estadosDesalineados.length === 0,
      estadosDesalineados.length
        ? `pedidos con estado SQL/JSON desalineado: ${estadosDesalineados.map(r => r.folio).join(', ')}`
        : 'estado SQL y fotografía JSON de pedidos alineados');

    const { rows: [menu] } = await db.query(`
      SELECT count(DISTINCT c.id)::int AS categorias, count(p.id)::int AS productos
        FROM menu_categorias c
        LEFT JOIN menu_productos p ON p.categoria_id=c.id AND p.negocio_id=c.negocio_id
          AND p.disponible IS NOT FALSE
       WHERE c.negocio_id=$1 AND c.activa=TRUE`, [negocioId]);
    exigir(menu.categorias > 0 && menu.productos > 0,
      `carta activa en DB (${menu.categorias} categorías, ${menu.productos} productos)`);

    const { rows: tiendasSinPedido } = await db.query(`
      SELECT tp.pedido_folio
        FROM tienda_pedidos tp
        LEFT JOIN pedidos_activos pa ON pa.negocio_id=tp.negocio_id AND pa.folio=tp.pedido_folio
       WHERE tp.negocio_id=$1 AND tp.pedido_folio IS NOT NULL
         AND tp.created_at >= now() - interval '48 hours' AND pa.folio IS NULL
       LIMIT 10`, [negocioId]);
    exigir(tiendasSinPedido.length === 0,
      tiendasSinPedido.length ? `tienda sin pedido operativo: ${tiendasSinPedido.map(r => r.pedido_folio).join(', ')}`
        : 'cada checkout reciente conserva su fila de pedido');

    const { rows: pagosSinDerivar } = await db.query(`
      SELECT p.pedido_folio, pa.estado
        FROM pagos p
        LEFT JOIN pedidos_activos pa ON pa.negocio_id=p.negocio_id AND pa.folio=p.pedido_folio
       WHERE p.negocio_id=$1 AND p.estado='pagado' AND p.created_at >= now() - interval '48 hours'
         AND (pa.folio IS NULL OR pa.estado='pendiente_pago'
           OR COALESCE((pa.datos->>'pago_confirmado')::boolean,FALSE)=FALSE)
       LIMIT 10`, [negocioId]);
    exigir(pagosSinDerivar.length === 0,
      pagosSinDerivar.length ? `pago confirmado sin derivar: ${pagosSinDerivar.map(r => r.pedido_folio).join(', ')}`
        : 'pagos recientes reflejados en el pedido');

    const { rows: duplicados } = await db.query(`
      SELECT a.folio AS primero, b.folio AS segundo
        FROM pedidos_activos a
        JOIN pedidos_activos b ON b.negocio_id=a.negocio_id AND b.folio>a.folio
          AND b.created_at BETWEEN a.created_at AND a.created_at + interval '5 minutes'
          AND b.datos->'items'=a.datos->'items'
          AND b.datos->>'total'=a.datos->>'total'
          AND COALESCE(b.datos->'cliente'->>'telefono',b.datos->>'telefono_conversacion')
            = COALESCE(a.datos->'cliente'->>'telefono',a.datos->>'telefono_conversacion')
       WHERE a.negocio_id=$1 AND a.created_at >= now() - interval '24 hours'
         AND a.datos->>'canal'='whatsapp'
         AND a.estado<>'cancelado' AND b.estado<>'cancelado'
       LIMIT 10`, [negocioId]);
    exigir(duplicados.length === 0,
      duplicados.length ? `posible doble pedido vivo: ${duplicados.map(r => `${r.primero}/${r.segundo}`).join(', ')}`
        : 'sin pares de WhatsApp idénticos vivos en cinco minutos');

    await db.query('ROLLBACK');
  } catch (e) {
    fallos.push(`verificación DB: ${e.message}`);
    await db.query('ROLLBACK').catch(() => {});
  } finally {
    await db.end().catch(() => {});
  }
}

if (!dbOnly) {
  try {
    const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(10000) });
    const body = health.ok ? await health.json() : {};
    exigir(health.ok && body.status === 'ok' && body.listo === true, 'servidor desplegado y listo');
  } catch (e) { fallos.push(`healthcheck: ${e.message}`); }

  if (!email || !password) {
    fallos.push('Faltan XABOR_SMOKE_EMAIL y XABOR_SMOKE_PASSWORD para comprobar sesión, menú e historial');
  } else {
    let cookie = null;
    try {
      const login = await fetch(`${baseUrl}/api/auth/negocio/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, negocioId }), signal: AbortSignal.timeout(15000),
      });
      const loginBody = await login.json().catch(() => ({}));
      const setCookie = typeof login.headers.getSetCookie === 'function'
        ? login.headers.getSetCookie().join(',') : login.headers.get('set-cookie');
      cookie = String(setCookie || '').match(/(?:^|,\s*)(xabor_sesion=[^;]+)/)?.[1] || null;
      exigir(login.ok && loginBody.ok === true && !!cookie, 'login real del negocio');

      if (cookie) {
        const get = async (ruta) => {
          const r = await fetch(`${baseUrl}${ruta}`, {
            headers: { cookie }, signal: AbortSignal.timeout(15000), redirect: 'manual',
          });
          return { r, body: await r.json().catch(() => null) };
        };
        const [me, menu, historial] = await Promise.all([get('/api/auth/me'), get('/api/menu'), get('/api/historial')]);
        exigir(me.r.ok && me.body?.negocioId === negocioId, 'sesión permanece en el negocio correcto');
        const productos = Array.isArray(menu.body)
          ? menu.body.reduce((n, c) => n + (Array.isArray(c.productos) ? c.productos.length : 0), 0) : 0;
        exigir(menu.r.ok && productos > 0, `menú HTTP disponible (${productos} productos)`);
        exigir(historial.r.ok && Array.isArray(historial.body), 'historial HTTP disponible');

        await fetch(`${baseUrl}/api/auth/negocio/logout`, {
          method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}',
          signal: AbortSignal.timeout(10000),
        }).catch(() => {});
      }
    } catch (e) { fallos.push(`humo autenticado: ${e.message}`); }
  }
}

for (const mensaje of exitos) console.log(`OK  ${mensaje}`);
for (const mensaje of fallos) console.error(`FALLO  ${mensaje}`);
console.log(`Resultado: ${exitos.length} comprobaciones correctas, ${fallos.length} fallos.`);
process.exit(fallos.length ? 1 : 0);
