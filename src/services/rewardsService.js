/**
 * rewardsService.js — Módulo de Lealtad Xabor Rewards
 *
 * Completamente aislado de los flujos críticos de WhatsApp, comandas e impresión.
 * Cualquier fallo en este módulo NO afecta la operación del restaurante.
 *
 * DEUDA TÉCNICA:
 *   - clientes.telefono es actualmente la identidad del cliente (PK VARCHAR).
 *   - rewards_accounts.telefono es FK a esa columna.
 *   - Cuando se migre a UUID, reemplazar todas las referencias a `telefono` en este
 *     archivo por `cliente_id`, sin necesidad de cambiar la lógica de negocio.
 *   - La función `obtenerOCrearCuenta` es el único punto de contacto con la tabla
 *     clientes, lo que facilita esa futura migración.
 *
 * FUTURO CRM (no implementado aún, estructura compatible):
 *   - rewards_levels: niveles de membresía (Bronze/Silver/Gold)
 *     Se agrega como tabla independiente con FK a rewards_accounts.
 *   - Cupones, referidos, cumpleaños: nuevas tablas sin alterar rewards_movements.
 *   - Campañas: usar movimientos tipo 'ajuste_positivo' con motivo = 'campaña'.
 *   - Expiración: job nocturno que crea movimientos tipo 'expiracion'.
 */

import { pool, obtenerEstadoModulo } from './database.js';
import { construirDesgloseDescuentos } from './descuentos.js';

const DEFAULT_TENANT = 'xabor-principal';

// Mismo criterio de disponibilidad que requireModulo/moduloHabilitado en
// server.js/database.js -- 'activo' o 'configurado' cuentan como
// disponible. Rewards solo siembra 'activo' hoy, pero se comparte el
// mismo criterio por si en el futuro se usa 'configurado' para él.
const REWARDS_ESTADOS_DISPONIBLES = ['activo', 'configurado'];

// ─── Niveles de membresía ─────────────────────────────────────────────────────
// Se calcula desde puntos_acumulados_total (histórico, nunca baja).
// Bronze: 0–499 | Silver: 500–1499 | Gold: 1500+
// Sin tabla nueva — calculado en tiempo real.
export function calcularNivel(puntosAcumuladosTotal) {
  const pts = parseInt(puntosAcumuladosTotal) || 0;
  if (pts >= 1500) return { nombre: 'Gold',   emoji: '🥇', color: '#f59e0b', siguiente: null,     falta: 0 };
  if (pts >= 500)  return { nombre: 'Silver', emoji: '🥈', color: '#6b7280', siguiente: 'Gold',   falta: 1500 - pts };
  return               { nombre: 'Bronze', emoji: '🥉', color: '#b45309', siguiente: 'Silver', falta: 500  - pts };
}

// ─── Mapa canal de pedido → interruptor de rewards_config ────────────────────
// FUENTE ÚNICA. Vivía suelto dentro de acumularPuntos y el canje de la tienda
// necesita exactamente el mismo criterio: dos copias se desincronizan y el
// resultado es "gané puntos pero no puedo usarlos" (o al revés).
//
// La clave es el `canal` con el que registrarPedido dio de alta el pedido, no
// una etiqueta de UI. 'tienda_online' es el valor literal que estampa
// tiendaCheckout.js -- por eso faltaba: el mapa no lo tenía y `undefined` es
// falsy, así que TODA venta de la tienda salía por "canal no habilitado" sin
// que nadie lo notara. Un canal que no esté aquí NO acumula (fallo cerrado);
// es deliberado: agregar un canal debe ser una decisión, no un accidente.
//
// 'pos' (POS de envíos: el personal captura el pedido con el teléfono del
// cliente) usa el mismo interruptor que el mostrador (decisión de Mario del
// 23-nov). 'restaurante_mesa' NO está: una mesa cierra sin cliente y sin
// pasar por aquí, y meterla exigiría tocar el cobro de mesas.
export function MAPA_CANAL_CONFIG(config) {
  return {
    presencial:    config?.canal_mostrador,
    pos:           config?.canal_mostrador,
    whatsapp:      config?.canal_whatsapp,
    voz:           config?.canal_telefono,
    rappi:         config?.canal_rappi,
    tienda_online: config?.canal_tienda,
  };
}

// ─── Identidad: inscrito e identificado (saneamiento, fase 3) ────────────────
// Decisión de Mario (21-nov): «Rewards NO se da a todos: solo acumula un
// cliente inscrito e identificado». Y del prompt: «Comprar no inscribe» y
// «que lo decida el servidor, no la pantalla». Todo eso vive aquí.
export class RewardsError extends Error {
  constructor(mensaje, codigo, status = 400) {
    super(mensaje); this.codigo = codigo; this.status = status;
  }
}

/**
 * El teléfono de Rewards: los últimos 10 dígitos, con la misma regla que la
 * Lista (clientesNegocio.normalizarTelefonoCliente): de 10 a 13 dígitos. Y
 * además sin letras: el registro técnico del mostrador (`pos-` + 12
 * hexadecimales) o el de Rappi (`rappi-…`) no son un cliente aunque por
 * casualidad tuvieran diez cifras. null si no identifica a nadie.
 */
export function telefonoRewards(valor) {
  const s = String(valor == null ? '' : valor).trim();
  if (!s || /[^\d\s+().-]/.test(s)) return null;
  const d = s.replace(/\D/g, '');
  if (d.length < 10 || d.length > 13) return null;
  return d.slice(-10);
}

// Una cuenta guardada identifica a una persona si su teléfono son solo
// dígitos (10, o 52/521 + 10). El genérico `pos-…` nunca cumple.
const SQL_CUENTA_IDENTIFICABLE = (a) => `${a}.telefono ~ '^[0-9]{10,13}$'`;
const SQL_TEL10 = (a) => `right(${a}.telefono, 10)`;

/**
 * La condición ÚNICA de «cuenta que cuenta» (punto 16): activa, de una
 * persona identificable, que no es un teléfono del negocio ni un cliente
 * marcado como interno. Rewards (resumen, lista) y la Lista de Clientes la
 * usan las dos, así que no pueden dar cifras distintas.
 */
export function sqlCuentaVigente(a = 'a') {
  return `${a}.activo AND ${SQL_CUENTA_IDENTIFICABLE(a)}
    AND NOT EXISTS (SELECT 1 FROM negocio_telefonos_propios tp
                     WHERE tp.negocio_id::text = ${a}.tenant_id AND tp.activo AND tp.telefono = ${SQL_TEL10(a)})
    AND NOT EXISTS (SELECT 1 FROM clientes_negocio cn
                     WHERE cn.negocio_id::text = ${a}.tenant_id AND cn.es_interno AND cn.telefono = ${SQL_TEL10(a)})`;
}

/**
 * Una fila por PERSONA de Rewards del negocio (param = tenant_id como texto):
 * dos cuentas del mismo número en formatos distintos son una persona. Es
 * inscrita si cualquiera de sus cuentas lo está.
 */
export function sqlPersonasRewards(param = '$1') {
  return `SELECT ${SQL_TEL10('a')} AS tel10,
                 bool_or(a.inscrito_at IS NOT NULL) AS inscrito,
                 min(a.inscrito_at) AS inscrito_at,
                 COALESCE(sum(a.puntos_balance), 0)::int AS saldo,
                 COALESCE(sum(a.puntos_acumulados_total), 0)::int AS acumulado,
                 count(*)::int AS cuentas,
                 min(a.created_at) AS alta
            FROM rewards_accounts a
           WHERE a.tenant_id = ${param} AND ${sqlCuentaVigente('a')}
           GROUP BY ${SQL_TEL10('a')}`;
}

// Por qué no puede acumular (ni inscribirse) un número: null si puede.
async function motivoNoElegible(ejecutor, tenantId, tel10) {
  const { rows: [r] } = await ejecutor.query(
    `SELECT EXISTS (SELECT 1 FROM negocio_telefonos_propios
                     WHERE negocio_id::text = $1 AND telefono = $2 AND activo) AS propio,
            EXISTS (SELECT 1 FROM clientes_negocio
                     WHERE negocio_id::text = $1 AND telefono = $2 AND es_interno) AS interno`,
    [String(tenantId), tel10]);
  if (r?.propio) return 'TELEFONO_DEL_NEGOCIO';
  if (r?.interno) return 'CLIENTE_INTERNO';
  return null;
}

