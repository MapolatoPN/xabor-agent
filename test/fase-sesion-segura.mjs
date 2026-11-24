import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.SESSION_SECRET='QA_SESION_CANONICA_LOCAL_SIN_CREDENCIALES';
const {crearTokenSesion,verificarTokenSesion,revocarTokenSesion,
  crearTokenPreAuth,verificarTokenPreAuth,reemitirTokenSesion}=await import('../src/services/session.js');
const identidad={usuarioId:'qa-usuario',negocioId:'qa-negocio',rol:'admin'};
const variantes=token=>{
  const [payload,firma]=token.split('.');
  return [token+'.extra',token+'.',payload+'.'+firma+'zz',payload+'.'+firma+'0',payload+'.'+firma.toUpperCase()];
};
const firmar=payload=>{
  const b64=Buffer.from(JSON.stringify(payload)).toString('base64url');
  return b64+'.'+createHmac('sha256',process.env.SESSION_SECRET).update(b64).digest('hex');
};

test('logout no se evade añadiendo segmentos ni variando la firma hexadecimal',()=>{
  const token=crearTokenSesion(identidad);
  assert.equal(verificarTokenSesion(token)?.usuarioId,identidad.usuarioId);
  revocarTokenSesion(token);
  assert.equal(verificarTokenSesion(token)===null,true);
  for(const variante of variantes(token))assert.equal(verificarTokenSesion(variante)===null,true);
});

test('preselección acepta solo el token íntegro y con caducidad numérica',()=>{
  const token=crearTokenPreAuth(identidad.usuarioId);
  assert.equal(verificarTokenPreAuth(token),identidad.usuarioId);
  for(const variante of variantes(token))assert.equal(verificarTokenPreAuth(variante)===null,true);
  const ahora=Date.now();
  for(const exp of ['sin-caducidad','9999999999999',null]) {
    assert.equal(verificarTokenPreAuth(firmar({usuarioId:identidad.usuarioId,tipo:'seleccion_pendiente',iat:ahora,exp}))===null,true);
    assert.equal(verificarTokenSesion(firmar({...identidad,iat:ahora,exp}))===null,true);
  }
});

test('reemisión de sucursal conserva tiempos; la cookie anterior revocada no reaparece',()=>{
  const original=crearTokenSesion(identidad),payload=verificarTokenSesion(original);
  const siguiente=reemitirTokenSesion(payload,{negocioId:'qa-sucursal-2',rol:'staff'});
  revocarTokenSesion(original);
  assert.equal(verificarTokenSesion(original)===null,true);
  const actual=verificarTokenSesion(siguiente);
  assert.equal(actual.negocioId,'qa-sucursal-2');assert.equal(actual.rol,'staff');
  assert.equal(actual.iat,payload.iat);assert.equal(actual.exp,payload.exp);
});
