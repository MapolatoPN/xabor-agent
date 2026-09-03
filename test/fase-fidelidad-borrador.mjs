// FIDELIDAD DEL BORRADOR — pruebas END TO END contra brain.js.
//
// Por qué existe esta suite y no bastaba la anterior: fase-validacion-
// conversacional-catalogo.mjs llama a `validarBorradorPedido()` DIRECTAMENTE,
// pasándole un borrador que ya contiene lo que el cliente pidió. Eso prueba que
// la función no pierde lo que le entregan, pero asume justo lo que estaba en
// duda: que el primer modelo entregue fielmente lo que el cliente dijo.
//
// Aquí el primer modelo está MOCKEADO y se le hace mentir a propósito:
//   F1  omite el atributo que el cliente pidió
//   F2  lo sustituye por otro que sí existe en el menú
//   F3  emite un marcador sintácticamente válido pero vacío
// En los tres casos la selección comercial del cliente desaparecía en silencio.
//
// El resto cubre lo que NO debe romperse al cerrarlos: provenance legítimo (F4),
// frontera entre pedidos (F5), logística y cortesía (F6), notas de preparación
// (F7), consultas que no mutan (F8), prioridad del mensaje (F9) y corrección
// explícita posterior (F10).
//
// Multi-tenant: fixture genérico (sin negocio, producto ni sabor reales) — los
// invariantes valen igual para pizzas, café o hamburguesas.
//
// Uso: DATABASE_URL=... PANEL_SECRET=... ADMIN_PASSWORD=... SESSION_SECRET=...
//      INTEGRATIONS_ENCRYPTION_KEY=... node test/fase-fidelidad-borrador.mjs
import assert from 'assert';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';

// El SDK lee ANTHROPIC_BASE_URL del entorno: hay que fijarlo ANTES de que
// brain.js construya su cliente (lo hace perezosamente, en la primera llamada).
const mock = await arrancarAnthropicMock();
process.env.ANTHROPIC_BASE_URL = mock.baseUrl;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-fidelidad';
process.env.PORT = process.env.PORT || '4187';

const { pool } = await import('../src/services/database.js');
const { procesarMensaje } = await import('../src/agent/brain.js');
const { getSession, deleteSession, iniciarCicloPedido, verPreviewPedido } = await import('../src/agent/session.js');
const { depurarMenciones, tieneRespaldo } = await import('../src/agent/mencionesComerciales.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ── Fixture ────────────────────────────────────────────────────────────────
const q1 = async (sql, params) => (await pool.query(sql, params)).rows[0];
const NEG = (await q1(
  `INSERT INTO negocios (nombre, slug) VALUES ('Fidelidad Borrador','fidelidad-borrador')
   ON CONFLICT (slug) DO UPDATE SET nombre='Fidelidad Borrador' RETURNING id`)).id;
for (const tabla of ['menu_modificadores_opciones', 'menu_modificadores_grupos', 'menu_productos', 'menu_categorias']) {
  await pool.query(`DELETE FROM ${tabla} WHERE negocio_id=$1`, [NEG]).catch(() => {});
}
const cat = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden) VALUES ($1,'GENERAL',0) RETURNING id`, [NEG])).id;
const BEBIDA = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Bebida Preparada',55) RETURNING id`, [NEG, cat])).id;
const grupo = async (prod, nombre, { requerido = false, minimo = 0, maximo = 0 } = {}) => (await q1(
  `INSERT INTO menu_modificadores_grupos (negocio_id,producto_id,nombre,requerido,minimo,maximo,orden)
   VALUES ($1,$2,$3,$4,$5,$6,0) RETURNING id`, [NEG, prod, nombre, requerido, minimo, maximo])).id;
const op = async (gid, nombre, extra = 0) => (await q1(
  `INSERT INTO menu_modificadores_opciones (negocio_id,grupo_id,nombre,precio_extra,disponible,orden)
   VALUES ($1,$2,$3,$4,TRUE,0) RETURNING id`, [NEG, gid, nombre, extra])).id;

