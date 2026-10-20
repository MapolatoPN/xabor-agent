// Genera el par de claves de la actualización automática de Xabor Edge.
//
//   node scripts/edge/generar-clave-actualizaciones.mjs [--privada <ruta>]
//
// Se corre UNA vez, en la computadora del dueño.
//
//   - La clave PRIVADA firma cada versión nueva del Edge. Se guarda fuera
//     del repositorio (por omisión en %USERPROFILE%\.xabor\) y nunca va al
//     servidor ni a GitHub. Quien la tenga puede instalar código en las PCs
//     de los restaurantes: hay que respaldarla (USB, gestor de contraseñas) y
//     no compartirla.
//   - La clave PÚBLICA va en installer/clave-publica-actualizaciones.pem y
//     viaja dentro del instalador. Con ella cada Edge comprueba la firma.
//
// No sobrescribe nada. Si la privada se pierde, las PCs ya instaladas no
// aceptan versiones firmadas con otra: hace falta otro instalador con la
// clave pública nueva.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLICA = join(REPO, 'installer', 'clave-publica-actualizaciones.pem');

const args = process.argv.slice(2);
const i = args.indexOf('--privada');
const privada = resolve(i >= 0 && args[i + 1] ? args[i + 1] : join(homedir(), '.xabor', 'clave-privada-actualizaciones-edge.pem'));

// ¿Está dentro de algún repositorio git? Ahí un `git add .` la publicaría.
function dentroDeRepositorio(ruta) {
  let d = dirname(ruta);
  for (;;) {
    if (existsSync(join(d, '.git'))) return d;
    const arriba = dirname(d);
    if (arriba === d) return null;
    d = arriba;
  }
}

const repoDeLaPrivada = dentroDeRepositorio(privada);
if (repoDeLaPrivada || (privada + sep).startsWith(REPO + sep)) {
  console.error(`NO: la clave privada no puede quedar dentro de un repositorio (${repoDeLaPrivada || REPO}).`);
  process.exit(2);
}
if (existsSync(privada)) {
  console.error(`NO: ya existe ${privada}. No se sobrescribe: las PCs instaladas confían en esa clave.`);
  process.exit(2);
}
if (existsSync(PUBLICA)) {
  console.error(`NO: ya existe ${PUBLICA}. Si de verdad hay que cambiar de clave, bórrala a mano y genera un instalador nuevo.`);
  process.exit(2);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

mkdirSync(dirname(privada), { recursive: true });
writeFileSync(privada, privateKey, { mode: 0o600, flag: 'wx' });
writeFileSync(PUBLICA, publicKey, { flag: 'wx' });

console.log('Clave privada (respáldala, no la compartas):');
console.log(`  ${privada}`);
console.log('Clave pública (va en el instalador y en el repositorio):');
console.log(`  ${PUBLICA}`);
