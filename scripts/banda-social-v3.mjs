// Reescribe SOLO el texto de la banda promocional del arte social aprobado.
// Trabaja sobre el original a resolucion completa (1731x909) y reescala al
// final a 1200x630, igual que la v2, para no encadenar perdidas.
//
// Geometria medida sobre el original, no inventada:
//   banda   x 63..776, y 702..819, borde naranja #E86A23, relleno #060608
//   icono   circulo centro (122,761) radio ~45  -> se conserva intacto
//   viejo   texto blanco x 192..450 | separador x 489 | naranja x 560..746
//
// Century Gothic es la tipografia del sistema mas cercana a la geometrica del
// arte original (ceros circulares, trazo uniforme).
import sharp from 'sharp';

//   node scripts/banda-social-v3.mjs <arte-original.png> <intermedio.png> <salida.png>
const SRC = process.argv[2];
const SALIDA_FULL = process.argv[3];
const SALIDA = process.argv[4];
if (!SRC || !SALIDA_FULL || !SALIDA) {
  console.error('uso: node scripts/banda-social-v3.mjs <origen> <intermedio> <salida>');
  process.exit(1);
}
const NEGRO = '#060608';
const F = 'Century Gothic, Segoe UI, sans-serif';

const svg = `<svg width="1731" height="909" xmlns="http://www.w3.org/2000/svg">
  <!-- Borra el texto anterior sin tocar el marco de la banda ni el icono -->
  <rect x="182" y="706" width="586" height="110" fill="${NEGRO}"/>

  <!-- 1. El importe manda: a tamaño de miniatura es lo unico que se lee,
          y TOTAL va pegado a la cifra para que no se lean por separado -->
  <text x="196" y="787" font-family="${F}" font-size="72" font-weight="700"
        fill="#FFFFFF">$990</text>
  <text x="392" y="785" font-family="${F}" font-size="38" font-weight="700"
        fill="#FFFFFF" letter-spacing="2">TOTAL</text>

  <line x1="524" y1="724" x2="524" y2="798" stroke="#4E4E4E" stroke-width="2"/>

  <!-- 2. El periodo que cubre ese importe -->
  <text x="554" y="771" font-family="${F}" font-size="24" font-weight="700"
        fill="#F07429">Agosto + septiembre</text>

  <!-- 3. Letra chica, fuera de la banda, sobre el fondo de la pagina -->
  <text x="70" y="863" font-family="${F}" font-size="25" font-weight="400"
        fill="#98A1AC">Instalación incluida  ·  Después $990/mes</text>
</svg>`;

await sharp(SRC)
  .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
  .png().toFile(SALIDA_FULL);

await sharp(SALIDA_FULL)
  .resize(1200, 630, { fit: 'fill', kernel: 'lanczos3' })
  .png({ compressionLevel: 9 }).toFile(SALIDA);

const m = await sharp(SALIDA).metadata();
console.log(`${SALIDA}: ${m.width}x${m.height} ${m.format}`);
