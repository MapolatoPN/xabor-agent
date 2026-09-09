# Asistente de WhatsApp — bitácora de fiabilidad (sesión nocturna 2026-09-09)

Rama: `asistente/fiabilidad-pedidos` (desde `mantenimiento/entorno-local-y-eol`,
que a su vez sale de `main` @ `290ceda`).

**Estado del despliegue durante esta sesión:** producción corre el despliegue
`b5a738ec`, que es exactamente el commit `290ceda` de `main`, desplegado el
2026-09-08 08:37 CDT. Producción == `main`. Nada de lo de esta bitácora está
desplegado.

## Alcance

Asistente de WhatsApp y toma de pedidos. **No se toca** `feature/compras-tickets`,
el PR #1 ni ningún archivo exclusivo de Compras — ese frente es de Codex.

## Incidente 1 — el cliente que confirma con cortesía pierde su pedido

**Evidencia de producción.** El evento
`preview_no_confirmable_turno_indeterminado` aparece **cinco veces** entre el
2026-09-02 y el 2026-09-08, en **dos negocios distintos**. Secuencia del caso
del 2026-09-08 (negocio `5de544d8…`, horas CDT):

| Hora | Evento |
|---|---|
| 08:20:56 | `promo_aplicada` descuento=189 |
| **08:22:47** | **`preview_no_confirmable_turno_indeterminado`** — el cliente confirmó |
| 08:23:17 | `preview_desde_borrador` total=378 — se le repite el resumen |
| 08:23:54 | `confirmacion_desde_snapshot` total=378 — confirma otra vez, ahora sí |

El cliente confirmó **dos veces con 67 segundos de diferencia** y recibió el
mismo resumen en medio. Los otros cuatro casos no se pudieron seguir hasta el
final con los logs disponibles: no consta si esos clientes insistieron.

**Causa.** `AFIRMACIONES` en `src/agent/confirmacionVerbal.js` se comparaba
ENTERA contra el mensaje normalizado, así que solo se reconocía la frase exacta
de la lista. Medido sobre 18 formas naturales de confirmar, **13 caían en
`indeterminado`** — y no eran las largas: `"confirmalo por favor"` (3 palabras),
`"correcto, procede"` (2), `"listo, mandalo"` (2). El tope de cinco palabras
tapaba el diagnóstico pero no era el problema.

`indeterminado` no es inocuo: marca el snapshot como **no confirmable**, así que
el pedido que el cliente acaba de aceptar deja de poder registrarse desde el
resumen que él mismo aceptó.

**Corrección** (`a67361a`). La tolerancia se abre por **vocabulario**, no por
longitud: se acepta mientras cada palabra sea núcleo afirmativo, verbo de
confirmar explícito o relleno de cortesía. En cuanto aparece una palabra con
CONTENIDO (cantidad, producto, modalidad) vuelve a fail-closed. Mutación y
negación se siguen evaluando antes y sobre el texto completo.

De 13 formas no reconocidas se pasa a **1**, que se deja así a propósito:
`"Sí, confirma mi pedido de 2 paninis"` reformula cantidades que nadie ha
comprobado contra el resumen.

## Incidente 2 — la suite de seguridad transaccional se desincronizaba sola

`fase-seguridad-transaccional` llevaba en 14/18 y esos cuatro fallos se citaban
como "preexistentes, idénticos a baseline" en varios commits. **No eran cuatro
defectos: era uno solo arrastrando a los otros tres.**

`confirmarWA` encola dos respuestas del modelo, pero desde la confirmación
determinista (`b4ece87`) el backend registra desde el snapshot **sin llamar al
modelo**. La segunda respuesta se quedaba en la cola FIFO compartida del mock y
se la comía el test siguiente: T11 recibía el resumen de T9, y T12 recibía el
mensaje que T11 había encolado.

**Corrección** (`518a279`): `drenar()` en el mock, llamado por `confirmarWA`.
Se arregla la prueba, no el producto. Y T7 traía además un mensaje
desactualizado que reformulaba cantidades; se cambió por una confirmación
limpia, igual que se hizo con D3b/D3c en `290ceda`.

Resultado: **18/18**, primera vez que la suite está entera en verde.

## Incidente 3 — el cliente contesta repitiendo el nombre del grupo

**Evidencia de producción, y esta es POSTERIOR al despliegue vigente.**
2026-09-08 08:39 CDT, con `290ceda` ya corriendo:
`catalogo_conversacional_bloqueado` con `invalidos=["mencion:proteína pollo"]`.
El cliente contestó repitiendo el nombre del grupo junto con su elección — que
es exactamente como se lo preguntamos — y la mención no resolvió.

El evento `MENCION_NO_RESUELTA` aparece 9 veces entre el 02 y el 08 de
septiembre; la mayoría corresponden a defectos ya corregidos (`suizos`,
`Prensado y panela en salsa`, `con bistec`). Los vivos son este y el del
2026-09-08 10:54 (`mencion:900`, `mencion:acoros`), que parecen un error de
tecleo del cliente y no se persiguieron.