const gVariante = await grupo(BEBIDA, 'Variante', { requerido: true, minimo: 1, maximo: 1 });
for (const v of ['Alfa', 'Beta', 'Gamma', 'Delta']) await op(gVariante, v);
const gTamano = await grupo(BEBIDA, 'Tamaño', { requerido: true, minimo: 1, maximo: 1 });
await op(gTamano, 'Chico'); await op(gTamano, 'Grande', 20);
const gLiquido = await grupo(BEBIDA, 'Líquido', { requerido: true, minimo: 1, maximo: 1 });
await op(gLiquido, 'Tipo Uno'); await op(gLiquido, 'Tipo Dos');

// Producto con opciones de VARIAS PALABRAS — el caso que faltaba y que dejó
// pasar el defecto real: el cliente abrevia ("grande" por "Grande 1 Litro").
// El fixture anterior solo tenía opciones de una palabra, así que toda mención
// o casaba exacto o no casaba con nada: el caso intermedio nunca se ejercitó.
const OTRO = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Refresco',70) RETURNING id`, [NEG, cat])).id;
const gMedida = await grupo(OTRO, 'Medida', { requerido: true, minimo: 1, maximo: 1 });
await op(gMedida, 'Chico'); await op(gMedida, 'Grande 1 Litro');
const AMBIG = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Refresco Doble',80) RETURNING id`, [NEG, cat])).id;
const gDoble = await grupo(AMBIG, 'Medida', { requerido: true, minimo: 1, maximo: 1 });
await op(gDoble, 'Grande 1 Litro'); await op(gDoble, 'Grande 2 Litros');

// ── Utilidades de mock ─────────────────────────────────────────────────────
const PROD = 'Bebida Preparada';
const borradorLLM = (mods, extra = {}) => `Con gusto.\n<PEDIDO_BORRADOR>${JSON.stringify({
  items: [{ nombre: PROD, cantidad: 1, modificadores: mods, ...extra }],
})}</PEDIDO_BORRADOR>`;
const menciones = (...ms) => JSON.stringify({ menciones: ms });
const atributo = (texto) => ({ tipo: 'atributo', texto_fuente: texto });
const producto = (texto) => ({ tipo: 'producto', texto_fuente: texto });

// Captura los eventos [TXN] del turno: son la evidencia observable de que el
// backend descartó algo, no una inspección de estado interno.
async function turno(sessionId, mensaje) {
  const eventos = [];
  const warn = console.warn;
  console.warn = (...a) => { eventos.push(a.join(' ')); };
  try {
    const r = await procesarMensaje(sessionId, mensaje, null, 'whatsapp', NEG, null);
    return { ...r, eventos };
  } finally { console.warn = warn; }
}

// ═══ F1 — el borrador OMITE lo que el cliente pidió ════════════════════════
const MSG_OMEGA = 'quiero una bebida preparada de omega grande';
let f1;
await t('F1. el atributo que el borrador omitió NO desaparece: se valida contra el catálogo', async () => {
  deleteSession('f1');
  mock.encolarRespuesta(borradorLLM([{ grupo: 'Tamaño', opciones: ['Grande'] }]));
  mock.encolarRespuesta(menciones(producto('bebida preparada'), atributo('omega'), atributo('grande')));
  f1 = await turno('f1', MSG_OMEGA);
  assert.match(f1.texto, /omega/i, `"omega" no puede desaparecer del turno: ${f1.texto}`);
  assert.match(f1.texto, /Alfa, Beta, Gamma y Delta/,
    `hay que ofrecer las variantes REALES del catálogo: ${f1.texto}`);
  assert.match(f1.texto, /omega/i, `"omega" no puede desaparecer: ${f1.texto}`);
});

// ═══ F9 — prioridad: lo inexistente antes que lo que falta ════════════════
await t('F9. la mención imposible tiene prioridad sobre el grupo requerido faltante', () => {
  // El invariante NO es que calle lo que falta —preguntarlo es útil— sino que
  // lo IMPOSIBLE vaya primero: nunca se puede fingir que el cliente no lo dijo.
  assert.match(f1.texto, /^Una disculpa: no manejamos "omega"/,
    `la mención imposible tiene que ENCABEZAR el mensaje: ${f1.texto}`);
  assert.ok(f1.texto.indexOf('omega') < f1.texto.indexOf('falta'),
    `lo que falta va DESPUÉS de lo que no existe: ${f1.texto}`);
});

