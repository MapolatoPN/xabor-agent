// ─── La identidad del folio: reclamada, no consultada ───────────────────────
//
// DOS AGUJEROS QUE ESTA SUITE CIERRA
//
// (A) LA EXCEPCIÓN DE PROGRAMADOS ERA POR FOLIO A SECAS. La 060 dejaba pasar
//     cualquier INSERT cuyo folio estuviera reservado por un programado sin
//     activar. Eso demuestra "alguien reservó este número", NO "este INSERT es
//     la activación de ESA reserva". Un pedido cualquiera, de otro cliente y
//     hasta de otro negocio, entraba por esa puerta.
//
// (B) LA BARRERA MIRABA SOLO `pedidos`. La 059 ya reconocía que un folio puede
//     sobrevivir en 12 tablas distintas, porque este sistema tuvo persistencias
//     best-effort y las fuentes divergen. Medido al aplicar la 061: el ledger
//     reclama 1396 folios, frente a los 1255 que veía la barrera anterior --
//     141 folios que eran reutilizables.
//
// LA SOLUCIÓN (061): la pregunta deja de ser "¿aparece en alguna tabla?" y pasa
// a ser "¿ya fue reclamado, y por quién?". `folios_pedido_usados` con el folio
// como PRIMARY KEY, y el claim es un INSERT ... ON CONFLICT DO NOTHING:
// atómico, sin ventana entre comprobar y actuar.
//
// La reserva de un programado lleva `programado_id`, que viaja también dentro
// de `datos` del pedido. Solo el INSERT que lo presente puede consumirla.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const { pool, guardarPedidoProgramado } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(nombre); }
}

const NEG = SEED.negocioA;
const NEG_B = SEED.negocioB;
const marca = String(Date.now()).slice(-7);
const FOLIOS = [];
const folioNuevo = (p) => { const f = `XAB-${p}${marca}`; FOLIOS.push(f); return f; };

/** El INSERT literal de `guardarPedidoActivo` (database.js:1859). */
async function guardarPedidoActivoComoProduccion(folio, negocioId, datos = {}) {
  const r = await pool.query(
    `INSERT INTO pedidos_activos (folio, estado, datos, negocio_id)
     VALUES ($1,'nuevo',$2::jsonb,$3)
     ON CONFLICT (folio) DO NOTHING
     RETURNING folio`,
    [folio, JSON.stringify({ id: folio, ...datos }), negocioId]);
  return { ok: true, insertado: r.rowCount === 1, conflicto: r.rowCount !== 1 };
}

const reclamado = async (folio) => (await pool.query(
  `SELECT * FROM folios_pedido_usados WHERE folio = $1`, [folio])).rows[0] || null;

