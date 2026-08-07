// ─── Central de Operaciones (Superadmin) ────────────────────────────────────
// Implementación, configuración y acompañamiento de negocios a escala
// (objetivo: 100+). Este módulo NO duplica la administración que ya existe
// (crearNegocioCompleto, checklist de instalación, integraciones por
// negocio): agrega encima de ella la capa de OPERACIÓN — pipeline de
// onboarding, checklist operativo con responsables/fechas/notas, ficha
// agregada de negocio, listado escalable y sesiones temporales de soporte.
//
// Regla transversal: nunca exponer contraseñas, hashes, tokens completos,
// credenciales cifradas ni claves de proveedor. Todo lo sensible se reporta
// como booleano de existencia ("tiene_password", "credencial_emitida") o
// enmascarado, siguiendo el criterio ya establecido en
// obtenerNegocioDetalleSuperadmin.
import { createHash, randomBytes } from 'crypto';
import { pool, registrarAuditoriaPlataforma, esSuperadmin } from './database.js';
import { crearTokenSesion } from './session.js';

// Estados del pipeline de onboarding (migración 037). El orden importa:
// define el "progreso" mostrado en el listado y qué transiciones son
// avance vs. retroceso. pausado/cancelado quedan fuera de la línea
// principal (son laterales, se entra y sale de ellos manualmente).
export const ONBOARDING_ESTADOS = [
  'prospecto', 'alta_iniciada', 'invitacion_enviada', 'cuenta_creada',
  'configuracion_en_proceso', 'integraciones', 'pruebas',
  'listo_para_operar', 'activo',
];
export const ONBOARDING_ESTADOS_LATERALES = ['pausado', 'cancelado'];

// Qué estados avanza el sistema SOLO (derivados de datos que ya existen) y
// cuáles exigen decisión humana explícita del equipo Xabor. Los automáticos
// nunca retroceden un estado manual: derivarOnboardingAutomatico solo
// avanza si el estado persistido está ANTES del derivado.
const ONBOARDING_AUTOMATICOS = ['invitacion_enviada', 'cuenta_creada', 'configuracion_en_proceso'];
const ONBOARDING_MANUALES = ['prospecto', 'alta_iniciada', 'integraciones', 'pruebas', 'listo_para_operar', 'activo', 'pausado', 'cancelado'];

// ─── Checklist operativo ────────────────────────────────────────────────────
// Pasos del checklist de implementación de la Central de Operaciones. Cada
// paso declara si su estado se CALCULA de datos reales (automatico: true) o
// si lo confirma una persona (automatico: false). Los manuales se guardan
// dentro de negocios.checklist bajo la clave "operativo" (mismo JSONB que
// ya usa el checklist de instalación de la migración 011 — sin tabla nueva),
// con la forma { estado, responsable, fecha, notas, bloqueante, siguiente_accion }.
export const CHECKLIST_OPERATIVO_PASOS = [
  { clave: 'negocio_creado',          automatico: true },
  { clave: 'invitacion_enviada',      automatico: true },
  { clave: 'administrador_registrado', automatico: true },
  { clave: 'datos_completos',         automatico: true },
  { clave: 'horarios',                automatico: true },
  { clave: 'menu',                    automatico: true },
  { clave: 'whatsapp',                automatico: true },
  { clave: 'bot',                     automatico: true },
  { clave: 'metodos_pago',            automatico: true },
  { clave: 'impresion',               automatico: false },
  { clave: 'delivery',                automatico: false },
  { clave: 'red_repartidores',        automatico: true },
  { clave: 'modulo_restaurante',      automatico: true },
  { clave: 'pedido_prueba',           automatico: false },
  { clave: 'capacitacion',            automatico: false },
  { clave: 'listo_para_operar',       automatico: false },
];
export const CHECKLIST_ESTADOS = ['pendiente', 'en_proceso', 'bloqueado', 'completado', 'no_aplica'];

