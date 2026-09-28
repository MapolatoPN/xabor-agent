# Continuidad del licuado — corrección local del 28 sep 2026

Actualización: `efac6de` quedó incorporado como `f45a99a` en la
[candidata de botones sobre ab37545](botones-integracion-vigente-20260928.md).
El E2E del licuado volvió a pasar allí. Esto no implica despliegue ni activación.

## Evidencia y alcance

En la prueba observada sobre `7a933eb`, ciclo de prueba r260, dos solicitudes
de licuado con wamids distintos produjeron una sola línea (correcto), pero
la segunda respuesta preguntó Medida y dejó `pendiente=null` (incorrecto).
Después de Grande, «Plátano y fresa» no mutó el carrito y repitió Sabor sin
explicar que esas opciones también pertenecían a Fruta Extra.

La traza solo conserva el motivo `producto_no_publicado` de la redacción
descartada; no permite atribuirlo a un nombre concreto. No se modifica ese
filtro ni se afirman problemas de transporte que la evidencia no demuestra.

## Cambios

- El cierre solo conserva una oferta del modelo sobre un producto nuevo,
  presentado por el ejecutor, si no hubo intento de mutación. Buscar un
  producto ya agregado deja la pregunta canónica del pedido y su pendiente
  estructurada, incluso cuando se rechaza agregarlo por segunda vez.
- Una respuesta formada solo por elecciones compartidas entre grupos de la
  misma línea recibe una aclaración construida por Xabor desde el catálogo.
  Se explica qué grupos coinciden y se pregunta primero por uno de ellos.
  No se reparte la primera fruta al sabor y la segunda a un extra por orden
  de mención. No cambia precios, cantidades, validación ni autorización.
- La aclaración conserva el foco y la pregunta durable mediante el mismo
  cierre existente. Mensajes complejos/condicionales continúan por la ruta
  habitual. El helper no decide entre dos líneas ni reabre terminales.

No hay cambios en webhook, pagos, impresión, catálogo productivo, SQL ni
esquema del estado. No se implementan botones con este cambio.

## Pruebas

Antes del arreglo, seis de los ocho casos iniciales fallaron por los dos
defectos señalados. Después del arreglo y de añadir barreras de terminales:

- `scripts/check-continuidad-licuado.mjs`: 9/9; integrada en el gate obligatorio.
- `npm run test:incident`: verde (incluye predeploy, continuidad y 19/19
  del pedido canónico).
- Herramientas 66/66; replay 26/26 y cero invariantes críticas rotas.
- Emisión, ciclos, ciclo terminal y prompt coherente: verdes.
- Sin llamadas a modelos ni transporte externos; preload `red-solo-local`.

El fixture tiene precios deliberadamente sintéticos: chilaquiles $195,
licuado $55 y fruta extra Fresa $15. El total $265 demuestra que el extra
se cobra después de elegirlo explícitamente, no durante la ambigüedad;
no pretende representar precios actuales del negocio.

`test/fase-continuidad-licuado-webhook.mjs` exige Postgres local con nombre
`test_licuado_*` y preload de red local. Crea su propio negocio sintético,
usa dos servidores reales, Meta/Anthropic simulados, reentregas y reinicio
de ambos servidores antes de continuar. Comprueba el pedido completo, el
total, una sola confirmación, las respuestas del outbox y ausencia de fallos
ocultos del proveedor. La base desechable se conserva para auditoría.

Resultado E2E: **verde**, en `test_licuado_20260928`, contenedor local
`pg-candidato`. Trece salidas entregadas, ocho llamadas al mock de modelo
esperadas, dos líneas, un pedido de $265, sin escalado ni errores de proveedor.
La continuación posterior al reinicio se resolvió desde el estado persistido.

## Entrega y límites

Corrección preparada sobre la rama propia `fix/mesero-continuidad-licuado`.
Debe revisarse el diff antes de integrar sobre el HEAD productivo vigente,
preservando cambios ajenos, incluidas las migraciones 101 y 102.

No se ha hecho push, despliegue, activación ni reinicio de conversación.
No se declara certificada una conversación real con Meta a partir de mocks.
La propuesta de botones se actualiza en otra rama y otro commit documental.
