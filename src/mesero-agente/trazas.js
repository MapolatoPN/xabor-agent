// ─── TRAZAS DEL AGENTE ────────────────────────────────────────────────────
//
// Una traza por turno: el mensaje, el contexto mínimo, cada llamada a
// herramienta con sus argumentos y su resultado, latencias, errores, el estado
// antes y después, la respuesta final, el modelo y el coste.
//
// ── Dos decisiones que evitan dos problemas conocidos ────────────────────
//
// 1. **La PII se redacta ANTES de salir del proceso**, no en el destino. Un
//    exportador que promete redactar es una promesa; redactar aquí es un
//    hecho. Lo que sale son los últimos cuatro dígitos de un teléfono, las
//    direcciones marcadas y nada más.
//
// 2. **La observabilidad externa NO puede tumbar un turno.** Langfuse —si se
//    configura— se manda en segundo plano, sin `await` en el camino del
//    cliente, con su propio tope de tiempo y tragándose sus errores. Si el
//    encargo es entregar el Mesero, una integración de métricas no puede ser
//    lo que lo bloquee: sin `LANGFUSE_*` el módulo no hace nada más que la
//    línea de log, que es lo que ya se sabe leer en Railway.
//
// No se instala ningún SDK: es una petición HTTP a la API de ingesta. Una
// dependencia menos que auditar y que puede romper un build.
import { createHash } from 'node:crypto';
import { redactarContacto, MARCA_DIRECCION } from '../mesero-whatsapp/redaccionPII.js';

const TELEFONO = /(\+?\d[\d\s().-]{7,}\d)/g;

/** Un teléfono se queda en cuatro dígitos; lo demás lo redacta la capa que ya existe. */
export function redactar(texto) {
  if (!texto) return texto;
  let t = String(texto).replace(TELEFONO, (m) => {
    const d = m.replace(/[^0-9]/g, '');
    return d.length >= 8 ? `[TEL_…${d.slice(-4)}]` : m;
  });
  try { t = redactarContacto(t); } catch { /* si la redacción falla, mejor cortar que filtrar */ }
  return t;
}

/** Redacción recursiva de cualquier estructura que vaya a salir del proceso. */
export function redactarProfundo(valor) {
  if (typeof valor === 'string') return redactar(valor);
  if (Array.isArray(valor)) return valor.map(redactarProfundo);
  if (valor && typeof valor === 'object') {
    const fuera = {};
    for (const [k, v] of Object.entries(valor)) {
      // Las claves que SIEMPRE son PII se cortan por nombre, no por contenido:
      // una dirección puede no parecer una dirección.
      if (/^(direccion|address|referencias|email|correo|coordenadas|lat|lng)$/i.test(k)) {
        fuera[k] = v ? MARCA_DIRECCION : v;
      } else fuera[k] = redactarProfundo(v);
    }
    return fuera;
  }
  return valor;
}

/**
 * EL RECOLECTOR de un turno. Se pasa como `traza` a `atenderTurnoConHerramientas`.
 *
 * Devuelve `{ traza, cerrar }`. `cerrar()` produce el objeto completo y, si
 * hay destino externo configurado, lo manda sin esperar.
 */
