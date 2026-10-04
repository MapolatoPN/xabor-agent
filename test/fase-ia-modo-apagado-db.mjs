// ─── MODO FORMULARIO: CON LA BANDERA SIN VALOR, EL CANAL ES EL DE fc1c803 ──
//
// La misma conversación guionada (20 turnos: saludo, toques del inicio Mapo,
// pedido escrito, formulario, resumen, «sí», consultas, cerrado, «no carga»,
// cortesía y estado) por el `atenderConAgente` de la BASE (el src/ de fc1c803
// montado en /app/.base-ia, o BASE_IA_DIR) y por el de este checkout, cada uno
// con su negocio idéntico en la misma base local, sin la bandera. Exige que
// sean iguales, turno por turno: lo que sale al cliente (texto e interactivo,
// sin tokens ni identificadores), la traza (agente_turnos, sin ids ni
// latencias) y el estado de la conversación (sin ids ni fechas).
//
// Base local test_botones_*, red solo local. Modelo, Meta y registro: dobles.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
Object.assign(process.env, { MESERO_AGENTE_MODE: 'true', WHATSAPP_INTERACTIVOS: 'true', WHATSAPP_FLOW_ENDPOINT: 'true',
  WHATSAPP_FLOW_PRIVATE_KEY: 'solo-local', META_APP_SECRET: 'solo-local' });

const raiz = fileURLToPath(new URL('../', import.meta.url));
const DIR_BASE = process.env.BASE_IA_DIR || join(raiz, '.base-ia');
if (!existsSync(join(DIR_BASE, 'src/mesero-agente/canalDelAgente.js'))) {
  console.log(`FALLA: no encuentro el src/ de la base en ${DIR_BASE} (montar fc1c803 en /app/.base-ia)`);
  process.exit(1);
}
const importar = (dir, r) => import(pathToFileURL(join(dir, r)).href);
const lados = {
  base: { canal: await importar(DIR_BASE, 'src/mesero-agente/canalDelAgente.js'),
    entrega: await importar(DIR_BASE, 'src/mesero-agente/entregaDeRespuestas.js'),
    db: await importar(DIR_BASE, 'src/services/database.js'),
    continuidad: await importar(DIR_BASE, 'src/services/whatsappContinuidad.js'),
    aviso: await importar(DIR_BASE, 'src/services/avisoRescateHumano.js') },
  nuevo: { canal: await importar(raiz, 'src/mesero-agente/canalDelAgente.js'),
    entrega: await importar(raiz, 'src/mesero-agente/entregaDeRespuestas.js'),
    db: await importar(raiz, 'src/services/database.js'),
    continuidad: await importar(raiz, 'src/services/whatsappContinuidad.js'),
    aviso: await importar(raiz, 'src/services/avisoRescateHumano.js') },
};
const { prepararNegocioMixtos } = await import('./lib-botones-local.mjs');
const { pool, actualizarConfiguracion } = lados.nuevo.db;
for (const l of Object.values(lados)) l.aviso.configurarAvisoRescate({ broadcastPanel: () => {}, enviarAvisoWhatsapp: async () => {}, log: () => {} });

let n = 0, fallidas = 0;
const caso = async (nombre, fn) => {
  try { await fn(); console.log(`OK paridad ${++n}: ${nombre}`); }
  catch (e) { fallidas++; console.log(`FALLA paridad: ${nombre}\n  ${String(e?.message || e).split('\n').slice(0, 3).join(' | ').slice(0, 1500)}`); }
};

