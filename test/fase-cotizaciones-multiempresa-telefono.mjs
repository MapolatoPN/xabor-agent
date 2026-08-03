// Suite del Defecto 1 (hotfix cotizaciones-telefono-multiempresa-iva):
// "El sistema respondió que el número pertenece a otro negocio" al crear una
// cotización en Alora usando un teléfono que ya existía como cliente de
// Nonna Maye. Causa raíz: POST /api/cotizaciones reutilizaba
// obtenerPertenenciaConversacion() (pensada para proteger el HISTORIAL de
// chat, tablas `clientes`/`mensajes` con PK global por telefono) como gate
// de creación -- pero un mismo teléfono puede y debe poder ser cliente
// comercial de varios negocios a la vez. Esta suite prueba el contrato
// exigido:
//   - identidad comercial = (negocio_id, telefono), nunca telefono global;
//   - Alora y Nonna Maye quedan con cotizaciones/historial 100% independientes
//     aun compartiendo el mismo número de teléfono;
//   - crearCotizacion() nunca lee ni escribe clientes/perfiles_clientes --
//     no hay ninguna mezcla de datos posible al no bloquear por teléfono;
//   - ningún acceso cruzado entre negocios;
//   - teléfono duplicado DENTRO del mismo negocio (dos cotizaciones distintas
//     para el mismo cliente) se maneja con normalidad;
//   - ausencia de negocio_id en crearCotizacion() falla cerrado
//     (TENANT_CONTEXT_REQUIRED), nunca con un fallback implícito;
//   - la protección real de conversación cruzada (obtenerPertenenciaConversacion,
//     usada en /api/conversacion/:telefono/estado-bot) sigue intacta --
//     el hotfix solo quitó el uso INCORRECTO en cotizaciones, no la función.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4104';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool, crearCotizacion, crearUsuarioConPassword } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
function cookieHeader(usuarioId, negocioId, rol) { return `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`; }
async function api(base, path, { cookie, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}
async function fijarModulo(negocioId, modulo, estado) {
  await pool.query(
    `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
     ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`,
    [negocioId, modulo, estado]
  );
}

const TEL_COMPARTIDO = '5218789930099';
const TEL_REGRESION_CHAT = '5218789930098';

await fijarModulo(SEED.negocioA, 'cotizaciones', 'activo');
await fijarModulo(SEED.negocioA, 'generador_cotizaciones', 'activo');
await fijarModulo(SEED.negocioA, 'whatsapp', 'activo');
await fijarModulo(SEED.nonnaMayeId, 'cotizaciones', 'activo');
await fijarModulo(SEED.nonnaMayeId, 'generador_cotizaciones', 'activo');
await fijarModulo(SEED.nonnaMayeId, 'whatsapp', 'activo');

// Limpieza previa: ninguna cotización ni fila de clientes debe quedar de una
// corrida anterior para este teléfono, en ninguno de los dos negocios.
await pool.query(`DELETE FROM cotizaciones WHERE telefono = $1`, [TEL_COMPARTIDO]);
await pool.query(`DELETE FROM clientes WHERE telefono = $1`, [TEL_COMPARTIDO]);
await pool.query(`DELETE FROM usuarios WHERE email = 'admin-nonna-maye-defecto1@test.local'`);

const cookieAdminA = cookieHeader(SEED.adminNegocioAUsuarioId, SEED.negocioA, 'admin');
// El usuario "superadmin" del fixture solo tiene membresía real en negocioA
// -- para operar como admin de Nonna Maye en esta suite hace falta un
// usuario con membresía activa propia en ese negocio (mismo patrón que
// adminNegocioAUsuarioId en seed-datos-prueba.mjs).
const adminNonnaMaye = await crearUsuarioConPassword({
  negocioId: SEED.nonnaMayeId, nombre: 'Admin Nonna Maye (prueba)', email: 'admin-nonna-maye-defecto1@test.local',
  password: 'ClaveAdminNonnaMayePrueba123!', rol: 'admin',
});
const cookieAdminNonnaMaye = cookieHeader(adminNonnaMaye.id, SEED.nonnaMayeId, 'admin');

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });

function cuerpoCotizacion(nota) {
  return {
    telefono: TEL_COMPARTIDO,
    evento: { nombre: 'Evento de prueba', fecha: '2026-12-05', lugar: 'Salón', cantidadPersonas: 20 },
    notas: nota,
    items: [{ tipo: 'servicio', descripcion: 'Servicio de prueba', cantidad: 1, precioUnitario: 1000, descuento: 0 }],
  };
}

