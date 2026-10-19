// Copia manual de consulta. Solo GET, fuera de la cola de cocina y del pago.
// La única escritura es «📦 Entregado» (solo admin), para cerrar un programado
// atascado; ver puedeCerrarse.
(function (global) {
  'use strict';
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = v => new Intl.NumberFormat('es-MX',{style:'currency',currency:'MXN'}).format(Number(v) || 0);
  const estados = {
    pendiente: {texto:'Pendiente de pago',color:'#92400e',fondo:'#fef3c7'},
    pagado: {texto:'Pagado',color:'#166534',fondo:'#dcfce7'},
    al_recibir: {texto:'Pago al recibir',color:'#374151',fondo:'#f3f4f6'},
    cancelado: {texto:'Cancelado',color:'#991b1b',fondo:'#fee2e2'},
    por_verificar: {texto:'Pago por verificar',color:'#92400e',fondo:'#fef3c7'},
  };
  const estado = p => estados[p.estado_pago] || estados.por_verificar;
  function fecha(p) {
    if (!p.programado_para || !Number.isFinite(new Date(p.programado_para).getTime())) return 'Fecha por verificar';
    const opciones = {timeZone:p.timezone || 'America/Matamoros',dateStyle:'short',timeStyle:'short'};
    try { return new Intl.DateTimeFormat('es-MX',opciones).format(new Date(p.programado_para)); }
    catch { return 'Fecha por verificar'; }
  }
  const detalle = (nombre,v) => v ? `<p><b>${esc(nombre)}:</b> ${esc(v)}</p>` : '';
  const formaPago = p => ({enlace_pago:'Enlace de pago',terminal:'Tarjeta en terminal',efectivo:'Efectivo',
    por_cobrar:'Pago al recibir',pago_en_sucursal:'Pago en sucursal'}[p.forma_pago] || String(p.forma_pago || '').replace(/_/g,' '));
  function copiaHTML(p) {
    const aviso = p.estado_pago === 'pendiente'
      ? 'Pedido aún no confirmado. No preparar ni entregar hasta recibir el pago.'
      : p.estado_pago === 'cancelado' ? 'Pedido cancelado. No preparar ni entregar.'
      : 'Copia de consulta. Conserva la fecha programada del pedido.';
    const items = (p.items || []).map(i => {
      const mods = (i.modificadores || []).map(m => `${m.grupo}: ${m.opcion}`);
      const nota = String(i.notas || '').split(/\s*·\s*/).filter(n=>!mods.includes(n)).join(' · ');
      return `<section><b>${esc(i.cantidad)} x ${esc(i.nombre)}</b>${mods.map(m=>`<p>${esc(m)}</p>`).join('')}
        ${nota ? `<p>${esc(nota)}</p>` : ''}<p>Precio por unidad: ${esc(money(i.precio_unitario))}</p></section>`;
    }).join('');
    return `<!doctype html><html lang="es"><head><meta charset="UTF-8"><title>Copia ${esc(p.folio)}</title>
      <style>@page{size:80mm auto;margin:0 2mm}*{box-sizing:border-box}body{width:74mm;margin:0;padding:4mm 2mm;font:13px/1.45 Arial,sans-serif;color:#000;background:#fff}
      h1,h2{text-align:center;margin:6px 0}h1{font-size:21px}h2{font-size:17px}p{margin:5px 0;overflow-wrap:anywhere}section{border-top:1px solid #000;padding:9px 0;break-inside:avoid}
      .aviso{border:2px solid #000;padding:7px;margin:10px 0}.pie{border-top:1px solid #000;padding-top:8px;font-size:11px}.centro{text-align:center}</style></head><body>
      <h2>${esc(p.negocio)}</h2><h1>PROGRAMADO</h1><h2>${esc(p.folio)}</h2><p class="centro"><b>COPIA PARA CONSULTA</b></p>
      <div class="aviso"><b>${esc(estado(p).texto.toUpperCase())}</b><p>${esc(aviso)}</p></div>
      ${detalle('Cliente',p.cliente)}${detalle('Programado',fecha(p))}<p>Hora local del negocio.</p>
      ${detalle('Modalidad',p.modalidad)}${detalle('Contacto',p.telefono)}${items}
      <section>${detalle('Subtotal',money(p.subtotal))}${detalle('Envío',money(p.costo_envio))}${detalle('Total',money(p.total))}
      ${detalle('Forma de pago',formaPago(p))}</section>
      ${detalle('Dirección',p.direccion)}${detalle('Referencias',p.referencias)}${detalle('Indicaciones',p.notas)}
      <p class="pie">Esta copia no activa el pedido ni modifica su pago o programación.</p></body></html>`;
  }
  // Un programado que el scheduler ya activó, cuya hora ya pasó y que sigue
  // abierto. «En curso» oculta al recargar lo registrado un día antes, y a los
  // de recoger en tienda no los lista ninguna otra vista: esta agenda era el
  // único lugar donde se veían, sin forma de cerrarlos (XAB-1734 y XAB-1998,
  // 19-oct). Se cierran por la misma ruta que Domicilio › «Sin cerrar de días
  // anteriores». Nunca uno por pagar o cancelado, ni una reserva sin activar.
  const ABIERTOS = ['nuevo','en_preparacion','listo'];
  function puedeCerrarse(p, ahora = Date.now()) {
    const hora = Date.parse(p.programado_para || '');
    return p.activado === true && ABIERTOS.includes(p.estado_operativo)
      && !['pendiente','cancelado'].includes(p.estado_pago)
      && Number.isFinite(hora) && hora <= ahora;
  }
  // Folios con el cierre en vuelo: el repintado de la agenda (cada 5 s) no
  // debe devolver el botón activo a mitad de la petición.
  const cerrando = new Set();
  function tarjeta(p, opciones = {}) {
    const e = estado(p);
    const cerrable = opciones.admin === true && puedeCerrarse(p, opciones.ahora ?? Date.now());
    const operativo = p.activado ? ({nuevo:'Pendiente de atención',en_preparacion:'En preparación',listo:'Listo'}[p.estado_operativo] || 'En tablero') : '';
    return `<article style="background:#fff;border:1px solid #e5e2da;border-left:4px solid #6366f1;border-radius:10px;padding:12px 14px;min-width:220px;max-width:300px;">
      <div style="font-size:.72rem;color:#6366f1;font-weight:700;">${esc(p.folio)} · ${p.estado_pago==='pendiente' ? 'RESERVA' : 'PROGRAMADO'}</div>
      <div style="font-weight:700;margin:5px 0;">${esc(p.cliente)}</div>
      <div style="font-size:.8rem;margin-bottom:6px;">${esc(fecha(p))}</div>
      <div style="display:inline-block;border-radius:5px;padding:3px 6px;background:${e.fondo};color:${e.color};font-size:.75rem;font-weight:700;">${esc(e.texto)}</div>
      ${operativo ? `<p style="font-size:.78rem;font-weight:700;">${esc(operativo)}</p>` : ''}
      ${p.estado_pago==='pendiente' ? '<p style="font-size:.75rem;color:#92400e;">Se confirma al recibir el pago. Aún no pasa a cocina.</p>' : ''}
      <p style="font-size:.78rem;">${esc((p.items || []).map(i=>`${i.cantidad}x ${i.nombre}`).join(', '))}</p>
      <p style="font-weight:700;">${esc(money(p.total))}</p>
      ${cerrable ? `<p style="font-size:.75rem;color:#92400e;">Su hora ya pasó y sigue abierto. Si ya se entregó, ciérralo.</p>
      <button type="button" data-programado-cerrar="${esc(p.folio)}" ${cerrando.has(p.folio) ? 'disabled' : ''} style="width:100%;border:1px solid #fde68a;border-radius:6px;background:#fffbeb;padding:8px;margin-bottom:6px;cursor:pointer;">${cerrando.has(p.folio) ? 'Cerrando…' : '📦 Entregado'}</button>` : ''}
      <button type="button" data-programado-folio="${esc(p.folio)}" data-programado-negocio="${esc(p.negocio_id)}" data-programado-id="${esc(p.programado_id)}" style="width:100%;border:1px solid #ddd;border-radius:6px;background:#fff;padding:8px;cursor:pointer;">Imprimir copia</button>
      <p role="status" data-programado-aviso style="font-size:.75rem;color:#666;"></p></article>`;
  }
  async function imprimir(folio, boton) {
    const aviso = boton.closest('article').querySelector('[data-programado-aviso]');
    const win = global.open('', '_blank', 'width=410,height=750,scrollbars=1');
    if (!win) { aviso.textContent='Permite ventanas emergentes para imprimir la copia.'; return; }
    boton.disabled=true;aviso.textContent='Consultando el estado actual del pedido…';
    win.document.write('<!doctype html><html><body>Consultando el pedido…</body></html>');win.document.close();
    try {
      const r = await global.apiFetch('/api/pedidos-programados',{cache:'no-store'});
      if (!r.ok) throw Error('No se pudo consultar el pedido. Intenta de nuevo.');
      const lista = await r.json(), p = Array.isArray(lista) && lista.find(x=>x.folio===folio
        && x.negocio_id===boton.dataset.programadoNegocio && (x.programado_id || '')===boton.dataset.programadoId);
      if (!p) throw Error('El pedido ya no está en programados. Actualiza el tablero para consultar su estado.');
      if (win.closed) return;
      win.document.open();win.document.write(copiaHTML(p));win.document.close();
      let impreso=false;
      const lanzar=()=>{if(impreso || win.closed)return;impreso=true;win.focus();win.print();};
      win.onload=()=>global.setTimeout(lanzar,250);
      global.setTimeout(lanzar,1200);
      aviso.textContent='Copia abierta para imprimir. El pedido conserva su estado.';
    } catch (e) { if(!win.closed)win.close();aviso.textContent=e.message || 'No se pudo abrir la copia.'; }
    finally { boton.disabled=false; }
  }
  // Misma ruta, mismo texto y mismo aviso de error que envMarcarEntregado
  // (Domicilio). El servidor decide lo demás: no avisa al cliente pasadas
  // 12 h de la hora del pedido (avisosEstadoPedido.js).
  async function cerrar(folio, boton, opciones) {
    if (opciones.admin !== true || !folio || cerrando.has(folio)) return;
    if (!global.confirm(`¿Marcar ${folio} como entregado? Se cierra el pedido.`)) return;
    cerrando.add(folio);boton.disabled=true;boton.textContent='Cerrando…';
    try {
      const r = await global.apiFetch(`/pedidos/${encodeURIComponent(folio)}/estado`,
        {method:'PATCH',body:JSON.stringify({estado:'entregado'})});
      if (!r.ok) { const j = await r.json().catch(()=>({})); throw Error(j.error || 'No se pudo marcar como entregado'); }
    } catch (e) {
      cerrando.delete(folio);boton.disabled=false;boton.textContent='📦 Entregado';
      global.alert(e.message || 'No se pudo marcar como entregado');
      return;
    }
    try { await opciones.alCerrar?.(); } catch { /* el siguiente refresco lo retira */ }
    finally { cerrando.delete(folio); }
  }
  // Las opciones del último pintado: el listener se registra una sola vez.
  let opcionesPintado = {};
  function renderizar(lista, grid, wrap, opciones = {}) {
    if (!Array.isArray(lista)) throw Error('Lista de programados no válida');
    opcionesPintado=opciones;
    wrap.style.display=lista.length ? '' : 'none';
    grid.innerHTML=lista.map(p=>tarjeta(p,opciones)).join('');
    if (!grid.dataset.programadosListener) {
      grid.dataset.programadosListener='true';
      grid.addEventListener('click',event=>{
        const cierre=event.target.closest('button[data-programado-cerrar]');
        if(cierre?.dataset?.programadoCerrar && grid.contains(cierre)){
          if(!cierre.disabled)cerrar(cierre.dataset.programadoCerrar,cierre,opcionesPintado);
          return;
        }
        const boton=event.target.closest('button[data-programado-folio]');
        if(boton && grid.contains(boton) && !boton.disabled)imprimir(boton.dataset.programadoFolio,boton);
      });
    }
  }
  // Consultar no prepara ni imprime. Una petición y un temporizador evitan
  // carreras entre la actualización periódica y los eventos del tablero.
  function crearActualizador({cargar,alError=()=>{},programar=global.setTimeout.bind(global),cancelar=global.clearTimeout.bind(global)}) {
    let agenda=false, temporizador=null, enCurso=null, detenido=false;
    const limpiar=()=>{if(temporizador!==null)cancelar(temporizador);temporizador=null;};
    const refrescar=()=>{
      if(detenido)return Promise.resolve();
      if(enCurso)return enCurso;
      limpiar();
      enCurso=Promise.resolve().then(cargar).catch(alError).finally(()=>{
        enCurso=null;
        if(!detenido)temporizador=programar(refrescar,agenda&&!global.document?.hidden?5000:300000);
      });
      return enCurso;
    };
    const volver=()=>{if(agenda&&!global.document?.hidden)refrescar();};
    global.addEventListener?.('focus',volver);
    global.document?.addEventListener?.('visibilitychange',volver);
    return {refrescar,configurar:valor=>{agenda=valor===true;},alEvento:tipo=>{
      if(agenda&&['nuevo_pedido','eliminar_pedido','actualizar_estado','actualizar_pago','cancelar_pedido'].includes(tipo))return refrescar();
    },detener:()=>{detenido=true;limpiar();global.removeEventListener?.('focus',volver);global.document?.removeEventListener?.('visibilitychange',volver);}};
  }
  global.XaborProgramados=Object.freeze({renderizar,copiaHTML,tarjeta,fecha,crearActualizador,puedeCerrarse});
})(window);
