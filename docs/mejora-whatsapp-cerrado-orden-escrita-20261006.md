# Mejora local de negocio cerrado y orden escrita

El recepcionista reconoce órdenes escritas por renglones, incluso largas o con nombres fuera del catálogo, explica que aún deben confirmarse en el formulario y conserva el mensaje original. Una pregunta aprobada adjunta a la orden se contesta. Con el negocio cerrado, una orden o una nueva solicitud recibe respuesta aunque se haya enviado un aviso de cierre recientemente. El seguimiento de pedidos registrados continúa disponible durante el cierre.

## Alcance y base

Implementación local del 6 de octubre por encargo de Mario. Rama `codex/mejora-whatsapp-20261006`, worktree independiente de Claude. Se integra el trabajo existente de `feat/ia-recepcionista` sobre `48e4150`, conservando las correcciones de navegación del 4 de octubre. El merge local de esa base es `d4e293c`; la corrección de esta entrega se revisa por separado sobre él.

No se activaron banderas, hicieron push o deploy ni modificaron datos de producción. Las correcciones propias están en `recepcionista.js`, `frasesRecepcion.js`, `horarioDelAgente.js`, el módulo puro `listaDeOrdenEscrita.js`, el guardián del modo y sus pruebas. No se editaron los componentes protegidos enumerados en CLAUDE.md.

## Comportamiento

| Situación | Respuesta local nueva |
| --- | --- |
| Abierto y «Voy a pedir» seguido de platillos, cantidades y entrega | Acuse específico con formulario. Explica que el pedido todavía no está registrado. |
| Lista larga, con viñetas, cantidades escritas o nombres fuera del catálogo | Reconoce la estructura y ofrece el formulario sin afirmar disponibilidad ni interpretar los productos automáticamente. |
| Orden acompañada de una pregunta aprobada sobre pago u otro tema | La respuesta informativa se conserva junto al acuse, tanto abierto como cerrado. |
| Información aprobada que excede el espacio del formulario | Sale completa en texto con una vía operable a atención humana, sin prometer un formulario ausente. |
| El cliente vuelve a escribir su orden después de recibir el formulario | Conserva el rescate humano existente, con pausa durable y aviso al panel. |
| Cerrado y orden escrita después de un aviso reciente | Responde que el mensaje no confirma ni modifica un pedido, informa la próxima apertura y ofrece la tienda únicamente si está publicada y admite programación. |
| Cerrado y nueva solicitud sin respuesta aprobada | Repite el camino de atención y el aviso de cierre; no la descarta por la ventana de una hora. |
| Cerrado y primera duda con respuesta aprobada | Informa el cierre y después muestra la información aprobada. Las dudas siguientes conservan su respuesta sin repetir todo el aviso. |
| Cerrado y consulta sobre pedido activo | Consulta el estado persistido y responde por folio. Si requiere revisión, usa la ruta humana; no inventa entrega ni pago. |
| Saludo o agradecimiento repetido después del aviso | Conserva la supresión de respuestas redundantes. |
| Próxima apertura con horario inválido o cierre anticipado que impide abrir | Busca una jornada válida utilizando el mismo calendario que determina si se puede vender. |

La orden escrita se reconoce y conserva, pero no se transforma automáticamente en renglones del carrito: el cliente selecciona y confirma en el formulario. Esta entrega conserva la decisión existente de pedidos por formulario. Las listas con cantidades se reconocen por su estructura aunque los nombres no coincidan con el catálogo; disponibilidad, precios y opciones se validan al seleccionar. No certifica entender cualquier formato de texto libre.

La segunda corrección parte de `b0bba38`. Añade la clasificación estructural y la conservación de información junto a una orden. La señal estructural excluye introducciones de consulta, historial o negación y renglones de datos de pago, dirección, tiempo o preguntas genéricas. No extrae un pedido comercial del texto.

## Validación

Las pruebas principales corren en Node 22.23.3, con proveedor y transporte simulados. Las pruebas SQL utilizan copias locales dedicadas `test_botones_codex_*` de PostgreSQL 18.4 y un bloqueo de destinos externos. Se aplicaron 113 y 114 únicamente a esas copias. No hubo mensajes, pagos ni impresiones reales.

