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

  // Demostración local: fotografías del catálogo de Mapolato, sin llamadas
  // al POS, sin registrar ventas y sin iniciar un checkout.
  const catalogo = new Map([...document.querySelectorAll('[data-demo-add]')].map(b =>
    [b.dataset.demoAdd, {nombre:b.dataset.name,precio:Number(b.dataset.price),foto:b.dataset.photo}]));
  const carrito = new Map([['78',1],['85',1]]);
  const dinero = n => new Intl.NumberFormat('es-MX',{style:'currency',currency:'MXN',maximumFractionDigits:0}).format(n);
  const avisoDemo=document.createElement('p');avisoDemo.className='sr-only';avisoDemo.setAttribute('role','status');
  $('demo-cart').after(avisoDemo);
  function pintarCarrito(foco){
    const area=$('demo-cart');area.replaceChildren();let total=0;
    for(const [id,cantidad] of carrito){
      const p=catalogo.get(id);if(!p)continue;total+=p.precio*cantidad;
      const fila=document.createElement('div');fila.className='cart-row';
      const img=document.createElement('img');img.src='/public/landing/images/mapolato-'+p.foto+'.jpg';img.alt='';img.width=42;img.height=42;
      const detalle=document.createElement('div'),titulo=document.createElement('p');titulo.className='cart-title';titulo.textContent=p.nombre;
      const controles=document.createElement('div');controles.className='cart-controls';
      for(const delta of [-1,1]){
        if(delta===1){const n=document.createElement('span');n.textContent=String(cantidad);controles.append(n);}
        const b=document.createElement('button');b.type='button';b.textContent=delta===1?'+':'−';
        b.dataset.demoProduct=id;b.dataset.demoDelta=String(delta);
        b.setAttribute('aria-label',(delta===1?'Aumentar ':'Reducir ')+p.nombre+' en la demostración');
        b.disabled=delta===1&&cantidad>=20;
        b.addEventListener('click',()=>{const siguiente=cantidad+delta;siguiente>0?carrito.set(id,siguiente):carrito.delete(id);pintarCarrito({id,delta});});controles.append(b);
      }
      detalle.append(titulo,controles);const precio=document.createElement('strong');precio.className='cart-price';precio.textContent=dinero(p.precio*cantidad);
      fila.append(img,detalle,precio);area.append(fila);
    }
    if(!carrito.size){const vacio=document.createElement('p');vacio.className='cart-empty';vacio.textContent='Elige un producto y descubre cómo funciona.';area.append(vacio);}
    $('demo-total').textContent=dinero(total);avisoDemo.textContent='Total de la demostración: '+dinero(total)+' MXN. No se generan pedidos ni cobros.';
    if(foco){const destino=area.querySelector('[data-demo-product="'+foco.id+'"][data-demo-delta="'+foco.delta+'"]')||document.querySelector('[data-demo-add="'+foco.id+'"]');destino?.focus();}
  }
  document.querySelectorAll('[data-demo-add]').forEach(b=>b.addEventListener('click',()=>{
    const id=b.dataset.demoAdd;carrito.set(id,Math.min((carrito.get(id)||0)+1,20));pintarCarrito();
  }));
  $('demo-clear').addEventListener('click',()=>{carrito.clear();pintarCarrito();});
  document.querySelectorAll('[data-demo-category]').forEach(b=>b.addEventListener('click',()=>{
    document.querySelectorAll('[data-demo-category]').forEach(c=>{const a=c===b;c.classList.toggle('is-active',a);c.setAttribute('aria-pressed',String(a));});
    document.querySelectorAll('[data-demo-add]').forEach(p=>{p.hidden=b.dataset.demoCategory!=='todos'&&p.dataset.category!==b.dataset.demoCategory;});
  }));
  document.querySelectorAll('[data-demo-target]').forEach(b=>b.addEventListener('click',()=>{const t=$('tab-'+b.dataset.demoTarget);mostrar(t);t.focus();}));
  document.querySelectorAll('[data-demo-table]').forEach(b=>b.addEventListener('click',()=>{
    document.querySelectorAll('[data-demo-table]').forEach(c=>{c.classList.toggle('is-selected',c===b);c.setAttribute('aria-pressed',String(c===b));});
    $('demo-mesa-title').textContent='Mesa '+b.dataset.demoTable;
    document.querySelector('.table-dish').hidden=!b.classList.contains('has-order');
  }));
  pintarCarrito();

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
