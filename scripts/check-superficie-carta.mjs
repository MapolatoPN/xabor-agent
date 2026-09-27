// Barrera de predeploy: lo que un cliente de WhatsApp puede recibir sale de
// la carta publicada, y POST /chat no vuelve.
//
//  1. POST /chat no existe: era público, llamaba al modelo sin sesión ni
//     límite y registraba pedidos con el negocioId que escribiera el modelo.
//     (La otra puerta de la misma clase, el canal de voz —/ws/voice y
//     /webhook/voice/start—, se retiró el 27-sep-2026; la vigila
//     check-voz-retirada.mjs.)
//  2. El menú en imagen solo sale revisado contra la carta vigente (100):
//     enviarMenuAutomatico comprueba la revisión ANTES de mandar nada y manda
//     exactamente las storage keys que verificó.
//  3. Ningún módulo del bot manda imágenes por fuera de enviarMenuAutomatico.
//     (El envío manual del panel, server.js /api/imagenes/enviar, es de una
//     persona y queda permitido.)
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resultadoDelEnvioDeMenu } from '../src/mesero-agente/canalDelAgente.js';
import { cambiosDeCarta } from '../src/services/revisionMenuWhatsapp.js';

const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const leer = (ruta) => readFileSync(join(RAIZ, ruta), 'utf8');
const sinComentarios = (fuente) => fuente.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// 1 · /chat
const server = sinComentarios(leer('src/server.js'));
assert.ok(!/\bapp\.(get|post|put|patch|delete|all|use)\(\s*['"`]\/chat['"`/]/i.test(server),
  'server.js volvió a exponer /chat: una puerta pública al modelo');
assert.ok(!/\bprocesarMensaje\b/.test(server), 'server.js volvió a llamar al bot legacy directamente');

// 2 · el menú en imagen
const menu = sinComentarios(leer('src/services/menuAutomatico.js'));
const cuerpoEnvio = menu.slice(menu.indexOf('export async function enviarMenuAutomatico'));
const iRevision = cuerpoEnvio.indexOf('estadoRevisionParaEnvio(');
const iPrimerTexto = cuerpoEnvio.indexOf('enviarTexto(');
const iImagen = cuerpoEnvio.indexOf('enviarImagenBuffer(telefono');
assert.ok(iRevision > 0, 'enviarMenuAutomatico ya no comprueba la revisión del menú');
assert.ok(iRevision < iPrimerTexto && iRevision < iImagen,
  'enviarMenuAutomatico manda algo ANTES de comprobar la revisión');
assert.ok(!/leerImagenMenu\(/.test(cuerpoEnvio),
  'enviarMenuAutomatico vuelve a releer las páginas por id en vez de mandar las storage keys verificadas');
assert.deepEqual(resultadoDelEnvioDeMenu({ ok: false, motivo: 'imagen_sin_revisar', menuEnTexto: true, textoFallback: 'menú en texto' }),
  { ok: true, paginas: 0, comoTexto: true }, 'el Mesero diría «no pude mandar el menú» cuando ya salió en texto');
assert.equal(resultadoDelEnvioDeMenu({ ok: false, motivo: 'error_envio' }).ok, false);
assert.equal(resultadoDelEnvioDeMenu({ ok: false, motivo: 'imagen_sin_revisar', menuEnTexto: false, textoFallback: 'No pude enviar el menú' }).ok, false,
  'el aviso genérico no es un menú entregado');
assert.ok(/menuEnTexto:\s*Boolean\(textual\)/.test(cuerpoEnvio),
  'enviarMenuAutomatico ya no dice si salió un menú en texto o solo el aviso genérico');
const cambios = cambiosDeCarta(
  [{ id: 1, nombre: 'Hotcake', precio: 50, disponible: true }, { id: 2, nombre: 'Pieza de Hotcake', precio: 20, disponible: true }],
  [{ id: 1, nombre: 'Hotcake', precio: 55, disponible: true }, { id: 3, nombre: 'Waffle', precio: 60, disponible: true }]);
assert.deepEqual(cambios.retirados, ['Pieza de Hotcake']);
assert.deepEqual(cambios.agregados, ['Waffle']);
assert.equal(cambios.cambiados.length, 1);

// 3 · nadie más manda imágenes a un cliente
function archivos(dir) {
  const out = [];
  for (const n of readdirSync(join(RAIZ, dir))) {
    const ruta = join(dir, n);
    if (statSync(join(RAIZ, ruta)).isDirectory()) out.push(...archivos(ruta));
    else if (/\.(m?js)$/.test(n)) out.push(ruta.replace(/\\/g, '/'));
  }
  return out;
}
const llamadas = [];
for (const ruta of archivos('src')) {
  const fuente = sinComentarios(leer(ruta));
  // También cuenta las llamadas por propiedad (`wa.enviarImagen(`): cualquier
  // camino nuevo tiene que aparecer aquí.
  for (const m of fuente.matchAll(/(^|[^\w])(enviarImagenBuffer|enviarImagen)\(/gm)) {
    const antes = fuente.slice(Math.max(0, m.index - 20), m.index + m[1].length);
    if (/function\s*$/.test(antes)) continue; // su definición
    llamadas.push(`${relative(RAIZ, join(RAIZ, ruta)).replace(/\\/g, '/')}:${m[2]}`);
  }
}
assert.deepEqual(llamadas.sort(), ['src/server.js:enviarImagenBuffer', 'src/services/menuAutomatico.js:enviarImagenBuffer'],
  `un camino nuevo manda imágenes a clientes sin pasar por la revisión del menú: ${llamadas.join(', ')}`);

console.log('OK: sin /chat público, menú en imagen solo revisado contra la carta vigente, sin otros envíos de imagen del bot.');
