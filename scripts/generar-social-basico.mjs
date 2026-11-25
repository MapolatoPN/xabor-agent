import sharp from 'sharp';
import {fileURLToPath} from 'node:url';
const fuente=new URL('../public/brand/xabor-social-basico-v4.svg',import.meta.url);
const destino=new URL('../public/brand/xabor-social-basico-v4.png',import.meta.url);
await sharp(fileURLToPath(fuente)).png().toFile(fileURLToPath(destino));
console.log('Vista social Básico generada:1200×630.');
