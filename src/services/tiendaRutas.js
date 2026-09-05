// Composición de rutas: conserva intacta la Tienda Online y monta Compras V1
// con la misma identidad multi-tenant ya resuelta por server.js.
//
// `tiendaRutasCore.js` es copia byte-a-byte del registrador existente en el
// commit base de esta rama. Este wrapper evita modificar server.js (que está
// siendo trabajado en paralelo por el bot) y mantiene el cambio aislado.
import { registrarRutasTienda as registrarRutasTiendaCore } from './tiendaRutasCore.js';
import { registrarRutasCompras } from './comprasRutas.js';

export function registrarRutasTienda(app, deps) {
  registrarRutasTiendaCore(app, deps);
  registrarRutasCompras(app, { requireAuthSeguro: deps.requireAuthSeguro });
}
