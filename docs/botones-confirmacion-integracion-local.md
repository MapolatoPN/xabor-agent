# Botones de confirmación: integración local — 28 sep 2026

Nota posterior: la extensión local de ofertas, productos, opciones y grupos
múltiples se documenta en [botones-opciones-multiples-local.md](botones-opciones-multiples-local.md).
Este archivo conserva la evidencia histórica de la fase de confirmación.

Rama: `prueba/botones-confirmacion-local`, continuación de `8e64f10`.
Autorización: integrar localmente el receptor protegido y preparar la migración,
con Meta simulado. **Sin autorización de despliegue ni activación productiva.**

## Alcance implementado

Fase 0 (recepción segura) y fase 1: **Confirmar / Cambiar algo**. Es código del
Mesero, no el prototipo de `experiments/`. No incluye todavía botones de
promociones, selección de producto, opciones, multiselección ni Flows.

- Se conserva el webhook firmado y la resolución de negocio existentes.
  `interactive.button_reply` se procesa como evento, nunca como su título.
  Las listas y botones de plantilla no soportados quedan sin efecto.
- El resumen canónico, su huella completa y el total mostrado se vinculan a
  dos tokens aleatorios de 128 bits. El texto y los tokens salen juntos en un
  solo mensaje interactivo del outbox. No se divide ni trunca un resumen largo:
  si excede 1024 caracteres continúa como texto.
- La migración aditiva **103** crea preguntas y botones. Ambos botones comparten
  una pregunta; la reserva durable precede a cualquier efecto. La revisión de
  conversación impide reservas concurrentes. Los efectos externos conservan
  la identidad de pedido/ciclo y el libro de operaciones existentes.
- Confirmar pasa por el ejecutor actual y vuelve a validar carta, opciones,
  horario, pago y total. Cualquier cambio de total, incluso una reducción,
  exige otro resumen. No se consulta al modelo para resolver un toque.
- Cambiar algo conserva el carrito, retira la confirmación y pide escribir el
  cambio. Un toque viejo avisa una vez; repetir una pregunta consumida no
  ejecuta ni responde otra vez.
- En lotes mixtos se descartan durablemente los toques y se atiende solo el
  texto/medio por su ruta habitual. Incluye atajos que no pasan por el agente.
  Un texto posterior a la pregunta y anterior al toque también la invalida,
  aunque haya sido atendido por otro atajo. No se deshacen efectos de un toque
  ya aplicado en un lote anterior.
- Sin acuse, el evento queda pendiente hasta dos minutos desde su recepción.
  El worker puede recuperarlo sin volver a ejecutar efectos. Al vencer, no se
  confirma: se presenta la información actual.
- Consumo final, estado, respuesta y traza se comprometen en una transacción.
  Si pudo ocurrir un efecto y falla ese commit, la reserva permanece bloqueada;
  se busca el folio por ciclo y se solicita revisión humana, sin reintento ciego.
  No se promete «exactamente una vez» distribuido entre PostgreSQL y Meta.
- Bot apagado, pausa, takeover humano, revisión activa, integración apagada y
  alcance del canario/prueba se comprueban antes de actuar y al enviar botones.
  El envío verifica las 24 horas usando timestamps entrantes y el reloj de la
  base; sin timestamp verificable no supone una ventana abierta.

## Interruptores y migración

Por omisión NO se envían botones. Se requieren ambas llaves:

```text
Proceso: WHATSAPP_INTERACTIVOS=true
Negocio: whatsapp_interactivos_v1=true
```

Estas llaves NO sustituyen `MESERO_AGENTE_MODE`, `mesero_agente_v1`, el canario,
`bot_whatsapp_solo_prueba`, el interruptor maestro o las barreras humanas.
No se agregó ni cambió ninguna configuración productiva.

`scripts/predeploy-103-agente-botones.mjs` está registrado en el runner.
Aplicación repetida comprobada en PostgreSQL local. **101 y 102 pertenecen al
panel y no se reutilizan.** Al integrar en una base más reciente, conservar
sus entradas del runner y comprobar que 103 continúe libre.

Rollback funcional: apagar las llaves de botones, manteniendo el receptor,
las tablas y las reservas. Los mensajes ya enviados siguen existiendo en el
teléfono: no retirar la recepción ni borrar asociaciones. La reversión NO
consiste en desplegar un binario viejo que vuelva a interpretar títulos.

## Pruebas y entorno

