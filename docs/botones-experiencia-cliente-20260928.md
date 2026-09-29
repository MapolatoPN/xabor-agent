# Botones: corrección de experiencia del cliente — 28 septiembre 2026

## Estado y alcance

Corrección local en `fix/botones-experiencia-20260929`, basada en `f3b2e8a`
(documentación encima de `e7ad0e4`). No es una activación ni una certificación
de todos los flujos del Mesero. Requiere revisión del diff antes de integrar.

**Nuevo criterio del dueño: límite de seis toques. No cumplido por el flujo
secuencial de este commit.** Ver la sección siguiente antes de considerar
terminada la experiencia o solicitar otra prueba al cliente.

No se hizo push, despliegue, reinicio de conversación ni cambio en producción.
No se modificaron `whatsapp-meta.js`, `brain.js`, `orderManager.js`, el panel,
las rutas protegidas, catálogo comercial ni banderas de negocios.

## Requisito añadido: esfuerzo para pedir varios platillos

Mario pidió que un mensaje no termine en más de seis toques, especialmente
cuando la misma persona agrega tres platillos. Falta precisar si el máximo es
por pedido o por platillo. No sustituir «toques» por «mensajes» para declarar
cumplido el objetivo: abrir una lista, seleccionar y enviar también cuestan.

El recorrido actual de un mixto con dos opciones en cada uno de sus tres grupos
exige seis elecciones y tres `Continuar`: **nueve respuestas**, sin contar
abrir listas, elegir producto, entrega, pago ni confirmar. Tres configuraciones
independientes suman 27 respuestas de configuración. Las pruebas funcionales
verdes no validan este nuevo criterio de facilidad de uso.

Dirección de producto propuesta, todavía no implementada:

- Aceptar los tres platillos en un mensaje y conservar qué opciones pertenecen
  a cada uno; no convertir información ya escrita en preguntas de botones.
- Preguntar solo lo que falte, agrupado y referido al platillo correspondiente.
  Si una opción puede pertenecer a dos grupos, aclarar sin adivinar ni cobrar.
- Dar un único resumen del pedido completo y una confirmación final, no tres
  procesos de compra independientes.
- Permitir reutilizar una configuración entre platillos solo cuando el cliente
  lo indique, no por asumir que los tres se preparan igual.
- Evaluar captura agrupada para quienes prefieren elegir visualmente. Un
  formulario puede reducir mensajes y pantallas, pero no garantiza seis toques
  físicos para seleccionar desde cero muchas preferencias independientes.
- Mantener alternativas textuales; no obligar a instalar otra aplicación ni
  omitir datos obligatorios o aceptar extras para reducir el conteo.

La aceptación debe medir un caso de tres platillos, tanto completamente
escrito como parcialmente especificado y configurado visualmente. Registrar
por separado toques físicos, respuestas enviadas y tiempo. Cambios voluntarios
del cliente no deben provocar un reinicio del pedido. No se autoriza aquí
publicar Flows, tocar recepción protegida ni cambiar producción.

## Qué estaba mal y qué cambia

| Problema observado | Corrección |
| --- | --- |
| Párrafos que repetían todas las opciones y «sin cargo extra» | El cuerpo muestra producto, grupo, selección actual y siguiente decisión. Las alternativas y sus cargos van dentro de la lista. |
| «Roja / Roja» en la respuesta del cliente | Se omite la descripción cuando repite el título. Solo se usa para precio o nombre largo. No se modifica la interfaz nativa de WhatsApp ni su cita al responder. |
| Verde y Roja desde la misma lista: la segunda se perdía | Cada opción tiene consumo propio; otra opción de la misma elección abierta puede sumarse. El mismo valor nunca alterna ni se duplica. |
| Dos toques rápidos: solo se conservaba uno | Dos adiciones compatibles del mismo lote producen una única modificación con ambas opciones. |
| Pedir otra opción después del máximo | Se conserva la selección y se explica el límite. Aparecen `Continuar` y `Cambiar selección`. |
| No había edición visible de la selección | `Cambiar selección` no borra nada. La primera nueva elección reemplaza el conjunto anterior; `Conservar selección` permite volver sin cambiarlo. También funciona escribiendo la nueva opción. |
| «Quiero ordenar unos chilaquiles» o «Chilaquiles» repetían la pregunta inicial | Xabor abre una aclaración de producto con candidatos reales del catálogo; no agrega un producto adivinado. |
| «Quiero agregar otro» repetía el resumen | Abre una pregunta para el producto adicional y conserva el carrito. También existe el botón `Agregar otro` junto a `Confirmar` y `Cambiar algo`. |
| Dos decisiones incompatibles juntas | Por ejemplo, `Confirmar` y `Cambiar algo`: no se ejecuta ninguna; se pide una elección nueva. |
| Bandera apagada entre preparar y despachar | Se entrega texto completo con alternativas y cargos, no una pregunta breve cuyo menú haya desaparecido. |

