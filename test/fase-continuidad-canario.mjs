// Reentrega simultánea del mismo WAMID con el agente canario encendido.
// Nunca llama Meta ni Anthropic reales: ambos proveedores son mocks locales.
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarMetaMock } from './lib-meta-mock.mjs';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';
import { pool, actualizarConfiguracion, obtenerConfiguracion } from '../src/services/database.js';
import { validarEstructuraReglas } from '../src/agent/prompts.js';

assert(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname));
const escenarioHorario = String(process.env.TEST_CANARIO_HORARIO || 'abierto').trim().toLowerCase();
const retorno = process.env.TEST_CANARIO_RETORNO === '1';
if (retorno) assert.equal(escenarioHorario, 'abierto');
assert(['abierto', 'cerrado'].includes(escenarioHorario),
  'TEST_CANARIO_HORARIO debe ser abierto o cerrado');
const seed = JSON.parse(await readFile(new URL('.datos-prueba.json', import.meta.url)));
const negocioId = seed.negocioA;
const telefono = `52879${Math.floor(Math.random() * 1e7).toString().padStart(7, '0')}`;
const fueraDelPiloto = `${telefono.slice(0, -1)}${(Number(telefono.at(-1)) + 1) % 10}`;
const identificador = `canario-${randomUUID()}`;
const secreto = 'firma-local-canario';
const cfgOriginal = await obtenerConfiguracion(negocioId);
const clavesConfiguracionPrueba = [
  'int_wa_phone_id', 'int_wa_token', 'mesero_agente_v1',
  'mesero_agente_telefonos', 'reglas_atencion',
  'bot_whatsapp_solo_prueba',
];
const zonaNegocio = cfgOriginal.timezone || 'America/Matamoros';
const diaDeHoy = new Intl.DateTimeFormat('en-US', {
  timeZone: zonaNegocio, weekday: 'long',
}).format(new Date()).toLowerCase();
const diaEspanol = {
  sunday: 'domingo', monday: 'lunes', tuesday: 'martes',
  wednesday: 'miercoles', thursday: 'jueves', friday: 'viernes', saturday: 'sabado',
}[diaDeHoy];
const reglasPorDefecto = {
  restaurante: 'Canario determinista',
  horarios: {
    lunes: { abierto: true, apertura: '09:00', cierre: '20:00' },
    martes: { abierto: true, apertura: '09:00', cierre: '20:00' },
    miercoles: { abierto: true, apertura: '09:00', cierre: '20:00' },
    jueves: { abierto: true, apertura: '09:00', cierre: '20:00' },
    viernes: { abierto: true, apertura: '09:00', cierre: '20:00' },
    sabado: { abierto: true, apertura: '09:00', cierre: '20:00' },
    domingo: { abierto: false, apertura: null, cierre: null },
  },
  pedidos: {
    modalidades: ['recoger en tienda', 'entrega a domicilio'],
    tiempo_preparacion_minutos: 20,
    pedido_minimo_entrega: 0,
    costo_envio: 0,
    pago_aceptado: ['efectivo'],
  },
  cierres_especiales: [],
  promociones: [],
  politicas: [],
};
let reglasBase;
try {
  reglasBase = cfgOriginal.reglas_atencion ? JSON.parse(cfgOriginal.reglas_atencion) : null;
} catch {
  reglasBase = null;
}
if (!validarEstructuraReglas(reglasBase)) {
  reglasBase = reglasPorDefecto;
}
const reglasEscenario = structuredClone(reglasBase);
reglasEscenario.horarios = { ...reglasPorDefecto.horarios, ...(reglasBase.horarios || {}) };
reglasEscenario.horarios[diaEspanol] = escenarioHorario === 'abierto'
  ? { abierto: true, apertura: '00:00', cierre: '24:00' }
  : { abierto: false, apertura: null, cierre: null };
