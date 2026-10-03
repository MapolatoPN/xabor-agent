import { randomUUID } from 'node:crypto';
import { fichaPorId, opcionesDeLinea } from './vistaDelPedido.js';
import { cardinalidadSeleccionable } from '../services/modificadores.js';
import { normalizarEleccion as norm } from './politicaDelTurno.js';
import { modalidadesDisponibles, etiquetaTipoModalidad } from '../orders/modalidadesDelPedido.js';
import { tiposDePagoDisponibles, etiquetaTipoPago } from './politicaDePagos.js';
import { iniciarSeleccion } from './seleccionDeProducto.js';
import { accionInteractiva } from './autoridadInteractiva.js';
import { esVerdadero } from '../orders/modoDelPedido.js';

export const eleccionesActivas = cfg => esVerdadero(cfg?.whatsapp_interactivos_elecciones_v1);
const precio = n => n != null && String(n).trim() && Number.isFinite(Number(n)) && Number(n) >= 0 ? Number(n) : null;
// JSONB reordena las claves de objetos al persistir. La igualdad es de
// estructura completa, independiente del orden de esas claves (no prefijos).
const canonico = v => Array.isArray(v) ? v.map(canonico) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k,canonico(v[k])])) : v;
const iguales = (a,b) => JSON.stringify(canonico(a)) === JSON.stringify(canonico(b));
const ordenadas = xs => [...xs].sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

export function grupoAbierto(estado, catalogo) {
  const abierto = estado.eleccionInteractiva;
  if (!abierto || abierto.ciclo !== estado.conversacionId) return null;
  const item = estado.carrito?.items?.find(i => i.lid === abierto.linea_id && String(i.id) === abierto.producto_id);
  const ficha = item && fichaPorId(catalogo,item.id);
  const grupo = ficha?.grupos.find(g => g.nombre === abierto.grupo);
  if (!grupo) return null;
  return { item, ficha, grupo, elegidas: opcionesDeLinea(item).filter(o => o.grupo === grupo.nombre).map(o => o.opcion) };
}

// La pantalla de elección no obliga a un «Listo» adicional si el cliente
// escribió un pedido compuesto y Xabor ya guardó esas decisiones. Se ejecuta
// después de las herramientas, nunca antes ni a partir de su respuesta verbal.
export function cerrarEleccionTrasTexto({estado,catalogo,operaciones}) {
  const abierto = grupoAbierto(estado,catalogo);
  if (!abierto || estado.eleccionInteractiva.editando) return;
  const {item,grupo,elegidas} = abierto, {minimo,maximo} = cardinalidadSeleccionable(grupo);
  if (elegidas.length < minimo || elegidas.length > maximo
    || elegidas.some(n=>!grupo.opciones.some(o=>o.nombre===n))
    || (estado.opcionesPendientes || []).some(p=>p.lid===item.lid && p.grupo===grupo.nombre)) return;
  const aplicadas = (operaciones || []).filter(o=>o.resultado?.aplicado && !o.resultado?.parcial);
  const grupoAplicado = aplicadas.some(o=>o.herramienta==='modificar_linea'
    && o.argumentos.linea_id===item.lid && o.argumentos.opciones?.some(x=>x.grupo===grupo.nombre));
  const otrasDecisiones = aplicadas.some(o=>['agregar_producto','definir_entrega','definir_pago'].includes(o.herramienta)
    || (o.herramienta==='modificar_linea' && o.argumentos.opciones?.some(x=>x.grupo!==grupo.nombre)));
  if (grupoAplicado && (elegidas.length===maximo || otrasDecisiones)) delete estado.eleccionInteractiva;
}