// ═══ F10 — el cliente corrige explícitamente ══════════════════════════════
await t('F10. tras corregir a una variante real, esa sí obtiene respaldo y pasa a faltar el resto', async () => {
  mock.encolarRespuesta(borradorLLM([
    { grupo: 'Variante', opciones: ['Beta'] }, { grupo: 'Tamaño', opciones: ['Grande'] },
  ]));
  mock.encolarRespuesta(menciones(atributo('beta')));
  const r = await turno('f1', 'mejor de beta');
  assert.doesNotMatch(r.texto, /omega/i, `"omega" quedó superado por la corrección: ${r.texto}`);
  assert.match(r.texto, /falta saber/i, `ahora sí toca preguntar lo que falta: ${r.texto}`);
  assert.match(r.texto, /l[ií]quido/i, `lo que falta es el grupo requerido pendiente: ${r.texto}`);
  // "Grande" viene del turno ANTERIOR del mismo ciclo: el respaldo es del ciclo,
  // no solo del último mensaje.
  assert.doesNotMatch(r.texto, /tama[ñn]o/i, `Tamaño ya estaba elegido en este ciclo: ${r.texto}`);
});

// ═══ F2 — el borrador SUSTITUYE lo que el cliente pidió ═══════════════════
await t('F2. una selección que el cliente nunca expresó NO se acepta (SELECCION_SIN_RESPALDO)', async () => {
  deleteSession('f2');
  mock.encolarRespuesta(borradorLLM([
    { grupo: 'Variante', opciones: ['Beta'] },
    { grupo: 'Tamaño', opciones: ['Grande'] },
    { grupo: 'Líquido', opciones: ['Tipo Uno'] },
  ]));
  // El extractor también miente: inventa "beta", que el cliente jamás escribió.
  mock.encolarRespuesta(menciones(atributo('beta'), atributo('omega'), atributo('grande')));
  const r = await turno('f2', MSG_OMEGA);
  assert.match(r.texto, /no manejamos "omega"/i, `hay que decir la verdad sobre omega: ${r.texto}`);
  const sinRespaldo = r.eventos.find((e) => e.includes('seleccion_sin_respaldo'));
  assert.ok(sinRespaldo, `Beta y Tipo Uno debieron descartarse por falta de respaldo: ${JSON.stringify(r.eventos)}`);
  assert.match(sinRespaldo, /Variante:Beta/, `la sustitución concreta debe quedar registrada: ${sinRespaldo}`);
  // El código viaja hasta el log, no solo dentro de la estructura: es lo que
  // hace rastreable el descarte en producción.
  assert.match(sinRespaldo, /codigo=SELECCION_SIN_RESPALDO/, sinRespaldo);
  assert.strictEqual(verPreviewPedido('f2'), null, 'una sustitución jamás puede terminar en un preview');
});

await t('F2b. el extractor NO puede inventar un span: "beta" no está en el mensaje y se descarta', async () => {
  deleteSession('f2b');
  mock.encolarRespuesta(borradorLLM([{ grupo: 'Tamaño', opciones: ['Grande'] }]));
  mock.encolarRespuesta(menciones(atributo('beta'), atributo('omega')));
  const r = await turno('f2b', MSG_OMEGA);
  const descartada = r.eventos.find((e) => e.includes('mencion_descartada'));
  assert.ok(descartada, `el span inventado debe registrarse como descartado: ${JSON.stringify(r.eventos)}`);
  assert.match(descartada, /span_inexistente/, descartada);
  const bloqueo = r.eventos.find((e) => e.includes('catalogo_conversacional_bloqueado'));
  assert.ok(bloqueo && /codigos=\["MENCION_NO_RESUELTA"\]/.test(bloqueo),
    `el código de la mención no resuelta debe quedar en el log: ${bloqueo}`);
  assert.match(descartada, /beta/i, `el descartado es el inventado, no el real: ${descartada}`);
  assert.match(r.texto, /omega/i, 'la mención verdadera sí sobrevive');
});

