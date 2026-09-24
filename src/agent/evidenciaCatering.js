// Procedencia de los datos de catering.
//
// El modelo puede proponer campos, pero no puede convertirlos en hechos. Un
// valor nuevo solo entra al estado si aparece en las palabras del cliente en
// ESTE turno. Los valores ya aceptados se pueden repetir sin perderlos.

const normalizar = (valor) => String(valor ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9ñ:/.-]+/g, ' ')
  .replace(/\s+/g, ' ').trim();

export const MARCA_EVIDENCIA_CATERING = '__evidencia_catering_v1';

const CAMPO_CANONICO = Object.freeze({
  nombre: 'nombre',
  personas: 'numero_personas',
  numero_personas: 'numero_personas',
  lugar: 'lugar',
  fecha_hora: 'fecha_evento',
  fecha_evento: 'fecha_evento',
  tipo_servicio: 'observaciones',
  observaciones: 'observaciones',
});

const iguales = (a, b) => normalizar(a) !== '' && normalizar(a) === normalizar(b);

const escaparRegex = (valor) => String(valor).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const conLimites = (mensaje, valor) => {
  const buscado = normalizar(valor);
  if (!buscado) return false;
  return new RegExp(`(^|[^a-z0-9])${escaparRegex(buscado)}(?=$|[^a-z0-9])`)
    .test(normalizar(mensaje));
};

const respuestaDirecta = (mensaje, valor) => normalizar(mensaje)
  .replace(/[^a-z0-9]+/g, ' ').trim() === normalizar(valor)
    .replace(/[^a-z0-9]+/g, ' ').trim();

function enteroExplicito(valor, mensaje, { campoEsperado = null } = {}) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1 || n > 10000) return false;
  const t = normalizar(mensaje);
  if (campoEsperado === 'numero_personas') {
    // Solo después de que Xabor preguntó por asistentes aceptamos respuestas
    // naturales sin repetir «personas». Todo el mensaje debe corresponder a
    // la respuesta: Calle 80, 20/10/2026 o «a las 2» siguen sin autorizar un
    // número aunque contengan los mismos dígitos.
    const directo = t.replace(/[^a-z0-9]+/g, ' ').trim();
    const formaNatural = new RegExp(
      `^(?:(?:somos|seremos|seriamos|serian|son|vamos\\s+a\\s+ser|van\\s+a\\s+ser)\\s+`
        + `(?:(?:unas?|unos?|aproximadamente|aprox|como)\\s+)?${n}`
        + `|para\\s+(?:(?:unas?|unos?|aproximadamente|aprox|como)\\s+)?${n}`
        + `|(?:unas?|unos?|aproximadamente|aprox|como|alrededor\\s+de)\\s+${n}`
        + `|${n}(?:\\s+en\\s+total)?)`
        + `(?:\\s+(?:personas?|invitad(?:o|a)s?|asistentes?|comensales?|pax))?$`,
    );
    if (formaNatural.test(directo)) return true;
  }
  return new RegExp(
    `(?:\\b${n}\\s*(?:personas?|invitad(?:o|a)s?|asistentes?|comensales?|pax)\\b`
      + `|\\b(?:personas?|invitad(?:o|a)s?|asistentes?|comensales?|pax)\\s*[:=-]?\\s*${n}\\b)`,
  ).test(t);
}

function textoExplicito(canonico, valor, mensaje, { campoEsperado = null } = {}) {
  if (typeof valor !== 'string' || valor.trim().length < 2 || valor.length > 500) return false;
  const buscado = normalizar(valor);
  const t = normalizar(mensaje);
  if (buscado.length < 2 || !conLimites(t, buscado)) return false;
  if (campoEsperado === canonico && respuestaDirecta(t, buscado)) return true;

  const v = escaparRegex(buscado);
  if (canonico === 'nombre') {
    // El modelo no puede recortar «Ana López» a «Ana». Fuera de una
    // respuesta directa, el valor tiene que ocupar todo lo que sigue al
    // prefijo de nombre. Si el cliente dio varios datos juntos se repregunta:
    // es una fricción segura y evita que el modelo decida el delimitador.
    if (/^(?:de|del|la|el|una?|unos?|unas?)\b/.test(buscado)) return false;
    if (new RegExp(`\\b(?:me llamo|mi nombre es|a nombre de)\\s+${v}\\s*[.!?]*$`).test(t)) return true;
    return campoEsperado === 'nombre'
      && new RegExp(`^soy\\s+${v}\\s*[.!?]*$`).test(t);
  }
  if (canonico === 'lugar') {
    if (new RegExp(
      `(?:\\b(?:lugar|sede|salon|domicilio|direccion)\\s+(?:(?:es|sera)\\s+)?(?:el\\s+|la\\s+)?${v}\\s*[.!?]*$`
        + `|\\b(?:el\\s+)?evento\\s+sera\\s+en\\s+(?:el\\s+|la\\s+)?${v}\\s*[.!?]*$`
        + `|^sera\\s+en\\s+(?:el\\s+|la\\s+)?${v}\\s*[.!?]*$)`,
    ).test(t)) return true;
    return campoEsperado === 'lugar'
      && new RegExp(`^en\\s+(?:el\\s+|la\\s+)?${v}\\s*[.!?]*$`).test(t);
  }
  // Fecha/hora y observaciones no deciden por sí solas el handoff: la primera
  // pasa además por `partesFechaHoraCatering` y la segunda es opcional. Aun
  // así se exige una secuencia completa de tokens, nunca una subcadena.
  return true;
}