function pasoManualDesdeChecklist(checklist, clave) {
  const op = checklist?.operativo?.[clave];
  if (op && typeof op === 'object') {
    return {
      estado: CHECKLIST_ESTADOS.includes(op.estado) ? op.estado : 'pendiente',
      responsable: op.responsable || null,
      fecha: op.fecha || null,
      notas: op.notas || null,
      bloqueante: op.bloqueante || null,
      siguiente_accion: op.siguiente_accion || null,
      evidencia: op.evidencia || null,
    };
  }
  return { estado: 'pendiente', responsable: null, fecha: null, notas: null, bloqueante: null, siguiente_accion: null, evidencia: null };
}

// Una sola consulta agregada por negocio (sin N+1): todos los hechos
// necesarios para calcular los pasos automáticos del checklist y la ficha.
async function hechosDeNegocio(negocioId) {
  const { rows } = await pool.query(`
    SELECT
      n.id, n.nombre, n.slug, n.estado, n.plan, n.activo, n.bot_whatsapp_activo,
      n.checklist, n.onboarding_estado, n.implementacion, n.created_at, n.updated_at,
      (SELECT row_to_json(x) FROM (
        SELECT u.id, u.nombre, u.email, (u.password_hash IS NOT NULL) AS tiene_password, u.created_at
        FROM usuario_negocios un JOIN usuarios u ON u.id = un.usuario_id
        WHERE un.negocio_id = n.id AND un.rol = 'admin' AND un.activo = true
        ORDER BY un.created_at ASC LIMIT 1
      ) x) AS admin_principal,
      (SELECT count(*) FROM usuario_negocios un WHERE un.negocio_id = n.id AND un.activo = true) AS num_usuarios,
      (SELECT row_to_json(y) FROM (
        SELECT i.expires_at, i.used_at, i.revoked_at, i.created_at
        FROM invitaciones_usuario i WHERE i.negocio_id = n.id
        ORDER BY i.created_at DESC LIMIT 1
      ) y) AS ultima_invitacion,
      (SELECT count(*) FROM menu_productos mp WHERE mp.negocio_id = n.id) AS productos_menu,
      (SELECT count(*) FROM pedidos p WHERE p.negocio_id = n.id) AS pedidos_totales,
      (SELECT max(p.created_at) FROM pedidos p WHERE p.negocio_id = n.id) AS ultimo_pedido_at,
      (SELECT count(*) FROM pedidos_activos pa WHERE pa.negocio_id = n.id) AS pedidos_activos,
      (SELECT count(*) FROM repartidores r WHERE r.negocio_id = n.id AND r.activo = true) AS repartidores_activos,
      (SELECT jsonb_object_agg(nm.modulo, nm.estado) FROM negocio_modulos nm WHERE nm.negocio_id = n.id) AS modulos,
      (SELECT jsonb_agg(jsonb_build_object('canal', ic.canal, 'estado', ic.estado, 'activo', ic.activo))
         FROM integraciones_canal ic WHERE ic.negocio_id = n.id) AS integraciones,
      (SELECT count(*) FROM metodos_pago mpg WHERE mpg.negocio_id = n.id AND mpg.habilitado = true) AS metodos_pago_habilitados,
      (SELECT count(*) FROM terminales t JOIN sucursales s ON s.id = t.sucursal_id WHERE s.negocio_id = n.id AND t.activo = true) AS terminales_activas,
      EXISTS (SELECT 1 FROM configuracion c WHERE c.negocio_id = n.id AND c.clave = 'horario' AND c.valor IS NOT NULL AND c.valor != '') AS tiene_horario,
      EXISTS (SELECT 1 FROM configuracion c WHERE c.negocio_id = n.id AND c.clave = 'telefono' AND c.valor IS NOT NULL AND c.valor != '') AS tiene_telefono,
      (SELECT jsonb_object_agg(c.clave, c.valor) FROM configuracion c
        WHERE c.negocio_id = n.id AND c.clave IN ('ciudad','telefono','direccion','nombre_corto')) AS contacto
    FROM negocios n WHERE n.id = $1
  `, [negocioId]);
  return rows[0] || null;
}

