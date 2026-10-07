import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { disponibilidadAsistente, exigirAsistenteDisponible, motivoSinAgente } from '../src/services/politicaAsistente.js';
import { resumirEstadoBotPanel } from '../src/services/estadoBotPanel.js';
import { decidirRutaCateringWhatsApp } from '../src/channels/enrutamientoCatering.js';

let pasadas = 0;
async function caso(nombre, fn) { await fn(); console.log(`OK Asistente ${++pasadas}: ${nombre}`); }
const base = { mesero_agente_v1: 'true', mesero_agente_telefonos: '528781234567' };
await caso('disponibilidad exige proceso, negocio y alcance, sin asumir valores truthy', () => {
  assert.equal(disponibilidadAsistente(base, true).listo, true);
  assert.equal(disponibilidadAsistente(base, false).motivo, 'AGENTE_PROCESO_APAGADO');
  for (const bandera of ['false', '1', 'yes', '']) assert.equal(disponibilidadAsistente({ ...base, mesero_agente_v1: bandera }, true).listo, false);
  assert.equal(disponibilidadAsistente({ mesero_agente_v1: 'true' }, true).motivo, 'AGENTE_SIN_ALCANCE');
});
await caso('lista prevalece; un alcance inválido no activa por porcentaje', () => {
  assert.equal(disponibilidadAsistente({ ...base, mesero_agente_porcentaje: '100' }, true).alcance, 'lista');
  for (const lista of ['123', '123,528781234567']) assert.equal(disponibilidadAsistente({ ...base, mesero_agente_telefonos: lista, mesero_agente_porcentaje: '100' }, true).listo, false);
  for (const porcentaje of ['-1', '101', 'abc', '0']) assert.equal(disponibilidadAsistente({ mesero_agente_v1: 'true', mesero_agente_porcentaje: porcentaje }, true).listo, false);
  assert.equal(disponibilidadAsistente({ mesero_agente_v1: 'true', mesero_agente_porcentaje: '10' }, true).listo, true);
});
await caso('solo prueba exige lista; guardar reglas no modifica alcance', async () => {
  const cfg = { mesero_agente_v1: 'true', bot_whatsapp_solo_prueba: 'true', mesero_agente_porcentaje: '100' };
  assert.equal(disponibilidadAsistente(cfg, true).listo, false);
  const copia = structuredClone(base); disponibilidadAsistente(base, true); assert.deepEqual(base, copia);
  const anterior = process.env.MESERO_AGENTE_MODE; process.env.MESERO_AGENTE_MODE = 'true';
  try {
    const llamadas = [];
    const db = { query: async (sql, args) => {
      llamadas.push(sql); assert.deepEqual(args, ['negocio-propio']);
      return { rows: Object.entries(base).map(([clave, valor]) => ({ clave, valor })) };
    } };
    assert.equal((await exigirAsistenteDisponible(db, 'negocio-propio')).listo, true);
    assert.equal(llamadas.length, 1); assert.match(llamadas[0], /^SELECT/); assert.match(llamadas[0], /FOR SHARE/);
    await assert.rejects(exigirAsistenteDisponible({ query: async () => ({ rows: [] }) }, 'negocio-propio'), e => e.codigo === 'ASISTENTE_NO_DISPONIBLE');
    await assert.rejects(exigirAsistenteDisponible({ query: async () => { throw Error('DB'); } }, 'negocio-propio'), /DB/);
  } finally { if (anterior === undefined) delete process.env.MESERO_AGENTE_MODE; else process.env.MESERO_AGENTE_MODE = anterior; }
});
await caso('panel informa motor y alcance sin revelar teléfonos ni prometer disponibilidad', () => {
  const piloto = resumirEstadoBotPanel(true, base, true);
  assert.equal(piloto.motor, 'agente_herramientas'); assert.equal(piloto.alcance, 'piloto'); assert.equal(piloto.puedeActivar, true);
  assert(!JSON.stringify(piloto).includes('528781234567'));
  assert.equal(resumirEstadoBotPanel(true, base, false).agenteDisponible, false);
  assert.match(resumirEstadoBotPanel(true, base, false).titulo, /Atención humana/);
  assert.equal(resumirEstadoBotPanel(false, base, true).botWhatsappActivo, false);
  assert.equal(resumirEstadoBotPanel(true, { mesero_agente_v1: 'true', mesero_agente_porcentaje: '100' }, true).alcance, 'todos');
});
await caso('catering siempre va al agente nuevo o revisión, incluso el perfil anterior', () => {
  assert.equal(decidirRutaCateringWhatsApp({ sesionAnteriorActiva: true, canarioActivo: true }), 'revision');
  for (const campo of ['solicitudExplicita', 'entradaPerfilCatering', 'eventoCanarioActivo']) {
    assert.equal(decidirRutaCateringWhatsApp({ [campo]: true, canarioActivo: true }), 'agente');
    assert.equal(decidirRutaCateringWhatsApp({ [campo]: true, canarioActivo: false }), 'revision');
  }
});

