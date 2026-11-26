// Ejecuta el CLI oficial. En Windows el SDK necesita la ruta del .exe real
// para comprobar la versión: un shim .ps1 no funciona con execFileSync.
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';

const [command,...args]=process.argv.slice(2);
if(!['plan','apply'].includes(command))throw Error('Usa plan o apply para la configuración de Railway.');
const cli=process.env.RAILWAY_CLI_BINARY || (process.platform==='win32'
  ? join(process.env.APPDATA||'','npm/node_modules/@railway/cli/bin/railway.exe') : 'railway');
if(process.platform==='win32'&&(!isAbsolute(cli)||!existsSync(cli)))throw Error('Define RAILWAY_CLI_BINARY con la ruta del ejecutable oficial railway.exe.');
const r=spawnSync(cli,['config',command,...args],{env:{...process.env,_:cli},stdio:'inherit',windowsHide:true});
if(r.error)throw r.error;
process.exitCode=r.status??1;