// ═══ F3 — marcador presente pero VACÍO ════════════════════════════════════
await t('F3. un <PEDIDO_BORRADOR> vacío NO desactiva la extracción independiente', async () => {
  deleteSession('f3');
  mock.encolarRespuesta('Claro que sí.\n<PEDIDO_BORRADOR>{"items":[]}</PEDIDO_BORRADOR>');
  // Extracción forzada del borrador (antes ni siquiera se llamaba).
  mock.encolarRespuesta(JSON.stringify({ items: [{ nombre: PROD, cantidad: 1, modificadores: [{ grupo: 'Tamaño', opciones: ['Grande'] }] }] }));
  mock.encolarRespuesta(menciones(producto('bebida preparada'), atributo('omega'), atributo('grande')));
  const r = await turno('f3', MSG_OMEGA);
  assert.match(r.texto, /no manejamos "omega"/i, `un marcador vacío no puede ser una vía de escape: ${r.texto}`);
  assert.strictEqual(mock.pendientes(), 0, 'debieron consumirse las tres llamadas (principal + borrador forzado + menciones)');
});

// ═══ F4 — provenance legítimo ═════════════════════════════════════════════
await t('F4. una selección que el cliente SÍ expresó se acepta sin corrección', async () => {
  deleteSession('f4');
  mock.encolarRespuesta(borradorLLM([
    { grupo: 'Variante', opciones: ['Alfa'] },
    { grupo: 'Tamaño', opciones: ['Chico'] },
    { grupo: 'Líquido', opciones: ['Tipo Uno'] },
  ]));
  mock.encolarRespuesta(menciones(producto('bebida preparada'), atributo('alfa'), atributo('chico'), atributo('tipo uno')));
  const r = await turno('f4', 'quiero una bebida preparada alfa chico de tipo uno');
  assert.match(r.texto, /Con gusto/, `el texto del modelo sobrevive cuando todo tiene respaldo: ${r.texto}`);
  assert.doesNotMatch(r.texto, /no tenemos|falta saber/i, `nada que corregir ni preguntar: ${r.texto}`);
  assert.ok(!r.eventos.some((e) => e.includes('seleccion_sin_respaldo')), JSON.stringify(r.eventos));
});

// ═══ F6 — logística y cortesía NO son atributos del menú ══════════════════
await t('F6. "para llevar por favor" no genera ninguna mención no resuelta', async () => {
  mock.encolarRespuesta(borradorLLM([
    { grupo: 'Variante', opciones: ['Alfa'] },
    { grupo: 'Tamaño', opciones: ['Chico'] },
    { grupo: 'Líquido', opciones: ['Tipo Uno'] },
  ]));
  // Extractor deliberadamente malo: clasifica "llevar" como atributo comercial.
  mock.encolarRespuesta(menciones(atributo('llevar')));
  const r = await turno('f4', 'para llevar por favor');
  assert.doesNotMatch(r.texto, /no tenemos/i, `"llevar" no es una opción de menú: ${r.texto}`);
  const descartada = r.eventos.find((e) => e.includes('mencion_descartada'));
  assert.ok(descartada && /sin_posicion_de_atributo/.test(descartada),
    `el filtro gramatical debe atraparlo aunque el extractor falle: ${JSON.stringify(r.eventos)}`);
});

// ═══ F7 — las notas de preparación siguen siendo notas ════════════════════
await t('F7. "sin cebolla" sigue siendo nota y nunca se compara contra el catálogo', async () => {
  deleteSession('f7');
  mock.encolarRespuesta(borradorLLM([
    { grupo: 'Variante', opciones: ['Alfa'] },
    { grupo: 'Tamaño', opciones: ['Chico'] },
    { grupo: 'Líquido', opciones: ['Tipo Uno'] },
  ], { notas: 'sin cebolla' }));
  // Otra vez el extractor se equivoca: la marca como atributo.
  mock.encolarRespuesta(menciones(atributo('alfa'), atributo('cebolla')));
  const r = await turno('f7', 'una bebida preparada alfa chico de tipo uno sin cebolla');
  assert.doesNotMatch(r.texto, /no tenemos cebolla/i, `una nota libre no puede volverse un rechazo: ${r.texto}`);
  assert.match(r.texto, /Con gusto/, `el turno sigue su curso normal: ${r.texto}`);
});