// Las asociaciones contienen identidades y precios concretos, nunca índices.
// Se recalculan SOLO para cotejar la asociación guardada, no para resolverla.
export function opcionesInteractivas({ estado, catalogo = [], modalidades, metodosPago, promociones = [] }) {
  const p = estado.pendiente;
  if (!p) return [];
  const opcion = (accion,title,datos) => ({ accion,title,datos:{ tipo:p.tipo,...datos } });
  if (p.tipo === 'modalidad') return (modalidadesDisponibles(modalidades) || [])
    .filter(m => p.opciones.includes(m.valor)).map(m => opcion('modalidad',etiquetaTipoModalidad(m.tipo),{ valor:m.valor }));
  if (p.tipo === 'pago') return (tiposDePagoDisponibles(metodosPago) || [])
    .filter(m => p.opciones.includes(m)).map(m => opcion('pago',etiquetaTipoPago(m),{ valor:m }));
  if (p.tipo === 'aceptar_pago_ofrecido') return (tiposDePagoDisponibles(metodosPago) || []).includes(p.forma_pago)
    ? [opcion('aceptar','Sí, usar ese pago',{ valor:p.forma_pago }),opcion('rechazar','No, gracias',{ valor:p.forma_pago })] : [];
  if (['aceptar_producto','aceptar_promocion'].includes(p.tipo)) {
    const f = fichaPorId(catalogo,p.producto_id);
    if (!f || f.nombre !== p.producto || precio(f.precio) == null) return [];
    let promocion = null;
    if (p.tipo === 'aceptar_promocion') {
      const real = (promociones || []).find(x => String(x.id) === p.promocion_id);
      if (!real || real.cantidadAceptacion !== p.cantidad || real.participacion?.modo !== 'productos'
        || real.participacion.nombres?.length !== 1 || real.participacion.nombres[0] !== f.nombre) return [];
      // Incluye las condiciones verificadas, no solo el ID; cambiar el descuento
      // o la vigencia invalida el toque igual que cambiar el precio base.
      promocion = JSON.parse(JSON.stringify(real));
    }
    const datos = { producto_id:String(f.id),producto:f.nombre,precio:precio(f.precio),
      cantidad:p.tipo === 'aceptar_promocion' ? p.cantidad : 1,promocion };
    return [opcion('aceptar','Sí, agrégalo',datos),opcion('rechazar','No, gracias',datos)];
  }
  if (p.tipo === 'elegir_producto') {
    const vigente = iniciarSeleccion({estado,catalogo,mensaje:p.solicitud});
    if (!vigente || vigente.ciclo !== p.ciclo || vigente.cantidad !== p.cantidad) return [];
    return p.candidatos.filter(c => vigente.candidatos.some(v => v.id === c.id && v.nombre === c.nombre))
      .map(c => fichaPorId(catalogo,c.id)).filter(f => f && precio(f.precio) != null)
      .map(f => opcion('elegir_producto',f.nombre,{producto_id:String(f.id),producto:f.nombre,
        cantidad:p.cantidad,precio:precio(f.precio),solicitud:p.solicitud}));
  }
  if (p.tipo !== 'elegir_opcion') return [];
  const item = estado.carrito?.items?.find(i => i.lid === p.linea_id);
  const f = item && fichaPorId(catalogo,item.id), g = f?.grupos.find(g => g.nombre === p.grupo);
  if (!g || precio(f.precio) == null) return [];
  const {minimo,maximo} = cardinalidadSeleccionable(g);
  const elegidas = opcionesDeLinea(item).filter(o => o.grupo === g.nombre).map(o => o.opcion);
  const base = {linea_id:item.lid,producto_id:String(f.id),grupo:g.nombre,precio_base:precio(f.precio),minimo,maximo,
    eleccion_id:estado.eleccionInteractiva?.id || null,
    seleccion:ordenadas(elegidas), precios:ordenadas(g.opciones.map(o => ({opcion:o.nombre,precio:precio(o.precio_extra)}))) };
  if (base.precios.some(o => o.precio == null)) return [];
  const multiples = maximo > 1;
  const editando = multiples && estado.eleccionInteractiva?.editando;
  const opciones = g.opciones.filter(o => (multiples || p.candidatos.includes(o.nombre))
    && (!multiples || editando || (!elegidas.includes(o.nombre) && elegidas.length < maximo)))
    .map(o => opcion(editando ? 'reemplazar_grupo' : multiples ? 'agregar_a_grupo' : 'elegir_opcion',o.nombre,{...base,valor:o.nombre,precio:precio(o.precio_extra)}));
  if (multiples && !editando && elegidas.length >= minimo && elegidas.length <= maximo
    && elegidas.every(n => g.opciones.some(o => o.nombre === n))) opciones.push(opcion('cerrar_grupo','Continuar',base));
  if (multiples && elegidas.length) opciones.push(opcion(editando ? 'conservar_grupo' : 'editar_grupo',
    editando ? 'Conservar selección' : 'Cambiar selección',base));
  return opciones;
}