// Lo aleatorio (uuid, tokens, lid, fechas, wamid, negocio y teléfono) se nombra por orden de aparición.
const normalizar = (v, { negocioId, telefono, productoId, mixtosId }) => {
  const m = new Map();
  return JSON.stringify(v ?? null)
    .split(negocioId).join('NEGOCIO').split(telefono).join('TEL')
    // La traza redacta lo que parece teléfono, también dentro de un uuid al azar.
    .replace(/"dialogo_id":"[^"]*"/g, '"dialogo_id":"ID"').replace(/\[TEL_…\d{4}\]/g, 'TELR')
    .replace(new RegExp(`\\b${productoId}\\b`, 'g'), 'PRODUCTO').replace(new RegExp(`\\b${mixtosId}\\b`, 'g'), 'MIXTOS')
    .replace(/xb1:[A-Za-z0-9_-]{22}/g, 'TOKEN')
    .replace(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d(?::?\d\d)?)?/g, 'FECHA')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\bit[0-9a-z]{9,13}\b|wamid\.[A-Za-z0-9._-]+|\b[a-f0-9]{64}\b/g,
      (x) => { if (!m.has(x)) m.set(x, `ID${m.size}`); return m.get(x); });
};

const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
const reglas = (abierto) => ({ restaurante: 'Mapolato', timezone: 'America/Matamoros',
  horarios: Object.fromEntries(DIAS.map((d) => [d, abierto ? { abierto: true, apertura: '00:00', cierre: '24:00' } : { abierto: false }])),
  pedidos: { modalidades: ['recoger en tienda', 'entrega a domicilio'], tiempo_preparacion_minutos: 25, tiempo_entrega_min_minutos: 45,
    tiempo_entrega_max_minutos: 45, pedido_minimo_entrega: 0, costo_envio: 60, pago_aceptado: ['efectivo'] },
  cierres_especiales: [], promociones: [], politicas: [],
  bot: { faqs: [{ pregunta: '¿Tienen mesas?', respuesta: 'Sí, tenemos mesas.' }] } });
const CONFIGS = {
  obispado: { whatsapp_flow_categorias_id: '11111111111', whatsapp_flow_carrito_id: '22222222222', whatsapp_flow_configurar_id: '44444444444',
    whatsapp_carrito_unificado_v1: 'true', whatsapp_flow_carrito_duplicar_v1: 'true' },
  legado: { whatsapp_flow_productos_id: '12121212121', whatsapp_flow_editar_id: '13131313131', whatsapp_flow_configurar_id: '44444444444',
    whatsapp_carrito_unificado_v1: 'false' },
};

