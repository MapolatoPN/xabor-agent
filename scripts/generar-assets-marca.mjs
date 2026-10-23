// Genera los assets de marca derivados a partir de los SVG fuente.
//
//   node scripts/generar-assets-marca.mjs
//
// Fuente única: public/brand/xabor-icono.svg (el isotipo aprobado — cuadrado
// redondeado #C96220 con la X blanca, el mismo que ya usaba la landing).
// Todo lo demás (PNG del apple-touch-icon, iconos del manifest, favicon.ico y
// la imagen de vista previa social) se DERIVA de ahí, para que no vuelva a
// existir una copia del logo por pantalla que se desincronice.
//
// Se ejecuta a mano cuando cambie la marca; los resultados se versionan en el
// repo para que el arranque no dependa de generarlos.
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MARCA = join(__dirname, '..', 'public', 'brand');
const iconoSvg = readFileSync(join(MARCA, 'xabor-icono.svg'));
const socialSvg = readFileSync(join(MARCA, 'xabor-social.svg'));

// density alta: el SVG mide 32×32, sin esto el rasterizado sale borroso.
const rasterizar = (svg, lado) =>
  sharp(svg, { density: Math.max(72, lado * 4) }).resize(lado, lado).png({ compressionLevel: 9 }).toBuffer();

// Íconos de la app instalada (iPad/iPhone y Android). El isotipo es una X
// transparente que llega hasta el borde, y eso falla en los dos:
//  · iOS no admite transparencia en el ícono de pantalla de inicio: la rellena
//    de NEGRO y además redondea las esquinas, cortando las puntas de la X.
//  · Android recorta los íconos "maskable" a su forma (círculo, gota…); solo
//    garantiza visible el círculo central de radio 40 % del lado.
// Por eso estos llevan fondo sólido, sin canal alfa, y la X centrada con
// margen. `escala` es la fracción del lado que ocupa el cuadro del isotipo.
// Fondo blanco con la X naranja: opción A que eligió Mario el 22-oct-2026.
const FONDO_APP = '#FFFFFF';
async function iconoOpaco(svg, lado, escala) {
  const isotipo = await rasterizar(svg, Math.round(lado * escala));
  return sharp({ create: { width: lado, height: lado, channels: 3, background: FONDO_APP } })
    .composite([{ input: isotipo, gravity: 'center' }])
    .removeAlpha().png({ compressionLevel: 9 }).toBuffer();
}

// ICO con un PNG embebido (soportado por todo navegador actual). No se usa
// una librería nueva: el contenedor son 22 bytes de cabecera.
function empaquetarIco(png, lado) {
  const cabecera = Buffer.alloc(6);
  cabecera.writeUInt16LE(0, 0);        // reservado
  cabecera.writeUInt16LE(1, 2);        // tipo: icono
  cabecera.writeUInt16LE(1, 4);        // número de imágenes
  const entrada = Buffer.alloc(16);
  entrada.writeUInt8(lado >= 256 ? 0 : lado, 0); // ancho (0 = 256)
  entrada.writeUInt8(lado >= 256 ? 0 : lado, 1); // alto
  entrada.writeUInt8(0, 2);            // paleta
  entrada.writeUInt8(0, 3);            // reservado
  entrada.writeUInt16LE(1, 4);         // planos
  entrada.writeUInt16LE(32, 6);        // bits por pixel
  entrada.writeUInt32LE(png.length, 8);
  entrada.writeUInt32LE(22, 12);       // offset de los datos
  return Buffer.concat([cabecera, entrada, png]);
}

const salidas = [];
// 32/192/512 siguen transparentes: pestaña, Windows y el propósito "any" del
// manifest se ven bien sin fondo.
for (const lado of [32, 192, 512]) {
  const png = await rasterizar(iconoSvg, lado);
  const nombre = `xabor-icono-${lado}.png`;
  writeFileSync(join(MARCA, nombre), png);
  salidas.push(`${nombre} (${png.length} bytes)`);
}

// apple-touch-icon: la X ocupa el 62 % del lado y sus puntas quedan lejos de
// las esquinas redondeadas.
const apple = await iconoOpaco(iconoSvg, 180, 0.62);
writeFileSync(join(MARCA, 'xabor-icono-180.png'), apple);
salidas.push(`xabor-icono-180.png (${apple.length} bytes, opaco)`);

// Maskable: al 56 % la punta más lejana de la X queda a ~33 % del lado desde
// el centro, dentro del círculo seguro del 40 %.
for (const lado of [192, 512]) {
  const png = await iconoOpaco(iconoSvg, lado, 0.56);
  const nombre = `xabor-icono-maskable-${lado}.png`;
  writeFileSync(join(MARCA, nombre), png);
  salidas.push(`${nombre} (${png.length} bytes, opaco)`);
}

const png32 = readFileSync(join(MARCA, 'xabor-icono-32.png'));
writeFileSync(join(MARCA, 'favicon.ico'), empaquetarIco(png32, 32));
salidas.push(`favicon.ico (${empaquetarIco(png32, 32).length} bytes)`);

// Vista previa social: 1200×630 es lo que esperan WhatsApp, Facebook y X.
const social = await sharp(socialSvg, { density: 144 }).resize(1200, 630).png({ compressionLevel: 9 }).toBuffer();
writeFileSync(join(MARCA, 'xabor-social.png'), social);
salidas.push(`xabor-social.png (${social.length} bytes)`);

console.log('Assets de marca generados en public/brand:');
for (const s of salidas) console.log('  ' + s);
