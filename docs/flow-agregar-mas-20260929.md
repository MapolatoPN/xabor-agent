# Agregar más / ORDEN COMPLETA — 29 septiembre 2026

## Estado

El dueño autorizó completar la conexión cifrada y desplegar («despliega cuando
termines»), conservando exclusivamente su número piloto. Código funcional:
`581e952`. El Flow nuevo `3021606251515164` está en DRAFT: Meta aceptó su JSON
sin errores. SHA-256: `34300026dfbb2f8f1685b63a19263093593242b416c95f936c03d1cde3f2915a`.

Se comprobó que la clave pública anterior era solo espacio en blanco y los
Flows anteriores no usaban endpoint. Se creó la privada en memoria, se guardó
por stdin exclusivamente en Railway con `--skip-deploys` y Meta verificó la
pública como VALID. Huella pública SHA-256:
`ef19e5441a545f2a7676936bb1c1c0c8ff1eba48e472ce1c203760e4a4e549cb`.
Se preparó `WHATSAPP_FLOW_ENDPOINT=true`, sin disparar deployment.

Código desplegado en `24af3885adc2f85160b692aafea9cd5fc7cfea1d`.
Railway deployment `64b5664b-aad4-46cd-8f87-c9fff3d38246`: **SUCCESS**.
Migración 107 aplicada por el runner; gate financiero OK y barrera de datos
productivos 12/12. Ping firmado y cifrado a producción: HTTP 200, respuesta
descifrada `{"data":{"status":"active"}}`.

**La opción nueva no está activa en el teléfono.** El publicador detuvo la
operación ANTES de POST /publish: Meta reporta FLOW LIMITED porque falta la
suscripción a avisos de Flows. Ya no reporta errores de clave ni endpoint.
La app compartida `4005577379739305` está suscrita a `messages` (v25.0),
`account_update`, `history`, `smb_app_state_sync`, `smb_message_echoes`
(v26.0); no a `flows`. Callback vigente:
`https://xabor-agent-production.up.railway.app/webhook/whatsapp`.

No se cambió ese webhook compartido ni sus campos/versiones. Añadir `flows`
requiere autorización del dueño por afectar configuración a nivel de app,
no solo al número piloto. Después: comprobar que los campos, versiones y URL
previos permanezcan intactos, reconsultar salud, publicar y activar solo la
clave `whatsapp_flow_repetible_id`. El Flow nuevo sigue DRAFT y la clave nueva
no se creó; el piloto conserva el Flow anterior `1796759261645436`.
Persiste el aviso WABA 141006 sobre conversaciones iniciadas por la empresa;
no se cambió facturación ni se enviaron plantillas.

El push fue fast-forward desde `c903d13`. Al no aparecer despliegue automático,
se ejecutó una sola vez `railway redeploy --from-source`; hubo espera larga en
cola, construcción y transición. Los pings 404 durante esa transición fueron
contra la versión anterior; se volvió a verificar después de SUCCESS.

Lecturas READ ONLY: antes del despliegue, revisión 373, XAB-0981, seis
renglones; al cierre, revisión 379, sin folio y carrito vacío. El estado avanzó
durante la espera, por lo que no se afirma igualdad de la conversación al
final. No se ejecutó ningún reinicio, borrado de mensajes, modificación de
carrito ni creación de pedido por esta operación. Las allowlists siguen con
los mismos formatos 52/521 del número terminado en 9919, porcentaje cero y
solo prueba activo. La causa de ese avance no se investigó en este despliegue.

## Experiencia

- Un solo selector de platillo. Sus opciones aparecen en la misma ventana.
- «Agregar más» guarda ese platillo en el borrador y deja el selector vacío
  para el siguiente. No devuelve al chat ni manda otro mensaje.
- «ORDEN COMPLETA» agrega el último platillo y abre entrega/pago dentro de la
  misma ventana. Si el selector quedó vacío después de «Agregar más», termina
  con lo guardado, sin añadir un platillo ficticio.
- Entrega y pago se eligen una vez. «Revisar pedido» vuelve al chat con el
  resumen existente, incluidos sus bloques y negritas. La confirmación sigue
  separada: ninguno de estos pasos cobra, imprime ni confirma.
- Un error de opciones conserva las elecciones válidas del platillo actual.
- El borrador agregado sobrevive a reinicios y a reabrir el formulario mientras
  la pregunta siga vigente (30 minutos); las opciones aún no enviadas del
  platillo actual no tienen persistencia garantizada al cerrar WhatsApp.
- No hay tres espacios fijos. Hay una protección técnica de 50 nuevos
  renglones por ventana, con salida explícita al alcanzar el límite. No se
  promete capacidad infinita ni seis toques para cualquier combinación.

Meta permite un Footer por pantalla. «ORDEN COMPLETA» usa ese botón principal;
«Agregar más» es una acción secundaria EmbeddedLink con data_exchange, no un
enlace a una web externa. Su presentación exacta y el reseteo de controles
deben comprobarse en el iPhone, no inferirse de las pruebas de servidor.

## Arquitectura y riesgo

La repetición usa el endpoint nuevo `/webhook/flows/pedido`; no amplía el
webhook de mensajes ni modifica whatsapp-meta.js, brain.js, orderManager.js,
panel/index.html o las rutas protegidas de pedidos de server.js. Los únicos
cambios en server.js importan y montan la ruta nueva con su parser propio.

