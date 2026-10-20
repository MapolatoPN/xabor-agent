// ─── /api/impresion/formato: el diseño del papel desde el panel ─────────────
//
// Lo usa Configuración → «Diseño de ticket y comanda». Solo administradores
// (server.js lo monta detrás de requireAdminSeguro, que fija req.negocioId).
//
//   GET  /               el diseño vigente (ya validado), el de fábrica y los
//                        datos del negocio que van en el encabezado del ticket
//   PUT  /               guarda { formato }; lo que no sea válido cae al de
//                        fábrica y se devuelve lo que quedó guardado
//   POST /vista-previa   { documento, formato, ancho } → los renglones que
//                        saldrían con un pedido de ejemplo; no guarda nada
//
// La vista previa usa EXACTAMENTE el mismo armado que el papel real: lo que el
// dueño ve en el panel es lo que imprime el Edge.
import { Router } from 'express';
import { formatoDeDocumento, normalizarFormato, FORMATO_POR_DEFECTO, FORMATO_CLAVE } from './index.js';
import { cargarDisenoDeNegocio, listarImpresoras } from '../../services/impresionService.js';
import { actualizarConfiguracion } from '../../services/database.js';

// 58 mm, 80 mm y 80 mm a todo el ancho del cabezal.
export const ANCHOS_VISTA = [32, 42, 48];

const EJEMPLO_COMANDA = Object.freeze({
  folio: 'XAB-0125', modalidad: 'recoger en tienda', cliente: 'Laura', impresora: 'Cocina',
  items: [
    { producto: 'Chilaquiles Sencillos', cantidad: 1, modificadores: ['Salsa: Verde', 'Proteína: Pechuga de pollo', 'Guarniciones: Frijolitos con chorizo'], notas: 'Sin cebolla' },
    { producto: 'Combito de Omelette', cantidad: 1, modificadores: ['Omelette: Clásico', 'Hotcakes o Waffles: Waffles', 'Topping: Miel y Mantequilla'], notas: null },
    { producto: 'Huevos Revueltos con Jamón', cantidad: 2, modificadores: ['Guarniciones: Frijolitos naturales'], notas: 'Guarniciones: Frijolitos naturales · bien cocidos' },
  ],
});
const EJEMPLO_TICKET = Object.freeze({
  mesa: 4, mesero: 'Karina', folio: 'RM-1A2B', ticketPagado: true,
  items: [
    { producto: 'Chilaquiles Sencillos', cantidad: 2, precioUnitario: 125, modificadores: ['Salsa: Verde', 'Proteína: Pechuga de pollo'], notas: null },
    { producto: 'Café Americano', cantidad: 2, precioUnitario: 35, modificadores: [] },
  ],
  subtotal: 320, descuento: 32, descuentoMotivo: 'Martes 2x1', total: 288,
  pagos: [{ metodo: 'efectivo', monto: 300 }], efectivoRecibido: 300, cambio: 12,
});

export const rutasFormato = Router();

rutasFormato.get('/', async (req, res) => {
  try {
    const diseno = await cargarDisenoDeNegocio(req.negocioId);
    const impresoras = await listarImpresoras(req.negocioId).catch(() => []);
    const anchos = [...new Set(impresoras.filter(i => i.activa).map(i => Number(i.ancho_columnas)))].filter(a => ANCHOS_VISTA.includes(a));
    res.json({
      formato: normalizarFormato(diseno.formato),
      porDefecto: normalizarFormato(null),
      negocio: diseno.negocio,
      anchos: ANCHOS_VISTA,
      anchoSugerido: anchos.includes(48) ? 48 : (anchos[0] || 42),
    });
  } catch (e) {
    console.error(`[Formato] GET negocio=${req.negocioId}: ${e.message}`);
    res.status(500).json({ error: 'No se pudo leer el diseño' });
  }
});

rutasFormato.put('/', async (req, res) => {
  const recibido = req.body?.formato;
  if (!recibido || typeof recibido !== 'object' || Array.isArray(recibido)) {
    return res.status(400).json({ error: 'Falta el diseño' });
  }
  const formato = normalizarFormato(recibido);
  const ok = await actualizarConfiguracion({ [FORMATO_CLAVE]: JSON.stringify(formato) }, req.negocioId);
  if (!ok) return res.status(500).json({ error: 'No se pudo guardar el diseño' });
  console.log(`[Formato] diseño guardado negocio=${req.negocioId} usuario=${req.usuarioId || '-'}`);
  res.json({ ok: true, formato });
});

rutasFormato.post('/vista-previa', async (req, res) => {
  try {
    const documento = req.body?.documento === 'cuenta' ? 'cuenta' : 'comanda';
    const ancho = ANCHOS_VISTA.includes(Number(req.body?.ancho)) ? Number(req.body.ancho) : 42;
    const diseno = await cargarDisenoDeNegocio(req.negocioId);
    const formato = normalizarFormato(req.body?.formato ?? diseno.formato);
    const emitidoAt = new Date().toISOString();
    const datos = documento === 'cuenta'
      ? { ...EJEMPLO_TICKET, emitidoAt }
      : { ...EJEMPLO_COMANDA, negocio: diseno.negocio.nombreCorto, emitidoAt };
    const f = formatoDeDocumento(documento, datos, { ancho, formato, negocio: diseno.negocio });
    if (!f) return res.status(500).json({ error: 'No se pudo armar la vista previa' });
    res.json({ documento, ancho, renglones: f.renglones });
  } catch (e) {
    console.error(`[Formato] vista previa negocio=${req.negocioId}: ${e.message}`);
    res.status(500).json({ error: 'No se pudo armar la vista previa' });
  }
});

export { FORMATO_POR_DEFECTO };
