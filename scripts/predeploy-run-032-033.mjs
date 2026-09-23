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
const CHECKS = [
  // Incidentes productivos del 21-sep: se prueban antes de tocar el esquema.
  // Si reaparece la doble confirmación, el menú pegado, el redirect de sesión
  // o el replay de pedidos viejos/cancelados, Railway conserva el deployment
  // anterior.
  'predeploy-check-incidentes.mjs',
];
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
  // 062 cierra P0-15C: un pedido programado nace como pedido ACTIVO, asi que su
  // folio ya esta reclamado como 'usado'. Sin la conversion atomica, el
  // programado queda pendiente para siempre y nunca se activa.
  '062-conversion-programada',
  // 063 cierra P0-11: deuda durable de emision operacional. Sin ella, un
  // pedido puede quedar aceptado en pedidos_activos sin ninguna obligacion
  // durable que garantice que llegue a cocina si el proceso muere antes de
  // terminar emitirPedido.
  '063-emision-operacional',
  '064-cortes-caja',
  // 067 amplia `tienda_promociones` con los tipos per-unit '2x1' y
  // 'segundo_descuento' (motor de promociones multi-canal). Idempotente y no
  // destructivo. Va aqui para que el ALTER corra ANTES de que el binario nuevo
  // (que ya conoce los tipos) empiece a atender pedidos.
  '067-promociones-multitipo',
  // 068 agrega `condiciones_modificadores` (jsonb) a `tienda_promociones`
  // (promociones condicionadas por modificadores). Idempotente y no destructivo:
  // solo una columna nullable. Corre ANTES de que el binario nuevo la lea.
  '068-promo-condiciones-modificadores',
  '070-compras-pagos-fondos',
  // 076 crea `conversacion_estado`: el pedido conversacional deja de vivir
  // solo en la memoria del proceso. Va ANTES de que el binario nuevo atienda
  // trafico -- `sesionDurable.js` escribe en cada turno, y un backend que
  // guarda en una tabla inexistente perderia el carrito igual que antes, solo
  // que ademas llenando el log de errores.
  '076-conversacion-durable',
  // 077 crea la constancia durable del webhook. Va ANTES del binario nuevo:
  // el webhook escribe ahi ANTES de acusarle recibo a Meta, asi que sin la
  // tabla fallaria cada mensaje entrante -- justo el punto que este cambio
  // quiere hacer seguro.
  '077-webhook-entrante',
  '078-whatsapp-continuidad',
  // 079 agrega rewards_config.canal_tienda. Va ANTES del binario nuevo
  // porque el mapa de canales de rewardsService la LEE en cada venta: sin la
  // columna, obtenerConfig devuelve una fila sin ese campo y la tienda
  // seguiria sin acumular -- exactamente el fallo que arregla. No enciende
  // nada para nadie (DEFAULT FALSE): el comportamiento solo cambia cuando un
  // negocio marca la casilla en su panel.
  '079-rewards-canal-tienda',
  // 080 crea el cliente canónico de la tienda (clientes_negocio y sus
  // satélites), agrega punteros NULLABLES a rewards_accounts y
  // pedidos_activos y el interruptor tienda_config.cuentas_clientes
  // (DEFAULT FALSE). Aditiva e idempotente; su backfill solo crea clientes y
  // pone punteros -- jamás mueve puntos (el predeploy lo verifica y aborta
  // si un saldo cambió). Va ANTES del binario nuevo porque el checkout con
  // sesión escribe pedidos_activos.cliente_id.
  '080-clientes-tienda',
  // 081 pone el índice (negocio, teléfono a 10 dígitos) sobre pedidos_activos
  // y hace el backfill de clientes_negocio desde los pedidos: solo INSERTA
  // clientes (DO NOTHING sobre los existentes); el predeploy aborta si
  // pedidos o Rewards cambian. Va ANTES del binario nuevo porque el tab
  // Clientes v2 lo consulta.
  '081-crm-clientes-negocio',
  // 082 añade a Restaurante el descuento de cuenta (con motivo y auditoría),
  // el efectivo recibido y el cambio por pago, y el contador de reimpresiones
  // del ticket. Solo columnas con default: el predeploy aborta si cambia el
  // número o el importe de cuentas, pagos o ventas de mesa. Va ANTES del
  // binario nuevo porque los totales de la cuenta leen descuento_monto.
  '082-restaurante-cobro',
  // 083 añade a Restaurante la división por consumo real: cobro_id y tipo de
  // cobro en los pagos, reverso auditado, la tabla de porciones por renglón
  // y la división del remanente. Solo columnas con default y una tabla
  // vacía; el predeploy aborta si cambia el número o el importe de cuentas,
  // pagos o ventas de mesa. Va ANTES del binario nuevo porque los totales
  // de la cuenta leen revertido_at.
  '083-restaurante-division-consumo',
  // 084 es la barrera durable contra una doble confirmación del agente. El
  // código productivo no puede arrancar confiando en agente_operaciones si el
  // predeploy no garantiza antes la tabla y sus dos UNIQUE (operación y
  // confirmación por ciclo de conversación).
  '084-agente-operaciones',
  // 085 depende de la 084 y conserva los efectos que aún no pudieron salir.
  // Debe existir antes de que el agente nuevo atienda el primer mensaje del
  // deployment.
  '085-agente-outbox',
  // 086 cierra el incidente XAB-0458: una confirmación de pago ya había
  // mandado la comanda a cocina, pero datos.estado conservaba pendiente_pago
  // y el replay podía ocultar el pedido del tablero. Repara las fotografías y
  // deja un trigger que las mantiene alineadas con el estado SQL autoritativo.
  '086-estado-pedidos',
  // 087 crea la configuración y el recibo idempotente de facturación por
  // negocio. Va antes del binario que expone esas rutas.
  '087-facturacion',
  // 088 agrega a cortes_caja tres columnas informativas (descuento_manual,
  // descuento_promocional, rewards_canjeados) -- solo ADD COLUMN con DEFAULT,
  // no bloquea nada ni le exige nada al binario viejo si algo sale mal. Va
  // ANTES del binario nuevo porque cerrarCorte()/listarCortes() ya las
  // nombran explícitamente en su INSERT/SELECT. (No existe la 087 en esta
  // rama -- feature de facturación aparte, sin commitear todavía.)
  '088-cortes-descuentos-promociones',
  // 089 le pone fecha a cada clave de `configuracion`, que es donde viven
  // todos los interruptores del producto y donde no había ni una. Va aquí, al
  // final, porque nada depende de ella para arrancar: es para poder contestar
  // «¿desde cuándo está así este negocio?» la próxima vez que haga falta.
  '089-configuracion-fechada',
  // 091 agrega tienda_promocion_usos.canal con DEFAULT compatible con el
  // binario anterior, backfill y NOT NULL. No toca limite_usos ni el ciclo
  // reserva/consumo; POS/WhatsApp son filas de auditoria, no de enforcement.
  '091-tienda-promocion-usos-canal',
  // 092 deja de sobrescribir la única devolución en datos.devolucion: crea un
  // ledger append-only y sólo backfillea la evidencia que aún existe.
  '092-devoluciones-venta',
];