// Una lista multiselección sigue siendo válida tras SUMAR otra opción del
// mismo grupo abierto. Nunca autoriza reemplazar, cerrar ni confirmar desde
// una foto vieja. Identidad, precio, catálogo y límites siguen siendo exactos.
export function adicionDeListaVigente(asociacion, contexto) {
  const d = asociacion?.datos, abierto = grupoAbierto(contexto.estado,contexto.catalogo);
  if (asociacion?.accion === 'agregar_a_grupo' && !d?.eleccion_id
    && asociacionVigente(asociacion,contexto)) return asociacion;
  if (asociacion?.accion !== 'agregar_a_grupo' || !d?.eleccion_id || !abierto
    || contexto.estado.eleccionInteractiva.editando || contexto.estado.eleccionInteractiva.id !== d.eleccion_id
    || contexto.estado.pendiente?.tipo !== 'elegir_opcion'
    || contexto.estado.pendiente.linea_id !== d.linea_id || contexto.estado.pendiente.grupo !== d.grupo
    || abierto.item.lid !== d.linea_id || String(abierto.item.id) !== d.producto_id
    || abierto.grupo.nombre !== d.grupo || !Array.isArray(d.seleccion)
    || !d.seleccion.every(n => abierto.elegidas.includes(n))) return null;
  // Cotejar incluso cuando se alcanzó el máximo o la opción ya fue elegida:
  // el adaptador responderá sin duplicar ni exceder el máximo.
  const copia = {...contexto.estado,carrito:structuredClone(contexto.estado.carrito)};
  const linea = copia.carrito.items.find(i => i.lid === d.linea_id);
  linea.modificadores = (linea.modificadores || []).filter(g => g.grupo !== d.grupo);
  const actual = opcionesInteractivas({...contexto,estado:copia}).find(o => o.accion === 'agregar_a_grupo' && o.datos.valor === d.valor);
  if (!actual || !iguales({...d,seleccion:[]},actual.datos)) return null;
  return {...actual,datos:{...actual.datos,seleccion:ordenadas(abierto.elegidas)}};
}

export function asociacionVigente(asociacion, contexto) {
  return opcionesInteractivas(contexto).some(o => o.accion === asociacion.accion && iguales(o.datos,asociacion.datos));
}

export function abrirGrupoDePregunta(estado,catalogo) {
  const p = estado.pendiente;
  if (p?.tipo !== 'elegir_opcion') return;
  const item = estado.carrito?.items?.find(i => i.lid === p.linea_id);
  const g = item && fichaPorId(catalogo,item.id)?.grupos.find(g => g.nombre === p.grupo);
  if (g && cardinalidadSeleccionable(g).maximo > 1) {
    const previo = estado.eleccionInteractiva;
    if (previo?.ciclo === estado.conversacionId && previo.linea_id === item.lid
      && previo.producto_id === String(item.id) && previo.grupo === g.nombre && previo.id) return;
    estado.eleccionInteractiva = {id:randomUUID(),
      ciclo:estado.conversacionId,linea_id:item.lid,producto_id:String(item.id),grupo:g.nombre };
  }
}

