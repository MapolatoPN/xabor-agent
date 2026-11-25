import sharp from 'sharp';
import {fileURLToPath} from 'node:url';
await sharp(fileURLToPath(new URL('../public/brand/xabor-planes-v5.svg',import.meta.url)))
  .png().toFile(fileURLToPath(new URL('../public/brand/xabor-planes-v5.png',import.meta.url)));
console.log('Vista social de planes generada:1200×630.');
