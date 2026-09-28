# Botones y opciones múltiples del Mesero — 28 sep 2026

Rama: `feat/botones-opciones-multiples-local`, sobre `85d3692`.
Alcance solicitado: desarrollar todos los tipos de botones propuestos, incluidas
las opciones múltiples de chilaquiles mixtos. Implementación y pruebas locales;
sin publicación ni activación productiva.

## Qué queda implementado

- Confirmar / Cambiar algo, conservando la reserva durable de la fase anterior.
- Aceptar o rechazar una oferta de producto, promoción o método de pago.
- Elegir entre productos concretos, conservando la cantidad de la solicitud.
- Elegir una opción simple: por ejemplo, proteína.
- Elegir varias opciones del mismo grupo: salsas y guarniciones. Cada elección
  suma a las anteriores, no las sustituye. Se vuelve a presentar la selección
  vigente y se termina con **Listo con estas**.
- Elegir modalidad de entrega y forma de pago habilitadas por el negocio.
- Recibir tanto `button_reply` como `list_reply` por el webhook existente.

La carta determina las opciones y sus mínimos/máximos; no se programaron nombres
de platillos, precios ni combinaciones de Obispado en el motor. La prueba usa un
negocio sintético con Salsa (1–2), Proteína (1) y Guarnición (2).

Se usan botones para hasta tres títulos cortos; los demás casos compatibles usan
una lista. No es una lista con casillas simultáneas: cada toque agrega una opción
y genera la siguiente pregunta. Más de diez acciones, nombres que colisionan al
abreviarse o cuerpos de más de 1024 caracteres continúan por texto, sin truncar
el pedido ni resolver por índices. Los formularios Flows y el catálogo comercial
de Meta no forman parte de esta entrega. Direcciones, notas y otros datos libres
continúan por texto.

## Autoridad, continuidad y riesgo

Cada token aleatorio queda asociado en PostgreSQL al negocio, cliente, ciclo,
pregunta, huella completa del carrito y datos exactos de la acción. Para opciones
incluye renglón, producto, grupo, selección previa, cardinalidad y precios; para
promociones incluye sus condiciones verificadas. No se interpreta el título que
envía WhatsApp como autorización.

Antes del efecto se coteja la asociación guardada contra el estado y catálogo
actuales. Cambiar un precio, disponibilidad, selección o condición promocional
invalida el toque: no modifica el carrito y presenta información actual con un
aviso explícito. La comparación de JSONB es estructural completa, independiente
del orden de claves; no usa prefijos de una cadena ni índices de una lista nueva.

Las acciones validadas pasan por el mismo ejecutor y reconciliador de pedidos.
La autorización adicional es una capacidad efímera vinculada al objeto de estado,
su ciclo y argumentos exactos; no puede fabricarse copiando JSON del modelo.
El cálculo de precios, validación de opciones y efectos siguen en Xabor.

El grupo abierto se persiste como `eleccionInteractiva`, por renglón y ciclo.
Cumplir el mínimo o máximo no lo cierra automáticamente; mientras siga abierto
no se confirma el pedido. Reiniciar ambos procesos conserva la primera salsa.

El texto dentro del grupo también funciona:

- `agrega verde` suma la opción válida conservando la anterior.
- `cambia a chipotle` sustituye explícitamente y mantiene la elección abierta.
- `solo verde` sustituye y cierra únicamente después de verificar el resultado
  real y satisfacer los mínimos.
- `listo` cierra si se cumplen los límites y las opciones siguen disponibles.
- Ambigüedad, opción desconocida o exceso conservan lo guardado y preguntan.
- Otro asunto no cierra el grupo por el mero hecho de escribir.

Se conservan las barreras de bot apagado, atención humana, integración, alcance,
canario, acuse y ventana de envío. La reserva precede al efecto; consumo, estado y
respuesta se comprometen juntos. Si hay una caída entre efecto y commit no se
repite a ciegas: permanece la reserva y el circuito de revisión de la fase 1.
No se promete entrega distribuida exactamente una vez entre PostgreSQL y Meta.

Una pregunta consumida no se ejecuta ni responde otra vez. Una pregunta caducada
no consumida avisa una sola vez. Texto y toque en el mismo lote descartan el
toque; no se deshace automáticamente un toque aplicado en un lote anterior.

Esta extensión modifica ejecutor, vista y reconciliación: es una superficie
sensible. Los permisos nuevos están limitados a capacidades verificadas y la
función permanece apagada por omisión. No se modificó `whatsapp-meta.js` en esta
extensión: se reutiliza su integración anterior y el parser compartido.

## Migración e interruptores

La migración local **104** requiere la **103**. Añade `datos` JSONB a cada botón,
habilita los tipos de acción nuevos, permite varios botones de la misma acción
por pregunta y un total todavía incompleto. Su runner está registrado después
del 103. No activa negocios ni altera catálogos. Aplicación repetida verificada
en PostgreSQL local.

Además de las barreras existentes, se necesitan:

```text
Proceso: WHATSAPP_INTERACTIVOS=true
Negocio: whatsapp_interactivos_v1=true
Negocio: whatsapp_interactivos_elecciones_v1=true
```

La tercera llave es nueva y queda apagada por omisión. Apagarla conserva los
botones de confirmación de la fase anterior; las nuevas elecciones pendientes
pueden seguir por texto, incluido `listo`. Apagar la llave general retira todos
los botones, no las asociaciones ni las barreras.

No hacer rollback desplegando un binario que desconozca los grupos abiertos:
mantener receptor, estado y tablas. Revalidar numeración al integrar; 101 y 102
pertenecen a cambios posteriores del panel y no se deben sustituir ni omitir.

## Evidencia local

PostgreSQL 18.4 en `pg-candidato`, puerto 55473. Bases sintéticas desechables,
Meta y Anthropic locales. `NODE_OPTIONS=--import=./test/red-solo-local.mjs`
bloqueó conexiones/fetch externos. Ningún cobro, mensaje o ticket real.

| Prueba | Resultado |
|---|---|
| `fase-botones-elecciones.mjs` | 14/14; autoridad, listas, multiselección y límites |
| `fase-botones-ofertas-db.mjs` | 6/6; ofertas, precio cambiado, texto ambiguo e interruptor |
| `fase-botones-mixtos-webhook.mjs` | E2E firmado con dos servidores, reinicio y reentregas |
| `fase-botones-webhook.mjs` | E2E de confirmación anterior conservado |
| `fase-botones-persistencia.mjs` | 27/27 |
| `npm run test:incident` | OK; gate, continuidad y canónico puro 19/19 |
| `npm run mesero:tools` / `npm run mesero:replay` | 66/66 y 26/26 |
| Ciclos / emisión / ciclo terminal / coherencia del prompt | OK; terminal 12/12, prompt 10/10 |
| Canario abierto / cerrado | Ambos OK |
| Sintaxis y `git diff --check` | OK |

La prueba de mixtos conserva roja + verde tras reiniciar ambos servidores; luego
prueba sustitución explícita por chipotle y adición de roja. Cierra salsas, elige
pollo, frijoles y papas a la mexicana, cierra guarniciones, selecciona entrega y
pago y confirma **un único pedido local de $145**, sin llamadas al modelo para
resolver los toques. El precio y el negocio son exclusivamente datos de prueba.
Esto no demuestra aún la visualización en un teléfono conectado a Meta real.

El gate incluye la prueba pura nueva en un proceso separado: otros checks del
gate cambian variables globales durante sus imports asíncronos y no deben alterar
la bandera de la prueba de elecciones.

### Fallos generales que siguen abiertos

`fase-pedido-canonico-db.mjs`: **29/34**, fallan **18, 20, 23, 23b y 25**.
Son los mismos casos documentados en la fase anterior y reproducidos entonces
en su base limpia `8e64f10`: continuidad de agregar/cambiar productos, reintentos
y pendiente. Se volvió a ejecutar en una base separada con esta extensión y el
resultado es el mismo. No se corrigieron, silenciaron ni dispensaron aquí; pasar
el gate focalizado no certifica el bot completo ni habilita producción.

## Reproducción

Preparar un clon **local desechable** con el esquema previo y datos sintéticos;
nunca reutilizar una URL de producción. Las suites nuevas verifican host local y
prefijo `test_botones_`. Configurar `DATABASE_URL` local y una clave de cifrado
sintética de 32 bytes en Base64, sin imprimir credenciales.

```powershell
$env:NODE_ENV = 'test'
$env:NODE_OPTIONS = '--import=./test/red-solo-local.mjs'
node scripts/predeploy-103-agente-botones.mjs
node scripts/predeploy-104-agente-elecciones.mjs
node test/fase-botones-elecciones.mjs
node test/fase-botones-mixtos-webhook.mjs
node test/fase-botones-webhook.mjs
node test/fase-botones-ofertas-db.mjs
node test/fase-botones-persistencia.mjs
npm run test:incident
```

E2E nuevo: puertos 55982/55983; anterior: 55980/55981. Correrlos en un clon limpio
antes de persistencia: esta última deja outbox pendiente/incierto como evidencia
que no debe consumir el despachador de otra prueba. Canario y canónico DB se
ejecutaron en clones independientes.

## Entrega e integración pendiente

El diff queda listo para revisión local. La rama hereda código de `7a933eb`; no
incluye automáticamente la corrección de licuado `efac6de` ni los commits nuevos
de producción/panel. **No desplegar esta rama como reemplazo de producción.**

Para ver los botones en el teléfono falta revisar e integrar en la candidata
vigente, conservar los cambios ajenos y sus migraciones, repetir pruebas, resolver
o clasificar con evidencia los fallos generales y autorizar despliegue/canario
limitado. También validar los grupos reales de la carta y el build activo.

No hubo push, despliegue, migración productiva, cambio de configuración productiva,
reinicio de conversación ni prueba con efectos externos reales.
