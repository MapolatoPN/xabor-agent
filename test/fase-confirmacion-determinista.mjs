// CONFIRMACIÓN TRANSACCIONAL DETERMINISTA.
//
// Caso real (Mapolato, 02/09/2026): Xabor mostró el resumen oficial correcto
// (subtotal $450, promo -$195, total $255), el cliente dijo "Sí"... y no se
// creó ningún pedido. El modelo redactó "tu pedido quedó confirmado / enviado a
// cocina" pero NO emitió <ORDEN_CONFIRMADA>, así que el backend nunca registró.
// La salvaguarda avisó ([TXN] confirmacion_verbal_sin_orden), pero el pedido se
// perdió.
//
// Invariante que protege esta suite: una vez mostrado un preview oficial, la
// confirmación del cliente registra ESE pedido canónico — sin depender de que
// el modelo lo reconstruya, sin registrar dos veces, y sin registrar nunca un
// total distinto al que el cliente vio.
//
// Uso: DATABASE_URL=... node test/fase-confirmacion-determinista.mjs
import assert from 'assert';

const { pool } = await import('../src/services/database.js');
const { guardarPromocion } = await import('../src/services/tiendaPromociones.js');
const { previsualizarPedido, registrarPedido } = await import('../src/orders/orderManager.js');
const { esConfirmacionVerbal, esMutacionDePedido, esConsultaNoMutante, clasificarTurnoPostPreview } = await import('../src/agent/confirmacionVerbal.js');
const { decidirConfirmacion, huellaOrden: huella } = await import('../src/agent/confirmacionPolicy.js');
const { getSession, deleteSession, agregarMensaje, guardarPreviewPedido, consumirPreviewPedido,
        verPreviewPedido, verPreviewConfirmable, restaurarPreviewPedido, invalidarPreviewPedido, marcarPreviewNoConfirmable,
        reemplazarUltimoMensajeAsistente } = await import('../src/agent/session.js');

let pasadas = 0, fallidas = 0; const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ── Fixture: réplica del pedido real ────────────────────────────────────────
const q1 = async (sql, params) => (await pool.query(sql, params)).rows[0];
const NEG = (await q1(
  `INSERT INTO negocios (nombre, slug) VALUES ('Confirmacion Determinista','confirmacion-det')
   ON CONFLICT (slug) DO UPDATE SET nombre='Confirmacion Determinista' RETURNING id`)).id;
for (const tabla of ['tienda_promociones', 'menu_modificadores_opciones', 'menu_modificadores_grupos', 'menu_productos', 'menu_categorias']) {
  await pool.query(`DELETE FROM ${tabla} WHERE negocio_id=$1`, [NEG]).catch(() => {});
}
await pool.query(`DELETE FROM pedidos_activos WHERE negocio_id=$1`, [NEG]).catch(() => {});
const cat = (await q1(`INSERT INTO menu_categorias (negocio_id,nombre,orden) VALUES ($1,'CHILAQUILES',0) RETURNING id`, [NEG])).id;
const pChila = (await q1(`INSERT INTO menu_productos (negocio_id,categoria_id,nombre,precio) VALUES ($1,$2,'Chilaquiles Sencillos',195) RETURNING id`, [NEG, cat])).id;
const gSalsa = (await q1(`INSERT INTO menu_modificadores_grupos (negocio_id,producto_id,nombre,requerido,minimo,maximo,orden) VALUES ($1,$2,'Salsa',FALSE,0,0,0) RETURNING id`, [NEG, pChila])).id;
const gGuarn = (await q1(`INSERT INTO menu_modificadores_grupos (negocio_id,producto_id,nombre,requerido,minimo,maximo,orden) VALUES ($1,$2,'Guarniciones',FALSE,0,0,0) RETURNING id`, [NEG, pChila])).id;
const op = async (gid, nombre, extra = 0) => (await q1(
  `INSERT INTO menu_modificadores_opciones (negocio_id,grupo_id,nombre,precio_extra,disponible,orden) VALUES ($1,$2,$3,$4,TRUE,0) RETURNING id`, [NEG, gid, nombre, extra])).id;
