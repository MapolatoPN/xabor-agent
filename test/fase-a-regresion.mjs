// Regresión persistida de Fase A (aislamiento de WhatsApp por negocio).
// Cubre el contrato que Fase B no debe romper: credenciales explícitas,
// fail-closed sin integración, sesión negocio_id+teléfono, memoria y
// prompt/reglas/overrides por negocio, envíos con credenciales
// explícitas en whatsapp-meta.js/server.js/learner.js, y el fallback
// verificado de Nonna Maye (nunca por defecto para un phone_number_id
// desconocido).
//
// Uso: DATABASE_URL=... INTEGRATIONS_ENCRYPTION_KEY=... node test/fase-a-regresion.mjs
// Requiere que aplicar-migraciones.mjs y seed-datos-prueba.mjs ya hayan
// corrido sobre el mismo DATABASE_URL.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import assert from 'assert';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));

const { pool, obtenerCredencialesWhatsappNegocio, obtenerIntegracionCanal, actualizarConfiguracion, upsertCliente } = await import('../src/services/database.js');
const { obtenerPerfilCliente } = await import('../src/services/memory.js');
const { construirSystemPrompt } = await import('../src/agent/prompts.js');
const { getSession, deleteSession } = await import('../src/agent/session.js');

// Aislamiento entre suites persistidas: limpia restos de corridas
// anteriores (de esta misma suite o de fase-b-integraciones.mjs) en los
// negocios sembrados, para que el orden de ejecución nunca afecte el
// resultado.
await pool.query(`DELETE FROM configuracion WHERE negocio_id = ANY($1) AND clave IN ('int_wa_phone_id','int_wa_token','reglas_atencion')`, [[SEED.negocioA, SEED.negocioB]]);
// Restos de fase-b-integraciones.mjs: sus credenciales cifradas (nivel 1)
// tienen prioridad sobre la vía legada que esta suite prueba -- se
// limpian aquí también para que el orden de ejecución nunca importe.
await pool.query(`DELETE FROM integraciones_canal_credenciales WHERE integracion_id IN (SELECT id FROM integraciones_canal WHERE negocio_id = ANY($1))`, [[SEED.negocioA, SEED.negocioB, SEED.nonnaMayeId]]);
await pool.query(`DELETE FROM integraciones_canal WHERE canal = 'whatsapp' AND negocio_id = ANY($1)`, [[SEED.negocioA, SEED.negocioB, SEED.nonnaMayeId]]);

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ═══════════════ 1. Credenciales explícitas por negocio (vía legada) ═══════════════
await t('credenciales por negocio: vía legada configuracion.int_wa_* aislada entre A y B', async () => {
  await actualizarConfiguracion({ int_wa_phone_id: 'LEGACY_PNID_A', int_wa_token: 'LEGACY_TOKEN_A' }, SEED.negocioA);
  await actualizarConfiguracion({ int_wa_phone_id: 'LEGACY_PNID_B', int_wa_token: 'LEGACY_TOKEN_B' }, SEED.negocioB);

  const credA = await obtenerCredencialesWhatsappNegocio(SEED.negocioA);
  const credB = await obtenerCredencialesWhatsappNegocio(SEED.negocioB);
  assert.deepStrictEqual(credA, { phoneNumberId: 'LEGACY_PNID_A', accessToken: 'LEGACY_TOKEN_A' });
  assert.deepStrictEqual(credB, { phoneNumberId: 'LEGACY_PNID_B', accessToken: 'LEGACY_TOKEN_B' });
});

// ═══════════════ 2. Fail-closed sin integración ═══════════════
await t('fail-closed: negocio sin ninguna configuración -> null, sin lanzar', async () => {
  const cred = await obtenerCredencialesWhatsappNegocio(SEED.negocioC);
  assert.strictEqual(cred, null);
});
await t('fail-closed: envíos de whatsapp-meta.js sin credenciales (enviarMensaje/enviarImagen/notificarRepartidoresPorWA)', async () => {
  // server.js y whatsapp-meta.js tienen una dependencia circular
  // preexistente que solo resuelve entrando por server.js primero (ver
  // child-envios-whatsapp-meta.mjs) -- se corre como proceso hijo en vez
  // de importar whatsapp-meta.js directamente en este proceso.
  const { stdout } = await execFileAsync(process.execPath, [join(__dirname, 'child-envios-whatsapp-meta.mjs')], {
    env: { ...process.env, CHILD_PORT: '4099' },
  });
  const linea = stdout.split('\n').find(l => l.startsWith('RESULTADOS_JSON:'));
  const resultados = JSON.parse(linea.slice('RESULTADOS_JSON:'.length));
  for (const r of resultados) assert.ok(r.ok, r.nombre);
});