/**
 * La cuenta ACTIVA de una persona en este negocio, sin importar el formato en
 * que quedó guardado su teléfono (10 dígitos o 521…). Si hay dos (el mismo
 * número en dos formatos, hasta que el script de saneamiento las fusione),
 * gana la inscrita, luego la de 10 dígitos, luego la más vieja.
 */
async function resolverCuenta(ejecutor, tenantId, tel10, { bloquear = false } = {}) {
  const { rows } = await ejecutor.query(
    `SELECT * FROM rewards_accounts a
      WHERE a.tenant_id = $1 AND a.activo AND ${SQL_CUENTA_IDENTIFICABLE('a')} AND ${SQL_TEL10('a')} = $2
      ORDER BY (a.inscrito_at IS NOT NULL) DESC, (a.telefono = $2) DESC, a.created_at, a.id
      LIMIT 1 ${bloquear ? 'FOR UPDATE' : ''}`,
    [String(tenantId), tel10]);
  return rows[0] || null;
}

async function anotarBitacora(ejecutor, { tenantId, accountId, accion, antes = null, despues = null, motivo = null, usuario = null, lote = null }) {
  const { rows: [b] } = await ejecutor.query(
    `INSERT INTO rewards_bitacora (tenant_id, account_id, accion, lote, antes, despues, motivo, usuario)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [String(tenantId), accountId, accion, lote, antes && JSON.stringify(antes), despues && JSON.stringify(despues), motivo, usuario]);
  return b.id;
}

export const ORIGENES_INSCRIPCION = ['caja', 'tienda', 'whatsapp', 'admin'];

/**
 * Inscripción EXPLÍCITA (punto 11): nombre y teléfono, desde caja, tienda o
 * WhatsApp. Es la única forma de que una persona empiece a acumular.
 *
 *   · Si ya tenía una cuenta «sin inscribir» (nació al comprar antes de esta
 *     fase), se inscribe ESA cuenta y conserva sus puntos.
 *   · Un teléfono del negocio o un cliente interno no se inscribe (409).
 *   · Asegura la fila del cliente en la Lista (clientes_negocio), para que
 *     Rewards y la Lista cuenten a las mismas personas.
 *   · Todo en una transacción, con su renglón en la bitácora.
 *
 * Devuelve { cuenta, nueva, yaInscrito }.
 */
export async function inscribirCliente({ negocioId, telefono, nombre, origen, usuario = null }) {
  const tenantId = typeof negocioId === 'string' ? negocioId.trim() : '';
  if (!tenantId) throw new RewardsError('Sin negocio', 'SIN_NEGOCIO', 401);
  if (!ORIGENES_INSCRIPCION.includes(origen)) throw new RewardsError('Origen de inscripción inválido', 'ORIGEN_INVALIDO');
  const tel10 = telefonoRewards(telefono);
  if (!tel10) throw new RewardsError('El teléfono debe tener 10 dígitos', 'TELEFONO_INVALIDO');
  const nom = String(nombre == null ? '' : nombre).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (nom.length < 2) throw new RewardsError('Escribe el nombre del cliente', 'NOMBRE_REQUERIDO');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const motivo = await motivoNoElegible(client, tenantId, tel10);
    if (motivo === 'TELEFONO_DEL_NEGOCIO') {
      throw new RewardsError('Ese número es del negocio: no se inscribe en Rewards', motivo, 409);
    }
    if (motivo === 'CLIENTE_INTERNO') {
      throw new RewardsError('Ese cliente está marcado como interno: no se inscribe en Rewards', motivo, 409);
    }

    // La Lista: una persona por (negocio, teléfono). Importación dinámica a
    // propósito: clientesNegocio ya importa este archivo. Si la persona ya
    // estaba en la Lista con nombre, ese nombre se respeta: lo que se teclea
    // en caja no pisa lo que el cliente escribió en la tienda.
    const { obtenerOCrearCliente } = await import('./clientesNegocio.js');
    const { rows: [enLista] } = await client.query(
      'SELECT nombre FROM clientes_negocio WHERE negocio_id::text = $1 AND telefono = $2', [tenantId, tel10]);
    const filaLista = await obtenerOCrearCliente({
      negocioId: tenantId, telefono: tel10, nombre: enLista?.nombre ? null : nom, origen: 'rewards',
    }, client);

    let cuenta = await resolverCuenta(client, tenantId, tel10, { bloquear: true });
    let nueva = false;
    if (!cuenta) {
      // La FK rewards_accounts.telefono -> clientes(telefono) exige la fila
      // en la tabla vieja de clientes (DO NOTHING: nunca mueve ni renombra).
      await asegurarClienteParaRewards(client, tel10, nom, tenantId);
      const { rows: [creada] } = await client.query(
        `INSERT INTO rewards_accounts (telefono, tenant_id, nombre, cliente_id, inscrito_at, inscripcion_origen, inscrito_por)
         VALUES ($1, $2, $3, $4, NOW(), $5, $6)
         ON CONFLICT (telefono, tenant_id) DO NOTHING
         RETURNING *`,
        [tel10, tenantId, nom, filaLista?.id || null, origen, usuario]);
      if (creada) {
        cuenta = creada; nueva = true;
        await anotarBitacora(client, {
          tenantId, accountId: creada.id, accion: 'inscripcion', usuario,
          despues: { telefono: tel10, nombre: nom, origen, nueva: true },
        });
      } else {
        // O alguien la inscribió en este mismo instante (y ya se ve), o el
        // número tiene una cuenta dada de baja que no se revive desde aquí.
        cuenta = await resolverCuenta(client, tenantId, tel10, { bloquear: true });
        if (!cuenta) {
          throw new RewardsError('Esa cuenta de Rewards está dada de baja: revísala con el administrador', 'CUENTA_INACTIVA', 409);
        }
      }
    }

    let yaInscrito = false;
    if (!nueva) {
      if (cuenta.inscrito_at) {
        yaInscrito = true;
        if (cuenta.nombre !== nom) {
          const { rows: [c] } = await client.query(
            'UPDATE rewards_accounts SET nombre = $2, updated_at = NOW() WHERE id = $1 RETURNING *', [cuenta.id, nom]);
          cuenta = c;
        }
      } else {
        const antes = { nombre: cuenta.nombre, inscrito_at: null, puntos_balance: cuenta.puntos_balance };
        const { rows: [c] } = await client.query(
          `UPDATE rewards_accounts
              SET inscrito_at = NOW(), inscripcion_origen = $2, inscrito_por = $3, nombre = $4, updated_at = NOW()
            WHERE id = $1 RETURNING *`,
          [cuenta.id, origen, usuario, nom]);
        cuenta = c;
        await anotarBitacora(client, {
          tenantId, accountId: c.id, accion: 'inscripcion', usuario, antes,
          despues: { nombre: nom, origen, puntos_balance: c.puntos_balance, nueva: false },
        });
      }
    }
    await client.query('COMMIT');
    if (!yaInscrito) console.log(`[Rewards] Inscripción (${origen}) cuenta ${cuenta.id} — negocio ${tenantId}`);
    return { cuenta, nueva, yaInscrito };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ─── Cálculo central de puntos ────────────────────────────────────────────────
// ÚNICA fuente de verdad para el cálculo de puntos.
// El frontend solo muestra estimaciones; el backend valida y persiste.
//
// Fórmula: floor(totalElegible / config.monto_por_punto)
// Ejemplo con monto_por_punto=10:
//   $189 → floor(189/10) = 18 puntos
//   $486 → floor(486/10) = 48 puntos
//   $99  → floor(99/10)  =  9 puntos
export function calcularPuntos(totalElegible, config) {
  if (!config || !config.activo) return 0;
  if (!totalElegible || totalElegible <= 0) return 0;
  const monto = parseFloat(config.monto_por_punto);
  if (!monto || monto <= 0) return 0;
  return Math.floor(totalElegible / monto);
}

// ─── Configuración ────────────────────────────────────────────────────────────
export async function obtenerConfig(tenantId = DEFAULT_TENANT) {
  const { rows } = await pool.query(
    'SELECT * FROM rewards_config WHERE tenant_id = $1',
    [tenantId]
  );
  return rows[0] || null;
}

const CAMPOS_CONFIG_PERMITIDOS = [
  'nombre_programa','activo','monto_por_punto','puntos_por_peso',
  'canje_minimo','canal_mostrador','canal_whatsapp','canal_telefono',
  'canal_rappi','canal_tienda','vigencia_dias'
];

/**
 * Guarda la configuración de Rewards de un negocio. UPSERT, no UPDATE.
 *
 * EL FALLO QUE ESTO ARREGLA (confirmado en producción): esto era un
 * `UPDATE ... WHERE tenant_id = $1` a secas. El único INSERT de
 * `rewards_config` en todo el código vive en `initDB` con el slug
 * 'nonna-maye' escrito a mano, así que CUALQUIER otro negocio nunca tenía
 * fila. El UPDATE afectaba 0 renglones, nadie miraba `rowCount`, la ruta
 * respondía `{ok:true}` y el panel pintaba «✓ Guardado». El operador
 * configuraba su programa, leía que se había guardado, y no se guardaba
 * nada — ni forma de enterarse. Rewards quedaba inalcanzable para todo
 * negocio nuevo (Mapolato Obispado, entre otros).
 *
 * Por qué `ON CONFLICT (tenant_id)` y no un SELECT previo: dos guardados
 * simultáneos del mismo negocio (doble clic, dos pestañas) pasarían los dos
 * el "¿existe?" y los dos intentarían INSERT; el segundo reventaría contra
 * la UNIQUE. Con el upsert la base resuelve la carrera y quedan una fila y
 * un solo resultado. La identidad es `tenant_id` -- la UNIQUE real, la misma
 * en producción y en local -- y no se inventa otra: `negocio_id` existe como
 * columna nullable pero no es única y nadie la lee.
 *
 * Columnas OMITIDAS en un alta toman los DEFAULT de la tabla, que son los de
 * fábrica del programa. En particular `canal_tienda` nace en FALSE: guardar
 * la configuración nunca puede encender Rewards en la tienda por accidente.
 *
 * Crear la fila NO otorga nada comercialmente: el entitlement vive en
 * `negocio_modulos` y lo sigue exigiendo `requireModulo('rewards')` en la
 * ruta y `obtenerEstadoModulo` en acumulación y canje. Configuración y
 * contratación siguen separadas.
 *
 * Devuelve la fila REALMENTE persistida (RETURNING), o null si no había ni
 * un campo válido que guardar. El llamador no debe dar por bueno un guardado
 * sin mirar este valor.
 */
//
// Vencimiento (punto 15): `vigencia_dias` NULL = apagado (así nace). El panel
// lo pide en meses y manda días (meses × 30). Fuera de 30 a 3,650 días se
// rechaza: un error de captura no puede vencer los puntos de todos mañana.
// `vigencia_desde` es desde cuándo cuenta el plazo: el día en que se
// encendió, o el día en que el programa volvió a encenderse. Así ni encender
// el vencimiento ni reanudar un programa en pausa vencen a nadie de golpe.
export const VIGENCIA_DIAS_MIN = 30;
export const VIGENCIA_DIAS_MAX = 3650;

export function normalizarVigenciaDias(valor) {
  if (valor === null || valor === undefined || valor === '' || valor === false || Number(valor) === 0) return null;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < VIGENCIA_DIAS_MIN || n > VIGENCIA_DIAS_MAX) {
    throw new RewardsError(`El vencimiento debe ser de ${VIGENCIA_DIAS_MIN / 30} a ${VIGENCIA_DIAS_MAX / 30} meses, o apagado`, 'VIGENCIA_INVALIDA');
  }
  return n;
}

export async function actualizarConfig(tenantId = DEFAULT_TENANT, datos) {
  const campos = Object.keys(datos || {}).filter(c => CAMPOS_CONFIG_PERMITIDOS.includes(c));
  // Sin ningún campo reconocible no se crea nada: un cuerpo vacío o con
  // basura no puede dar de alta una configuración por la puerta de atrás.
  if (!campos.length) return null;

  const limpio = { ...datos };
  if (campos.includes('vigencia_dias')) limpio.vigencia_dias = normalizarVigenciaDias(datos.vigencia_dias);

  const valores = campos.map(c => limpio[c]);
  const columnas = ['tenant_id', ...campos].join(', ');
  const marcadores = ['$1', ...campos.map((_, i) => `$${i + 2}`)].join(', ');
  const set = campos.map((c, i) => `${c} = $${i + 2}`).join(', ');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [previa] } = await client.query(
      'SELECT activo, vigencia_dias, vigencia_desde FROM rewards_config WHERE tenant_id = $1 FOR UPDATE', [tenantId]);
    const { rows: [guardada] } = await client.query(
      `INSERT INTO rewards_config (${columnas})
       VALUES (${marcadores})
       ON CONFLICT (tenant_id) DO UPDATE SET ${set}, updated_at = NOW()
       RETURNING *`,
      [tenantId, ...valores]
    );
    let config = guardada;
    if (config) {
      const encendida = (Number(config.vigencia_dias) || 0) > 0;
      const estabaEncendida = (Number(previa?.vigencia_dias) || 0) > 0 && previa?.vigencia_desde != null;
      const reanudado = config.activo === true && previa != null && previa.activo !== true;
      const desde = !encendida ? null
        : (!estabaEncendida || reanudado) ? 'ahora' : 'igual';
      if (desde !== 'igual' && (desde !== null || config.vigencia_desde !== null)) {
        ({ rows: [config] } = await client.query(
          `UPDATE rewards_config SET vigencia_desde = ${desde === 'ahora' ? 'NOW()' : 'NULL'}
            WHERE tenant_id = $1 RETURNING *`, [tenantId]));
      }
    }
    await client.query('COMMIT');
    return config || null;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ─── Cuentas de cliente ───────────────────────────────────────────────────────
// rewards_accounts (UNIQUE telefono+tenant_id) es la identidad propia de
// Rewards por negocio -- nombre incluido (columna propia, migración 015).
// `clientes` solo se consulta para confirmar que la fila exista (lo exige
// la FK rewards_accounts.telefono -> clientes.telefono); nunca se lee su
// `nombre` para mostrarlo, y nunca se asume que el negocio_id de esa fila
// coincide con el tenant que está inscribiendo -- el mismo teléfono puede
// ser cliente "dueño" de otro negocio en `clientes` y aun así tener aquí
// una cuenta de Rewards totalmente independiente para este tenant.
/**
 * Asegura que exista la fila de `clientes` a la que apunta la FK
 * `rewards_accounts.telefono -> clientes(telefono)`.
 *
 * Por qué hace falta: un cliente de WhatsApp siempre tiene fila (la crea la
 * conversación), pero uno que compra por POS, tienda web o Rappi puede no
 * tenerla nunca. La acumulación entonces reventaba con
 * `violates foreign key constraint rewards_accounts_telefono_fkey` y el
 * cliente se quedaba sin sus puntos aunque el pedido y el cobro hubieran
 * salido perfectos (incidente XAB-0180).
 *
 * Es DO NOTHING a propósito, no DO UPDATE: `clientes.telefono` es una PK
 * GLOBAL con una columna negocio_id. Si ese teléfono ya existe porque compró
 * en otro negocio, tocar la fila lo movería de negocio o le borraría el
 * nombre. Aquí solo hace falta que la fila EXISTA para que la FK se cumpla;
 * la identidad de Rewards es propia y vive en (telefono, tenant_id).
 *
 * Recibe el `client` de la transacción para que crear el cliente y acreditar
 * los puntos sean el mismo acto: o pasan los dos, o no pasa ninguno.
 */
async function asegurarClienteParaRewards(ejecutor, telefono, nombre, tenantId) {
  await ejecutor.query(
    `INSERT INTO clientes (telefono, nombre, ultima_visita, negocio_id)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (telefono) DO NOTHING`,
    [telefono, nombre || null, tenantId || null]);
}

// El alta con nombre y teléfono. Desde la fase 3 ES la inscripción explícita
// (antes solo creaba la cuenta; comprar también la creaba). Se conserva el
// nombre y la forma de la respuesta para quien ya la llamaba.
export async function obtenerOCrearCuenta(telefono, nombre, tenantId = DEFAULT_TENANT, origen = 'caja', usuario = null) {
  const { cuenta } = await inscribirCliente({ negocioId: tenantId, telefono, nombre, origen, usuario });
  return cuenta;
}

// La cuenta activa de ese número en este negocio, en cualquier formato en que
// esté guardada (10 dígitos o 521…). null si el número no identifica a nadie.
// Puede venir «sin inscribir»: quien la use para acumular o canjear lo revisa.
export async function obtenerCuentaPorTelefono(telefono, tenantId = DEFAULT_TENANT) {
  const tel10 = telefonoRewards(telefono);
  if (!tel10) return null;
  return resolverCuenta(pool, tenantId, tel10);
}

// ─── Acumulación automática ───────────────────────────────────────────────────
// Llamada desde orderManager.js cuando estado = 'entregado'.
// Se ejecuta en background (fire-and-forget con try/catch en orderManager).
// Si falla aquí, la venta ya quedó archivada — nunca bloquea el flujo crítico.
export async function acumularPuntos(folio, pedido, tenantId = DEFAULT_TENANT) {
  // 0. Módulo Rewards contratado y disponible para este negocio -- defensa
  // en profundidad independiente de rewards_config.activo (que es un flag
  // heredado, previo a negocio_modulos, y puede quedar desincronizado). Se
  // consulta negocio_modulos directamente vía obtenerEstadoModulo, nunca se
  // asume. Sin punto de entrada gateado aquí, un negocio sin Rewards
  // contratado podría acumular puntos igualmente porque esta función se
  // invoca desde el flujo de pedidos (fuera de las 11 rutas de
  // requireModulo('rewards')). Fallo seguro: sin más, no acumula.
  const estadoModulo = await obtenerEstadoModulo(tenantId, 'rewards');
  if (!REWARDS_ESTADOS_DISPONIBLES.includes(estadoModulo)) {
    console.log(`[Rewards] Módulo no disponible (estado=${estadoModulo || 'sin contratar'}) — sin puntos para ${folio}`);
    return null;
  }

  // 1. Configuración
  const config = await obtenerConfig(tenantId);
  if (!config || !config.activo) {
    console.log(`[Rewards] Desactivado — sin puntos para ${folio}`);
    return null;
  }

  // 2. Canal habilitado
  const canal = pedido.canal || 'presencial';
  const mapaCanal = MAPA_CANAL_CONFIG(config);
  if (!mapaCanal[canal]) {
    console.log(`[Rewards] Canal '${canal}' no habilitado — sin puntos para ${folio}`);
    return null;
  }

  // 3. Cliente identificado (punto 10). Nunca el registro técnico del
  // mostrador (`pos-…`), ni el de Rappi, ni '—': telefonoRewards los rechaza.
  // Y nunca un teléfono del negocio ni un cliente marcado como interno.
  const telefono = pedido.cliente?.telefono;
  const tel10 = telefonoRewards(telefono);
  if (!tel10) {
    console.log(`[Rewards] Sin cliente identificado — sin puntos para ${folio}`);
    return null;
  }
  const noElegible = await motivoNoElegible(pool, tenantId, tel10);
  if (noElegible) {
    console.log(`[Rewards] ${noElegible === 'TELEFONO_DEL_NEGOCIO' ? 'Teléfono del negocio' : 'Cliente interno'} — sin puntos para ${folio}`);
    return null;
  }

  // 4. Total elegible: la parte de la venta que el cliente pagó con DINERO.
  // Fuera la propina (no es venta) y fuera lo que se pagó con puntos (no se
  // dan puntos sobre puntos).
  //
  // El detalle que hacía falta acertar: `pedido.total` NO siempre significa
  // lo mismo, según por dónde entró la venta.
  //
  //   · POS clásico (crear = cobrar): el total se fija ANTES de registrar el
  //     canje, así que es BRUTO -- todavía incluye lo que se pagará con
  //     puntos. Aquí sí hay que restarlo.
  //   · POS por_cobrar y tienda en línea: el cobro (o el checkout) fija el
  //     total YA rebajado por el canje y deja constancia en
  //     `datos.rewards_canje`. Restarlo otra vez lo descontaba DOS veces:
  //     una venta de $200 pagada con $100 de puntos daba 0 puntos en vez de
  //     los 10 que corresponden a los $100 en efectivo.
  //
  // `rewards_canje` es la señal, y es fiable porque lo escribe exactamente
  // el mismo acto que rebaja el total (cobrarPedidoActivo y
  // aplicarRewardsAlPedido); nunca aparece sin que el total ya esté neto.
  let montoCanjeado = 0;
  try {
    const { rows: [canjePrev] } = await pool.query(
      `SELECT metadata FROM rewards_movements
       WHERE folio_venta = $1 AND tipo = 'canje' AND tenant_id = $2`,
      [folio, tenantId]
    );
    if (canjePrev?.metadata) {
      const meta = typeof canjePrev.metadata === 'string'
        ? JSON.parse(canjePrev.metadata) : canjePrev.metadata;
      montoCanjeado = parseFloat(meta.monto_descuento || 0);
    }
  } catch (_) { /* sin canje previo — continuar */ }

  const totalYaNeto = pedido.rewards_canje != null;
  const totalElegible = Math.max(0,
    parseFloat(pedido.total || 0)
      - parseFloat(pedido.propina || 0)
      - (totalYaNeto ? 0 : montoCanjeado)
  );
  const puntos = calcularPuntos(totalElegible, config);
  if (puntos <= 0) {
    console.log(`[Rewards] $${totalElegible.toFixed(2)} elegible = 0 puntos — ${folio}`);
    return null;
  }

  // 5. Transacción con lock: cuenta INSCRITA → movimiento → balance.
  //
  // «Comprar no inscribe» (punto 11). Antes, aquí se CREABA la cuenta si no
  // existía: así nacieron las 113 cuentas automáticas de Obispado, la del
  // registro genérico del mostrador incluida (5,846 pts). Ahora la cuenta
  // tiene que existir, estar activa e inscrita; si no, la venta no da puntos
  // y no se crea nada. Como la cuenta ya existe, la fila de `clientes` que
  // exige su FK también existe: aquí ya no hay nada que asegurar.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock de fila para evitar race conditions en lecturas concurrentes
    const cuenta = await resolverCuenta(client, tenantId, tel10, { bloquear: true });
    if (!cuenta || !cuenta.inscrito_at) {
      await client.query('ROLLBACK');
      console.log(`[Rewards] ${cuenta ? 'Cuenta sin inscribir' : 'Cliente no inscrito'} — comprar no inscribe: sin puntos para ${folio}`);
      return null;
    }

    const balanceAnterior  = cuenta.puntos_balance;
    const balancePosterior = balanceAnterior + puntos;

    // Registrar movimiento. El índice único parcial
    // (tenant_id, folio_venta, tipo) WHERE tipo IN ('acumulacion','canje')
    // es la garantía real de "una compra = una acumulación": un webhook
    // repetido, el reconciliador o un reintento no pueden acreditar dos
    // veces. Se declara ON CONFLICT DO NOTHING para que ese caso sea un
    // camino NORMAL y silencioso, en vez de una excepción que aborta la
    // transacción y se pierde en un catch.
    const movimiento = await client.query(
      `INSERT INTO rewards_movements
         (account_id, tenant_id, tipo, puntos, balance_anterior, balance_posterior,
          folio_venta, usuario, motivo, metadata)
       VALUES ($1, $2, 'acumulacion', $3, $4, $5, $6, 'sistema',
               'Acumulación automática por venta', $7)
       ON CONFLICT (tenant_id, folio_venta, tipo)
         WHERE tipo IN ('acumulacion','canje') DO NOTHING`,
      [
        cuenta.id, tenantId, puntos,
        balanceAnterior, balancePosterior,
        folio,
        JSON.stringify({ total_venta: pedido.total, canal, cliente: cuenta.telefono })
      ]
    );

    if (movimiento.rowCount === 0) {
      // Ya se había acreditado esta venta. Se confirma sin tocar el balance:
      // el saldo del cliente no puede moverse dos veces por la misma compra.
      await client.query('COMMIT');
      console.log(`[Rewards] ${folio} ya tenía acumulación — no se acredita de nuevo`);
      return { puntos: 0, balancePosterior: balanceAnterior, telefono, yaAcreditado: true };
    }

    // Actualizar balance del cliente
    await client.query(
      `UPDATE rewards_accounts
       SET puntos_balance = $1,
           puntos_acumulados_total = puntos_acumulados_total + $2,
           updated_at = NOW()
       WHERE id = $3`,
      [balancePosterior, puntos, cuenta.id]
    );

    await client.query('COMMIT');
    console.log(`[Rewards] ✅ ${folio} — ${telefono} +${puntos} pts → balance: ${balancePosterior}`);

    // Notificar al cliente por WhatsApp (fire-and-forget, nunca bloquea la
    // acumulación de puntos, que ya quedó confirmada arriba). Fix de
    // seguridad: antes llamaba a enviarMensaje() sin credenciales, lo que
    // usaba el caché global del motor del bot (mismo mecanismo que causó
    // el incidente de aislamiento de WhatsApp) -- CUALQUIER negocio con
    // Rewards activo habría notificado por el número de Nonna Maye. Ahora
    // se resuelven credenciales propias del negocio vía
    // obtenerCredencialesWhatsappNegocio (el mismo resolvedor ya validado
    // para el envío manual del panel, reutilizado tal cual, sin
    // modificarlo). Sin integración propia verificada, la notificación
    // simplemente se omite -- nunca cae a Nonna Maye ni a ningún caché
    // global, y la acumulación de puntos ya sucedió de todos modos.
    const nivelActual = calcularNivel((cuenta.puntos_acumulados_total || 0) + puntos);
    (async () => {
      const { obtenerCredencialesWhatsappNegocio } = await import('./database.js');
      const credenciales = await obtenerCredencialesWhatsappNegocio(tenantId);
      if (!credenciales) {
        console.log(`[Rewards] Notificación de puntos omitida — sin integración de WhatsApp propia para este negocio (folio ${folio})`);
        return;
      }
      const { enviarMensaje } = await import('../channels/whatsapp-meta.js');
      const msgNivel = nivelActual.siguiente
        ? `Faltan ${nivelActual.falta} pts para llegar a ${nivelActual.siguiente} ${nivelActual.nombre === 'Bronze' ? '🥈' : '🥇'}`
        : '¡Eres miembro Gold! 🏆';
      const msg = `🎉 ¡Ganaste *${puntos} puntos* de ${config.nombre_programa || 'Rewards'}!\n\nTu saldo: *${balancePosterior} pts* ${nivelActual.emoji} ${nivelActual.nombre}\n${msgNivel}`;
      return enviarMensaje(telefono, msg, credenciales);
    })().catch(e => console.error(`[Rewards] Error enviando notificación de puntos (folio ${folio}):`, e.message));

    return { puntos, balancePosterior, telefono };

  } catch (e) {
    await client.query('ROLLBACK');
    // Violación de unique = ya se procesó antes. Silencioso e idempotente.
    if (e.code === '23505') {
      console.log(`[Rewards] Duplicado ignorado — ${folio} ya tenía acumulación`);
      return null;
    }
    // Cualquier otro error: línea estructurada y buscable. La acumulación es
    // idempotente, así que volver a dispararla para ese folio es seguro y es
    // la forma de recuperarla sin tocar la base a mano.
    console.error(`[Rewards] FALLO_ACUMULACION folio=${folio} negocio=${tenantId} cliente=${telefono} code=${e.code || 'sin_code'} constraint=${e.constraint || '-'} :: ${e.message}`);
    throw e;
  } finally {
    client.release();
  }
}

// ─── Estadísticas generales (panel admin) ────────────────────────────────────
/**
 * LAS cifras de Rewards de un negocio (punto 16): la pestaña Rewards y la
 * Lista de Clientes leen esta misma función, así que no pueden diferir.
 *
 * Antes cada pantalla contaba a su manera: Rewards contaba CUENTAS (el mismo
 * número en dos formatos eran dos, y el registro genérico del mostrador era
 * una más) y la Lista contaba clientes ligados. En Obispado salía 113 contra
 * 110, y 10,315 pts contra 4,469: la diferencia exacta eran los 5,846 pts del
 * genérico.
 *
 *   · inscritos / saldoInscritos: personas inscritas (a partir de la fase 3,
 *     las únicas que acumulan) y su saldo.
 *   · sinInscribir / saldoSinInscribir: personas cuya cuenta nació al comprar
 *     antes de esta fase. Conservan su saldo; no acumulan.
 *   · fueraDelPrograma / saldoFuera: cuentas que no son de un cliente (el
 *     registro genérico del mostrador, un teléfono del negocio, un interno).
 *     Se muestran aparte para que no se pierdan, hasta que se anulen.
 *   · puntosEmitidos / puntosCanjeados: lo histórico, del libro de
 *     movimientos tal cual.
 */
export async function cifrasRewards(tenantId) {
  const tid = String(tenantId || '');
  const { rows: [r] } = await pool.query(`
    WITH p AS (${sqlPersonasRewards('$1')})
    SELECT
      (SELECT count(*) FROM p WHERE inscrito)::int                                AS inscritos,
      (SELECT COALESCE(sum(saldo), 0) FROM p WHERE inscrito)::int                 AS saldo_inscritos,
      (SELECT count(*) FROM p WHERE NOT inscrito)::int                            AS sin_inscribir,
      (SELECT COALESCE(sum(saldo), 0) FROM p WHERE NOT inscrito)::int             AS saldo_sin_inscribir,
      (SELECT count(*) FROM rewards_accounts a
        WHERE a.tenant_id = $1 AND a.activo AND NOT (${sqlCuentaVigente('a')}))::int AS fuera,
      (SELECT COALESCE(sum(a.puntos_balance), 0) FROM rewards_accounts a
        WHERE a.tenant_id = $1 AND a.activo AND NOT (${sqlCuentaVigente('a')}))::int AS saldo_fuera,
      (SELECT COALESCE(sum(puntos) FILTER (WHERE tipo = 'acumulacion'), 0)
         FROM rewards_movements WHERE tenant_id = $1)::int                        AS emitidos,
      (SELECT COALESCE(sum(abs(puntos)) FILTER (WHERE tipo = 'canje'), 0)
         FROM rewards_movements WHERE tenant_id = $1)::int                        AS canjeados
  `, [tid]);
  return {
    inscritos: r.inscritos, saldoInscritos: r.saldo_inscritos,
    sinInscribir: r.sin_inscribir, saldoSinInscribir: r.saldo_sin_inscribir,
    fueraDelPrograma: r.fuera, saldoFuera: r.saldo_fuera,
    puntosEmitidos: r.emitidos, puntosCanjeados: r.canjeados,
  };
}

// La forma que el panel ya leía, construida de las cifras únicas.
// `clientes_inscritos` y `saldo_total` son ahora los de los INSCRITOS.
export async function obtenerResumenRewards(tenantId = DEFAULT_TENANT) {
  const c = await cifrasRewards(tenantId);
  return {
    clientes_inscritos: c.inscritos,
    puntos_emitidos:    c.puntosEmitidos,
    puntos_canjeados:   c.puntosCanjeados,
    saldo_total:        c.saldoInscritos,
    sin_inscribir:      c.sinInscribir,
    saldo_sin_inscribir: c.saldoSinInscribir,
    fuera_del_programa: c.fueraDelPrograma,
    saldo_fuera:        c.saldoFuera,
  };
}

// ─── Búsqueda de clientes ─────────────────────────────────────────────────────
// Arranca desde `rewards_accounts` (ya aislada por tenant_id), nunca desde
// `clientes` sin filtrar -- así nunca puede devolver un cliente de otro
// negocio, ni con datos de Rewards ni sin ellos. `clientes` solo aporta
// `ultima_visita` real (uso general, no específico de Rewards) cuando esa
// fila SÍ pertenece a este mismo negocio; si pertenece a otro, se omite
// (nunca se muestra ese dato ajeno).
//
// Por omisión (la caja) solo devuelve cuentas INSCRITAS: asignar en el POS a
// alguien sin inscribir daría una venta que no acumula sin que nadie se
// entere. A esa persona la caja la encuentra por «alta» con su nombre y
// teléfono, que la inscribe conservando sus puntos. `todos` (la pestaña
// Rewards del administrador) incluye además a los «sin inscribir».
export async function buscarClientesRewards(q, tenantId = DEFAULT_TENANT, { todos = false } = {}) {
  const buscar = `%${(q || '').trim()}%`;
  const { rows } = await pool.query(`
    SELECT
      a.telefono, a.nombre,
      CASE WHEN c.negocio_id::text = $1 THEN c.ultima_visita ELSE NULL END AS ultima_visita,
      a.id AS account_id, a.puntos_balance, a.puntos_acumulados_total,
      a.activo AS rewards_activo, a.created_at AS rewards_desde,
      (a.inscrito_at IS NOT NULL) AS inscrito, a.inscrito_at, a.inscripcion_origen
    FROM rewards_accounts a
    LEFT JOIN clientes c ON c.telefono = a.telefono
    WHERE a.tenant_id = $1
      AND (a.nombre ILIKE $2 OR a.telefono ILIKE $2)
      AND ${sqlCuentaVigente('a')}
      ${todos ? '' : 'AND a.inscrito_at IS NOT NULL'}
    ORDER BY a.updated_at DESC NULLS LAST
    LIMIT 20
  `, [tenantId, buscar]);
  return rows;
}

// ─── Lista de clientes de Rewards ─────────────────────────────────────────────
// Una fila por PERSONA, con la misma condición que las cifras: activa,
// identificable, ni del negocio ni interna. Primero los inscritos. El nombre
// es el de la cuenta, o el de la Lista si la cuenta no tiene (las cuentas
// automáticas nacieron sin nombre).
export async function listarClientesRewards(tenantId = DEFAULT_TENANT) {
  const { rows } = await pool.query(`
    WITH p AS (${sqlPersonasRewards('$1')}),
    principal AS (
      SELECT DISTINCT ON (${SQL_TEL10('a')}) ${SQL_TEL10('a')} AS tel10, a.id, a.telefono, a.nombre
        FROM rewards_accounts a
       WHERE a.tenant_id = $1 AND ${sqlCuentaVigente('a')}
       ORDER BY ${SQL_TEL10('a')}, (a.inscrito_at IS NOT NULL) DESC, (a.telefono = ${SQL_TEL10('a')}) DESC, a.created_at, a.id
    )
    SELECT pr.telefono, COALESCE(pr.nombre, cn.nombre) AS nombre,
           pr.id AS account_id, p.saldo AS puntos_balance, p.acumulado AS puntos_acumulados_total,
           TRUE AS rewards_activo, p.alta AS rewards_desde,
           p.inscrito, p.inscrito_at, p.cuentas
      FROM p
      JOIN principal pr ON pr.tel10 = p.tel10
      LEFT JOIN clientes_negocio cn ON cn.negocio_id::text = $1 AND cn.telefono = p.tel10
     ORDER BY p.inscrito DESC, p.saldo DESC, p.tel10
     LIMIT 300
  `, [String(tenantId)]);
  return rows;
}

// ─── Perfil de un cliente ─────────────────────────────────────────────────────
// Arranca desde rewards_accounts (aislada por tenant_id) -- si este
// negocio nunca inscribió ese teléfono, no existe perfil que mostrar,
// sin importar si el teléfono es cliente de otro negocio. "última
// actividad de Rewards" se deriva de la propia cuenta (updated_at),
// nunca de clientes.ultima_visita (ese campo es global entre negocios,
// no específico de Rewards -- ver decisión de producto).
//
// El teléfono exacto gana (la lista manda el de la cuenta); si no hay, la
// cuenta de ese número en otro formato. `inscrito` le dice a la caja si la
// venta va a acumular.
export async function obtenerPerfilRewards(telefono, tenantId = DEFAULT_TENANT) {
  const tel10 = telefonoRewards(telefono);
  const { rows: [perfil] } = await pool.query(`
    SELECT
      a.telefono, a.nombre, a.updated_at AS ultima_actividad_rewards,
      a.id AS account_id, a.puntos_balance, a.puntos_acumulados_total,
      a.puntos_canjeados_total, a.activo AS rewards_activo, a.created_at AS rewards_desde,
      (a.inscrito_at IS NOT NULL) AS inscrito, a.inscrito_at, a.inscripcion_origen
    FROM rewards_accounts a
    WHERE a.tenant_id = $1
      AND (a.telefono = $2 OR ($3::text IS NOT NULL AND ${SQL_CUENTA_IDENTIFICABLE('a')} AND ${SQL_TEL10('a')} = $3))
    ORDER BY (a.telefono = $2) DESC, a.activo DESC, (a.inscrito_at IS NOT NULL) DESC, a.created_at
    LIMIT 1
  `, [tenantId, String(telefono == null ? '' : telefono), tel10]);
  if (!perfil) return null;
  perfil.nivel = calcularNivel(perfil.puntos_acumulados_total);
  return perfil;
}

// ─── Movimientos de un cliente ────────────────────────────────────────────────
// tenantId es defensa en profundidad: el caller (server.js) ya resolvió
// account_id a través de una consulta filtrada por tenant_id, pero esta
// función vuelve a exigirlo explícitamente en su propio WHERE -- nunca
// confía únicamente en que el account_id que le llegó ya fue validado
// aguas arriba.
export async function obtenerMovimientosCliente(accountId, tenantId = DEFAULT_TENANT, limit = 50) {
  const { rows } = await pool.query(`
    SELECT m.id, m.tipo, m.puntos, m.balance_anterior, m.balance_posterior,
           m.folio_venta, m.usuario, m.motivo, m.created_at
    FROM rewards_movements m
    JOIN rewards_accounts a ON a.id = m.account_id
    WHERE m.account_id = $1 AND m.tenant_id = $2 AND a.tenant_id = $2
    ORDER BY m.created_at DESC
    LIMIT $3
  `, [accountId, tenantId, limit]);
  return rows;
}

// ─── Movimientos recientes (panel admin) ─────────────────────────────────────
export async function obtenerMovimientosRecientes(tenantId = DEFAULT_TENANT, limit = 30) {
  const { rows } = await pool.query(`
    SELECT
      m.id, m.tipo, m.puntos, m.balance_posterior,
      m.folio_venta, m.created_at,
      a.nombre, a.telefono
    FROM rewards_movements m
    JOIN rewards_accounts a ON a.id = m.account_id
    WHERE m.tenant_id = $1
    ORDER BY m.created_at DESC
    LIMIT $2
  `, [tenantId, limit]);
  return rows;
}

// ─── Cálculo de bloques disponibles para canje (usado en POS) ────────────────
// Retorna cuántos puntos puede canjear el cliente en bloques de config.canje_minimo
// sin exceder el total de la venta.
export function calcularBloquesDisponibles(puntosBalance, totalVenta, config) {
  if (!config || !config.activo) return { bloques: 0, puntos: 0, valor: 0 };
  const min   = parseInt(config.canje_minimo) || 100;
  const valor = parseFloat(config.puntos_por_peso) || 0.5;
  const valorPorBloque = min * valor;
  if (valorPorBloque <= 0) return { bloques: 0, puntos: 0, valor: 0 };
  const bloquesPorBalance = Math.floor(puntosBalance / min);
  const bloquesPorTotal   = Math.floor(totalVenta / valorPorBloque);
  const bloques = Math.min(bloquesPorBalance, bloquesPorTotal);
  return { bloques, puntos: bloques * min, valor: bloques * valorPorBloque };
}

// ─── Registrar canje en POS ───────────────────────────────────────────────────
// Se llama SINCRÓNICAMENTE cuando el staff confirma un pedido con puntos aplicados.
// Retorna { puntos, monto, balancePosterior } o null si ya fue procesado.
// Lanza error si saldo insuficiente o puntos inválidos — el caller debe manejarlos.
export async function registrarCanje(folio, telefono, puntosACanjear, usuario, tenantId = DEFAULT_TENANT) {
  // 0. Mismo gate de negocio_modulos que acumularPuntos -- el canje
  // también se dispara desde el flujo de pedidos (POS presencial), fuera
  // de las rutas gateadas por requireModulo('rewards').
  const estadoModulo = await obtenerEstadoModulo(tenantId, 'rewards');
  if (!REWARDS_ESTADOS_DISPONIBLES.includes(estadoModulo)) {
    throw new Error('Rewards no está contratado para este negocio');
  }

  const config = await obtenerConfig(tenantId);
  if (!config || !config.activo) throw new Error('Rewards desactivado');

  const min = parseInt(config.canje_minimo) || 100;
  if (puntosACanjear % min !== 0)   throw new Error(`Los puntos deben ser múltiplo de ${min}`);
  if (puntosACanjear <= 0)           throw new Error('Puntos a canjear deben ser positivos');

  const montoCanje = puntosACanjear * parseFloat(config.puntos_por_peso);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // La cuenta de ese número en cualquier formato, y solo si está inscrita:
    // una cuenta «sin inscribir» conserva su saldo pero no lo gasta hasta que
    // la persona se inscriba (decisión de Mario del 23-nov).
    const tel10 = telefonoRewards(telefono);
    const cuenta = tel10 ? await resolverCuenta(client, tenantId, tel10, { bloquear: true }) : null;
    if (!cuenta)                          throw new Error('Cuenta Rewards no encontrada');
    if (!cuenta.inscrito_at)              throw new Error('El cliente no está inscrito en Rewards');
    if (cuenta.puntos_balance < puntosACanjear) throw new Error('Saldo insuficiente');

    const balanceAnterior  = cuenta.puntos_balance;
    const balancePosterior = balanceAnterior - puntosACanjear;

    await client.query(
      `INSERT INTO rewards_movements
         (account_id, tenant_id, tipo, puntos, balance_anterior, balance_posterior,
          folio_venta, usuario, motivo, metadata)
       VALUES ($1, $2, 'canje', $3, $4, $5, $6, $7, 'Canje de puntos en venta', $8)`,
      [
        cuenta.id, tenantId, -puntosACanjear,
        balanceAnterior, balancePosterior,
        folio, usuario || 'operador',
        JSON.stringify({ monto_descuento: montoCanje, puntos_canjeados: puntosACanjear })
      ]
    );

    await client.query(
      `UPDATE rewards_accounts
       SET puntos_balance = $1,
           puntos_canjeados_total = puntos_canjeados_total + $2,
           updated_at = NOW()
       WHERE id = $3`,
      [balancePosterior, puntosACanjear, cuenta.id]
    );

    // El ledger de Rewards es la evidencia del canje, pero el corte también
    // necesita que la venta durable conserve el importe neto y el snapshot
    // del canje. Esto cubre el POS presencial, cuyo pedido ya fue creado
    // antes de consumir puntos. La tienda volverá a estampar los mismos datos
    // de forma idempotente; si el folio ya no está activo (histórico), no se
    // inventa una fila ni se bloquea el canje.
    const { rows: [pedidoActivo] } = await client.query(
      `SELECT datos FROM pedidos_activos
        WHERE folio = $1 AND negocio_id = $2 FOR UPDATE`,
      [folio, tenantId]);
    if (pedidoActivo) {
      const datosPedido = pedidoActivo.datos || {};
      const yaEstampado = datosPedido.rewards_canje != null;
      const totalOriginal = Number(datosPedido.total);
      const totalFinal = yaEstampado || !Number.isFinite(totalOriginal)
        ? totalOriginal
        : Math.max(0, Math.round((totalOriginal - montoCanje) * 100) / 100);
      const descuentos = construirDesgloseDescuentos({
        manual: datosPedido.descuentos?.manual || null,
        promociones: datosPedido.descuentos?.promociones || [],
        rewards: { monto: montoCanje, puntos: puntosACanjear },
      });
      const parche = {
        ...(Number.isFinite(totalFinal) ? { total: totalFinal } : {}),
        rewards_canje: { puntos: puntosACanjear, monto: montoCanje, usuario },
        descuentos,
      };
      await client.query(
        `UPDATE pedidos_activos
            SET datos = datos || $3::jsonb, updated_at = NOW()
          WHERE folio = $1 AND negocio_id = $2`,
        [folio, tenantId, JSON.stringify(parche)]);
    }

    await client.query('COMMIT');
    console.log(`[Rewards] Canje: ${folio} — ${telefono} -${puntosACanjear} pts ($${montoCanje} desc)`);
    return { puntos: puntosACanjear, monto: montoCanje, balancePosterior };

  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') {
      console.log(`[Rewards] Canje duplicado ignorado — ${folio}`);
      return null;
    }
    throw e;
  } finally {
    client.release();
  }
}

// ─── Consultar el canje ya registrado de un folio ────────────────────────────
// Para cobros reintentados (reingeniería UX): registrarCanje es idempotente
// por folio (idx_rewards_movements_no_dup) y devuelve null en el duplicado;
// esta lectura recupera puntos y monto del canje original sin volver a mover
// saldo. Devuelve null si el folio no tiene canje.
export async function obtenerCanjeDeFolio(folio, tenantId = DEFAULT_TENANT) {
  const { rows } = await pool.query(
    `SELECT puntos, metadata, usuario FROM rewards_movements
     WHERE folio_venta = $1 AND tenant_id = $2 AND tipo = 'canje'
     LIMIT 1`,
    [folio, tenantId]
  );
  if (!rows.length) return null;
  const meta = rows[0].metadata || {};
  return {
    puntos: Math.abs(parseInt(rows[0].puntos, 10) || 0),
    monto: parseFloat(meta.monto_descuento) || 0,
    usuario: rows[0].usuario || null,
  };
}

// ─── Revertir movimientos de un folio (al cancelar una venta) ────────────────
// Crea un movimiento tipo 'reverso' por cada movimiento original del folio.
// Fire-and-forget desde el endpoint de cancelación — la cancelación siempre procede.
// El saldo nunca queda en negativo (se recorta a 0).
export async function revertirMovimientosFolio(folio, tenantId = DEFAULT_TENANT) {
  const { rows: movimientos } = await pool.query(
    `SELECT m.*, a.telefono
     FROM rewards_movements m
     JOIN rewards_accounts a ON a.id = m.account_id
     WHERE m.folio_venta = $1 AND m.tenant_id = $2
       AND m.tipo IN ('acumulacion','canje')`,
    [folio, tenantId]
  );

  if (!movimientos.length) {
    console.log(`[Rewards] Sin movimientos que revertir para ${folio}`);
    return null;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const mov of movimientos) {
      // Evitar reverso duplicado por movimiento original
      const { rows: [existeReverso] } = await client.query(
        `SELECT id FROM rewards_movements
         WHERE tenant_id = $1 AND tipo = 'reverso'
           AND metadata->>'movimiento_original_id' = $2`,
        [tenantId, String(mov.id)]
      );
      if (existeReverso) {
        console.log(`[Rewards] Reverso ya existe para mov ${mov.id} — skip`);
        continue;
      }

      const { rows: [cuenta] } = await client.query(
        'SELECT * FROM rewards_accounts WHERE id = $1 FOR UPDATE',
        [mov.account_id]
      );
      if (!cuenta) continue;

      // puntos del movimiento original pueden ser negativos (canje) o positivos (acumulacion)
      const puntosReverso   = -mov.puntos; // invertir el signo
      const balAnterior     = cuenta.puntos_balance;
      const balPosterior    = Math.max(0, balAnterior + puntosReverso);
      const puntosEfectivos = balPosterior - balAnterior;

      await client.query(
        `INSERT INTO rewards_movements
           (account_id, tenant_id, tipo, puntos, balance_anterior, balance_posterior,
            folio_venta, usuario, motivo, metadata)
         VALUES ($1, $2, 'reverso', $3, $4, $5, $6, 'sistema', $7, $8)`,
        [
          cuenta.id, tenantId, puntosEfectivos,
          balAnterior, balPosterior,
          folio,
          `Reverso por cancelación de venta ${folio}`,
          JSON.stringify({ movimiento_original_id: String(mov.id), tipo_original: mov.tipo })
        ]
      );

      await client.query(
        `UPDATE rewards_accounts SET puntos_balance = $1, updated_at = NOW() WHERE id = $2`,
        [balPosterior, cuenta.id]
      );

      // Ajustar acumulados históricos
      if (mov.tipo === 'acumulacion') {
        await client.query(
          `UPDATE rewards_accounts
           SET puntos_acumulados_total = GREATEST(0, puntos_acumulados_total + $1)
           WHERE id = $2`,
          [puntosEfectivos, cuenta.id]
        );
      } else if (mov.tipo === 'canje') {
        // revertir canje devuelve puntos → reduce canjeados_total
        await client.query(
          `UPDATE rewards_accounts
           SET puntos_canjeados_total = GREATEST(0, puntos_canjeados_total - $1)
           WHERE id = $2`,
          [mov.puntos * -1, cuenta.id] // mov.puntos era negativo, negarlo = positivo = lo que se canjeó
        );
      }
    }

    await client.query('COMMIT');
    console.log(`[Rewards] ✅ Reverso completado para ${folio}`);
    return true;

  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`[Rewards] ❌ Error revertiendo ${folio}:`, e.message);
    throw e;
  } finally {
    client.release();
  }
}

// ─── Ajuste manual de puntos (solo admin) ────────────────────────────────────
// tipo: 'ajuste_positivo' | 'ajuste_negativo'
// motivo: obligatorio, se guarda en el movimiento
export async function ajustarPuntosManual(telefono, puntos, tipo, motivo, usuario, tenantId = DEFAULT_TENANT) {
  if (!['ajuste_positivo', 'ajuste_negativo'].includes(tipo)) {
    throw new Error('Tipo de ajuste inválido');
  }
  if (!motivo?.trim()) throw new Error('El motivo es obligatorio');
  puntos = parseInt(puntos);
  if (!puntos || puntos <= 0) throw new Error('Los puntos deben ser un entero positivo');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Teléfono exacto (el de la cuenta que el administrador abrió). Una
    // cuenta dada de baja (anulada o fusionada) no se ajusta a mano: eso lo
    // revierte el script de saneamiento, con su bitácora.
    const { rows: [cuenta] } = await client.query(
      'SELECT * FROM rewards_accounts WHERE telefono = $1 AND tenant_id = $2 FOR UPDATE',
      [telefono, tenantId]
    );
    if (!cuenta) throw new Error('Cuenta Rewards no encontrada');
    if (!cuenta.activo) throw new Error('Esa cuenta de Rewards está dada de baja');

    const delta         = tipo === 'ajuste_positivo' ? puntos : -puntos;
    const balAnterior   = cuenta.puntos_balance;
    const balPosterior  = Math.max(0, balAnterior + delta);

    await client.query(
      `INSERT INTO rewards_movements
         (account_id, tenant_id, tipo, puntos, balance_anterior, balance_posterior,
          folio_venta, usuario, motivo)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8)`,
      [cuenta.id, tenantId, tipo, delta, balAnterior, balPosterior, usuario, motivo.trim()]
    );

    await client.query(
      `UPDATE rewards_accounts SET puntos_balance = $1, updated_at = NOW() WHERE id = $2`,
      [balPosterior, cuenta.id]
    );

    await client.query('COMMIT');
    console.log(`[Rewards] Ajuste manual: ${telefono} ${tipo} ${puntos} pts (${motivo}) por ${usuario}`);
    return { balanceAnterior: balAnterior, balancePosterior: balPosterior };

  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ─── «¿Cuántos puntos tengo?» por WhatsApp ───────────────────────────────────
// La respuesta directa del bot (whatsapp-meta.js solo la manda). Antes decía
// «¡Tu próximo pedido los genera automáticamente!», y lo decía aunque el
// programa estuviera apagado o el negocio ni siquiera tuviera Rewards: desde
// la fase 3 comprar no inscribe, así que eso ya sería falso (decisión de
// Mario del 23-nov: corregir el texto, sin cambiar el flujo del bot).
//
// Siempre devuelve un texto fijo: ninguna de estas respuestas la improvisa
// el modelo.

/**
 * La liga a «Mi cuenta» de la tienda en línea del negocio, donde la persona
 * se inscribe con su teléfono verificado por código. null si el negocio no
 * tiene tienda publicada con cuentas de cliente, o si el servidor no conoce
 * su dirección pública.
 */
export async function ligaMiCuenta(negocioId) {
  const base = String(process.env.XABOR_URL_PUBLICA || process.env.BASE_URL || process.env.PUBLIC_URL || '')
    .trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return null;
  try {
    const { rows: [t] } = await pool.query(
      `SELECT COALESCE(t.slug_publico, n.slug) AS slug
         FROM tienda_config t JOIN negocios n ON n.id = t.negocio_id
        WHERE t.negocio_id::text = $1 AND t.estado = 'publicada' AND t.cuentas_clientes IS TRUE
          AND n.activo AND n.estado IS DISTINCT FROM 'suspendido'`, [String(negocioId)]);
    if (!t?.slug) return null;
    const estado = await obtenerEstadoModulo(negocioId, 'tienda_online');
    if (!['activo', 'contratado'].includes(estado)) return null;
    return `${base}/t/${encodeURIComponent(t.slug)}#mi-cuenta`;
  } catch (e) {
    console.error(`[Rewards] No se pudo armar la liga de Mi cuenta: ${e.message}`);
    return null;
  }
}

