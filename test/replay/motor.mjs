// ─── EL MOTOR DE REPLAY ───────────────────────────────────────────────────
//
// Corre conversaciones COMPLETAS por el flujo real del agente: el mismo bucle,
// el mismo ejecutor, el mismo reconciliador, el mismo libro de operaciones.
// Lo único que se sustituye es el modelo.
//
// ── Dos modos, y el primero es el que sirve de puerta ────────────────────
//
//   GUION   el fixture trae las llamadas que el modelo haría. Determinista,
//           sin red, sin coste, sin API key. Es lo que mide si XABOR hace bien
//           su trabajo: rechazar lo que no autorizó el cliente, no inventar
//           productos, no confirmar de más, no aplicar dos veces. Estas son
//           las invariantes críticas y tienen que salir a cero SIEMPRE.
//
//   MODELO  el mismo fixture con el modelo de verdad. Mide comprensión: si el
//           modelo llama a las herramientas correctas ante lo que escribe una
//           persona. Cuesta dinero y varía entre corridas; su scorecard es
//           requisito previo al canario.
//
// Que los dos pasen por el MISMO runner es lo que hace que el guion signifique
// algo: no es una simulación del sistema, es el sistema con otro modelo.
import { atenderTurnoConHerramientas } from '../../src/mesero-agente/agenteDelMesero.js';
import { estadoNuevo } from '../../src/mesero-agente/ejecutorDeHerramientas.js';
import { libroDeOperaciones, almacenEnMemoria } from '../../src/mesero-agente/libroDeOperaciones.js';
import { vistaDelPedido } from '../../src/mesero-agente/vistaDelPedido.js';
import { NEGOCIOS, preciosDe, nombresDe, idDe } from './cartas.mjs';

const norm = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Sustituye `$id:Nombre` por el id real de la carta del negocio del fixture.
 *
 * Los fixtures se escriben con nombres porque un fixture con `producto_id: 11`
 * deja de significar nada en cuanto alguien reordena el menú, y lo que se
 * quería probar se pierde sin que ninguna prueba se ponga roja.
 */
function resolverIds(valor, catalogo, vivo) {
  if (typeof valor === 'string') {
    if (valor.startsWith('$id:')) return idDe(catalogo, valor.slice(4));
    // ── LOS QUE SE RESUELVEN EN EL MOMENTO ─────────────────────────────
    //
    // `$linea:2` y `$huella` NO se pueden resolver al cargar el fixture: el
    // linea_id lo genera el carrito y la huella cambia con cada mutación. Se
    // resuelven contra el estado VIVO, justo antes de la llamada, que es
    // exactamente lo que hace el modelo real —los lee del `ver_pedido` que
    // acaba de recibir—. Un fixture que escribiera un lid a mano estaría
    // probando otra cosa.
    if (valor.startsWith('$linea:')) {
      const n = Number(valor.slice(7));
      const l = (vivo?.().lineas || [])[n - 1];
      return l ? l.linea_id : `$linea:${n}:no-existe`;
    }
    if (valor === '$huella') return vivo ? vivo().huella : '$huella';
  }
  if (Array.isArray(valor)) return valor.map((v) => resolverIds(v, catalogo, vivo));
  if (valor && typeof valor === 'object') {
    return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, resolverIds(v, catalogo, vivo)]));
  }
  return valor;
}

/** El modelo de guion: devuelve el paso siguiente con forma de respuesta real. */
function modeloDeGuion(pasos, catalogo, registro, vivo) {
  let i = 0;
  return async () => {
    const paso = pasos[i];
    i += 1;
    if (!paso) {
      // El guion se acabó y el bucle sigue pidiendo. Eso es un fixture mal
      // escrito, y se dice así en vez de colgarse: el turno acaba en texto.
      registro.push({ tipo: 'guion_agotado' });
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: '(guion agotado)' }], usage: null };
    }
    if (paso.texto !== undefined) {
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: paso.texto }], usage: null };
    }
    const tools = (paso.tools || []).map((t, n) => ({
      type: 'tool_use', id: `tu_${i}_${n}`, name: t.name, input: resolverIds(t.input || {}, catalogo, vivo),
    }));
    return { stop_reason: 'tool_use', content: [...(paso.previo ? [{ type: 'text', text: paso.previo }] : []), ...tools], usage: null };
  };
}

