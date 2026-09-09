import { prepararCamaraTicket } from './compras-camara.js';
const $ = id=>document.getElementById(id);
const esc = s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n=>new Intl.NumberFormat('es-MX',{style:'currency',currency:'MXN'}).format(Number(n||0));
const date = v=>String(v||'').slice(0,10);
const labelFactura = s=>({no_facturado:'Sin factura',pendiente:'Pendiente',facturado:'Facturada'}[s]||s);
const state={role:null,responsables:[],categorias:[],compra:null,page:1,summary:null,preview:null,busy:false};
const formValues = form=>Object.fromEntries(new FormData(form));
const field = (form,name)=>form.elements.namedItem(name);

async function api(path,{body,method='GET',raw=false}={}) {
  const token=sessionStorage.getItem('xabor_token');
  const response=await fetch('/api/admin/compras'+path,{method,credentials:'same-origin',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  if(response.status===401){location.assign('/login?redirect='+encodeURIComponent('/compras.html'));throw new Error('Inicia sesión para continuar');}
  if(!response.ok){const data=await response.json().catch(()=>({}));const e=new Error(data.error||'No se pudo completar la operación');e.code=data.codigo;throw e;}
  return raw?response.blob():response.json();
}
function notice(message,error=false){$('status').hidden=false;$('status').className=error?'error':'';$('status').textContent=message;}
function errorForm(form,message){const el=form?.querySelector('.form-error');if(el){el.hidden=false;el.textContent=message;}else notice(message,true);}
// Serializa acciones de la pantalla, conserva la clave del intento financiero
// si la respuesta se pierde, y no oculta errores dentro de un diálogo abierto.
async function run(action,form=null){
  if(state.busy)return;state.busy=true;
  const enabled=[...document.querySelectorAll('button:not(:disabled)')];enabled.forEach(b=>b.disabled=true);
  const error=form?.querySelector('.form-error');if(error)error.hidden=true;
  try{await action();}catch(e){errorForm(form,e.message);}finally{enabled.forEach(b=>b.disabled=false);state.busy=false;pager();}
}
function pager(){const total=state.total||0;$('prev-page').disabled=state.busy||state.page<=1;$('next-page').disabled=state.busy||state.page*25>=total;}
function showDialog(id){const dialog=$(id);const error=dialog.querySelector('.form-error');if(error)error.hidden=true;dialog.showModal();}
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>$(b.dataset.close).close()));
document.querySelectorAll('dialog').forEach(d=>d.addEventListener('cancel',e=>{if(state.busy)e.preventDefault();}));
$('editor').addEventListener('close',()=>{if(state.preview){URL.revokeObjectURL(state.preview);state.preview=null;}});
function optionsResponsables(form){const select=field(form,'responsable_id');if(select)select.innerHTML='<option value="">Elige un responsable</option>'+state.responsables.map(r=>`<option value="${r.id}">${esc(r.nombre)}</option>`).join('');}
function sourceFields(form){
  const origin=field(form,'origen')?.value;
  form.querySelectorAll('.source-fondo').forEach(el=>el.hidden=origin!=='fondo');
  form.querySelectorAll('.source-cuenta').forEach(el=>el.hidden=origin!=='otra_cuenta');
  const required=form.id!=='editor-form'||field(form,'tipo_pago').value==='contado';
  if(field(form,'responsable_id'))field(form,'responsable_id').required=required&&origin==='fondo';
  if(field(form,'cuenta'))field(form,'cuenta').required=required&&origin==='otra_cuenta';
}
function initialPayment(){const form=$('editor-form');$('initial-payment').hidden=state.compra?.estado!=='borrador'||field(form,'tipo_pago').value!=='contado';field(form,'origen').required=!$('initial-payment').hidden;sourceFields(form);}
field($('editor-form'),'tipo_pago').addEventListener('change',initialPayment);
for(const id of ['editor-form','payment-form'])field($(id),'origen').addEventListener('change',()=>sourceFields($(id)));
document.querySelectorAll('[data-view]').forEach(btn=>btn.addEventListener('click',()=>{document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b===btn)));for(const id of ['compras','fondos','proveedores'])$('view-'+id).hidden=id!==btn.dataset.view;}));
async function context(){const [ctx,categories]=await Promise.all([api('/contexto'),api('/categorias')]);state.role=ctx.rol;state.responsables=ctx.responsables;state.categorias=categories.categorias;document.querySelectorAll('.admin').forEach(el=>el.hidden=state.role!=='admin');}
async function summary(){
  const params=new URLSearchParams();if($('desde').value)params.set('desde',$('desde').value);if($('hasta').value)params.set('hasta',$('hasta').value);
  const s=await api('/resumen?'+params);state.summary=s;$('desde').value=s.desde;$('hasta').value=s.hasta;$('hasta').max=s.hoy;
  $('period-note').textContent='Compras por fecha del ticket · saldos acumulados';
  for(const [id,value] of [['compras',s.comprobado],['pagado',s.pagado_periodo],['fondo',s.saldo_fondo],['deuda',s.deuda_proveedores]])$('m-'+id).textContent=money(value);
  $('sin-factura').textContent=`${s.sin_factura_count} compras sin factura en el periodo · ${money(s.sin_factura_monto)}`;
  $('legacy-warning').hidden=!(s.compras_sin_revisar||s.fondos_sin_responsable);
  $('legacy-warning').textContent=`Hay ${s.compras_sin_revisar} compras históricas con pagos sin revisar y ${s.fondos_sin_responsable} fondos sin responsable asignado. Los saldos excluyen esos movimientos desconocidos y requieren revisión antes de usarse como saldo completo.`;
  $('responsables-list').innerHTML=s.responsables.length?s.responsables.map(r=>`<article><h3>${esc(r.nombre)}</h3><strong>${money(r.saldo)}</strong><p>Debe conservar al ${esc(s.hasta)}</p><dl><dt>Saldo anterior</dt><dd>${money(r.saldo_anterior)}</dd><dt>Entregado</dt><dd>+ ${money(r.entregado)}</dd><dt>Pagado del fondo</dt><dd>− ${money(r.pagado)}</dd><dt>Devuelto al negocio</dt><dd>− ${money(r.devuelto)}</dd></dl></article>`).join(''):'<p class="empty">Agrega un responsable y registra el dinero que le entregaste.</p>';
  $('fondos-list').innerHTML=s.fondos.map(f=>`<tr><td>${esc(date(f.fecha))}</td><td>${esc(f.nombre||f.responsable||'Sin asignar')}</td><td>${f.revertido_at?'Corregido':f.tipo==='entrega'?'Entrega':'Devolución'}</td><td>${money(f.monto)}</td><td>${esc(f.motivo_reversion||f.notas||'—')}</td><td>${state.role==='admin'&&!f.revertido_at?`<button class="secondary" data-revert-fund="${f.id}">Corregir</button>`:''}</td></tr>`).join('')||'<tr><td colspan="6" class="empty">Sin movimientos en este periodo.</td></tr>';
  $('deudas-list').innerHTML=s.pendientes.map(c=>`<tr><td>${esc(c.proveedor)}</td><td>${esc(date(c.fecha))}</td><td>${money(c.total)}</td><td>${money(c.pagado)}</td><td><strong>${money(c.pendiente)}</strong></td><td><button class="secondary" data-open="${c.id}">Ver compra</button></td></tr>`).join('')||'<tr><td colspan="6" class="empty">Sin compras pendientes registradas hasta esa fecha.</td></tr>';
}
async function list(){
  const params=new URLSearchParams({size:25,page:state.page});for(const [name,id] of [['q','q'],['estado','estado'],['estado_factura','factura'],['desde','desde'],['hasta','hasta']])if($(id).value)params.set(name,$(id).value);
  const r=await api('?'+params);state.total=r.total;
  $('compras-list').innerHTML=r.compras.map(c=>`<tr><td>${esc(date(c.fecha)||'Sin fecha')}</td><td>${esc(c.proveedor||'Por revisar')}</td><td><strong>${c.total==null?'—':money(c.total)}</strong></td><td>${c.tipo_pago==='credito'?'A crédito':'Pagada completa'}</td><td>${esc(labelFactura(c.estado_factura))}</td><td><span class="badge ${esc(c.estado)}">${esc(c.estado)}</span></td><td><button class="secondary" data-open="${c.id}">Revisar</button></td></tr>`).join('')||'<tr><td colspan="7" class="empty">No hay compras con estos filtros. Puedes subir un ticket o capturar una compra manual.</td></tr>';
  $('page-info').textContent=`${r.total} registros · página ${state.page}`;pager();
}
async function reload(){await summary();await list();}
for(const id of ['period-form','filters'])$(id).addEventListener('submit',e=>{e.preventDefault();state.page=1;run(reload);});
$('prev-page').onclick=()=>{state.page--;run(list);};$('next-page').onclick=()=>{state.page++;run(list);};

