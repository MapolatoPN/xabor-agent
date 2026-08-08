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
for (const lado of [32, 180, 192, 512]) {
  const png = await rasterizar(iconoSvg, lado);
  const nombre = `xabor-icono-${lado}.png`;
  writeFileSync(join(MARCA, nombre), png);
  salidas.push(`${nombre} (${png.length} bytes)`);
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