function calcularPasosChecklist(hechos) {
  const modulos = hechos.modulos || {};
  const integraciones = hechos.integraciones || [];
  const waActiva = integraciones.some(i => i.canal === 'whatsapp' && (i.estado === 'activo' || i.activo === true));
  const inv = hechos.ultima_invitacion;
  const invitacionVigente = !!(inv && !inv.used_at && !inv.revoked_at && new Date(inv.expires_at) > new Date());
  const invitacionAceptada = !!(inv && inv.used_at);

  // Estado de cada paso automático, derivado SOLO de datos existentes.
  const automaticos = {
    negocio_creado: 'completado',
    invitacion_enviada: (invitacionAceptada || invitacionVigente || !!inv) ? 'completado' : 'pendiente',
    administrador_registrado: hechos.admin_principal?.tiene_password ? 'completado' : (hechos.admin_principal ? 'en_proceso' : 'pendiente'),
    datos_completos: (hechos.tiene_telefono && hechos.nombre) ? 'completado' : 'en_proceso',
    horarios: hechos.tiene_horario ? 'completado' : 'pendiente',
    menu: Number(hechos.productos_menu) > 0 ? 'completado' : 'pendiente',
    whatsapp: waActiva ? 'completado' : 'pendiente',
    bot: hechos.bot_whatsapp_activo ? 'completado' : 'pendiente',
    metodos_pago: Number(hechos.metodos_pago_habilitados) > 0 ? 'completado' : 'pendiente',
    red_repartidores: (modulos.repartidores === 'activo' || Number(hechos.repartidores_activos) > 0) ? 'completado' : 'pendiente',
    modulo_restaurante: modulos.restaurante === 'activo' ? 'completado' : 'pendiente',
  };

  return CHECKLIST_OPERATIVO_PASOS.map(def => {
    const manual = pasoManualDesdeChecklist(hechos.checklist, def.clave);
    if (def.automatico) {
      // El estado real viene del cálculo; los metadatos (responsable, notas,
      // bloqueante...) sí pueden anotarse manualmente encima.
      return { clave: def.clave, automatico: true, ...manual, estado: automaticos[def.clave] ?? 'pendiente' };
    }
    return { clave: def.clave, automatico: false, ...manual };
  });
}

function progresoDesdePasos(pasos) {
  const relevantes = pasos.filter(p => p.estado !== 'no_aplica');
  if (!relevantes.length) return 0;
  const completados = relevantes.filter(p => p.estado === 'completado').length;
  return Math.round((completados / relevantes.length) * 100);
}

// Deriva el estado de onboarding "automático" a partir de los hechos. Solo
// devuelve estados de la porción automática del pipeline; los estados
// manuales (integraciones/pruebas/listo_para_operar/activo/pausado/
// cancelado) nunca se derivan aquí.
function derivarOnboardingAutomatico(hechos) {
  if (hechos.admin_principal?.tiene_password) return 'configuracion_en_proceso';
  if (hechos.ultima_invitacion) return 'invitacion_enviada';
  return 'alta_iniciada';
}

function resolverOnboarding(hechos) {
  const persistido = hechos.onboarding_estado || 'alta_iniciada';
  // Estados laterales y manuales mandan tal cual.
  if (ONBOARDING_ESTADOS_LATERALES.includes(persistido)) return persistido;
  const derivado = derivarOnboardingAutomatico(hechos);
  const idxPersistido = ONBOARDING_ESTADOS.indexOf(persistido);
  const idxDerivado = ONBOARDING_ESTADOS.indexOf(derivado);
  // El derivado solo AVANZA — nunca retrocede un estado manual posterior
  // (p. ej. 'pruebas' no vuelve a 'configuracion_en_proceso' porque el
  // cálculo diga menos).
  return idxDerivado > idxPersistido ? derivado : persistido;
}

