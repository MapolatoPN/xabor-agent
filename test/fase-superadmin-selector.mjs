import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const fuente = readFileSync(new URL('../panel/cambio-sucursal.js', import.meta.url), 'utf8');

function entorno(respuesta, { pendiente = false, confirmar = true, soporte = false } = {}) {
  const elementos = [];
  function crear(tag) {
    const e = { tag, children: [], attrs: {}, dataset: {}, style: {}, hidden: true, disabled: false,
      classList: { add() {} }, append(...h) { this.children.push(...h); }, appendChild(h) { this.children.push(h); },
      setAttribute(k,v) { this.attrs[k]=v; }, getAttribute(k) { return this.attrs[k]; },
      addEventListener(k,fn) { this[k]=fn; }, focus() { this.enfocado=true; }, contains(el) { return this.children.includes(el); },
      getBoundingClientRect() { return { right:300,bottom:50 }; },
      querySelectorAll(q) { return elementos.filter(x => q === 'button' && x.tag === 'button' && x !== boton); },
      querySelector(q) { return elementos.find(x => q === '.ms-error' ? x.className === 'ms-error' : x.tag === 'button' && x !== boton && !x.disabled); },
    };
    elementos.push(e); return e;
  }
  const boton=crear('button'); boton.id='btn-sucursal';
  const peticiones=[], confirmaciones=[];
  const global={ document: { head:crear('head'), body:crear('body'), createElement:crear,
    getElementById:id=>elementos.find(e=>e.id===id), addEventListener() {} },
    location:{href:'/app',reload() {}}, localStorage:{setItem() {}}, addEventListener() {}, innerWidth:390,
    confirm(texto) { confirmaciones.push(texto); return confirmar; },
    async fetch(url,opciones) { peticiones.push({url,opciones}); return {ok:true,json:async()=>respuesta}; },
  };
  vm.runInNewContext(fuente,{window:global});
  return { global, elementos, boton, peticiones, confirmaciones,
    iniciar:()=>global.XaborCambioSucursal.iniciar({negocioId:'propio',soporte,trabajoSinGuardar:()=>pendiente}),
    superadmin:()=>elementos.find(e=>e.className==='ms-superadmin'),
  };
}
const sucursales=[{negocioId:'propio',nombre:'Sucursal propia',etiqueta:'Propia',rol:'admin',actual:true}];

test('un superadmin de una sola sucursal también tiene el acceso de plataforma',async()=>{
  const e=entorno({sucursales,puedeCambiar:false,puedeAbrirSuperadmin:true}); await e.iniciar();
  assert.equal(e.boton.hidden,false);
  assert.equal(e.superadmin().attrs.role,'menuitem');
  e.superadmin().click();
  assert.equal(e.global.location.href,'/superadmin');
  assert.equal(e.peticiones.length,1,'navegar no crea soporte ni cambia sucursal');
});
test('ser admin de sucursales no muestra Superadmin sin autorización del servidor',async()=>{
  for(const valor of [false,undefined,'true',1]) {
    const e=entorno({sucursales,puedeCambiar:true,puedeAbrirSuperadmin:valor}); await e.iniciar();
    assert.equal(e.superadmin(),undefined);
  }
});
test('un usuario de una sola sucursal sin superadmin conserva el selector oculto',async()=>{
  const e=entorno({sucursales,puedeCambiar:false,puedeAbrirSuperadmin:false}); await e.iniciar();
  assert.equal(e.boton.hidden,true);
});
test('soporte no obtiene un selector ni una salida que reutilice la sesión de soporte',async()=>{
  const e=entorno({sucursales,puedeAbrirSuperadmin:true},{soporte:true}); await e.iniciar();
  assert.equal(e.peticiones.length,0); assert.equal(e.superadmin(),undefined);
});
test('abrir Superadmin protege el pedido sin guardar y permite cancelar la salida',async()=>{
  const e=entorno({sucursales,puedeAbrirSuperadmin:true},{pendiente:true,confirmar:false}); await e.iniciar();
  e.superadmin().click(); assert.equal(e.global.location.href,'/app'); assert.equal(e.confirmaciones.length,1);
});
test('confirmar la salida navega al superadmin sin enviar el carrito ni alterar la sucursal',async()=>{
  const e=entorno({sucursales,puedeAbrirSuperadmin:true},{pendiente:true}); await e.iniciar();
  e.superadmin().click(); assert.equal(e.global.location.href,'/superadmin'); assert.equal(e.peticiones.length,1);
});
test('el panel carga la versión exacta del selector y conserva los reportes publicados',()=>{
  const panel=readFileSync(new URL('../panel/index.html',import.meta.url),'utf8');
  assert(panel.includes(`/cambio-sucursal.js?v=${createHash('sha256').update(fuente).digest('hex').slice(0,8)}`));
  assert(panel.includes('/reportes-consejero.js?'));
});
