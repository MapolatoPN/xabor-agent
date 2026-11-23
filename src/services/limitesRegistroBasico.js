import { createHmac } from 'node:crypto';
import { pool } from './database.js';
// Compartido entre réplicas/reinicios, sin almacenar IP o correo en esta tabla.
export async function permitirRegistroBasico(req){
  const email=typeof req.body?.email==='string'?req.body.email.trim().toLowerCase().slice(0,320):'';
  for(const [nombre,valor,limite] of [['ip',req.ip,5],['email',email,3]]){
    const clave=createHmac('sha256',process.env.SESSION_SECRET||'registro-local-sin-envio').update(nombre+':'+valor).digest('hex');
    const r=await pool.query(`INSERT INTO limites_registro_basico(clave) VALUES($1)
      ON CONFLICT(clave) DO UPDATE SET
        intentos=CASE WHEN limites_registro_basico.ventana<NOW()-INTERVAL '15 minutes' THEN 1 ELSE limites_registro_basico.intentos+1 END,
        ventana=CASE WHEN limites_registro_basico.ventana<NOW()-INTERVAL '15 minutes' THEN NOW() ELSE limites_registro_basico.ventana END
      WHERE limites_registro_basico.ventana<NOW()-INTERVAL '15 minutes' OR limites_registro_basico.intentos<$2
      RETURNING clave`,[clave,limite]);
    if(!r.rowCount)return false;
  }
  await pool.query("DELETE FROM limites_registro_basico WHERE ventana<NOW()-INTERVAL '1 day'");
  return true;
}
