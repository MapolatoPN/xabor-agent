# Mejora local de negocio cerrado y orden escrita

El recepcionista reconoce una orden completa con prefacio y varios renglones, explica que aún debe confirmarse en el formulario y conserva el mensaje original. Con el negocio cerrado, una orden o una nueva solicitud recibe respuesta aunque se haya enviado un aviso de cierre recientemente. El seguimiento de pedidos registrados continúa disponible durante el cierre.

## Alcance y base

Implementación local del 6 de octubre por encargo de Mario. Rama `codex/mejora-whatsapp-20261006`, worktree independiente de Claude. Se integra el trabajo existente de `feat/ia-recepcionista` sobre `48e4150`, conservando las correcciones de navegación del 4 de octubre. El merge local de esa base es `d4e293c`; la corrección de esta entrega se revisa por separado sobre él.

No se activaron banderas, hicieron push o deploy ni modificaron datos de producción. Las correcciones propias están en `recepcionista.js`, `frasesRecepcion.js`, `horarioDelAgente.js`, el guardián del modo y sus pruebas. No se editaron los componentes protegidos enumerados en CLAUDE.md.

## Comportamiento

| Situación | Respuesta local nueva |
| --- | --- |
| Abierto y «Voy a pedir» seguido de platillos, cantidades y entrega | Acuse específico con formulario. Explica que el pedido todavía no está registrado. |
| El cliente vuelve a escribir su orden después de recibir el formulario | Conserva el rescate humano existente, con pausa durable y aviso al panel. |
| Cerrado y orden escrita después de un aviso reciente | Responde que el mensaje no confirma ni modifica un pedido, informa la próxima apertura y ofrece la tienda únicamente si está publicada y admite programación. |
| Cerrado y nueva solicitud sin respuesta aprobada | Repite el camino de atención y el aviso de cierre; no la descarta por la ventana de una hora. |
| Cerrado y primera duda con respuesta aprobada | Informa el cierre y después muestra la información aprobada. Las dudas siguientes conservan su respuesta sin repetir todo el aviso. |
| Cerrado y consulta sobre pedido activo | Consulta el estado persistido y responde por folio. Si requiere revisión, usa la ruta humana; no inventa entrega ni pago. |
| Saludo o agradecimiento repetido después del aviso | Conserva la supresión de respuestas redundantes. |
| Próxima apertura con horario inválido o cierre anticipado que impide abrir | Busca una jornada válida utilizando el mismo calendario que determina si se puede vender. |

La orden escrita se reconoce y conserva, pero no se transforma automáticamente en renglones del carrito: el cliente selecciona y confirma en el formulario. Esta entrega conserva la decisión existente de pedidos por formulario. Los nombres se reconocen mediante el catálogo del negocio; no certifica entender cualquier orden con errores ortográficos o productos no publicados.

## Validación

Las pruebas principales corren en Node 22.23.3, con proveedor y transporte simulados. Las pruebas SQL utilizan copias locales dedicadas `test_botones_codex_*` de PostgreSQL 18.4 y un bloqueo de destinos externos. Se aplicaron 113 y 114 únicamente a esas copias. No hubo mensajes, pagos ni impresiones reales.

| Comprobación | Resultado |
| --- | --- |
| Nueva suite de cerrado y orden escrita | 15 casos correctos. La primera corrida contra el recepcionista anterior reprodujo nueve fallos de trece casos iniciales. |
| Router del recepcionista | 189 casos correctos. |
| Recepción por adaptador real y PostgreSQL | 36 casos correctos, incluidos mensaje original, rescate al insistir, orden después del cierre y seguimiento durante el cierre. |
| Mensajes fijos y selector con PostgreSQL | 20 casos correctos. |
| Entrega de respuestas en base aislada | 25 casos correctos. |
| Respuestas con carrito en PostgreSQL | 14 casos correctos. |
| Selector puro y activación | 15 y 11 casos correctos, respectivamente. |
| Fuera de horario y transiciones de formularios | 12 y 5 verificaciones correctas, respectivamente. |
| Continuidad determinista y pedido canónico | Correctos; pedido canónico 19 casos. |
| Comparación sin bandera contra `48e4150` | 11 grupos puros correctos en el host Node 24 y comparación de dos conversaciones en Node 22 con PostgreSQL. |

El gate local `predeploy-check-incidentes.mjs` pasó con las dos comprobaciones adicionales: orden escrita y seguimiento con local cerrado; apertura futura descartada por cierre especial. El guardián del modo pasó 12 grupos. Su ejecución es una prueba local, no un despliegue.

En las primeras corridas se corrigieron dos errores de fixtures nuevos: importación faltante y folio sintético demasiado largo. La prueba de entrega falló al compartir una base con otras suites y pasó sus 25 casos al ejecutarse en una copia dedicada. Las expectativas antiguas de silencio ante nuevas solicitudes y de texto genérico se actualizaron al comportamiento solicitado. La primera ejecución del gate omitió montar las migraciones; se corrigió el montaje y pasó.

## Revisión y trabajo pendiente

Para revisar solamente esta corrección, usar `git diff d4e293c..HEAD`. Para revisar el candidato completo, usar `git diff 48e4150..HEAD`. La integración del recepcionista es parte del candidato y no debe confundirse con un cambio productivo ya activo.

Antes de una activación futura siguen pendientes la aprobación de respuestas comerciales, los atajos del webhook anteriores al recepcionista, las pruebas con teléfono y Meta y la comprobación del alcance por negocio. Las pausas, el seguimiento humano y las métricas del resto del [plan](plan-mejora-whatsapp-20261006.md) continúan pendientes. Las pruebas locales no establecen todavía un porcentaje de cobertura real.