## Ejemplo de presentación

Una selección de dos salsas muestra:

```text
Chilaquiles Mixtos · Salsa
Seleccionado: Verde y Roja.
Selección completa. Puedes continuar o cambiarla.

[Continuar] [Cambiar selección]
```

Mientras solo hay una:

```text
Chilaquiles Mixtos · Salsa
Seleccionado: Verde.
Puedes agregar una más o continuar.

[Ver Salsa]
```

El título se envía en negritas. Las opciones sin recargo no duplican el nombre
en su descripción. Las de pago muestran `+$30`, por ejemplo, en la lista.
En nombres largos el importe se coloca primero, para no recortarlo al abreviar.
Las reglas, límites y precios siguen viniendo del catálogo, no están fijados
a estos ejemplos ni se decidió que todos los chilaquiles deban ser mixtos.

## Contrato de seguridad

- El modelo no recibe autoridad para cantidades, precios ni elecciones.
  Todas las modificaciones pasan por el reconciliador existente.
- Una lista anterior solo admite **adiciones** mientras corresponda a la misma
  elección abierta, ciclo, renglón, producto, grupo, catálogo y precios. No
  autoriza reemplazar, cerrar ni confirmar desde una foto vieja del pedido.
- Una edición, cierre, texto posterior, cambio de precio o cambio de identidad
  invalida la lista anterior. La nueva selección tiene identidad propia.
- Reserva, revisión de estado y consumo continúan transaccionales. Los tokens
  aplicados quedan persistidos; duplicados no repiten efectos.
- Bot apagado, pausa humana, canario, contexto de salida y límites de Meta se
  comprueban por las barreras existentes. Un botón no reactiva una conversación.
- Texto y botón en el mismo lote conservan la regla de atender solo el texto.
- Sin soporte interactivo se conserva una respuesta textual utilizable. El
  historial registra el texto realmente enviado; el acuse conserva su diálogo.

La excepción a «una respuesta por pregunta» es deliberada y acotada: una lista
multiselección permite consumir opciones diferentes de la misma elección abierta.
Confirmación, pago, entrega y ofertas no adquieren esa excepción.

## Migración e integración

`105_agente_edicion_interactiva.sql` amplía únicamente el CHECK de acciones
permitidas: `agregar_otro`, `editar_grupo`, `conservar_grupo`,
`reemplazar_grupo`. No cambia datos de negocio, precios, pedidos ni banderas.

El runner repite migraciones: la 104 detecta el esquema ampliado y no reinstala
su CHECK antiguo. La prueba ejecuta 104/105 dos veces con asociaciones nuevas
ya guardadas y comprueba que todas las filas permanecen iguales.

Antes de un despliegue autorizado: verificar que 105 siga libre en la rama
vigente y revisar diferencias con producción. Aplicar la migración antes de
enviar acciones nuevas. No mezclar versiones antiguas y nuevas atendiendo la
misma conversación: el estado incorpora campos de elección que un binario
anterior con esquema estricto puede rechazar. Una reversión necesita revisar
las elecciones persistidas; no volver automáticamente al CHECK de la 104.

## Verificación local

Todos los comandos de prueba se ejecutaron con
`NODE_OPTIONS=--import=./test/red-solo-local.mjs`.
Las bases son locales desechables, creadas con **solo esquema** y datos
sintéticos. Meta y Anthropic se sustituyeron por servidores locales. No hubo
mensajes, pagos ni impresiones externos. Los pedidos citados abajo son ficticios.

| Comprobación | Resultado |
| --- | --- |
| `npm run test:incident` (incluye `predeploy-check-incidentes`) | OK; contrato canónico 19/19 |
| `npm run mesero:tools` | 66/66 |
| `npm run mesero:replay` | 26/26; cero invariantes críticas rotas |
| `scripts/check-experiencia-botones.mjs`, incluido en el gate de la imagen | 11/11 |
| Contrato de elecciones interactivas | 14/14 |
| `test/fase-botones-persistencia.mjs` | 27/27 |
| `test/fase-botones-ofertas-db.mjs` | 6/6 |
| `test/fase-botones-experiencia-db.mjs` | 10/10 |
| `test/fase-botones-webhook.mjs` | OK; dos procesos, reinicio, un pedido ficticio de $45 |
| `test/fase-botones-mixtos-webhook.mjs` | OK; dos procesos, reinicio, un pedido ficticio de $245 |
| `git diff --check` | OK |