// ─── Ficha completa de un negocio ───────────────────────────────────────────
export async function obtenerFichaNegocio(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return null;
  const hechos = await hechosDeNegocio(negocioId.trim());
  if (!hechos) return null;

  const pasos = calcularPasosChecklist(hechos);
  const onboarding = resolverOnboarding(hechos);
  const impl = hechos.implementacion || {};
  const inv = hechos.ultima_invitacion;

  return {
    general: {
      id: hechos.id, nombre: hechos.nombre, slug: hechos.slug,
      contacto: hechos.contacto || {},
      estado: hechos.estado, plan: hechos.plan, activo: hechos.activo,
      mensualidad: impl.mensualidad ?? null,
      fecha_alta: hechos.created_at,
      responsable_comercial: impl.responsable_comercial ?? null,
      responsable_implementacion: impl.responsable_implementacion ?? null,
    },
    cuenta: {
      admin_principal: hechos.admin_principal ? {
        id: hechos.admin_principal.id, nombre: hechos.admin_principal.nombre,
        email: hechos.admin_principal.email, tiene_password: hechos.admin_principal.tiene_password,
      } : null,
      num_usuarios: Number(hechos.num_usuarios),
      invitacion: inv ? {
        enviada: true,
        aceptada: !!inv.used_at,
        vigente: !inv.used_at && !inv.revoked_at && new Date(inv.expires_at) > new Date(),
        expira_at: inv.expires_at,
        enviada_at: inv.created_at,
      } : { enviada: false, aceptada: false, vigente: false, expira_at: null, enviada_at: null },
      acceso: hechos.admin_principal?.tiene_password ? 'con_acceso' : (inv ? 'invitacion_pendiente' : 'sin_invitacion'),
    },
    configuracion: {
      datos_generales: hechos.tiene_telefono ? 'completo' : 'incompleto',
      horarios: hechos.tiene_horario,
      menu_productos: Number(hechos.productos_menu),
      whatsapp: (hechos.integraciones || []).some(i => i.canal === 'whatsapp' && (i.estado === 'activo' || i.activo === true)),
      bot_activo: hechos.bot_whatsapp_activo,
      metodos_pago_habilitados: Number(hechos.metodos_pago_habilitados),
      terminales_activas: Number(hechos.terminales_activas),
      modulos: hechos.modulos || {},
      repartidores_activos: Number(hechos.repartidores_activos),
    },
    operacion: {
      pedidos_totales: Number(hechos.pedidos_totales),
      pedidos_activos: Number(hechos.pedidos_activos),
      ultimo_pedido_at: hechos.ultimo_pedido_at,
      ultima_actividad: hechos.ultimo_pedido_at || hechos.updated_at,
      estado_operativo: hechos.estado === 'activo'
        ? (Number(hechos.pedidos_totales) > 0 ? 'operando' : 'activo_sin_pedidos')
        : hechos.estado,
    },
    implementacion: {
      onboarding_estado: onboarding,
      onboarding_persistido: hechos.onboarding_estado,
      progreso: progresoDesdePasos(pasos),
      fecha_objetivo: impl.fecha_objetivo ?? null,
      siguiente_accion: impl.siguiente_accion ?? null,
      bloqueantes: Array.isArray(impl.bloqueantes) ? impl.bloqueantes : [],
      notas: impl.notas ?? null,
    },
    checklist_operativo: pasos,
  };
}

