// ─── EL CONTRATO CON EL MODELO ────────────────────────────────────────────
//
// Esto es lo único que el modelo puede pedirle a Xabor. No hay otra puerta:
// el texto que el modelo escribe se le manda al cliente tal cual, y cualquier
// efecto sobre el pedido pasa obligatoriamente por una de estas herramientas.
//
// ── Qué cambia respecto del contrato anterior ────────────────────────────
//
// Antes el modelo emitía un PEDIDO ENTERO dentro de `<ORDEN_PREVIEW>` y el
// backend tenía que deducir por diferencia qué había querido cambiar. Eso es
// un diff contra un estado probabilístico: si el modelo se olvidaba de un
// renglón, el sistema no podía distinguir «lo quitó» de «no lo escribió».
//
// Aquí el modelo dice OPERACIONES, una por una, y cada una vuelve con el
// resultado REAL de haberla intentado. No hay estado imaginado que reconciliar.
//
// ── Lo que estas herramientas NO pueden hacer ────────────────────────────
//
//   · inventar un producto      `agregar_producto` exige un `producto_id` que
//                               solo puede salir de `buscar_producto`, y el
//                               ejecutor lo vuelve a comprobar contra la carta
//   · inventar un modificador   las opciones se validan contra los grupos
//                               reales del producto real
//   · confirmar a ciegas        `confirmar_pedido` exige la huella del resumen
//                               que el cliente leyó; si el pedido cambió desde
//                               entonces, la huella no coincide y no confirma
//   · autorizarse solo          TODA mutación sigue pasando por `reconciliar`,
//                               que exige evidencia en lo que DIJO el cliente
//
// ── Una sola fuente para el esquema ──────────────────────────────────────
//
// El esquema Zod es el original y el JSON Schema que ve el modelo se deriva de
// él (`jsonSchemaDe`). Escribir los dos a mano es cómo se acaba con un
// validador que exige un campo que el modelo nunca supo que existía.
import { z } from 'zod';

// ── Conversión Zod -> JSON Schema, del subconjunto que aquí se usa ───────
//
// No se instala `zod-to-json-schema`: soporta el estándar entero y aquí hacen
// falta seis tipos. Lo que sí hace falta es que no haya dos definiciones.
function desenvolver(tipo) {
  let t = tipo;
  let opcional = false;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const n = t?._def?.typeName;
    if (n === 'ZodOptional' || n === 'ZodNullable' || n === 'ZodDefault') {
      opcional = opcional || n === 'ZodOptional' || n === 'ZodDefault';
      t = t._def.innerType;
    } else if (n === 'ZodEffects') {
      t = t._def.schema;
    } else break;
  }
  return { tipo: t, opcional };
}

export function jsonSchemaDe(esquema) {
  const { tipo } = desenvolver(esquema);
  const nombre = tipo?._def?.typeName;
  const descripcion = tipo?.description ? { description: tipo.description } : {};

  if (nombre === 'ZodObject') {
    const forma = tipo._def.shape();
    const properties = {};
    const required = [];
    for (const [clave, valor] of Object.entries(forma)) {
      const { opcional } = desenvolver(valor);
      properties[clave] = jsonSchemaDe(valor);
      if (!opcional) required.push(clave);
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}),
      additionalProperties: false, ...descripcion };
  }
  if (nombre === 'ZodArray') return { type: 'array', items: jsonSchemaDe(tipo._def.type), ...descripcion };
  if (nombre === 'ZodEnum') return { type: 'string', enum: [...tipo._def.values], ...descripcion };
  if (nombre === 'ZodNumber') {
    const checks = tipo._def.checks || [];
    const entero = checks.some((c) => c.kind === 'int');
    const min = checks.find((c) => c.kind === 'min');
    const max = checks.find((c) => c.kind === 'max');
    return { type: entero ? 'integer' : 'number',
      ...(min ? { minimum: min.value } : {}), ...(max ? { maximum: max.value } : {}), ...descripcion };
  }
  if (nombre === 'ZodBoolean') return { type: 'boolean', ...descripcion };
  return { type: 'string', ...descripcion };
}

// ── Piezas compartidas ───────────────────────────────────────────────────

const OpcionElegida = z.object({
  grupo: z.string().min(1).describe('Nombre exacto del grupo, tal como lo devolvió ver_opciones_producto'),
  opcion: z.string().min(1).describe('Nombre exacto de la opción, tal como lo devolvió ver_opciones_producto'),
}).strict();

const cantidad = z.number().int().min(1).max(99)
  .describe('Cuántas unidades. Usa 1 para "un", "una", "unos" o una orden singular; una cantidad mayor necesita respaldo explícito del cliente.');

// ── LAS HERRAMIENTAS ─────────────────────────────────────────────────────
//
// `efecto: true` significa que puede cambiar el pedido. Esas —y solo esas—
// pasan por el libro de operaciones y son idempotentes por clave de operación.

