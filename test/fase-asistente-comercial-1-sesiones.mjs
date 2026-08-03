// Fase 1 del Asistente Comercial de Cotizaciones por WhatsApp:
// sesionComercial.js (máquina de estados durable, aislamiento por
// negocio_id+telefono) + intentDetector.js (clasificación de intención,
// reglas de activación en código).
//
// No requiere servidor HTTP -- son servicios puros llamados directamente,
// mismo criterio que las pruebas [TENANT-CONTEXT] de fase-pagos-multiempresa.mjs.
// No llama a la API real de Anthropic para las rutas donde el propio
// diseño ya evita la llamada (moduloHabilitado=false) o donde el fallo de
// la llamada (sin ANTHROPIC_API_KEY real) es en sí mismo el comportamiento
// fail-closed que se está probando.
//
// Uso: DATABASE_URL=... node test/fase-asistente-comercial-1-sesiones.mjs
// Requiere aplicar-migraciones.mjs y seed-datos-prueba.mjs ya corridos.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const NEGOCIO_A = SEED.negocioA;
const NEGOCIO_B = SEED.negocioB;

const { pool, crearCotizacion } = await import('../src/services/database.js');
const { TenantContextRequiredError } = await import('../src/services/integracionesService.js');
const {
  obtenerSesionActiva, obtenerSesion, obtenerOCrearSesionActiva, actualizarCamposSesion,
  cambiarEstadoSesion, vincularCotizacion, finalizarSesion, obtenerSesionPorCotizacion,
} = await import('../src/services/sesionComercial.js');
const { detectarIntencionComercial, activaModoComercial, CATEGORIAS_INTENCION } = await import('../src/agent/intentDetector.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(categoria, nombre, fn) {
  try { await fn(); console.log(`  OK  [${categoria}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${categoria}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${categoria}] ${nombre}: ${e.message}`); }
}

const TEL_1 = '+528781110001';
const TEL_2 = '+528781110002';
const TEL_3 = '+528781110003';

// ═══════════ TENANT-CONTEXT: fail-closed sin negocioId ═══════════

await t('TENANT-CONTEXT', 'obtenerSesionActiva sin negocioId -> TenantContextRequiredError', async () => {
  await assert.rejects(() => obtenerSesionActiva(undefined, TEL_1), TenantContextRequiredError);
});
await t('TENANT-CONTEXT', 'obtenerSesion sin negocioId -> TenantContextRequiredError', async () => {
  await assert.rejects(() => obtenerSesion('00000000-0000-0000-0000-000000000000', ''), TenantContextRequiredError);
});
await t('TENANT-CONTEXT', 'obtenerOCrearSesionActiva sin negocioId -> TenantContextRequiredError', async () => {
  await assert.rejects(() => obtenerOCrearSesionActiva(null, TEL_1), TenantContextRequiredError);
});
await t('TENANT-CONTEXT', 'actualizarCamposSesion sin negocioId -> TenantContextRequiredError', async () => {
  await assert.rejects(() => actualizarCamposSesion('00000000-0000-0000-0000-000000000000', undefined, { nombre: 'x' }), TenantContextRequiredError);
});
await t('TENANT-CONTEXT', 'cambiarEstadoSesion sin negocioId -> TenantContextRequiredError', async () => {
  await assert.rejects(() => cambiarEstadoSesion('00000000-0000-0000-0000-000000000000', null, 'finalizada'), TenantContextRequiredError);
});
await t('TENANT-CONTEXT', 'finalizarSesion sin negocioId -> TenantContextRequiredError', async () => {
  await assert.rejects(() => finalizarSesion('00000000-0000-0000-0000-000000000000', '', 'aprobada'), TenantContextRequiredError);
});

// ═══════════ CICLO DE VIDA ═══════════

let sesionId;
await t('CICLO', 'obtenerOCrearSesionActiva crea con estado inicial descubriendo_necesidad', async () => {
  const sesion = await obtenerOCrearSesionActiva(NEGOCIO_A, TEL_1);
  assert.strictEqual(sesion.estado, 'descubriendo_necesidad');
  assert.deepStrictEqual(sesion.campos_capturados, {});
  assert.strictEqual(sesion.negocio_id, NEGOCIO_A);
  sesionId = sesion.id;
});

