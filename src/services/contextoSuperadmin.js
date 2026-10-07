// Contexto por petición de la consola de Superadmin (migración 116).
//
// requireSuperadmin corre el resto de la petición dentro de este
// AsyncLocalStorage con { usuarioId, ip }. registrarAuditoriaPlataforma lo lee
// para guardar la IP de cada acción sin que los más de 70 sitios que la
// llaman tengan que pasarla a mano: una acción nueva queda registrada con su
// IP por construcción, no por disciplina.
//
// Módulo aparte a propósito: database.js lo importa y superadmin2fa.js
// importa database.js; tenerlo en cualquiera de los dos crearía un ciclo.
import { AsyncLocalStorage } from 'node:async_hooks';

export const contextoSuperadmin = new AsyncLocalStorage();

export function ipDelContextoSuperadmin() {
  return contextoSuperadmin.getStore()?.ip || null;
}