await op(gSalsa, 'Verde'); await op(gSalsa, 'Roja');
await op(gGuarn, 'Bistec en Salsa', 30); await op(gGuarn, 'Queso Panela en Salsa', 30);
await op(gGuarn, 'Frijolitos naturales'); await op(gGuarn, 'Papas con chorizo');
await guardarPromocion(NEG, {
  nombre: 'Miercoles de Chilaquiles', tipo: '2x1', automatica: true,
  cantidadRequerida: 2, cantidadBeneficiada: 1, canales: ['whatsapp'], productos: [pChila],
});

const ORDEN = {
  cliente: { nombre: 'Mario Cantu', telefono: '8787899919' },
  modalidad: 'recoger', forma_pago: 'efectivo', canal: 'whatsapp',
  items: [
    { nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [
      { grupo: 'Salsa', opciones: ['Verde'] },
      { grupo: 'Guarniciones', opciones: ['Bistec en Salsa', 'Queso Panela en Salsa'] }] },
    { nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [
      { grupo: 'Salsa', opciones: ['Roja'] },
      { grupo: 'Guarniciones', opciones: ['Frijolitos naturales', 'Papas con chorizo'] }] },
  ],
};
const previewOk = async () => {
  const v = await previsualizarPedido(ORDEN, NEG, { canal: 'whatsapp' });
  assert.ok(v.ok, `fixture inválido: ${JSON.stringify(v.rechazos || [])}`);
  return v;
};
const snapshotDe = (v) => ({ ordenCanonica: v.orden, total: v.preview.total, promociones: v.preview.promociones || [], ts: Date.now(), fingerprint: 'fp' });
const nuevaSesion = (id) => { deleteSession(id); return getSession(id); };
const folios = [];
async function registrarDesde(snap) {
  const pedido = await registrarPedido({ ...snap.ordenCanonica, negocioId: NEG, canal: 'whatsapp' }, 'whatsapp');
  folios.push(pedido.id);
  return pedido;
}

// ═══ Detección de intención (módulo puro) ═══════════════════════════════════
await t('intención: afirmaciones inequívocas se reconocen', () => {
  for (const s of ['Sí', 'si', 'SI', 'confirmo', 'correcto', 'adelante', 'está bien',
                   'así está bien', 'dale', 'ok', 'perfecto', 'de acuerdo', 'sale']) {
    assert.strictEqual(esConfirmacionVerbal(s), true, `"${s}" debía ser confirmación`);
  }
});
await t('intención: cambios y dudas NO son confirmación (fail-closed)', () => {
  for (const s of ['no', 'mejor cambia la salsa', 'quita el queso', 'agrega papas',
                   'sí pero cámbiale la salsa', '¿cuánto es?', 'espera', 'cancela',
                   'sin cebolla', 'otro más', 'cómo?']) {
    assert.strictEqual(esConfirmacionVerbal(s), false, `"${s}" NO debía ser confirmación`);
  }
});
await t('intención: un cambio se detecta como tal', () => {
  assert.strictEqual(esMutacionDePedido('mejor cambia la salsa'), true);
  assert.strictEqual(esMutacionDePedido('no, quita el queso'), true);
  assert.strictEqual(esMutacionDePedido('Sí'), false);
});

// ═══ CASO A — el caso real ══════════════════════════════════════════════════
await t('A. preview $255 + "Sí" sin <ORDEN_CONFIRMADA> → se registra desde el snapshot', async () => {
  const sid = 'det-A'; nuevaSesion(sid);
  const v = await previewOk();
  assert.strictEqual(v.preview.total, 255, 'el fixture debe reproducir el total real');
  guardarPreviewPedido(sid, snapshotDe(v));
  // El cliente dice "Sí" y el modelo NO emite marcador: el snapshot decide.
  assert.strictEqual(esConfirmacionVerbal('Sí'), true);
  const snap = consumirPreviewPedido(sid);
  assert.ok(snap, 'debía haber snapshot que consumir');
  const pedido = await registrarDesde(snap);
  assert.ok(/^XAB-\d+/.test(pedido.id), `folio real esperado, llegó ${pedido.id}`);
  assert.strictEqual(Number(pedido.total), 255, 'el total registrado debe ser el que vio el cliente');
});