// ═══ F8 — una consulta no muta el pedido ══════════════════════════════════
await t('F8. una pregunta informativa no crea ni modifica pedido', async () => {
  deleteSession('f8');
  mock.encolarRespuesta('Sí, tenemos la variante Alfa disponible.');
  mock.encolarRespuesta(JSON.stringify({ items: [] }));   // borrador forzado: no hay pedido
  const r = await turno('f8', '¿tienen bebida preparada de alfa?');
  assert.match(r.texto, /S[ií], tenemos/, `la respuesta del modelo se conserva: ${r.texto}`);
  assert.doesNotMatch(r.texto, /falta saber|no tenemos/i, `una consulta no se convierte en formulario: ${r.texto}`);
  assert.strictEqual(verPreviewPedido('f8'), null, 'no puede nacer un preview de una pregunta');
  assert.strictEqual(getSession('f8').pedido.items.length, 0, 'el carrito sigue vacío');
  assert.strictEqual(mock.pendientes(), 0, 'no debe pedirse extracción de menciones si no hay borrador con ítems');
});

// ═══ F5 — el ciclo activo delimita el respaldo ════════════════════════════
await t('F5. lo dicho en un pedido ANTERIOR no respalda una selección del pedido actual', async () => {
  deleteSession('f5');
  // Turno 1: el cliente sí pide Alfa. Termina en un pedido (frontera de ciclo).
  mock.encolarRespuesta(borradorLLM([
    { grupo: 'Variante', opciones: ['Alfa'] },
    { grupo: 'Tamaño', opciones: ['Chico'] },
    { grupo: 'Líquido', opciones: ['Tipo Uno'] },
  ]));
  mock.encolarRespuesta(menciones(producto('bebida preparada'), atributo('alfa'), atributo('chico'), atributo('tipo uno')));
  await turno('f5', 'quiero una bebida preparada alfa chico de tipo uno');
  iniciarCicloPedido('f5');   // el pedido se registró: el ciclo se cierra (ver brain.js)

  // Turno 2: pedido NUEVO. El modelo arrastra "Alfa" del pedido viejo.
  mock.encolarRespuesta(borradorLLM([
    { grupo: 'Variante', opciones: ['Alfa'] }, { grupo: 'Tamaño', opciones: ['Grande'] },
  ]));
  mock.encolarRespuesta(menciones(producto('bebida preparada'), atributo('grande')));
  const r = await turno('f5', 'ahora quiero otra bebida preparada grande');
  const sinRespaldo = r.eventos.find((e) => e.includes('seleccion_sin_respaldo'));
  assert.ok(sinRespaldo && /Variante:Alfa/.test(sinRespaldo),
    `Alfa pertenece al pedido anterior y no respalda a este: ${JSON.stringify(r.eventos)}`);
  assert.match(r.texto, /falta saber/i, `hay que volver a preguntar la variante: ${r.texto}`);
  assert.match(r.texto, /variante/i, r.texto);
});

// ═══ G1/G2 — el guard del Asistente Comercial es ESTRECHO ═════════════════
// Un turno de cotización no arma un pedido del menú: validar su texto contra el
// catálogo no protege nada y cuesta una llamada extra al modelo. Pero apagar de
// más sería peor que el problema: lo TRANSACCIONAL tiene que seguir intacto.
const TEL = '5219990001111';
await pool.query(`INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,'asistente_comercial_cotizaciones','activo')
  ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado='activo'`, [NEG]);
await pool.query(`DELETE FROM sesiones_comerciales WHERE negocio_id=$1 AND telefono=$2`, [NEG, TEL]).catch(() => {});