await t('CICLO', 'obtenerOCrearSesionActiva es idempotente -- reutiliza la misma sesión activa', async () => {
  const sesion2 = await obtenerOCrearSesionActiva(NEGOCIO_A, TEL_1);
  assert.strictEqual(sesion2.id, sesionId);
});

await t('CICLO', 'actualizarCamposSesion fusiona campos sin perder los anteriores', async () => {
  await actualizarCamposSesion(sesionId, NEGOCIO_A, { cantidad_personas: 150 });
  const s1 = await obtenerSesion(sesionId, NEGOCIO_A);
  assert.strictEqual(s1.campos_capturados.cantidad_personas, 150);

  await actualizarCamposSesion(sesionId, NEGOCIO_A, { tipo_evento: 'boda', fecha_evento: '2026-09-20' });
  const s2 = await obtenerSesion(sesionId, NEGOCIO_A);
  assert.strictEqual(s2.campos_capturados.cantidad_personas, 150, 'no debe perderse el campo capturado en el turno anterior');
  assert.strictEqual(s2.campos_capturados.tipo_evento, 'boda');
  assert.strictEqual(s2.campos_capturados.fecha_evento, '2026-09-20');
});

await t('CICLO', 'cambiarEstadoSesion transiciona correctamente', async () => {
  const s = await cambiarEstadoSesion(sesionId, NEGOCIO_A, 'construyendo_borrador');
  assert.strictEqual(s.estado, 'construyendo_borrador');
});

await t('CICLO', 'cambiarEstadoSesion rechaza un estado inválido', async () => {
  await assert.rejects(() => cambiarEstadoSesion(sesionId, NEGOCIO_A, 'estado_inventado'));
});

let cotizacionFixture;
await t('CICLO', 'vincularCotizacion asocia una cotización real a la sesión', async () => {
  cotizacionFixture = await crearCotizacion({
    negocioId: NEGOCIO_A, telefono: TEL_1, createdBy: null,
    items: [{ tipo: 'servicio', descripcion: 'Banquete de prueba', cantidad: 1, precioUnitario: 0 }],
  });
  const s = await vincularCotizacion(sesionId, NEGOCIO_A, cotizacionFixture.id);
  assert.strictEqual(s.cotizacion_id, cotizacionFixture.id);
});

await t('CICLO', 'obtenerSesionPorCotizacion encuentra la sesión vinculada', async () => {
  const s = await obtenerSesionPorCotizacion(cotizacionFixture.id, NEGOCIO_A);
  assert.strictEqual(s.id, sesionId);
});

await t('CICLO', 'finalizarSesion cambia el estado y es idempotente', async () => {
  const s1 = await finalizarSesion(sesionId, NEGOCIO_A, 'aprobada');
  assert.strictEqual(s1.estado, 'finalizada');
  const s2 = await finalizarSesion(sesionId, NEGOCIO_A, 'aprobada'); // segunda vez, no debe fallar
  assert.strictEqual(s2.estado, 'finalizada');
});

await t('CICLO', 'tras finalizar, obtenerSesionActiva ya no la devuelve', async () => {
  const activa = await obtenerSesionActiva(NEGOCIO_A, TEL_1);
  assert.strictEqual(activa, null);
});

await t('CICLO', 'tras finalizar, se puede crear una NUEVA sesión activa para el mismo negocio+telefono', async () => {
  const nueva = await obtenerOCrearSesionActiva(NEGOCIO_A, TEL_1);
  assert.notStrictEqual(nueva.id, sesionId);
  assert.strictEqual(nueva.estado, 'descubriendo_necesidad');
  await finalizarSesion(nueva.id, NEGOCIO_A, 'abandonada');
});

// ═══════════ UNICIDAD: a lo sumo una sesión activa por negocio+telefono ═══════════

