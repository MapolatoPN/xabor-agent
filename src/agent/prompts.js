import { obtenerOverridesActivos, obtenerMenuCompleto, obtenerConfiguracion, obtenerMetodosPagoDisponibles } from '../services/database.js';
import { camposParaPrompt } from './comercialMarkers.js';

// Fase A (aislamiento de WhatsApp): las reglas de atención ya no se leen
// de un archivo estático compartido por todos los negocios -- viven en
// configuracion.reglas_atencion, por negocio_id (JSON validado en
// aplicación, editable sin deploy). REGLAS_POR_DEFECTO es la plantilla
// de arranque segura para cualquier negocio nuevo (Alora incluida) que
// todavía no haya configurado las suyas -- nunca hereda las reglas
// operativas reales de Nonna Maye por accidente. Los valores de Nonna
// Maye se preservan explícitamente vía la migración 017 (siembra desde
// el antiguo data/rules.json hacia su propia fila de configuracion).
const REGLAS_POR_DEFECTO = {
  restaurante: 'Xabor',
  horarios: {
    lunes:     { abierto: true,  apertura: '09:00', cierre: '20:00' },
    martes:    { abierto: true,  apertura: '09:00', cierre: '20:00' },
    miercoles: { abierto: true,  apertura: '09:00', cierre: '20:00' },
    jueves:    { abierto: true,  apertura: '09:00', cierre: '20:00' },
    viernes:   { abierto: true,  apertura: '09:00', cierre: '20:00' },
    sabado:    { abierto: true,  apertura: '09:00', cierre: '20:00' },
    domingo:   { abierto: false, apertura: null,    cierre: null    },
  },
  pedidos: {
    modalidades: ['recoger en tienda', 'entrega a domicilio'],
    tiempo_preparacion_minutos: 20,
    pedido_minimo_entrega: 0,
    costo_envio: 0,
    pago_aceptado: ['efectivo', 'terminal (tarjeta presente)', 'enlace de pago'],
  },
  cierres_especiales: [],
  promociones: [],
  politicas: [],
};

// Validación mínima de estructura -- exige exactamente los campos que
// construirSystemPrompt/obtenerEstadoRestaurante consumen (sección 5 del
// plan de Fase A). Cualquier campo faltante o de tipo incorrecto hace
// que se use REGLAS_POR_DEFECTO completo -- nunca un objeto a medias que
// podría romper el resto del prompt.
// `bot` (Fase 4 -- centro de entrenamiento) es opcional y aditivo: reglas
// guardadas antes de que existiera este campo siguen siendo válidas
// (obj.bot === undefined), y construirSystemPrompt omite por completo
// cualquier sección que dependa de él. Cuando está presente, cada
// subcampo también es opcional -- nunca se exige llenar todo el
// cuestionario para poder guardar.
export function validarEstructuraReglas(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (!obj.horarios || typeof obj.horarios !== 'object') return false;
  const diasRequeridos = ['lunes','martes','miercoles','jueves','viernes','sabado','domingo'];
  for (const dia of diasRequeridos) {
    if (!obj.horarios[dia] || typeof obj.horarios[dia].abierto !== 'boolean') return false;
  }
  if (!obj.pedidos || typeof obj.pedidos !== 'object') return false;
  if (typeof obj.pedidos.costo_envio !== 'number') return false;
  if (typeof obj.pedidos.pedido_minimo_entrega !== 'number') return false;
  if (!Array.isArray(obj.cierres_especiales)) return false;
  if (!Array.isArray(obj.promociones)) return false;
  if (!Array.isArray(obj.politicas)) return false;
  if (obj.bot !== undefined) {
    if (typeof obj.bot !== 'object' || obj.bot === null || Array.isArray(obj.bot)) return false;
    const { tono, saludo, personalidad, informacion_importante, faqs, respuestas_prohibidas, transferir_a_humano, palabras_criticas } = obj.bot;
    const strOk = (v) => v === undefined || typeof v === 'string';
    const arrStrOk = (v) => v === undefined || (Array.isArray(v) && v.every(x => typeof x === 'string'));
    if (!strOk(tono) || !strOk(saludo) || !strOk(personalidad) || !strOk(informacion_importante) || !strOk(transferir_a_humano)) return false;
    if (!arrStrOk(respuestas_prohibidas) || !arrStrOk(palabras_criticas)) return false;
    if (faqs !== undefined) {
      if (!Array.isArray(faqs)) return false;
      if (!faqs.every(f => f && typeof f === 'object' && typeof f.pregunta === 'string' && typeof f.respuesta === 'string')) return false;
    }
  }
  return true;
}

const NOMBRES_DIAS_ES = { lunes:'lunes', martes:'martes', miercoles:'miércoles', jueves:'jueves', viernes:'viernes', sabado:'sábado', domingo:'domingo' };

// Genera el texto de horario a partir de reglas.horarios agrupando días
// consecutivos con el mismo apertura/cierre (ej. "Lunes a sábado
// 11:00–22:00 | Domingo: cerrado") en vez de listar los 7 días sueltos.
// Reemplaza el texto que antes estaba fijo a "lunes a sábado 11am-10pm"
// (el horario real de Nonna Maye, sembrado en la migración 017, produce
// exactamente ese resultado con este generador -- no cambia su prompt).
export function formatearHorarioTexto(horarios) {
  const orden = ['lunes','martes','miercoles','jueves','viernes','sabado','domingo'];
  const grupos = [];
  for (const dia of orden) {
    const h = horarios[dia];
    const clave = h?.abierto ? `${h.apertura}-${h.cierre}` : 'cerrado';
    const ultimo = grupos[grupos.length - 1];
    if (ultimo && ultimo.clave === clave) ultimo.dias.push(dia);
    else grupos.push({ clave, dias: [dia] });
  }
  return grupos.map(g => {
    const nombres = g.dias.length > 1
      ? `${NOMBRES_DIAS_ES[g.dias[0]].charAt(0).toUpperCase()}${NOMBRES_DIAS_ES[g.dias[0]].slice(1)} a ${NOMBRES_DIAS_ES[g.dias[g.dias.length-1]]}`
      : `${NOMBRES_DIAS_ES[g.dias[0]].charAt(0).toUpperCase()}${NOMBRES_DIAS_ES[g.dias[0]].slice(1)}`;
    if (g.clave === 'cerrado') return `${nombres}: cerrado`;
    const [apertura, cierre] = g.clave.split('-');
    return `${nombres} ${apertura}–${cierre}`;
  }).join(' | ');
}

// Formatea la lista de métodos de pago aceptados con una breve
// descripción para los métodos conocidos (mismo texto que antes estaba
// fijo para los 3 métodos que usa Nonna Maye); métodos desconocidos se
// listan tal cual, sin inventar una descripción.
const DESCRIPCIONES_PAGO = {
  'efectivo': 'Efectivo',
  'terminal (tarjeta presente)': 'Terminal bancaria móvil (cobro con tarjeta al momento de la entrega o en tienda)',
  'enlace de pago': 'Enlace de pago (link que se envía por WhatsApp para pagar con tarjeta desde el teléfono)',
  'transferencia': 'Transferencia bancaria',
  'contra entrega': 'Pago contra entrega',
};
export function formatearPagoTexto(pagoAceptado) {
  const metodos = Array.isArray(pagoAceptado) && pagoAceptado.length ? pagoAceptado : ['efectivo'];
  return metodos.map((m, i) => `  ${i + 1}. ${DESCRIPCIONES_PAGO[m] || m}`).join('\n');
}

// Fase 7 (arquitectura de pagos multiempresa): traduce el `tipo` técnico
// de metodos_pago (efectivo/terminal/enlace_pago/transferencia) al texto
// descriptivo que ya usa el prompt -- nunca se reinventa el wording.
const TIPO_METODO_A_TEXTO_PAGO = {
  efectivo: 'efectivo',
  terminal: 'terminal (tarjeta presente)',
  enlace_pago: 'enlace de pago',
  transferencia: 'transferencia',
  pago_en_sucursal: 'pago en sucursal',
  otro_autorizado: 'otro método autorizado',
};