async function turnoComercial(sessionId, mensaje) {
  const eventos = []; const warn = console.warn;
  console.warn = (...a) => { eventos.push(a.join(' ')); };
  try {
    const r = await procesarMensaje(sessionId, mensaje, null, 'whatsapp', NEG, TEL);
    return { ...r, eventos };
  } finally { console.warn = warn; }
}

await t('G1. con sesión comercial activa NO corre la validación conversacional de catálogo', async () => {
  deleteSession('g1');
  mock.encolarRespuesta('solicitud_comercial');                       // clasificador de intención
  mock.encolarRespuesta(borradorLLM([{ grupo: 'Tamaño', opciones: ['Grande'] }]));
  const r = await turnoComercial('g1', MSG_OMEGA);
  assert.doesNotMatch(r.texto, /no tenemos omega/i,
    `el flujo de cotización no se contrasta contra el menú: ${r.texto}`);
  assert.strictEqual(mock.pendientes(), 0,
    'solo clasificador + principal: ninguna llamada extra de fidelidad');
});

await t('G2. …pero el camino TRANSACCIONAL sigue protegido con sesión comercial activa', async () => {
  deleteSession('g2');
  mock.encolarRespuesta('solicitud_comercial');
  mock.encolarRespuesta(`Va tu pedido.
<ORDEN_PREVIEW>${JSON.stringify({
    items: [{ nombre: PROD, cantidad: 1, modificadores: [{ grupo: 'Variante', opciones: ['Omega'] }] }],
    forma_pago: 'efectivo', modalidad: 'recoger',
  })}</ORDEN_PREVIEW>`);
  const r = await turnoComercial('g2', MSG_OMEGA);
  // El texto lo redacta el backend (mensajeRechazoParaCliente), NUNCA el modelo:
  // aquí faltan además Tamaño y Líquido, así que cae en el rechazo compuesto.
  assert.doesNotMatch(r.texto, /Va tu pedido/,
    `la redacción del modelo no puede sobrevivir a un rechazo del backend: ${r.texto}`);
  assert.match(r.texto, /no pude registrar tu pedido|no tenemos|falta/i,
    `el validador transaccional sigue rechazando lo inexistente: ${r.texto}`);
  assert.strictEqual(verPreviewPedido('g2'), null,
    'una orden inválida nunca deja preview confirmable, haya o no sesión comercial');
});
await pool.query(`UPDATE negocio_modulos SET estado='no_contratado' WHERE negocio_id=$1 AND modulo='asistente_comercial_cotizaciones'`, [NEG]);

// ═══ H1-H4 — regresión del smoke real: "Quiero un licuado grande de mango" ══
// En producción esto respondió: "no tenemos grande en medida; tengo Chico y
// Grande 1 Litro y no tenemos mango en medida; tengo Chico y Grande 1 Litro".
// Tres defectos encadenados: emparejamiento exacto contra el habla del cliente,
// atribución de un grupo sin evidencia, y una cláusula por mención.
const { validarBorradorPedido: validar, mensajeBorradorParaCliente: mensaje } =
  await import('../src/orders/validadorOrden.js');
const soloProducto = (nombre) => ({ items: [{ nombre, cantidad: 1, modificadores: [] }] });

await t('H1. una mención ABREVIADA resuelve a la opción real ("grande" → "Grande 1 Litro")', async () => {
  const rc = await validar(soloProducto('Refresco'), NEG,
    { textoCiclo: 'quiero un refresco grande', menciones: ['grande'] });
  assert.deepStrictEqual(rc.productos[0].elegidas, [{ grupo: 'Medida', opcion: 'Grande 1 Litro' }],
    'el cliente no tiene que escribir el nombre completo del catálogo');
  assert.deepStrictEqual(rc.mencionesNoResueltas, [],
    'jamás se le puede decir que no existe algo que sí se vende');
});

