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
import { checkoutsSinPedidoOperativo, pagosSinPedidoOperativo } from './checkoutOperativo.mjs';

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
      // CUALQUIER bot de WhatsApp —el legacy (`bot_whatsapp_activo`) y el
      // Agente v1— vende solo la carta publicada para WhatsApp (098). Un
      // negocio que HOY vende su menú por WhatsApp y no tiene nada publicado
      // se quedaría sin carta en cuanto arranque el binario nuevo, así que la
      // liberación se detiene aquí, con el binario anterior vivo.
      //
      // Qué detiene: TODO bot encendido —agente o legacy— sin carta publicada.
      // En runtime, sin carta ningún bot contesta: la conversación pasa a una
      // persona (whatsapp-meta.js, «SIN CARTA PUBLICADA NO CONTESTA NINGÚN
      // BOT»). Liberar así cambiaría en silencio lo que vive el cliente de ese
      // negocio —de un bot que contesta a una conversación en espera—, con
      // productos en el menú (le quitaría lo que vende) o sin ellos (le
      // quitaría las respuestas). Esa decisión es del dueño y va ANTES:
      // publicar su carta o apagar su bot (ver la transición del documento).
      // `con_menu` solo distingue el mensaje.
      //
      // Es la única invariante nueva que el legacy estrena en este release:
      // por eso se comprueba sola y no se le aplica el resto del gate del agente.
      const { rows: sinCarta } = await db.query(`
        SELECT n.id::text AS negocio_id, n.nombre,
               EXISTS (SELECT 1 FROM configuracion cf
                        WHERE cf.negocio_id = n.id AND cf.clave = 'mesero_agente_v1'
                          AND lower(trim(cf.valor)) = 'true') AS agente,
               EXISTS (SELECT 1 FROM menu_productos p
                         JOIN menu_categorias c ON c.id = p.categoria_id AND c.negocio_id = p.negocio_id
                        WHERE p.negocio_id = n.id AND c.activa = TRUE
                          AND p.disponible IS NOT FALSE AND p.agotado IS NOT TRUE) AS con_menu
          FROM negocios n
         WHERE n.activo IS NOT FALSE
           AND (n.bot_whatsapp_activo IS TRUE OR EXISTS (
                 SELECT 1 FROM configuracion cf
                  WHERE cf.negocio_id = n.id AND cf.clave = 'mesero_agente_v1'
                    AND lower(trim(cf.valor)) = 'true'))
           AND NOT EXISTS (
                 SELECT 1 FROM whatsapp_productos wp
                   JOIN menu_productos p ON p.id = wp.producto_id AND p.negocio_id = wp.negocio_id
                   JOIN menu_categorias c ON c.id = p.categoria_id AND c.negocio_id = p.negocio_id
                  WHERE wp.negocio_id = n.id AND wp.publicado = TRUE AND c.activa = TRUE
                    AND p.disponible IS NOT FALSE AND p.agotado IS NOT TRUE)
         ORDER BY n.nombre, n.id`);
      const bloqueantes = sinCarta;
      if (bloqueantes.length) {
        for (const r of bloqueantes) {
          console.error(`FALLO  ${r.nombre} (${r.negocio_id}): bot de WhatsApp encendido`
            + `${r.agente ? ' (agente)' : ' (legacy)'} sin carta publicada para WhatsApp`
            + (r.con_menu ? '' : ' (y sin productos en su menú: con este release no le contestaría a nadie)'));
        }
        console.error('Ver docs/mesero-pedido-canonico.md, «Transición de los negocios con bot legacy».');
        await db.end();
        process.exit(1);
      }
      console.log('OK  todo negocio con un bot de WhatsApp encendido tiene carta publicada para WhatsApp');

      // El menú en imagen solo sale revisado contra la carta vigente (100). Sin
      // la función, el binario nuevo mandaría el menú en texto a TODOS (fallo
      // cerrado, pero una regresión visible): se exige. Un menú activo sin
      // revisar NO bloquea —sus clientes reciben el menú en texto desde la
      // carta, que es lo seguro—, pero se avisa para que el dueño lo revise.
      const { rows: [fnRevision] } = await db.query(
        `SELECT to_regprocedure('public.estado_revision_menu_whatsapp(uuid,text[])') IS NOT NULL AS existe`);
      if (!fnRevision.existe) {
        console.error('FALLO  falta estado_revision_menu_whatsapp (migración 100): el menú en imagen no se podría verificar');
        await db.end();
        process.exit(1);
      }
      console.log('OK  revisión del menú en imagen contra la carta (100) disponible');
      const { rows: menusSinRevisar } = await db.query(`
        SELECT n.nombre, n.id::text AS negocio_id, estado_revision_menu_whatsapp(n.id) AS estado
          FROM whatsapp_menu_automatico m
          JOIN negocios n ON n.id = m.negocio_id
         WHERE m.activo = TRUE AND n.activo IS NOT FALSE AND n.bot_whatsapp_activo IS TRUE
           AND estado_revision_menu_whatsapp(n.id) <> 'vigente'
         ORDER BY n.nombre, n.id`);
      for (const r of menusSinRevisar) {
        console.log(`AVISO  ${r.nombre} (${r.negocio_id}): menú en imagen activo sin revisar contra la carta `
          + `(${r.estado}); sus clientes reciben el menú en texto hasta que el administrador lo revise`);
      }
      const { rows } = await db.query(`
        SELECT DISTINCT negocio_id::text
          FROM configuracion
         WHERE clave='mesero_agente_v1' AND lower(trim(valor))='true'
         ORDER BY negocio_id::text`);
      if (!rows.length) {
        console.log('Gate DB: no hay negocios con el agente activo; no existen tenants productivos que validar.');
        await db.end();
        process.exit(0);
      }
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
        to_regclass('public.whatsapp_productos') IS NOT NULL AS catalogo_whatsapp,
        to_regclass('public.agente_turnos') IS NOT NULL AS turnos,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
          AND table_name='agente_outbox' AND column_name='turno_clave') AS outbox_por_turno,
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
    exigir(schema.catalogo_whatsapp, 'tabla de publicación del catálogo de WhatsApp (098)');
    exigir(schema.turnos && schema.outbox_por_turno, 'traza de turnos y respuestas en el outbox (099)');
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

    // El agente solo conoce la carta PUBLICADA para WhatsApp: con el agente
    // encendido y nada publicado, cada conversación terminaría en una persona.
    if (schema.catalogo_whatsapp) {
      const { rows: [cartaWhatsapp] } = await db.query(`
        SELECT count(DISTINCT c.id)::int AS categorias, count(p.id)::int AS productos
          FROM whatsapp_productos wp
          JOIN menu_productos p ON p.id=wp.producto_id AND p.negocio_id=wp.negocio_id
          JOIN menu_categorias c ON c.id=p.categoria_id AND c.negocio_id=p.negocio_id
         WHERE wp.negocio_id=$1 AND wp.publicado=TRUE AND c.activa=TRUE
           AND p.disponible IS NOT FALSE AND p.agotado IS NOT TRUE`, [negocioId]);
      exigir(cartaWhatsapp.categorias > 0 && cartaWhatsapp.productos > 0,
        `carta publicada para WhatsApp (${cartaWhatsapp.categorias} categorías, ${cartaWhatsapp.productos} productos)`);
    }

    const tiendasSinPedido = await checkoutsSinPedidoOperativo(db, negocioId);
    exigir(tiendasSinPedido.length === 0,
      tiendasSinPedido.length ? `tienda sin pedido operativo: ${tiendasSinPedido.map(r => r.pedido_folio).join(', ')}`
        : 'cada checkout reciente conserva su fila de pedido');

    const pagosSinDerivar = await pagosSinPedidoOperativo(db, negocioId);
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
