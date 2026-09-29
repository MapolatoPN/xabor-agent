# Cantidades y eliminación en el editor — 29 septiembre 2026

## Solicitud y alcance

El dueño confirmó implementar y desplegar cantidad y «Eliminar este platillo».
Las capturas muestran que la × de un ingrediente solo vacía ese campo y la
validación obligatoria impide guardar; no existía una acción para quitar el
renglón. No se debe borrar ni reiniciar su carrito por consola.

## Contrato y experiencia

- «Cambiar algo» → elegir un renglón → editar cantidad/opciones o eliminarlo.
- Cantidad de 1 a 20, conservando preparación y nota para esas piezas. No se
  usa cero como una eliminación implícita.
- Eliminar abre una pantalla propia con número, cantidad y nombre del platillo.
  «Sí, eliminar platillo» quita todas las piezas de ese renglón. Volver con la
  flecha no envía ni aplica la eliminación. No pide ingredientes, entrega ni pago.
- Los demás renglones y datos se conservan. El motor de Xabor recalcula el
  pedido. Quitar el último deja un carrito vacío disponible para elegir de
  nuevo, no un pedido confirmado ni una cancelación de órdenes registradas.
- Solo cambia un renglón por envío. Cantidades, eliminación y opciones pasan
  por el mismo ejecutor/reconciliador existente y por su barrera de confirmación.

## Riesgo y controles

Una eliminación o cantidad mal asociada podría afectar otro platillo. El
formulario usa una foto persistida del pedido y un identificador de renglón;
no busca por nombre ni acepta precio/cantidad propuestos por el modelo. La
autorización interna no es serializable y queda ligada a estado, ciclo,
herramienta y argumentos exactos. Las cantidades autorizadas no se extienden
a renglones con el mismo nombre. Eliminar exige un booleano de confirmación
explícito y rechaza cualquier campo de edición mezclado con la eliminación.

Se conservan token, negocio, teléfono, TTL, consumo transaccional, deduplicación,
bot apagado, pausa humana y ventana de envío. Un formulario o resumen anterior
no autoriza cambios después de modificar el carrito. El Flow anterior sigue
siendo compatible hasta el cambio de ID; después queda invalidado por su foto.

No se modifican componentes protegidos, migraciones, categorías, catálogo,
tarifas, horarios, zonas, pagos ni las listas del piloto. No se envían mensajes
reales ni se crean pedidos, cobran pagos o imprimen tickets para verificar.

## Pruebas

- `npm run test:incident`: OK, incluye la regresión nueva en el gate obligatorio.
- `npm run mesero:tools`: 66/66.
- `node test/fase-agente-ciclo-terminal.mjs`: 12/12.
- `node test/fase-flows-db.mjs`: 22/22. Cantidad, eliminación exacta, último
  platillo, duplicados y confirmación antigua sin efectos.
- `node test/fase-edicion-cancelacion-webhook.mjs`: OK en base nueva
  `test_botones_eliminar_20260929`, esquema sin datos de producción. Webhooks
  firmados, dos servidores, reinicios antes de editar/eliminar, duplicados
  concurrentes, nueve renglones, ocho intactos, cero órdenes y cero llamadas
  al modelo. Meta/modelo simulados y red externa bloqueada.
- `git diff --check`: OK.

La primera ejecución DB comparaba los datos posteriores a eliminar con los
anteriores a editar: el editor había agregado correctamente `costo_envio:0`
para recoger. Se corrigió la expectativa para comparar justo antes/después
de eliminar; no se cambió cálculo ni comportamiento para hacer pasar la prueba.

## Meta y publicación

- Nuevo editor validado: `1668610027961778`, DRAFT al preparar el despliegue.
- Nombre: `xabor_editar_agrupado_bf4bfa399bd2`.
- SHA256: `bf4bfa399bd2fb7664fa2893da1e54c59f59d7f04511ecfe11061d739700d8eb`.
- Meta aceptó las tres pantallas y las ramas condicionales, sin errores JSON.
  Dos intentos anteriores de expresión compuesta fueron rechazados; esos
  borradores no se publicaron ni activaron. La versión válida usa dos `If`
  anidados, con protección independiente para «Entrega y pago».
- Sigue la advertencia 141006 de conversaciones iniciadas por la empresa.
  Este piloto responde al cliente; no modifica facturación ni usa plantillas.

Publicar únicamente el Flow validado y el código probado. Verificar commit
exacto y SUCCESS en Railway antes de cambiar `whatsapp_flow_editar_id`.
Actualizar solo esa clave con comparación y bloqueo; conservar todo lo demás.

Línea base leída sin mutación: editor `2342516913214213`, categorías
`1908733896776951`, nueve personas (18 representaciones) en ambas listas.
SHA256 de toda la configuración excepto editor:
`fb441bd83a54ba44e16062f2007e8635c06641f4490e3a5ed65c68e95ac074b1`.
Carrito del dueño: revisión 430, nueve renglones, sin folio, hash
`89efecdf5fba95fe96f7f862d89cfae4f497ddcf320fd897b6b0247f558711be`.

Rollback de interfaz: restaurar exclusivamente el ID `2342516913214213`
(editor anterior de opciones/notas). No borrar estados ni ampliar listas.
La comprobación de uso en teléfono físico queda pendiente del dueño; abrir
una invitación nueva después de desplegar, no reutilizar la ventana anterior.