export const HERRAMIENTAS = Object.freeze([
  {
    nombre: 'ver_pedido',
    efecto: false,
    descripcion: 'Lee el pedido REAL tal como está ahora: renglones con su identificador, '
      + 'opciones elegidas, modalidad, pago, total, qué falta y qué está sin aclarar. '
      + 'Úsala cuando necesites saber en qué punto va el pedido. Nunca supongas el contenido del pedido.',
    esquema: z.object({}).strict(),
  },
  {
    nombre: 'buscar_producto',
    efecto: false,
    descripcion: 'Busca en la carta REAL del negocio lo que el cliente nombró. Devuelve los productos '
      + 'que la carta puede sostener, con su producto_id. Si devuelve varios, el cliente no ha dicho '
      + 'todavía cuál es y hay que preguntarle. Si devuelve ninguno, ese producto NO existe: dilo, '
      + 'no lo sustituyas por otro. Con el texto vacío devuelve las categorías de la carta.',
    esquema: z.object({
      texto: z.string().describe('Lo que el cliente dijo, con sus palabras. Vacío para ver las categorías.'),
      categoria: z.string().optional().describe('Acota la búsqueda a una categoría de la carta.'),
    }).strict(),
  },
  {
    nombre: 'ver_opciones_producto',
    efecto: false,
    descripcion: 'Los grupos de opciones REALES de un producto (tipo de huevo, salsa, guarnición…), '
      + 'con cuántas admite cada grupo y cuáles son obligatorias. Úsala antes de agregar un producto '
      + 'que tenga opciones obligatorias, para saber qué preguntar.',
    esquema: z.object({
      producto_id: z.string().min(1).describe('El producto_id que devolvió buscar_producto.'),
    }).strict(),
  },
  {
    nombre: 'agregar_producto',
    efecto: true,
    descripcion: 'Agrega un renglón al pedido. El producto_id TIENE que venir de buscar_producto; '
      + 'no lo inventes ni lo deduzcas. Las opciones tienen que existir en ese producto. '
      + 'Si el cliente pidió el producto, agrégalo sin pedirle otro permiso. Puedes dejar opciones '
      + 'obligatorias pendientes y preguntarlas después. El resultado dice si se aplicó de verdad: '
      + 'si dice que no, NO le digas al cliente que ya está.',
    esquema: z.object({
      producto_id: z.string().min(1).describe('El producto_id que devolvió buscar_producto.'),
      cantidad: cantidad.default(1),
      opciones: z.array(OpcionElegida).optional()
        .describe('Las opciones que el cliente eligió. Solo las que dijo.'),
      nota: z.string().max(200).optional().describe('Indicación del cliente para la cocina.'),
    }).strict(),
  },
  {
    nombre: 'modificar_linea',
    efecto: true,
    descripcion: 'Cambia un renglón que YA está en el pedido: su cantidad, sus opciones o su nota. '
      + 'El linea_id viene de ver_pedido. Manda solo los campos que cambian.',
    esquema: z.object({
      linea_id: z.string().min(1).describe('El linea_id que devolvió ver_pedido.'),
      cantidad: cantidad.optional(),
      opciones: z.array(OpcionElegida).optional()
        .describe('Sustituye las opciones de los grupos que menciones. Los demás grupos no se tocan.'),
      sin_opciones: z.array(z.string().min(1)).optional()
        .describe('Nombres de grupos que el cliente quiere QUITAR ("sin fruta", "sin huevo"). '
          + 'Si el grupo era obligatorio, el renglón quedará pendiente de elegir otra cosa y habrá que preguntársela.'),
      nota: z.string().max(200).optional(),
    }).strict(),
  },
  {
    nombre: 'quitar_linea',
    efecto: true,
    descripcion: 'Quita un renglón del pedido. Solo cuando el cliente pidió quitarlo.',
    esquema: z.object({
      linea_id: z.string().min(1).describe('El linea_id que devolvió ver_pedido.'),
    }).strict(),
  },
  {
    nombre: 'definir_entrega',
    efecto: true,
    descripcion: 'Registra cómo se entrega el pedido y, si es a domicilio, dónde. '
      + 'Un pedido a domicilio no queda listo para confirmar sin dirección. '
      + 'Si el cliente cambia la modalidad, llama a esta herramienta antes de decir que cambió. '
      + 'La configuración real del negocio puede rechazar una modalidad; si ocurre, ofrece únicamente '
      + 'las alternativas devueltas. Manda modalidad, dirección, o las dos.',
    esquema: z.object({
      modalidad: z.string().min(1).optional()
        .describe('Tal como el negocio la llama, usando solo una modalidad disponible.'),
      direccion: z.string().min(1).optional().describe('La dirección completa que dio el cliente.'),
      referencias: z.string().max(200).optional().describe('Entre qué calles, color de la casa…'),
      zona_entrega: z.string().min(1).optional()
        .describe('Nombre EXACTO de una zona configurada, solo si el cliente la mencionó en su mensaje o dirección.'),
    }).strict().refine((v) => v.modalidad || v.direccion || v.referencias || v.zona_entrega,
      { message: 'definir_entrega necesita al menos modalidad, direccion, referencias o zona_entrega' }),
  },
  {
    nombre: 'definir_pago',
    efecto: true,
    descripcion: 'Registra con qué va a pagar el cliente. Solo cuando lo dijo o cuando aceptó explícitamente '
      + 'el método que el pedido muestra como ofrecido. La configuración real del negocio puede rechazarlo; '
      + 'si ocurre, explica el motivo y ofrece únicamente la alternativa devuelta.',
    esquema: z.object({
      forma_pago: z.string().min(1).describe('"efectivo", "tarjeta", "transferencia"… como lo dijo el cliente.'),
      paga_con: z.number().optional().describe('Con cuánto paga, si lo dijo, para calcular el cambio.'),
    }).strict(),
  },
  {
    nombre: 'definir_cliente',
    efecto: true,
    descripcion: 'Registra el nombre del cliente cuando lo dice. El teléfono ya lo tiene Xabor: no lo preguntes.',
    esquema: z.object({
      nombre: z.string().min(1).max(80).describe('El nombre que dio el cliente.'),
    }).strict(),
  },
  {
    nombre: 'cancelar_pedido',
    efecto: true,
    descripcion: 'Vacía el pedido en curso porque el cliente ya no lo quiere. No se usa para quitar '
      + 'un renglón —para eso está quitar_linea— ni para un pedido ya confirmado. '
      + 'Úsala también si cancela antes de haber agregado un renglón.',
    esquema: z.object({
      motivo: z.string().min(1).max(200).describe('Qué dijo el cliente para cancelar.'),
    }).strict(),
  },
  {
    nombre: 'confirmar_pedido',
    efecto: true,
    descripcion: 'Cierra el pedido y lo manda a la cocina. Solo después de haberle mostrado al cliente '
      + 'el resumen que devuelve ver_pedido y de que él haya dicho que sí. '
      + 'La huella tiene que ser la del resumen que el cliente LEYÓ: si el pedido cambió desde entonces, '
      + 'no confirma, y hay que volver a mostrar el resumen. Si la forma de pago es enlace de pago, '
      + 'el resultado trae la URL real que debes copiar exactamente en la respuesta.',
    esquema: z.object({
      huella_resumen: z.string().min(1)
        .describe('El campo "huella" del último ver_pedido que le mostraste al cliente.'),
    }).strict(),
  },
  {
    nombre: 'pedir_humano',
    efecto: true,
    descripcion: 'Pasa la conversación a una persona del negocio. Úsala si el cliente lo pide, si se queja, '
      + 'si quiere cambiar un pedido ya confirmado, si hay un problema con un pedido anterior, '
      + 'o si llevas dos intentos sin poder resolver lo mismo.',
    esquema: z.object({
      motivo: z.string().min(1).max(200).describe('Por qué hace falta una persona.'),
    }).strict(),
  },
]);