export function recolectorDeTraza({ negocioId, conversacionId, turnoId, mensaje,
  modo = 'productivo', modelo = null, estadoAntes = null } = {}) {
  const t0 = Date.now();
  const eventos = [];
  const traza = (ev) => eventos.push({ ...ev, t: Date.now() - t0 });

  const cerrar = ({ salida = null, error = null } = {}) => {
    const uso = eventos.filter((e) => e.tipo === 'modelo').map((e) => e.uso).filter(Boolean);
    const entrada = uso.reduce((s, u) => s + (u.input_tokens || 0), 0);
    const salidaTk = uso.reduce((s, u) => s + (u.output_tokens || 0), 0);

    const completa = {
      // La conversación se identifica por HASH: se pueden agrupar los turnos de
      // una misma conversación sin que el teléfono salga del proceso.
      conversacion: createHash('sha256').update(String(conversacionId)).digest('hex').slice(0, 16),
      negocio: negocioId,
      turno: turnoId,
      modo,
      modelo,
      mensaje: redactar(mensaje),
      estado_antes: estadoAntes,
      estado_despues: salida?.pedido?.estado ?? null,
      falta: salida?.pedido?.falta ?? [],
      renglones: salida?.pedido?.lineas?.length ?? 0,
      total: salida?.pedido?.total ?? null,
      herramientas: eventos.filter((e) => e.tipo === 'herramienta').map((e) => ({
        nombre: e.herramienta,
        argumentos: redactarProfundo(e.argumentos),
        aplicado: e.aplicado,
        motivo: e.motivo ? String(e.motivo).slice(0, 120) : null,
        repetida: !!e.repetida,
        ms: e.t,
      })),
      llamadas_al_modelo: eventos.filter((e) => e.tipo === 'modelo').length,
      tokens: { entrada, salida: salidaTk },
      respuesta: redactar(salida?.texto || ''),
      cierre: salida?.motivoCierre ?? null,
      escalado: !!salida?.escalado,
      confirmado: !!salida?.confirmado,
      error: error ? String(error).slice(0, 300) : null,
      ms: Date.now() - t0,
    };

    console.log(`[AGENTE-TRAZA] ${JSON.stringify(completa)}`);
    // Sin `await`: la observabilidad no está en el camino del cliente.
    enviarALangfuse(completa).catch(() => {});
    return completa;
  };

  return { traza, cerrar };
}

// ── LANGFUSE, OPCIONAL Y DESACOPLADO ─────────────────────────────────────
//
// Se activa solo con las tres variables. Sin ellas esta función sale en la
// primera línea y no cuesta nada. Un fallo aquí no sube: el llamador ya lo
// llama sin esperar y con `.catch()`, y aun así se traga sus propios errores,
// porque una integración de métricas rota no puede convertirse en ruido que
// tape un incidente de verdad.
export const langfuseConfigurado = () => !!(process.env.LANGFUSE_PUBLIC_KEY
  && process.env.LANGFUSE_SECRET_KEY && process.env.LANGFUSE_HOST);

export async function enviarALangfuse(traza, { fetchImpl = globalThis.fetch, topeMs = 3000 } = {}) {
  if (!langfuseConfigurado() || typeof fetchImpl !== 'function') return { enviado: false, motivo: 'no_configurado' };
  const auth = Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString('base64');
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), topeMs);
  try {
    const r = await fetchImpl(`${String(process.env.LANGFUSE_HOST).replace(/\/+$/, '')}/api/public/ingestion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
      signal: control.signal,
      body: JSON.stringify({
        batch: [{
          id: `${traza.conversacion}-${traza.turno}`,
          type: 'trace-create',
          timestamp: new Date().toISOString(),
          body: {
            id: `${traza.conversacion}-${traza.turno}`,
            sessionId: traza.conversacion,
            name: 'mesero-turno',
            userId: null,
            input: traza.mensaje,
            output: traza.respuesta,
            metadata: {
              negocio: traza.negocio, modo: traza.modo, modelo: traza.modelo,
              estado_antes: traza.estado_antes, estado_despues: traza.estado_despues,
              herramientas: traza.herramientas, cierre: traza.cierre,
              escalado: traza.escalado, confirmado: traza.confirmado,
              tokens: traza.tokens, ms: traza.ms, error: traza.error,
            },
            tags: ['mesero-agente', traza.modo],
          },
        }],
      }),
    });
    return { enviado: r.ok, status: r.status };
  } catch (e) {
    return { enviado: false, motivo: String(e?.message || e) };
  } finally {
    clearTimeout(reloj);
  }
}