/**
 * Comprueba un campo propuesto contra evidencia literal del cliente.
 *
 * Para asistentes se exige el entero explícito. Para texto se exige el valor
 * literal normalizado: si el modelo traduce, completa o corrige lo dicho, se
 * repregunta. Esa fricción conservadora es preferible a entregar una ficha con
 * nombre, lugar o fecha inventados.
 */
export function valorCateringRespaldado(campo, valor, {
  mensaje = '', valorPrevio = undefined, campoEsperado = null,
} = {}) {
  const canonico = CAMPO_CANONICO[campo];
  if (!canonico || valor === null || valor === undefined || normalizar(valor) === '') return false;
  if (canonico === 'numero_personas'
      && !(Number.isInteger(valor) || (typeof valor === 'string' && /^\d+$/.test(valor.trim())))) return false;
  if (canonico !== 'numero_personas' && typeof valor !== 'string') return false;
  if (valorPrevio !== null && valorPrevio !== undefined && iguales(valor, valorPrevio)) return true;
  if (canonico === 'numero_personas') return enteroExplicito(valor, mensaje, { campoEsperado });
  return textoExplicito(canonico, valor, mensaje, { campoEsperado });
}

const siguienteCampoLegacy = (campos = {}) => {
  if (!campos.nombre) return 'nombre';
  if (!campos.numero_personas) return 'numero_personas';
  if (!campos.lugar) return 'lugar';
  if (!campos.fecha_evento) return 'fecha_evento';
  return null;
};

const siguienteCampoEvento = (evento = {}) => {
  if (!evento.nombre) return 'nombre';
  if (!evento.personas) return 'numero_personas';
  if (!evento.lugar) return 'lugar';
  if (!evento.fecha_hora) return 'fecha_evento';
  return null;
};

/**
 * Firma los valores cuya procedencia ya comprobó código determinista. Guardar
 * el valor normalizado (y no solo un booleano) impide que una escritura
 * posterior cambie el dato conservando una marca vieja.
 */
export function sellarCamposCatering(campos = {}, camposAceptados = []) {
  const sello = typeof campos[MARCA_EVIDENCIA_CATERING] === 'object'
    && campos[MARCA_EVIDENCIA_CATERING] !== null
    ? { ...campos[MARCA_EVIDENCIA_CATERING] } : {};
  for (const campo of camposAceptados) {
    const canonico = CAMPO_CANONICO[campo] || campo;
    if (canonico && campos[canonico] !== undefined) sello[canonico] = normalizar(campos[canonico]);
  }
  return { ...campos, [MARCA_EVIDENCIA_CATERING]: sello };
}

/**
 * Retira datos de fichas antiguas o alteradas que no tengan una firma igual
 * al valor actual. Los metadatos `__*` sobreviven; los datos se repreguntan.
 */
export function camposCateringVerificados(campos = {}, { nombreConfiable = null } = {}) {
  const selloAnterior = typeof campos[MARCA_EVIDENCIA_CATERING] === 'object'
    && campos[MARCA_EVIDENCIA_CATERING] !== null
    ? { ...campos[MARCA_EVIDENCIA_CATERING] } : {};
  const sello = {};
  const salida = Object.fromEntries(Object.entries(campos).filter(([k]) => k.startsWith('__')));
  for (const campo of ['nombre', 'numero_personas', 'lugar', 'fecha_evento', 'observaciones']) {
    if (campos[campo] !== undefined && selloAnterior[campo] === normalizar(campos[campo])) {
      salida[campo] = campos[campo];
      sello[campo] = selloAnterior[campo];
    }
  }
  if (salida.fecha_evento && campos.fecha_evento_iso) salida.fecha_evento_iso = campos.fecha_evento_iso;
  if (!salida.nombre && nombreConfiable) {
    salida.nombre = String(nombreConfiable).trim();
    sello.nombre = normalizar(salida.nombre);
  }
  salida[MARCA_EVIDENCIA_CATERING] = sello;
  return salida;
}