export const PORNOMBRE = Object.freeze(Object.fromEntries(HERRAMIENTAS.map((h) => [h.nombre, h])));
export const NOMBRES = Object.freeze(HERRAMIENTAS.map((h) => h.nombre));
export const CON_EFECTO = Object.freeze(HERRAMIENTAS.filter((h) => h.efecto).map((h) => h.nombre));

/** Las definiciones tal como las pide la API de Anthropic. */
export const definicionesParaElModelo = () => HERRAMIENTAS.map((h) => ({
  name: h.nombre,
  description: h.descripcion,
  input_schema: jsonSchemaDe(h.esquema),
}));

/**
 * VALIDA los argumentos de una llamada. Nunca lanza.
 *
 * Devuelve `{ ok, valor, error }`. Un `ok:false` NO es un fallo del sistema:
 * es una llamada mal formada del modelo, y el agente se la devuelve como
 * `tool_result` con `is_error` para que la corrija. Es la diferencia entre un
 * modelo que se equivoca y un pedido que se estropea.
 */
export function validarArgumentos(nombre, argumentos) {
  const h = PORNOMBRE[nombre];
  if (!h) return { ok: false, valor: null, error: `herramienta_desconocida: ${nombre}` };
  const r = h.esquema.safeParse(argumentos ?? {});
  if (r.success) return { ok: true, valor: r.data, error: null };
  const detalle = r.error.issues
    .map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`).join('; ');
  return { ok: false, valor: null, error: `argumentos_invalidos: ${detalle}` };
}

export const tieneEfecto = (nombre) => !!PORNOMBRE[nombre]?.efecto;