/**
 * CORRE UN FIXTURE. Devuelve la conversación entera y los hallazgos.
 *
 * `llamarModeloReal` solo se usa en modo 'modelo'; si no se pasa, el fixture se
 * corre con su guion.
 */
export async function correrFixture(fixture, { modo = 'guion', llamarModeloReal = null, traza = null } = {}) {
  const negocio = NEGOCIOS[fixture.negocio];
  if (!negocio) throw new Error(`el fixture ${fixture.id} pide el negocio "${fixture.negocio}", que no existe`);
  const catalogo = negocio.catalogo;
  const precios = preciosDe(catalogo);
  const requierePago = fixture.requiere_pago !== false;

  const conversacionId = `replay-${fixture.id}`;
  const estado = fixture.estado_inicial
    ? { ...estadoNuevo({ negocioId: negocio.id, conversacionId }), ...fixture.estado_inicial }
    : estadoNuevo({ negocioId: negocio.id, conversacionId });

  const libro = libroDeOperaciones(almacenEnMemoria());
  const historial = [];
  const turnos = [];
  const eventos = [];
  const efectos = {
    confirmar: async ({ pedido }) => {
      eventos.push({ tipo: 'confirmar', pedido: JSON.parse(JSON.stringify(pedido)) });
      return { ok: true, folio: `XAB-R${String(eventos.length).padStart(3, '0')}` };
    },
    escalar: async ({ motivo }) => { eventos.push({ tipo: 'escalar', motivo }); return { ok: true }; },
  };

  // El estado VIVO tal como lo vería el modelo: la misma función que usa el
  // ejecutor, sobre el mismo carrito. Es lo que resuelve los marcadores
  // `$linea:N` y `$huella` de los fixtures.
  const vivo = () => vistaDelPedido({ carrito: estado.carrito, catalogo, precios, requierePago, hechos: estado.hechos });

  let n = 0;
  for (const turno of (fixture.turnos || [])) {
    n += 1;
    // ── EL MISMO MENSAJE DOS VECES ──────────────────────────────────────
    // Un fixture puede marcar `duplicado: true` para que el mensaje entre dos
    // veces con el MISMO turno_id, que es lo que hace Meta cuando reintenta un
    // webhook. Con el mismo turno_id, el libro tiene que atajar las mutaciones.
    const repeticiones = turno.duplicado ? 2 : 1;
    const textoCiclo = [...historial.filter((h) => h.rol === 'user').map((h) => h.texto), turno.cliente]
      .slice(-8).join('\n');

    let salida = null;
    for (let r = 0; r < repeticiones; r += 1) {
      const registro = [];
      const llamarModelo = modo === 'modelo' && llamarModeloReal
        ? llamarModeloReal
        : modeloDeGuion(turno.guion || [], catalogo, registro, vivo);

      salida = await atenderTurnoConHerramientas({
        negocioId: negocio.id,
        conversacionId,
        // El turno_id es del MENSAJE, no de la repetición: es lo que hace que
        // una reentrega de Meta no vuelva a aplicar nada.
        turnoId: `t${n}`,
        mensaje: turno.cliente,
        historial: historial.slice(-12),
        catalogo, precios, requierePago,
        estado, libro, llamarModelo, efectos,
        contexto: {
          nombreNegocio: negocio.nombre,
          textoCiclo,
          estadoRestaurante: fixture.cerrado ? { abierto: false, detalle: 'Abrimos mañana a las 8.' } : null,
        },
        modo: 'replay',
        traza,
        topeIteraciones: fixture.tope_iteraciones ?? 8,
      });
      if (registro.length) salida.avisos = registro;
      // Una reentrega es otra ejecución del mismo turno. Conservar solo la
      // última hacía que una mutación válida de la primera pareciera ocurrir
      // sin herramienta cuando la segunda no cambiaba nada.
      turnos.push({ n, repeticion: r + 1, cliente: turno.cliente, ...salida });
    }

    historial.push({ rol: 'user', texto: turno.cliente });
    if (salida.texto) historial.push({ rol: 'assistant', texto: salida.texto });

    if (estado.hechos.escalado || estado.hechos.cancelado || estado.hechos.fallido) break;
  }

  const operaciones = await libro.operacionesDelTurno({ conversacionId });
  return {
    fixture, negocio, estado, turnos, eventos, operaciones,
    pedidoFinal: turnos.length ? turnos[turnos.length - 1].pedido : null,
    hallazgos: revisarInvariantes({ fixture, negocio, estado, turnos, eventos, operaciones, precios }),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LAS INVARIANTES
//
// Se comprueban en TODOS los fixtures, diga lo que diga cada uno. Un fixture
// que no habla de multiempresa sigue midiendo que no hubo un cruce: una
// invariante que solo se mira donde se espera un fallo no es una invariante.
// ═══════════════════════════════════════════════════════════════════════════

export const CRITICAS = Object.freeze([
  'producto_inventado', 'mutacion_no_autorizada', 'cruce_multiempresa',
  'confirmacion_distinta', 'precio_incorrecto', 'efecto_repetido', 'pedido_duplicado',
]);

function revisarInvariantes({ fixture, negocio, estado, turnos, eventos, operaciones, precios }) {
  const hallazgos = [];
  const anotar = (tipo, detalle) => hallazgos.push({ tipo, critica: CRITICAS.includes(tipo), detalle });

  const propios = nombresDe(negocio.catalogo).map(norm);
  const ajenos = Object.values(NEGOCIOS)
    .filter((x) => x.id !== negocio.id)
    .flatMap((x) => nombresDe(x.catalogo).map(norm));

  // 1. PRODUCTO INVENTADO — un renglón que no está en ninguna carta.
  // 2. CRUCE MULTIEMPRESA — un renglón de la carta de OTRO negocio.
  for (const item of (estado.carrito.items || [])) {
    const nm = norm(item.nombre);
    if (ajenos.includes(nm)) anotar('cruce_multiempresa', `"${item.nombre}" es de otro negocio`);
    else if (!propios.includes(nm)) anotar('producto_inventado', `"${item.nombre}" no está en la carta`);
  }

  // 3. MUTACIÓN NO AUTORIZADA — el pedido cambió en un turno en el que ninguna
  //    herramienta con efecto se aplicó. Es la firma de una autoridad que se
  //    coló por otro lado.
  let anterior = JSON.stringify([]);
  for (const t of turnos) {
    const ahora = JSON.stringify((t.pedido?.lineas || [])
      .map((l) => [l.producto, l.cantidad, l.opciones, l.nota]));
    const hubo = (t.operaciones || []).some((o) => o.resultado?.aplicado === true);
    if (ahora !== anterior && !hubo) {
      anotar('mutacion_no_autorizada', `turno ${t.n}, ejecución ${t.repeticion}: el pedido cambió sin ninguna herramienta aplicada`);
    }
    anterior = ahora;
  }

  // 4. CONFIRMACIÓN DISTINTA — lo que se mandó a la cocina no es lo que hay.
  for (const ev of eventos.filter((e) => e.tipo === 'confirmar')) {
    const mandado = JSON.stringify((ev.pedido.lineas || []).map((l) => [l.producto, l.cantidad, l.opciones]));
    const real = JSON.stringify((estado.carrito.items || []).map((i) => [
      i.nombre, Number(i.cantidad) || 1,
      (i.modificadores || []).flatMap((g) => (g.opciones || [])
        .map((o) => ({ grupo: g.grupo, opcion: typeof o === 'string' ? o : o?.nombre }))),
    ]));
    if (mandado !== real) anotar('confirmacion_distinta', 'lo confirmado no coincide con el pedido real');
  }

  // 5. PRECIO INCORRECTO — el total no es la suma de la carta.
  const final = turnos.length ? turnos[turnos.length - 1].pedido : null;
  if (final && final.total !== null && final.total !== undefined) {
    const suma = (final.lineas || []).reduce((s, l) => s + (precios[l.producto] ?? NaN) * l.cantidad, 0);
    if (!Number.isFinite(suma) || Math.abs(suma - final.total) > 0.001) {
      anotar('precio_incorrecto', `total ${final.total} != suma de la carta ${suma}`);
    }
  }

  // 6. EFECTO REPETIDO — la misma operación ejecutada dos veces de verdad.
  const porClave = new Map();
  for (const o of operaciones) porClave.set(o.operacion_clave, (porClave.get(o.operacion_clave) || 0) + 1);
  for (const [clave, veces] of porClave) {
    if (veces > 1) anotar('efecto_repetido', `la operación ${clave.slice(0, 12)} se registró ${veces} veces`);
  }

  // 7. PEDIDO DUPLICADO — dos confirmaciones en la misma conversación.
  const confirmaciones = eventos.filter((e) => e.tipo === 'confirmar').length;
  if (confirmaciones > 1) anotar('pedido_duplicado', `${confirmaciones} confirmaciones en una conversación`);

  return hallazgos;
}

// ═══════════════════════════════════════════════════════════════════════════
// LO QUE EL FIXTURE ESPERA
// ═══════════════════════════════════════════════════════════════════════════

const opcionesDe = (l) => (l.opciones || []).map((o) => `${norm(o.grupo)}=${norm(o.opcion)}`).sort();

// La carta usa texto libre para la modalidad. El contrato operativo distingue
// recoger y domicilio; esas variantes expresan la misma entrega al cliente.
function modalidadComparable(valor) {
  const v = norm(valor);
  if (v === 'domicilio' || v === 'a domicilio' || v === 'entrega a domicilio') return 'domicilio';
  if (v === 'recoger' || v === 'para recoger' || v === 'recoger en tienda') return 'recoger';
  return v;
}

function cantidadesPorProductoYOpciones(lineas) {
  const cantidades = new Map();
  for (const linea of lineas) {
    const clave = JSON.stringify([norm(linea.producto), opcionesDe(linea)]);
    cantidades.set(clave, (cantidades.get(clave) || 0) + (linea.cantidad ?? 1));
  }
  return [...cantidades.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function comparar(corrida) {
  const esperado = corrida.fixture.esperado || {};
  const pedido = corrida.pedidoFinal;
  const fallos = [];

  if (esperado.estado !== undefined && pedido?.estado !== esperado.estado) {
    fallos.push(`estado: esperaba "${esperado.estado}", quedó "${pedido?.estado}"`);
  }
  if (esperado.confirmado !== undefined && !!corrida.estado.hechos.confirmado !== esperado.confirmado) {
    fallos.push(`confirmado: esperaba ${esperado.confirmado}, fue ${!!corrida.estado.hechos.confirmado}`);
  }
  if (esperado.escalado !== undefined && !!corrida.estado.hechos.escalado !== esperado.escalado) {
    fallos.push(`escalado: esperaba ${esperado.escalado}, fue ${!!corrida.estado.hechos.escalado}`);
  }
  if (esperado.cancelado !== undefined && !!corrida.estado.hechos.cancelado !== esperado.cancelado) {
    fallos.push(`cancelado: esperaba ${esperado.cancelado}, fue ${!!corrida.estado.hechos.cancelado}`);
  }
  if (esperado.modalidad !== undefined
    && modalidadComparable(pedido?.modalidad) !== modalidadComparable(esperado.modalidad)) {
    fallos.push(`modalidad: esperaba ${JSON.stringify(esperado.modalidad)}, fue ${JSON.stringify(pedido?.modalidad ?? null)}`);
  }
  if (esperado.pago !== undefined && (pedido?.forma_pago ?? null) !== esperado.pago) {
    fallos.push(`pago: esperaba ${JSON.stringify(esperado.pago)}, fue ${JSON.stringify(pedido?.forma_pago ?? null)}`);
  }
  if (esperado.total !== undefined && (pedido?.total ?? null) !== esperado.total) {
    fallos.push(`total: esperaba ${esperado.total}, fue ${pedido?.total ?? null}`);
  }

  if (esperado.lineas !== undefined) {
    const real = cantidadesPorProductoYOpciones(pedido?.lineas || []);
    const quiere = cantidadesPorProductoYOpciones(esperado.lineas);
    if (JSON.stringify(real) !== JSON.stringify(quiere)) {
      fallos.push(`renglones: esperaba ${JSON.stringify(quiere)}, hubo ${JSON.stringify(real)}`);
    }
  }

  const usadas = corrida.turnos.flatMap((t) => (t.operaciones || []).map((o) => o.herramienta));
  for (const h of (corrida.fixture.herramientas_esperadas || [])) {
    if (!usadas.includes(h)) fallos.push(`no se usó la herramienta esperada: ${h}`);
  }
  for (const h of (corrida.fixture.no_debe || [])) {
    // `no_debe` mira lo que se APLICÓ, no lo que se intentó: un intento
    // bloqueado es precisamente el sistema funcionando.
    const aplicada = corrida.turnos.flatMap((t) => t.operaciones || [])
      .some((o) => o.herramienta === h && o.resultado?.aplicado === true);
    if (aplicada) fallos.push(`se aplicó una herramienta prohibida en este caso: ${h}`);
  }

  return fallos;
}