**Causa.** `contienePalabra` exige que la mención ENTERA quepa dentro del nombre
de la opción o al revés. `"proteina pollo"` no cabe en `"Pechuga de pollo"` ni
al revés. Reproducido con catálogos sintéticos: con una opción corta
(`"Pollo"`) resolvía por casualidad, y con una de varias palabras se perdía —
por eso no lo veía ninguna prueba existente.

**Corrección** (`4a735f2`). Cuando nada más casó, se quita el nombre del grupo
y se vuelve a resolver DENTRO de ese grupo, recursivamente sobre un solo grupo
para conservar la exigencia de candidato único. Se ignora el separador
(`"Proteína: pollo"`). Solo puede aceptar más, nunca rechazar más.

## Incidente 4 — contestar varias preguntas de una vez borra todas las respuestas

**También posterior al despliegue vigente.** 2026-09-08 08:45 CDT,
`mencion_descartada` con cuatro spans en un solo turno:

```
{"span":"salsa verde","motivo":"span_inexistente"}
{"span":"en agua","motivo":"sin_posicion_de_atributo"}
{"span":"proteina pollo","motivo":"sin_posicion_de_atributo"}
{"span":"guarnicion papas con chorizo","motivo":"sin_posicion_de_atributo"}
```

El backend le había hecho varias preguntas seguidas y el cliente las contestó
todas de golpe separadas por comas — salsa, preparación, proteína y
guarnición. Se perdieron las cuatro.

**Causa.** `esRespuestaDirecta` exige que el span abra el mensaje Y lo cubra
casi entero. Solo el primer renglón abre el mensaje y ninguno lo cubre. Y la
cascada es lo que lo vuelve grave: al descartarse el primero tampoco entra en
`anclas`, y sin ancla el segundo no tiene de qué colgarse.

**Corrección** (`8661134`). Un span que ocupa un renglón entero de una lista se
conserva, y va a `respuestas`, nunca a `atributos` — un atributo sí puede
acabar diciéndole al cliente que no manejamos algo.

**Ojo, y esto importa para no confundir los dos arreglos:** los incidentes 3 y 4
son etapas distintas. El 3 descarta *después* de comparar contra el catálogo
(`MENCION_NO_RESUELTA`); el 4 descarta *antes* de llegar a comparar
(`sin_posicion_de_atributo`). Ninguno de los dos bastaba solo: se componen, y
por eso `"proteína pollo"` aparece en los dos eventos.

## Pruebas ejecutadas

Suites con pruebas nuevas (todas fallaban antes del arreglo correspondiente):

- `fase-confirmacion-determinista` **38/38** (36 previas + 2 nuevas) — incidente 1
- `fase-negaciones-injustas` **25/25** (23 previas + 2 nuevas) — incidente 3
- `fase-fidelidad-borrador` **27/27** (25 previas + 2 nuevas) — incidente 4
- `fase-seguridad-transaccional` **18/18** (antes 14/18) — incidente 2

**Regresión definitiva sobre base recién creada: 34/36 suites en verde**, con
`fase-seguridad-transaccional` y `fase-confirmacion-determinista` repetidas al
final para descartar intermitencia (18/18 y 38/38 las dos veces). Las dos que
fallan están explicadas arriba y ninguna la causaron los cambios de esta sesión.

Sin regresiones en el camino de pedido: confirmacion-ux 13,
pedido-determinista 13, flujo-real 6, multi-item 13, grupos-requeridos 24,
autoridad-grupos 15, validacion-conversacional 17, e2e-licuado 5,
modificadores-grupo-identidad 20, modificadores-llm 9,
fidelidad-catalogo-notas 14, promo-participantes 12,
promo-condiciones-modificadores 28, hotfix-borrador-recuperable 8,
bot-ux-cierre 27, preconfirmacion-pricing 18, agrupamiento-turnos 14,
chat-manual 22, tomar-conversacion 17, brain-contexto-visual-v2 25,
routing-categoria 10, normalizar-fecha 23.

## Tres suites que fallaban, y a quién le tocaba cada una

La regresión final dio 31/34. Los tres fallos se atribuyeron con dos
experimentos, no a ojo:

1. **Contra el commit anterior a los cambios del asistente** (`ed999d3`), sobre
   la misma base: resultados **idénticos** (`bot-enlace-pago` 5/11,
   `folio-concurrencia` 22/1). Ninguno lo causaron los cambios de esta sesión.
2. **Contra una base desechable recién creada** (`edgefresh`, 81 tablas,
   sembrada de cero):

| Suite | Base usada toda la noche | Base nueva | Veredicto |
|---|---|---|---|
| `fase-bot-forma-pago` | falla (`duplicate key value`) | **verde** | contaminación local |
| `fase-folio-concurrencia` | 22/1 | **23/23** | sensible al estado acumulado |
| `fase-bot-enlace-pago` | 5/11 | **7/9 de 16** | **fallo real preexistente** |