const CAMPO_EVENTO_A_CANONICO = Object.freeze({
  nombre: 'nombre', personas: 'numero_personas', lugar: 'lugar',
  fecha_hora: 'fecha_evento', tipo_servicio: 'observaciones',
});

/** La misma procedencia, para el estado durable del agente de herramientas. */
export function sellarEventoCatering(evento = {}, camposAceptados = []) {
  const sello = typeof evento[MARCA_EVIDENCIA_CATERING] === 'object'
    && evento[MARCA_EVIDENCIA_CATERING] !== null
    ? { ...evento[MARCA_EVIDENCIA_CATERING] } : {};
  for (const campo of camposAceptados) {
    const canonico = CAMPO_EVENTO_A_CANONICO[campo] || CAMPO_CANONICO[campo];
    const campoEstado = campo === 'numero_personas' ? 'personas'
      : campo === 'fecha_evento' ? 'fecha_hora'
        : campo === 'observaciones' ? 'tipo_servicio' : campo;
    if (canonico && evento[campoEstado] !== undefined) sello[canonico] = normalizar(evento[campoEstado]);
  }
  return { ...evento, [MARCA_EVIDENCIA_CATERING]: sello };
}

export function eventoCateringVerificado(evento = {}, { nombreConfiable = null } = {}) {
  const selloAnterior = typeof evento[MARCA_EVIDENCIA_CATERING] === 'object'
    && evento[MARCA_EVIDENCIA_CATERING] !== null
    ? { ...evento[MARCA_EVIDENCIA_CATERING] } : {};
  const sello = {};
  const salida = { [MARCA_EVIDENCIA_CATERING]: sello };
  for (const [campoEstado, canonico] of Object.entries(CAMPO_EVENTO_A_CANONICO)) {
    if (evento[campoEstado] !== undefined && selloAnterior[canonico] === normalizar(evento[campoEstado])) {
      salida[campoEstado] = evento[campoEstado];
      sello[canonico] = selloAnterior[canonico];
    }
  }
  if (!salida.nombre && nombreConfiable) {
    salida.nombre = String(nombreConfiable).trim();
    sello.nombre = normalizar(salida.nombre);
  }
  return salida;
}

export function eventoCateringPublico(evento = {}) {
  return Object.fromEntries(Object.entries(evento).filter(([campo]) => !campo.startsWith('__')));
}

/** Filtra marcadores del flujo comercial legacy antes de persistirlos. */
export function filtrarCapturasCatering(capturas = [], {
  mensaje = '', camposPrevios = {},
} = {}) {
  const aceptadas = [];
  const rechazadas = [];
  const campoEsperado = siguienteCampoLegacy(camposPrevios);
  for (const captura of capturas || []) {
    const campo = captura?.campo;
    const canonico = CAMPO_CANONICO[campo];
    const previo = canonico ? camposPrevios?.[canonico] : undefined;
    if (valorCateringRespaldado(campo, captura?.valor, {
      mensaje, valorPrevio: previo, campoEsperado,
    })) {
      aceptadas.push(captura);
    } else {
      rechazadas.push(campo || 'campo_desconocido');
    }
  }
  return { aceptadas, rechazadas };
}

/** Filtra argumentos de `registrar_solicitud_evento` antes de mutar estado. */
export function filtrarDatosEventoCatering(datos = {}, {
  mensaje = '', eventoPrevio = {},
} = {}) {
  const aceptados = {};
  const rechazados = [];
  const campoEsperado = siguienteCampoEvento(eventoPrevio);
  for (const [campo, valor] of Object.entries(datos || {})) {
    if (valor === undefined) continue;
    const canonico = CAMPO_CANONICO[campo];
    const campoEstado = campo === 'personas' ? 'personas'
      : campo === 'fecha_hora' ? 'fecha_hora'
        : campo === 'tipo_servicio' ? 'tipo_servicio' : campo;
    const previo = eventoPrevio?.[campoEstado];
    if (canonico && valorCateringRespaldado(campo, valor, {
      mensaje, valorPrevio: previo, campoEsperado,
    })) {
      aceptados[campoEstado] = valor;
    } else {
      rechazados.push(campo);
    }
  }
  return { aceptados, rechazados };
}