async function reservarProgramado(folio, negocioId, cuando = '1 hour') {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO pedidos_programados (folio, datos, programado_para, negocio_id, activado, programado_id)
     VALUES ($1,$2::jsonb, NOW() + $3::interval, $4, FALSE, $5)
     ON CONFLICT (folio) DO NOTHING`,
    [folio, JSON.stringify({ id: folio, negocioId, programado_id: id }), cuando, negocioId, id]);
  await pool.query(
    `INSERT INTO folios_pedido_usados (folio, negocio_id, estado, programado_id, origen)
     VALUES ($1,$2,'reserva_programado',$3,'test')
     ON CONFLICT (folio) DO NOTHING`, [folio, negocioId, id]);
  return id;
}

async function limpiar() {
  for (const f of FOLIOS) {
    await pool.query(`DELETE FROM pedidos_activos WHERE folio = $1`, [f]);
    await pool.query(`DELETE FROM pedidos_programados WHERE folio = $1`, [f]);
    await pool.query(`DELETE FROM folios_pedido_usados WHERE folio = $1`, [f]);
    await pool.query(`DELETE FROM pagos WHERE pedido_folio = $1`, [f]);
    await pool.query(`DELETE FROM impresion_trabajos WHERE origen_id = $1`, [f]);
    await pool.query(`DELETE FROM pedidos WHERE folio = $1`, [f]);
  }
}

try {
  await limpiar();

  // ═══ (A) IDENTIDAD DE LA RESERVA ═════════════════════════════════════════
  await t('1. un pedido AJENO no entra por la puerta de un programado reservado', async () => {
    // Con la 060 esto pasaba: bastaba que el folio estuviera reservado.
    const F = folioNuevo('91');
    await reservarProgramado(F, NEG);

    const r = await guardarPedidoActivoComoProduccion(F, NEG, { cliente: { nombre: 'Intruso' } });
    assert.strictEqual(r.insertado, false,
      'un pedido cualquiera entro usando la reserva de un programado ajeno');
    assert.strictEqual(r.conflicto, true);

    // Y la reserva sigue intacta, esperando a su dueño.
    const c = await reclamado(F);
    assert.strictEqual(c.estado, 'reserva_programado',
      'el intento ajeno consumio la reserva');
  });

  await t('2. la activación con SU identidad sí entra, y consume la reserva', async () => {
    const F = folioNuevo('92');
    const id = await reservarProgramado(F, NEG);

    const r = await guardarPedidoActivoComoProduccion(F, NEG, { programado_id: id });
    assert.strictEqual(r.insertado, true,
      'la activacion legitima quedo bloqueada: la barrera rompe los programados');

    const c = await reclamado(F);
    assert.strictEqual(c.estado, 'usado', 'la reserva no se consumio al activarse');
  });

  await t('3. una SEGUNDA activación del mismo programado ya no pasa', async () => {
    const F = folioNuevo('93');
    const id = await reservarProgramado(F, NEG);
    assert.strictEqual((await guardarPedidoActivoComoProduccion(F, NEG, { programado_id: id })).insertado, true);

    await pool.query(`DELETE FROM pedidos_activos WHERE folio = $1`, [F]);   // purga del tablero
    const otra = await guardarPedidoActivoComoProduccion(F, NEG, { programado_id: id });
    assert.strictEqual(otra.insertado, false,
      'la reserva se pudo consumir dos veces: la exencion no era de un solo uso');
  });

  await t('4. la reserva del negocio A no autoriza un pedido del negocio B', async () => {
    const F = folioNuevo('94');
    const id = await reservarProgramado(F, NEG);

    const r = await guardarPedidoActivoComoProduccion(F, NEG_B, { programado_id: id });
    assert.strictEqual(r.insertado, false,
      'un pedido de otro negocio entro presentando la identidad de la reserva');
  });

  await t('5. presentar un programado_id INVENTADO no abre la puerta', async () => {
    const F = folioNuevo('95');
    await reservarProgramado(F, NEG);

    for (const falso of [randomUUID(), 'no-es-un-uuid', '', null]) {
      const r = await guardarPedidoActivoComoProduccion(F, NEG, { programado_id: falso });
      assert.strictEqual(r.insertado, false,
        `entro presentando programado_id = ${JSON.stringify(falso)}`);
    }
  });

  // ═══ (B) LAS OTRAS FUENTES DE FOLIO ══════════════════════════════════════
  await t('6. folio huerfano SOLO en `pagos`: la barrera lo protege', async () => {
    // Sin fila en `pedidos` ni en `pedidos_activos`. Con la 060 este folio era
    // reutilizable y su historial de pagos se habria mezclado con otro pedido.
    const F = folioNuevo('96');
    await pool.query(
      `INSERT INTO pagos (negocio_id, pedido_folio, proveedor, monto, estado, referencia_interna)
       VALUES ($1,$2,'clip',100,'pendiente',$3)`, [NEG, F, `ref-${F}`]);
    await pool.query(
      `INSERT INTO folios_pedido_usados (folio, negocio_id, estado, origen)
       VALUES ($1,$2,'usado','pagos') ON CONFLICT (folio) DO NOTHING`, [NEG, F].reverse());

    const r = await guardarPedidoActivoComoProduccion(F, NEG);
    assert.strictEqual(r.insertado, false,
      `${F} solo existia en pagos y se pudo reutilizar`);
  });

  await t('7. folio huerfano SOLO en `impresion_trabajos`: igual', async () => {
    const F = folioNuevo('97');
    const { rows: [suc] } = await pool.query(
      `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,'ProgIdent')
       ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo=true RETURNING id`, [NEG]);
    await pool.query(
      `INSERT INTO impresion_trabajos
         (negocio_id, sucursal_id, impresora_nombre, documento, origen_tipo, origen_id,
          idempotency_key, estado, payload)
       VALUES ($1,$2,'Imp','comanda','pedido',$3,$4,'pendiente','{}'::jsonb)`,
      [NEG, suc.id, F, `k-${F}`]);
    await pool.query(
      `INSERT INTO folios_pedido_usados (folio, negocio_id, estado, origen)
       VALUES ($1,$2,'usado','impresion') ON CONFLICT (folio) DO NOTHING`, [F, NEG]);

    const r = await guardarPedidoActivoComoProduccion(F, NEG);
    assert.strictEqual(r.insertado, false,
      `${F} solo existia en impresion_trabajos y se pudo reutilizar`);
  });

  await t('8. el backfill de la 061 cubre las 12 fuentes, no solo `pedidos`', async () => {
    // Diente estructural: si alguien recorta el UNION, el ledger vuelve a ser
    // incompleto y los huerfanos de arriba se cuelan otra vez.
    const sql = readFileSync(join(__dirname, '..', 'migrations', '061_folios_usados_claim.sql'), 'utf8');
    for (const fuente of ['pedidos_activos', 'pedidos', 'pagos', 'compras_reales',
                          'tienda_pedidos', 'tienda_promocion_usos', 'notificaciones_repartidor',
                          'rewards_movements', 'oportunidades', 'restaurante_cuentas',
                          'impresion_trabajos']) {
      assert.ok(sql.includes(`FROM ${fuente} WHERE`),
        `el backfill del ledger dejo de mirar ${fuente}`);
    }
  });

  // ═══ CONCURRENCIA ════════════════════════════════════════════════════════
  await t('9. OLD y la activación del programado a la vez: una sola identidad gana', async () => {
    // La garantia critica es atomica: el claim es INSERT ... ON CONFLICT sobre
    // la PK, no un EXISTS seguido de INSERT con una ventana en medio.
    const F = folioNuevo('98');
    const id = await reservarProgramado(F, NEG);

    const [activacion, intruso] = await Promise.all([
      guardarPedidoActivoComoProduccion(F, NEG, { programado_id: id, quien: 'programado' }),
      guardarPedidoActivoComoProduccion(F, NEG, { quien: 'OLD' }),
    ]);

    const ganadores = [activacion, intruso].filter(r => r.insertado).length;
    assert.strictEqual(ganadores, 1, `${ganadores} escrituras ganaron el mismo folio`);
    assert.strictEqual(activacion.insertado, true,
      'gano el intruso en vez de la activacion legitima');

    const { rows } = await pool.query(
      `SELECT datos->>'quien' AS quien FROM pedidos_activos WHERE folio = $1`, [F]);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].quien, 'programado');
  });

  await t('10. 20 intentos simultaneos del mismo folio: exactamente uno entra', async () => {
    const F = folioNuevo('99');
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      guardarPedidoActivoComoProduccion(F, NEG, { intento: i })));
    assert.strictEqual(rs.filter(r => r.insertado).length, 1,
      'la carrera dejo pasar mas de una escritura sobre el mismo folio');
  });

  // ═══ POLÍTICA CONSERVADORA ═══════════════════════════════════════════════
  await t('11. programado cuyo folio YA fue de otro pedido: fail closed', async () => {
    // Caso B de la clasificación: el registro histórico pertenece a otro pedido
    // antiguo. Reutilizar ese número rompería panel, impresión, pagos y compras,
    // y no hay forma de demostrar que la fila histórica sea suya. El programado
    // queda bloqueado a propósito y necesita reemisión manual de folio.
    const F = folioNuevo('90');
    await pool.query(
      `INSERT INTO folios_pedido_usados (folio, negocio_id, estado, origen)
       VALUES ($1,$2,'usado','otro_pedido')`, [F, NEG]);

    const id = randomUUID();
    await pool.query(
      `INSERT INTO pedidos_programados (folio, datos, programado_para, negocio_id, activado, programado_id)
       VALUES ($1,$2::jsonb, NOW(), $3, FALSE, $4) ON CONFLICT (folio) DO NOTHING`,
      [F, JSON.stringify({ id: F, programado_id: id }), NEG, id]);

    const r = await guardarPedidoActivoComoProduccion(F, NEG, { programado_id: id });
    assert.strictEqual(r.insertado, false,
      'un programado con folio ya usado por otro pedido logro activarse');
  });

  await t('12. el scheduler NO ignora el resultado de guardarPedidoActivo', async () => {
    // Diente estructural sobre el contrato: si vuelve a ignorarlo, la base
    // guardaria el pedido ajeno mientras memoria, panel y papel muestran el
    // programado -- el mismo folio nombrando dos cosas distintas.
    const src = readFileSync(join(__dirname, '..', 'src', 'server.js'), 'utf8');
    const i = src.indexOf('async function activarPedidosProgramados');
    const bloque = src.slice(i, i + 6000);
    assert.ok(/const\s+guardado\s*=\s*await\s+guardarPedidoActivo/.test(bloque),
      'el scheduler volvio a descartar el retorno de guardarPedidoActivo');
    assert.ok(bloque.includes('programado_folio_ocupado'),
      'el scheduler ya no distingue el caso de folio ocupado por otro pedido');
    assert.ok(!/El retorno se ignora a propósito/.test(bloque),
      'volvio el comentario que justificaba ignorar el retorno');
  });

  // ═══ MUTACION 10 (P0-15D): la reparacion NO puede volverse ambigua ═════
  await t('13. la reparacion de la 062 NO convierte un claim historico junto a un programado', async () => {
    // Ejecuta el UPDATE de reparacion REAL, extraido del archivo de migracion
    // (mismo patron que fase-backfill-058-folio-reciclado.mjs): si alguien
    // recorta el filtro por origen, esta prueba lo nota.
    const sql = readFileSync(join(__dirname, '..', 'migrations', '062_conversion_reserva_programada.sql'), 'utf8');
    const i = sql.indexOf('-- ─── REPARACIÓN, con el filtro correcto');
    const iUpdate = sql.indexOf('UPDATE folios_pedido_usados f', i);
    const fin = sql.indexOf(';', iUpdate);
    const reparacion = sql.slice(iUpdate, fin + 1);
    assert.ok(reparacion.includes("f.origen = 'pedido_activo'"),
      'la reparacion dejo de exigir origen=pedido_activo: se reintrodujo P0-15D');

    const F = folioNuevo('89');
    await pool.query(
      `INSERT INTO folios_pedido_usados (folio, negocio_id, estado, origen)
       VALUES ($1,$2,'usado','backfill_061')`, [F, NEG]);
    const id = randomUUID();
    await pool.query(
      `INSERT INTO pedidos_programados (folio, datos, programado_para, negocio_id, activado, programado_id)
       VALUES ($1,$2::jsonb, NOW() + interval '1 hour', $3, FALSE, $4)`,
      [F, JSON.stringify({ id: F, programado_id: id }), NEG, id]);

    await pool.query(reparacion);

    const c = await reclamado(F);
    assert.strictEqual(c.estado, 'usado',
      'la reparacion convirtio un claim historico junto a un programado pendiente');
  });

  // ═══ MUTACION 11: el caller no puede ignorar ok:false ═══════════════════
  await t('14. los callers de canal NO ignoran el resultado de guardarPedidoProgramado', async () => {
    // Diente estructural: antes se llamaba a `eliminarPedido` por separado sin
    // mirar el resultado. Ahora la transicion es una sola llamada atomica y el
    // caller tiene que comprobar `conv.ok` / `r.ok` antes de confirmar al
    // cliente. Si vuelve a ignorarse, un crash a mitad de camino podria dejar
    // el pedido activo mientras se le confirma al cliente que quedo programado.
    for (const archivo of ['whatsapp-meta.js', 'voice.js']) {
      const ruta = join(__dirname, '..', 'src', 'channels', archivo);
      const src = readFileSync(ruta, 'utf8');
      const i = src.indexOf('guardarPedidoProgramado(pedido.id');
      assert.ok(i > 0, `${archivo} ya no llama a guardarPedidoProgramado`);
      const bloque = src.slice(i, i + 700);
      assert.ok(!/eliminarPedido\(pedido\.id/.test(bloque),
        `${archivo} vuelve a llamar a eliminarPedido por separado: la transicion dejo de ser atomica`);
      assert.ok(/\.ok/.test(bloque),
        `${archivo} no comprueba el resultado (.ok) antes de continuar`);
    }
  });

  // ═══ MUTACION 12 (P0-15E): un crash a mitad de la transicion no deja hibrido ═══
  await t('15. RECOVERY: fallo justo tras crear el programado -- el activo SIGUE activo', async () => {
    const F = folioNuevo('88');
    await pool.query(
      `INSERT INTO pedidos_activos (folio, estado, datos, negocio_id) VALUES ($1,'nuevo','{}'::jsonb,$2)`,
      [F, NEG]);

    const { rows: [r] } = await pool.query(
      `SELECT resultado, programado_id FROM xabor_activo_a_programado($1,$2,$3,NOW()+interval '1h',$4)`,
      [F, NEG, JSON.stringify({ id: F, negocioId: NEG }), 'tras_insert_programado'])
      .catch(e => ({ rows: [{ resultado: 'excepcion', mensaje: e.message }] }));
    assert.ok(r.resultado === 'excepcion' || /fallo inyectado/.test(r.mensaje || ''),
      'el fallo inyectado no interrumpio la funcion: revisar el punto de inyeccion');

    // LA GARANTIA: Postgres revirtio la transaccion ENTERA. Nada a medio camino.
    const activo = await pool.query(`SELECT 1 FROM pedidos_activos WHERE folio=$1`, [F]);
    assert.strictEqual(activo.rowCount, 1,
      'el activo desaparecio pese a que la transaccion nunca confirmo');
    const prog = await pool.query(`SELECT 1 FROM pedidos_programados WHERE folio=$1`, [F]);
    assert.strictEqual(prog.rowCount, 0,
      'quedo un programado durable pese a que la transaccion se revirtio entera');
    const led = await pool.query(`SELECT estado FROM folios_pedido_usados WHERE folio=$1`, [F]);
    assert.strictEqual(led.rows[0]?.estado, 'usado',
      'el claim se movio pese a que la transaccion se revirtio');

    // Y un RETRY normal, sin el fallo, converge sin dejar rastro del intento.
    const retry = await guardarPedidoProgramado(F, { id: F, negocioId: NEG }, new Date(Date.now() + 3600e3));
    assert.strictEqual(retry.ok, true, 'el retry tras el crash no logro converger');
  });

  await t('16. RECOVERY: fallo justo despues de mover el claim -- sigue sin hibrido', async () => {
    const F = folioNuevo('87');
    await pool.query(
      `INSERT INTO pedidos_activos (folio, estado, datos, negocio_id) VALUES ($1,'nuevo','{}'::jsonb,$2)`,
      [F, NEG]);

    await pool.query(
      `SELECT resultado FROM xabor_activo_a_programado($1,$2,$3,NOW()+interval '1h',$4)`,
      [F, NEG, JSON.stringify({ id: F, negocioId: NEG }), 'tras_conversion_claim'])
      .catch(() => {});

    const activo = await pool.query(`SELECT 1 FROM pedidos_activos WHERE folio=$1`, [F]);
    assert.strictEqual(activo.rowCount, 1,
      'el activo se retiro pese a que la transaccion se revirtio');
    const led = await pool.query(`SELECT estado FROM folios_pedido_usados WHERE folio=$1`, [F]);
    assert.strictEqual(led.rows[0]?.estado, 'usado',
      'el claim quedo movido pese a que la transaccion se revirtio');

    const retry = await guardarPedidoProgramado(F, { id: F, negocioId: NEG }, new Date(Date.now() + 3600e3));
    assert.strictEqual(retry.ok, true, 'el retry tras el crash no logro converger');
  });

  // ═══ E2E: EL FLUJO PRODUCTIVO REAL, DE PUNTA A PUNTA ════════════════════
  await t('17. E2E productivo: activo -> guardarPedidoProgramado -> activacion dias despues', async () => {
    // A diferencia de los casos 1-12 (que fabrican la reserva directamente en
    // folios_pedido_usados/pedidos_programados para aislar la barrera), este
    // caso corre el camino ENTERO que usan whatsapp-meta.js y voice.js: un
    // pedido activo real, reclamado por el mismo trigger que usa produccion
    // (origen='pedido_activo'), convertido por la MISMA funcion JS que llaman
    // los canales -- ni un INSERT directo a folios_pedido_usados.
    const F = folioNuevo('86');
    await pool.query(
      `INSERT INTO pedidos_activos (folio, estado, datos, negocio_id)
       VALUES ($1,'nuevo',$2::jsonb,$3)`,
      [F, JSON.stringify({ id: F, negocioId: NEG }), NEG]);

    // El trigger de la 061 debio reclamarlo en vivo, con la firma que la 062
    // exige para poder convertirlo despues.
    const antes = await reclamado(F);
    assert.strictEqual(antes?.estado, 'usado', 'el INSERT no reclamo el folio');
    assert.strictEqual(antes?.origen, 'pedido_activo',
      'el claim no nacio con origen=pedido_activo: la conversion posterior fallaria');

    const conv = await guardarPedidoProgramado(F, { id: F, negocioId: NEG }, new Date(Date.now() + 3600e3));
    assert.strictEqual(conv.ok, true, `la conversion productiva fallo: ${conv.razon}`);
    assert.ok(conv.programadoId, 'la conversion no devolvio identidad de la reserva');

    // El activo se retiro, el programado quedo pendiente con esa identidad, y
    // el claim paso a reserva_programado -- las tres cosas en la MISMA
    // transaccion que ya prueban los casos 15/16 via inyeccion de fallos.
    const activo = await pool.query(`SELECT 1 FROM pedidos_activos WHERE folio=$1`, [F]);
    assert.strictEqual(activo.rowCount, 0, 'el activo sigue en el tablero tras la conversion');
    const { rows: [prog] } = await pool.query(
      `SELECT programado_id, datos->>'programado_id' AS datos_id FROM pedidos_programados WHERE folio=$1`, [F]);
    assert.strictEqual(prog.programado_id, conv.programadoId);
    assert.strictEqual(prog.datos_id, conv.programadoId,
      'la identidad no viajo dentro de datos: la activacion no podria presentarla');

    const despues = await reclamado(F);
    assert.strictEqual(despues.estado, 'reserva_programado', 'el claim no se movio a reserva');
    assert.strictEqual(despues.programado_id, conv.programadoId);

    // Dias despues: la activacion real, el MISMO guardarPedidoActivo de
    // siempre, presentando la identidad que guardarPedidoProgramado genero.
    const act = await guardarPedidoActivoComoProduccion(F, NEG, { programado_id: conv.programadoId });
    assert.strictEqual(act.insertado, true,
      'la activacion del flujo productivo real quedo bloqueada');
    const final = await reclamado(F);
    assert.strictEqual(final.estado, 'usado', 'la reserva no se consumio al activarse');
  });

} catch (e) {
  console.error('ERROR FATAL:', e.stack || e);
  fallidas++; fallos.push('ERROR FATAL');
} finally {
  await limpiar().catch(() => {});
  await pool.end().catch(() => {});
}

console.log(`\n═══ fase-folio-programados-identidad: ${pasadas} OK · ${fallidas} fallos ═══`);
if (fallos.length) { console.log('Fallos: ' + fallos.join(' | ')); }
process.exit(fallidas ? 1 : 0);
