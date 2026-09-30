# Beta híbrida de restaurante — informe para revisión

Base de código: `6744742` (producción revisada: `25ccf44`).
Rama: `feat/mesero-beta-hibrido-20260930`.
Commit de implementación: `4ea8f71` (local, hecho desde PowerShell; sin push).

Diff para revisión antes de integrar:

```powershell
git diff 6744742..4ea8f71
```

## Alcance autorizado

Implementación y pruebas aisladas. El dueño revisa el informe antes del
despliegue y prueba después desde su teléfono. Esta tarea NO activa el bot
general, no agrega participantes, no publica Flows/catálogos, no envía mensajes
reales y no modifica producción.

## Objetivos de la beta

1. Responder consultas sin modificar ni sustituir el carrito por una venta.
2. Retomar explícitamente el pedido guardado, sin autorizar confirmaciones con
   un «sí» a una consulta. Las ventanas viejas no sobrescriben cambios recientes.
3. Copiar un platillo dentro del carrito, con sus opciones y nota, para después
   personalizarlo individualmente. Copiar una unidad, no todo el lote.
4. Preparar la recepción segura del carrito nativo de Meta: identificadores
   asociados al catálogo publicado de Xabor, precios y efectos decididos aquí.
5. Probar reintentos, aislamiento entre negocios, bot apagado y entrega humana.

## Límites de producto

- El carrito de Meta y el formulario no son la misma ventana. La beta no
  promete sincronización bidireccional automática ni controles +/- en Flows.
- El catálogo nativo requiere configurar/verificar el activo de Meta antes de
  una prueba real. No se inventará un catálogo ni se publicará esta noche.
- Recuperar el pedido guardado no equivale a recuperar campos escritos sin
  enviar en el teléfono. Nunca se dirá que se guardó lo que el servidor no recibió.
- Ubicación no determina por sí sola la zona de envío. Tarifas siguen en Xabor.
- Audio, fidelización, campañas, llamadas y nuevos pagos no son condición de
  salida de esta beta: se mantienen en las fases posteriores del plan.

## Resultado para el dueño

La primera etapa de la beta está implementada y probada localmente. No es un
despliegue ni una certificación de toda la operación del restaurante.

| Parte | Qué cambia para el cliente | Estado |
| --- | --- | --- |
| Conversación híbrida | Una consulta informativa conserva su respuesta; no se sustituye por una pregunta de venta. Puede aparecer «Continuar pedido». | Implementada; probada con modelo simulado. |
| Retomar | «Seguir pedido» o «abrir carrito» recupera el pedido y, si es compatible, la edición del formulario recibida por el servidor. | Implementado; expiración y ventanas antiguas probadas. |
| Otro igual | Copia una pieza con sus opciones y nota; después permite personalizarla por separado. La copia queda visible, incluso al pasar a otra página. | Implementado; necesita publicar la nueva versión del Flow antes de activarlo. |
| Carrito nativo de Meta | Prepara la entrada de cantidades de productos sencillos sin reconstruirlas con el modelo. | Recepción/backend implementados. Catálogo real, publicación y experiencia móvil pendientes. |
| Apagado y atención humana | Las respuestas nuevas de la beta vuelven a comprobar permiso al enviarse, incluso si son solo texto. | Probado: pausa, revisión humana, retiro del piloto, flag apagado y ventana vencida. |

Se conservan las mejoras anteriores: categorías, notas por platillo, bajas
múltiples, cantidades, deshacer, resumen legible y confirmación final separada.
El cambio no vuelve a introducir la eliminación de uno en uno.

## Lo bueno y lo que todavía no resuelve

- El cliente puede preguntar y volver al pedido; el modelo no obtiene permiso
  para modificarlo por contestar esa pregunta. Un «sí» posterior a la consulta
  no confirma el resumen viejo.
- Copiar evita repetir salsa, proteína, guarniciones y observaciones cuando
  se quiere otro platillo parecido. No copia el lote completo ni confirma nada.
- No se necesita una migración, una dependencia nueva ni cambiar pagos,
  impresión, horarios o tarifas de envío.
- La recuperación solo cubre el editor de un carrito ya guardado (`carrito_v1`),
  hasta 30 minutos y con una foto compatible. No recupera la primera selección
  de un pedido vacío, campos que siguen solo en el teléfono, ni una ventana
  finalizada. Si cambian productos, precios, opciones o el pedido, no mezcla
  aquella edición con la nueva.
- La consulta híbrida sigue dependiendo del intérprete para la calidad de la
  respuesta. Se probaron sus barreras y continuidad con dobles, no la calidad
  de todas las respuestas de un modelo real. No se promete entender cualquier
  frase ni un máximo universal de seis toques para ocho platillos distintos.
- El catálogo nativo aún NO es una tienda terminada dentro de WhatsApp. Esta
  entrega no manda mensajes de catálogo ni crea/vincula un activo en Meta.
- Un segundo carrito nativo, cuando Xabor ya tiene platillos, se rechaza con
  una explicación para evitar sumar dos veces la selección completa. Para
  editar/agregar se usa el Flow existente. Una nota global de catálogo también
  se rechaza: debe asignarse al platillo correcto en observaciones.