try {
  await t('DEFECTO-1', 'teléfono ya es cliente de Nonna Maye (clientes.negocio_id) -- precondición del bug reportado', async () => {
    await pool.query(
      `INSERT INTO clientes (telefono, nombre, negocio_id) VALUES ($1,'Cliente Nonna Maye',$2)
       ON CONFLICT (telefono) DO UPDATE SET negocio_id = $2`,
      [TEL_COMPARTIDO, SEED.nonnaMayeId]
    );
    const { rows } = await pool.query(`SELECT negocio_id FROM clientes WHERE telefono = $1`, [TEL_COMPARTIDO]);
    assert.strictEqual(rows[0].negocio_id, SEED.nonnaMayeId);
  });

  let cotizacionAlora;
  await t('DEFECTO-1', 'Alora SÍ puede crear cotización con ese mismo teléfono -- ya NO responde "pertenece a otro negocio"', async () => {
    const r = await api(srv.base, '/api/cotizaciones', { cookie: cookieAdminA, method: 'POST', body: cuerpoCotizacion('Cotización Alora') });
    assert.strictEqual(r.status, 200, `esperaba 200, obtuvo ${r.status}: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.negocio_id, SEED.negocioA);
    assert.strictEqual(r.body.telefono, TEL_COMPARTIDO);
    cotizacionAlora = r.body;
  });

  await t('DEFECTO-1', 'crearCotizacion() no tocó clientes -- la fila sigue atribuida a Nonna Maye, sin mezcla', async () => {
    const { rows } = await pool.query(`SELECT negocio_id FROM clientes WHERE telefono = $1`, [TEL_COMPARTIDO]);
    assert.strictEqual(rows[0].negocio_id, SEED.nonnaMayeId, 'crearCotizacion no debe escribir clientes/perfiles_clientes');
  });

  let cotizacionNonnaMaye;
  let folioMaxNonnaMayeAntes;
  await t('DEFECTO-1', 'Nonna Maye también puede crear su propia cotización con el mismo teléfono -- identidad independiente', async () => {
    const { rows: antes } = await pool.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(folio FROM 5) AS INTEGER)), 0)::int AS n FROM cotizaciones WHERE negocio_id = $1 AND folio ~ '^COT-[0-9]+$'`,
      [SEED.nonnaMayeId]
    );
    folioMaxNonnaMayeAntes = antes[0].n;
    const r = await api(srv.base, '/api/cotizaciones', { cookie: cookieAdminNonnaMaye, method: 'POST', body: cuerpoCotizacion('Cotización Nonna Maye') });
    assert.strictEqual(r.status, 200, `esperaba 200, obtuvo ${r.status}: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.negocio_id, SEED.nonnaMayeId);
    cotizacionNonnaMaye = r.body;
    assert.notStrictEqual(cotizacionNonnaMaye.id, cotizacionAlora.id, 'deben ser dos cotizaciones distintas, no la misma');
  });

  await t('DEFECTO-1', 'cada negocio tiene su propio contador de folio independiente (no un contador global compartido)', async () => {
    // No se asume que ambos negocios empiecen en COT-0001 (el negocio real
    // Nonna Maye puede ya tener cotizaciones previas de otras suites/corridas)
    // -- lo que importa es que crear una cotización en Alora no afectó el
    // contador de Nonna Maye, y que el folio de Nonna Maye avanzó exactamente
    // en 1 sobre SU PROPIO máximo anterior.
    const folioNumNonnaMaye = parseInt(cotizacionNonnaMaye.folio.slice(4), 10);
    assert.strictEqual(folioNumNonnaMaye, folioMaxNonnaMayeAntes + 1, 'el folio de Nonna Maye debe avanzar sobre su propio contador, ajeno al de Alora');
  });

  await t('AISLAMIENTO', 'Nonna Maye NO puede leer la cotización de Alora -> 403', async () => {
    const r = await api(srv.base, `/api/cotizaciones/${cotizacionAlora.id}`, { cookie: cookieAdminNonnaMaye });
    assert.strictEqual(r.status, 403);
  });

  await t('AISLAMIENTO', 'Alora NO puede leer la cotización de Nonna Maye -> 403', async () => {
    const r = await api(srv.base, `/api/cotizaciones/${cotizacionNonnaMaye.id}`, { cookie: cookieAdminA });
    assert.strictEqual(r.status, 403);
  });

  await t('AISLAMIENTO', 'listarCotizaciones(negocioA) solo trae la cotización de Alora, nunca la de Nonna Maye', async () => {
    const r = await api(srv.base, `/api/cotizaciones?telefono=${TEL_COMPARTIDO}`, { cookie: cookieAdminA });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.every(c => c.negocio_id === SEED.negocioA));
    assert.ok(r.body.some(c => c.id === cotizacionAlora.id));
    assert.ok(!r.body.some(c => c.id === cotizacionNonnaMaye.id));
  });

  await t('HISTORIAL', 'editar la cotización de Alora agrega historial solo bajo su propio cotizacion_id -- Nonna Maye no se ve afectada', async () => {
    const r = await api(srv.base, `/api/cotizaciones/${cotizacionAlora.id}`, {
      cookie: cookieAdminA, method: 'PATCH',
      body: { items: [...cuerpoCotizacion('x').items, { tipo: 'servicio', descripcion: 'Extra Alora', cantidad: 1, precioUnitario: 500, descuento: 0 }] },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.version, 2);

    const { rows: histAlora } = await pool.query(`SELECT * FROM cotizaciones_historial WHERE cotizacion_id = $1`, [cotizacionAlora.id]);
    assert.strictEqual(histAlora.length, 1);

    const { rows: histNonnaMaye } = await pool.query(`SELECT * FROM cotizaciones_historial WHERE cotizacion_id = $1`, [cotizacionNonnaMaye.id]);
    assert.strictEqual(histNonnaMaye.length, 0, 'editar Alora no debe crear historial para la cotización de Nonna Maye');

    const { rows: nonnaMayeSigueV1 } = await pool.query(`SELECT version FROM cotizaciones WHERE id = $1`, [cotizacionNonnaMaye.id]);
    assert.strictEqual(nonnaMayeSigueV1[0].version, 1, 'la cotización de Nonna Maye no debe cambiar de versión');
  });

  await t('DUPLICADO-MISMO-NEGOCIO', 'un segundo teléfono duplicado dentro del MISMO negocio (Alora) se maneja con normalidad', async () => {
    const r = await api(srv.base, '/api/cotizaciones', { cookie: cookieAdminA, method: 'POST', body: cuerpoCotizacion('Segunda cotización, mismo cliente de Alora') });
    assert.strictEqual(r.status, 200, `esperaba 200, obtuvo ${r.status}: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.negocio_id, SEED.negocioA);
    assert.notStrictEqual(r.body.id, cotizacionAlora.id);
    assert.notStrictEqual(r.body.folio, cotizacionAlora.folio, 'el folio debe avanzar dentro del mismo negocio, no colisionar');

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM cotizaciones WHERE negocio_id = $1 AND telefono = $2`, [SEED.negocioA, TEL_COMPARTIDO]);
    assert.strictEqual(rows[0].n, 2, 'Alora debe tener dos cotizaciones distintas para el mismo teléfono');
  });

  await t('TENANT_CONTEXT_REQUIRED', 'crearCotizacion() sin negocioId falla cerrado, nunca con un negocio por defecto', async () => {
    await assert.rejects(
      () => crearCotizacion({ telefono: TEL_COMPARTIDO, items: cuerpoCotizacion('x').items }),
      /TENANT_CONTEXT_REQUIRED/
    );
  });
  await t('TENANT_CONTEXT_REQUIRED', 'crearCotizacion() con negocioId vacío también falla cerrado', async () => {
    await assert.rejects(
      () => crearCotizacion({ negocioId: '  ', telefono: TEL_COMPARTIDO, items: cuerpoCotizacion('x').items }),
      /TENANT_CONTEXT_REQUIRED/
    );
  });

  await t('REGRESION', 'obtenerPertenenciaConversacion sigue protegiendo el chat real -- Nonna Maye no puede tomar/pausar una conversación real de Alora', async () => {
    // Este es el uso CORRECTO de la función que el hotfix dejó intacto:
    // protege el historial de WhatsApp por conversación, algo distinto de
    // "crear una cotización nueva" (que nunca debió depender de esto).
    // Usa un teléfono DISTINTO a TEL_COMPARTIDO a propósito: ese ya tiene
    // clientes.negocio_id = nonnaMayeId como precondición del Defecto 1 --
    // usarlo aquí mezclaría "Nonna Maye es dueña legítima de ese cliente en
    // la tabla legado" con lo que esta prueba quiere aislar (una conversación
    // que es inequívocamente de OTRO negocio).
    await pool.query(
      `INSERT INTO mensajes (telefono, direccion, texto, negocio_id, origen) VALUES ($1,'entrante','hola',$2,'cliente')`,
      [TEL_REGRESION_CHAT, SEED.negocioA]
    );
    const r = await api(srv.base, `/api/conversacion/${TEL_REGRESION_CHAT}/estado-bot`, { cookie: cookieAdminNonnaMaye });
    assert.strictEqual(r.status, 403, 'Nonna Maye no debe poder leer/controlar una conversación real que es de Alora');
  });
} finally {
  srv.detener();
  await pool.query(`DELETE FROM cotizaciones WHERE telefono = $1`, [TEL_COMPARTIDO]);
  await pool.query(`DELETE FROM clientes WHERE telefono = $1`, [TEL_COMPARTIDO]);
  await pool.query(`DELETE FROM mensajes WHERE telefono = ANY($1)`, [[TEL_COMPARTIDO, TEL_REGRESION_CHAT]]);
}

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('\nDetalle de fallos:'); fallos.forEach(f => console.log('  - ' + f)); }
await pool.end();
process.exit(fallidas > 0 ? 1 : 0);
