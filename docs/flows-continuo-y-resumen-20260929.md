# Correcciones de experiencia — 29 septiembre 2026

## Estado de entrega

Implementación local para revisión; **sin push, despliegue ni activación**.
La configuración del piloto y la conversación del cliente no se modificaron.
El pedido real XAB-0969 de la prueba anterior no se canceló ni reinició.

## Qué cambia

- Un nuevo Flow reúne elección de producto y personalización. Al seleccionar
  un platillo, sus opciones aparecen en la misma ventana mediante
  `on-select-action: update_data`, sin completar un formulario intermedio,
  volver al chat, esperar un mensaje ni abrir otro formulario.
- Se pueden configurar uno, dos o tres platillos por ventana. Salsa, proteína,
  guarniciones, toppings y otros grupos vienen del catálogo publicado. Entrega
  y pago se seleccionan una sola vez, con las preferencias existentes precargadas.
- Tres es el límite de **nuevas líneas por formulario**, no del carrito. Un
  cuarto/quinto platillo se agrega con el mismo Flow y conserva lo anterior.
  Los Flows anteriores también permiten bloques adicionales: personalizan los
  renglones con opciones obligatorias pendientes, no los ya completados.
- El resumen usa bloques separados por producto, cantidad e importe del renglón
  destacados, opciones en otra línea y total destacado. No recorta opciones ni
  sustituye el total del motor. La reproducción de los cinco platos de la
  captura ocupa 618 caracteres con dirección ficticia y conserva los botones.

No son «seis toques garantizados»: elegir varias opciones requiere tocarlas.
Se elimina el intercambio de mensajes entre elecciones, no las decisiones del
cliente. Para añadir más de tres platos se vuelve al resumen y «Agregar otro».

## Autoridad y alcance

El selector devuelve códigos de la foto persistida, no nombres ni precios con
autoridad. Cada opción lleva producto y grupo en su código; una selección vieja
no se puede interpretar como la opción del mismo índice de otro producto.
Todos los campos y cardinalidades se validan antes de aplicar. Las mutaciones
se ejecutan sobre una copia y se vinculan al nuevo renglón exacto. Se conservan
el consumo único, el commit atómico, las barreras de pausa/bot apagado, la huella,
la expiración y la comprobación de ventana de 24 horas al enviar.

No se modificaron componentes protegidos, catálogo, migraciones, pagos ni
creación de pedidos. El formulario solo prepara un borrador; la confirmación
continúa siendo un paso separado.

La nueva configuración `whatsapp_flow_pedido_id` queda **ausente por defecto**.
Sin ella siguen disponibles los dos Flows actuales. La nueva ruta conserva
las restricciones de `whatsapp_flows_v1`, modo de prueba y lista de teléfonos.

## Validación

- `scripts/predeploy-check-incidentes.mjs`: OK, incluye las regresiones nuevas.
- `scripts/check-flows-pedido.mjs`: OK; una ventana, códigos cruzados, campos
  falsos, multiselección, cuatro renglones y rechazo sin escrituras parciales.
- `scripts/check-resumen-legible.mjs`: OK; cinco platos, descuento 139,
  envío 60 y total 838, importes de varias unidades y resumen largo sin recortar.
- `test/fase-flows-db.mjs`: **16/16** en Postgres local, red externa bloqueada.
- `test/fase-flows-webhook.mjs --continuo`: OK; dos procesos HTTP, webhook
  firmado, reinicio con formulario abierto, duplicados, tres + dos platillos,
  cero listas intermedias y exactamente un pedido LOCAL de 705 al confirmar.
- `test/fase-pedido-canonico.mjs`: **19/19**.
- `npm run mesero:tools`: **66/66**.
- Estado y continuidad determinista: OK.
- `test/fase-pedido-canonico-db.mjs`: **33/34**. El caso 05-06 «la segunda»
  espera Roja y falla. Se reprodujo **33/34 con el mismo fallo en e256efe**, en
  el worktree de referencia sin estos cambios. No se alteró ese caso para
  ocultarlo. Las aserciones de promociones se adaptaron únicamente al formato
  nuevo; descuento, caducidad, reconfirmación y total persistido sí pasan.

Meta aceptó el JSON del nuevo formulario:

- Flow **DRAFT**, no publicado: `1796759261645436`.
- Nombre: `xabor_pedido_agrupado_acf5eed5adcd`.
- SHA-256: `acf5eed5adcd5d8d51ef1e098df7c1080b250e40930f52de595a8960ad6a085d`.
- `validation_errors=[]`, una pantalla, 48 componentes.
- Dos intentos anteriores rechazados por la declaración de `const` quedaron
  como borradores sin publicar: `1109360288216149`, `1910124363715428`.
- Continúa el aviso WABA 141006 de facturación para conversaciones iniciadas
  por la empresa. No se cambió facturación ni se enviaron mensajes.

La consulta de solo lectura del catálogo real encontró 76 productos elegibles;
la carga de datos del formulario completo mide **455,709 bytes**. Falta comprobar
la aceptación del envío y la velocidad real de apertura en el teléfono. La
validación del JSON de Meta no prueba ese envío ni su renderizado.

## Antes de otra prueba real

1. Revisar el diff; integrar y desplegar el commit exacto aprobado, verificando
   el gate obligatorio y la identidad del build.
2. Publicar el borrador con
   `node scripts/publicar-flows-pedido.mjs <negocio> publicar pedido`.
3. Con autorización operativa, usar `scripts/configurar-piloto-flows.mjs` con
   los cinco argumentos habituales y el ID nuevo como sexto argumento. El
   script comprueba cuenta, estado PUBLISHED, nombre derivado del JSON revisado
   y piloto limitado al mismo número. No cambia el bot maestro ni las pausas.
4. Verificar en iPhone que elegir/cambiar/quitar un producto muestra y reinicia
   sus controles, que se puede cerrar la ventana sin mutar el carrito y que
   funcionan uno/tres platos y agregar cuarto/quinto. Revisar aceptación de
   Meta, tiempos y resumen, sin confirmar un pedido real innecesariamente.

La vista previa visual no pudo abrirse: el navegador de automatización informó
`No browser is available`. No se afirma que la UI ya esté verificada en un
dispositivo. Editar por formulario un carrito de más de tres líneas completas
sigue fuera de este cambio; conserva la alternativa conversacional existente.

Referencia técnica primaria consultada: [componentes de WhatsApp Flows](https://developers.facebook.com/docs/whatsapp/flows/reference/components/).