// ═══ CASO B — doble "Sí" ════════════════════════════════════════════════════
await t('B. doble "Sí" → un solo pedido (el segundo no encuentra snapshot)', async () => {
  const sid = 'det-B'; nuevaSesion(sid);
  guardarPreviewPedido(sid, snapshotDe(await previewOk()));
  const primero = consumirPreviewPedido(sid);
  const segundo = consumirPreviewPedido(sid);
  assert.ok(primero, 'el primer "Sí" debe tomar el snapshot');
  assert.strictEqual(segundo, null, 'el segundo "Sí" NO debe poder registrar');
  const antes = folios.length;
  await registrarDesde(primero);
  assert.strictEqual(folios.length, antes + 1, 'debió crearse exactamente un folio');
});

// ═══ CASO C — cambio después del preview ════════════════════════════════════
await t('C. "mejor cambia la salsa" invalida el snapshot: no se puede confirmar', async () => {
  const sid = 'det-C'; nuevaSesion(sid);
  guardarPreviewPedido(sid, snapshotDe(await previewOk()));
  assert.ok(verPreviewPedido(sid), 'el snapshot debía existir');
  assert.strictEqual(esMutacionDePedido('mejor cambia la salsa'), true);
  invalidarPreviewPedido(sid);                       // lo que hace brain
  assert.strictEqual(verPreviewPedido(sid), null, 'el snapshot debía quedar obsoleto');
  assert.strictEqual(consumirPreviewPedido(sid), null, 'un "Sí" posterior NO puede registrar el pedido viejo');
});

// ═══ CASO D — el precio cambia antes de confirmar ═══════════════════════════
await t('D. si el total recalculado difiere, NO se registra: se pide reconfirmar', async () => {
  const sid = 'det-D'; nuevaSesion(sid);
  const v = await previewOk();
  // El cliente vio 255; simulamos que el catálogo cambió y ahora son 265.
  guardarPreviewPedido(sid, { ...snapshotDe(v), total: 265 });
  const snap = verPreviewPedido(sid);
  const revalidado = await previewOk();
  assert.notStrictEqual(Number(revalidado.preview.total), Number(snap.total),
    'el fixture debe simular un total distinto');
  // La política: guardar el NUEVO preview y NO registrar.
  guardarPreviewPedido(sid, snapshotDe(revalidado));
  assert.strictEqual(verPreviewPedido(sid).total, 255, 'el snapshot debe pasar a ser el total nuevo');
  // Y el pedido no se creó en este turno: hace falta un "Sí" sobre el nuevo.
});

// ═══ CASO E — sin snapshot ══════════════════════════════════════════════════
await t('E. "Sí" sin preview pendiente → no hay nada que registrar (fail-closed)', async () => {
  const sid = 'det-E'; nuevaSesion(sid);
  assert.strictEqual(verPreviewPedido(sid), null);
  assert.strictEqual(consumirPreviewPedido(sid), null, 'sin snapshot no puede registrarse nada');
});

// ═══ CASO F — historial ═════════════════════════════════════════════════════
await t('F. el historial guarda lo que el cliente VIO, no la cifra descartada', () => {
  const sid = 'det-F'; nuevaSesion(sid);
  agregarMensaje(sid, 'user', 'confirma');
  agregarMensaje(sid, 'assistant', 'Tu total es $999 (cifra inventada por el modelo)');
  const oficial = 'Tu pedido queda así:\n\nSubtotal: $450\nTotal: $255';
  reemplazarUltimoMensajeAsistente(sid, oficial);
  const ultimo = getSession(sid).mensajes.filter((m) => m.role === 'assistant').pop();
  assert.strictEqual(ultimo.content, oficial, 'el historial debe contener el resumen oficial');
  assert.ok(!getSession(sid).mensajes.some((m) => /999/.test(m.content)),
    'la cifra descartada no puede sobrevivir en el historial');
});

// ═══ CASO G — el registro falla ═════════════════════════════════════════════
await t('G. si la escritura falla, el snapshot se reactiva y no se afirma nada', async () => {
  const sid = 'det-G'; nuevaSesion(sid);
  const snapOriginal = snapshotDe(await previewOk());
  guardarPreviewPedido(sid, snapOriginal);
  const tomado = consumirPreviewPedido(sid);
  assert.ok(tomado);
  assert.strictEqual(verPreviewPedido(sid), null, 'mientras se registra, el snapshot está consumido');
  // La escritura falla (error técnico) → el canal lo reactiva.
  restaurarPreviewPedido(sid, tomado);
  const revivido = verPreviewPedido(sid);
  assert.ok(revivido, 'el snapshot debía reactivarse para poder reintentar');
  assert.strictEqual(revivido.total, 255);
  assert.strictEqual(revivido.consumido, false);
});

