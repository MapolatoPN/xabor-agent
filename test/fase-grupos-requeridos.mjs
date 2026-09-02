// GRUPOS OBLIGATORIOS Y CARDINALIDAD (min/max) EN EL CAMINO DEL AGENTE.
//
// El POS/Restaurante ya exigía la cardinalidad de cada grupo desde siempre
// (resolverSeleccion), pero el camino del LLM no: un pedido conversacional
// podía llegar a preview sin elegir un grupo obligatorio. Caso real: se vendió
// un licuado sin sabor.
//
// La semántica NO se inventa aquí: se reutiliza la que ya aplica la UI, ahora
// extraída a `cardinalidadDeGrupo` para que ambos caminos usen la misma regla:
//   · mínimo → si `requerido`, al menos 1 aunque `minimo` sea 0/null;
//              si no, `minimo` o 0.
//   · máximo → solo cuenta si es > 0; 0/null significan SIN LÍMITE.
//
// El backend NUNCA rellena un grupo faltante: pregunta con las opciones reales.
//
// Multi-tenant y sin nombres de negocio: fixture genérico con grupos
// "Variante" (requerido 1..1), "Guarnición" (2..2) y "Extra" (opcional).
//
// Uso: DATABASE_URL=... node test/fase-grupos-requeridos.mjs
import assert from 'assert';

const { pool } = await import('../src/services/database.js');
const { previsualizarPedido } = await import('../src/orders/orderManager.js');
const { validarOrdenPropuesta, RECHAZOS, mensajeRechazoParaCliente } = await import('../src/orders/validadorOrden.js');
const { cardinalidadDeGrupo, validarCardinalidadGrupos, cargarGruposDeProductos } = await import('../src/services/modificadores.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ── Fixture ─────────────────────────────────────────────────────────────────
const q1 = async (sql, params) => (await pool.query(sql, params)).rows[0];
const NEG = (await q1(
  `INSERT INTO negocios (nombre, slug) VALUES ('Grupos Requeridos','grupos-requeridos')
   ON CONFLICT (slug) DO UPDATE SET nombre='Grupos Requeridos' RETURNING id`)).id;
const OTRO = (await q1(
  `INSERT INTO negocios (nombre, slug) VALUES ('Grupos Otro','grupos-otro')
   ON CONFLICT (slug) DO UPDATE SET nombre='Grupos Otro' RETURNING id`)).id;
for (const n of [NEG, OTRO]) {
  for (const tabla of ['menu_modificadores_opciones', 'menu_modificadores_grupos', 'menu_productos', 'menu_categorias']) {
    await pool.query(`DELETE FROM ${tabla} WHERE negocio_id=$1`, [n]).catch(() => {});
  }
  await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1`, [n]).catch(() => {});
}
const cat = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden) VALUES ($1,'GENERAL',0) RETURNING id`, [NEG])).id;
const CONREQ = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Producto Con Requeridos',100) RETURNING id`, [NEG, cat])).id;
const LIBRE = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Producto Libre',80) RETURNING id`, [NEG, cat])).id;
const grupo = async (prod, nombre, { requerido = false, minimo = 0, maximo = 0 } = {}, negocio = NEG) => (await q1(
  `INSERT INTO menu_modificadores_grupos (negocio_id,producto_id,nombre,requerido,minimo,maximo,orden)
   VALUES ($1,$2,$3,$4,$5,$6,0) RETURNING id`, [negocio, prod, nombre, requerido, minimo, maximo])).id;
const op = async (gid, nombre, extra = 0, negocio = NEG) => (await q1(
  `INSERT INTO menu_modificadores_opciones (negocio_id,grupo_id,nombre,precio_extra,disponible,orden)
   VALUES ($1,$2,$3,$4,TRUE,0) RETURNING id`, [negocio, gid, nombre, extra])).id;

const gVariante = await grupo(CONREQ, 'Variante', { requerido: true, minimo: 1, maximo: 1 });
for (const v of ['Uno', 'Dos', 'Tres']) await op(gVariante, v);
const gGuarnicion = await grupo(CONREQ, 'Guarnición', { requerido: true, minimo: 2, maximo: 2 });
for (const v of ['G1', 'G2', 'G3']) await op(gGuarnicion, v);
const gExtra = await grupo(CONREQ, 'Extra', { requerido: false, minimo: 0, maximo: 0 });
await op(gExtra, 'E1', 15);
// Producto sin grupos requeridos (compatibilidad con el catálogo existente).
const gLibre = await grupo(LIBRE, 'Opcional', { requerido: false, minimo: 0, maximo: 0 });
await op(gLibre, 'L1');
// Negocio ajeno.
const catO = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden) VALUES ($1,'G',0) RETURNING id`, [OTRO])).id;
const prodO = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Producto Con Requeridos',100) RETURNING id`, [OTRO, catO])).id;
const gVarO = await grupo(prodO, 'Variante', { requerido: true, minimo: 1, maximo: 1 }, OTRO);
await op(gVarO, 'Ajena', 0, OTRO);

