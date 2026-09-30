// Entrada: JSON local {cfg:{whatsapp_catalogo_meta_id,whatsapp_catalogo_meta_mapa},catalogo:[]}
// catalogo debe ser la carta PUBLICADA de WhatsApp, no el menú operativo/POS.
// No abre DB, llama a Meta, manda mensajes, publica ni enciende banderas.
import assert from 'node:assert/strict';
import { readFileSync,statSync } from 'node:fs';
import { revisarMapaCatalogoNativo } from '../src/mesero-agente/catalogoNativo.js';
const [archivo,...sobrantes]=process.argv.slice(2);
assert(archivo && !sobrantes.length,'Indica una foto local JSON del catálogo y mapa');
assert(statSync(archivo).size<=2*1024*1024,'Foto demasiado grande');
const r=revisarMapaCatalogoNativo(JSON.parse(readFileSync(archivo,'utf8')));
console.log(JSON.stringify(r,null,2));
process.exitCode=r.ok?0:1;
