// Reversa del emparejamiento a partir del JSON de respaldo que dejó alinear.
//
//   node scripts/ops/lista-unica-2026-10/revertir.mjs <alinear-ANTES-....json>            (simulacro)
//   node scripts/ops/lista-unica-2026-10/revertir.mjs <alinear-ANTES-....json> --aplicar
//
// Devuelve cada fila de whatsapp_productos a como estaba (publicado, origen y
// autor) y borra las que el emparejamiento creó. `updated_at` queda con la
// hora de la reversa: lo fija el trigger set_updated_at. OJO: con el código de
// la lista única, el siguiente cambio en la tienda de ese producto lo vuelve a
// igualar; revertir del todo es también desplegar el binario anterior.
import { readFileSync } from 'node:fs';
import { enTransaccion, opciones } from './comun.mjs';

const opts = opciones();
const archivo = opts.posicionales[0];
if (!archivo) { console.error('Falta el archivo de respaldo'); process.exit(1); }
const antes = JSON.parse(readFileSync(archivo, 'utf8'));
if (antes.tipo !== 'lista-unica-alinear' || !Array.isArray(antes.filas)) {
  console.error('El archivo no es un respaldo de alinear-whatsapp-con-tienda'); process.exit(1);
}

await enTransaccion('revertir', async (c) => {
  await c.query('LOCK TABLE whatsapp_productos IN SHARE ROW EXCLUSIVE MODE');
  let restauradas = 0, borradas = 0;
  for (const f of antes.filas) {
    if (f.existia) {
      const { rowCount } = await c.query(
        `UPDATE whatsapp_productos SET publicado = $3, origen = $4, actualizado_por = $5
          WHERE negocio_id = $1 AND producto_id = $2`,
        [f.negocio_id, f.producto_id, f.publicado, f.origen, f.actualizado_por]);
      restauradas += rowCount;
    } else {
      const { rowCount } = await c.query(
        'DELETE FROM whatsapp_productos WHERE negocio_id = $1 AND producto_id = $2', [f.negocio_id, f.producto_id]);
      borradas += rowCount;
    }
  }
  console.log(`restauradas ${restauradas} filas; borradas ${borradas} creadas por el emparejamiento (de ${antes.filas.length} en el respaldo)`);
}, opts);