const gruposCon = (await cargarGruposDeProductos(NEG, [CONREQ])).get(CONREQ) || [];
const base = (items, canal = 'whatsapp') => ({ cliente: { nombre: 'C', telefono: '5550000010' },
  modalidad: 'recoger', forma_pago: 'efectivo', canal, items });
const conMods = (mods, extra = {}) => base([{ nombre: 'Producto Con Requeridos', cantidad: 1, modificadores: mods, ...extra }]);
const mod = (grupo, ...opciones) => ({ grupo, opciones });

// ═══ Semántica (§1/§7) ══════════════════════════════════════════════════════
await t('§7. la semántica es la MISMA que ya aplicaba la UI (no se inventa)', () => {
  assert.deepStrictEqual(cardinalidadDeGrupo({ requerido: true, minimo: 0, maximo: 0 }),
    { minimo: 1, maximo: Infinity }, 'requerido implica al menos 1 aunque minimo sea 0');
  assert.deepStrictEqual(cardinalidadDeGrupo({ requerido: false, minimo: 0, maximo: 0 }),
    { minimo: 0, maximo: Infinity }, 'maximo 0 significa SIN LÍMITE, no "cero opciones"');
  assert.deepStrictEqual(cardinalidadDeGrupo({ requerido: false, minimo: 2, maximo: 3 }),
    { minimo: 2, maximo: 3 });
});

// ═══ R1–R6 — cardinalidad ═══════════════════════════════════════════════════
await t('R1. grupo requerido con CERO opciones → rechaza', async () => {
  const v = await previsualizarPedido(conMods([mod('Guarnición', 'G1', 'G2')]), NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.ok, false);
  const r = v.rechazos.find((x) => x.codigo === RECHAZOS.GRUPO_REQUERIDO_FALTANTE);
  assert.ok(r, 'debía faltar Variante');
  assert.strictEqual(r.grupo, 'Variante');
});
await t('R2. requerido min=1 con UNA opción → pasa', async () => {
  const v = await previsualizarPedido(conMods([mod('Variante', 'Uno'), mod('Guarnición', 'G1', 'G2')]), NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.ok, true, `debía pasar: ${JSON.stringify(v.rechazos || [])}`);
});
await t('R3. min=2 con UNA opción → rechaza', async () => {
  const v = await previsualizarPedido(conMods([mod('Variante', 'Uno'), mod('Guarnición', 'G1')]), NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.ok, false);
  const r = v.rechazos.find((x) => x.codigo === RECHAZOS.GRUPO_REQUERIDO_FALTANTE && x.grupo === 'Guarnición');
  assert.ok(r); assert.strictEqual(r.minimo, 2); assert.strictEqual(r.elegidas, 1);
});
await t('R4. min=2 con DOS opciones → pasa', async () => {
  const v = await previsualizarPedido(conMods([mod('Variante', 'Dos'), mod('Guarnición', 'G1', 'G3')]), NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.ok, true);
});
await t('R5. max=1 con DOS opciones → rechaza', async () => {
  const v = await previsualizarPedido(conMods([mod('Variante', 'Uno', 'Dos'), mod('Guarnición', 'G1', 'G2')]), NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.ok, false);
  const r = v.rechazos.find((x) => x.codigo === RECHAZOS.GRUPO_EXCEDE_MAXIMO);
  assert.ok(r, 'Variante admite máximo 1'); assert.strictEqual(r.maximo, 1); assert.strictEqual(r.elegidas, 2);
});
await t('R6. grupo OPCIONAL omitido → pasa (no se vuelve todo obligatorio)', async () => {
  const v = await previsualizarPedido(conMods([mod('Variante', 'Uno'), mod('Guarnición', 'G1', 'G2')]), NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.ok, true, 'Extra es opcional y puede faltar');
});