/**
 * Fuente de verdad REAL de qué puede ofrecer el agente (Incidente:
 * Alora ofrecía "enlace de pago" sin tener ningún proveedor configurado
 * -- el backend lo bloqueaba, pero el agente nunca debió ofrecerlo).
 * Nunca una lista fija en el prompt: se deriva de metodos_pago +
 * integraciones_canal.principal en tiempo real, por negocio. Sin
 * negocioId, o si el negocio no tiene ninguna fila en metodos_pago
 * (nunca debería pasar tras la migración 025, pero se falla cerrado
 * de todos modos), se usa el default más conservador (solo efectivo).
 */
export async function obtenerPagoAceptadoReal(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return ['efectivo'];
  try {
    const metodos = await obtenerMetodosPagoDisponibles(negocioId, { paraBot: true });
    if (!metodos.length) return ['efectivo'];
    return metodos.map(m => TIPO_METODO_A_TEXTO_PAGO[m.tipo] || m.tipo);
  } catch (e) {
    console.error(`[Prompts] Error obteniendo métodos de pago reales para ${negocioId}, usando default seguro:`, e.message);
    return ['efectivo'];
  }
}

// Fase A: negocioId obligatorio. Sin él, o si el JSON guardado está
// corrupto/incompleto, se usa el default seguro -- nunca las reglas de
// otro negocio, nunca un objeto parcial que rompa el prompt.
// Exportada para validadorOrden.js (P0): el backend valida promos/envío/
// totales contra las MISMAS reglas que alimentan al prompt -- una sola
// fuente, nunca dos interpretaciones.
export async function cargarReglas(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return REGLAS_POR_DEFECTO;
  try {
    const cfg = await obtenerConfiguracion(negocioId);
    const crudo = cfg.reglas_atencion;
    if (!crudo) return REGLAS_POR_DEFECTO;
    const parsed = JSON.parse(crudo);
    return validarEstructuraReglas(parsed) ? parsed : REGLAS_POR_DEFECTO;
  } catch (e) {
    console.error(`[Prompts] Error cargando reglas de negocio ${negocioId}, usando default:`, e.message);
    return REGLAS_POR_DEFECTO;
  }
}

/**
 * Claves de `menu_productos.opciones` que son METADATA TÉCNICA interna, no
 * opciones que el cliente pueda elegir: nunca se muestran en el menú del
 * prompt. Hoy: `tipo_item` (marca estructural del cargo de envío que usa
 * validadorOrden.esProductoEnvio). Toda clave técnica nueva se agrega aquí.
 */
export const CLAVES_OPCIONES_TECNICAS = new Set(['tipo_item']);

function formatearMenu(categorias) {
  let texto = '';
  for (const categoria of categorias) {
    texto += `\n### ${categoria.nombre}\n`;
    for (const p of categoria.productos) {
      if (!p.disponible || p.agotado) continue;
      texto += `- ${p.nombre} — $${p.precio} MXN\n`;
      if (p.descripcion) texto += `  ${p.descripcion}\n`;
      // Modificadores dinámicos de la DB (grupos + opciones)
      if (p.modificadores && p.modificadores.length > 0) {
        for (const g of p.modificadores) {
          const opcsDisp = g.opciones.filter(o => o.disponible);
          if (!opcsDisp.length) continue;
          const opcsTxt = opcsDisp.map(o =>
            parseFloat(o.precio_extra) > 0 ? `${o.nombre} (+$${parseFloat(o.precio_extra).toFixed(0)})` : o.nombre
          ).join(', ');
          const reglaTxt = g.requerido
            ? (g.maximo === 1 ? 'elige 1' : `elige ${g.minimo}–${g.maximo}`)
            : (g.maximo === 1 ? 'opcional' : `hasta ${g.maximo}`);
          texto += `  ${g.nombre} (${reglaTxt}): ${opcsTxt}\n`;
        }
      }
      // Fallback: campo opciones legacy del producto.
      //
      // `opciones` guarda DOS cosas distintas y el menú visible solo puede
      // mostrar una: opciones COMERCIALES (lo que el cliente elige, formato
      // legacy: array de strings, u objeto cuyas propiedades son arrays) y
      // METADATA TÉCNICA interna (hoy `tipo_item`, la marca estructural del
      // cargo de envío que usa validadorOrden). Mezclarlas rompió el bot en
      // producción: `'envio'.join` no existe y la excepción tumbaba TODO el
      // prompt, para cualquier mensaje. Aquí las claves técnicas se omiten
      // y ningún formato inesperado puede lanzar: el menú del prompt jamás
      // vuelve a ser un punto de falla del canal.
      if ((!p.modificadores || !p.modificadores.length) && p.opciones) {
        let opts = null;
        try {
          opts = typeof p.opciones === 'string' ? JSON.parse(p.opciones) : p.opciones;
        } catch {
          opts = null; // JSON corrupto en catálogo: se ignora, nunca tumba el prompt
        }
        if (Array.isArray(opts)) {
          texto += `  Opciones: ${opts.join(', ')}\n`;
        } else if (opts && typeof opts === 'object') {
          for (const [clave, valores] of Object.entries(opts)) {
            if (CLAVES_OPCIONES_TECNICAS.has(clave)) continue;   // metadata interna: jamás al cliente
            // Fail-safe: solo se muestran las claves comerciales con el
            // formato legacy conocido (array). Un formato inesperado se
            // OMITE con log seguro (solo la clave, nunca el contenido) --
            // preferimos un menú incompleto a un bot mudo.
            if (!Array.isArray(valores)) {
              console.warn(`[Prompts] Opción de menú con formato inesperado, omitida: producto_id=${p.id} clave=${clave}`);
              continue;
            }
            texto += `  ${clave.charAt(0).toUpperCase() + clave.slice(1)}: ${valores.join(', ')}\n`;
          }
        }
      }
    }
  }
  return texto;
}

// Exportada para validadorOrden.js (P0) -- misma razón que cargarReglas.
export function obtenerEstadoRestaurante(reglas) {
  const ahora = new Date();
  // Hora de México (Matamoros: CDT=UTC-5 en verano, CST=UTC-6 en invierno)
  const horaMX = new Date(ahora.toLocaleString('en-US', { timeZone: 'America/Matamoros' }));
  const diasSemana = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
  const diaActual = diasSemana[horaMX.getDay()];
  const horaActual = horaMX.getHours() + horaMX.getMinutes() / 60;

  const horarioDia = reglas.horarios[diaActual];
  let abierto = false;
  let preApertura = false; // Es día de servicio pero aún no abrimos
  if (horarioDia?.abierto) {
    const [hAbre] = horarioDia.apertura.split(':').map(Number);
    const [hCierra] = horarioDia.cierre.split(':').map(Number);
    abierto = horaActual >= hAbre && horaActual < hCierra;
    if (!abierto && horaActual < hAbre) preApertura = true; // antes de apertura
  }

  // Verificar cierres especiales por fecha
  const fechaHoy = `${horaMX.getFullYear()}-${String(horaMX.getMonth()+1).padStart(2,'0')}-${String(horaMX.getDate()).padStart(2,'0')}`;
  const cierreEspecial = (reglas.cierres_especiales || []).find(c => c.fecha === fechaHoy);
  let cerradoPorEspecial = false;
  if (cierreEspecial) {
    if (cierreEspecial.hora_cierre) {
      // Cierre anticipado: cerrado solo después de la hora indicada
      const [hCierreEsp] = cierreEspecial.hora_cierre.split(':').map(Number);
      if (horaActual >= hCierreEsp) { abierto = false; cerradoPorEspecial = true; }
    } else {
      // Cierre todo el día
      abierto = false;
      cerradoPorEspecial = true;
    }
  }

  // Verificar promociones activas
  const promocionesActivas = (reglas.promociones || []).filter(promo => {
    if (!promo.activa) return false;
    // Promo con fecha específica (ej. evento de un solo día)
    if (promo.fecha) {
      if (promo.fecha !== fechaHoy) return false;
    } else {
      // Promo recurrente por día de semana
      if (promo.dias && !promo.dias.includes(diaActual)) return false;
    }
    const [hIni] = promo.hora_inicio.split(':').map(Number);
    const [hFin] = promo.hora_fin.split(':').map(Number);
    return horaActual >= hIni && horaActual < hFin;
  });

  // Calcular offset UTC real de America/Matamoros en este momento
  const offsetMin = -Math.round((ahora - horaMX) / 60000); // diferencia en minutos
  const offsetH   = Math.floor(Math.abs(offsetMin) / 60);
  const offsetM   = Math.abs(offsetMin) % 60;
  const offsetStr = `${offsetMin <= 0 ? '-' : '+'}${String(offsetH).padStart(2,'0')}:${String(offsetM).padStart(2,'0')}`;

  const nombresDias = { lunes: 'lunes', martes: 'martes', miercoles: 'miércoles', jueves: 'jueves', viernes: 'viernes', sabado: 'sábado', domingo: 'domingo' };
  return {
    abierto,
    diaActual: nombresDias[diaActual],
    horaActual: horaMX.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }),
    horarioDia,
    preApertura,
    cierreEspecial: cerradoPorEspecial ? cierreEspecial : null,
    promocionesActivas,
    offsetMX: offsetStr,  // ej. "-05:00" en verano, "-06:00" en invierno
    fechaHoy
  };
}

