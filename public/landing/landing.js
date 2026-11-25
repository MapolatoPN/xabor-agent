(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const menu = $('menu-movil');
  function cerrarMenu() { menu.hidden = true; $('nav-abrir').setAttribute('aria-expanded','false'); }
  $('nav-abrir').addEventListener('click', () => {
    menu.hidden = !menu.hidden;
    $('nav-abrir').setAttribute('aria-expanded',String(!menu.hidden));
  });
  menu.querySelectorAll('a').forEach(a => a.addEventListener('click',cerrarMenu));
  document.addEventListener('keydown',e => { if(e.key==='Escape')cerrarMenu(); });

  const tabs = [...document.querySelectorAll('[role=tab]')];
  function mostrar(tab) {
    tabs.forEach(t => { const activo=t===tab; t.setAttribute('aria-selected',String(activo)); t.tabIndex=activo?0:-1; $(t.getAttribute('aria-controls')).hidden=!activo; });
  }
  tabs.forEach((t,i) => {
    t.addEventListener('click',()=>mostrar(t));
    t.addEventListener('keydown',e => {
      const n=e.key==='ArrowRight'?(i+1)%tabs.length:e.key==='ArrowLeft'?(i+tabs.length-1)%tabs.length:e.key==='Home'?0:e.key==='End'?tabs.length-1:null;
      if(n===null)return;e.preventDefault();mostrar(tabs[n]);tabs[n].focus();
    });
  });
  document.querySelectorAll('a[href="#costos-meta"]').forEach(a=>a.addEventListener('click',()=>{$('costos-meta').open=true;}));
  if(location.hash==='#costos-meta')$('costos-meta').open=true;

  const form=$('lead-form'), feedback=$('form-feedback'), submit=$('lead-submit');
  const cargadoEn=Date.now();
  const prefijo='Solicitud Xabor Pro: $900 MXN mensuales, instalación incluida y los módulos de la oferta Pro. Tarifas de Meta por mensajería no incluidas.';
  function avisar(texto,error=false) { feedback.textContent=texto;feedback.hidden=false;feedback.classList.toggle('es-error',error);feedback.focus(); }
  form.addEventListener('submit',async e => {
    e.preventDefault();if(submit.disabled)return;
    if(!form.reportValidity())return;
    const comentario=$('f-comentario').value.trim();
    const payload={nombre:$('f-nombre').value.trim(),negocio:$('f-negocio').value.trim(),ciudad:$('f-ciudad').value.trim(),telefono:$('f-telefono').value.trim(),tipoNegocio:$('f-tipo').value,volumenMensajes:$('f-volumen').value,comentario:prefijo+(comentario?' '+comentario:''),empresaWeb:$('empresa-web').value,cargadoEn};
    submit.disabled=true;submit.textContent='Enviando solicitud…';feedback.hidden=true;
    try {
      const r=await fetch('/api/public/prospectos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const d=await r.json();
      if(r.status===201&&d.ok){form.reset();avisar('Recibimos tu solicitud de Xabor Pro. Te contactaremos para preparar la configuración de tu negocio. Enviar esta solicitud no realiza cargos.');}
      else avisar(d.error||'No pudimos guardar tu solicitud. Intenta de nuevo.',true);
    }catch{avisar('No pudimos conectar. Revisa tu conexión e intenta de nuevo.',true);}
    finally{submit.disabled=false;submit.textContent='Solicitar Xabor Pro';}
  });
})();
