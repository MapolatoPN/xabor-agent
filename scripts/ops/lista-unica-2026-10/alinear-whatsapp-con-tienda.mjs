// Empareja la lista de WhatsApp con la de la Tienda en línea: LA TIENDA MANDA.
//
//   node scripts/ops/lista-unica-2026-10/alinear-whatsapp-con-tienda.mjs                      (simulacro, todos)
//   node scripts/ops/lista-unica-2026-10/alinear-whatsapp-con-tienda.mjs --negocio=mapolato-obispado
//   node scripts/ops/lista-unica-2026-10/alinear-whatsapp-con-tienda.mjs --aplicar
//
// Lo publicado en WhatsApp que no está en la tienda queda en FALSE (la fila
// no se borra); lo publicado en la tienda que falta en WhatsApp se publica.
// Las filas tocadas quedan con origen 'siembra_tienda'. Respaldo previo en
// --respaldo=<dir>; reversa con revertir.mjs.
//
// Freno: si un negocio tiene carta de WhatsApp y su tienda no publica nada,
// el emparejamiento lo dejaría SIN carta y su bot dejaría de contestar. En
// ese caso aborta todo (excluirlo con --negocio=..., o --forzar).
import { enTransaccion, guardar, sello, SQL_DIFERENCIAS } from './comun.mjs';

await enTransaccion('alinear', async (c, { aplicar, forzar, negocios, respaldo }) => {
  // Nadie publica ni retira mientras se empareja.
  await c.query('LOCK TABLE tienda_productos, whatsapp_productos IN SHARE ROW EXCLUSIVE MODE');
  const { rows: filas } = await c.query(SQL_DIFERENCIAS, [negocios]);
  if (!filas.length) { console.log('Nada que emparejar: WhatsApp ya coincide con la tienda.'); return; }

  const slugs = [...new Set(filas.map(f => f.slug))];
  const { rows: cartas } = await c.query(
    `SELECT n.slug,
            count(*) FILTER (WHERE tp.publicado)::int AS tienda,
            count(*) FILTER (WHERE wp.publicado)::int AS whatsapp
       FROM negocios n
       JOIN menu_productos p ON p.negocio_id = n.id
       LEFT JOIN tienda_productos tp ON tp.negocio_id = p.negocio_id AND tp.producto_id = p.id
       LEFT JOIN whatsapp_productos wp ON wp.negocio_id = p.negocio_id AND wp.producto_id = p.id
      WHERE n.slug = ANY($1::text[]) GROUP BY n.slug`, [slugs]);
  for (const s of slugs) {
    const de = filas.filter(f => f.slug === s);
    const cta = cartas.find(x => x.slug === s) || { tienda: 0, whatsapp: 0 };
    const salen = de.filter(f => !f.tienda), entran = de.filter(f => f.tienda);
    console.log(`\n${s}: WhatsApp ${cta.whatsapp} -> ${cta.tienda} (tienda)`);
    if (salen.length) console.log(`  salen de WhatsApp (${salen.length}): ${salen.map(f => `${f.categoria} / ${f.nombre}`).join(' | ')}`);
    if (entran.length) console.log(`  entran a WhatsApp (${entran.length}): ${entran.map(f => `${f.categoria} / ${f.nombre}`).join(' | ')}`);
  }
  const sinCarta = cartas.filter(x => x.tienda === 0 && x.whatsapp > 0).map(x => x.slug);
  if (sinCarta.length && !forzar) {
    throw new Error(`quedarían SIN carta de WhatsApp (su tienda no publica nada): ${sinCarta.join(', ')}. ` +
      'Exclúyelos con --negocio=<los demás> o confirma con --forzar.');
  }

  if (aplicar) {
    const ruta = guardar(respaldo, `alinear-ANTES-${sello()}.json`,
      { tipo: 'lista-unica-alinear', negocios: slugs, filas });
    console.log(`\nrespaldo: ${ruta}`);
  }
  const { rowCount } = await c.query(
    `INSERT INTO whatsapp_productos (negocio_id, producto_id, publicado, origen)
     SELECT p.negocio_id, p.id, COALESCE(tp.publicado, FALSE), 'siembra_tienda'
       FROM menu_productos p
       JOIN negocios n ON n.id = p.negocio_id
       LEFT JOIN tienda_productos tp ON tp.negocio_id = p.negocio_id AND tp.producto_id = p.id
       LEFT JOIN whatsapp_productos wp ON wp.negocio_id = p.negocio_id AND wp.producto_id = p.id
      WHERE COALESCE(tp.publicado, FALSE) <> COALESCE(wp.publicado, FALSE)
        AND (cardinality($1::text[]) = 0 OR n.slug = ANY($1::text[]))
     ON CONFLICT (negocio_id, producto_id) DO UPDATE
       SET publicado = EXCLUDED.publicado, origen = 'siembra_tienda', updated_at = NOW()`,
    [negocios]);
  const { rows: quedan } = await c.query(SQL_DIFERENCIAS, [negocios]);
  if (quedan.length || rowCount !== filas.length) {
    throw new Error(`verificación: ${rowCount} escritas de ${filas.length} y ${quedan.length} diferencias restantes`);
  }
  console.log(`\n${rowCount} filas de WhatsApp emparejadas; diferencias restantes: 0.`);
});