// ═══ CASO H — concurrencia ══════════════════════════════════════════════════
await t('H. dos confirmaciones concurrentes → una sola escritura', async () => {
  const sid = 'det-H'; nuevaSesion(sid);
  guardarPreviewPedido(sid, snapshotDe(await previewOk()));
  // Dos turnos que llegan "a la vez": ambos intentan tomar el snapshot.
  const [a, b] = await Promise.all([
    Promise.resolve().then(() => consumirPreviewPedido(sid)),
    Promise.resolve().then(() => consumirPreviewPedido(sid)),
  ]);
  const ganadores = [a, b].filter(Boolean);
  assert.strictEqual(ganadores.length, 1, 'exactamente un turno puede tomar el snapshot');
  const antes = folios.length;
  await registrarDesde(ganadores[0]);
  assert.strictEqual(folios.length, antes + 1, 'una sola escritura');
});

// ═══ CASOS J–O — CONSULTA vs MUTACIÓN ═══════════════════════════════════════
// Una pregunta sobre el pedido NO lo modifica: el cliente debe poder preguntar
// y confirmar después. Lo que invalida es la INTENCIÓN de cambio, traiga o no
// signo de interrogación.
const CONSULTAS = [
  ['J', '¿Y la promo?'],
  ['K', '¿Cuánto tarda?'],
  ['L', '¿Puedo pagar con tarjeta?'],
  ['M', '¿Dónde recojo?'],
  ['L2', '¿Aceptan tarjeta?'],
  ['M2', '¿A qué hora estaría?'],
  ['J2', '¿Cuánto me estás descontando?'],
];
for (const [etiqueta, pregunta] of CONSULTAS) {
  await t(`${etiqueta}. "${pregunta}" NO invalida el snapshot (es consulta)`, async () => {
    const sid = `det-${etiqueta}`; nuevaSesion(sid);
    guardarPreviewPedido(sid, snapshotDe(await previewOk()));
    assert.strictEqual(esMutacionDePedido(pregunta), false, 'no debía clasificarse como mutación');
    assert.strictEqual(esConsultaNoMutante(pregunta), true, 'debía clasificarse como consulta');
    // brain solo invalida ante mutación: aquí el snapshot sobrevive.
    assert.ok(verPreviewPedido(sid), 'el snapshot debía seguir vivo tras la pregunta');
    assert.strictEqual(getSession(sid).awaitingConfirmacion, true, 'debe seguir esperando confirmación');
  });
}
await t('N. pregunta y DESPUÉS "Sí" → registra ESE mismo snapshot, 1 pedido, $255', async () => {
  const sid = 'det-N'; nuevaSesion(sid);
  const v = await previewOk();
  guardarPreviewPedido(sid, snapshotDe(v));
  const idOriginal = verPreviewPedido(sid).ts;
  // Turno 1: el cliente pregunta por la promo. No se toca nada.
  assert.strictEqual(esMutacionDePedido('¿Y la promo?'), false);
  assert.ok(verPreviewPedido(sid), 'el snapshot sobrevive a la pregunta');
  // Turno 2: ahora sí confirma.
  assert.strictEqual(esConfirmacionVerbal('Sí'), true);
  const snap = consumirPreviewPedido(sid);
  assert.ok(snap, 'debía poder confirmarse después de preguntar');
  assert.strictEqual(snap.ts, idOriginal, 'debe ser EL MISMO snapshot, no uno nuevo');
  assert.strictEqual(snap.total, 255);
  const antes = folios.length;
  const pedido = await registrarDesde(snap);
  assert.strictEqual(folios.length, antes + 1, 'exactamente un pedido');
  assert.strictEqual(Number(pedido.total), 255);
  assert.ok(/^XAB-\d+/.test(pedido.id), 'folio real');
});
await t('O. "¿me los puedes cambiar a rojos?" SÍ invalida (pregunta pero muta)', async () => {
  const sid = 'det-O'; nuevaSesion(sid);
  guardarPreviewPedido(sid, snapshotDe(await previewOk()));
  assert.strictEqual(esMutacionDePedido('¿me los puedes cambiar a rojos?'), true,
    'una pregunta que pide un cambio ES mutación');
  assert.strictEqual(esConfirmacionVerbal('¿me los puedes cambiar a rojos?'), false);
  invalidarPreviewPedido(sid);                       // lo que hace brain
  assert.strictEqual(verPreviewPedido(sid), null, 'el snapshot debía invalidarse');
});
await t('O2. mutaciones declarativas invalidan; "Sí, pero cámbiale…" no confirma', () => {
  for (const s of ['Mejor ponlos rojos', 'Quita el queso', 'Agrega otro',
                   'Será a domicilio', 'Cambia la proteína', 'No', 'No gracias',
                   'Así no', 'No, mejor roja']) {
    assert.strictEqual(esMutacionDePedido(s), true, `"${s}" debía invalidar el snapshot`);
    assert.strictEqual(esConfirmacionVerbal(s), false, `"${s}" NUNCA debe confirmar`);
  }
  assert.strictEqual(esConfirmacionVerbal('Sí, pero cámbiale la salsa'), false);
});

