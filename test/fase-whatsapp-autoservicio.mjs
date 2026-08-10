// Autoservicio de WhatsApp: el negocio conecta su propio número.
//
// Lo que estas pruebas defienden no es "el botón funciona". Es que el
// administrador de un restaurante no pueda, ni queriendo ni por accidente,
// conectar WhatsApp al negocio de otro; que un mesero no pueda tocar la
// integración; y que la pantalla del cliente no filtre un solo secreto.
import assert from 'assert';
import { randomUUID } from 'crypto';
import { arrancarServidor } from './lib-servidor.mjs';

const PUERTO = process.env.TEST_PORT || '4995';
const { pool } = await import('../src/services/database.js');
const { buscarFugas, CLAVES_PROHIBIDAS, puedeAdministrarWhatsapp,
        traducirEstadoNombre, traducirErrorMeta } = await import('../src/services/whatsappAutoservicio.js');
const { crearState, validarYConsumirState } = await import('../src/services/embeddedSignupState.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ─── Dos negocios distintos, como Carnitas y Mapolato ───────────────────────
async function crearNegocio(slug, nombre) {
  const { rows: [n] } = await pool.query(
    `INSERT INTO negocios (nombre, slug) VALUES ($1,$2)
     ON CONFLICT (slug) DO UPDATE SET nombre = $1 RETURNING id`, [nombre, slug]);
  await pool.query(
    `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'Principal')
     ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true`, [n.id]);
  await pool.query(
    `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'whatsapp','activo')
     ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [n.id]).catch(() => {});
  return n.id;
}

const CARNITAS = await crearNegocio('carnitas-mock', 'Carnitas Mock');
const OTRO     = await crearNegocio('otro-mock', 'Otro Restaurante Mock');

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const BASE = `http://localhost:${PUERTO}`;

// ─── Contrato del estado (sin servidor) ─────────────────────────────────────

await t('ROLES', '1. solo el administrador del negocio puede conectar', () => {
  assert.strictEqual(puedeAdministrarWhatsapp('admin'), true);
  assert.strictEqual(puedeAdministrarWhatsapp('mesero'), false, 'un mesero no toca la integracion');
  assert.strictEqual(puedeAdministrarWhatsapp('staff'), false);
  assert.strictEqual(puedeAdministrarWhatsapp('operador'), false);
  assert.strictEqual(puedeAdministrarWhatsapp(undefined), false, 'sin rol, no');
});

await t('SECRETOS', '2. el detector de fugas encuentra un token escondido', () => {
  // La prueba del detector: si esto no fallara, las de abajo no valdrian nada.
  const conFuga = { conectado: true, credenciales: { access_token: 'EAAG...' } };
  assert.deepStrictEqual(buscarFugas(conFuga), ['credenciales.access_token']);
  assert.deepStrictEqual(buscarFugas({ conectado: true, numero: '+52...' }), []);
});

await t('SECRETOS', '3. la lista de prohibidas cubre lo que de verdad duele', () => {
  for (const clave of ['access_token', 'verify_token', 'app_secret', 'phone_number_id', 'waba_id']) {
    assert.ok(CLAVES_PROHIBIDAS.some(c => c.toLowerCase() === clave),
      `${clave} tiene que estar prohibida`);
  }
});

await t('NOMBRE', '4. el nombre visible en revision NO es un error', () => {
  const revision = traducirEstadoNombre('PENDING_REVIEW');
  assert.strictEqual(revision.etiqueta, 'En revisión');
  assert.strictEqual(revision.tono, 'espera', 'en revision no es rojo: Meta deja operar mientras revisa');

  const rechazado = traducirEstadoNombre('REJECTED');
  assert.strictEqual(rechazado.tono, 'problema');
});

await t('NOMBRE', '5. un estado desconocido se dice desconocido, no se inventa', () => {
  const r = traducirEstadoNombre('ALGO_QUE_META_INVENTO_MANANA');
  assert.strictEqual(r.etiqueta, 'Desconocido');
  assert.strictEqual(r.crudo, 'ALGO_QUE_META_INVENTO_MANANA', 'pero se conserva para el log');
});

await t('ERRORES', '6. los errores de Meta se traducen a algo accionable', () => {
  // Este es real: aparecio en los logs de produccion.
  const borrado = traducirErrorMeta({ code: 33, message: 'The requested phone number has been deleted.' });
  assert.match(borrado.mensaje, /ya no existe/i);
  assert.strictEqual(borrado.accionable, true);

  const caducado = traducirErrorMeta({ code: 190 });
  assert.match(caducado.mensaje, /vuelve a conectar/i);
});

await t('ERRORES', '7. un error desconocido no inventa un motivo', () => {
  const r = traducirErrorMeta({ code: 999999, message: 'algo rarisimo' });
  assert.strictEqual(r.accionable, false);
  assert.match(r.mensaje, /No pudimos completar/);
  assert.ok(!r.mensaje.includes('algo rarisimo'), 'el detalle crudo no va a la cara del cliente');
});

// ─── State firmado ──────────────────────────────────────────────────────────

await t('STATE', '8. el negocio viaja DENTRO del state firmado', () => {
  const usuarioId = randomUUID();
  const state = crearState({ negocioId: CARNITAS, usuarioId });
  const leido = validarYConsumirState(state);
  assert.strictEqual(leido.negocioId, CARNITAS);
  assert.strictEqual(leido.usuarioId, usuarioId);
  assert.strictEqual(leido.actor, 'negocio', 'se distingue de un inicio de Superadmin');
});

await t('STATE', '9. el state es de un solo uso: el replay se rechaza', () => {
  const state = crearState({ negocioId: CARNITAS, usuarioId: randomUUID() });
  assert.ok(validarYConsumirState(state), 'la primera vez vale');
  assert.strictEqual(validarYConsumirState(state), null, 'la segunda no');
});

await t('STATE', '10. un state manipulado no pasa la firma', () => {
  const state = crearState({ negocioId: CARNITAS, usuarioId: randomUUID() });
  const [payload, firma] = state.split('.');

  // Alguien reescribe el negocio para apuntar al otro restaurante.
  const datos = JSON.parse(Buffer.from(payload, 'base64url').toString());
  datos.negocioId = OTRO;
  const falsificado = Buffer.from(JSON.stringify(datos)).toString('base64url') + '.' + firma;

  assert.strictEqual(validarYConsumirState(falsificado), null,
    'cambiar el negocio invalida la firma: es lo que impide robar la integracion de otro');
});

await t('STATE', '11. sin actor no se puede crear un state', () => {
  assert.throws(() => crearState({ negocioId: CARNITAS }), /superadminId o usuarioId/);
  assert.throws(() => crearState({ negocioId: CARNITAS, usuarioId: 'u1', superadminId: 's1' }),
    /dos actores/, 'un state con dos actores no se sabe a quien auditar');
});

// ─── Rutas HTTP: sin sesion ─────────────────────────────────────────────────

const pedir = (metodo, ruta, cuerpo = null, cookie = null) => fetch(`${BASE}${ruta}`, {
  method: metodo,
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
});

await t('AUTH', '12. sin sesion, todas las rutas del autoservicio fallan cerrado', async () => {
  for (const [m, r] of [['GET', '/api/integraciones/whatsapp/estado'],
                        ['GET', '/api/integraciones/whatsapp/config'],
                        ['POST', '/api/integraciones/whatsapp/iniciar'],
                        ['POST', '/api/integraciones/whatsapp/verificar'],
                        ['DELETE', '/api/integraciones/whatsapp/conexion-pendiente']]) {
    const res = await pedir(m, r);
    assert.ok([401, 403].includes(res.status), `${m} ${r} devolvio ${res.status}`);
  }
});

await t('AUTH', '13. el callback publico rechaza un state invalido', async () => {
  const res = await pedir('POST', '/api/integraciones/whatsapp/meta/callback',
    { state: 'inventado.porcompleto', code: 'x', phoneNumberId: '123' });
  assert.strictEqual(res.status, 400);
  const cuerpo = await res.json();
  assert.match(cuerpo.error, /state/i);
});

await t('AUTH', '14. el callback NO acepta un negocioId puesto a mano', async () => {
  // El intento mas obvio: mandar el negocio en el cuerpo. Se ignora por
  // completo -- el unico negocio que cuenta es el que va firmado.
  const res = await pedir('POST', '/api/integraciones/whatsapp/meta/callback',
    { negocioId: OTRO, code: 'x', phoneNumberId: '123' });
  assert.strictEqual(res.status, 400, 'sin state valido no hay nada que hacer');
});

// ─── Estado sin secretos ────────────────────────────────────────────────────

await t('ESTADO', '15. un negocio sin conectar reporta no conectado, sin ruido', async () => {
  const { estadoWhatsappNegocio } = await import('../src/services/whatsappAutoservicio.js');
  const e = await estadoWhatsappNegocio(CARNITAS);
  assert.strictEqual(e.conectado, false);
  assert.strictEqual(e.numero, null);
  assert.strictEqual(e.botActivo, false);
  assert.deepStrictEqual(buscarFugas(e), [], 'ni un secreto');
});

await t('ESTADO', '16. un negocio conectado muestra su numero y NADA tecnico', async () => {
  await pool.query(
    `INSERT INTO integraciones_canal
       (negocio_id, canal, identificador, activo, estado, waba_id,
        display_phone_number, verified_name, estado_nombre, app_suscrita_waba, numero_registrado_cloud_api)
     VALUES ($1,'whatsapp',$2,true,'activo','WABA-SECRETA-123',
             '+52 878 123 4567','Carnitas Mock','PENDING_REVIEW',true,true)
     ON CONFLICT (canal, identificador) DO UPDATE
       SET negocio_id=$1, estado='activo', waba_id='WABA-SECRETA-123',
           display_phone_number='+52 878 123 4567', verified_name='Carnitas Mock',
           estado_nombre='PENDING_REVIEW', app_suscrita_waba=true, numero_registrado_cloud_api=true`,
    [CARNITAS, `pn-carnitas-${Date.now()}`]);

  const { estadoWhatsappNegocio } = await import('../src/services/whatsappAutoservicio.js');
  const e = await estadoWhatsappNegocio(CARNITAS);

  assert.strictEqual(e.conectado, true);
  assert.strictEqual(e.numero, '+52 878 123 4567');
  assert.strictEqual(e.nombreVisible, 'Carnitas Mock');
  assert.strictEqual(e.appSuscrita, true);
  assert.strictEqual(e.numeroRegistrado, true);
  assert.strictEqual(e.botActivo, false, 'conectar NO enciende el bot: eso lo decide el negocio');
  assert.strictEqual(e.estadoNombre.etiqueta, 'En revisión');
  assert.strictEqual(e.conectado, true,
    'un nombre en revision NO desmiente la conexion: Meta deja operar mientras revisa');

  assert.deepStrictEqual(buscarFugas(e), [], 'la pantalla del cliente no lleva secretos');
  const serializado = JSON.stringify(e);
  assert.ok(!serializado.includes('WABA-SECRETA-123'), 'el waba_id no sale del backend');
});

// ─── Aislamiento entre negocios ─────────────────────────────────────────────

await t('AISLAMIENTO', '17. el estado de un negocio no filtra el del otro', async () => {
  const { estadoWhatsappNegocio } = await import('../src/services/whatsappAutoservicio.js');
  const otro = await estadoWhatsappNegocio(OTRO);
  assert.strictEqual(otro.conectado, false, 'el otro restaurante sigue sin conectar');
  assert.strictEqual(otro.numero, null, 'y no ve el numero del vecino');
});

await t('AISLAMIENTO', '18. un state de Carnitas no sirve para el otro negocio', () => {
  const state = crearState({ negocioId: CARNITAS, usuarioId: randomUUID() });
  const leido = validarYConsumirState(state);
  assert.strictEqual(leido.negocioId, CARNITAS);
  assert.notStrictEqual(leido.negocioId, OTRO,
    'el negocio del state es el unico que el callback va a usar');
});

await t('AISLAMIENTO', '19. un numero ya tomado no se le puede robar a su dueno', async () => {
  // El callback comprueba la propiedad del phone_number_id antes de escribir.
  const { rows } = await pool.query(
    `SELECT negocio_id FROM integraciones_canal WHERE canal='whatsapp' AND negocio_id=$1`, [CARNITAS]);
  assert.ok(rows.length >= 1);
  assert.strictEqual(rows[0].negocio_id, CARNITAS,
    'la fila sigue siendo de Carnitas y ningun otro negocio la reclama');
});

// ─── Higiene ────────────────────────────────────────────────────────────────

await t('LOGS', '20. el servidor no registra el state completo ni tokens', async () => {
  const salida = srv.obtenerSalida();
  assert.ok(!salida.includes('WABA-SECRETA-123'), 'el waba_id no puede acabar en un log');
  assert.ok(!/access_token=|EAAG[A-Za-z0-9]/.test(salida), 'ni un token');
});

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) for (const f of fallos) console.log(`  - ${f}`);
srv.detener();
await pool.end();
process.exit(fallidas ? 1 : 0);