| Comprobación | Resultado |
| --- | --- |
| Nueva suite de cerrado y orden escrita | 37 casos correctos. La primera corrida contra el recepcionista anterior reprodujo nueve fallos de trece casos iniciales; la segunda ronda reprodujo cuatro huecos adicionales antes de corregirlos. |
| Router del recepcionista | 189 casos correctos. |
| Recepción por adaptador real y PostgreSQL | 40 casos correctos, incluidos mensaje original, rescate al insistir, orden después del cierre, seguimiento durante el cierre, orden larga y respuesta informativa completa. |
| Mensajes fijos y selector con PostgreSQL | 20 casos correctos. |
| Entrega de respuestas en base aislada | 25 casos correctos. |
| Respuestas con carrito en PostgreSQL | 14 casos correctos. |
| Selector puro y activación | 15 y 11 casos correctos, respectivamente. |
| Fuera de horario y transiciones de formularios | 12 y 5 verificaciones correctas, respectivamente. |
| Continuidad determinista y pedido canónico | Correctos; pedido canónico 19 casos. |
| Comparación sin bandera contra `48e4150` | 11 grupos puros correctos en el host Node 24 y comparación de dos conversaciones en Node 22 con PostgreSQL. |

El gate local `predeploy-check-incidentes.mjs` pasó con las dos comprobaciones adicionales: orden escrita y seguimiento con local cerrado; apertura futura descartada por cierre especial. El guardián del modo pasó 12 grupos. Su ejecución es una prueba local, no un despliegue.

En las primeras corridas se corrigieron dos errores de fixtures nuevos: importación faltante y folio sintético demasiado largo. La prueba de entrega falló al compartir una base con otras suites y pasó sus 25 casos al ejecutarse en una copia dedicada. Las expectativas antiguas de silencio ante nuevas solicitudes y de texto genérico se actualizaron al comportamiento solicitado. La primera ejecución del gate omitió montar las migraciones; se corrigió el montaje y pasó.

En la segunda ronda se corrigió la fixture de nombres ajenos al catálogo: el jugo usado al principio sí existía en la carta de prueba. Los casos ahora exigen explícitamente cero coincidencias de catálogo. La ampliación de listas detectó dos falsos positivos, «transferencias» y «una cosa más»; se corrigieron sin cambiar las expectativas de las pruebas del selector.

## Revisión y trabajo pendiente

Para revisar solamente esta corrección, usar `git diff d4e293c..HEAD`. Para revisar el candidato completo, usar `git diff 48e4150..HEAD`. La integración del recepcionista es parte del candidato y no debe confundirse con un cambio productivo ya activo.

Antes de una activación futura siguen pendientes la aprobación de respuestas comerciales, los atajos del webhook anteriores al recepcionista, las pruebas con teléfono y Meta y la comprobación del alcance por negocio. Las pausas, el seguimiento humano y las métricas del resto del [plan](plan-mejora-whatsapp-20261006.md) continúan pendientes. Las pruebas locales no establecen todavía un porcentaje de cobertura real.

## Integración autorizada para producción — 7 de octubre

El dueño autorizó desplegar esta mejora. El candidato se integró sobre `7fd4883`, que ya incluía el cambio de Claude para ordenar por persona. La integración no modifica sus archivos de panel, servidor, servicios de personas, renderizadores ni migraciones, y tampoco cambia las definiciones de los formularios publicados.

Sobre el candidato integrado pasaron el gate previo al despliegue, 37 casos de las prioridades, 189 del router, 15 del selector y 11 de activación. En una copia local con migraciones 113–115 pasaron 40 casos de recepción, 20 de mensajes fijos y 14 de carrito. La comparación con el modo apagado contra `7fd4883` pasó 11 grupos puros y dos conversaciones SQL de 13 y 7 turnos. La suite independiente de personas exige base y navegador: no se cuenta como prueba ejecutada, y sus archivos permanecen idénticos a la versión productiva.

Al preparar el despliegue, el modo nuevo estaba ausente en Acuña y Obispado. Publicar el código no activa sus respuestas: la activación requiere definir sucursal y alcance y cumplir las precondiciones del script. El estado de Railway y cualquier activación se registrarán por separado después de comprobarlos.