function addItem(item={}){
  const row=document.createElement('div');row.className='item';row.dataset.id=item.id||'';
  const control=(name,label,type='text',step='')=>`<label><span>${label}</span><input data-field="${name}" type="${type}" ${step?`step="${step}" min="0"`:''} value="${esc(item[name]??'')}"></label>`;
  row.innerHTML=`<div class="fields"><label class="item-description">Descripción<input data-field="descripcion" required maxlength="250" value="${esc(item.descripcion||'')}"></label>${control('cantidad','Cantidad','number','.001')}${control('unidad','Unidad')}${control('precio_unitario','Precio unitario','number','.01')}${control('importe','Importe','number','.01')}<label>Categoría<select data-field="categoria"><option value="">Sin categoría</option>${[...new Set([item.categoria,...state.categorias].filter(Boolean))].map(c=>`<option ${c===(item.categoria||item.categoria_sugerida)?'selected':''}>${esc(c)}</option>`).join('')}</select></label></div><div class="item-controls"><small>${item.categoria_sugerida?'Sugerida: '+esc(item.categoria_sugerida):'Concepto manual'}</small><button type="button" class="secondary remove-item">Quitar</button></div>`;
  row.querySelector('.remove-item').onclick=()=>row.remove();$('items').append(row);
}
$('add-item').onclick=()=>addItem();
function collect(){
  const values=formValues($('editor-form'));
  const data=Object.fromEntries(['proveedor','fecha','total','subtotal','impuestos','numero_ticket','tipo_pago','estado_factura','cfdi_uuid','notas'].map(k=>[k,values[k]??'']));
  data.version=state.compra.version;
  data.items=[...$('items').children].map(row=>({...row.dataset.id?{id:row.dataset.id}:{},...Object.fromEntries([...row.querySelectorAll('[data-field]')].map(el=>[el.dataset.field,el.value]))}));
  return data;
}
function renderEditor(c){
  state.compra=c;const form=$('editor-form');form.reset();optionsResponsables(form);
  for(const name of ['proveedor','fecha','total','subtotal','impuestos','numero_ticket','tipo_pago','estado_factura','cfdi_uuid','notas'])field(form,name).value=name==='fecha'?date(c[name]):c[name]??'';
  $('items').innerHTML='';c.items.forEach(addItem);$('purchase-fields').disabled=c.estado!=='borrador';$('editor-state').textContent=c.estado.toUpperCase();
  $('save-draft').hidden=$('confirm-purchase').hidden=c.estado!=='borrador';$('cancel-purchase').hidden=state.role!=='admin'||c.estado==='cancelada';
  $('purchase-payments').hidden=c.estado!=='confirmada';$('new-payment').hidden=state.role!=='admin'||!c.pagos_revisados||!(c.pendiente>0);
  $('edit-invoice').hidden=state.role!=='admin'||c.estado!=='confirmada';
  $('payment-summary').textContent=c.pagos_revisados?`Pagado: ${money(c.pagado)} · Pendiente: ${money(c.pendiente)}`:'Pagos históricos sin revisar. No se infieren del tipo de compra.';
  $('payments-list').innerHTML=(c.pagos||[]).map(p=>`<div class="payment-row"><div><strong>${money(p.monto)} ${p.revertido_at?'· Corregido':''}</strong><small>${esc(date(p.fecha))} · ${esc(p.origen==='fondo'?'Fondo: '+p.responsable:p.cuenta)}</small><small>${esc(p.motivo_reversion||p.referencia||p.notas||'')}</small></div>${state.role==='admin'&&!p.revertido_at?`<button type="button" class="secondary" data-revert-payment="${p.id}">Corregir registro</button>`:''}</div>`).join('')||'<p class="muted">Sin pagos registrados.</p>';
  $('cancellation-info').hidden=!c.cancelacion_motivo;$('cancellation-info').textContent='Cancelada: '+(c.cancelacion_motivo||'');
  $('warnings').hidden=!c.advertencias?.length;$('warnings').textContent=(c.advertencias||[]).join(' · ');
  initialPayment();
}
async function openPurchase(id){
  const c=await api('/'+id);renderEditor(c);state.confirmKey=crypto.randomUUID();$('ticket-preview').hidden=true;
  if(state.preview){URL.revokeObjectURL(state.preview);state.preview=null;}
  showDialog('editor');
  if(c.ticket_storage_key){try{state.preview=URL.createObjectURL(await api('/'+id+'/ticket',{raw:true}));$('ticket-preview').src=state.preview;$('ticket-preview').hidden=false;}catch{errorForm($('editor-form'),'No se pudo cargar la foto. El registro sigue disponible.');}}
}
async function save(){
  state.compra=await api('/'+state.compra.id,{method:'PUT',body:collect()});
  // Mantiene IDs recién creados y metadatos tras agregar/reordenar conceptos.
  [...$('items').children].forEach((row,i)=>row.dataset.id=state.compra.items[i].id);
}
$('save-draft').onclick=()=>run(async()=>{await save();await reload();notice('Borrador guardado. Todavía no cuenta como compra confirmada.');},$('editor-form'));
$('editor-form').addEventListener('submit',e=>{e.preventDefault();run(async()=>{
  const values=formValues($('editor-form'));await save();
  const body={version:state.compra.version};
  if(values.tipo_pago==='contado')body.pago_inicial={origen:values.origen,responsable_id:values.responsable_id,cuenta:values.cuenta,clave_operacion:state.confirmKey};
  try {await api('/'+state.compra.id+'/confirmar',{method:'POST',body});}
  catch(e){
    // Si el servidor confirmó pero la respuesta se perdió, consultar evita
    // enviar otro PUT sobre una compra ya confirmada y dejar el editor atorado.
    const actual=await api('/'+state.compra.id).catch(()=>null);
    if(actual?.estado!=='confirmada')throw e;
  }
  $('editor').close();await reload();notice('Compra confirmada.');
},$('editor-form'));});
$('new-manual').onclick=()=>run(async()=>{const c=await api('/manual',{method:'POST',body:{fecha:state.summary.hoy,tipo_pago:'credito'}});await openPurchase(c.id);});
$('new-ticket').onclick=()=>$('ticket-file').click();
function analizarFoto(file){if(!file)return;return run(async()=>{
  if(file.size>8*1024*1024)throw new Error('La foto supera 8 MB. Usa una imagen más pequeña.');
  notice('Analizando ticket. Al terminar podrás revisar y corregir los datos.');
  const base64=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file);});
  const d=await api('/analizar-ticket',{method:'POST',body:{base64,filename:file.name}});await reload();await openPurchase(d.compra.id);notice('Ticket leído. Revisa las cifras y el origen del pago antes de confirmar.');
});}
$('ticket-file').addEventListener('change',e=>{const file=e.target.files?.[0];e.target.value='';analizarFoto(file);});
prepararCamaraTicket({alCapturar:analizarFoto,alSubir:()=>$('ticket-file').click()});