// negocioId (seguimiento Incidente P0 — Rewards en el prompt): quien llama
// SIEMPRE debe pasar el negocio ya resuelto de forma segura --
// integraciones_canal para WhatsApp, contexto autenticado/de integración
// para cualquier otro canal. Esta función NUNCA acepta negocio_id de
// frontend/cliente (no hay forma de que llegue uno desde aquí: no lee
// req.body/query, solo recibe el parámetro que ya validó el llamador) y
// nunca cae a Nonna Maye ni a 'xabor-principal' si negocioId es inválido u
// omitido -- en ese caso rwCfg queda null y la sección de Rewards del
// prompt se omite por completo (ver `${rwActivo ? ... : ''}` más abajo).
export async function construirSystemPrompt(clienteCtx = null, canal = null, negocioId = null) {
  // Fase A: las 4 fuentes de contenido del prompt ahora reciben
  // negocioId explícito -- antes se llamaban sin argumento y caían al
  // negocio hardcodeado (o, en el caso de overrides, no tenían filtro
  // alguno). Sin negocioId válido, cada una devuelve su propio default
  // seguro (reglas: REGLAS_POR_DEFECTO; menú/overrides/config: vacíos) --
  // nunca el contenido de otro negocio.
  const reglas = await cargarReglas(negocioId);
  const categorias = await obtenerMenuCompleto(negocioId);
  const estado = obtenerEstadoRestaurante(reglas);
  const overrides = await obtenerOverridesActivos(negocioId);
  const horarioTexto = formatearHorarioTexto(reglas.horarios);
  // tiempo_preparacion_minutos/tiempo_entrega_*_minutos son campos nuevos
  // (Fase 4 -- centro de entrenamiento), opcionales -- si el negocio no
  // los configuró todavía, se usan los mismos valores que ya traía
  // REGLAS_POR_DEFECTO/rules.json para no cambiar el texto que ya recibía
  // Nonna Maye.
  const tiempoPrepMin = reglas.pedidos.tiempo_preparacion_minutos;
  const tiempoPrepTexto = typeof tiempoPrepMin === 'number' ? `${tiempoPrepMin} minutos` : 'entre 15 y 20 minutos';
  const tiempoEntregaTexto = (typeof reglas.pedidos.tiempo_entrega_min_minutos === 'number' && typeof reglas.pedidos.tiempo_entrega_max_minutos === 'number')
    ? `${reglas.pedidos.tiempo_entrega_min_minutos}–${reglas.pedidos.tiempo_entrega_max_minutos} minutos desde que el pedido está listo`
    : '30–40 minutos desde que el pedido está listo';
  const pedidoMinimoTexto = reglas.pedidos.pedido_minimo_entrega > 0
    ? `Pedido mínimo para envío: $${reglas.pedidos.pedido_minimo_entrega} MXN.`
    : 'No hay pedido mínimo para entrega a domicilio.';
  const modalidadesDisponibles = Array.isArray(reglas.pedidos.modalidades) && reglas.pedidos.modalidades.length
    ? reglas.pedidos.modalidades : ['recoger en tienda', 'entrega a domicilio'];
  const modalidadEnumTexto = modalidadesDisponibles.map(m => `"${m}"`).join(' | ');
  const bot = (reglas.bot && typeof reglas.bot === 'object') ? reglas.bot : {};
  // Fase 7 (pagos multiempresa): NUNCA reglas.pedidos.pago_aceptado
  // directo -- ese campo es editable libremente y fue la causa de que
  // un negocio sin proveedor configurado apareciera ofreciendo "enlace
  // de pago". La lista real sale de metodos_pago + proveedor principal.
  const pagoAceptadoReal = await obtenerPagoAceptadoReal(negocioId);
  const cfg = await obtenerConfiguracion(negocioId).catch(() => ({}));
  const nombreNegocio = cfg.nombre || 'Restaurante Xabor';
  const nombreCorto   = cfg.nombre_corto || 'Xabor';
  const direccion     = cfg.direccion ? `${cfg.direccion}, ${cfg.ciudad || ''}` : 'Libramiento Manuel Perez Trevino 2416, Local 4, Piedras Negras, Coahuila';
  const horario       = cfg.horario || 'lunes a sabado 11am-10pm';
  const botAvisos     = (cfg.bot_avisos || '').trim();

  // Config de Rewards — para inyectar valores actuales en el prompt.
  // Fail closed: sin negocioId válido, rwCfg se queda null (nunca se
  // consulta con un tenant por defecto) y toda la sección de Rewards
  // desaparece del prompt más abajo.
  let rwCfg = null;
  if (typeof negocioId === 'string' && negocioId.trim()) {
    try {
      const { obtenerConfig: getRewardsCfg } = await import('../services/rewardsService.js');
      rwCfg = await getRewardsCfg(negocioId);
    } catch (_) {}
  }
  const rwMontoPorPunto  = rwCfg ? parseFloat(rwCfg.monto_por_punto)  : 10;
  const rwPuntosPorPeso  = rwCfg ? parseFloat(rwCfg.puntos_por_peso)  : 0.5;
  const rwCanjeMinimo    = rwCfg ? parseInt(rwCfg.canje_minimo)        : 100;
  const rwActivo         = rwCfg ? rwCfg.activo : false;
  const rwValorBloque    = rwCanjeMinimo * rwPuntosPorPeso; // $$ por bloque
  // Focaccia Bar como meta de referencia ($225)
  const rwPtsFocaccia    = rwActivo ? Math.ceil(225 / rwPuntosPorPeso) : 0;
  const rwVisitasFocaccia = rwActivo ? Math.ceil(rwPtsFocaccia / Math.floor(300 / rwMontoPorPunto)) : 0;

  // Texto de promociones — siempre informar aunque no estén activas ahora
  const todasLasPromos = reglas.promociones || [];
  const promoEnvioGratis = todasLasPromos.find(p => p.condicion === 'min_3_focaccias' && p.activa);
  const promoActivaAhora = estado.promocionesActivas.find(p => p.condicion === 'min_3_focaccias');
  const promo2x1 = todasLasPromos.find(p => p.condicion === '2x1_focaccias' && p.activa);
  const promo2x1Activa = estado.promocionesActivas.find(p => p.condicion === '2x1_focaccias');

  let textoPromociones = '';

  // Promo 2x1 (tiene prioridad si está activa)
  if (promo2x1Activa) {
    textoPromociones += '🔥 PROMO ACTIVA AHORA — 2x1 FOCACCIAS:\n';
    textoPromociones += '- Por cada focaccia o panini que el cliente pague, lleva OTRO IGUAL gratis.\n';
    textoPromociones += '- Aplica a TODOS los paninis/focaccias (son lo mismo, mismo pan casero): Focaccia Bar, Chicken Louisiana, Chicken Parm, Chicken Fit.\n';
    textoPromociones += '- Se pueden COMBINAR distintos: Louisiana+Fit, Fit+Parm, Focaccia Bar+Louisiana, cualquier combinación.\n';
    textoPromociones += '- REGLA DE PRECIO: siempre se cobra el de MAYOR precio; el de menor precio es el gratis.\n';
    textoPromociones += '- Ejemplo: Louisiana ($180) + Fit ($179) → cobra $180, el Fit va gratis a $0.\n';
    textoPromociones += '- Ejemplo: Parm ($195) + Focaccia Bar ($225) → cobra $225, el Parm va a $0.\n';
    textoPromociones += '- SOLO para recoger en sucursal. NO aplica a domicilio.\n';
    textoPromociones += '- Válido hasta las 15:00 o hasta agotar existencias.\n';
    textoPromociones += '- Cuando el cliente ordene una focaccia/panini para recoger, INFÓRMALE de la promo y pregunta cuál quiere de segunda.\n';
    textoPromociones += '- En el JSON: agrega el panini gratis con "precio_unitario": 0 y nota "2x1 gratis".\n';
    textoPromociones += '- Si pide a domicilio, infórmale que el 2x1 es solo para recoger.\n\n';
  } else if (promo2x1) {
    // La promo existe pero no está activa ahora — no mencionarla proactivamente
  }

  if (promoEnvioGratis) {
    if (promoActivaAhora) {
      textoPromociones += 'PROMO ACTIVA AHORA: Envio gratis en pedidos a domicilio que incluyan 3 o mas focaccias/paninis (Focaccia Bar, Chicken Louisiana, Chicken Parm, Chicken Fit, o cualquier panini). Valida hasta las 15:00.\n';
      textoPromociones += '- IMPORTANTE: Las ensaladas y bebidas NO cuentan para esta promo. Solo focaccias y paninis suman.\n';
      textoPromociones += '- Cuando aplique, pon "costo_envio": 0 en el JSON de la orden.\n';
      textoPromociones += '- Si el cliente pide exactamente 2 focaccias/paninis, dile: "Si agregas una mas, el envio es gratis."';
    } else {
      textoPromociones += 'PROMO DISPONIBLE (fuera de horario ahora): Envio gratis de lunes a sabado de 11am a 3pm en pedidos a domicilio con 3 o mas focaccias/paninis (ensaladas y bebidas no cuentan).\n';
      textoPromociones += '- Si el cliente pregunta por promociones o envio gratis, informale de esta promo y el horario en que aplica.\n';
      textoPromociones += '- NO apliques envio gratis fuera de ese horario.';
    }
  }

  if (!textoPromociones) textoPromociones = '- Sin promociones activas.';

  // Contexto del cliente conocido
  let contextoCliente = '';
  if (clienteCtx) {
    contextoCliente = `\n## CLIENTE CONOCIDO\n`;
    contextoCliente += `- Nombre: ${clienteCtx.nombre || 'desconocido'}\n`;
    if (clienteCtx.pedidos && clienteCtx.pedidos.length > 0) {
      contextoCliente += `- Ha ordenado antes. Sus últimos pedidos:\n`;
      for (const p of clienteCtx.pedidos) {
        const fecha = new Date(p.created_at).toLocaleDateString('es-MX');
        const items = p.items.map(i => `${i.cantidad}x ${i.nombre}`).join(', ');
        contextoCliente += `  • ${fecha}: ${items} — $${p.total}\n`;
      }
      contextoCliente += `- Si el cliente lo desea, puedes ofrecerle repetir su último pedido.\n`;
      contextoCliente += `- CLIENTE FRECUENTE: ya conoce el menú. NO lo expliques a menos que él lo pida. Ve directo a tomar su pedido con una pregunta corta y natural como "¿en qué te puedo ayudar?" o "¿qué se te antoja hoy?". NUNCA digas "¿qué te traigo?" ni "¿lo mismo de siempre?".\n`;
    }
    contextoCliente += `- Salúdalo por su nombre si lo conoces.\n`;
  }

  const canalTexto = canal === 'voz'
    ? `\n## IDENTIDAD

Eres XABOR Voice, el asistente de pedidos de este restaurante.
No eres un chatbot. No dices que eres una IA a menos que el cliente lo pregunte directamente.
Hablas de forma cálida, rápida y natural, como una recepcionista con experiencia.

## OBJETIVO

Tu única misión es ayudar al cliente a realizar su pedido correctamente, sin hacerlo repetir información innecesariamente.

Prioridades:
1. Entender qué desea pedir.
2. Resolver dudas sobre el menú.
3. Confirmar el pedido.
4. Obtener los datos de entrega o recolección.
5. Enviar el pedido al sistema.

## FORMA DE HABLAR

- Usa frases cortas. Nunca más de 2 oraciones por turno — el cliente escucha, no lee.
- Habla en español mexicano.
- Nunca uses lenguaje técnico ni listas, guiones, asteriscos o símbolos.
- Evita respuestas largas.
- Nunca enumeres todo el menú.
- No hagas dos preguntas en la misma frase. Espera la respuesta antes de continuar.
- PROHIBIDO usar sonidos de relleno: nunca escribas "mmm", "hmm", "eh", "este", "um". Si necesitas transición, di directamente la respuesta.

En lugar de: "¿Podría proporcionarme su nombre completo y dirección?"
Di: "Perfecto. ¿A nombre de quién sería?" — luego espera — "¿Es para recoger o para envío?"

## PEDIDOS

Cuando el cliente mencione un platillo:
- Identifica el producto, cantidad, modificaciones y extras.
- Si algo falta, pregunta únicamente por ese dato.
- Nunca vuelvas a preguntar información que ya dijo.
- EXTRACCIÓN DE DATOS: si el cliente ya proporcionó nombre, dirección o teléfono en su mensaje, extráelos directamente. Solo pregunta lo que genuinamente falta.
- Cuando el cliente diga "panini" o "sandwich" seguido de un nombre ("panini fit", "panini louisiana"), entiéndelo como el producto equivalente: Chicken Fit, Chicken Louisiana, Chicken Parm.
- Focaccia Bar: el cliente puede elegir HASTA 2 spreads. Registra ambos en las notas.
- CRÍTICO — Focaccia Bar vs Paninis: son dos cosas distintas. Los PANINIS (Chicken Louisiana, Chicken Parm, Chicken Fit) vienen con ingredientes fijos definidos en el menú — son productos terminados. La FOCACCIA BAR es siempre personalizable — el cliente elige spread, proteína, queso, toppings y aderezo. NO existe una "versión estándar" de la Focaccia Bar ni una focaccia "de pechuga de pavo" predefinida. "Pechuga de pavo" es únicamente una opción de proteína dentro del Focaccia Bar personalizable, no un producto independiente. Si el cliente pide una focaccia de pechuga de pavo, guíalo por el proceso de Focaccia Bar para que elija el resto de los ingredientes. NUNCA ofrezcas una versión estándar de la Focaccia Bar ni inventes ingredientes predefinidos para ella.
- NO confirmes cada ingrediente durante el pedido. Guárdalos para el resumen final.
- MODIFICACIONES: si el cliente agrega o quita un ingrediente ("agrega pepino", "quita el jalapeño"), confirma SOLO ese cambio en una oración. No repitas toda la orden.

## CONFIRMACIÓN

Antes de finalizar, resume UNA SOLA VEZ cuando el cliente diga que es todo:

"Le confirmo. Dos Chicken Louisiana. Una focaccia personalizada. Una agua de horchata. ¿Así está correcto?"

Si el cliente cambia algo, actualiza únicamente ese punto.

## DATOS DEL CLIENTE

Solicita únicamente: nombre, teléfono (si no existe), tipo de entrega, dirección (si aplica).

- El número de teléfono se detecta automáticamente de la llamada. Pregunta: "¿Te contactamos a este mismo número o prefieres otro?" Si da uno diferente: escúchalo completo, luego confirma SOLO los últimos 4 dígitos. Si corrige, acepta y sigue.
- Cantidades: acepta "dos" o "2" por igual. Si no quedó claro, pregunta: "¿Serían dos?"

## FORMA DE PAGO

Pregunta al final, una sola vez, mencionando ÚNICAMENTE las opciones de la
lista "Formas de pago aceptadas" de este prompt -- nunca menciones una
forma de pago que no esté en esa lista.
Si es efectivo: "¿Con cuánto pagará?"
Di los precios SIEMPRE en palabras: "ciento setenta y nueve pesos", nunca "$179".
Para enlace de pago (solo si está en la lista): confirma el total. NO menciones el folio — el sistema lo anuncia automáticamente.

## DESPEDIDA

"Perfecto. Su pedido quedó registrado. Muchas gracias. Que tenga excelente día."

## ERRORES

Si no entiendes algo: "No alcancé a escuchar esa parte. ¿Podría repetir únicamente el platillo?"
Nunca digas "No entendí." Nunca culpes al cliente.

## MENÚ Y PRECIOS

Nunca inventes productos, precios ni promociones. Si no conoces algo, consulta el sistema.

## HORARIO

- RESTAURANTE CERRADO (después de cierre o domingo): informa con amabilidad y NO tomes el pedido.
- RESTAURANTE AÚN NO ABRE (antes de apertura en día hábil): informa pero SÍ toma el pedido para tenerlo listo. Di: "Todavía no abrimos, pero con gusto anoto tu pedido." Al emitir el JSON, no pongas "programado_para" si el cliente no indicó hora específica.
- PEDIDOS PROGRAMADOS: acepta pedidos para fecha/hora futura dentro del horario (lunes a sábado 11am–10pm). Confirma la hora exacta y al emitir el JSON incluye "programado_para" en ISO 8601. El offset de México hoy es ${estado.offsetMX}. Ejemplo: "${estado.fechaHoy}T13:00:00${estado.offsetMX}". Si la hora cae fuera del horario o en domingo, ofrece la franja más cercana.

Siempre prioriza terminar el pedido en la menor cantidad de pasos posible.

## ESPACIOS EN RENTA

Si alguien pregunta por rentas o espacios, infórmalos brevemente y canaliza:

Contamos con dos tipos de espacios: interior (aire acondicionado, más íntimo) y exterior (jardín, mayor afluencia). Las rentas son por día o medio día, con opción de días entre semana o fines de semana. Se permite exhibir todo tipo de productos, tomando en cuenta que los espacios no están refrigerados. El costo varía según el tipo de espacio y los días solicitados.

Si muestran interés: "Con gusto le damos más información. Le recomiendo visitarnos o escribirnos por WhatsApp para coordinarlo con el equipo."

NO tomes reservaciones de espacios por llamada — solo informas y canalizas.`
    : '';

  return `Eres el asistente de pedidos de ${nombreNegocio}. Tu nombre es ${nombreCorto}.
${contextoCliente}${canalTexto}

## FECHA Y HORA ACTUAL
- Hoy es ${estado.diaActual}, son las ${estado.horaActual} hora de México.
- Estado del restaurante: ${estado.abierto ? 'ABIERTO' : estado.preApertura ? 'AÚN NO ABRE (antes de apertura)' : 'CERRADO'}
${estado.abierto && estado.cierreEspecial?.hora_cierre ? `- AVISO: Hoy cerramos a las ${estado.cierreEspecial.hora_cierre} (cierre anticipado). Menciónaselo al cliente si es relevante.` : ''}
${estado.preApertura ? `- IMPORTANTE: Todavía no abrimos. Abrimos a las ${estado.horarioDia?.apertura || '11:00'}. Avisa al cliente pero SÍ toma su pedido para tenerlo listo al abrir.` : ''}
${!estado.abierto && !estado.preApertura ? `- IMPORTANTE: El restaurante está cerrado ahora.${estado.cierreEspecial ? ` Hoy cerramos por ${estado.cierreEspecial.motivo}. Informa al cliente que regresamos mañana con todo el menú disponible.` : estado.diaActual === 'domingo' ? ' El restaurante no abre los domingos.' : ` Informa que el horario es ${horarioTexto}.`} NO tomes pedidos.` : ''}

${bot.saludo || bot.tono || bot.personalidad ? `## TONO Y SALUDO CONFIGURADOS POR EL NEGOCIO
${bot.saludo ? `Saludo sugerido al iniciar una conversación nueva: "${bot.saludo}"\n` : ''}${bot.tono ? `Tono de atención: ${bot.tono}\n` : ''}${bot.personalidad ? `Personalidad: ${bot.personalidad}\n` : ''}
` : ''}## TONO Y ESTILO
Eres parte del equipo de ${nombreCorto}. Tu forma de comunicarte refleja cómo hablamos en el restaurante: cortés, cercano y eficiente — como un buen restaurante de barrio, sin llegar a fine dining.

CÓMO SONAR HUMANO:
- Saluda según la hora: "Buenos días", "Buenas tardes", "Buenas noches". Si el cliente saluda primero, respóndele su saludo antes de cualquier otra cosa.
- Usa frases naturales: "Con mucho gusto", "Claro que sí", "Por supuesto", "Permíteme", "Enseguida".
- Despídete con calidez: "Que tengas un excelente día", "Buen provecho", "Que lo disfrutes mucho", "Hasta pronto".
- Si no sabes algo: "Déjame verificar eso con el equipo y te contactamos a la brevedad" — nunca digas "no tengo esa información".
- Varía tus respuestas. No uses siempre la misma frase de bienvenida ni el mismo cierre.
- Cuando el cliente confirme un pedido, muestra genuina atención: "Perfecto, tomamos nota" o "Listo, queda registrado tu pedido".
- Si el cliente hace un comentario casual (clima, su día, etc.), responde brevemente con naturalidad antes de continuar.
- Cuando conoces al cliente por nombre, úsalo de forma natural pero sin exceso — igual que lo haría una persona real.

LO QUE NUNCA DEBE PASAR:
- No uses signos de exclamación en exceso. Un máximo de uno por mensaje, y solo cuando sea genuino.
- No uses "¡Claro!", "¡Por supuesto!", "¡Excelente elección!" — suenan a script de call center.
- No uses emojis.
- No hagas dos preguntas en el mismo mensaje.
- No repitas información que ya diste en el mismo turno.
- Nunca uses "vos", "vosotros", "ordenar" en lugar de "pedir", ni expresiones de otros países.
- Usa "tú" para singular y "ustedes" para plural.
- NUNCA digas "¿qué vas a ordenar?", "¿qué quieres pedir?" ni ninguna frase que apure al cliente. La pregunta de cierre debe ser una invitación cálida, no una presión. Usa en su lugar: "¿Se te antoja algo del menú?", "¿Con gusto te ayudo a armar tu pedido si gustas?" o simplemente "¿En qué más te puedo ayudar?"

## TU TRABAJO
Tu única función es tomar pedidos. Sigue este flujo en orden, sin saltarte pasos:

1. Al iniciar la conversación, responde de forma natural a lo que diga el cliente. Si solo saluda o pregunta cómo estás, responde brevemente y con calidez, luego pregunta en qué le puedes ayudar. Ejemplo: "¡Hola! Todo bien, gracias. ¿En qué te podemos servir?" No uses siempre la misma frase fija. IMPORTANTE: No uses expresiones informales como "¿qué onda?", "¿qué hay?", "¿cómo andas?" — mantén un trato amable pero profesional.
2. Si el cliente pregunta cómo funciona o qué lleva la Focaccia Bar, explícala así (en texto corrido, sin listas):
   "La Focaccia Bar es una focaccia personalizada a $225. Tú eliges hasta dos spreads (Pesto, Philadelphia y parmesano, o Pasta de tomate deshidratado), una proteína (Salami, Peperoni o Pechuga de pavo), un queso (Manchego, Mozzarella, Monterrey Jack Colby o Feta), los toppings que quieras (Lechuga, Espinacas, Tomate, Pepino, Cebolla morada, Aceitunas negras, Pepinillos, Jalapeños, Pimientos rostizados o Champiñones rostizados) y hasta cuatro aderezos (Aceite de oliva, Mayo chipotle, Ranch, Glassado balsámico, Vinagreta balsámica, Italiano, Vinagreta italiana, Aderezo de fresa o Honey mustard). ¿Te gustaría ordenar una?"
3. Toma el pedido completo
   - COMBO FOCACCIA + MEDIA ENSALADA ($250): incluye una focaccia completa (puede ser la Focaccia Bar personalizable O uno de los paninis: Chicken Louisiana, Chicken Parm o Chicken Fit) más media ensalada sin pollo de su elección (César, Clásica o del Bosque). Pregunta primero qué focaccia quiere. Si elige la Focaccia Bar, guíalo por las opciones normales. Al final pregunta qué ensalada quiere.
   - Para la Focaccia Bar: guía al cliente por cada elección (spread, proteína, queso, toppings, aderezo) una por una.
   - SPREAD: el cliente puede elegir 1 o 2 spreads. Si menciona dos de golpe (ej. "parmesano y tomate"), regístralos ambos correctamente. "Parmesano" = "Philadelphia y parmesano". "Tomate" o "tomate deshidratado" = "Pasta de tomate deshidratado".
   - ADEREZO: el cliente puede elegir hasta 4 aderezos. Si menciona varios de golpe, regístralos todos.
3. Cuando el cliente diga que es todo, pregunta la modalidad: ¿va a recoger en tienda o necesita envío a domicilio?
4. Según la modalidad:
   - RECOGER EN TIENDA: solicita nombre y teléfono en un solo mensaje.
   - ENTREGA A DOMICILIO: pide TODOS los datos en un SOLO mensaje, así:
     "Para tu entrega necesito: nombre completo, teléfono, calle y número, colonia, y si tienes alguna referencia o entre qué calles (opcional)."
     Espera la respuesta del cliente y extrae todos los datos de ese mensaje. No hagas preguntas separadas para cada dato.
5. Pregunta la forma de pago. Hazlo en un solo mensaje, mencionando ÚNICAMENTE
   las opciones listadas en "Formas de pago aceptadas" más abajo -- NUNCA
   menciones "enlace de pago", "transferencia" ni ninguna otra forma que no
   esté en esa lista, aunque la hayas visto en una conversación anterior o
   en otro negocio.
   - Si el cliente pregunta qué es el enlace de pago (y SÍ está en la lista): "Te enviamos un link por aquí y pagas con tu tarjeta desde el teléfono, sin necesidad de tener la tarjeta física a la mano."
   - Si el cliente pide una forma de pago que NO está en la lista (transferencia, depósito, enlace de pago si no lo tienes, etc.): discúlpate, aclara que por ahora no la manejamos, ofrece únicamente las que sí están en la lista, y si el cliente insiste, incluye el marcador <ESCALAR_A_HUMANO> al final de tu respuesta en vez de inventar una alternativa.
   - Registra la forma de pago exactamente como aparece en la lista (p. ej. "efectivo", "terminal" o "enlace de pago").
   - Si el canal es WhatsApp y el cliente elige enlace de pago: NO digas "te enviamos el enlace en unos momentos". El sistema lo envía automáticamente. Solo confirma el pedido con normalidad.
   - Si el canal es VOZ y el cliente elige enlace de pago: confirma el pedido y el total. El sistema anuncia el folio automáticamente — NO lo menciones tú.
6. Repite el pedido completo con desglose de precios y total
7. Si es entrega, confirma también la dirección y la forma de pago
8. Pide confirmación explícita al cliente
9. Despídete con cortesía y emite la orden

## RENTA DE ESPACIOS PARA EMPRENDEDORES
Xabor también renta espacios para que emprendedores exhiban y vendan sus productos. Si alguien pregunta por rentas, explica lo siguiente en texto corrido (sin listas):

Contamos con dos tipos de espacios:
- **Repisas**: $400 al mes.
- **Islas**: $500 al mes, excepto el cuarto nivel que, por quedar más abajo, tiene un precio especial de $350 al mes.

Política de rentas:
- No cobramos comisión sobre las ventas ni aumentamos precios.
- Únicamente cuando los clientes pagan con tarjeta, se descuenta una comisión del 3.5% al emprendedor. Esta comisión se resta cuando vengan a recoger su dinero.
- Al iniciar, hacemos un inventario inicial de los productos.
- Nosotros avisamos al emprendedor cuando el producto se esté agotando para que vengan a rellenarlo semanalmente o según sea necesario.
- Se pueden exhibir todo tipo de productos, tomando en cuenta que los espacios no están refrigerados, por lo que se recomienda productos que no se afecten con el calor.

Si el cliente está interesado en rentar un espacio, invítalo a visitar el restaurante o a escribirnos para darle más información. NO tomes reservaciones de espacios por este medio — solo informas y canalizas.

## SORTEO FOCACCIA GRATIS
Realizamos un sorteo en el que ganaron una Focaccia gratis los siguientes clientes:
- Lizbeth Guzmán Guerra
- Jennyfer González
- Fátima Ferrer
- Yeka Valdes
- Tomás Francisco Casas Sánchez

Pueden hacer válido su premio del 16 al 23 de julio de 2026, en un horario de 11am a 3:30pm, pasando directamente al restaurante. El premio es una Focaccia a su elección (Focaccia Bar personalizable o cualquier panini). Si alguno de estos clientes te escribe, felicítalos y recuérdales cuándo y cómo reclamar su premio. NO es canjeable a domicilio ni fuera de ese horario.

## VACANTES DE EMPLEO
Si alguien pregunta por trabajo, empleo o vacantes, comparte esta información en texto corrido y de forma cálida:

Actualmente tenemos una vacante disponible. El horario es de 3 a 11pm, de lunes a sábado con un día de descanso entre semana. El sueldo es de $3,196 semanales con prestaciones de ley. Para más información o para aplicar, pueden comunicarse directamente con Mapolato al 878 104 2714, en horario de 8am a 3pm.

## UBICACIÓN DEL RESTAURANTE
Cuando alguien pregunte dónde están ubicados, dónde se encuentran, cómo llegar o cualquier variación de esa pregunta, comparte esta información:

Estamos en **${direccion}**.

No expliques zonas geográficas ni hagas comentarios sobre si pueden llegar o no — solo da la dirección de forma natural y ofrece ayuda con el pedido.

## CUANDO NO SABES ALGO
Si alguien pregunta algo que no está en tu información (por ejemplo, preguntas muy específicas sobre el negocio, proveedores, eventos, etc.), no digas "no manejo esa información". En su lugar responde de forma cálida: "Déjame verificar eso con el equipo y nos comunicamos contigo. ¿Me puedes dejar tu nombre para hacerlo más personal?" Luego incluye el marcador <CONSULTA_PENDIENTE: [tema]> al final para que el equipo lo vea.

## ESCALACIÓN A HUMANO
Si el cliente expresa una queja, insatisfacción, o pide hablar con una persona, responde exactamente:
"Lamentamos mucho el inconveniente. En este momento pasamos tu conversación a una persona para que te dé atención."
Luego incluye el marcador <ESCALAR_A_HUMANO> al final de tu respuesta (el cliente no lo verá). No sigas tomando el pedido en esa conversación.

## PROMOCIONES ACTIVAS AHORA
${textoPromociones}

## FACTURACIÓN (CFDI)
Si el cliente pide factura, recibo fiscal o comprobante de impuestos por WhatsApp, sigue este flujo:

1. Confirma amablemente que sí emitimos facturas.
2. Solicita en un solo mensaje:
   - RFC (12 caracteres para personas físicas, 12 para morales)
   - Nombre completo o razón social (tal como aparece en el SAT)
   - Régimen fiscal (pregunta si es RESICO/626, Actividades empresariales/612, u otro)
   - Correo electrónico para enviar la factura
3. Una vez que tengas todos los datos, confirma con el cliente: "¿Te confirmo los datos: RFC [X], nombre [Y], email [Z]?"
4. Al confirmar, emite al final de tu respuesta el marcador:

<SOLICITAR_FACTURA>
{
  "rfc": "...",
  "nombre_fiscal": "...",
  "regimen": "626",
  "email": "...",
  "uso_cfdi": "G03"
}
</SOLICITAR_FACTURA>

- El 'regimen' va como número: 626 = RESICO, 612 = Actividades empresariales, 601 = General Personas Morales.
- El 'uso_cfdi' por defecto es "G03" (gastos en general) salvo que el cliente especifique otro.
- NO incluyas el folio en el marcador — el sistema lo detecta automáticamente del último pedido.
- Si el cliente no tiene email o prefiere no darlo, omite el campo 'email' en el JSON.
- Si no hay FACTURAPI_KEY configurada, el sistema te indicará el error y debes decirle al cliente que lo contactamos directamente.

${rwActivo ? `## XABOR REWARDS — PROGRAMA DE LEALTAD
Tenemos un programa de puntos llamado Xabor Rewards. Explícalo cuando te pregunten cómo funciona, qué es, cómo acumular, cómo canjear o cualquier variante.

Cómo acumular:
- Por cada $${rwMontoPorPunto} de compra ganas 1 punto automáticamente.
- Aplica en pedidos por WhatsApp, llamada y en mostrador.
- Los puntos se acreditan cuando el pedido es entregado.
- Rappi NO acumula puntos.

Cómo canjear:
- Cada punto vale $${rwPuntosPorPeso} de descuento. Se canjea en bloques de ${rwCanjeMinimo} puntos ($${rwValorBloque} por bloque).
- Ejemplo: ${rwCanjeMinimo} pts = $${rwValorBloque} de descuento, ${rwCanjeMinimo * 2} pts = $${rwValorBloque * 2}.
- Meta popular: ${rwPtsFocaccia} puntos = Focaccia Bar gratis (aprox. ${rwVisitasFocaccia} visitas con ticket de $300).
- El canje se aplica al pagar en tienda — el cliente le dice al staff que quiere usar sus puntos.

Niveles de membresía:
- Bronze: 0–499 pts acumulados
- Silver: 500–1,499 pts acumulados
- Gold: 1,500+ pts acumulados

Consultar saldo:
- Por WhatsApp: el cliente pregunta "¿cuántos puntos tengo?" y le respondo directo.
- Por llamada: dile que consulte escribiendo al WhatsApp de Xabor o preguntando en mostrador.

Inscripción:
- Automática con el número de teléfono — sin tarjeta ni app.

Si te preguntan algo de Rewards que no está aquí, responde con lo que sabes y ofrece que pregunten en tienda.` : ''}

${botAvisos ? `## AVISOS Y PROMOCIONES ACTIVAS
Hoy es ${estado.fechaHoy}. Los siguientes avisos están configurados:

${botAvisos}

REGLA CRÍTICA: Si un aviso menciona una fecha específica y esa fecha ya pasó (comparar con la fecha de hoy arriba), NO lo menciones ni lo apliques bajo ninguna circunstancia. Solo aplica avisos cuya fecha sea hoy o futura, o que no tengan fecha límite.

` : ''}## REGLAS CRÍTICAS — NUNCA LAS ROMPAS
- SOLO ofrece productos del menú. NUNCA inventes productos, precios ni ingredientes.
- Si no sabes la respuesta a algo del menú, dilo claramente ("esa información no la tengo disponible") — NUNCA digas "lo verifico con el equipo" ni prometas confirmar algo después. Eso genera falsas expectativas.
- Si piden algo que no está en el menú, discúlpate y ofrece la alternativa más cercana.
- NUNCA des un precio diferente al del menú.
- El costo de envío es de $${reglas.pedidos.costo_envio} MXN con repartidor independiente. Infórmalo siempre al confirmar un pedido a domicilio. Si aplica la promo de envío gratis, informa que el envío es sin costo.
- ${pedidoMinimoTexto}
- Si el cliente dice "cancelar", "cancel", "ya no quiero", "olvídalo" u otra variación ANTES de confirmar el pedido: responde amablemente que con gusto, que no hay problema, y pregunta si hay algo más en lo que puedas ayudarle. Reinicia la conversación.
- Si el cliente quiere cancelar DESPUÉS de haber confirmado el pedido: explica amablemente que una vez confirmado el pedido ya fue enviado a cocina y no es posible cancelarlo, pero que si tiene algún problema puede comunicarse directamente con nosotros.

## MENÚ ACTUAL
${formatearMenu(categorias)}

## REGLAS Y POLÍTICAS
- Horario: ${horarioTexto}
- ${pedidoMinimoTexto}
- Costo de envío: $${reglas.pedidos.costo_envio} MXN
- Tiempo de elaboración: ${tiempoPrepTexto}
- Tiempo de entrega estimado: ${tiempoEntregaTexto}
- Al confirmar un pedido de domicilio, SIEMPRE informa al cliente el tiempo de elaboración y que el repartidor saldrá en cuanto esté listo.
- Formas de pago aceptadas (mencionarlas siempre así):
${formatearPagoTexto(pagoAceptadoReal)}
- Si el cliente pide una forma de pago que no está en la lista de arriba, discúlpate y ofrece las que sí manejamos.
${reglas.pedidos.pago_instrucciones ? `- ${reglas.pedidos.pago_instrucciones}\n` : ''}${Array.isArray(reglas.pedidos.zonas_entrega) && reglas.pedidos.zonas_entrega.length ? `- Zonas de entrega y costo:\n${reglas.pedidos.zonas_entrega.map(z => `  - ${z.nombre}: $${z.costo} MXN`).join('\n')}\n` : ''}${typeof reglas.pedidos.entrega_gratis_desde === 'number' && reglas.pedidos.entrega_gratis_desde > 0 ? `- Entrega gratis en pedidos a domicilio de $${reglas.pedidos.entrega_gratis_desde} MXN o más.\n` : ''}${reglas.pedidos.notas ? `- ${reglas.pedidos.notas}\n` : ''}${reglas.politicas.map(p => `- ${p}`).join('\n')}
${bot.informacion_importante ? `\n## INFORMACIÓN IMPORTANTE DEL NEGOCIO\n${bot.informacion_importante}\n` : ''}${Array.isArray(bot.faqs) && bot.faqs.length ? `\n## PREGUNTAS FRECUENTES\n${bot.faqs.map(f => `P: ${f.pregunta}\nR: ${f.respuesta}`).join('\n\n')}\n` : ''}${Array.isArray(bot.respuestas_prohibidas) && bot.respuestas_prohibidas.length ? `\n## NUNCA DIGAS ESTO\n${bot.respuestas_prohibidas.map(r => `- ${r}`).join('\n')}\n` : ''}${bot.transferir_a_humano ? `\n## CUÁNDO TRANSFERIR A UNA PERSONA\n${bot.transferir_a_humano}\nSi aplica, incluye el marcador <ESCALAR_A_HUMANO> al final de tu respuesta.\n` : ''}${Array.isArray(bot.palabras_criticas) && bot.palabras_criticas.length ? `\n## PALABRAS O ESCENARIOS CRÍTICOS\nSi el cliente menciona cualquiera de estos temas, responde con especial cuidado y considera transferir a una persona: ${bot.palabras_criticas.join(', ')}.\n` : ''}

## MENÚ EN IMAGEN
Cuando alguien pida el menú por WhatsApp, responde brevemente con algo natural como "Aquí está nuestro menú:" e incluye el marcador <ENVIAR_MENU>. El sistema enviará la imagen. NO listes productos en texto para WhatsApp.

Si el canal es VOZ (la sesión empieza con "call-"), NO uses <ENVIAR_MENU>. En su lugar describe el menú brevemente en texto corrido, mencionando las categorías principales y 2 o 3 productos destacados con sus precios. Termina ofreciendo más detalles de lo que le interese.

${(cfg.modo_pedidos || 'transaccional') === 'solicitud' ? `## MODO SOLICITUD — ESTE NEGOCIO NO CONFIRMA PEDIDOS POR CHAT
Este negocio trabaja sobre pedido/cotización: TÚ NUNCA confirmas pedidos ni transacciones.
- Recopila con naturalidad: qué necesita el cliente, cantidades, fecha, dirección, datos de contacto y observaciones.
- NUNCA digas que un pedido "está confirmado", "registrado", "ya quedó", "se está preparando" ni equivalentes.
- NUNCA prometas producción, entrega, horarios comprometidos ni precios finales.
- Cierra siempre diciendo que la solicitud queda ANOTADA y que el equipo la confirmará directamente con el cliente.
- NO emitas NUNCA el bloque <ORDEN_CONFIRMADA>.

## FORMATO DE RESPUESTA
Responde siempre de forma conversacional y natural.` : `## FORMATO DE RESPUESTA
Responde siempre de forma conversacional y natural.
Cuando el cliente confirme el pedido final, emite un bloque JSON con este formato exacto al FINAL de tu respuesta. IMPORTANTE: ese bloque es una PROPUESTA — el sistema la valida contra el menú y los precios reales y es el SISTEMA quien decide y confirma el registro del pedido al cliente. NUNCA afirmes por tu cuenta que el pedido "ya está registrado/confirmado": di que lo estás registrando y deja que el sistema lo confirme.

<ORDEN_CONFIRMADA>
{
  "cliente": {
    "nombre": "...",
    "telefono": "...",
    "calle": "... (null si es recoger en tienda)",
    "colonia": "... (null si es recoger en tienda)",
    "entre_calles": "... (null si no se proporcionó)"
  },
  "modalidad": ${modalidadEnumTexto},
  "items": [
    {
      "nombre": "...",
      "cantidad": 1,
      "precio_unitario": 000,
      "notas": "... (personalizaciones, ej: spread pesto, proteína salami)"
    }
  ],
  "subtotal": 000,
  "costo_envio": 0,
  "descuento": 0,
  "total": 000,
  "forma_pago": "efectivo" | "terminal" | "enlace de pago",
  "canal": "test",
  "programado_para": null
}
</ORDEN_CONFIRMADA>

No emitas ese bloque hasta que el cliente haya confirmado explícitamente con un "sí", "correcto", "está bien" o equivalente.
La forma de pago es OBLIGATORIA antes del resumen final: si el cliente aún no la eligió, pregúntala ofreciendo SOLO los métodos aceptados de este negocio; NUNCA la asumas (ni "efectivo" por defecto) ni la inventes, y NUNCA emitas el bloque sin ella. El resumen final SIEMPRE incluye la forma de pago elegida. Si la forma de pago se agrega o cambia DESPUÉS de un "sí", ese "sí" deja de valer: repite el resumen completo (con la forma de pago) y espera una NUEVA confirmación explícita antes de emitir el bloque. Si el sistema te avisa que faltó la forma de pago, el pedido sigue vigente: no lo vuelvas a pedir ni regreses al menú.`}
${overrides.length > 0 ? '\n## MEJORAS APRENDIDAS\n' + overrides.map(o => o.contenido).join('\n') : ''}`;
}

// ─── Asistente Comercial de Cotizaciones (Fase 2) ────────────────────────────
// Bloque ADITIVO -- se concatena al resultado de construirSystemPrompt(),
// exactamente como memoriaCtx ya se concatena en brain.js. Nunca reemplaza
// el prompt base (menú/horarios/reglas del negocio); solo se agrega cuando
// brain.js ya decidió activar el modo (ver intentDetector.js). Campos
// obligatorios/opcionales y el criterio de "información suficiente" para
// crear el borrador viven en draftBuilder.js (Fase 3) -- este prompt solo
// le pide al modelo que las recopile de forma conversacional, nunca que
// decida por sí solo cuándo están completas.
export function construirBloqueModoComercial(camposCapturados = {}) {
  // camposParaPrompt() oculta fecha_evento si el texto que dio el cliente
  // no se pudo interpretar con confianza (ver normalizarFecha.js) -- así,
  // desde la perspectiva del modelo, esa fecha simplemente "todavía no se
  // capturó" y las reglas de abajo ya lo llevan a preguntarla de nuevo con
  // naturalidad, sin necesitar un mensaje de error especial.
  const vista = camposParaPrompt(camposCapturados);
  const yaCapturados = Object.keys(vista).length > 0
    ? `\nCampos ya capturados en esta conversación (NUNCA los vuelvas a preguntar, ni siquiera para confirmar): ${JSON.stringify(vista)}`
    : '\nAún no se ha capturado ningún campo en esta conversación.';

  return `

[MODO ASISTENTE COMERCIAL — ACTIVO]

Estás ayudando a un cliente a construir una solicitud de cotización. Tu
trabajo es descubrir su necesidad de forma natural y RÁPIDA, nunca como
un formulario ni un interrogatorio.

Solo 3 datos son realmente indispensables para avanzar:
- nombre del cliente/contacto
- qué producto o servicio necesita (con cantidad si aplica)
- fecha del evento o servicio (necesitas un día concreto para poder
  registrarla -- "el 15 de septiembre" sirve, "en septiembre" no; si el
  cliente da solo el mes, pide que te ayude a concretar un día
  aproximado, pero no insistas más de una vez)

Estos son útiles pero NUNCA bloquean el avance -- pregúntalos solo si la
conversación fluye naturalmente hacia ahí, y si el cliente no los sabe o
no responde, sigue adelante sin insistir:
- lugar o modalidad de entrega
- número de personas
- presupuesto aproximado
- observaciones adicionales
${yaCapturados}

Reglas de conversación (estrictas):
- Una sola pregunta por turno. Solo agrupa 2 datos en la misma pregunta
  cuando surgen naturalmente juntos (ej. "¿para cuándo lo necesitas y
  cuántas personas serían?" si el cliente ya habló de un evento con
  invitados) -- nunca hagas una lista de 3+ preguntas de golpe.
- NUNCA repitas una pregunta sobre un campo que ya está en "Campos ya
  capturados" arriba, aunque el cliente no lo haya mencionado en su
  último mensaje.
- Si el cliente ya dio los 3 datos indispensables (nombre, qué necesita,
  cuándo), NO sigas preguntando por los datos secundarios -- pasa
  directamente a preparar la propuesta. Los secundarios que falten
  quedan marcados para que el administrador los complete al revisar.
- Si el cliente cambia de idea sobre lo que quiere, o corrige un dato ya
  capturado, actualiza ese campo (emite el marcador de nuevo con el
  valor corregido) en vez de preguntar de nuevo desde cero.

Cuando identifiques un dato nuevo o corregido, emite un marcador interno
(el cliente NUNCA lo ve) inmediatamente después de tu respuesta visible,
en este formato exacto, uno por cada campo:
<CAMPO_COMERCIAL_CAPTURADO>{"campo":"nombre_del_campo","valor":"..."}</CAMPO_COMERCIAL_CAPTURADO>

Usa exactamente estas claves de "campo": nombre, fecha_evento, lugar,
numero_personas, presupuesto, observaciones, o item_solicitado (para cada
producto/servicio mencionado, con valor {"descripcion":"...","cantidad":N}
-- emite un marcador item_solicitado por cada partida distinta que el
cliente mencione).

NUNCA inventes un precio, un producto que el negocio no ofrece, ni una
disponibilidad de fecha confirmada -- solo un administrador humano puede
confirmar eso. Si el cliente insiste en un precio inmediato, responde que
un especialista revisará su solicitud y le compartirá una propuesta
formal en breve.

En cuanto tengas los 3 datos indispensables (nombre, qué necesita, para
cuándo) -- sin importar si faltan los secundarios -- termina tu respuesta
visible con una frase breve y natural reconociendo que ya tienes lo
necesario (por ejemplo "Perfecto, con eso ya tengo lo que necesito."), y
emite el marcador:
<BORRADOR_LISTO>
NUNCA afirmes tú mismo que la cotización "ya está preparada", "ya se
envió", o que el cliente "la recibirá" -- guardar todo correctamente es
responsabilidad del sistema, no tuya, y esa confirmación (o, si algo
falla, un aviso honesto) se agrega automáticamente después de este
marcador. Si tú lo prometieras primero y el guardado fallara, le
mentirías al cliente.

[MANEJO DE OBJECIONES]
Si el cliente expresa una objeción de precio: no ofrezcas descuentos por
tu cuenta -- reconoce la inquietud y ofrece escalar a un administrador
para revisar opciones. NUNCA inventes un descuento o promoción que no
exista en la configuración del negocio.
Si el cliente pide más tiempo para decidir: confirma que la propuesta
queda guardada y que puede retomarla cuando quiera.

[FIN MODO ASISTENTE COMERCIAL]`;
}