La suite de experiencia en Postgres incluye dos salsas, dos proteínas entre
siete opciones y dos guarniciones, título largo, cargo visible y total exacto;
edición por botón seguida de texto; `Continuar` escrito; confirmación y cambio
simultáneos; apagado y pausa humana; fallback de envío; migraciones repetidas.

El E2E de mixtos empieza **sin carrito precargado**: saludo y pedido natural,
elección de producto, dos salsas desde la lista original, repetición, reinicio,
exceso de opciones, edición, texto, dos guarniciones juntas, entrega, pago,
agregar otro producto, rechazo de confirmación vieja y confirmación actual.
Comprueba un único pedido de $245 y ausencia de llamadas al modelo en ese flujo.

Durante el desarrollo, el primer E2E detectó un acceso incorrecto a una adición
inexistente al tocar una confirmación vieja; se corrigió antes de repetirlo.
La prueba antigua de cargos también se actualizó para comprobar el importe en
la lista y en el fallback, no exigir que vuelva al párrafo saturado.

## Qué falta para verlo en el teléfono

Revisión del diff, autorización de integración/despliegue y comprobación del
commit efectivamente publicado. Después, validación visual en WhatsApp dentro
del canario restringido, sin ampliar destinatarios. La evidencia local verifica
datos y payloads; no se presenta como una prueba nueva contra Meta real.

No se necesita descargar un skill para estas correcciones. Tampoco se instaló
un plugin ni se rehízo el sistema en otra plataforma. No se incorporaron Flows;
la interacción sigue usando botones, listas y texto de WhatsApp.

## Actualización: pedido múltiple y autorización de despliegue

El dueño autorizó implementar el recorrido recomendado y desplegarlo. La
publicación incluye los cambios de presentación anteriores y estos ajustes:

- El intérprete recibe la instrucción de procesar todos los platillos claros y
  sus preferencias antes de preguntar. No se incrementan sus presupuestos.
- Una lista de salsa abierta ya no intercepta y descarta un mensaje compuesto
  como «roja y verde con pollo, frijoles y papas, para recoger, en efectivo».
  Las propuestas siguen pasando por las herramientas y el reconciliador.
- Una elección abierta puede cerrarse después de verificar sus mutaciones si
  el texto completa el máximo o también guarda otras decisiones. La selección
  exclusivamente por botones conserva su cierre explícito y las listas seguras.
- Con varios platillos incompletos se agrupan los datos faltantes de hasta tres
  renglones en una pregunta breve. Una respuesta ambigua mantiene sus alternativas
  y una selección interactiva en curso conserva su contexto. No se asigna el
  foco del primer platillo a una pregunta conjunta.
- Entrega y pago ya guardados no se preguntan de nuevo; la última elección
  inequívoca puede producir el resumen sin llamar otra vez al modelo.
- La validación recorta evidencia por nombres completos de productos, referencias
  ordinales y referencias numéricas explícitas (`2:` al inicio de línea).
  «Todos con…» permite evidencia compartida, salvo negaciones o excepciones.
  No es un parser universal: abreviaturas y frases no separables continúan por
  las barreras existentes o requieren aclaración. No se inventan preferencias.

### Evidencia y alcance de la reducción de esfuerzo

`scripts/check-pedido-multiple.mjs`, incluido en el gate productivo, cubre seis
grupos de regresiones, incluidas propuestas erróneas de preferencias cruzadas.
`test/fase-pedido-multiple-db.mjs` usa el canal productivo con catálogo,
persistencia y outbox locales: tres platillos en un mensaje, una respuesta a la
proteína faltante y un resumen con botones; modificar el segundo conserva los
otros. No se registra ningún pedido sin confirmar. El modelo está simulado:
esto prueba ejecución/persistencia y no demuestra precisión universal del LLM.

En ese escenario son dos mensajes del cliente antes de tocar Confirmar, no
una secuencia por ingrediente. No se promete un máximo universal de seis
toques físicos: las listas nativas requieren abrir/elegir/enviar, y un pedido
con muchas preferencias sin especificar necesita obtenerlas. No hay Flows.

Verificación previa a publicación: gate e incidentes 19/19; herramientas 66/66;
replay 26/26; experiencia DB 10/10; E2E HTTP de mixtos con dos procesos y reinicio;
gate dentro de imagen Node 20 sin red. El gate de datos productivos dio 12/12,
en solo lectura. El canario sigue restringido al teléfono del dueño (52 y 521),
porcentaje cero y modo solo prueba; Acuña permanece apagado. No se modificó
configuración, carta, pagos ni impresión. La migración 105 sigue libre en la
base remota e7ad0e4 y se aplicará únicamente por el runner normal.

Revisión local del diff: no cambia ninguno de los componentes protegidos, Edge,
caja o panel. No es una auditoría independiente. El despliegue y su SHA deberán
registrarse al terminar, junto al resultado real de Railway.