- «Repetir mi pedido anterior», ubicación/reutilizar dirección, audio y
  fidelización no están implementados por esta beta. Siguen siendo etapas
  futuras; no se presentan como objetivos ya terminados.

## Contratos técnicos y cambios de riesgo

1. **Webhook protegido:** se añade recepción durable de `order` con la firma,
   integración por negocio, deduplicación y worker existentes. No se aplica
   ningún carrito fuera de los flags y listas del piloto. Si llega junto con
   texto, gana el texto. No se convierte el payload en instrucciones del modelo.
2. **Autoridad comercial:** el receptor vuelve a leer el mensaje desde
   `whatsapp_entradas` por negocio, teléfono y wamid. El mapa por negocio enlaza
   `retailer_id` con un ID publicado de Xabor y opciones exactas. Moneda, precio
   mostrado, cantidad, disponibilidad e identidad se verifican. El precio de
   Meta es una comprobación, nunca la fuente del cobro. El motor de Xabor
   sigue calculando promociones y total.
3. **Atomicidad:** formularios y catálogo comparten un adaptador interno de
   comandos que trabaja sobre una copia y aplica todo o nada. Solo admite
   altas, edición, bajas, modalidad y forma de pago. No confirma, cobra ni
   imprime. No se expone como herramienta del modelo.
4. **Recuperación:** se copia el borrador compatible en la transacción del
   nuevo turno. Debe pertenecer al mismo negocio, sesión y ciclo, estar vigente,
   haber sido enviado y coincidir en toda la foto. El token antiguo no gana
   autoridad sobre la nueva pregunta.
5. **Entrega:** las respuestas de la beta llevan una marca interna persistida.
   Se revalida master, integración, piloto, pausa, takeover, revisión humana,
   flags y ventana de servicio antes del transporte. Si no se permite, se
   descarta sin enviar. Si falla la lectura, se reprograma sin enviar a ciegas.
   Esto no modifica la política de mensajes fuera de la beta.
6. **Compatibilidad:** por defecto la definición del Flow y su respuesta no
   agregan el campo de duplicación. La opción nueva requiere flag explícito y
   una definición publicada compatible; no debe activarse sobre el Flow viejo.

La revisión local del diff y las pruebas no sustituyen revisar la integración
contra el HEAD productivo que exista al momento de desplegar. No se tocó
`outbox.js` ni su NUL intencional.

## Pruebas ejecutadas

Todos los resultados finales siguientes fueron verdes. Postgres local 18.4,
Meta y modelo simulados; red externa bloqueada. No se utilizó una base remota.

| Comando | Resultado |
| --- | --- |
| `npm run test:incident` | Verde: gate obligatorio, continuidad y pedido canónico. |
| `npm run test:beta` | 6 grupos: alcance, consulta, ejecutor, autoridad nativa, rechazos, duplicación/reintentos/límites. Integrados también en predeploy. |
| `npm run test:beta:db` | 8/8: recuperación, invalidación, expiración, dedup, aislamiento, permisos al recibir y al enviar, error de lectura/reintento. |
| `npm run test:beta:webhook` | Firma inválida, HTTP firmado, dos servidores, reinicio, una aplicación/respuesta, segundo carrito, mezcla texto+carrito, fuera del piloto. |
| `node test/fase-flows-db.mjs` | 23/23. |
| `node test/fase-flows-webhook.mjs --carrito` | Recorrido cifrado por HTTP: tacos 2+3, mixtos x2, notas, dos bajas y cantidad en un guardado, deshacer, dos procesos y reinicio. |
| `node test/fase-outbox-entrega-db.mjs` | 25/25: aceptación, fallo posterior, concurrencia, descarte, reintentos y atención humana. |
| `npm run mesero:tools` | 66/66. |
| `npm run mesero:replay` | 26/26, cero invariantes críticas rotas; también pasa `cambio-despues-de-confirmar` en esta base. |
| `node test/fase-agente-ciclo-terminal.mjs` | 12/12. |
| `git diff --check` | Sin errores. |

La suite HTTP anterior crea exactamente un pedido **local** sintético de $420
al confirmar al final; no envía a cocina ni cobra. La nueva suite de catálogo
no confirma ningún pedido. Los importes de fixtures no son precios del negocio.

Se repitieron la suite pura de beta y `test:incident` en Node 20/Linux usando
una imagen local y montaje de solo lectura, con `--network none`: verdes.
También se repitieron las 8 pruebas SQL y el HTTP firmado de la beta en Node
20/Linux, conectando únicamente al Postgres local y al mock mediante la red
del contenedor; el preload bloqueó destinos externos. Las demás suites SQL/HTTP
se ejecutaron en Node 24/Windows. Esto no equivale a desplegar en Railway ni
a validar la nueva pantalla en el cliente de WhatsApp.

Incidentes del banco de pruebas, corregidos y no ocultados:

- La primera ejecución simultánea de dos suites HTTP compartía base local.
  Sus workers cruzaron fixtures y fallaron las aserciones del mock. Se separó
  una base por suite y se repitieron ambas con éxito. No hubo tráfico externo.
- La primera prueba con `node:20-slim` no resolvió `zod`: el `node_modules` del
  worktree es una unión de Windows. Se repitió con las dependencias Linux de
  la imagen local, montando el código nuevo en `/app/beta`, y pasó.

Bases conservadas para auditoría en `pg-candidato`, puerto local 55473:
`test_botones_beta_hibrida_20260930`, `test_botones_beta_http_20260930`,
`test_botones_beta_regresion_20260930` y `test_botones_beta_outbox_20260930`.
No ejecutar dos suites con workers contra la misma base, aunque usen puertos
distintos. Los scripts de beta exigen host local, prefijo `test_botones_` y
`NODE_OPTIONS=--import=./test/red-solo-local.mjs`.

## Preparación del piloto — solo después de aprobación

No se aplicó ninguno de estos valores a producción durante este trabajo.

| Configuración | Uso |
| --- | --- |
| `bot_whatsapp_solo_prueba=true` | Obligatoria para la beta; el porcentaje del agente no sustituye esta barrera. |
| `mesero_agente_telefonos` | Mantener únicamente al dueño; conservar sus alias 52/521 actuales. |
| `whatsapp_beta_hibrido_v1=true` | Habilita conversación/retomar y protección de entrega de la beta. Por defecto apagada. |
| `whatsapp_beta_telefonos` | Segunda lista cerrada, solo `528787899919`; se reconoce el alias `5218787899919`. |
| `whatsapp_flows_telefonos` | Mantener igualmente solo al dueño, sin ampliar participantes. |
| `whatsapp_flow_carrito_id` | ID de una nueva definición validada y publicada, si se habilita duplicación. |
| `whatsapp_flow_carrito_duplicar_v1=true` | Activar únicamente junto con ese Flow nuevo compatible. |
| `whatsapp_catalogo_nativo_v1` | Conservar `false` en el primer piloto conversacional. |

La definición local del editor con duplicación se genera sin publicar nada:

```powershell
node --input-type=module -e "import {definicionFlowCarrito} from './scripts/definicion-flow-carrito.mjs'; console.log(JSON.stringify(definicionFlowCarrito({duplicar:true}),null,2));"
```

Antes de habilitar catálogo nativo se requieren el activo real asociado al
negocio, elegibilidad/permisos, precios vigentes, `whatsapp_catalogo_meta_id`
y `whatsapp_catalogo_meta_mapa`. Ejemplo **ilustrativo, no para copiar**:

```json
[{"retailer_id":"taco-harina","producto_id":"ID_REAL_XABOR","opciones":[{"grupo":"Tortilla","opcion":"Harina"}]}]
```

Usar IDs reales publicados, no nombres deducidos. El mapa es por negocio.
El puente admite 1–50 renglones y 1–20 piezas por renglón, MXN. Estos son
límites de esta implementación, no una afirmación de los límites de Meta.

Referencias para la validación externa pendiente:
[webhooks oficiales de Meta](https://www.postman.com/meta/whatsapp-business-platform/folder/vzaxn16/webhook-payload-reference),
[mensajes de pedido](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/order),
[componentes Flow](https://developers.facebook.com/docs/whatsapp/flows/reference/components/).
Las dos últimas devolvieron HTTP 429 durante la comprobación final; no se
presenta el esquema nuevo como validado por Meta ni se usó una fuente de
terceros como aprobación de compatibilidad.

## Revisión y prueba de mañana

1. Revisar este informe y el diff de la rama; comprobar si producción avanzó.
2. Aprobar integración/despliegue y, por separado, publicación/configuración
   del nuevo Flow. Volver a pasar el gate sobre el candidato integrado.
3. Mantener los demás clientes en manual. Verificar identidad del build en
   Railway, no solo `/health`. Sin ampliar listas ni porcentaje.
4. El dueño inicia la conversación. Probar a su ritmo: agregar distintos
   platillos, duplicar uno con nota, cambiar cantidades y quitar varios.
5. Interrumpir con una pregunta de horario/precio; verificar que la conteste,
   no cambie el carrito y permita continuar. Abrir una ventana vieja: no debe
   sobrescribir. «Sí» a la consulta no debe confirmar.
6. Verificar opciones, notas, promociones, envío y total antes de una
   confirmación final explícita. No imprimir ni enviar pedidos de prueba a
   cocina sin coordinarlo primero.
7. Registrar wamids, tiempos y resultado del servidor, más la experiencia
   observada en el teléfono. Si falla, conservar evidencia y detener el piloto.

Reversión: deshabilitar la beta y catálogo, retirar duplicación y restaurar el
ID del Flow anterior, sin limpiar carritos ni conversaciones. Después de un
cambio de definición/flag se deben abrir formularios nuevos; los anteriores
no deben aplicarse sobre una foto diferente. No activar la atención general
como parte de la reversión.

`STATUS_CODEX: BETA_LOCAL_PROBADA_PENDIENTE_REVISION_Y_DESPLIEGUE`