async function negocio(lado, formularios) {
  const f = await prepararNegocioMixtos();
  f.estado.carrito.items = [];
  await pool.query('UPDATE conversacion_estado SET estado=$3 WHERE negocio_id=$1 AND session_id=$2',
    [f.negocioId, `agente:${f.telefono}`, JSON.stringify(f.estado)]);
  await actualizarConfiguracion({ nombre: 'Mapolato Obispado', whatsapp_inicio_mapo_v1: 'true', whatsapp_atencion_general_v1: 'true',
    bot_whatsapp_solo_prueba: 'false', mesero_agente_porcentaje: '100', mesero_agente_telefonos: '', whatsapp_flows_v1: 'true',
    whatsapp_flows_telefonos: '', whatsapp_beta_hibrido_v1: 'true', whatsapp_beta_telefonos: '', whatsapp_interactivos_elecciones_v1: 'true',
    ...CONFIGS[formularios], whatsapp_flow_facturacion_id: '66666666666', whatsapp_flow_evento_id: '77777777777',
    whatsapp_eventos_formulario_v1: 'true', whatsapp_rescate_humano_v1: 'true', direccion: 'Libramiento 2416', ciudad: 'Piedras Negras',
    reglas_atencion: JSON.stringify(reglas(true)) }, f.negocioId);
  const L = lados[lado];
  const cont = L.continuidad.crearContinuidad({ pool: L.db.pool, locks: L.db.pool, procesar: async () => { throw Error('X'); },
    cargarSesion: async () => {}, leerSesion: async () => ({}), alRevision: (neg, tel) => L.db.setBotPausado(tel, true, neg) });
  const escalar = async (neg, tel, motivo) => (await cont.enviarARevision(neg, tel, motivo)) || cont.revisionActiva(neg, tel);
  const modelo = async ({ messages }) => {
    const ultimo = String(messages.at(-1)?.content ?? '');
    if (/chilaquiles mixtos/.test(ultimo) && messages.at(-1).role === 'user' && typeof messages.at(-1).content === 'string') {
      return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu-1', name: 'agregar_producto',
        input: { producto_id: String(f.mixtosId), cantidad: 2 } }] };
    }
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Con gusto te ayudo.' }] };
  };
  let folios = 0;
  const salidas = [];
  const turno = async (m) => {
    await pool.query("INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'completado')",
      [f.negocioId, f.telefono, m.id, JSON.stringify({ message: m })]);
    const r = await L.canal.atenderConAgente({ negocioId: f.negocioId, telefono: f.telefono, nombre: 'Cliente local',
      mensaje: m.type === 'text' ? m.text.body : '', wamids: [m.id], interaccion: m.type === 'interactive' ? { mensajes: [m], mixto: false } : null,
      llamarModelo: modelo, escalarAHumano: escalar, registrar: async () => ({ ok: true, folio: `XAB-P${++folios}`, total: 240 }),
      emitir: async () => {}, guardar: async () => {}, crearPago: async () => { throw Error('SIN_PAGOS'); } });
    await L.aviso.esperarAvisosEnCurso();
    const fila = r.outbox ? (await pool.query('SELECT carga FROM agente_outbox WHERE evento_clave=$1', [r.outbox.clave])).rows[0] : null;
    const wamid = `wamid.salida.${randomUUID()}`;
    if (fila && r.ok) await L.entrega.entregarRespuesta({ outboxClave: r.outbox.clave, enviar: async () => ({ messages: [{ id: wamid }] }), alHumano: async () => {} });
    const estado = (await pool.query('SELECT estado FROM conversacion_estado WHERE negocio_id=$1 AND session_id=$2', [f.negocioId, `agente:${f.telefono}`])).rows[0]?.estado;
    const t = (await pool.query(`SELECT fase_antes, fase_despues, pendiente_antes, pendiente_despues, acciones, rechazos, folio, motivo_handoff,
      cierre, recuperacion FROM agente_turnos WHERE negocio_id=$1 ORDER BY id DESC LIMIT 1`, [f.negocioId])).rows[0];
    const { _revision, _actualizadoAt, _inactividadMs, version, turnosAplicados, ultimoWamid, ...estadoComparable } = estado || {};
    salidas.push(normalizar({ ok: r.ok, sinRespuesta: !!r.sinRespuesta, texto: fila?.carga?.texto ?? null, interactivo: fila?.carga?.interactivo ?? null,
      texto_fallback: fila?.carga?.texto_fallback ?? null, beta: fila?.carga?.beta ?? null, turno: t, estado: estadoComparable }, f));
    return { r, carga: fila?.carga || {}, wamid };
  };
  const id = () => ({ id: `wamid.par.${randomUUID()}`, from: f.telefono, timestamp: String(Math.floor(Date.now() / 1000)) });
  const texto = (body) => turno({ ...id(), type: 'text', text: { body } });
  const tocar = (q, titulo) => {
    const i = q.carga.interactivo; const filas = i?.type === 'list' ? i.action.sections[0].rows : i?.action?.buttons?.map((b) => b.reply) || [];
    const fila = filas.find((r) => r.title === titulo); assert(fila, `${lado}: sin «${titulo}» en ${JSON.stringify(filas.map((r) => r.title))}`);
    const tipo = i.type === 'list' ? 'list_reply' : 'button_reply';
    return turno({ ...id(), type: 'interactive', context: { id: q.wamid }, interactive: { type: tipo, [tipo]: { id: fila.id, title: 'x' } } });
  };
  const flow = (q, campos) => turno({ ...id(), type: 'interactive', context: { id: q.wamid }, interactive: { type: 'nfm_reply',
    nfm_reply: { name: 'flow', body: 'Sent', response_json: JSON.stringify({ flow_token: q.carga.interactivo.action.parameters.flow_token, ...campos }) } } });
  const foto = async () => (await pool.query(`SELECT b.datos FROM agente_botones b JOIN agente_preguntas_interactivas p ON p.id=b.pregunta_id
    WHERE p.negocio_id=$1 ORDER BY p.created_at DESC LIMIT 1`, [f.negocioId])).rows[0]?.datos;
  const configurar = (cambios) => actualizarConfiguracion(cambios, f.negocioId);
  const despausar = async () => {
    await pool.query('UPDATE conversaciones_control SET bot_pausado=false, updated_by=NULL WHERE negocio_id=$1 AND telefono=$2', [f.negocioId, f.telefono]);
    await pool.query('UPDATE whatsapp_conversaciones SET requiere_revision=false, motivo=NULL WHERE negocio_id=$1 AND telefono=$2', [f.negocioId, f.telefono]);
  };
  return { f, texto, tocar, flow, foto, configurar, despausar, salidas };
}

