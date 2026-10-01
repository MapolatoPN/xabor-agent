# Menú de WhatsApp: reducir la espera de navegación

Base `42c6799`, rama `fix/whatsapp-latencia-navegacion`.

## Diagnóstico

Consulta productiva de solo lectura mediante `medir-latencia-whatsapp.mjs`,
ventana de seis horas, sin exportar mensajes, teléfonos ni tokens:

| Ruta | Turnos / con acuse | p95 recepción → aceptación Meta | p95 cola estimada | p95 modelo |
| --- | --- | --- | --- | --- |
| Sin modelo | 15 / 14 | 7.808 s | 7.083 s | 0 s |
| Con modelo | 3 / 3 | 13.826 s | 7.058 s | 6.680 s |

Muestra pequeña; no representa un SLA. Hay una salida con error en la ruta
sin modelo y dos recuperaciones en la ruta con modelo. Las salidas sin acuse
no entran al percentil. Aceptación de Meta no equivale a entrega al teléfono.
Las lecturas de datos tienen p95 de 36 ms y el envío de 810 ms o menos.
Los percentiles por etapa no deben sumarse como si fueran el mismo turno.

El coordinador espera seis segundos después del último mensaje para agrupar
texto y botones. Esa espera domina las rutas sin IA.

## Cambio y riesgo

Un único toque verificado en Ordenar, Facturación o Servicio para eventos
puede ejecutarse después de 500 ms. La asociación se consulta por token,
negocio, teléfono, ciclo y mensaje saliente entregado; no por título visible.
El procesamiento mantiene los locks, checkpoints y validaciones habituales.
No se cambia el modelo, el catálogo, el precio ni la confirmación.

Texto, formularios, selecciones de productos, confirmaciones, atención humana
y lotes mixtos conservan su ventana. Si una corrección llega después de que
la navegación haya arrancado, se procesa en el siguiente turno; esta ruta
solo abre pantallas y conserva el carrito. El menú sigue siendo reutilizable.

La reducción programada es de 5.5 segundos en esas tres opciones. El barrido
de 500 ms, carga del servidor y transporte pueden añadir tiempo. La mejora
real requiere medición posterior a un despliegue autorizado.

## Validación

Node 22.23.3 en Docker; PostgreSQL `test_botones_latencia_20261001`, red externa
bloqueada y Meta/modelo simulados. No se ejecutaron pruebas contra clientes.

- Mapo DB: 17/17, con navegación rápida y exclusiones.
- Continuidad: 13/13, con dos trabajadores, duplicados, reinicio e interrupción.
- Webhook de botones mixtos: recorrido firmado con dos servidores, edición,
  reinicio, confirmación vieja rechazada y un único pedido local de $245.
  Se corrigió una expectativa antigua del test: el resumen ya usaba ` · `
  en la base, mientras la aserción aún esperaba una coma.
- `git diff --check`: correcto.

Cambio preparado localmente; no publicado ni integrado en producción.