export function textoDeElecciones(estado,catalogo,opciones,texto,{compacto=false}={}) {
  const p = estado.pendiente;
  if (p.tipo === 'elegir_producto') return compacto
    ? `*Elige tu producto*\nCantidad: ${p.cantidad}. Los precios aparecen en la lista.`
    : `¿Cuál deseas agregar? Cantidad: ${p.cantidad}.\n`
    + opciones.map(o => `${o.title}: $${o.datos.precio} c/u.`).join('\n');
  if (p.tipo === 'elegir_opcion') {
    const item = estado.carrito.items.find(i => i.lid === p.linea_id);
    const g = item && fichaPorId(catalogo,item.id)?.grupos.find(g => g.nombre === p.grupo);
    if (!g) return texto;
    const {minimo,maximo} = cardinalidadSeleccionable(g);
    const elegidas = opcionesDeLinea(item).filter(o => o.grupo === g.nombre).map(o => o.opcion);
    if (compacto) {
      const cabecera = `*${item.nombre} · ${g.nombre}*`;
      const seleccion = elegidas.length ? `\nSeleccionado: ${elegidas.join(' y ')}.` : '';
      const disponibles = Math.min(maximo,g.opciones.length) - elegidas.length;
      const indicacion = estado.eleccionInteractiva?.editando
        ? 'Elige la primera opción de tu nueva selección. Reemplazará las anteriores.'
        : !disponibles ? 'Selección completa. Puedes continuar o cambiarla.'
        : elegidas.length >= minimo ? `Puedes agregar ${disponibles === 1 ? 'una más' : `hasta ${disponibles} más`} o continuar.`
        : maximo === 1 ? 'Elige una opción.'
        : elegidas.length ? `Falta elegir ${minimo - elegidas.length} opción${minimo - elegidas.length === 1 ? '' : 'es'}.`
        : minimo === maximo ? `Elige ${minimo} opciones.` : `Elige de ${minimo} a ${maximo} opciones.`;
      return `${cabecera}${seleccion}\n${indicacion}`;
    }
    return `Para ${item.nombre}, ${g.nombre}: ${elegidas.join(', ') || 'sin seleccionar'}.\n`
      + `Elige ${maximo > 1 ? `de ${minimo} a ${Math.min(maximo,g.opciones.length)} opciones` : 'una opción'}.\n`
      + g.opciones.map(o => `${o.nombre}${Number(o.precio_extra) ? ` (+$${Number(o.precio_extra)})` : ' (sin cargo extra)'}`).join(', ')
      + (maximo > 1 ? '.\nAl terminar escribe «listo». Para cambiar, escribe «cambia a» y tus opciones.' : '.');
  }
  if (p.tipo === 'aceptar_producto') return `¿Agregamos ${p.producto} a tu pedido? Precio base: $${opciones[0].datos.precio}.`;
  if (p.tipo === 'aceptar_promocion') {
    const d=opciones[0].datos, pr=d.promocion;
    return `${pr.nombre}${pr.descripcion ? `: ${pr.descripcion}` : ''}.\n`
      + `${pr.participantesTexto || ''}\n¿Agregamos ${d.cantidad} × ${d.producto} para esta promoción? Precio base por unidad: $${d.precio}.`;
  }
  if (compacto && p.tipo === 'modalidad') return '*Entrega*\n¿Cómo quieres recibir tu pedido?';
  if (compacto && p.tipo === 'pago') return '*Forma de pago*\n¿Cómo prefieres pagar?';
  return texto;
}

export function respuestaDeEleccion(reserva, contexto) {
  const {estado,catalogo} = contexto;
  const {accion,datos:d} = reserva;
  const base = {tipo:'boton_eleccion',desdePedido:true,sinSaludo:true,acciones:[]};
  if (accion === 'agregar_a_grupo') {
    const elecciones = reserva.elecciones || [reserva];
    const vigentes = elecciones.map(o => adicionDeListaVigente(o,contexto));
    if (vigentes.some(o => !o)) return {...base,texto:'Esta selección cambió. Revisa las opciones actuales.\n'};
    const valores = [...new Set([...vigentes[0].datos.seleccion,...vigentes.map(o => o.datos.valor)])];
    if (valores.length > d.maximo) return {...base,texto:`Puedes elegir hasta ${d.maximo} opciones. Conservo tu selección; elige cuáles prefieres.\n`};
    abrirGrupoDePregunta(estado,catalogo);
    base.acciones = [accionInteractiva('modificar_linea',{linea_id:d.linea_id,
      opciones:valores.map(opcion => ({grupo:d.grupo,opcion}))},estado)];
    return base;
  }
  if (!asociacionVigente(reserva,contexto)) return {...base,texto:'La opción o su precio cambió. Revisa las opciones actuales.\n'};
  if (accion === 'editar_grupo' || accion === 'conservar_grupo') {
    estado.eleccionInteractiva = {...estado.eleccionInteractiva,id:randomUUID(),editando:accion === 'editar_grupo'};
    return base;
  }
  if (accion === 'rechazar') return {...base,texto:'Entendido, no lo agrego.\n'};
  if (accion === 'cerrar_grupo') { delete estado.eleccionInteractiva; return base; }
  if (accion === 'modalidad') base.acciones = [accionInteractiva('definir_entrega',{modalidad:d.valor},estado)];
  if (accion === 'pago' || d.tipo === 'aceptar_pago_ofrecido') base.acciones = [accionInteractiva('definir_pago',{forma_pago:d.valor},estado)];
  if (accion === 'elegir_producto' || (accion === 'aceptar' && d.producto_id)) {
    base.acciones = [accionInteractiva('agregar_producto',{producto_id:d.producto_id,cantidad:d.cantidad},estado)];
  }
  if (['elegir_opcion','reemplazar_grupo'].includes(accion)) {
    if (accion === 'reemplazar_grupo') estado.eleccionInteractiva = {...estado.eleccionInteractiva,id:randomUUID(),editando:false};
    const valores = [d.valor];
    base.acciones = [accionInteractiva('modificar_linea',{linea_id:d.linea_id,
      opciones:valores.map(opcion => ({grupo:d.grupo,opcion}))},estado)];
  }
  return base;
}