const botOriginal = (await pool.query(
  'SELECT bot_whatsapp_activo FROM negocios WHERE id=$1', [negocioId],
)).rows[0]?.bot_whatsapp_activo;
let meta;
let ia;
let s1;
let s2;
let limpiezaNecesaria = false;
let categoriaPrueba;
let productoPrueba;
const esperar = async (fn) => {
  const fin = Date.now() + 18000;
  while (Date.now() < fin) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const { rows: [diagnostico] } = await pool.query(
    `SELECT revision, requiere_revision FROM whatsapp_conversaciones
      WHERE negocio_id=$1 AND telefono=$2`, [negocioId, telefono],
  );
  throw new Error('timeout esperando el turno canario'
    + `; fila=${JSON.stringify(diagnostico || null)}`
    + `; servidor1=${s1?.obtenerSalida?.().slice(-1200) || ''}`
    + `; servidor2=${s2?.obtenerSalida?.().slice(-1200) || ''}`);
};
const detener = async (servidor) => {
  if (!servidor) return;
  const salida = new Promise((resolve) => servidor.proc.once('exit', resolve));
  servidor.detener();
  await salida;
};
const mensaje = (id, texto) => ({ id, from: telefono, type: 'text', text: { body: texto } });
const publicar = async (base, mensajes) => {
  return publicarCuerpo(base, {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: identificador },
      messages: mensajes,
      contacts: [{ profile: { name: 'Cliente canario' } }],
    } }] }],
  },);
};
const publicarCuerpo = async (base, cuerpoObjeto) => {
  const cuerpo = JSON.stringify(cuerpoObjeto);
  return fetch(`${base}/webhook/whatsapp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', secreto).update(cuerpo).digest('hex')}`,
    },
    body: cuerpo,
  });
};

