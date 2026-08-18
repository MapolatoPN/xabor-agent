// Runner del Pre-Deploy Command de Railway para este release.
//
// Railway NO interpreta "&&" como un shell (comprobado en el deploy de
// hoy: con preDeployCommand="node a.mjs && node b.mjs" solo corrio a.mjs
// -- el resto quedo como argv ignorado, sin error, sin abortar). Este
// runner ejecuta cada script como su PROPIO proceso hijo (execFileSync),
// para que el process.exit(0) interno de cada uno nunca mate al runner
// antes de tiempo, y se detiene (exit 1) si cualquiera de los dos falla.
//
// Cada migracion sigue viviendo en su propio script angosto
// (predeploy-032-notificaciones-repartidor.mjs, predeploy-033-token-
// aceptacion-repartidor.mjs, predeploy-034-modo-conversacion-repartidor.mjs)
// -- este runner no duplica su logica, solo los invoca en orden. El nombre
// de archivo se quedo en "032-033" por no generar un rename innecesario;
// la lista SCRIPTS de abajo es la fuente de verdad de qué corre.
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = [
  '032-notificaciones-repartidor',
  '033-token-aceptacion-repartidor',
  '034-modo-conversacion-repartidor',
  '035-perfil-repartidor',
  '036-entregado-at-pedidos',
  '037-central-operaciones',
  '038-red-repartidores-config',
  '039-restaurante-mesas',
  '040-restaurante-integracion-ventas',
  '041-usuarios-mesero-pin',
  '042-password-reset',
  '043-impresion-edge',
  '045-nombre-visible',
  '046-auditoria-actor',
  '048-menu-automatico',
  '049-whatsapp-coexistence',
  '050-menu-multiimagen',
  '051-tienda-online',
  '052-impresion-legacy-idempotente',
  '053-impresion-legacy-pendientes',
  '054-pagos-routing-y-ids',
  '055-pagos-ciclo-vida',
  '056-pagos-expiracion',
  '057-promo-reservas',
  '058-compras-reales',
  // 059 va DETRAS de 058 y no es opcional: el codigo nuevo llama a
  // `nextval('folio_pedido_seq')` en cada pedido. Sin esta linea, un deploy
  // normal dejaria binario que exige una secuencia que nadie creo, y
  // `registrarPedido` fallaria en el primer pedido.
  '059-folio-durable',
  // 060 va PEGADA a la 059: es la barrera que hace segura la ventana en la que
  // el binario viejo --con su contador en memoria-- sigue vivo mientras la
  // secuencia ya existe. Sin ella, OLD puede reinsertar un folio historico que
  // el UNIQUE de `pedidos_activos` no bloquea porque ya no esta activo.
  '060-barrera-folio',
  // 061 sustituye la barrera de la 060 por un ledger de claims: cubre las 12
  // fuentes de folio que la 059 ya reconocia, no solo `pedidos`, y exige que la
  // activacion de un programado demuestre SU identidad, no solo su numero.
  '061-folios-claim',
];

for (const nombre of SCRIPTS) {
  const ruta = join(__dirname, `predeploy-${nombre}.mjs`);
  console.log(`[predeploy-run] Ejecutando predeploy-${nombre}...`);
  try {
    execFileSync(process.execPath, [ruta], { stdio: 'inherit', env: process.env });
  } catch (e) {
    console.error(`[predeploy-run] FALLO en predeploy-${nombre} -- se aborta el deploy.`);
    process.exit(1);
  }
}
console.log('[predeploy-run] Todos los pasos completados.');
process.exit(0);
