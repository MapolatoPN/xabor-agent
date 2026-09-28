# Prueba local de botones — 28 sep 2026

> Registro histórico del prototipo `8e64f10`. La integración posterior en el
> Mesero, sus pruebas y límites están en
> [botones-confirmacion-integracion-local.md](botones-confirmacion-integracion-local.md).

Rama: `prueba/botones-confirmacion-local`, sobre `4fd6eba` (propuesta v3).
Es un experimento separado: no integra la corrección del licuado `efac6de`
ni pretende sustituir el HEAD de producción.

## Resultado

Primera prueba del contrato de **Confirmar / Cambiar algo**, con datos
ficticios y sin enviar mensajes. El módulo vive en `experiments/`, no está
importado por el Mesero, webhook, outbox ni servidor. No cambia el bot actual.

- `node --test test/fase-botones-confirmacion-local.mjs`: **47/47**.
- `npm run test:incident`: **OK**, incluido el gate `predeploy-check-incidentes`,
  continuidad determinista y pedido canónico 19/19.
- `node --check experiments/botones-confirmacion/contrato.mjs`: OK.
- `git diff --check`: OK.

La prueba importa `test/red-solo-local.mjs`. El gate se ejecutó también con
ese bloqueo de red en `NODE_OPTIONS`. No se cargaron credenciales, no se
conectó a ninguna base y no se enviaron mensajes, pagos, pedidos ni impresiones.

## Qué se comprobó

1. Se construye la carga de dos botones con tokens aleatorios de 128 bits;
   la asociación y la huella completa quedan separadas de la carga a Meta.
2. El token de «Cambiar algo» sigue representando esa acción aunque el
   cliente mande el título «Confirmar». El título nunca autoriza.
3. Negocio, cliente, remitente, ciclo, pregunta y acuse deben coincidir.
4. Cambiar precio, cantidad, salsa, modalidad, pago, fecha, cliente o total
   invalida el resumen, aunque sus primeros 12 caracteres sigan iguales.
5. Bot apagado, pausa, atención humana, fuera del canario o ciclo cerrado
   impiden continuar. Los datos de las barreras deben ser positivos explícitos.
6. Texto y toque se conservan separados. Si comparten lote, no se ejecuta
   el toque. Medios y eventos no soportados tampoco permiten ejecutarlo.
7. Una pregunta reportada como reservada/consumida/incierta no autoriza otro
   toque. Ambos botones comparten la misma identidad de pregunta.
8. Sin acuse se solicita retención; tras el acuse se deben revalidar las
   barreras y la pregunta. Un acuse ajeno o salida incierta no valida.
9. Una ventana de servicio vencida, desconocida o futura no permite construir
   el mensaje. Un resumen demasiado largo no se trunca para hacerlo caber.

## Lo que NO demuestra

Esto **no es un E2E ni la fase 0 terminada**. `prevalidarToque` devuelve
`requiere_reserva_durable`, nunca «pedido confirmado». No escribe ni consume
nada, por lo que dos llamadas válidas consecutivas pueden devolver el mismo
resultado. Los tests de pregunta ocupada usan un estado preparado: NO prueban
exclusión entre procesos, persistencia real ni ausencia de pedidos duplicados.

Falta implementar y probar:

- firma del webhook, resolución del negocio y normalización de la identidad
  del cliente con los mecanismos existentes;
- tabla y reserva durable compartida por TODOS los botones de la pregunta;
- retención durable con vencimiento, acuse y recuperación tras reinicio;
- agrupamiento real de seis segundos y orden de procesamiento entre lotes;
- validación real de carta/precios/estado por Xabor, bajo control de revisión;
- registro, conciliación de efectos inciertos y respuesta única en outbox;
- comprobación de las 24 horas al enviar, no solo al preparar;
- pruebas con dos procesos, caídas y Meta simulado, y luego prueba visual real.

No hay migración, modificación de `whatsapp-meta.js`, feature flag, despliegue
ni envío real. Las decisiones de la propuesta no se convierten en aprobaciones
por haberlas ejercitado en un experimento.

## Siguiente paso

Obtener aprobación para tocar el receptor protegido `whatsapp-meta.js` y
preparar la migración de asociaciones en una rama local. Explicar el riesgo:
recibir botones no debe saltar pausa, atención humana, canario ni deduplicación;
una integración incorrecta podría confirmar un pedido equivocado o duplicarlo.
Primero completar fase 0 con servidor real y Meta simulado, sin enviar botones
reales. Después reservar y probar confirmación antes de cualquier canario.

La rama experimental NO debe desplegarse como reemplazo de producción.

## Referencias del formato

Se contrastó la carga `interactive / button / action.buttons[].reply` con
la [colección oficial de Meta: Send Reply Button](https://www.postman.com/meta/whatsapp-business-platform/request/ne00kt6/send-reply-button)
y la distinción `interactive` / `button` con su
[Messages Object](https://www.postman.com/meta/whatsapp-business-platform/folder/1dtuocp/messages-object).
La página directa de developers.facebook.com respondió 429 durante la consulta.
La propuesta v3 contiene el contrato completo, sus límites y decisiones pendientes.
