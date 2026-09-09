export function prepararWhatsappCompras({api,contexto}) {
  if(contexto.rol!=='admin') return;
  const button=document.createElement('button');button.className='secondary';button.textContent='Compras por WhatsApp';button.id='compras-whatsapp';
  document.querySelector('.heading .actions').append(button);
  const dialog=document.createElement('dialog');dialog.id='whatsapp-compras-dialog';
  dialog.innerHTML=`<form><h2>Compras por WhatsApp</h2><p>Estos números pueden enviar tickets al WhatsApp del negocio y confirmar pagos desde el fondo del responsable elegido.</p><div data-list></div><label>Responsable<select name="responsable_id" required></select></label><label>Número de WhatsApp<input name="telefono" type="tel" required placeholder="10 dígitos" maxlength="20"></label><label>Acceso<select name="activo"><option value="true">Autorizado</option><option value="false">Desactivado</option></select></label><p data-error role="alert"></p><div class="actions"><button type="button" data-close>Cerrar</button><button type="submit">Guardar autorización</button></div></form>`;
  document.body.append(dialog);
  const form=dialog.querySelector('form'),select=form.elements.responsable_id,error=dialog.querySelector('[data-error]');
  async function refresh(){
    const ctx=await api('/contexto');select.replaceChildren(...ctx.responsables.map(r=>new Option(r.nombre,r.id)));
    const {autorizados}=await api('/whatsapp');
    const list=dialog.querySelector('[data-list]');list.replaceChildren();
    for(const a of autorizados){const p=document.createElement('p');p.textContent=`${a.nombre}: +${a.telefono} · ${a.activo?'Autorizado':'Desactivado'}`;list.append(p);}
  }
  button.onclick=async()=>{error.textContent='';dialog.showModal();try{await refresh()}catch(e){error.textContent=e.message}};
  dialog.querySelector('[data-close]').onclick=()=>dialog.close();
  form.onsubmit=async e=>{
    e.preventDefault();const submit=form.querySelector('[type=submit]');submit.disabled=true;error.textContent='';
    try{await api('/whatsapp',{method:'PUT',body:{responsable_id:select.value,telefono:form.elements.telefono.value,activo:form.elements.activo.value==='true'}});await refresh();error.textContent='Autorización guardada.';}
    catch(e){error.textContent=e.message}finally{submit.disabled=false}
  };
}