await t('UNICIDAD', 'dos llamadas casi simultáneas devuelven la MISMA sesión (sin duplicar)', async () => {
  const [a, b] = await Promise.all([
    obtenerOCrearSesionActiva(NEGOCIO_A, TEL_2),
    obtenerOCrearSesionActiva(NEGOCIO_A, TEL_2),
  ]);
  assert.strictEqual(a.id, b.id);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM sesiones_comerciales WHERE negocio_id=$1 AND telefono=$2 AND estado NOT IN ('finalizada','abandonada')`,
    [NEGOCIO_A, TEL_2]
  );
  assert.strictEqual(rows[0].n, 1);
  await finalizarSesion(a.id, NEGOCIO_A, 'abandonada');
});

// ═══════════ AISLAMIENTO entre negocios ═══════════

let sesionAjena;
await t('AISLAMIENTO', 'setup: sesión creada en negocio A', async () => {
  sesionAjena = await obtenerOCrearSesionActiva(NEGOCIO_A, TEL_3);
});
await t('AISLAMIENTO', 'negocio B no puede leer la sesión de A (obtenerSesion -> null)', async () => {
  const s = await obtenerSesion(sesionAjena.id, NEGOCIO_B);
  assert.strictEqual(s, null);
});
await t('AISLAMIENTO', 'negocio B no puede actualizar campos de la sesión de A (-> null, no lanza)', async () => {
  const s = await actualizarCamposSesion(sesionAjena.id, NEGOCIO_B, { intento: 'ajeno' });
  assert.strictEqual(s, null);
  const propia = await obtenerSesion(sesionAjena.id, NEGOCIO_A);
  assert.strictEqual(propia.campos_capturados.intento, undefined, 'el intento ajeno no debe haber escrito nada');
});
await t('AISLAMIENTO', 'negocio B no puede cambiar el estado de la sesión de A (-> null)', async () => {
  const s = await cambiarEstadoSesion(sesionAjena.id, NEGOCIO_B, 'finalizada');
  assert.strictEqual(s, null);
});
await t('AISLAMIENTO', 'negocio A y B con el mismo teléfono tienen sesiones independientes', async () => {
  const sesionB = await obtenerOCrearSesionActiva(NEGOCIO_B, TEL_3);
  assert.notStrictEqual(sesionB.id, sesionAjena.id);
  await finalizarSesion(sesionB.id, NEGOCIO_B, 'abandonada');
  await finalizarSesion(sesionAjena.id, NEGOCIO_A, 'abandonada');
});

// ═══════════ IntentDetector ═══════════

await t('INTENT', 'activaModoComercial: verdad exacta para las 5 categorías', () => {
  assert.strictEqual(activaModoComercial('solicitud_comercial'), true);
  assert.strictEqual(activaModoComercial('continuacion_comercial'), true);
  assert.strictEqual(activaModoComercial('pedido_normal'), false);
  assert.strictEqual(activaModoComercial('consulta_general'), false);
  assert.strictEqual(activaModoComercial('ambiguo'), false);
});

await t('INTENT', 'módulo no habilitado -> pedido_normal, nunca llama al modelo', async () => {
  const categoria = await detectarIntencionComercial({ mensaje: 'Necesito una cotización para 200 personas', moduloHabilitado: false });
  assert.strictEqual(categoria, 'pedido_normal');
});

await t('INTENT', 'mensaje vacío -> ambiguo (nunca activa el modo)', async () => {
  const categoria = await detectarIntencionComercial({ mensaje: '   ', moduloHabilitado: true });
  assert.strictEqual(categoria, 'ambiguo');
  assert.strictEqual(activaModoComercial(categoria), false);
});

await t('INTENT', 'sin ANTHROPIC_API_KEY real disponible, la clasificación falla cerrado a ambiguo (nunca lanza)', async () => {
  const claveOriginal = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-clave-invalida-para-esta-prueba';
  try {
    const categoria = await detectarIntencionComercial({ mensaje: 'Quiero una cotización para una boda', moduloHabilitado: true });
    assert.strictEqual(categoria, 'ambiguo');
    assert.strictEqual(activaModoComercial(categoria), false);
  } finally {
    if (claveOriginal === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = claveOriginal;
  }
});

await t('INTENT', 'CATEGORIAS_INTENCION contiene exactamente las 5 categorías documentadas', () => {
  assert.deepStrictEqual(
    [...CATEGORIAS_INTENCION].sort(),
    ['ambiguo', 'consulta_general', 'continuacion_comercial', 'pedido_normal', 'solicitud_comercial'].sort()
  );
});

// ═══════════ Resumen ═══════════
console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) {
  console.log('\nFallos:');
  fallos.forEach(f => console.log(' - ' + f));
}

await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