// ═══════════════ 3. Sesión negocio_id + teléfono ═══════════════
await t('sesión: mismo teléfono en dos negocios tiene historiales independientes', async () => {
  const telefono = '5218780000111';
  const idA = `meta-${SEED.negocioA}-${telefono}`;
  const idB = `meta-${SEED.negocioB}-${telefono}`;
  deleteSession(idA); deleteSession(idB); // limpiar restos de corridas previas
  const sesionA = getSession(idA);
  const sesionB = getSession(idB);
  assert.notStrictEqual(sesionA, sesionB);
  sesionA.mensajes.push({ role: 'user', content: 'mensaje solo de A' });
  assert.strictEqual(sesionB.mensajes.length, 0);
  deleteSession(idA); deleteSession(idB);
});

// ═══════════════ 4. Memoria aislada por negocio ═══════════════
// Nota: clientes.telefono es PK global (deuda ya registrada,
// "perfiles_clientes global PK" -- fuera de alcance de Fase A/B). Esta
// prueba usa teléfonos DISTINTOS por negocio, que es la garantía real
// que Fase A ofrece: un negocio nunca ve ni mezcla el perfil de un
// cliente que pertenece a otro negocio.
await t('memoria: perfil de cliente de A no es visible desde B', async () => {
  const telA = '5218780000222';
  const telB = '5218780000333';
  await upsertCliente(telA, 'Cliente Exclusivo de A', SEED.negocioA);
  await upsertCliente(telB, 'Cliente Exclusivo de B', SEED.negocioB);

  const perfilA_en_A = await obtenerPerfilCliente(telA, SEED.negocioA);
  const perfilA_en_B = await obtenerPerfilCliente(telA, SEED.negocioB); // mismo cliente, negocio equivocado
  assert.ok(perfilA_en_A);
  assert.strictEqual(perfilA_en_A.nombre, 'Cliente Exclusivo de A');
  assert.strictEqual(perfilA_en_B, null); // B nunca tuvo trato con este teléfono
});
await t('memoria: negocioId inválido u omitido falla cerrado', async () => {
  assert.strictEqual(await obtenerPerfilCliente('5218780000222', null), null);
  assert.strictEqual(await obtenerPerfilCliente('5218780000222', ''), null);
});

// ═══════════════ 5. Prompt / reglas / overrides por negocio ═══════════════
await t('prompt: reglas de un negocio no aparecen en el prompt de otro', async () => {
  const marcaA = 'REGLA-EXCLUSIVA-NEGOCIO-A-' + Date.now();
  const diaBase = { abierto: true, apertura: '09:00', cierre: '20:00' };
  const reglasA = {
    restaurante: 'Negocio A Prueba',
    horarios: { lunes: diaBase, martes: diaBase, miercoles: diaBase, jueves: diaBase, viernes: diaBase, sabado: diaBase, domingo: { abierto: false, apertura: null, cierre: null } },
    pedidos: { modalidades: ['recoger en tienda'], tiempo_preparacion_minutos: 20, pedido_minimo_entrega: 0, costo_envio: 0, pago_aceptado: ['efectivo'] },
    cierres_especiales: [], promociones: [], politicas: [marcaA],
  };
  await actualizarConfiguracion({ reglas_atencion: JSON.stringify(reglasA) }, SEED.negocioA);
  const promptA = await construirSystemPrompt(null, 'whatsapp', SEED.negocioA);
  const promptB = await construirSystemPrompt(null, 'whatsapp', SEED.negocioB);
  assert.ok(promptA.includes(marcaA));
  assert.ok(!promptB.includes(marcaA));
});
await t('prompt: sin negocioId usa reglas por defecto sin lanzar', async () => {
  const prompt = await construirSystemPrompt(null, 'whatsapp', null);
  assert.ok(typeof prompt === 'string' && prompt.length > 0);
});

