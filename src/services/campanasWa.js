/**
 * campanasWa.js — campañas de WhatsApp con plantilla aprobada por Meta.
 *
 *   plantillasDelNegocio   lee de Meta las plantillas de la cuenta del negocio
 *   prepararCampana        valida y cuenta a quién le llegaría (vista previa)
 *   crearCampanaPlantilla  la guarda y deja la COLA en campana_envios
 *   procesarColaCampanas   el trabajo en segundo plano que la va mandando
 *   sincronizarEntregas    copia los acuses de Meta (entregado/leído/no llegó)
 *   detenerCampana, listarCampanasWa, enviarPrueba
 *
 * Reglas que no se negocian:
 *   - El negocio sale SIEMPRE de la sesión; cada consulta filtra por él.
 *   - Un mensaje cuyo envío quedó en duda (se cayó la red a medio camino) se
 *     marca 'incierto' y nunca se reintenta solo: uno de marketing se cobra.
 *   - Detener corta la cola: lo que no salió queda 'cancelado'.
 *   - Solo una campaña mandándose a la vez por negocio (una pausada cuenta).
 *   - Se manda solo de 9:00 a 20:59, hora del negocio.
 *   - Por tandas: a lo más `tope_24h` envíos en 24 h, y si los rechazos pasan
 *     `umbral_rechazo_pct` la campaña se pausa sola hasta que la reanuden.
 *   - Va a los clientes de la Lista menos bajas, teléfonos del negocio,
 *     internos y repartidores. La baja (botón o 131050) se anota en el cliente.
 *   - Nada de esto corre en el camino del webhook ni de los pedidos.
 */
import { pool, obtenerCredencialesWhatsappNegocio } from './database.js';
import { zonaHorariaNegocio } from './cortesCaja.js';
import { candidatosCampanaCrm } from './clientesCrm.js';
import { registrarTelefonoWhatsapp } from './clientesSaneamiento.js';
import {
  DIAS_SIN_REPETIR, ErrorCampana, analizarPlantilla, clasificarErrorMeta, construirComponentes, costoAproximado,
  dentroDeHorario, esBotonDeBaja, explicarCodigo, nombreUsable, rebasaUmbral, segmentoValido, telefonoParaMeta,
  usaNombreDelCliente, validarTandas, validarVariables, vistaPrevia,
} from './campanasWaPlantillas.js';

export { ErrorCampana } from './campanasWaPlantillas.js';

// Solo para pruebas: un servidor local que simula la Graph API (mismo
// contrato que META_GRAPH_BASE_URL en whatsapp-meta.js). En producción no
// existe y se usa el host de siempre.
const graph = () => `${process.env.META_GRAPH_BASE_URL || 'https://graph.facebook.com'}/v20.0`;
const ESPERA_ENTRE_ENVIOS_MS = 120;
const PRESUPUESTO_POR_VUELTA_MS = 8000;
const TIEMPO_MAXIMO_META_MS = 20000;
// Si los primeros N envíos de una campaña fallan todos con el MISMO código y
// ninguno salió, el problema es de la campaña (una variable que Meta no
// acepta, un idioma que no existe), no de los clientes: se detiene.
const FALLOS_SEGUIDOS_PARA_DETENER = 5;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Meta ────────────────────────────────────────────────────────────────────
async function cuentaWhatsapp(negocioId) {
  const { rows: [r] } = await pool.query(
    `SELECT waba_id FROM integraciones_canal
      WHERE negocio_id = $1 AND canal = 'whatsapp' AND proveedor = 'meta' AND estado = 'activo'
      ORDER BY updated_at DESC NULLS LAST LIMIT 1`, [negocioId]);
  return r?.waba_id || null;
}