// ═══ CASOS P–V — INDETERMINADO = FAIL-CLOSED ════════════════════════════════
// Una frase que podría cambiar el pedido pero que ningún detector léxico
// razonable reconoce NO puede tratarse como consulta: el snapshot se conserva
// (el flujo normal aún puede resolverlo) pero deja de ser confirmable.
const INDETERMINADAS = [
  ['P', 'Los quiero rojos'],
  ['Q', 'Hazlos rojos'],
  ['R', 'Ponlos rojos'],
  ['S', 'Quiero pollo en el segundo'],
  ['S2', 'Quiero recogerlo más tarde'],
];
for (const [etiqueta, frase] of INDETERMINADAS) {
  await t(`${etiqueta}. "${frase}" → el snapshot viejo NO puede confirmarse`, async () => {
    const sid = `det-${etiqueta}`; nuevaSesion(sid);
    guardarPreviewPedido(sid, snapshotDe(await previewOk()));
    const clase = clasificarTurnoPostPreview(frase);
    assert.ok(clase === 'indeterminado' || clase === 'mutacion',
      `"${frase}" no puede clasificarse como consulta segura (fue ${clase})`);
    assert.strictEqual(esConsultaNoMutante(frase), false, 'jamás debe pasar por consulta segura');
    // Lo que hace brain según la clase:
    if (clase === 'mutacion') invalidarPreviewPedido(sid); else marcarPreviewNoConfirmable(sid);
    // En AMBOS casos, un "Sí" posterior no puede registrar el pedido viejo.
    assert.strictEqual(consumirPreviewPedido(sid), null,
      'el snapshot posiblemente obsoleto NO debe poder registrarse');
    assert.strictEqual(getSession(sid).awaitingConfirmacion, false, 'no debe seguir esperando confirmación');
  });
}
await t('T. indeterminado + "Sí" → NO registra hasta que haya un preview nuevo', async () => {
  const sid = 'det-T'; nuevaSesion(sid);
  guardarPreviewPedido(sid, snapshotDe(await previewOk()));
  // Frase que nunca hemos visto y que podría cambiar el pedido.
  assert.strictEqual(clasificarTurnoPostPreview('que sean para las 3 con todo aparte'), 'indeterminado');
  marcarPreviewNoConfirmable(sid);
  // El "Sí" llega, pero el snapshot ya no es confirmable.
  assert.strictEqual(esConfirmacionVerbal('Sí'), true);
  assert.strictEqual(consumirPreviewPedido(sid), null, 'no puede registrarse sin resolver el turno');
  assert.ok(getSession(sid).pedidoPreview, 'el snapshot NO se borra: el flujo puede repreviewar');
  // Un preview nuevo lo rehabilita (§4: la orden estructurada gana).
  guardarPreviewPedido(sid, snapshotDe(await previewOk()));
  const snap = consumirPreviewPedido(sid);
  assert.ok(snap, 'tras el nuevo preview sí puede confirmarse');
  assert.strictEqual(snap.total, 255);
});
await t('U. "¿Cuánto tarda?" → "Sí" SÍ registra el snapshot original', async () => {
  const sid = 'det-U'; nuevaSesion(sid);
  guardarPreviewPedido(sid, snapshotDe(await previewOk()));
  const tsOriginal = verPreviewPedido(sid).ts;
  assert.strictEqual(clasificarTurnoPostPreview('¿Cuánto tarda?'), 'consulta_segura');
  // brain no toca nada ante consulta segura.
  assert.strictEqual(verPreviewPedido(sid).confirmable, true);
  const snap = consumirPreviewPedido(sid);
  assert.ok(snap && snap.ts === tsOriginal, 'debe registrarse EL MISMO snapshot');
  const antes = folios.length;
  const pedido = await registrarDesde(snap);
  assert.strictEqual(folios.length, antes + 1);
  assert.strictEqual(Number(pedido.total), 255);
});
await t('V. "¿Y la promo?" → "Sí" SÍ registra el snapshot original', async () => {
  const sid = 'det-V'; nuevaSesion(sid);
  guardarPreviewPedido(sid, snapshotDe(await previewOk()));
  const tsOriginal = verPreviewPedido(sid).ts;
  assert.strictEqual(clasificarTurnoPostPreview('¿Y la promo?'), 'consulta_segura');
  assert.strictEqual(getSession(sid).awaitingConfirmacion, true);
  const snap = consumirPreviewPedido(sid);
  assert.ok(snap && snap.ts === tsOriginal, 'debe registrarse EL MISMO snapshot');
  const pedido = await registrarDesde(snap);
  assert.strictEqual(Number(pedido.total), 255);
  assert.ok(/^XAB-\d+/.test(pedido.id));
});
await t('W. las 4 clases son excluyentes y el default es INDETERMINADO', () => {
  assert.strictEqual(clasificarTurnoPostPreview('Sí'), 'confirmacion');
  assert.strictEqual(clasificarTurnoPostPreview('quita el queso'), 'mutacion');
  assert.strictEqual(clasificarTurnoPostPreview('¿aceptan tarjeta?'), 'consulta_segura');
  assert.strictEqual(clasificarTurnoPostPreview('mmm ándale pues va'), 'indeterminado');
  assert.strictEqual(clasificarTurnoPostPreview(''), 'indeterminado');
});