// ═══════════════ 6-8. Envíos con credenciales explícitas (estructural) ═══════════════
// Fase A eliminó el caché global de credenciales -- esta comprobación
// estática confirma que ningún punto de envío de estos 3 archivos
// volvió a depender de un fallback implícito: toda llamada a
// enviarMensaje/enviarImagen debe pasar el parámetro de credenciales.
// Extrae llamadas reales a enviarMensaje(/enviarImagen( con paréntesis
// balanceados (soporta argumentos multilínea con template literals que
// contienen sus propios paréntesis) e ignora coincidencias dentro de
// comentarios de línea (// ...).
function extraerLlamadas(contenido) {
  const llamadas = [];
  const re = /enviar(?:Mensaje|Imagen)\(/g;
  let m;
  while ((m = re.exec(contenido))) {
    const inicioLinea = contenido.lastIndexOf('\n', m.index) + 1;
    const prefijoLinea = contenido.slice(inicioLinea, m.index);
    if (prefijoLinea.includes('//')) continue; // dentro de un comentario de línea
    let profundidad = 1;
    let i = m.index + m[0].length;
    while (i < contenido.length && profundidad > 0) {
      if (contenido[i] === '(') profundidad++;
      else if (contenido[i] === ')') profundidad--;
      i++;
    }
    llamadas.push(contenido.slice(m.index, i));
  }
  return llamadas;
}
function verificarLlamadasConCredenciales(rutaRelativa, minimoEsperado) {
  const contenido = readFileSync(join(__dirname, '..', rutaRelativa), 'utf8');
  const llamadas = extraerLlamadas(contenido);
  assert.ok(llamadas.length >= minimoEsperado, `se esperaban al menos ${minimoEsperado} llamadas en ${rutaRelativa}, hubo ${llamadas.length}`);
  const sinCredenciales = llamadas.filter(l => !/credencial/i.test(l));
  assert.strictEqual(sinCredenciales.length, 0, `llamadas sin credenciales explícitas en ${rutaRelativa}: ${JSON.stringify(sinCredenciales)}`);
}
await t('envíos whatsapp-meta.js: todas las llamadas pasan credenciales explícitas', () => {
  verificarLlamadasConCredenciales('src/channels/whatsapp-meta.js', 10);
});
await t('envíos server.js: todas las llamadas a enviarMensaje/enviarImagen pasan credenciales explícitas', () => {
  verificarLlamadasConCredenciales('src/server.js', 1);
});
await t('envíos learner.js: todas las llamadas pasan credenciales explícitas', () => {
  verificarLlamadasConCredenciales('src/services/learner.js', 5);
});

// ═══════════════ 9. Fallback verificado de Nonna Maye ═══════════════
// Nonna Maye no tiene fila 'whatsapp' en integraciones_canal por
// defecto en este entorno de prueba (solo 'rappi', migración 008) --
// se siembra una sintética mínima aquí, análoga a como producción la
// tiene, para poder probar el mecanismo real de verificación de dueño.
const PNID_NONNA_SINTETICO = 'PNID_NONNA_MAYE_SINTETICO_TEST';
await t('fallback Nonna Maye: env vars + ownership verificado -> resuelve sus credenciales', async () => {
  await pool.query(
    `INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre)
     VALUES ($1, 'whatsapp', $2, 'WhatsApp Nonna Maye (prueba)')
     ON CONFLICT (canal, identificador) DO NOTHING`,
    [SEED.nonnaMayeId, PNID_NONNA_SINTETICO]
  );
  process.env.WHATSAPP_PHONE_ID = PNID_NONNA_SINTETICO;
  process.env.WHATSAPP_TOKEN = 'TOKEN_ENV_NONNA_MAYE_TEST';
  const cred = await obtenerCredencialesWhatsappNegocio(SEED.nonnaMayeId);
  assert.deepStrictEqual(cred, { phoneNumberId: PNID_NONNA_SINTETICO, accessToken: 'TOKEN_ENV_NONNA_MAYE_TEST' });
});

// ═══════════════ 10. phone_number_id desconocido nunca cae a Nonna Maye ═══════════════
await t('phone_number_id desconocido: obtenerIntegracionCanal -> null (fail closed)', async () => {
  const r = await obtenerIntegracionCanal('whatsapp', 'PHONE_NUMBER_ID_QUE_NO_EXISTE_NUNCA');
  assert.strictEqual(r, null);
});
await t('phone_number_id de Nonna Maye en env, pero negocio distinto pide credenciales -> null (nunca hereda)', async () => {
  // Las env vars siguen apuntando al phone_number_id de Nonna Maye (paso
  // anterior) -- un negocio que NO es su dueño nunca debe recibirlas.
  const cred = await obtenerCredencialesWhatsappNegocio(SEED.negocioD);
  assert.strictEqual(cred, null);
});
delete process.env.WHATSAPP_PHONE_ID;
delete process.env.WHATSAPP_TOKEN;

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('\nDetalle de fallos:'); fallos.forEach(f => console.log('  - ' + f)); }
await pool.end();
process.exit(fallidas > 0 ? 1 : 0);