// Los dos guiones, idénticos para la base y para este checkout.
async function guionObispado(x) {
  const hola = await x.texto('hola');
  await x.tocar(hola, 'Ordenar');
  await x.texto('¿hacen eventos? es para un cumpleaños de 50 personas');
  await x.texto('Quiero 2 chilaquiles mixtos');
  await x.texto('¿A qué hora cierran?');
  await x.texto('¿Tienen café americano?');
  await x.texto('¿Qué promociones tienen?');
  await x.texto('mejor sin cebolla');
  await x.configurar({ reglas_atencion: JSON.stringify(reglas(false)) });
  await x.texto('quiero 1 café americano');
  await x.configurar({ reglas_atencion: JSON.stringify(reglas(true)) });
  await x.texto('No carga');
  await x.despausar();
  await x.texto('asdf qwer');
  await x.texto('gracias');
  await x.texto('Persona');
}
async function guionLegado(x) {
  const q = await x.texto('quiero hacer un pedido');
  const foto = await x.foto();
  const i = foto.productos.findIndex((p) => p.nombre === 'Café americano');
  const aplicado = await x.flow(q, { producto0: `p${i}` });
  if (aplicado.carga.interactivo?.type === 'flow') {
    const f2 = await x.foto();
    await x.flow(aplicado, { modalidad: 'm0', pago: 'p0', ...(f2?.lineas ? {} : {}) });
  }
  await x.texto('sí');
  await x.texto('gracias');
  await x.texto('¿cuánto falta?');
  await x.texto('¿Tienen mesas?');
}

try {
  for (const [nombre, guion, formularios] of [['Obispado (categorías, rescate, eventos)', guionObispado, 'obispado'],
    ['formularios de siempre (Flow aplicado, resumen, «sí», tras el pedido)', guionLegado, 'legado']]) {
    await caso(nombre, async () => {
      const base = await negocio('base', formularios);
      const nuevo = await negocio('nuevo', formularios);
      await guion(base);
      await guion(nuevo);
      assert.equal(nuevo.salidas.length, base.salidas.length, 'distinto número de turnos');
      assert(base.salidas.length >= 6);
      base.salidas.forEach((b, i) => {
        const a = nuevo.salidas[i];
        if (a !== b) {
          let k = 0; while (k < a.length && a[k] === b[k]) k++;
          assert.fail(`turno ${i + 1}: difiere en ${k}: nuevo «${a.slice(Math.max(0, k - 120), k + 160)}» base «${b.slice(Math.max(0, k - 120), k + 160)}»`);
        }
      });
      // El guion recorrió lo que dice recorrer (en los dos lados).
      const todo = nuevo.salidas.join('\n');
      if (formularios === 'legado') assert.match(todo, /"folio":"XAB-P1"/, 'el «sí» no registró el pedido');
      else for (const huella of ['Mapo Bot', 'FORMULARIO_NO_CARGA', 'ya cerramos', '"flow_id":"11111111111"', '"flow_id":"77777777777"']) {
        assert(todo.includes(huella), `el guion no pasó por «${huella}»`);
      }
      console.log(`  ${base.salidas.length} turnos idénticos`);
    });
  }
} finally {
  console.log(`\nparidad del canal con la bandera sin valor: ${n} pasadas, ${fallidas} fallidas`);
  await Promise.all(Object.values(lados).map((l) => l.db.pool.end().catch(() => {})));
  if (fallidas) process.exitCode = 1;
}