await t('H2. si la abreviación encaja en DOS opciones, se pregunta en vez de adivinar', async () => {
  const rc = await validar(soloProducto('Refresco Doble'), NEG,
    { textoCiclo: 'quiero un refresco grande', menciones: ['grande'] });
  assert.deepStrictEqual(rc.productos[0].elegidas, [], 'no se elige por el cliente');
  assert.strictEqual(rc.productos[0].ambiguos.length, 1);
  assert.match(mensaje(rc), /aparece en|cu[aá]l/i, mensaje(rc));
});

await t('H3. una mención sin grupo posible NO hereda un grupo ajeno', async () => {
  const rc = await validar(soloProducto('Refresco'), NEG,
    { textoCiclo: 'quiero un refresco grande de mango', menciones: ['grande', 'mango'] });
  // Las menciones no resueltas son del TURNO, no de un artículo: viven en la raíz.
  const m = rc.mencionesNoResueltas;
  assert.deepStrictEqual(m.map((x) => x.texto), ['mango'], 'solo mango queda sin resolver');
  assert.strictEqual(m[0].gruposCandidatos, undefined,
    'no se le puede atribuir "Medida" ni ningún otro grupo sin evidencia');
  const txt = mensaje(rc);
  assert.doesNotMatch(txt, /mango en medida/i, `atribución falsa de grupo: ${txt}`);
  assert.match(txt, /no manejamos "mango" en Refresco/, txt);
});

await t('H4. el mensaje NO repite alternativas ni cláusulas', async () => {
  const rc = await validar(soloProducto('Refresco'), NEG,
    { textoCiclo: 'quiero un refresco de mango y de kiwi', menciones: ['mango', 'kiwi'] });
  const txt = mensaje(rc);
  assert.match(txt, /"mango" y "kiwi"/, `ambas menciones en UNA sola cláusula: ${txt}`);
  const veces = (txt.match(/Chico/g) || []).length;
  assert.ok(veces <= 1, `las opciones no pueden listarse dos veces: ${txt}`);
  assert.strictEqual((txt.match(/no manejamos/g) || []).length, 1, txt);
});

// ═══ Contratos del mecanismo (unitarios, sin LLM) ═════════════════════════
await t('C1. el respaldo distingue el nombre completo y sus palabras significativas', () => {
  assert.ok(tieneRespaldo('Tipo Uno', 'quiero de tipo uno'), 'nombre completo');
  assert.ok(tieneRespaldo('Leche Entera', 'que sea entera'), 'palabra significativa');
  assert.ok(!tieneRespaldo('Fresa', 'quiero un licuado de mango grande'), 'lo que no dijo no respalda');
});
await t('C2. un span inexistente se descarta aunque el extractor insista', () => {
  const d = depurarMenciones([{ tipo: 'atributo', texto_fuente: 'fresa' }], 'quiero uno de mango');
  assert.deepStrictEqual(d.atributos, []);
  assert.strictEqual(d.descartadas[0].motivo, 'span_inexistente');
});
await t('C3. la logística no entra como atributo; la nota de preparación va a notas', () => {
  assert.deepStrictEqual(depurarMenciones([{ tipo: 'atributo', texto_fuente: 'llevar' }], 'es para llevar').atributos, []);
  const n = depurarMenciones([{ tipo: 'atributo', texto_fuente: 'cebolla' }], 'uno sin cebolla');
  assert.deepStrictEqual(n.atributos, []);
  assert.deepStrictEqual(n.notas, ['cebolla']);
});
await t('C4. brain.js cierra el ciclo en TODOS los caminos que registran', async () => {
  const { readFileSync } = await import('fs');
  const src = readFileSync(new URL('../src/agent/brain.js', import.meta.url), 'utf8');
  assert.strictEqual((src.match(/iniciarCicloPedido\(sessionId\)/g) || []).length, 2,
    'confirmación desde snapshot y registro directo deben cerrar el ciclo');
});

// ── Resumen ────────────────────────────────────────────────────────────────
mock.detener();
console.log(`\n${fallidas === 0 ? 'TODO VERDE' : 'CON FALLOS'} — ${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) for (const f of fallos) console.log(`  · ${f}`);
await pool.end().catch(() => {});
process.exit(fallidas === 0 ? 0 : 1);
