const $=id=>document.getElementById(id);
const pesos=n=>new Intl.NumberFormat('es-MX',{style:'currency',currency:'MXN'}).format(Number(n)||0);
let menu=[],carrito=new Map(),ocupado=false,clave=crypto.randomUUID();
const mensaje=t=>{$('mensaje').textContent=t;};
async function api(path,opciones={}) {
  const r=await fetch(path,{credentials:'same-origin',cache:'no-store',...opciones,
    headers:{'Content-Type':'application/json',...opciones.headers}});
  if(r.status===401){location.replace('/login?redirect='+encodeURIComponent('/basico'));throw Error('Inicia sesión para continuar.');}
  if(r.status===402){location.replace('/suscripcion-basico');throw Error('Tu suscripción requiere renovación.');}
  const d=await r.json();if(!r.ok)throw Error(d.error||'No pudimos completar la operación.');return d;
}
function texto(tag,contenido){const el=document.createElement(tag);el.textContent=contenido;return el;}
function cambiarVista(id){
  for(const s of document.querySelectorAll('main>section'))s.hidden=s.id!==id;
  for(const b of document.querySelectorAll('[data-vista]'))b.setAttribute('aria-pressed',String(b.dataset.vista===id));
  mensaje('');if(id==='reportes')reporte().catch(e=>mensaje(e.message));
}
for(const b of document.querySelectorAll('[data-vista]'))b.onclick=()=>cambiarVista(b.dataset.vista);
function pintarCarrito(){
  $('carrito').replaceChildren();let total=0;
  for(const {producto:p,cantidad} of carrito.values()){
    total+=Number(p.precio)*cantidad;const fila=document.createElement('div');fila.className='fila';
    fila.append(texto('span',cantidad+' × '+p.nombre));const menos=texto('button','−');menos.setAttribute('aria-label','Quitar '+p.nombre);
    menos.onclick=()=>{if(ocupado)return;if(cantidad===1)carrito.delete(p.id);else carrito.get(p.id).cantidad--;pintarCarrito();};fila.append(menos);$('carrito').append(fila);
  }
  if(!carrito.size)$('carrito').append(texto('p','Todavía no agregas productos.'));
  $('total').textContent=pesos(total);$('cobrar').disabled=ocupado||!carrito.size;
}
async function cargarMenu(){
  menu=await api('/api/menu');$('catalogo').replaceChildren();$('lista-productos').replaceChildren();$('categoria').replaceChildren();
  if(!menu.length){const opcion=texto('option','General');opcion.value='__nueva__';$('categoria').append(opcion);}
  for(const c of menu){
    const option=texto('option',c.nombre);option.value=c.id;$('categoria').append(option);
    for(const p of c.productos){
      if(p.disponible&&!p.agotado){const b=document.createElement('button');b.className='producto';b.append(texto('strong',p.nombre),texto('small',pesos(p.precio)));
        b.onclick=()=>{if(ocupado)return;const actual=carrito.get(p.id);if(actual){if(actual.cantidad>=99){mensaje('Máximo 99 unidades de cada producto por venta.');return;}actual.cantidad++;}else carrito.set(p.id,{producto:p,cantidad:1});pintarCarrito();};$('catalogo').append(b);}
      const fila=document.createElement('form');fila.className='fila';fila.append(texto('span',p.nombre));
      const precio=document.createElement('input');precio.type='number';precio.min='0.01';precio.step='.01';precio.value=p.precio;precio.style.width='105px';precio.setAttribute('aria-label','Precio de '+p.nombre);
      fila.append(precio,texto('button','Guardar'));
      fila.onsubmit=async e=>{e.preventDefault();try{await api('/api/admin/menu/productos/'+p.id,{method:'PATCH',body:JSON.stringify({precio:Number(precio.value)})});await cargarMenu();mensaje('Precio actualizado.');}catch(e){mensaje(e.message);}};
      $('lista-productos').append(fila);
    }
  }
  if(!$('catalogo').children.length){const b=texto('button','Agrega tu primer producto');b.onclick=()=>cambiarVista('productos');$('catalogo').append(b);}
  const actuales=new Map(menu.flatMap(c=>c.productos).map(p=>[p.id,p]));
  for(const [id,item] of carrito){const p=actuales.get(id);if(!p||!p.disponible||p.agotado)carrito.delete(id);else item.producto=p;}
  pintarCarrito();
}
$('nueva-categoria').onsubmit=async e=>{e.preventDefault();try{await api('/api/admin/menu/categorias',{method:'POST',body:JSON.stringify({nombre:$('nombre-categoria').value})});e.target.reset();await cargarMenu();mensaje('Categoría guardada.');}catch(e){mensaje(e.message);}};
$('nuevo-producto').onsubmit=async e=>{e.preventDefault();const boton=e.target.querySelector('button');boton.disabled=true;try{let categoria=$('categoria').value;if(categoria==='__nueva__')categoria=(await api('/api/admin/menu/categorias',{method:'POST',body:JSON.stringify({nombre:'General'})})).id;await api('/api/admin/menu/productos',{method:'POST',body:JSON.stringify({nombre:$('nombre-producto').value,precio:Number($('precio-producto').value),categoria_id:categoria})});e.target.reset();await cargarMenu();mensaje('Producto guardado. Ya puedes venderlo.');}catch(e){mensaje(e.message);}finally{boton.disabled=false;}};
$('cobrar').onclick=async()=>{
  if(ocupado||!carrito.size)return;ocupado=true;pintarCarrito();mensaje('Guardando la venta…');
  try{
    const d=await api('/api/pedido-presencial',{method:'POST',headers:{'Idempotency-Key':clave},body:JSON.stringify({forma_pago:$('forma').value,items:[...carrito.values()].map(x=>({producto_id:x.producto.id,cantidad:x.cantidad})),nombre:'Mostrador'})});
    carrito.clear();clave=crypto.randomUUID();$('ultima').replaceChildren();
    const a=texto('a','Ver ticket digital · '+d.pedido.id);a.href='/ticket-venta/'+encodeURIComponent(d.pedido.id);a.target='_blank';a.rel='noopener';$('ultima').append(a);mensaje('Venta registrada por '+pesos(d.pedido.total)+'.');
  }catch(e){mensaje(e.message+' Puedes reintentar la misma venta.');}
  finally{ocupado=false;pintarCarrito();}
};
async function reporte(){
  const q=new URLSearchParams({desde:$('desde').value,hasta:$('hasta').value,todas:'1'});
  const d=await api('/api/reportes/ventas?'+q);$('vendido').textContent=pesos(d.resumen.total_ventas);$('cantidad').textContent=d.resumen.num_pedidos;$('historial').replaceChildren();
  for(const v of d.ventas){const tr=document.createElement('tr');tr.append(texto('td',v.folio||v.id),texto('td',pesos(v.total??v.venta_neta)));const td=document.createElement('td'),a=texto('a','Ver ticket');a.href='/ticket-venta/'+encodeURIComponent(v.folio||v.id);a.target='_blank';a.rel='noopener';td.append(a);tr.append(td);$('historial').append(tr);}
}
$('filtro-reporte').onsubmit=e=>{e.preventDefault();reporte().catch(e=>mensaje(e.message));};
$('configuracion').onsubmit=async e=>{e.preventDefault();try{await api('/api/config',{method:'PUT',body:JSON.stringify({nombre:$('nombre-negocio').value,ciudad:$('ciudad').value,telefono:$('telefono').value})});$('negocio').textContent=$('nombre-negocio').value;mensaje('Datos guardados.');}catch(e){mensaje(e.message);}};
async function iniciar(){
  await api('/api/auth/me');const config=await api('/api/config');
  $('negocio').textContent=config.nombre||'Mi negocio';$('nombre-negocio').value=config.nombre||'';$('ciudad').value=config.ciudad||'';$('telefono').value=config.telefono||'';
  const hoy=new Intl.DateTimeFormat('en-CA',{timeZone:config.timezone||'America/Mexico_City',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());$('desde').value=hoy;$('hasta').value=hoy;
  await cargarMenu();pintarCarrito();
}
iniciar().catch(e=>mensaje(e.message));