// Escribir una opción mientras el grupo está abierto suma, no sustituye.
// Una sustitución exige un verbo inequívoco o «solo». Vocabulario restante
// implica otra intención: sigue el intérprete habitual sin cerrar el grupo.
export function respuestaTextoGrupo({estado,catalogo,mensaje}) {
  const abierto = grupoAbierto(estado,catalogo);
  if (!abierto || !String(mensaje).trim()) return null;
  const {item,grupo,elegidas} = abierto, {minimo,maximo} = cardinalidadSeleccionable(grupo);
  const base = {tipo:'texto_grupo_abierto',desdePedido:true,sinSaludo:true,acciones:[]};
  const t = norm(mensaje);
  if (/^(?:listo(?: con estas)?|asi esta bien|terminar|terminado|continuar|continua)$/.test(t)) {
    if (elegidas.length >= minimo && elegidas.length <= maximo
      && elegidas.every(n => grupo.opciones.some(o => o.nombre === n))) delete estado.eleccionInteractiva;
    else base.texto = `Necesitas elegir al menos ${minimo} opciones disponibles.\n`;
    return base;
  }
  if (/[?¿]/.test(mensaje)) return null;
  let resto = t.replace(/^(?:(?:me|le) )?(?:(?:puedes|podrias) )?(?:agrega(?:r|me|le)?|anade(?:me|le)?|anadir|ponle|tambien) /,'');
  const sustituye = estado.eleccionInteractiva.editando
    || /^(?:solo|solamente|cambia(?:r|me|le)?(?: por| a)?|sustituye(?: por)?|mejor) /.test(resto);
  const cerrar = /^(?:solo|solamente) /.test(resto);
  resto = resto.replace(/^(?:solo|solamente|cambia(?:r|me|le)?(?: por| a)?|sustituye(?: por)?|mejor) /,'')
    .replace(/^(?:la |el )?salsa /,'').replace(/(?: por favor| gracias)$/,'');
  const nombres = grupo.opciones.map(o => o.nombre).sort((a,b)=>b.length-a.length);
  const nuevas = [];
  for (const n of nombres) {
    const needle = ` ${norm(n)} `;
    if (` ${resto} `.includes(needle)) {
      nuevas.push(n); resto = (` ${resto} `).replaceAll(needle,' ').trim();
    }
  }
  if (!nuevas.length || resto.split(' ').some(w => w && !['y','con', 'salsa'].includes(w))) {
    // La lista no secuestra la conversación. «Roja con pollo y un café»
    // contiene otras decisiones: el intérprete debe ver el mensaje ENTERO y
    // todas sus propuestas seguirán pasando por el reconciliador. También un
    // cambio que no casa («solo aguacate»): el reconciliador, no esta lista,
    // impide que el modelo adivine otra salsa (fase-botones-ofertas-db, caso 6).
    return null;
  }
  const valores = sustituye ? nuevas : [...new Set([...elegidas,...nuevas])];
  if (valores.length > maximo || (cerrar && valores.length < minimo))
    return {...base,texto:`Este grupo admite de ${minimo} a ${maximo} opciones. Conservo tu selección.\n`};
  base.acciones = [accionInteractiva('modificar_linea',{linea_id:item.lid,
    opciones:valores.map(opcion => ({grupo:grupo.nombre,opcion}))},estado)];
  if (estado.eleccionInteractiva.editando) base.edicionGrupo = {
    linea_id:item.lid,grupo:grupo.nombre,valores,id:randomUUID() };
  // Solo se cierra después de releer el resultado real del ejecutor.
  if (cerrar) base.cerrarGrupo = {linea_id:item.lid,grupo:grupo.nombre,valores};
  return base;
}