Sobre `folio-concurrencia` hay un matiz que conviene no perder: en base recién
creada da 23/23, pero en la batería completa vuelve a dar 22/1 cuando le tocan
32 suites por delante escribiendo en la misma base. No es el producto: es que
esa suite depende del estado y la batería se lo ensucia. Corrida sola, pasa.

Lección operativa: una base local con muchas corridas encima produce fallos
que no existen. Ante un fallo raro, repetir en base nueva antes de creerlo.

La `edged1` de esta sesión acabó tan contaminada que ni el propio seed corría
(`usuarios_email_key` duplicado). Se recreó desde cero al terminar —81 tablas y
seed en verde— así que queda en el estado que describe la receta del CLAUDE.md.
Recrearla es barato y conviene hacerlo cada tantas sesiones:

```powershell
docker exec pg-restv2 psql -U postgres -c "DROP DATABASE IF EXISTS edged1 WITH (FORCE)"
docker exec pg-restv2 psql -U postgres -c "CREATE DATABASE edged1"
# y repetir los pasos 4 y 5 de la receta (migraciones + predeploy + 065/066 + seed)
```

### `fase-bot-enlace-pago` — fallo real, NO corregido

Preexistente en `main` y ajeno a esta sesión. Los nueve fallos están en la
ENTREGA del enlace, no en la intención: `[INTENCION]` pasa (las 11 frases se
reconocen y los mensajes normales no disparan cobro), y lo que falla es que el
bot responde *"Te compartimos los datos de pago en un momento"* en vez de la
URL. Ese texto es el respaldo de `whatsapp-meta.js:843`, que se usa cuando
`crearEnlacePago` devuelve un resultado **sin `url`**.

No es un fixture faltante: la suite monta sus propias credenciales de Clip con
un mock (`guardarCredencialesClip` + `marcarProveedorPrincipal`). Queda por
determinar por qué la resolución de proveedor no entrega URL.

**No se tocó**: es otro subsistema (pagos, no toma de pedidos) y no parecía
prudente cambiar un camino de dinero de madrugada sin revisión. El síntoma es
un enlace que no se envía —un cobro que no ocurre—, no un cobro incorrecto.

## Cómo correr esto sin engañarse

**Las suites no toleran ejecución concurrente.** Comparten puertos fijos
(`fase-e2e-licuado` y `fase-seguridad-transaccional` usan 4193) y la misma base.
Dos corridas a la vez producen `EADDRINUSE` y números falsos: en esta sesión una
corrida en paralelo dio 10/18 en `seguridad-transaccional` cuando aislada daba
15/18. Correr siempre en serie, y desconfiar de cualquier resultado obtenido
mientras había otra corrida viva.

## Límites de esta validación

- Todo es **local**, contra la base desechable en Docker y con Anthropic y Meta
  simulados. **Pasar las suites no valida producción.**
- No se envió ningún mensaje real, ni se ejecutó ningún cobro, pedido o
  impresión de verdad.
- Railway se consultó **solo en lectura**.
- **Sin push**: no se pudo verificar desde fuera que un push a una rama no
  dispare despliegue (la rama de deploy se configura en el panel de Railway, no
  en `railway.toml`), así que los commits quedan en local.

## Pendiente

- Los otros cuatro casos de `preview_no_confirmable_turno_indeterminado` no se
  reconstruyeron hasta el final; falta saber si algún cliente se fue.
- `fase-comanda-edge-exclusiva` sigue en 18/23 con
  `upsertPedidoEnTablero is not defined`: el test extrae funciones del panel por
  texto y las evalúa en un sandbox que ya no incluye a todas las que se llaman
  entre sí. Es deriva test↔panel, ajena al asistente.
- Cuando un turno queda `indeterminado`, el bot vuelve a emitir un resumen en
  vez de preguntar de forma explícita qué quiso decir el cliente. Con el arreglo
  esto pasa mucho menos, pero el camino sigue ahí.
- **Posible pedido duplicado, sin verificar.** El 2026-09-02 aparecen DOS
  `confirmacion_desde_snapshot` con el mismo `total=330` para el mismo negocio,
  a las 10:22:17 y a las 10:25:48, con un `modificador_no_reconocido` y un
  `total_mismatch` en medio. Puede ser un cliente que pidió otro igual (que es
  legítimo y frecuente) o un cobro doble. **No se comprobó**: distinguirlo
  exige mirar `pedidos_activos` de producción, y esta sesión no tocó bases de
  producción. Vale la pena revisarlo con los folios a la vista.
- `modificador_no_reconocido` descarta la opción **en silencio**: el cliente no
  se entera de que lo que pidió no se registró. No aparece desde el 2026-09-03
  (lo apagaron los arreglos de raíz y diminutivos), así que no es un fuego, pero
  el patrón "callarse no es neutral" ya costó un incidente antes.
- `catalogo_conversacional_bloqueado invalidos=["Bebida:Limonada"]`
  (2026-09-08 08:49) usa la forma canónica `Grupo:Opción`, distinta de
  `mencion:`. No se investigó si comparte causa con el incidente 3.