// ═══ R7 — no confundir los dos errores (§5) ════════════════════════════════
await t('R7. opción INEXISTENTE en un grupo requerido → MODIFICADOR_NO_DISPONIBLE (no "faltante")', async () => {
  const v = await validarOrdenPropuesta(conMods([mod('Variante', 'Inexistente'), mod('Guarnición', 'G1', 'G2')]), NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.ok, false);
  assert.ok(v.rechazos.some((r) => r.codigo === RECHAZOS.MODIFICADOR_NO_DISPONIBLE),
    'pedir algo que no existe NO es lo mismo que omitir el grupo');
});
await t('R7b. grupo OMITIDO por completo → GRUPO_REQUERIDO_FALTANTE (no "no disponible")', async () => {
  const v = await validarOrdenPropuesta(conMods([mod('Guarnición', 'G1', 'G2')]), NEG, { canal: 'whatsapp' });
  assert.ok(v.rechazos.some((r) => r.codigo === RECHAZOS.GRUPO_REQUERIDO_FALTANTE));
  assert.ok(!v.rechazos.some((r) => r.codigo === RECHAZOS.MODIFICADOR_NO_DISPONIBLE));
});

// ═══ R8/R9 — mensaje conjunto con opciones reales ══════════════════════════
await t('R8. DOS grupos requeridos faltantes → se informan AMBOS en un mensaje', async () => {
  const v = await validarOrdenPropuesta(conMods([]), NEG, { canal: 'whatsapp' });
  const fs = v.rechazos.filter((r) => r.codigo === RECHAZOS.GRUPO_REQUERIDO_FALTANTE);
  assert.strictEqual(fs.length, 2, 'faltan Variante y Guarnición');
  const msg = mensajeRechazoParaCliente(v.rechazos);
  assert.match(msg, /Variante/); assert.match(msg, /Guarnición/);
  assert.strictEqual((msg.match(/\?/g) || []).length, 1, 'una sola pregunta, no una por turno');
});
await t('R9. las alternativas salen del CATÁLOGO real', async () => {
  const v = await validarOrdenPropuesta(conMods([mod('Guarnición', 'G1', 'G2')]), NEG, { canal: 'whatsapp' });
  const r = v.rechazos.find((x) => x.codigo === RECHAZOS.GRUPO_REQUERIDO_FALTANTE);
  assert.deepStrictEqual(r.alternativas, ['Uno', 'Dos', 'Tres']);
  assert.match(mensajeRechazoParaCliente(v.rechazos), /Uno, Dos y Tres/);
});
await t('§4. el backend NUNCA rellena el grupo faltante por su cuenta', async () => {
  const v = await previsualizarPedido(conMods([mod('Guarnición', 'G1', 'G2')]), NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.ok, false, 'no puede autocompletar y seguir');
  assert.strictEqual(v.preview, undefined, 'no debe existir preview con una selección inventada');
});

// ═══ R10 — aislamiento ══════════════════════════════════════════════════════
await t('R10. una opción de OTRO negocio no satisface el grupo requerido', async () => {
  const v = await previsualizarPedido(conMods([mod('Variante', 'Ajena'), mod('Guarnición', 'G1', 'G2')]), NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.ok, false);
});

// ═══ R11 — compatibilidad ══════════════════════════════════════════════════
await t('R11. un producto SIN grupos requeridos sigue funcionando igual', async () => {
  const v = await previsualizarPedido(base([{ nombre: 'Producto Libre', cantidad: 1 }]), NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.ok, true, 'el catálogo existente no se vuelve obligatorio');
  assert.strictEqual(v.preview.total, 80);
});
await t('§8. un canal con checkout EXTERNO (ya cobrado) no se rompe en silencio', async () => {
  // En Rappi no hay conversación donde preguntar y el cliente ya pagó allá:
  // rechazar solo destruiría la venta. El resto de validaciones siguen.
  const v = await previsualizarPedido(conMods([], 'rappi'), NEG, { canal: 'rappi' });
  assert.strictEqual(v.ok, true, 'un pedido de Rappi no se rechaza por cardinalidad');
});

// ═══ R13 — notas no cuentan como selección ═════════════════════════════════
await t('R13. una nota libre NO cuenta como selección de grupo ni la satisface', async () => {
  const v = await previsualizarPedido(conMods([mod('Guarnición', 'G1', 'G2')], { notas: 'sin cebolla' }), NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.ok, false, 'la nota no puede hacer las veces de Variante');
  assert.ok(v.rechazos.some((r) => r.grupo === 'Variante'));
});

