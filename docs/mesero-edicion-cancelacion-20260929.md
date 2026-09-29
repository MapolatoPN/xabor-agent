# Cancelación y edición de pedidos del piloto — 29 septiembre 2026

## Autorización y alcance

El dueño autorizó corregir y desplegar ambos problemas, conservando su
carrito hasta que él decida cancelarlo. No resetear conversaciones, cancelar
pedidos por consola ni ampliar el piloto de nueve personas.

## Evidencia y causas

- Mensaje entrante 12558, «Cancelar ese pedido»: el modelo propuso
  `cancelar_pedido`, pero el contrato rechazó `ese` como objeto del verbo.
  Resultado `cancelacion_sin_autorizacion`, sin mutación. El agente devolvió
  el resumen del borrador. No fue una caída de Meta ni del servidor.
- Mensaje 12566, «Cambiar algo»: el borrador tenía nueve renglones completos,
  sin folio. El editor antiguo solo presentaba tres renglones y, con más de
  tres completos, no construía ningún formulario. Se prometía revisar las
  selecciones, pero no aparecía una ventana ni una alternativa útil.

## Cambios

- Cancelación inequívoca del borrador por el ejecutor existente, sin depender
  del modelo. `ese/este pedido` y `esa/esta orden` nombran el pedido completo;
  `ese`, `ese taco`, preguntas, condiciones, negaciones y pedidos anteriores
  no autorizan vaciarlo. Las negaciones se verifican por cláusula, preservando
  «mejor ya no, cancélalo» como instrucción explícita.
- Después de cancelar un borrador vacío, un saludo abre un ciclo nuevo.
  Folios, confirmaciones inciertas, carritos con contenido y cierres fallidos
  no se reabren por esta regla. Un formulario previo no restaura lo cancelado.
- Editor nuevo: escoger un renglón del pedido y editar opciones/nota dentro
  de la misma ventana. Cada apertura muestra todos los renglones (límite de
  seguridad 50), con numeración para distinguir platillos iguales. También
  permite elegir «Entrega y pago» sin alterar platillos.
- Guarda un solo renglón por envío y conserva los demás. No modifica cantidad,
  agrega productos, confirma ni cobra. Se puede volver a «Cambiar algo» para
  otro renglón. Los importes se recalculan en Xabor, no en el formulario.
- Reutiliza asociación durable, foto completa, huella, TTL, autorización por
  negocio/cliente/ciclo y aplicación atómica. IDs de opciones ligados a línea
  y grupo. Precio, catálogo, selección o configuración cambiados invalidan
  una respuesta antigua. Campo de nota omitido conserva; vacío explícito borra.
- Sin editor disponible se ofrece una alternativa explícita por texto o ayuda
  humana; ya no se promete una ventana inexistente.

## Riesgo y controles

Se modifica el canal del Mesero y su contrato de cancelación: una autorización
demasiado amplia podría borrar un borrador, y un índice mal resuelto podría
editar otro plato. Por eso se prueban negaciones, condiciones y cambios
parciales, además de identidad exacta, serialización, duplicados y reinicios.
Las barreras de bot apagado, pausa humana, teléfono, ventana de 24 horas y
confirmación permanecen en el mismo recorrido.

No se modifican componentes protegidos de `CLAUDE.md`, migraciones, horarios,
zonas, tarifas, catálogo, pagos, pausas ni conversaciones de producción.
La nueva vista solo se activa con `whatsapp_flow_editar_id`, detrás del piloto
existente de Flows. No se modifica el Flow de categorías.

## Verificación local

- `npm run test:incident`: OK, incluye `check-edicion-cancelacion.mjs`.
- `npm run mesero:tools`: 66/66.
- `node test/fase-agente-ciclo-terminal.mjs`: 12/12.
- `node test/fase-flows-db.mjs`: 21/21, incluida edición del noveno platillo,
  doble respuesta, cancelación, formulario anterior y nuevo ciclo.
- `node test/fase-edicion-cancelacion-webhook.mjs`: OK, webhook Meta firmado,
  dos procesos, reinicio antes de responder, mismo `wamid` concurrente,
  respuesta repetida con otro ID, edición del noveno, cancelación y saludo.
  Cero pedidos creados y cero llamadas al modelo en ese recorrido.