PostgreSQL 18.4 local (`pg-candidato`, puerto 55473), bases desechables con
prefijo `test_botones_`. Dependencias instaladas desde el lockfile. Las pruebas
corrieron con `NODE_OPTIONS=--import=./test/red-solo-local.mjs`: conexiones y
fetch externos bloqueados. Los servidores de Meta y Anthropic son locales.
Los negocios, teléfonos, pedidos y credenciales usados son sintéticos.

| Prueba | Resultado |
|---|---|
| `predeploy-check-incidentes` con contrato real de botones incluido | OK |
| `npm run test:incident` | OK; pedido canónico puro 19/19 |
| `npm run mesero:tools` | 66/66 |
| `npm run mesero:replay` | 26/26 |
| Ciclos, emisión, ciclo terminal, coherencia del prompt | OK; terminal 12/12, prompt 10/10 |
| Outbox contra PostgreSQL | 25/25 |
| Continuidad WhatsApp contra PostgreSQL | 13/13 |
| Canario con horario abierto y cerrado | Ambos OK |
| `fase-botones-webhook.mjs` | E2E local OK; dos servidores y reinicio de ambos |
| `fase-botones-persistencia.mjs` | 27/27 |
| `git diff --check` y sintaxis de módulos modificados | OK |

El E2E obtiene el payload real que recibiría Meta, prueba título manipulado,
contexto ajeno, tipos no soportados, bot apagado, Cambiar algo, pregunta vieja,
texto junto a toque y reentregas. Tras reiniciar ambos servidores, confirma
un único pedido local de $45, sin llamada al modelo. Hubo siete respuestas
únicas. Esto NO es una prueba visual en un teléfono con Meta real.

La suite de persistencia agrega ventanas de envío, canario y barreras humanas,
retención recuperable, dos conexiones compitiendo, acuse tardío y rollback
atómico. Inyecta un fallo después de registrar el pedido local: se conserva
el folio y un segundo intento no lo duplica. Esa inyección es una excepción
controlada; no se presenta como una caída física del proceso en ese punto.

## Fallos existentes: no ocultarlos

`test/fase-pedido-canonico-db.mjs`: **29/34**, tanto con esta integración como
en el checkout limpio de **8e64f10**, en bases clonadas separadas. Fallan los
mismos casos: **18, 20, 23, 23b y 25** (continuidad de agregar/cambiar productos,
reintento y pregunta pendiente). No son regresiones introducidas por botones,
pero no quedan corregidos ni dispensados por esta entrega. La equivalencia
de resultados no demuestra que sean simples errores del test.

El seed general no se pudo repetir sobre el clon porque sus usuarios ya
existían. Para el canario se reconstruyó el archivo de IDs ignorado por Git
desde las filas sintéticas verificadas; después ambos horarios pasaron.

## Reproducir sin producción

Usar una base **local desechable** con el esquema previo completo y 103.
Las suites nuevas rechazan hosts no locales y nombres sin `test_botones_`.
Fijar una clave de cifrado sintética válida y el bloqueo de red antes de correr:

```powershell
$env:NODE_ENV = 'test'
$env:NODE_OPTIONS = '--import=./test/red-solo-local.mjs'
# DATABASE_URL: únicamente la base local desechable preparada.
# INTEGRATIONS_ENCRYPTION_KEY: clave sintética de 32 bytes en Base64.
node scripts/predeploy-103-agente-botones.mjs
node test/fase-botones-webhook.mjs
node test/fase-botones-persistencia.mjs
npm run test:incident
```

El E2E usa 55980/55981. Ejecutarlo en un clon limpio ANTES de la suite de
persistencia: esta conserva escenarios de outbox pendiente/incierto como
evidencia, que no deben entrar al despachador de otra prueba.

## Antes de verlos en WhatsApp real

1. Revisar el diff de esta integración. La rama parte del código de `7a933eb`:
   NO incluye automáticamente la corrección de licuado `efac6de` ni los cambios
   posteriores de producción/panel. No desplegar esta rama como reemplazo.
2. Integrar los commits revisados en una candidata vigente, conservar los
   cambios ajenos y repetir el gate y la batería. Resolver o clasificar con
   evidencia los cinco fallos de la revisión general.
3. Autorizar separadamente despliegue y canario de botones. Limitarlo al
   teléfono de prueba en sus dos formas, con barrera real de atención; no
   abrirlo al tráfico general. Confirmar build y estado de Meta.
4. Hacer una prueba visual controlada sin cobro ni impresión involuntarios.
   Después decidir promociones y opciones como fases independientes.

No hubo push, despliegue, reset de conversación, mensaje real, pago real,
impresión ni escritura de producción en esta integración.