- Firma HMAC de Meta obligatoria antes de descifrar; RSA-OAEP SHA-256 y AES-GCM.
- Parser limitado a 64 KB; endpoint apagado por defecto; sin logs de tokens,
  conversaciones ni claves. Las claves de prueba se crean en memoria.
- Migración aditiva 107: `agente_flows_borradores`, ligada a la pregunta. No
  borra tablas ni activa banderas. Registrada en el runner de predeploy.
- En cada llamada: pregunta/ciclo/diálogo vigente, envío acreditado, bot y
  canario activos, teléfono permitido, sin pausa humana ni texto posterior.
- Lock de conversación y pregunta en el mismo orden que el consumo normal.
  Cada paso lleva revisión; doble toque o petición vieja nunca agrega dos veces.
- El endpoint guarda un borrador separado. NO cambia el carrito operativo.
- El cierre devuelve solamente token/revisión; los platillos se recuperan de
  Postgres, no de una lista recibida del cliente. El webhook habitual vuelve a
  validar catálogo, precios, opciones, huella y contexto antes de aplicar el
  lote al carrito atómicamente. La foto del catálogo se conserva durante la
  ventana; cambios de catálogo se rechazan al finalizar, no se aceptan con
  precios viejos.
- Sin `whatsapp_flow_repetible_id` y las variables requeridas continúa el
  formulario anterior. No se cambia el Flow ya publicado.

## Pruebas realizadas

- Gate obligatorio `node scripts/predeploy-check-incidentes.mjs`: OK; incluye
  `check-flow-repetible.mjs` (1, 2, 3, 4 y 8 platillos, campos inválidos,
  opciones cruzadas, errores conservando selección, límite técnico y cierre).
- `node test/fase-flow-endpoint.mjs`: OK; HTTP local con firma real, cifrado
  RSA/AES, ping, firma inválida, rechazo cifrado y bandera apagada.
- `node test/fase-flows-db.mjs`: 18/18, Postgres local y red externa bloqueada.
  Incluye ocho renglones con opciones distintas, peticiones concurrentes,
  reapertura, rechazo de recibo inventado y consumo único de la finalización.
- `node test/fase-flows-webhook.mjs --repetible`: OK; dos procesos HTTP reales,
  endpoint cifrado, reinicio después del tercer platillo, ocho platillos,
  reintentos concurrentes y solo dos mensajes salientes: apertura y resumen.
  Cero llamadas al modelo. Ningún pedido antes de confirmar; confirmación
  posterior creó exactamente un pedido LOCAL de $1120.
- `node test/fase-pedido-canonico.mjs`: 19/19.
- `npm run mesero:tools`: 66/66.

Los mocks de Meta no validan el esquema de Flow JSON ni su renderizado. No se
afirma una prueba real del formulario repetible. Los fallos históricos ajenos
a esta tarea (incluido el saludo con el importe del pedido anterior) no se
han corregido con este cambio.

## Secuencia de activación autorizada

1. Revisar este diff y comprobar que el número de migración 107 siga libre
   en producción. Rebase/integración solo tras revisar avances ajenos.
2. Crear una clave RSA propia de Flows con custodia segura; verificar primero
   si ya existe una clave registrada para no reemplazarla ni romper otros Flows.
   Registrar la pública en el número piloto de Meta, nunca en el repositorio.
3. Configurar `WHATSAPP_FLOW_PRIVATE_KEY` y `WHATSAPP_FLOW_ENDPOINT=true` en
   Railway; conservar `META_APP_SECRET` existente. Desplegar el commit revisado
   con gate y migración, verificando identidad real del build.
4. Crear un Flow NUEVO con `definicionFlowRepetible()` de
   `scripts/definicion-flow-repetible.mjs`, data API 3.0 y endpoint
   `https://xabor.mx/webhook/flows/pedido`. Validar JSON/endpoint con Meta antes
   de publicar; el publicador anterior no publica esta versión automáticamente.
5. Activar únicamente `whatsapp_flow_repetible_id` del negocio piloto, sin
   ampliar allowlist ni tocar pedidos, mensajes, pausa o conversación existente.
6. Probar un plato y ocho, opciones mixtas, cambio de producto, cierre/reapertura,
   volver atrás, doble toque, pantalla de entrega/pago y resumen en el iPhone.
   El comportamiento de la navegación atrás todavía requiere evaluación visual.

Reversión: retirar la configuración `whatsapp_flow_repetible_id` restaura el
formulario anterior. No bajar el esquema ni borrar conversaciones/borradores.

Operación: `preparar-cifrado-flow.mjs` exige ruta absoluta al binario de Railway
en `RAILWAY_EXECUTABLE`, protege cualquier clave preexistente y nunca imprime
secretos. `publicar-flows-pedido.mjs <negocio> publicar repetible` comprueba
cifrado y salud del endpoint. `configurar-piloto-flow-repetible.mjs` verifica
Flow, migración y allowlists antes de cambiar únicamente
`whatsapp_flow_repetible_id`; no enciende el bot ni reinicia conversaciones.

Referencias primarias consultadas:
- [Componentes de WhatsApp Flows](https://developers.facebook.com/docs/whatsapp/flows/reference/components/).
- [Endpoint de ejemplo oficial](https://github.com/WhatsApp/WhatsApp-Flows-Tools/tree/main/examples/endpoint/nodejs/book-appointment).
- [Cifrado oficial del endpoint](https://github.com/WhatsApp/WhatsApp-Flows-Tools/blob/main/examples/endpoint/nodejs/basic/src/encryption.js).