try {
  limpiezaNecesaria = true;
  categoriaPrueba = (await pool.query(
    'INSERT INTO menu_categorias(negocio_id,nombre,activa,orden) VALUES($1,$2,true,995) RETURNING id',
    [negocioId, identificador])).rows[0].id;
  productoPrueba = (await pool.query(
    'INSERT INTO menu_productos(negocio_id,categoria_id,nombre,precio,disponible) VALUES($1,$2,$3,195,true) RETURNING id',
    [negocioId, categoriaPrueba, 'Desayuno canario'])).rows[0].id;
  await pool.query(
    "INSERT INTO integraciones_canal(negocio_id,canal,identificador,activo) VALUES($1,'whatsapp',$2,true)",
    [negocioId, identificador],
  );
  await actualizarConfiguracion({
    int_wa_phone_id: identificador,
    int_wa_token: 'token-mock-canario',
    mesero_agente_v1: 'true',
    mesero_agente_telefonos: telefono,
    reglas_atencion: JSON.stringify(reglasEscenario),
  }, negocioId);
  await pool.query('UPDATE negocios SET bot_whatsapp_activo=true WHERE id=$1', [negocioId]);

  meta = await arrancarMetaMock();
  ia = await arrancarAnthropicMock();
  if (retorno) {
    const { estadoNuevo } = await import('../src/mesero-agente/ejecutorDeHerramientas.js');
    const estado = estadoNuevo({ negocioId, conversacionId: `agente:${telefono}` });
    estado.carrito.datos = { modalidad: 'recoger en tienda', forma_pago: 'efectivo' };
    estado.carrito.items = [{ id: productoPrueba, lid: 'retorno', nombre: 'Desayuno canario', cantidad: 1, notas: '', modificadores: [] }];
    estado.programacionRequerida = true;
    await pool.query(`INSERT INTO conversacion_estado(negocio_id,session_id,estado,actualizado_at)
      VALUES($1,$2,$3::jsonb,NOW()-INTERVAL '90 minutes')`,
    [negocioId, `agente:${telefono}`, JSON.stringify(estado)]);
  }
  const env = {
    META_GRAPH_BASE_URL: meta.baseUrl,
    ANTHROPIC_BASE_URL: ia.baseUrl,
    ANTHROPIC_API_KEY: 'test-only',
    META_APP_SECRET: secreto,
    MESERO_AGENTE_MODE: 'true',
  };
  // Con el negocio abierto el agente sí consulta Anthropic. La respuesta se
  // encola antes de publicar el webhook: el resultado no depende del reloj ni
  // de la disponibilidad de un proveedor externo.
  if (escenarioHorario === 'abierto' && !retorno) {
    ia.encolarRespuesta('¡Hola! Con gusto, ¿qué te gustaría pedir hoy?');
  }
  const puerto1 = process.env.TEST_PORT_CANARIO_1 || '4996';
  const puerto2 = process.env.TEST_PORT_CANARIO_2 || '4997';
  s1 = await arrancarServidor({ ...env, PORT: puerto1 });
  s2 = await arrancarServidor({ ...env, PORT: puerto2 });
  const entrada = mensaje(`canario-${telefono}`, retorno ? 'Hola' : 'Hola, ¿qué tienen hoy?');
  const respuestas = await Promise.all([
    publicar(s1.base, [entrada]),
    publicar(s2.base, [entrada]),
  ]);
  assert.equal(respuestas[0].status, 200);
  assert.equal(respuestas[1].status, 200);
  await esperar(async () => {
    const { rows: [fila] } = await pool.query(
      `SELECT c.revision, c.requiere_revision
         FROM whatsapp_conversaciones c
        WHERE c.negocio_id=$1 AND c.telefono=$2`, [negocioId, telefono],
    );
    return Number(fila?.revision) === 1 && fila?.requiere_revision === false;
  });
  if (escenarioHorario === 'abierto') {
    assert.equal(ia.pendientes(), 0, 'el escenario abierto debe consumir la respuesta del modelo');
  }

  const salidas = meta.obtenerMensajesEnviados().filter((m) => m.to === telefono);
  assert.equal(salidas.length, 1, 'una reentrega no puede mandar dos respuestas del canario');
  assert.ok(salidas[0].text.body, 'la respuesta canaria debe conservar texto');
  if (retorno) {
    assert.match(salidas[0].text.body, /fecha.*hoy.*otra fecha/i);
    assert.doesNotMatch(salidas[0].text.body, /equipo|registrado/i);
    const { rows: [persistido] } = await pool.query(
      'SELECT estado FROM conversacion_estado WHERE negocio_id=$1 AND session_id=$2',
      [negocioId, `agente:${telefono}`]);
    assert.equal(persistido.estado.hechos.escalado, false);
    assert.equal(persistido.estado.programacionRequerida, true);
    assert.equal(persistido.estado.carrito.datos.modalidad, 'recoger en tienda');
  }
  const { rows: mensajes } = await pool.query(
    `SELECT direccion, texto, message_id_externo
       FROM mensajes
      WHERE negocio_id=$1 AND telefono=$2
      ORDER BY id`, [negocioId, telefono],
  );
  assert.equal(mensajes.filter((m) => m.direccion === 'entrante').length, 1);
  const salientes = mensajes.filter((m) => m.direccion === 'saliente');
  assert.equal(salientes.length, 1);
  assert.match(salientes[0].message_id_externo, /^wamid\.SALIENTE_FAKE_/);
  const echo = await publicarCuerpo(s1.base, {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'smb_message_echoes', value: {
      metadata: { phone_number_id: identificador },
      message_echoes: [{
        id: salientes[0].message_id_externo,
        to: telefono,
        type: 'text',
        text: { body: salientes[0].texto },
      }],
    } }] }],
  });
  assert.equal(echo.status, 200);
  const { rows: despuesDelEcho } = await pool.query(
    `SELECT direccion, origen, message_id_externo
       FROM mensajes
      WHERE negocio_id=$1 AND telefono=$2
      ORDER BY id`, [negocioId, telefono],
  );
  assert.equal(despuesDelEcho.filter((m) => m.direccion === 'saliente').length, 1,
    'el eco de la propia salida no puede crear una segunda burbuja');
  console.log('OK canario: reentrega simultánea produce una sola respuesta y conserva wamid saliente');
  if (retorno) {
    // La redacción inventada se sustituye por una pregunta canónica, sin
    // retirar la protección ni pausar la conversación para atención humana.
    ia.encolarRespuesta('Listo, te registré el pedido.');
    await publicar(s2.base, [mensaje(`retorno-${telefono}`, 'Continuamos')]);
    await esperar(async () => meta.obtenerMensajesEnviados().filter((m) => m.to === telefono).length === 2);
    const ultima = meta.obtenerMensajesEnviados().filter((m) => m.to === telefono).at(-1).text.body;
    assert.match(ultima, /fecha.*hoy.*otra fecha/i);
    const { rows: [control] } = await pool.query(
      'SELECT requiere_revision FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2',
      [negocioId, telefono]);
    assert.equal(control.requiere_revision, false);
    console.log('OK retorno: saludo conserva borrador durable y una afirmación sin efectos se recupera sin handoff.');
  }
  // La lista experimental restringe TODOS los motores, no solo la elección
  // del agente. Un número ajeno se guarda para atención manual sin respuesta.
  await actualizarConfiguracion({ bot_whatsapp_solo_prueba: 'true' }, negocioId);
  const enviadas = meta.obtenerMensajesEnviados().filter((m) => m.to === telefono).length;
  await publicar(s1.base, [{ ...mensaje(`fuera-${fueraDelPiloto}`, 'Hola'), from: fueraDelPiloto }]);
  await esperar(async () => {
    const { rows } = await pool.query('SELECT estado FROM whatsapp_entradas WHERE negocio_id=$1 AND telefono=$2', [negocioId, fueraDelPiloto]);
    return rows.some((r) => r.estado === 'completado');
  });
  assert.equal(meta.obtenerMensajesEnviados().filter((m) => m.to === fueraDelPiloto).length, 0);
  const { rows: estadoAjeno } = await pool.query('SELECT estado FROM conversacion_estado WHERE negocio_id=$1 AND session_id=$2', [negocioId, `agente:${fueraDelPiloto}`]);
  assert.equal(estadoAjeno.length, 0);
  // El mismo interruptor sí deja pasar al número explícitamente autorizado.
  await publicar(s1.base, [mensaje(`dentro-${telefono}`, 'Hola')]);
  await esperar(async () => meta.obtenerMensajesEnviados().filter((m) => m.to === telefono).length === enviadas + 1);
  console.log('OK aislamiento: cliente fuera de lista queda en manual; el número de prueba conserva atención.');
} finally {
  await detener(s1);
  await detener(s2);
  ia?.drenar();
  ia?.detener();
  meta?.detener();
  await pool.query('DELETE FROM whatsapp_entradas WHERE negocio_id=$1 AND telefono=$2', [negocioId, telefono]);
  await pool.query('DELETE FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2', [negocioId, telefono]);
  await pool.query('DELETE FROM conversacion_estado WHERE negocio_id=$1 AND session_id=$2', [negocioId, `meta-${negocioId}-${telefono}`]);
  await pool.query('DELETE FROM conversacion_estado WHERE negocio_id=$1 AND session_id=$2', [negocioId, `agente:${telefono}`]);
  await pool.query('DELETE FROM mensajes WHERE negocio_id=$1 AND telefono=$2', [negocioId, telefono]);
  await pool.query('DELETE FROM whatsapp_entradas WHERE negocio_id=$1 AND telefono=$2', [negocioId, fueraDelPiloto]);
  await pool.query('DELETE FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2', [negocioId, fueraDelPiloto]);
  await pool.query('DELETE FROM mensajes WHERE negocio_id=$1 AND telefono=$2', [negocioId, fueraDelPiloto]);
  await pool.query('DELETE FROM integraciones_canal WHERE identificador=$1', [identificador]);
  if (productoPrueba) await pool.query('DELETE FROM menu_productos WHERE id=$1 AND negocio_id=$2', [productoPrueba, negocioId]);
  if (categoriaPrueba) await pool.query('DELETE FROM menu_categorias WHERE id=$1 AND negocio_id=$2', [categoriaPrueba, negocioId]);
  if (limpiezaNecesaria) {
    for (const clave of clavesConfiguracionPrueba) {
      if (Object.prototype.hasOwnProperty.call(cfgOriginal, clave)) {
        await actualizarConfiguracion({ [clave]: cfgOriginal[clave] }, negocioId);
      } else {
        await pool.query(
          'DELETE FROM configuracion WHERE negocio_id=$1 AND clave=$2', [negocioId, clave],
        );
      }
    }
  }
  await pool.query('UPDATE negocios SET bot_whatsapp_activo=$2 WHERE id=$1', [negocioId, botOriginal]);
  await pool.end();
}