// ═══ T2/T3 — `confirmable=false` ES AUTORIDAD PARA TODOS LOS CAMINOS ════════
// El camino legacy (<ORDEN_CONFIRMADA> emitida por el modelo) leía el total del
// snapshot directamente: con uno marcado no-confirmable, una orden del mismo
// total volvía a pasar por 'registrar'. Eso era un bypass del fail-closed.
await t('T2. snapshot no confirmable + <ORDEN_CONFIRMADA> del mismo total → NO registra', async () => {
  const sid = 'det-T2'; nuevaSesion(sid);
  const v = await previewOk();                       // P1 = $255
  guardarPreviewPedido(sid, snapshotDe(v));
  assert.strictEqual(verPreviewConfirmable(sid).total, 255);
  // El cliente dice "Los quiero rojos" → indeterminado.
  assert.notStrictEqual(clasificarTurnoPostPreview('Los quiero rojos'), 'consulta_segura');
  marcarPreviewNoConfirmable(sid);
  // El modelo emite ERRÓNEAMENTE una ORDEN_CONFIRMADA equivalente a P1.
  const snapConfirmable = verPreviewConfirmable(sid);
  assert.strictEqual(snapConfirmable, null, 'un snapshot no confirmable NO puede autorizar');
  const d = decidirConfirmacion({
    canal: 'whatsapp',
    prevTotal: snapConfirmable?.total,                // undefined: no hay autoridad
    nuevoTotal: v.preview.total,                      // 255, idéntico
    prevFingerprint: snapConfirmable?.fingerprint,
    nuevoFingerprint: huella(v.orden),
  });
  assert.notStrictEqual(d.accion, 'registrar', 'CERO escritura: no puede terminar en registrar');
  assert.strictEqual(d.accion, 'preview_requerido', 'debe exigir un preview nuevo');
  // Y el snapshot viejo sigue sin poder consumirse ni reactivarse solo.
  assert.strictEqual(consumirPreviewPedido(sid), null, 'CERO folio desde P1');
});
await t('T3. mismo total NO es prueba de identidad: contenido distinto → reconfirmar', async () => {
  const v1 = await previewOk();                       // Verde + Roja, $255
  // Pedido DISTINTO que cuesta exactamente lo mismo: se invierten las salsas.
  const ordenB = { ...ORDEN, items: [
    { nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [
      { grupo: 'Salsa', opciones: ['Roja'] },
      { grupo: 'Guarniciones', opciones: ['Bistec en Salsa', 'Queso Panela en Salsa'] }] },
    { nombre: 'Chilaquiles Sencillos', cantidad: 1, modificadores: [
      { grupo: 'Salsa', opciones: ['Verde'] },
      { grupo: 'Guarniciones', opciones: ['Frijolitos naturales', 'Papas con chorizo'] }] },
  ] };
  const v2 = await previsualizarPedido(ordenB, NEG, { canal: 'whatsapp' });
  assert.ok(v2.ok);
  assert.strictEqual(v2.preview.total, v1.preview.total, 'el fixture debe costar lo mismo');
  assert.notStrictEqual(huella(v1.orden), huella(v2.orden),
    'la huella DEBE distinguir dos pedidos con el mismo total');
  const d = decidirConfirmacion({
    canal: 'whatsapp',
    prevTotal: v1.preview.total, nuevoTotal: v2.preview.total,   // iguales
    prevFingerprint: huella(v1.orden), nuevoFingerprint: huella(v2.orden),
  });
  assert.strictEqual(d.accion, 'reconfirmar_cambio',
    'con el mismo total pero contenido distinto NO puede registrarse en silencio');
});
await t('T3b. la huella varía con producto, cantidad, modificador y modalidad', async () => {
  const base = (await previewOk()).orden;
  const h0 = huella(base);
  const cambiarCantidad = { ...base, items: [{ ...base.items[0], cantidad: 2 }, base.items[1]] };
  const cambiarModalidad = { ...base, modalidad: 'entrega a domicilio' };
  const cambiarPago = { ...base, forma_pago: 'terminal' };
  const quitarItem = { ...base, items: [base.items[0]] };
  assert.notStrictEqual(huella(cambiarCantidad), h0, 'la cantidad debe cambiar la huella');
  assert.notStrictEqual(huella(cambiarModalidad), h0, 'la modalidad debe cambiar la huella');
  assert.notStrictEqual(huella(cambiarPago), h0, 'la forma de pago debe cambiar la huella');
  assert.notStrictEqual(huella(quitarItem), h0, 'quitar un producto debe cambiar la huella');
  assert.strictEqual(huella(base), h0, 'la huella debe ser estable para el mismo pedido');
});
await t('T4. igualdad de total + MISMO contenido sí registra (no se rompe el camino feliz)', async () => {
  const v = await previewOk();
  const d = decidirConfirmacion({
    canal: 'whatsapp',
    prevTotal: v.preview.total, nuevoTotal: v.preview.total,
    prevFingerprint: huella(v.orden), nuevoFingerprint: huella(v.orden),
  });
  assert.strictEqual(d.accion, 'registrar');
});
await t('T5. un preview NUEVO rehabilita: solo P2 puede confirmarse', async () => {
  const sid = 'det-T5'; nuevaSesion(sid);
  guardarPreviewPedido(sid, snapshotDe(await previewOk()));      // P1
  marcarPreviewNoConfirmable(sid);
  assert.strictEqual(verPreviewConfirmable(sid), null, 'P1 no confirmable');
  const v2 = await previewOk();                                   // P2
  const p2 = guardarPreviewPedido(sid, snapshotDe(v2));
  assert.strictEqual(p2.confirmable, true, 'P2 nace confirmable');
  assert.ok(verPreviewConfirmable(sid), 'ahora sí hay autoridad');
  const snap = consumirPreviewPedido(sid);
  assert.strictEqual(snap.ts, p2.ts, 'se confirma P2, nunca P1');
});

// ═══ Regresión: el snapshot NO salta validaciones ═══════════════════════════
await t('I. el snapshot revalida por el pipeline oficial (no es un atajo)', async () => {
  const v = await previewOk();
  const snap = snapshotDe(v);
  // Revalidar el mismo snapshot debe dar el MISMO total oficial.
  const re = await previsualizarPedido(snap.ordenCanonica, NEG, { canal: 'whatsapp' });
  assert.ok(re.ok);
  assert.strictEqual(re.preview.total, snap.total, 'la revalidación debe reproducir el total');
  assert.strictEqual(re.preview.descuento_total, 195, 'la promo se recalcula, no se copia del snapshot');
});

// ── Limpieza ────────────────────────────────────────────────────────────────
for (const f of folios) await pool.query(`DELETE FROM pedidos_activos WHERE folio=$1`, [f]).catch(() => {});

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
await pool.end();
process.exitCode = fallidas > 0 ? 1 : 0;
