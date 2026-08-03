// Fase 3 del Asistente Comercial: draftBuilder.js -- creación de la
// cotización borrador a partir de una sesión comercial con información
// suficiente. Consulta el catálogo real (menu_productos) para precios;
// nunca inventa uno. Puramente a nivel de servicio (DB), sin servidor
// HTTP ni llamada a Claude.
//
// Uso: DATABASE_URL=... node test/fase-asistente-comercial-3-draftbuilder.mjs
// Requiere aplicar-migraciones.mjs y seed-datos-prueba.mjs ya corridos.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const NEGOCIO_A = SEED.negocioA;
const NEGOCIO_B = SEED.negocioB;

const { pool } = await import('../src/services/database.js');
const { TenantContextRequiredError } = await import('../src/services/integracionesService.js');
const { obtenerOCrearSesionActiva, actualizarCamposSesion, obtenerSesion, finalizarSesion } = await import('../src/services/sesionComercial.js');
const { generarBorradorDesdeSesion } = await import('../src/services/draftBuilder.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(categoria, nombre, fn) {
  try { await fn(); console.log(`  OK  [${categoria}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${categoria}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${categoria}] ${nombre}: ${e.message}`); }
}

// Fixture de catálogo real para negocio A: una categoría + un producto
// con nombre "Arreglo Floral Premium" y precio real $1500.
const { rows: [categoria] } = await pool.query(
  `INSERT INTO menu_categorias (nombre, negocio_id) VALUES ('Arreglos', $1) RETURNING id`,
  [NEGOCIO_A]
);
await pool.query(
  `INSERT INTO menu_productos (categoria_id, nombre, precio, disponible, negocio_id) VALUES ($1, 'Arreglo Floral Premium', 1500, true, $2)`,
  [categoria.id, NEGOCIO_A]
);

await t('TENANT-CONTEXT', 'generarBorradorDesdeSesion sin negocioId -> TenantContextRequiredError', async () => {
  await assert.rejects(() => generarBorradorDesdeSesion('00000000-0000-0000-0000-000000000000', ''), TenantContextRequiredError);
});

await t('INSUFICIENTE', 'sin campos obligatorios completos -> null, no crea nada', async () => {
  const sesion = await obtenerOCrearSesionActiva(NEGOCIO_A, '+528781120001');
  await actualizarCamposSesion(sesion.id, NEGOCIO_A, { nombre: 'Cliente Incompleto' });
  const resultado = await generarBorradorDesdeSesion(sesion.id, NEGOCIO_A);
  assert.strictEqual(resultado, null);
  const s = await obtenerSesion(sesion.id, NEGOCIO_A);
  assert.strictEqual(s.cotizacion_id, null);
  await finalizarSesion(sesion.id, NEGOCIO_A, 'abandonada');
});

let sesionConCatalogo, cotizacionConCatalogo;
await t('CATALOGO', 'item que SÍ coincide con el catálogo usa el precio real (nunca inventado)', async () => {
  sesionConCatalogo = await obtenerOCrearSesionActiva(NEGOCIO_A, '+528781120002');
  await actualizarCamposSesion(sesionConCatalogo.id, NEGOCIO_A, {
    nombre: 'Ana López', fecha_evento: '2026-09-20', numero_personas: 150,
    items: [{ descripcion: 'Arreglo Floral Premium', cantidad: 10 }],
  });
  cotizacionConCatalogo = await generarBorradorDesdeSesion(sesionConCatalogo.id, NEGOCIO_A);
  assert.strictEqual(cotizacionConCatalogo.origen, 'whatsapp_ia');
  assert.strictEqual(cotizacionConCatalogo.estado, 'borrador');
  assert.strictEqual(Number(cotizacionConCatalogo.items[0].precio_unitario), 1500, 'debe usar el precio real del catálogo');
  assert.strictEqual(cotizacionConCatalogo.items[0].descripcion, 'Arreglo Floral Premium', 'sin sufijo de pendiente, ya tiene precio real');
  assert.strictEqual(Number(cotizacionConCatalogo.total), 15000);
});

await t('CATALOGO', 'la sesión queda vinculada y en esperando_aprobacion', async () => {
  const s = await obtenerSesion(sesionConCatalogo.id, NEGOCIO_A);
  assert.strictEqual(s.cotizacion_id, cotizacionConCatalogo.id);
  assert.strictEqual(s.estado, 'esperando_aprobacion');
});

await t('CATALOGO', 'idempotente -- una segunda llamada no crea un segundo borrador', async () => {
  const resultado2 = await generarBorradorDesdeSesion(sesionConCatalogo.id, NEGOCIO_A);
  assert.strictEqual(resultado2.yaExistia, true);
  assert.strictEqual(resultado2.cotizacionId, cotizacionConCatalogo.id);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM cotizaciones WHERE telefono = $1 AND negocio_id = $2`, ['+528781120002', NEGOCIO_A]);
  assert.strictEqual(rows[0].n, 1);
});

await t('SIN-CATALOGO', 'item que NO coincide con el catálogo queda con precio 0, marcado pendiente (nunca inventado)', async () => {
  const sesion = await obtenerOCrearSesionActiva(NEGOCIO_A, '+528781120003');
  await actualizarCamposSesion(sesion.id, NEGOCIO_A, {
    nombre: 'Carlos Ruiz', fecha_evento: '2026-10-10', numero_personas: 80,
    items: [{ descripcion: 'Servicio de banquete estilo hawaiano', cantidad: 1 }],
  });
  const cotizacion = await generarBorradorDesdeSesion(sesion.id, NEGOCIO_A);
  assert.strictEqual(Number(cotizacion.items[0].precio_unitario), 0);
  assert.ok(cotizacion.items[0].descripcion.includes('precio pendiente de revisión'));
  assert.strictEqual(Number(cotizacion.total), 0);
});

await t('AISLAMIENTO', 'una sesión de negocio A no genera un borrador si se invoca con negocioId de B', async () => {
  const sesion = await obtenerOCrearSesionActiva(NEGOCIO_A, '+528781120004');
  await actualizarCamposSesion(sesion.id, NEGOCIO_A, {
    nombre: 'Aislamiento', fecha_evento: '2026-11-11', numero_personas: 50,
    items: [{ descripcion: 'Cualquier cosa', cantidad: 1 }],
  });
  const resultado = await generarBorradorDesdeSesion(sesion.id, NEGOCIO_B); // negocioId equivocado a propósito
  assert.strictEqual(resultado, null, 'no debe encontrar la sesión bajo un negocio distinto');
  await finalizarSesion(sesion.id, NEGOCIO_A, 'abandonada');
});

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }

await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