for (const nombre of CHECKS) {
  // `test/` no entra a la imagen productiva (.dockerignore). Estos checks
  // viven junto al runner para que la barrera exista también dentro de Docker,
  // no solo en el checkout local.
  const ruta = join(__dirname, nombre);
  console.log(`[predeploy-run] Comprobando ${nombre}...`);
  try {
    execFileSync(process.execPath, [ruta], { stdio: 'inherit', env: process.env });
  } catch (e) {
    console.error(`[predeploy-run] FALLO en ${nombre} -- se conserva el deployment anterior.`);
    process.exit(1);
  }
}

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

// La migración puede haber sido idempotente/no-op, pero el binario nuevo no
// puede arrancar si alguna tabla, índice o columna financiera sigue faltando.
// Esta barrera corre DESPUÉS de 087/088/090/091 y es exclusivamente READ ONLY.
console.log('[predeploy-run] Ejecutando gate financiero...');
try {
  execFileSync(process.execPath,
    [join(__dirname, 'release-gate-financiero.mjs')],
    { stdio: 'inherit', env: process.env });
} catch (e) {
  console.error('[predeploy-run] FALLO en gate financiero -- se conserva el deployment anterior.');
  process.exit(1);
}

// Última puerta, ya con el esquema completo: inspecciona en READ ONLY todos
// los negocios que tienen el agente encendido. Un checkout huérfano, un pago
// sin derivar, una carta vacía o dos pedidos idénticos vivos conservan el
// deployment anterior.
console.log('[predeploy-run] Ejecutando barrera de datos productivos...');
try {
  execFileSync(process.execPath,
    [join(__dirname, 'release-gate.mjs'), '--db-only', '--all-agent-businesses'],
    { stdio: 'inherit', env: process.env });
} catch (e) {
  console.error('[predeploy-run] FALLO en barrera de datos -- se conserva el deployment anterior.');
  process.exit(1);
}
console.log('[predeploy-run] Todos los pasos completados.');
process.exit(0);
