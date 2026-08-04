// Normalización de teléfono compartida — extraída de whatsapp-meta.js
// para que database.js (detección de duplicados en el roster de
// repartidores) y whatsapp-meta.js (dedupe de envío en modo completo/
// piloto) usen EXACTAMENTE el mismo criterio, nunca dos implementaciones
// paralelas que pudieran divergir.
//
// Deliberadamente sin dependencias hacia server.js/whatsapp-meta.js (leaf
// util) -- evita el problema de import circular ya detectado entre esos
// dos módulos.
//
// Normaliza a los últimos 10 dígitos para poder comparar sin importar si
// el teléfono viene con o sin código de país (los datos reales en
// `repartidores.telefono` están mezclados: algunas filas tienen 10
// dígitos, otras traen el prefijo 521 -- higiene de datos fuera de
// alcance de este cambio, ver docs/piloto-notificaciones-repartidor.md
// sección 10).
export function normalizarTelefonoMX(telefono) {
  if (typeof telefono !== 'string') return null;
  const soloDigitos = telefono.replace(/\D/g, '');
  if (soloDigitos.length < 10) return null;
  return soloDigitos.slice(-10);
}