export async function textoPuntosWhatsApp(negocioId, telefono) {
  const estado = await obtenerEstadoModulo(negocioId, 'rewards');
  const config = REWARDS_ESTADOS_DISPONIBLES.includes(estado) ? await obtenerConfig(negocioId) : null;
  if (!config) return 'Por ahora no tenemos programa de puntos.';
  const programa = config.nombre_programa || 'nuestro programa de puntos';
  if (!config.activo) return `${programa} está en pausa por ahora. Te avisaremos cuando regrese.`;

  const liga = await ligaMiCuenta(negocioId);
  const donde = liga
    ? `en caja con tu nombre y teléfono, o aquí: ${liga}`
    : 'en caja con tu nombre y teléfono';

  const cuenta = await obtenerCuentaPorTelefono(telefono, negocioId);
  if (cuenta?.inscrito_at) {
    const nivel = calcularNivel(cuenta.puntos_acumulados_total);
    const msgNivel = nivel.siguiente
      ? `Faltan ${nivel.falta} pts para llegar a ${nivel.siguiente} ${nivel.nombre === 'Bronze' ? '🥈' : '🥇'}`
      : '¡Eres miembro Gold! 🏆';
    return `🏆 Tu saldo de ${programa}:\n\n*${cuenta.puntos_balance} puntos* ${nivel.emoji} ${nivel.nombre}\n${msgNivel}\n\nAcumulados en total: ${cuenta.puntos_acumulados_total} pts`;
  }
  if (cuenta && cuenta.puntos_balance > 0) {
    return `Tienes *${cuenta.puntos_balance} puntos* guardados en ${programa}, pero todavía no estás inscrito. Inscríbete gratis ${donde} para usarlos y seguir ganando.`;
  }
  return `Todavía no estás inscrito en ${programa}. Inscríbete gratis ${donde}: así cada compra te da puntos.`;
}
