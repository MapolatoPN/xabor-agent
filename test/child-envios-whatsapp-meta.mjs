// Se ejecuta como proceso hijo (nunca importado directamente): server.js
// y whatsapp-meta.js tienen una dependencia circular preexistente
// (server.js importa el router de whatsapp-meta.js; whatsapp-meta.js
// importa getIntegracion de server.js) que solo resuelve en el orden
// real de producción -- entrando por server.js primero. Importar
// whatsapp-meta.js de forma aislada dispara un TDZ ReferenceError. Este
// archivo replica el orden real (server.js primero) y luego reutiliza
// la instancia ya inicializada de whatsapp-meta.js (import cacheado)
// para probar sus funciones exportadas sin levantar nada nuevo.
process.env.PORT = process.env.CHILD_PORT || '4099';

await import('../src/server.js'); // boot real -- resuelve el ciclo en el orden correcto
const { enviarMensaje, enviarImagen, notificarRepartidoresPorWA } = await import('../src/channels/whatsapp-meta.js');

const resultados = [];
function check(nombre, cond) { resultados.push({ nombre, ok: !!cond }); }

const r1 = await enviarMensaje('5215500000000', 'hola', null);
check('enviarMensaje sin credenciales -> null', r1 === null);

const r2 = await enviarImagen('5215500000000', 'https://example.com/x.png', '', undefined);
check('enviarImagen sin credenciales -> null', r2 === null);

let lanzo = false;
try { await notificarRepartidoresPorWA({ id: 'XAB-TEST', total: 100 }); } catch { lanzo = true; }
check('notificarRepartidoresPorWA sin negocioId no lanza', !lanzo);

console.log('RESULTADOS_JSON:' + JSON.stringify(resultados));
process.exit(resultados.every(r => r.ok) ? 0 : 1);