// ═══ R14/R15 — el caso del producto sin su atributo ════════════════════════
await t('R14. producto con grupo requerido SIN elegirlo → cero preview', async () => {
  const v = await previsualizarPedido(conMods([mod('Guarnición', 'G1', 'G2')]), NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.preview, undefined);
});
await t('R15. con la selección válida → preview permitido', async () => {
  const v = await previsualizarPedido(conMods([mod('Variante', 'Tres'), mod('Guarnición', 'G2', 'G3')]), NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.preview.total, 100);
  assert.strictEqual(v.orden.items[0].modificadores.length, 3);
});

// ═══ Unidad de la función pura ═════════════════════════════════════════════
await t('validarCardinalidadGrupos reporta faltantes y excedidos con nombres reales', () => {
  const r = validarCardinalidadGrupos(gruposCon, []);
  assert.strictEqual(r.faltantes.length, 2);
  assert.ok(r.faltantes.every((f) => Array.isArray(f.alternativas) && f.alternativas.length));
  assert.strictEqual(r.excedidos.length, 0);
});

// ═══ C1–C4 — CATÁLOGO INCONSISTENTE ════════════════════════════════════════
// Un grupo obligatorio SIN opciones que ofrecer no es "falta que elijas": el
// cliente no puede resolverlo por más que se le pregunte. Es configuración del
// negocio y debe distinguirse, o el cliente queda en un bucle imposible.
const ROTO = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Producto Mal Configurado',90) RETURNING id`, [NEG, cat])).id;
const gRoto = await grupo(ROTO, 'Obligatorio Vacío', { requerido: true, minimo: 1, maximo: 1 });
await pool.query(
  `INSERT INTO menu_modificadores_opciones (negocio_id,grupo_id,nombre,precio_extra,disponible,orden)
   VALUES ($1,$2,'Agotada',0,FALSE,0)`, [NEG, gRoto]);   // única opción, NO disponible
const OPC_VACIO = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Producto Opcional Vacío',70) RETURNING id`, [NEG, cat])).id;
await grupo(OPC_VACIO, 'Opcional Vacío', { requerido: false, minimo: 0, maximo: 0 });

await t('C1. grupo requerido SIN opciones suficientes → catálogo inconsistente, NO preview', async () => {
  const v = await previsualizarPedido(base([{ nombre: 'Producto Mal Configurado', cantidad: 1 }]), NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.ok, false, 'no puede venderse algo que no se puede configurar');
  assert.strictEqual(v.preview, undefined);
  assert.ok(v.rechazos.some((r) => r.codigo === RECHAZOS.PRODUCTO_NO_CONFIGURADO_PARA_VENTA));
  // Y NO se reporta como si el cliente hubiera olvidado elegir.
  assert.ok(!v.rechazos.some((r) => r.codigo === RECHAZOS.GRUPO_REQUERIDO_FALTANTE),
    'no debe confundirse con "falta que elijas"');
});
await t('C2. el cliente NO recibe una petición imposible de resolver', async () => {
  const v = await validarOrdenPropuesta(base([{ nombre: 'Producto Mal Configurado', cantidad: 1 }]), NEG, { canal: 'whatsapp' });
  const msg = mensajeRechazoParaCliente(v.rechazos);
  assert.match(msg, /no está disponible para pedir/i);
  assert.ok(!/falta elegir/i.test(msg), 'jamás pedirle que elija de una lista vacía');
  assert.ok(!/Obligatorio Vacío/.test(msg), 'sin detalle técnico del catálogo');
});
await t('C3. grupo requerido CON opciones suficientes → flujo normal', async () => {
  const v = await previsualizarPedido(conMods([mod('Variante', 'Uno'), mod('Guarnición', 'G1', 'G2')]), NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.ok, true, 'un catálogo sano no se ve afectado');
});
await t('C4. grupo OPCIONAL sin opciones → no bloquea (no es obligatorio)', async () => {
  const v = await previsualizarPedido(base([{ nombre: 'Producto Opcional Vacío', cantidad: 1 }]), NEG, { canal: 'whatsapp' });
  assert.strictEqual(v.ok, true, 'un grupo opcional vacío es normal, no un error');
  assert.strictEqual(v.preview.total, 70);
});
await t('C5. un máximo menor que el mínimo también es catálogo inconsistente', () => {
  const g = [{ id: 1, nombre: 'Imposible', requerido: true, minimo: 3, maximo: 1,
    opciones: [{ id: 1, nombre: 'A', disponible: true }, { id: 2, nombre: 'B', disponible: true },
               { id: 3, nombre: 'C', disponible: true }] }];
  const r = validarCardinalidadGrupos(g, []);
  assert.strictEqual(r.inconsistentes.length, 1, 'max<min no se puede satisfacer nunca');
  assert.strictEqual(r.faltantes.length, 0);
});

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
