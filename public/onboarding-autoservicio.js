(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  function pintarPaso(p,i,permitido){
    const li=document.createElement('li');li.className='paso'+(p.completo?' completo':'');
    const numero=document.createElement('span');numero.className='numero';numero.textContent=p.completo?'✓':String(i+1);numero.setAttribute('aria-label',p.completo?'Completado':'Pendiente');
    const texto=document.createElement('div'),titulo=document.createElement('h3'),detalle=document.createElement('p');
    titulo.textContent=p.titulo;detalle.textContent=p.detalle;texto.append(titulo,detalle);li.append(numero,texto);
    if(p.enlace){
      if(permitido||p.id==='suscripcion'){
        const a=document.createElement('a');a.href=p.enlace;a.textContent=p.accion;li.append(a);
      }else{
        const bloqueo=document.createElement('span');bloqueo.className='bloqueo';bloqueo.textContent='Disponible al activar tu plan';li.append(bloqueo);
      }
    }
    return li;
  }
  async function cargar(){
    $('actualizar').disabled=true;$('estado').textContent='';
    try{
      const r=await fetch('/api/onboarding/estado',{credentials:'same-origin',cache:'no-store'});
      if(r.status===401){location.replace('/login?redirect=%2Fempezar');return;}
      if(r.status===404){location.replace('/app');return;}
      const d=await r.json();if(!r.ok)throw Error(d.error||'Esta guía requiere una cuenta de administrador.');
      $('bienvenida').textContent=d.negocio.nombre+' ya tiene su lugar en Xabor. Continúa desde donde te quedaste.';
      $('plan').textContent='Tu plan · Xabor '+(d.plan==='pro'?'Pro':'Básico');
      $('precio').textContent=new Intl.NumberFormat('es-MX',{style:'currency',currency:'MXN',maximumFractionDigits:0}).format(d.montoMensual)+' MXN / mes';
      $('condicion').textContent=d.accesoPermitido?(d.estadoComercial==='prueba'?'Tu prueba está activa. Puedes configurar tu negocio y empezar a vender.':'Tu plan está activo. Puedes usar las funciones contratadas.'):(d.diasPrueba===0?'Sin periodo gratuito. Autoriza tu suscripción; el acceso se habilita al comprobar el primer pago aprobado.':'Tu prueba o periodo pagado terminó. Renueva para continuar; tus datos se conservan.');
      $('suscripcion').textContent=d.accesoPermitido?'Ver mi suscripción':'Activar mi plan';
      const esenciales=d.pasos.filter(p=>!p.opcional),opcionales=d.pasos.filter(p=>p.opcional);
      $('pasos').replaceChildren(...esenciales.map((p,i)=>pintarPaso(p,i,d.accesoPermitido)));
      $('opcionales').replaceChildren(...opcionales.map((p,i)=>pintarPaso(p,i,d.accesoPermitido)));
      const completos=esenciales.filter(p=>p.completo).length;
      const progreso=document.querySelector('[role=progressbar]');progreso.setAttribute('aria-valuemax',String(esenciales.length));progreso.setAttribute('aria-valuenow',String(completos));
      $('barra').style.width=(100*completos/esenciales.length)+'%';$('avance').textContent=completos+' de '+esenciales.length+' pasos esenciales completados';
      $('nota-pro').hidden=d.plan!=='pro';$('contenido').hidden=false;
    }catch(e){$('estado').textContent=e.message;}
    finally{$('actualizar').disabled=false;}
  }
  $('actualizar').addEventListener('click',cargar);
  cargar();
})();