- `git diff --check`: OK.

DB local desechable, Meta/modelo simulados y red externa bloqueada. El primer
intento HTTP falló porque una base compartida contenía salidas pendientes de
otra fixture; el mock detectó un destinatario distinto y abortó. Se repitió
en `test_botones_edicion_cancelacion_20260929`, base nueva con solo esquema,
y pasó. No se silenció la comprobación de destinatario. La suite HTTP debe
usar una base exclusiva sin trabajos pendientes de otras suites.

## Flow de Meta

- ID validado: `2342516913214213`.
- Nombre: `xabor_editar_agrupado_c4aa7d206022`.
- SHA256: `c4aa7d2060229ead245c845aae148cb2041db33ca6a426aa76ab04fd0cff13c8`.
- Validación JSON: sin errores. Dos pantallas `PEDIDO` → `EDITAR`, sin endpoint
  nuevo. Estado al preparar el despliegue: DRAFT, todavía no activado.
- Persiste advertencia WABA 141006 sobre conversaciones iniciadas por la
  empresa. El piloto responde a mensajes entrantes; no se cambia facturación
  ni se envían plantillas.

## Despliegue y prueba móvil pendientes

Revisar el diff, publicar el commit probado y verificar SUCCESS y commit en
Railway. Publicar el Flow validado; luego agregar exclusivamente
`whatsapp_flow_editar_id`, verificando ambas listas exactas de nueve personas
y toda la demás configuración antes y después. No usar scripts antiguos que
reducen el piloto a un único teléfono.

Para retirar solo el nuevo editor, quitar esa clave restaura la alternativa
anterior (texto para un carrito grande); no borrar estado ni cambiar listas.
Revertir código requiere un nuevo commit revisado, no force push.

No se han enviado mensajes reales ni se ha comprobado esta ventana en un
teléfono físico. La prueba móvil deberá abrir una invitación nueva. Guardar
cambios muestra un resumen, pero solo la confirmación explícita crea un pedido.

## Despliegue y activación completados

- Commit de código `c1a3314a8323dd5200fe85e355689453f0df6e57`, hecho desde
  PowerShell. Diff entregado antes de integrar. Push fast-forward desde
  `1f31cc9` a `prod/mesero-shadow-v3`, sin force push.
- Dos consultas confirmaron que el push no inició un despliegue; se ejecutó
  una sola vez `railway redeploy --yes --from-source` sobre el servicio y
  entorno explícitos.
- Deployment `ed1eb56d-eb58-4a6b-8bd7-d8a40ebb754d`: **SUCCESS** con el
  commit exacto `c1a3314`. Logs verifican la nueva regresión «cancelación y
  edición» y todos los pasos del predeploy completados. `/health`: HTTP 200,
  usado como comprobación adicional, no como identidad del build.
- Meta confirmó **PUBLISHED**, sin errores JSON, para `2342516913214213`.
  Se verificó su pertenencia a la cuenta del negocio, nombre y estado antes
  de activar.
- Después del SUCCESS, transacción con bloqueo agregó solo
  `whatsapp_flow_editar_id=2342516913214213`. No existía previamente.
  Comparación de toda la configuración excepto esa clave antes, dentro de
  la transacción y después del COMMIT: idéntica. SHA256 de esa configuración:
  `fb441bd83a54ba44e16062f2007e8635c06641f4490e3a5ed65c68e95ac074b1`.
- Ambas listas conservan exactamente las 18 representaciones de las mismas
  nueve personas; porcentaje cero, modo de prueba y demás banderas intactos.
  Categorías conserva el Flow `1908733896776951`.
- Borrador del dueño: revisión 425, nueve renglones y folio nulo antes y
  después. Comparación SHA256 del carrito idéntica; no se canceló ni reseteó.

Pendiente únicamente la prueba real de uso en el teléfono: escribir «Hola»
para recibir un resumen vigente y abrir «Cambiar algo». Si decide cancelar
el borrador completo, escribir «Cancelar ese pedido»; esa es una acción del
cliente, no una parte automática del despliegue. No se enviaron mensajes
reales, crearon pedidos, cobraron pagos ni imprimieron tickets para verificar.