// ─── Checklist operativo: escritura de pasos manuales ───────────────────────
export async function actualizarPasoChecklistOperativo(negocioId, clave, cambios, superadminId) {
  const def = CHECKLIST_OPERATIVO_PASOS.find(p => p.clave === clave);
  if (!def) throw Object.assign(new Error(`Paso desconocido: ${clave}`), { code: 'PASO_INVALIDO' });
  if (cambios.estado !== undefined) {
    if (!CHECKLIST_ESTADOS.includes(cambios.estado)) {
      throw Object.assign(new Error(`Estado inválido: ${cambios.estado}`), { code: 'ESTADO_INVALIDO' });
    }
    if (def.automatico) {
      // El estado de un paso automático lo calcula el sistema — solo los
      // metadatos son editables. Cambiarlo a mano crearía dos fuentes de
      // verdad en desacuerdo.
      throw Object.assign(new Error(`El paso ${clave} es automático — su estado no se edita manualmente`), { code: 'PASO_AUTOMATICO' });
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT checklist FROM negocios WHERE id = $1 FOR UPDATE', [negocioId]);
    if (!rows.length) { await client.query('ROLLBACK'); return null; }
    const checklist = rows[0].checklist || {};
    const operativo = checklist.operativo || {};
    const previo = operativo[clave] || {};
    const nuevo = { ...previo };
    for (const campo of ['estado', 'responsable', 'fecha', 'notas', 'bloqueante', 'siguiente_accion', 'evidencia']) {
      if (cambios[campo] !== undefined) nuevo[campo] = cambios[campo];
    }
    operativo[clave] = nuevo;
    checklist.operativo = operativo;
    await client.query('UPDATE negocios SET checklist = $2, updated_at = NOW() WHERE id = $1', [negocioId, JSON.stringify(checklist)]);
    await registrarAuditoriaPlataforma({
      superadminId, accion: 'checklist_operativo', negocioId,
      estadoAnterior: { [clave]: previo }, estadoNuevo: { [clave]: nuevo },
    }, client);
    await client.query('COMMIT');
    return nuevo;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ─── Pipeline: transición manual de onboarding ──────────────────────────────
export async function actualizarOnboardingEstado(negocioId, estadoNuevo, superadminId) {
  const todos = [...ONBOARDING_ESTADOS, ...ONBOARDING_ESTADOS_LATERALES];
  if (!todos.includes(estadoNuevo)) {
    throw Object.assign(new Error(`Estado de onboarding inválido: ${estadoNuevo}`), { code: 'ESTADO_INVALIDO' });
  }
  if (!ONBOARDING_MANUALES.includes(estadoNuevo)) {
    // Los automáticos los fija el sistema al leer la ficha — aceptarlos por
    // esta vía dejaría al humano "pegándole" a un estado que el derivado
    // sobrescribiría en la siguiente lectura.
    throw Object.assign(new Error(`El estado ${estadoNuevo} es automático — lo deriva el sistema`), { code: 'ESTADO_AUTOMATICO' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT onboarding_estado FROM negocios WHERE id = $1 FOR UPDATE', [negocioId]);
    if (!rows.length) { await client.query('ROLLBACK'); return null; }
    const anterior = rows[0].onboarding_estado;
    await client.query('UPDATE negocios SET onboarding_estado = $2, updated_at = NOW() WHERE id = $1', [negocioId, estadoNuevo]);
    await registrarAuditoriaPlataforma({
      superadminId, accion: 'onboarding_estado', negocioId,
      estadoAnterior: { onboarding_estado: anterior }, estadoNuevo: { onboarding_estado: estadoNuevo },
    }, client);
    await client.query('COMMIT');
    return { anterior, nuevo: estadoNuevo };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ─── Implementación (responsables, fecha objetivo, notas) ───────────────────
const CAMPOS_IMPLEMENTACION = ['responsable_comercial', 'responsable_implementacion', 'fecha_objetivo', 'siguiente_accion', 'bloqueantes', 'notas', 'mensualidad'];

export async function actualizarImplementacion(negocioId, cambios, superadminId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT implementacion FROM negocios WHERE id = $1 FOR UPDATE', [negocioId]);
    if (!rows.length) { await client.query('ROLLBACK'); return null; }
    const previo = rows[0].implementacion || {};
    const nuevo = { ...previo };
    for (const campo of CAMPOS_IMPLEMENTACION) {
      if (cambios[campo] !== undefined) nuevo[campo] = cambios[campo];
    }
    await client.query('UPDATE negocios SET implementacion = $2, updated_at = NOW() WHERE id = $1', [negocioId, JSON.stringify(nuevo)]);
    await registrarAuditoriaPlataforma({
      superadminId, accion: 'implementacion', negocioId,
      estadoAnterior: previo, estadoNuevo: nuevo,
    }, client);
    await client.query('COMMIT');
    return nuevo;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ─── Listado escalable (Central) ────────────────────────────────────────────
// Una sola consulta con subqueries escalares — sin N+1, sin cargar la ficha
// completa de cada negocio. limit acotado (máx 100), igual que
// obtenerNegociosParaSuperadmin.
export async function listarNegociosCentral({ buscar = '', onboarding = '', estado = '', responsable = '', orden = 'created_at', limit = 50, offset = 0 } = {}) {
  const limitSeguro = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const offsetSeguro = Math.max(Number(offset) || 0, 0);
  const condiciones = [];
  const params = [];
  if (buscar) {
    params.push(`%${buscar}%`);
    condiciones.push(`(n.nombre ILIKE $${params.length} OR n.slug ILIKE $${params.length})`);
  }
  if (onboarding && [...ONBOARDING_ESTADOS, ...ONBOARDING_ESTADOS_LATERALES].includes(onboarding)) {
    params.push(onboarding);
    condiciones.push(`n.onboarding_estado = $${params.length}`);
  }
  if (estado && ['pendiente', 'activo', 'suspendido'].includes(estado)) {
    params.push(estado);
    condiciones.push(`n.estado = $${params.length}`);
  }
  if (responsable) {
    params.push(`%${responsable}%`);
    condiciones.push(`(n.implementacion->>'responsable_implementacion' ILIKE $${params.length} OR n.implementacion->>'responsable_comercial' ILIKE $${params.length})`);
  }
  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
  // Orden con lista blanca — nunca interpolar entrada del cliente en el SQL.
  const ORDENES = {
    created_at: 'n.created_at DESC',
    nombre: 'n.nombre ASC',
    onboarding: 'n.onboarding_estado ASC, n.created_at DESC',
    actividad: 'ultima_actividad DESC NULLS LAST',
  };
  const orderBy = ORDENES[orden] || ORDENES.created_at;
  params.push(limitSeguro, offsetSeguro);

  const { rows } = await pool.query(`
    SELECT
      n.id, n.nombre, n.slug, n.estado, n.plan, n.onboarding_estado, n.created_at,
      n.implementacion->>'responsable_implementacion' AS responsable_implementacion,
      n.implementacion->>'siguiente_accion' AS siguiente_accion,
      COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(n.implementacion->'bloqueantes') = 'array' THEN n.implementacion->'bloqueantes' ELSE '[]'::jsonb END), 0) AS num_bloqueantes,
      (SELECT max(p.created_at) FROM pedidos p WHERE p.negocio_id = n.id) AS ultima_actividad,
      (SELECT count(*) FROM pedidos_activos pa WHERE pa.negocio_id = n.id) AS pedidos_activos,
      EXISTS (SELECT 1 FROM negocio_modulos nm WHERE nm.negocio_id = n.id AND nm.modulo = 'repartidores' AND nm.estado = 'activo') AS red_activa,
      EXISTS (SELECT 1 FROM negocio_modulos nm WHERE nm.negocio_id = n.id AND nm.modulo = 'restaurante' AND nm.estado = 'activo') AS restaurante_activo,
      EXISTS (SELECT 1 FROM usuario_negocios un JOIN usuarios u ON u.id = un.usuario_id
              WHERE un.negocio_id = n.id AND un.rol = 'admin' AND u.password_hash IS NOT NULL) AS admin_con_acceso,
      count(*) OVER() AS total_filas
    FROM negocios n
    ${where}
    ORDER BY ${orderBy}
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);
  const total = rows.length ? Number(rows[0].total_filas) : 0;
  return { total, negocios: rows.map(({ total_filas, ...r }) => r) };
}

// ─── Sesiones de soporte ────────────────────────────────────────────────────
// Superadmin entra al panel de un negocio SIN conocer ni cambiar la
// contraseña del cliente. El token es el mismo HMAC de session.js con el
// flag sop:true — el middleware del panel lo valida contra esta tabla en
// cada request (vigente, no cerrada, no expirada) además de re-verificar
// que el usuario siga siendo superadmin. negocio_id queda fijado dentro del
// token firmado (jamás de URL/query/body/header del cliente).
const SOPORTE_DURACION_MS = 2 * 60 * 60 * 1000; // 2 horas

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export async function crearSesionSoporte(superadminId, negocioId, motivo = null) {
  const { rows: neg } = await pool.query('SELECT id, nombre, slug FROM negocios WHERE id = $1', [negocioId]);
  if (!neg.length) return null;
  const expiresAt = new Date(Date.now() + SOPORTE_DURACION_MS);
  // rol 'admin': la sesión de soporte opera el panel del negocio con las
  // mismas capacidades que su administrador (para eso existe) — la
  // diferencia es el flag sop y la auditoría, no un rol distinto.
  const token = crearTokenSesion({ usuarioId: superadminId, negocioId, rol: 'admin', sop: true }, SOPORTE_DURACION_MS);
  await pool.query(
    `INSERT INTO sesiones_soporte (superadmin_id, negocio_id, token_hash, expires_at, motivo) VALUES ($1,$2,$3,$4,$5)`,
    [superadminId, negocioId, hashToken(token), expiresAt, motivo]
  );
  await registrarAuditoriaPlataforma({
    superadminId, accion: 'sesion_soporte_iniciada', negocioId,
    estadoNuevo: { expires_at: expiresAt.toISOString(), motivo },
  });
  return { token, expiresAt, negocio: neg[0] };
}

// Chequeo caliente por request del panel: ¿este token de soporte sigue
// autorizado? (fila viva + no cerrada + no expirada). El HMAC ya se validó
// antes (verificarTokenSesion) — esto agrega la revocación server-side.
export async function sesionSoporteVigente(token) {
  try {
    const { rows } = await pool.query(
      `SELECT id, negocio_id, superadmin_id FROM sesiones_soporte
       WHERE token_hash = $1 AND cerrada_at IS NULL AND expires_at > NOW()`,
      [hashToken(token)]
    );
    return rows[0] || null;
  } catch (e) {
    console.error('[Soporte] Error sesionSoporteVigente:', e.message);
    return null; // fail closed
  }
}

// El superadmin_id real sale de la propia fila (fue quien la creó) — el
// segundo argumento existe solo por simetría con los llamadores y no
// participa en el WHERE: cerrar exige poseer el token, no un id.
export async function cerrarSesionSoporte(token, _superadminId, motivo = 'salida manual') {
  const { rows } = await pool.query(
    `UPDATE sesiones_soporte SET cerrada_at = NOW(), motivo = COALESCE(motivo, '') || ' | cierre: ' || $2
     WHERE token_hash = $1 AND cerrada_at IS NULL
     RETURNING id, negocio_id, superadmin_id`,
    [hashToken(token), motivo]
  );
  if (!rows.length) return null;
  await registrarAuditoriaPlataforma({
    superadminId: rows[0].superadmin_id, accion: 'sesion_soporte_cerrada', negocioId: rows[0].negocio_id,
    estadoNuevo: { motivo },
  });
  return rows[0];
}

export async function listarSesionesSoporte({ negocioId = null, soloVigentes = false, limit = 50 } = {}) {
  const condiciones = [];
  const params = [];
  if (negocioId) { params.push(negocioId); condiciones.push(`ss.negocio_id = $${params.length}`); }
  if (soloVigentes) condiciones.push('ss.cerrada_at IS NULL AND ss.expires_at > NOW()');
  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 100));
  const { rows } = await pool.query(`
    SELECT ss.id, ss.negocio_id, n.nombre AS negocio_nombre, ss.superadmin_id, u.nombre AS superadmin_nombre,
           ss.expires_at, ss.cerrada_at, ss.motivo, ss.created_at
    FROM sesiones_soporte ss
    JOIN negocios n ON n.id = ss.negocio_id
    JOIN usuarios u ON u.id = ss.superadmin_id
    ${where}
    ORDER BY ss.created_at DESC
    LIMIT $${params.length}
  `, params);
  return rows;
}

export { esSuperadmin };