function newFund(){const form=$('fund-form');form.reset();optionsResponsables(form);field(form,'fecha').value=state.summary.hoy;field(form,'fecha').max=state.summary.hoy;state.fundKey=crypto.randomUUID();showDialog('fund-dialog');}
$('new-fondo').onclick=newFund;
$('fund-form').addEventListener('submit',e=>{e.preventDefault();run(async()=>{await api('/fondos',{method:'POST',body:{...formValues(e.target),clave_operacion:state.fundKey}});$('fund-dialog').close();await reload();notice('Movimiento registrado en el fondo.');},e.target);});
$('new-responsable').onclick=()=>{$('responsable-form').reset();showDialog('responsable-dialog');};
$('responsable-form').addEventListener('submit',e=>{e.preventDefault();run(async()=>{await api('/responsables',{method:'POST',body:formValues(e.target)});$('responsable-dialog').close();await context();await reload();},e.target);});
$('new-payment').onclick=()=>{const form=$('payment-form');form.reset();optionsResponsables(form);field(form,'fecha').value=state.summary.hoy;field(form,'fecha').max=state.summary.hoy;field(form,'fecha').min=date(state.compra.fecha);field(form,'monto').value=state.compra.pendiente;field(form,'monto').max=state.compra.pendiente;$('pay-pending').textContent=state.compra.proveedor+' · pendiente '+money(state.compra.pendiente);state.payKey=crypto.randomUUID();sourceFields(form);showDialog('payment-dialog');};
$('payment-form').addEventListener('submit',e=>{e.preventDefault();run(async()=>{await api('/'+state.compra.id+'/pagos',{method:'POST',body:{...formValues(e.target),clave_operacion:state.payKey}});$('payment-dialog').close();renderEditor(await api('/'+state.compra.id));await reload();notice('Pago registrado sin duplicar la compra.');},e.target);});
function reason(path,title,help,extra={}){state.reason={path,extra};$('reason-form').reset();$('reason-title').textContent=title;$('reason-help').textContent=help;showDialog('reason-dialog');}
$('cancel-purchase').onclick=()=>reason('/'+state.compra.id+'/cancelar','Cancelar compra','Solo cancela registros incorrectos. Una compra con pagos vigentes no se puede cancelar.',{version:state.compra.version});
$('reason-form').addEventListener('submit',e=>{e.preventDefault();run(async()=>{await api(state.reason.path,{method:'POST',body:{...state.reason.extra,...formValues(e.target)}});$('reason-dialog').close();if($('editor').open)renderEditor(await api('/'+state.compra.id));await reload();notice('Corrección registrada con su motivo.');},e.target);});
document.addEventListener('click',e=>{const btn=e.target.closest('button');if(!btn||state.busy)return;if(btn.dataset.open)run(()=>openPurchase(btn.dataset.open));if(btn.dataset.revertFund)reason('/fondos/'+btn.dataset.revertFund+'/revertir','Corregir movimiento del fondo','Anula un registro equivocado conservando su historial. Si el dinero sí se entregó y ahora se devuelve, usa una devolución.');if(btn.dataset.revertPayment)reason('/pagos/'+btn.dataset.revertPayment+'/revertir','Corregir registro de pago','Anula una captura equivocada. No realiza un reembolso ni recupera dinero de un proveedor.');});
await run(async()=>{await context();await reload();});

$('edit-invoice').onclick=()=>{
  const form=$('invoice-form');form.reset();field(form,'estado_factura').value=state.compra.estado_factura;field(form,'cfdi_uuid').value=state.compra.cfdi_uuid||'';showDialog('invoice-dialog');
};
$('invoice-form').addEventListener('submit',e=>{e.preventDefault();run(async()=>{
  const c=await api('/'+state.compra.id+'/factura',{method:'POST',body:{...formValues(e.target),version:state.compra.version}});
  $('invoice-dialog').close();renderEditor(c);await reload();notice('Estado de factura actualizado.');
},e.target);});