const canal = readFileSync(new URL('../src/channels/whatsapp-meta.js', import.meta.url), 'utf8');
const inicio = canal.indexOf('async function procesarConClaude(');
const fin = canal.indexOf('// ─── Enrutamiento repartidor/cliente', inicio);
assert(inicio >= 0 && fin > inicio);
const funcion = canal.slice(inicio, fin);
async function ejecutarTurno(modo, confirmada = true) {
  const efectos = { revision: [], facturacion: 0, enviados: 0 };
  const errorHandoffNoConfirmado = () => Object.assign(Error('handoff no confirmado'), { codigo: 'AGENTE_HANDOFF_NO_CONFIRMADO' });
  const dependencias = {
    obtenerCredencialesWhatsappNegocio: async n => { assert.equal(n, 'negocio'); return {}; },
    modoDelPedido: async () => modo, motivoSinAgente,
    pasarAgenteARevision: async ({ motivo }) => { efectos.revision.push(motivo); return confirmada; },
    continuidadWA: {}, errorHandoffNoConfirmado,
    esSolicitudFactura: () => false, tieneContextoFiscal: async () => false,
    manejarFacturacionWhatsapp: async () => { efectos.facturacion++; return { manejado: true }; },
    registrarError: () => {}, esErrorRespuestaTruncada: () => false, esErrorSalidaInternaNoPublicable: () => false,
    enviarMensaje: async () => { efectos.enviados++; }, console: { log() {}, error() {} },
  };
  const procesar = new Function(...Object.keys(dependencias), `${funcion}; return procesarConClaude;`)(...Object.values(dependencias));
  if (!confirmada) await assert.rejects(procesar('528781234567', 'hola', 'Cliente', 'negocio'), e => e.codigo === 'AGENTE_HANDOFF_NO_CONFIRMADO');
  else await procesar('528781234567', 'hola', 'Cliente', 'negocio');
  return efectos;
}
await caso('runtime del canal: sin agente o fuera del piloto no ejecuta atajos ni modelo', async () => {
  for (const modo of [null, {}, { agente: false, modo: 'legacy' }, { agente: false, canario: { dentro: false } }]) {
    const r = await ejecutarTurno(modo); assert.deepEqual(r, { revision: ['AGENTE_FUERA_DE_ALCANCE'], facturacion: 0, enviados: 0 });
  }
});
await caso('runtime: fallo al guardar revisión se propaga sin respuesta falsa ni reintento', async () => {
  assert.deepEqual(await ejecutarTurno({ agente: false }, false), { revision: ['AGENTE_FUERA_DE_ALCANCE'], facturacion: 0, enviados: 0 });
});
await caso('runtime: dentro del alcance continúan los servicios del agente nuevo', async () => {
  assert.deepEqual(await ejecutarTurno({ agente: true }), { revision: [], facturacion: 1, enviados: 0 });
});
await caso('ninguna entrada de WhatsApp carga brain; simulador y activación son coherentes', () => {
  for (const archivo of ['whatsapp-meta.js', 'whatsapp.js']) {
    const s = readFileSync(new URL(`../src/channels/${archivo}`, import.meta.url), 'utf8');
    assert.doesNotMatch(s, /from ['"].*agent\/brain\.js['"]|procesarMensaje\(|extraerBorradorParaSombra\(/);
  }
  const twilio = readFileSync(new URL('../src/channels/whatsapp.js', import.meta.url), 'utf8'); assert.match(twilio, /status\(410\)/);
  const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(server, /simularConAgente\(\{/); assert.doesNotMatch(server, /simularMensaje\(/);
  assert.equal((server.match(/e\.codigo === 'ASISTENTE_NO_DISPONIBLE'/g) || []).length, 2);
  const db = readFileSync(new URL('../src/services/database.js', import.meta.url), 'utf8');
  const cambio = db.slice(db.indexOf('export async function actualizarBotWhatsappActivoNegocio'), db.indexOf('// ─── Asistente IA'));
  assert(cambio.indexOf('if (activo)') < cambio.indexOf('UPDATE negocios SET bot_whatsapp_activo'));
  assert.match(cambio, /exigirAsistenteDisponible\(client, negocioId.trim\(\)\)/);
});
console.log(`Asistente exclusivo: ${pasadas} grupos pasados, sin IA, proveedores ni impresoras.`);
