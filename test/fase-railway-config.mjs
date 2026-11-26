import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createRailwayContext} from 'railway/iac';
import configuracion from '../.railway/railway.ts';
const scope={projectId:'f38167de-f48c-457f-972c-3bc0a48c6135',environmentId:'23ef5879-22be-4740-9d47-34984792631d',environmentName:'production'};
test('rechaza otro proyecto, staging y un entorno de igual nombre con distinto ID',()=>{
  for(const cambio of [{projectId:'otro'},{environmentName:'staging-basico'},{environmentId:'otro'}])assert.throws(()=>configuracion(createRailwayContext({...scope,...cambio})),/únicamente a production/);
});
test('el despliegue toma el commit del checkout y conserva las credenciales mediante preserve',()=>{
  const p=configuracion(createRailwayContext(scope));const app=p.resources.find(r=>r.name==='xabor-agent');
  assert.equal(app.source.repo,'MapolatoPN/xabor-agent');assert.equal(app.source.commitSha,execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim());
  assert.equal(app.deploy.preDeployCommand[0],'node scripts/predeploy-run-032-033.mjs');
  assert.equal(app.deploy.healthcheckPath,'/health');assert.equal(app.deploy.restartPolicyMaxRetries,3);
  for(const clave of ['DATABASE_URL','SESSION_SECRET','RESEND_API_KEY','MP_SAAS_ACCESS_TOKEN','META_WHATSAPP_TOKEN'])assert.deepEqual(app.variables[clave],app.variables.ADMIN_PASSWORD);
  assert(!JSON.stringify(p).includes('APP_USR-'));assert(!JSON.stringify(p).includes('postgres://'));
});
test('el almacenamiento mantiene la capacidad actual y la base se declara como recurso existente',()=>{
  const p=configuracion(createRailwayContext(scope));const volumen=p.resources.find(r=>r.name==='postgres-volume');
  assert.equal(volumen.config.sizeMB,1000);assert.equal(p.resources.filter(r=>r.type==='database').length,1);assert.equal(p.resources.length,3);
});
