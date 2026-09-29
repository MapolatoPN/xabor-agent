# Observaciones para cocina por platillo — 29 sep 2026

## Alcance y estado

Actualización: las notas se integran en el candidato de categorías y cantidades.
Ver `mesero-categorias-tacos-20260929.md` para validación de Meta, pruebas
integradas y estado de publicación. Lo siguiente conserva el registro inicial.

Implementación local sobre `c30a41c`, rama `feat/flows-pedido-agrupado-20260929`.
No publicada en Meta ni desplegada. Sin cambios de configuración, zonas,
conversaciones, pagos o impresoras de producción. No requiere migración.

El formulario repetible incluye un recuadro opcional **Nota para cocina** junto
a las opciones de cada platillo. Ejemplos: «Sin crema», «Huevos bien cocidos».
No agrega pantallas ni pasos obligatorios; conserva **Agregar más** y
**ORDEN COMPLETA**. Límite: 300 caracteres. Los extras siguen el catálogo.

## Contrato

- Cada nota pertenece al renglón recién agregado, incluso entre platillos iguales.
- Al agregar otro o cambiar de producto, el nuevo campo inicia vacío.
- Un error de selección conserva la nota válida del platillo actual; una revisión
  vencida no la copia a otro platillo.
- Se normalizan espacios y saltos de línea; no se trunca texto demasiado largo.
  Objetos, arreglos y caracteres de control se rechazan sin mutación parcial.
- El servidor guarda las notas en el borrador durable; el recibo final del Flow
  sigue siendo únicamente token y revisión. No admite platillos enviados en ese recibo.
- El ejecutor autoriza exclusivamente el texto y renglón exactos mediante una
  capacidad local no serializable. No convierte las observaciones en evidencia
  para agregar productos, cambiar cantidades, aplicar precios o confirmar.
- Los formularios y borradores sin `observaciones` siguen siendo válidos.
- El campo existente `items[].notas` transporta la nota al resumen y al pedido
  para cocina. Se reutilizan los renderizadores existentes; no se modificaron
  `orderManager.js`, `whatsapp-meta.js` ni el panel protegido.

## Pruebas locales

- `node scripts/check-flow-observaciones.mjs`: notas independientes, campo
  opcional, límites, normalización, rechazo atómico, capacidad exacta, resumen
  y texto que intenta cambiar cantidades/precios sin lograrlo.
- `npm run test:incident`: verde, incluida la nueva regresión en el gate obligatorio.
- `npm run mesero:tools`: 66/66.
- `node test/fase-flows-webhook.mjs --repetible`: verde con Postgres desechable
  `test_botones_observaciones_20260929`, red externa bloqueada y Meta/IA locales.
  Ocho platillos iguales con notas distintas u omitidas, dos procesos, doble
  envío, reinicio tras el tercero, notas persistidas en el resumen y pedido final.
  Una sola orden LOCAL de $1120; cero llamadas al modelo.
- `git diff --check`: verde.

No hubo impresión física ni prueba visual en WhatsApp real. No se reejecutó
la suite DB canónica completa; su fallo histórico `05-06` («la segunda»),
documentado antes de este cambio, no queda certificado ni corregido aquí.

## Publicación pendiente (con autorización del dueño)

1. Revisar este diff y validar la nueva definición de Meta generada por
   `scripts/definicion-flow-repetible.mjs`. La prueba local verifica estructura
   y payloads, pero no sustituye al validador ni al cliente móvil de Meta.
2. Crear/validar y publicar una NUEVA definición del Flow; conservar el ID anterior
   para reversión. No editar a ciegas un formulario publicado.
3. Desplegar el servidor revisado y verificar commit y resultado del deployment.
4. Cambiar únicamente el ID del Flow del piloto autorizado. No ampliar teléfonos,
   activar el bot global ni modificar zonas. Los formularios anteriores abiertos
   quedan sujetos a las barreras de vigencia existentes; no reiniciar conversaciones.
5. Probar en el teléfono piloto: dos chilaquiles iguales, uno «Sin crema», otro
   «Huevos bien cocidos», y uno sin nota. Verificar campo vacío al agregar otro,
   recuperación tras error, resumen por renglón y comanda.

El componente `TextArea` opcional está documentado en el ejemplo oficial de
[WhatsApp Flows](https://github.com/WhatsApp/WhatsApp-Flows-Tools/blob/main/articles/llama-chatbot-flows/agent-connect.json).
La aceptación del JSON completo nuevo por Meta sigue pendiente.
