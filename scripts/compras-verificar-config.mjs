// Solo inspecciona configuración. No conecta a DB, IA ni almacenamiento.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function verificarConfiguracion(env = process.env) {
  const problemas = [];
  if (!env.ANTHROPIC_API_KEY?.trim()) problemas.push('Falta ANTHROPIC_API_KEY para leer fotos.');
  const driver = (env.STORAGE_DRIVER || 'local').trim().toLowerCase();
  if (!['s3','local'].includes(driver)) problemas.push('STORAGE_DRIVER debe ser local o s3.');
  if (driver === 's3') {
    for (const key of ['S3_BUCKET','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY'])
      if (!env[key]?.trim()) problemas.push('Falta '+key+'.');
  } else if (driver === 'local' && (env.RAILWAY_ENVIRONMENT_ID || env.NODE_ENV === 'production')) {
    const destino = fileURLToPath(new URL('../storage/documentos', import.meta.url));
    const montaje = env.RAILWAY_VOLUME_MOUNT_PATH;
    const relativa = montaje ? path.relative(path.resolve(montaje), destino) : null;
    if (relativa === null || relativa === '..' || relativa.startsWith('..'+path.sep) || path.isAbsolute(relativa))
      problemas.push('El almacenamiento local de tickets necesita un volumen que cubra storage/documentos; verificar montaje en Railway o usar S3.');
  }
  return { driver, problemas };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const resultado = verificarConfiguracion();
  console.log('Almacenamiento:',resultado.driver);
  for (const problema of resultado.problemas) console.error('PENDIENTE:',problema);
  console.log('Esta revisión no prueba credenciales, permisos ni persistencia real. Completar prueba de foto y recuperación tras reiniciar en staging.');
  process.exitCode = resultado.problemas.length ? 1 : 0;
}
