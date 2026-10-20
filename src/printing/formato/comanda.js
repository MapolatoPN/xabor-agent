// ─── Comanda de cocina, armada en el servidor ───────────────────────────────
//
// Se lee de pie, a un metro y con las manos ocupadas. Arriba, en grande, lo
// que identifica el papel: el número de orden (o la mesa), el tipo de pedido
// y la hora. Luego cada platillo en el tamaño más grande que no lo parta, con
// sus opciones en lista, grandes y en negritas, y la nota resaltada. Sin
// precios. Las opciones de diseño vienen del negocio (ver opciones.js).
//
// Recibe los datos ORIGINALES (persona, «cambio de», nota del pedido por
// separado), no la nota mezclada que se arma para los Edge viejos.
import { parrafo, linea, espacio, corte, columnasDisponibles } from './maquetador.js';
import { FORMATO_POR_DEFECTO } from './opciones.js';
import { lineasDeModificadores, notaSinModificadores } from '../../../edge/renderers/modificadores.js';
import { agruparPorPersona, tituloPersona } from '../../../edge/renderers/personas.js';

// Con 24 letras en letra doble caben casi todos los platillos («1 CHILAQUILES
// SENCILLOS» = 23). Menos que eso partiría la mayoría: se usa letra alta.
const COLUMNAS_PRODUCTO_DOBLE = 24;
const ZONA = 'America/Matamoros';

export function horaDe(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('es-MX', { timeZone: ZONA, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

// «XAB-0207» → «#207». Otros folios salen tal cual.
export function numeroDeOrden(folio) {
  const f = String(folio ?? '').trim();
  const m = /^XAB-0*(\d+)$/i.exec(f);
  return m ? `#${m[1]}` : f;
}

export function tipoDePedido(modalidad) {
  const m = String(modalidad ?? '').toLowerCase();
  if (m.includes('domicilio')) return 'DOMICILIO';
  if (m.includes('recoger')) return 'PARA RECOGER';
  if (m.includes('llevar')) return 'PARA LLEVAR';
  if (m.includes('mesa') || m.includes('sitio') || m.includes('aqu')) return 'COMER AQUÍ';
  return m ? m.toUpperCase() : 'PARA LLEVAR';
}

function sinGrupo(opcion) {
  return String(opcion).replace(/^[^:]{1,40}:\s*/, '');
}

export function renglonesDeComanda(d, { ancho = 42, formato = null } = {}) {
  const o = (formato && formato.comanda) || FORMATO_POR_DEFECTO.comanda;
  const R = [];
  const add = (...xs) => { for (const x of xs) Array.isArray(x) ? R.push(...x) : R.push(x); };
  const hora = horaDe(d.emitidoAt);

  if (o.negocio && d.negocio) add(parrafo(String(d.negocio).toUpperCase(), { tam: 'alto', negrita: true, alinear: 'centro' }, ancho));
  add(linea('='));
  if (d.mesa != null) {
    add(parrafo(`MESA ${d.mesa}`, { tam: o.tamOrden, negrita: true, alinear: 'centro' }, ancho));
    add(parrafo([d.ronda != null ? `RONDA ${d.ronda}` : null, hora].filter(Boolean).join(' · '),
      { tam: 'alto', negrita: true, alinear: 'centro' }, ancho));
  } else {
    if (d.folio) add(parrafo(numeroDeOrden(d.folio), { tam: o.tamOrden, negrita: true, alinear: 'centro' }, ancho));
    add(parrafo([tipoDePedido(d.modalidad), hora].filter(Boolean).join(' · '), { tam: 'alto', negrita: true, alinear: 'centro' }, ancho));
    // Negritas: es el nombre con el que se llama el pedido al entregarlo.
    if (o.cliente && d.cliente) add(parrafo(`Cliente: ${d.cliente}`, { tam: 'alto', negrita: true, alinear: 'centro' }, ancho));
  }
  if (o.mesero && d.mesero) add(parrafo(`Mesero: ${d.mesero}`, { alinear: 'centro' }, ancho));
  if (o.impresora && d.impresora) add(parrafo(String(d.impresora).toUpperCase(), { alinear: 'centro' }, ancho));
  add(linea('='));

  const aire = o.aire === 'auto' ? (ancho >= 48 ? 2 : 0) : o.aire;
  const resaltado = { tam: 'alto', negrita: true, invertido: o.notaInvertida === true, aire };
  if (d.notaPedido) add(espacio(1), parrafo(`NOTA DEL PEDIDO: ${d.notaPedido}`, resaltado, ancho));
  add(espacio(1));

  const tamProducto = o.producto === 'auto'
    ? (columnasDisponibles(ancho, { tam: 'doble' }) >= COLUMNAS_PRODUCTO_DOBLE ? 'doble' : 'alto')
    : o.producto;
  const items = Array.isArray(d.items) ? d.items : [];
  const separados = items.some(i => i.persona);
  for (const grupo of agruparPorPersona(items)) {
    if (separados) add(parrafo(tituloPersona(grupo.persona).toUpperCase(), { tam: 'alto', negrita: true }, ancho), linea('-'));
    for (const item of grupo.items) {
      add(parrafo(`${item.cantidad} ${String(item.producto ?? item.nombre ?? '').toUpperCase()}`, { tam: tamProducto, negrita: true }, ancho));
      if (item.en_lugar_de) add(parrafo(`CAMBIO DE: ${item.en_lugar_de}`, resaltado, ancho, { sangria: '  ' }));
      for (const m of lineasDeModificadores(item.modificadores)) {
        const texto = o.mostrarGrupo ? m : sinGrupo(m);
        add(parrafo(`> ${texto}`, { tam: o.modificadores, negrita: true, aire }, ancho, { sangria: '  ' }));
      }
      const nota = notaSinModificadores(item.notas, item.modificadores);
      if (nota) add(parrafo(`NOTA: ${nota}`, resaltado, ancho, { sangria: '  ' }));
      add(espacio(1));
    }
  }

  if (d.reimpresion) add(parrafo('*** REIMPRESION ***', { negrita: true, alinear: 'centro' }, ancho));
  add(linea('='), espacio(3), corte());
  return R;
}
