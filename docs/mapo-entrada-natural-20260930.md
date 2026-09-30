# Corrección de entrada a Mapo — 30 sep 2026

## Incidente y causa

Con el build `9b3408a`, «Buenos díasss» omitió la bienvenida de Mapo y las
cuatro opciones. «Me gustaría realizar una orden» y «Ya sé que ordenar»
tampoco abrieron el formulario. Las expresiones de entrada exigían frases
casi literales y enviaron estos mensajes al modelo conversacional.
No se generó un formulario: no fue un rechazo de entrega de Meta.

La nueva prueba del saludo falló con el código anterior antes de corregirlo.

## Corrección y límites

- Un clasificador compartido reconoce saludos expresivos, mayúsculas,
  acentos, puntuación, cortesía y varias formas de solicitar un pedido.
- Saludo solo: presentación de Mapo y las cuatro opciones existentes.
- Intención general de ordenar: formulario, sin otra pregunta del modelo.
- Saludo y petición juntos, incluso en un lote: prevalece la petición.
- No descarta detalles: un pedido con productos, condiciones o fecha,
  una negación, una cancelación o una consulta conserva su ruta existente.
- No convierte un «sí» sin contexto en permiso para abrir ni confirmar.
- No reinicia carritos con productos, pedidos confirmados, catering,
  programación pendiente, escalados ni confirmaciones inciertas.
- Es clasificación acotada para navegación; no sustituye el intérprete
  general ni garantiza reconocer cualquier frase del lenguaje natural.

El nuevo módulo no consulta servicios externos ni autoriza cantidades,
productos, precios o efectos. Solo dos consumidores de entrada lo usan.
No se modificaron componentes protegidos, migraciones, flags, promociones,
pausas de clientes ni credenciales. El resto de los saludos del agente
conserva su implementación anterior.

## Evidencia local

Node 22.23.3 en Docker, PostgreSQL local y red externa bloqueada.

- `scripts/check-inicio-mapo.mjs`: 9 saludos, 16 solicitudes, 20 exclusiones,
  estados protegidos y banderas. Incluido en el gate obligatorio.
- `npm run test:incident`: verde.
- `npm run mesero:tools`: 66/66.
- `npm run mesero:replay`: 26/26; cero invariantes críticas rotas.
- `test/fase-inicio-mapo-db.mjs`: 12/12; frases reales, cero llamadas al
  modelo, formulario de categorías, reintentos sin duplicar y horario cerrado.
- `test/fase-flows-db.mjs`: 23/23.
- `test/fase-inicio-mapo-webhook.mjs`: verde; HTTP firmado con dos procesos,
  incidente real, lote mixto, botón Ordenar, reentrega duplicada, factura y
  silencio ante las nuevas frases durante atención humana o master apagado.
- `git diff --check` y comprobaciones de sintaxis: verdes.

Una repetición del E2E excedió los 15 segundos del arranque local antes de
ejecutar los casos. No se modificó el timeout ni se omitieron aserciones;
la repetición completa por separado pasó, incluidas las comprobaciones de
silencio con pausa humana y master apagado.

## Publicación

Corrección local; sin push, despliegue ni mensajes a clientes en este trabajo.
Requiere revisar el diff, autorizar publicación y verificar el commit activo
antes de pedir una nueva prueba real. Los tests aislados no prueban entrega
ni presentación en un teléfono conectado a Meta.