async function pedirMeta(url, { credenciales, fetchImpl = fetch, metodo = 'GET', cuerpo } = {}) {
  const resp = await fetchImpl(url, {
    method: metodo,
    signal: AbortSignal.timeout(TIEMPO_MAXIMO_META_MS),
    headers: { Authorization: `Bearer ${credenciales.accessToken}`, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const datos = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, datos };
}

const cachePlantillas = new Map(); // negocioId → { hasta, valor }

/**
 * Las plantillas de la cuenta de WhatsApp del negocio, ya analizadas. Si Meta
 * falla o el número no está conectado, lo dice en `motivo` para que el panel
 * lo muestre (solo un error de la base se lanza).
 */
export async function plantillasDelNegocio(negocioId, { fetchImpl = fetch, sinCache = false } = {}) {
  const c = cachePlantillas.get(negocioId);
  if (!sinCache && c && c.hasta > Date.now()) return c.valor;
  const credenciales = await obtenerCredencialesWhatsappNegocio(negocioId);
  if (!credenciales) return { conectado: false, motivo: 'Este negocio no tiene su WhatsApp conectado.', plantillas: [] };
  const waba = await cuentaWhatsapp(negocioId);
  if (!waba) {
    return { conectado: false, plantillas: [],
      motivo: 'No encontramos la cuenta de WhatsApp Business de este número. Reconéctalo desde Configuración → WhatsApp.' };
  }
  const plantillas = [];
  try {
    let url = `${graph()}/${encodeURIComponent(waba)}/message_templates?fields=id,name,status,category,language,components,parameter_format&limit=100`;
    for (let pagina = 0; url && pagina < 5; pagina++) {
      const r = await pedirMeta(url, { credenciales, fetchImpl });
      if (!r.ok) {
        const codigo = r.datos?.error?.code ?? null;
        return { conectado: true, plantillas: [], motivo: `Meta no nos dejó leer las plantillas: ${explicarCodigo(codigo)}.` };
      }
      for (const p of Array.isArray(r.datos?.data) ? r.datos.data : []) plantillas.push(analizarPlantilla(p));
      // La página siguiente solo se pide al mismo Graph de Meta: lleva el token del negocio.
      const siguiente = r.datos?.paging?.next;
      url = typeof siguiente === 'string' && siguiente.startsWith(`${graph()}/`) ? siguiente : null;
    }
  } catch {
    return { conectado: true, plantillas: [], motivo: 'Meta no respondió al pedir las plantillas. Intenta de nuevo en un momento.' };
  }
  // Mejor esfuerzo: calidad y límite diario del número. Si Meta no lo da, no se
  // muestra. De paso, el número mismo queda como teléfono del negocio.
  let numero = null;
  try {
    const r = await pedirMeta(
      `${graph()}/${encodeURIComponent(credenciales.phoneNumberId)}?fields=display_phone_number,quality_rating,messaging_limit_tier`,
      { credenciales, fetchImpl });
    if (r.ok) numero = { calidad: r.datos?.quality_rating || null, limite: r.datos?.messaging_limit_tier || null };
    if (r.ok && typeof r.datos?.display_phone_number === 'string') {
      await registrarTelefonoWhatsapp(negocioId, r.datos.display_phone_number).catch(() => {});
    }
  } catch { /* sin dato */ }
  plantillas.sort((a, b) => Number(b.compatible) - Number(a.compatible) || a.nombre.localeCompare(b.nombre));
  const valor = { conectado: true, motivo: null, plantillas, numero };
  cachePlantillas.set(negocioId, { hasta: Date.now() + 60_000, valor });
  return valor;
}

function respuestaEnvio(r) {
  const wamid = r.datos?.messages?.[0]?.id;
  if (r.ok && wamid) return { ok: true, wamid };
  if (r.ok) return { ok: false, tipo: 'incierto', codigo: null };
  const codigo = Number.isSafeInteger(r.datos?.error?.code) ? r.datos.error.code : null;
  return { ok: false, tipo: clasificarErrorMeta({ status: r.status, codigo }), codigo };
}

async function mandarPlantilla(credenciales, telefono, analisis, componentes, fetchImpl) {
  try {
    const r = await pedirMeta(`${graph()}/${encodeURIComponent(credenciales.phoneNumberId)}/messages`, {
      credenciales, fetchImpl, metodo: 'POST',
      cuerpo: {
        messaging_product: 'whatsapp', recipient_type: 'individual', to: telefono, type: 'template',
        template: { name: analisis.nombre, language: { code: analisis.idioma }, ...(componentes.length ? { components: componentes } : {}) },
      },
    });
    return respuestaEnvio(r);
  } catch {
    // Timeout o red caída: no sabemos si Meta lo recibió.
    return { ok: false, tipo: 'incierto', codigo: null };
  }
}

// ─── A quién le llega ────────────────────────────────────────────────────────
// Los clientes de la Lista (clientes_negocio) del segmento, menos: teléfonos
// del negocio, internos, repartidores, número inválido, quien se dio de baja
// (en su ficha o con un 131050 de Meta) y quien recibió otra campaña hace poco.
// Cada excluido se cuenta en la primera razón que le toca.
async function destinatarios(negocioId, segmento, { excluirRecientes }) {
  const base = await candidatosCampanaCrm(negocioId, segmento);
  const { rows: bajas } = await pool.query(
    `SELECT DISTINCT e.telefono_envio FROM campana_envios e JOIN campanas c ON c.id = e.campana_id
      WHERE c.negocio_id = $1 AND e.telefono_envio IS NOT NULL AND e.error_codigo = 131050`, [negocioId]);
  const { rows: recientes } = excluirRecientes ? await pool.query(
    `SELECT DISTINCT e.telefono_envio FROM campana_envios e JOIN campanas c ON c.id = e.campana_id
      WHERE c.negocio_id = $1 AND c.tipo = 'plantilla' AND e.cola_at > now() - make_interval(days => $2)
        AND e.estado IN ('pendiente', 'enviando', 'enviado', 'incierto')`, [negocioId, DIAS_SIN_REPETIR]) : { rows: [] };
  const sinBaja = new Set(bajas.map((r) => r.telefono_envio));
  const yaRecibieron = new Set(recientes.map((r) => r.telefono_envio));
  const lista = []; const vistos = new Set();
  const excluidos = { delNegocio: 0, internos: 0, repartidores: 0, sinNumero: 0, repetidos: 0, pidieronBaja: 0, recientes: 0 };
  for (const d of base) {
    if (d.esDelNegocio) { excluidos.delNegocio++; continue; }
    if (d.esInterno) { excluidos.internos++; continue; }
    if (d.esRepartidor) { excluidos.repartidores++; continue; }
    const t = telefonoParaMeta(d.telefono);
    if (!t) { excluidos.sinNumero++; continue; }
    if (vistos.has(t)) { excluidos.repetidos++; continue; }
    vistos.add(t);
    if (d.consentimiento === 'baja' || sinBaja.has(t)) { excluidos.pidieronBaja++; continue; }
    if (yaRecibieron.has(t)) { excluidos.recientes++; continue; }
    lista.push({ clienteId: d.id, telefono: d.telefono, telefonoEnvio: t, nombre: d.nombre || null });
  }
  return { lista, excluidos };
}

async function plantillaElegida(negocioId, { nombre, idioma }, opciones) {
  const leidas = await plantillasDelNegocio(negocioId, opciones);
  if (!leidas.conectado) throw new ErrorCampana(leidas.motivo, 'SIN_WHATSAPP');
  if (leidas.motivo) throw new ErrorCampana(leidas.motivo, 'META_NO_RESPONDE');
  const p = leidas.plantillas.find((x) => x.nombre === nombre && x.idioma === idioma);
  if (!p) throw new ErrorCampana('Esa plantilla ya no está en tu cuenta de WhatsApp (o cambió de idioma). Recarga la lista.', 'PLANTILLA_NO_EXISTE');
  if (!p.compatible) throw new ErrorCampana(`Esa plantilla no se puede mandar desde Xabor: ${p.razones.join('; ')}.`, 'PLANTILLA_NO_COMPATIBLE');
  return p;
}

/**
 * Lo que el administrador ve ANTES de mandar: a cuántos le llegaría, cuánto
 * cuesta más o menos y cómo se verá con el nombre del primer cliente.
 */
export async function prepararCampana(negocioId, datos, opciones = {}) {
  if (!segmentoValido(datos?.segmento)) throw new ErrorCampana('Elige a quién mandarle la campaña.', 'SEGMENTO_INVALIDO');
  const analisis = await plantillaElegida(negocioId, { nombre: datos.plantilla, idioma: datos.idioma }, opciones);
  const { variables, respaldoNombre } = validarVariables(analisis, datos.variables, datos.respaldoNombre);
  const tandas = validarTandas(datos.tope24h, datos.umbralRechazoPct);
  const excluirRecientes = datos.excluirRecientes !== false;
  const { lista, excluidos } = await destinatarios(negocioId, datos.segmento, { excluirRecientes });
  const usaNombre = usaNombreDelCliente(variables);
  // El primero con nombre de verdad, para que la vista previa no salude «Hola Rappi».
  const ejemplo = lista.find((d) => nombreUsable(d.nombre)) || lista[0];
  return {
    analisis, variables, respaldoNombre, excluirRecientes, tandas, lista,
    resumen: {
      total: lista.length, excluidos, costo: costoAproximado(analisis.categoria, lista.length), categoria: analisis.categoria,
      vista: vistaPrevia(analisis, variables, ejemplo?.nombre, respaldoNombre),
      // Cuántos van con el texto de respaldo y cómo les llega.
      usaNombre,
      sinNombre: usaNombre ? lista.filter((d) => !nombreUsable(d.nombre)).length : 0,
      vistaSinNombre: usaNombre ? vistaPrevia(analisis, variables, null, respaldoNombre) : null,
      tandas: { ...tandas, cuantas: lista.length ? Math.ceil(lista.length / tandas.tope24h) : 0 },
    },
  };
}

export async function crearCampanaPlantilla(negocioId, datos, { usuarioId = null, ...opciones } = {}) {
  const nombre = String(datos?.nombre || '').trim().slice(0, 120);
  if (!nombre) throw new ErrorCampana('Ponle un nombre a la campaña.', 'NOMBRE_FALTA');
  // Se vuelve a leer la plantilla de Meta (sin caché): pudo pausarse o cambiar.
  const prep = await prepararCampana(negocioId, datos, { ...opciones, sinCache: true });
  if (!prep.lista.length) throw new ErrorCampana('Nadie en esa lista puede recibirla ahora.', 'SIN_DESTINATARIOS');
  if (Number(datos.totalVisto) !== prep.lista.length) {
    throw new ErrorCampana(`La lista cambió mientras la revisabas: ahora son ${prep.lista.length}. Revísala otra vez antes de mandar.`,
      'LISTA_CAMBIO', { total: prep.lista.length });
  }
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query("SELECT pg_advisory_xact_lock(hashtextextended('campanas-wa:' || $1::text, 0))", [negocioId]);
    const { rows: [activa] } = await cliente.query(
      `SELECT id, nombre FROM campanas WHERE negocio_id = $1 AND tipo = 'plantilla' AND estado = 'enviando' LIMIT 1`, [negocioId]);
    if (activa) {
      throw new ErrorCampana(`Ya se está mandando «${activa.nombre}». Espera a que termine o detenla para mandar otra.`, 'OTRA_EN_CURSO');
    }
    const plantilla = { analisis: prep.analisis, variables: prep.variables, respaldoNombre: prep.respaldoNombre,
      excluirRecientes: prep.excluirRecientes };
    const { rows: [c] } = await cliente.query(
      `INSERT INTO campanas (nombre, segmento, mensaje, total_destinatarios, estado, negocio_id, tipo, plantilla, creada_por,
                             tope_24h, umbral_rechazo_pct)
       VALUES ($1, $2, $3, $4, 'enviando', $5, 'plantilla', $6::jsonb, $7, $8, $9) RETURNING id`,
      [nombre, datos.segmento, prep.analisis.cuerpo, prep.lista.length, negocioId, JSON.stringify(plantilla),
        usuarioId ? String(usuarioId) : null, prep.tandas.tope24h, prep.tandas.umbralRechazoPct]);
    await cliente.query(
      `INSERT INTO campana_envios (campana_id, telefono, nombre, estado, cola_at, telefono_envio, cliente_id)
       SELECT $1, t, n, 'pendiente', now(), te, ci FROM unnest($2::text[], $3::text[], $4::text[], $5::uuid[]) AS x(t, n, te, ci)
       ON CONFLICT DO NOTHING`,
      [c.id, prep.lista.map((d) => d.telefono), prep.lista.map((d) => d.nombre), prep.lista.map((d) => d.telefonoEnvio),
        prep.lista.map((d) => d.clienteId || null)]);
    await cliente.query('COMMIT');
    return { campanaId: c.id, total: prep.lista.length };
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

// Pruebas al número del administrador: pocas, para que no sirva de atajo.
const pruebas = new Map(); // negocioId → [ms]
export async function enviarPrueba(negocioId, datos, { fetchImpl = fetch, ahora = Date.now() } = {}) {
  const telefono = telefonoParaMeta(datos?.telefono);
  if (!telefono) throw new ErrorCampana('Escribe tu número de WhatsApp a 10 dígitos.', 'TELEFONO_INVALIDO');
  const recientes = (pruebas.get(negocioId) || []).filter((t) => ahora - t < 10 * 60_000);
  if (recientes.length >= 5) throw new ErrorCampana('Ya mandaste 5 pruebas en 10 minutos. Espera un poco.', 'DEMASIADAS_PRUEBAS');
  const analisis = await plantillaElegida(negocioId, { nombre: datos.plantilla, idioma: datos.idioma }, { fetchImpl });
  const { variables, respaldoNombre } = validarVariables(analisis, datos.variables, datos.respaldoNombre);
  const credenciales = await obtenerCredencialesWhatsappNegocio(negocioId);
  if (!credenciales) throw new ErrorCampana('Este negocio no tiene su WhatsApp conectado.', 'SIN_WHATSAPP');
  pruebas.set(negocioId, [...recientes, ahora]);
  const r = await mandarPlantilla(credenciales, telefono, analisis,
    construirComponentes(analisis, variables, datos.nombrePrueba, respaldoNombre), fetchImpl);
  if (!r.ok) throw new ErrorCampana(`Meta no la mandó: ${explicarCodigo(r.codigo)}.`, 'META_RECHAZO', { codigoMeta: r.codigo });
  return { ok: true };
}

export async function detenerCampana(negocioId, campanaId, { motivo = 'Detenida desde el panel' } = {}) {
  const id = Number(campanaId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ErrorCampana('Campaña inválida.', 'NO_EXISTE');
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const { rows: [c] } = await cliente.query(
      `UPDATE campanas SET estado = 'detenida', detenida_at = now(), detenida_motivo = $3
        WHERE id = $1 AND negocio_id = $2 AND tipo = 'plantilla' AND estado = 'enviando' RETURNING id`, [id, negocioId, motivo]);
    if (!c) throw new ErrorCampana('Esa campaña ya no se está mandando.', 'NO_EN_CURSO');
    const { rowCount } = await cliente.query(
      `UPDATE campana_envios SET estado = 'cancelado' WHERE campana_id = $1 AND estado = 'pendiente'`, [id]);
    await cliente.query('COMMIT');
    return { ok: true, cancelados: rowCount };
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

const idCampana = (v) => {
  const id = Number(v);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ErrorCampana('Campaña inválida.', 'NO_EXISTE');
  return id;
};

/** Pausa a mano: la cola no la toca, pero nada se cancela. */
export async function pausarCampana(negocioId, campanaId, { motivo = 'Pausada desde el panel' } = {}) {
  const { rows: [c] } = await pool.query(
    `UPDATE campanas SET pausada_at = now(), pausada_motivo = $3
      WHERE id = $1 AND negocio_id = $2 AND tipo = 'plantilla' AND estado = 'enviando' AND pausada_at IS NULL RETURNING id`,
    [idCampana(campanaId), negocioId, String(motivo).slice(0, 300)]);
  if (!c) throw new ErrorCampana('Esa campaña no se está mandando (o ya estaba pausada).', 'NO_EN_CURSO');
  return { ok: true };
}

/** Reanuda una pausada. El umbral de rechazos vuelve a medir desde aquí. */
export async function reanudarCampana(negocioId, campanaId) {
  const { rows: [c] } = await pool.query(
    `UPDATE campanas SET pausada_at = NULL, pausada_motivo = NULL, reanudada_at = now()
      WHERE id = $1 AND negocio_id = $2 AND tipo = 'plantilla' AND estado = 'enviando' AND pausada_at IS NOT NULL RETURNING id`,
    [idCampana(campanaId), negocioId]);
  if (!c) throw new ErrorCampana('Esa campaña no está pausada.', 'NO_PAUSADA');
  return { ok: true };
}

// ─── La cola ─────────────────────────────────────────────────────────────────
// Cuántos más caben en la tanda: el tope cuenta lo intentado en las últimas
// 24 h (como el límite de Meta). Un envío que Meta pidió reintentar no cuenta.
async function cupoDeTanda(c) {
  if (!Number.isInteger(c.tope_24h)) return Infinity;
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM campana_envios
      WHERE campana_id = $1 AND estado <> 'pendiente' AND intento_at > now() - interval '24 hours'`, [c.id]);
  return Math.max(0, c.tope_24h - r.n);
}

// Rechazos desde la última vez que se reanudó: lo que Meta no aceptó al
// mandar y lo que aceptó pero después dijo que no llegó.
async function pausarSiRebasa(c) {
  if (!Number.isInteger(c.umbral_rechazo_pct)) return false;
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE estado IN ('enviado', 'fallido'))::int AS intentos,
            COUNT(*) FILTER (WHERE estado = 'fallido' OR no_entregado_at IS NOT NULL)::int AS rechazos
       FROM campana_envios WHERE campana_id = $1 AND intento_at > COALESCE($2::timestamptz, '-infinity')`,
    [c.id, c.reanudada_at || null]);
  if (!rebasaUmbral(r, c.umbral_rechazo_pct)) return false;
  const pct = Math.round((r.rechazos * 100) / r.intentos);
  await pool.query(
    `UPDATE campanas SET pausada_at = now(), pausada_motivo = $2
      WHERE id = $1 AND estado = 'enviando' AND pausada_at IS NULL`,
    [c.id, `Se pausó sola: ${r.rechazos} de ${r.intentos} no llegaron (${pct}%, el tope es ${c.umbral_rechazo_pct}%). Revisa los motivos antes de reanudar.`]);
  return true;
}

async function tomarSiguiente(campanaId) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const { rows: [e] } = await cliente.query(
      `SELECT e.id, e.telefono_envio, e.nombre FROM campana_envios e
         JOIN campanas c ON c.id = e.campana_id AND c.estado = 'enviando'
        WHERE e.campana_id = $1 AND e.estado = 'pendiente'
        ORDER BY e.id LIMIT 1 FOR UPDATE OF e SKIP LOCKED`, [campanaId]);
    if (e) await cliente.query(`UPDATE campana_envios SET estado = 'enviando', intento_at = now() WHERE id = $1`, [e.id]);
    await cliente.query('COMMIT');
    return e || null;
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

async function terminarSiVacia(campanaId) {
  await pool.query(
    `UPDATE campanas SET estado = 'completada', completada_at = now()
      WHERE id = $1 AND estado = 'enviando'
        AND NOT EXISTS (SELECT 1 FROM campana_envios WHERE campana_id = $1 AND estado IN ('pendiente', 'enviando'))`, [campanaId]);
}

async function anotarResultado(campanaId, envioId, r) {
  if (r.ok) {
    await pool.query(`UPDATE campana_envios SET estado = 'enviado', wamid = $2, enviado_at = now() WHERE id = $1`, [envioId, r.wamid]);
    await pool.query('UPDATE campanas SET enviados = enviados + 1 WHERE id = $1', [campanaId]);
  } else if (r.tipo === 'destinatario') {
    await pool.query(`UPDATE campana_envios SET estado = 'fallido', error_codigo = $2, enviado_at = now() WHERE id = $1`, [envioId, r.codigo]);
    await pool.query('UPDATE campanas SET fallidos = fallidos + 1 WHERE id = $1', [campanaId]);
  } else if (r.tipo === 'incierto') {
    await pool.query(`UPDATE campana_envios SET estado = 'incierto', error_codigo = $2 WHERE id = $1`, [envioId, r.codigo]);
  } else {
    // detener / reintentar: este cliente no se tocó, vuelve a la fila.
    await pool.query(`UPDATE campana_envios SET estado = 'pendiente', intento_at = NULL WHERE id = $1`, [envioId]);
  }
}

async function fallaDeCampana(campanaId) {
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE estado = 'enviado')::int AS salieron,
            COUNT(*) FILTER (WHERE estado = 'fallido')::int AS fallaron,
            COUNT(DISTINCT error_codigo) FILTER (WHERE estado = 'fallido')::int AS codigos,
            MIN(error_codigo) FILTER (WHERE estado = 'fallido') AS codigo
       FROM campana_envios WHERE campana_id = $1`, [campanaId]);
  return r.salieron === 0 && r.fallaron >= FALLOS_SEGUIDOS_PARA_DETENER && r.codigos === 1 ? r.codigo : undefined;
}

async function detenerPorFalla(campanaId, negocioId, codigo) {
  await detenerCampana(negocioId, campanaId, { motivo: `Se detuvo sola: ${explicarCodigo(codigo)}` }).catch(() => {});
}

/**
 * Una vuelta del trabajo en segundo plano. Nunca lanza. `deps` existe para las
 * pruebas: fetch simulado, reloj fijo y sin esperas.
 */
export async function procesarColaCampanas({ fetchImpl = fetch, ahora = () => new Date(), esperaMs = ESPERA_ENTRE_ENVIOS_MS,
  presupuestoMs = PRESUPUESTO_POR_VUELTA_MS, log = console } = {}) {
  const inicio = Date.now();
  const resumen = { enviados: 0, fallidos: 0, inciertos: 0, detenidas: 0, pausadas: 0 };
  try {
    // Lo que quedó «enviando» de una vuelta que se murió (redeploy a la
    // mitad): no sabemos si salió, y no se reintenta solo.
    await pool.query(`UPDATE campana_envios SET estado = 'incierto'
                        WHERE estado = 'enviando' AND intento_at < now() - interval '5 minutes'`);
    const { rows: campanas } = await pool.query(
      `SELECT id, negocio_id::text AS negocio_id, plantilla, tope_24h, umbral_rechazo_pct, reanudada_at FROM campanas
        WHERE tipo = 'plantilla' AND estado = 'enviando' AND pausada_at IS NULL
          AND (reanudar_at IS NULL OR reanudar_at <= now())
        ORDER BY creada_at`);
    for (const c of campanas) {
      if (Date.now() - inicio > presupuestoMs) break;
      const zona = await zonaHorariaNegocio(c.negocio_id);
      if (!dentroDeHorario(ahora(), zona)) continue;
      const credenciales = await obtenerCredencialesWhatsappNegocio(c.negocio_id);
      if (!credenciales) {
        await detenerCampana(c.negocio_id, c.id, { motivo: 'Se detuvo sola: el WhatsApp del negocio está desconectado' }).catch(() => {});
        resumen.detenidas++;
        continue;
      }
      const { analisis, variables, respaldoNombre } = c.plantilla || {};
      if (!analisis?.nombre || !variables) {
        await detenerCampana(c.negocio_id, c.id, { motivo: 'Se detuvo sola: la campaña no tiene plantilla guardada' }).catch(() => {});
        resumen.detenidas++;
        continue;
      }
      // Los acuses tardíos («no llegó») cuentan: se revisa antes de mandar más.
      if (await pausarSiRebasa(c)) { resumen.pausadas++; continue; }
      let cupo = await cupoDeTanda(c);
      while (cupo > 0 && Date.now() - inicio <= presupuestoMs) {
        const envio = await tomarSiguiente(c.id);
        if (!envio) { await terminarSiVacia(c.id); break; }
        cupo--;
        const r = await mandarPlantilla(credenciales, envio.telefono_envio, analisis,
          construirComponentes(analisis, variables, envio.nombre, respaldoNombre), fetchImpl);
        await anotarResultado(c.id, envio.id, r);
        if (r.ok) resumen.enviados++;
        else if (r.tipo === 'destinatario') resumen.fallidos++;
        else if (r.tipo === 'incierto') resumen.inciertos++;
        if (!r.ok && r.tipo === 'detener') {
          await detenerPorFalla(c.id, c.negocio_id, r.codigo);
          resumen.detenidas++;
          break;
        }
        if (!r.ok && r.tipo === 'reintentar') {
          await pool.query(`UPDATE campanas SET reanudar_at = now() + interval '2 minutes' WHERE id = $1`, [c.id]);
          break;
        }
        if (!r.ok && r.tipo === 'destinatario') {
          const codigo = await fallaDeCampana(c.id);
          if (codigo !== undefined) { await detenerPorFalla(c.id, c.negocio_id, codigo); resumen.detenidas++; break; }
          if (await pausarSiRebasa(c)) { resumen.pausadas++; break; }
        }
        if (esperaMs) await dormir(esperaMs);
      }
    }
  } catch (e) {
    log.error?.('[CAMPANAS-WA] cola:', e.message);
  }
  return resumen;
}

/**
 * Copia a campana_envios los acuses que el webhook ya guarda en
 * whatsapp_estados_mensaje (si el negocio tiene la trazabilidad encendida).
 * Leído implica entregado; un «no llegó» tardío nunca borra una entrega.
 */
export async function sincronizarEntregas({ log = console } = {}) {
  try {
    const { rowCount } = await pool.query(`
      WITH pend AS (
        SELECT e.id, e.wamid, c.negocio_id
          FROM campana_envios e JOIN campanas c ON c.id = e.campana_id
         WHERE e.wamid IS NOT NULL AND e.enviado_at > now() - interval '30 days'
           AND e.leido_at IS NULL AND e.no_entregado_at IS NULL
      ), ev AS (
        SELECT p.id,
               MIN(m.ocurrido_at) FILTER (WHERE m.estado = 'delivered') AS entregado,
               MIN(m.ocurrido_at) FILTER (WHERE m.estado = 'read') AS leido,
               MIN(m.ocurrido_at) FILTER (WHERE m.estado = 'failed') AS fallido,
               (ARRAY_AGG(m.error_codigo ORDER BY m.ocurrido_at) FILTER (WHERE m.estado = 'failed'))[1] AS codigo
          FROM pend p JOIN whatsapp_estados_mensaje m ON m.negocio_id = p.negocio_id AND m.wamid = p.wamid
         GROUP BY p.id
      )
      UPDATE campana_envios e SET
        entregado_at = COALESCE(e.entregado_at, ev.entregado, ev.leido),
        leido_at = COALESCE(e.leido_at, ev.leido),
        no_entregado_at = CASE WHEN COALESCE(e.entregado_at, ev.entregado, ev.leido) IS NULL THEN ev.fallido END,
        error_codigo = CASE WHEN COALESCE(e.entregado_at, ev.entregado, ev.leido) IS NULL AND ev.fallido IS NOT NULL
                            THEN ev.codigo ELSE e.error_codigo END
      FROM ev
      WHERE e.id = ev.id
        AND (ev.entregado IS NOT NULL OR ev.leido IS NOT NULL OR ev.fallido IS NOT NULL)
        AND (e.entregado_at IS DISTINCT FROM COALESCE(e.entregado_at, ev.entregado, ev.leido)
             OR e.leido_at IS DISTINCT FROM COALESCE(e.leido_at, ev.leido)
             OR (COALESCE(e.entregado_at, ev.entregado, ev.leido) IS NULL AND ev.fallido IS NOT NULL))`);
    return rowCount;
  } catch (e) {
    if (e.code === '42P01') return 0; // sin la 111: no hay acuses que copiar
    log.error?.('[CAMPANAS-WA] acuses:', e.message);
    return 0;
  }
}

// ─── Bajas ───────────────────────────────────────────────────────────────────
// Quien se da de baja queda así EN SU FICHA (cliente_consentimientos, con
// fecha y fuente), no solo en el historial de envíos. Dos señales:
//   · tocó el botón de baja de una campaña: llega como mensaje «button» cuyo
//     context.id es el wamid que mandamos (se lee de whatsapp_entradas, sin
//     tocar el webhook);
//   · Meta rechazó un envío con 131050 (ya había pedido no recibir promociones).
// Una sola vez por envío (baja_at). Si su estado vigente ya es «baja», no se
// repite la fila.
const LOTE_ENTRADAS = 5000;

async function anotarBaja(db, { negocioId, clienteId, telefono, fuente }) {
  const { rows: [c] } = clienteId
    ? await db.query('SELECT id FROM clientes_negocio WHERE negocio_id = $1 AND id = $2', [negocioId, clienteId])
    : await db.query(`SELECT id FROM clientes_negocio WHERE negocio_id = $1
                        AND telefono = right(regexp_replace($2, '\\D', '', 'g'), 10)`, [negocioId, String(telefono || '')]);
  if (!c) return false;
  const { rows: [vigente] } = await db.query(
    `SELECT otorgado FROM cliente_consentimientos WHERE negocio_id = $1 AND cliente_id = $2 AND canal = 'whatsapp'
      ORDER BY created_at DESC, id DESC LIMIT 1`, [negocioId, c.id]);
  if (vigente && vigente.otorgado === false) return false;
  await db.query(
    `INSERT INTO cliente_consentimientos (negocio_id, cliente_id, canal, otorgado, fuente) VALUES ($1, $2, 'whatsapp', false, $3)`,
    [negocioId, c.id, fuente]);
  return true;
}

const pareceBotonDeBaja = (botones, texto, carga) => {
  const deLaPlantilla = (Array.isArray(botones) ? botones : []).filter((b) => b?.baja).map((b) => String(b.texto).trim().toLowerCase());
  const t = String(texto || '').trim().toLowerCase();
  return (t && deLaPlantilla.includes(t)) || esBotonDeBaja(texto) || esBotonDeBaja(carga);
};

/** Trabajo en segundo plano. Nunca lanza. Devuelve cuántas bajas anotó. */
export async function registrarBajasCampanas({ log = console } = {}) {
  let anotadas = 0;
  const db = await pool.connect();
  try {
    // 1) Rechazos 131050.
    await db.query('BEGIN');
    const { rows: rechazos } = await db.query(
      `SELECT e.id, e.cliente_id, e.telefono, c.negocio_id::text AS negocio_id
         FROM campana_envios e JOIN campanas c ON c.id = e.campana_id
        WHERE e.error_codigo = 131050 AND e.baja_at IS NULL
        ORDER BY e.id LIMIT 500 FOR UPDATE OF e SKIP LOCKED`);
    for (const r of rechazos) {
      if (await anotarBaja(db, { negocioId: r.negocio_id, clienteId: r.cliente_id, telefono: r.telefono, fuente: 'meta_131050' })) anotadas++;
      await db.query('UPDATE campana_envios SET baja_at = now() WHERE id = $1', [r.id]);
    }
    await db.query('COMMIT');

    // 2) Toques del botón de baja, desde el último mensaje revisado. El minuto
    // de margen deja que termine de guardarse lo que acaba de llegar.
    await db.query('BEGIN');
    // La primera vez arranca en lo último que llegó antes de la primera campaña
    // con plantilla (o en lo último, si no hay ninguna): lo anterior no puede
    // ser respuesta a una campaña.
    let { rows: [cur] } = await db.query(`SELECT ultimo_id FROM campanas_wa_cursor WHERE nombre = 'bajas' FOR UPDATE`);
    if (!cur) {
      await db.query(
        `INSERT INTO campanas_wa_cursor (nombre, ultimo_id)
         SELECT 'bajas', COALESCE(
           (SELECT max(id) FROM whatsapp_entradas
             WHERE recibido_at < (SELECT min(creada_at) FROM campanas WHERE tipo = 'plantilla')),
           CASE WHEN EXISTS (SELECT 1 FROM campanas WHERE tipo = 'plantilla') THEN 0 END,
           (SELECT max(id) FROM whatsapp_entradas), 0)
         ON CONFLICT DO NOTHING`);
      ({ rows: [cur] } = await db.query(`SELECT ultimo_id FROM campanas_wa_cursor WHERE nombre = 'bajas' FOR UPDATE`));
    }
    // Corta ANTES de la primera entrada reciente: si una de hace segundos queda
    // entre dos viejas, el cursor no la brinca (se revisa en la vuelta siguiente).
    const { rows: [lim] } = await db.query(
      `SELECT max(id) AS hasta FROM (SELECT id FROM whatsapp_entradas
         WHERE id > $1
           AND id < COALESCE((SELECT min(id) FROM whatsapp_entradas
                               WHERE id > $1 AND recibido_at >= clock_timestamp() - interval '1 minute'), 9223372036854775807)
         ORDER BY id LIMIT $2) x`,
      [cur.ultimo_id, LOTE_ENTRADAS]);
    if (lim.hasta) {
      const { rows: toques } = await db.query(
        `SELECT w.id AS entrada_id, w.negocio_id::text AS negocio_id,
                w.payload->'message'->'button'->>'text' AS texto, w.payload->'message'->'button'->>'payload' AS carga,
                e.id AS envio_id, e.cliente_id, e.telefono, e.baja_at, c.plantilla->'analisis'->'botones' AS botones
           FROM whatsapp_entradas w
           JOIN campana_envios e ON e.wamid = w.payload->'message'->'context'->>'id'
           JOIN campanas c ON c.id = e.campana_id AND c.negocio_id = w.negocio_id
          WHERE w.id > $1 AND w.id <= $2 AND w.payload->'message'->>'type' = 'button'
          ORDER BY w.id`, [cur.ultimo_id, lim.hasta]);
      for (const t of toques) {
        if (t.baja_at || !pareceBotonDeBaja(t.botones, t.texto, t.carga)) continue;
        if (await anotarBaja(db, { negocioId: t.negocio_id, clienteId: t.cliente_id, telefono: t.telefono, fuente: 'campana_boton_baja' })) anotadas++;
        await db.query('UPDATE campana_envios SET baja_at = now() WHERE id = $1 AND baja_at IS NULL', [t.envio_id]);
      }
      await db.query(`UPDATE campanas_wa_cursor SET ultimo_id = $1, updated_at = now() WHERE nombre = 'bajas'`, [lim.hasta]);
    }
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    if (e.code !== '42P01') log.error?.('[CAMPANAS-WA] bajas:', e.message);
  } finally {
    db.release();
  }
  return anotadas;
}

// ─── Lo que ve el panel ──────────────────────────────────────────────────────
export async function trazabilidadEncendida(negocioId) {
  const { rows: [r] } = await pool.query(
    "SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = 'whatsapp_trazabilidad_formularios_v1'", [negocioId]);
  return String(r?.valor) === 'true';
}

export async function listarCampanasWa(negocioId) {
  const { rows } = await pool.query(`
    SELECT c.id, c.nombre, c.segmento, c.tipo, c.estado, c.total_destinatarios, c.creada_at, c.completada_at,
           c.detenida_motivo, c.reanudar_at, c.enviados AS enviados_texto, c.fallidos AS fallidos_texto, c.respondidos,
           c.tope_24h, c.umbral_rechazo_pct, c.pausada_at, c.pausada_motivo,
           COUNT(e.id) FILTER (WHERE e.estado <> 'pendiente' AND e.intento_at > now() - interval '24 hours')::int AS intentos_24h,
           COUNT(e.id) FILTER (WHERE e.baja_at IS NOT NULL)::int AS bajas,
           c.plantilla->'analisis'->>'nombre' AS plantilla_nombre, c.plantilla->'analisis'->>'categoria' AS categoria,
           COUNT(e.id) FILTER (WHERE e.estado IN ('pendiente', 'enviando'))::int AS en_cola,
           COUNT(e.id) FILTER (WHERE e.wamid IS NOT NULL)::int AS aceptados,
           COUNT(e.id) FILTER (WHERE e.entregado_at IS NOT NULL)::int AS entregados,
           COUNT(e.id) FILTER (WHERE e.leido_at IS NOT NULL)::int AS leidos,
           COUNT(e.id) FILTER (WHERE e.estado = 'fallido' OR e.no_entregado_at IS NOT NULL)::int AS no_llegaron,
           COUNT(e.id) FILTER (WHERE e.estado = 'incierto')::int AS inciertos,
           COUNT(e.id) FILTER (WHERE e.estado = 'cancelado')::int AS cancelados,
           COUNT(e.id) FILTER (WHERE e.respondio_at IS NOT NULL)::int AS respondieron
      FROM campanas c LEFT JOIN campana_envios e ON e.campana_id = c.id
     WHERE c.negocio_id = $1
     GROUP BY c.id ORDER BY c.creada_at DESC LIMIT 20`, [negocioId]);
  const ids = rows.filter((r) => r.tipo === 'plantilla').map((r) => r.id);
  const { rows: motivos } = ids.length ? await pool.query(`
    SELECT campana_id, error_codigo, COUNT(*)::int AS n FROM campana_envios
     WHERE campana_id = ANY($1::int[]) AND (estado = 'fallido' OR no_entregado_at IS NOT NULL)
     GROUP BY 1, 2 ORDER BY 3 DESC`, [ids]) : { rows: [] };
  return rows.map((r) => ({
    id: r.id, nombre: r.nombre, segmento: r.segmento, tipo: r.tipo, estado: r.estado, total: r.total_destinatarios,
    creada: r.creada_at, completada: r.completada_at, motivoDetenida: r.detenida_motivo, reanudar: r.reanudar_at,
    plantilla: r.plantilla_nombre, categoria: r.categoria,
    ...(r.tipo === 'plantilla'
      ? { enCola: r.en_cola, enviados: r.aceptados, entregados: r.entregados, leidos: r.leidos, noLlegaron: r.no_llegaron,
          inciertos: r.inciertos, cancelados: r.cancelados, respondieron: r.respondieron, bajas: r.bajas,
          tope24h: r.tope_24h, umbralRechazoPct: r.umbral_rechazo_pct, pausada: r.pausada_at, motivoPausa: r.pausada_motivo,
          intentos24h: r.intentos_24h,
          tandaLlena: Number.isInteger(r.tope_24h) && r.estado === 'enviando' && r.en_cola > 0 && r.intentos_24h >= r.tope_24h }
      : { enviados: r.enviados_texto, fallidos: r.fallidos_texto, respondieron: r.respondidos }),
    motivos: motivos.filter((m) => m.campana_id === r.id).slice(0, 4)
      .map((m) => ({ codigo: m.error_codigo, n: m.n, explicacion: explicarCodigo(m.error_codigo) })),
  }));
}
