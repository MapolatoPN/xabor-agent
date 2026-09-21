# Rescate del Mesero de WhatsApp — estado

**Rama:** `rescue/mesero-tool-agent` (desde `a90c8d0` = producción `dab2f12` + 1)
**Fecha:** 21 de septiembre de 2026
**Auditoría de partida:** [`mesero-auditoria-2026-09-20.md`](mesero-auditoria-2026-09-20.md)

**Estado de salida:** el bloqueo operacional está CERRADO. El recorrido
completo —webhook → agente → `registrarPedido` → `emitirPedido` → panel →
impresión— se demuestra ahora con el servidor real, Postgres real y el
WebSocket del panel real en `test/fase-agente-recorrido-operacional.mjs`, y
los cuatro observadores (registro, panel, impresión y compra durable) miran
el MISMO folio. La caída posterior al COMMIT también se prueba contra la
base: no nace un segundo pedido y el handoff humano sí sale.

La puerta técnica del evaluador está **ABIERTA**: la última corrida con modelo
real pasó **26 de 26 fixtures**, con **0 invariantes críticas rotas** (§7).
El commit `9f3abb0` está desplegado en Railway desde
`prod/mesero-shadow-v3` (deployment `9adaf2e9-bffa-461e-aa2e-3a514a38130c`);
la migración 084 está aplicada. La sombra y el agente productivo están activos
para Mapolato Obispado; el porcentaje del agente quedó en `100` y la lista de
teléfonos está vacía para incluir a todos los clientes. El canario real quedó
validado: armó un Café Americano
para recoger y pagar en efectivo, mostró el resumen de $39 y, tras el «Sí» del
cliente, creó una sola vez el folio `XAB-0446`. El pedido, la compra durable y
el trabajo de impresión comparten ese folio; la impresión quedó pendiente de
que la terminal la recoja, sin error. El bot legacy permaneció apagado durante
ese recorrido de prueba. Después de la validación se activó
`bot_whatsapp_activo` únicamente para Mapolato y luego el agente se amplió al
100% de sus teléfonos. Los eventos de `agente_outbox` siguen sin
consumidor y no forman parte del camino productivo actual.

### Corrección de formas de pago del canario

Mapolato Obispado tiene disponibles para el bot `efectivo`, `terminal` y
`enlace_pago`; `transferencia` está deshabilitada. El agente ahora consulta
esa lista antes de aceptar la elección. Si el cliente pide transferencia, el
carrito no cambia y la respuesta determinista explica que no se acepta y
ofrece enlace de pago, similar a una transferencia. Un «sí» posterior puede
aceptar ese ofrecimiento.

El enlace se crea con `pagosService.crearEnlacePago()` únicamente después de
que `registrarPedido()` devolvió el folio confirmado. La misma capa calcula el
monto desde el pedido persistido y reutiliza el enlace ante reintentos. La
integración principal de Obispado es Clip, está activa y marcada como
`sandbox`; no se cambió a producción. Si Clip falla, el pedido ya registrado
se conserva, no se inventa una URL y se solicita revisión humana.

Los pedidos del agente que usan `enlace_pago` ahora declaran pago anticipado:
nacen en `pendiente_pago` y no emiten comanda, impresión ni oferta a reparto
hasta que el webhook verificado confirme el dinero. Efectivo y terminal
mantienen el recorrido inmediato. `test/fase-agente-gate-de-pago.mjs` prueba
esta frontera contra Postgres local y la ruta real de emisión.

La conversación del canario ya había confirmado `XAB-0447` con pago en
terminal antes de desplegar esta corrección. El cambio no altera pedidos
confirmados ni crea enlaces retroactivamente.

### Corrección de modalidades del canario

Mapolato Obispado solo permite `recoger en tienda` y `entrega a domicilio`.
Se retiró `consumo en sitio` de `configuracion.reglas_atencion`. El agente lee
esa lista por negocio en cada turno; si el cliente pide comer ahí, el carrito
no cambia y una respuesta determinista aclara que no existe ese servicio y
ofrece recoger o domicilio. Una conversación antigua que guardara consumo en
sitio se limpia antes de continuar.

La validación final vuelve a comprobar la modalidad para pedidos de WhatsApp,
de modo que una llamada incorrecta del modelo tampoco puede registrar consumo
en sitio. Los flujos presenciales de POS y restaurante conservan sus mesas.
El humo con Claude real y la carta/configuración productiva respondió a
«quiero comer aquí» con el rechazo correcto, ofreció recoger o domicilio y
dejó la modalidad vacía; no registró, imprimió ni cobró nada.

### Corrección del desglose de envío

El resumen del Mesero ahora usa el mismo cálculo de envío que la validación
final. Para Mapolato, un café de $39 a domicilio se muestra como subtotal de
$39, envío de $60 y total de $99 desde que se elige domicilio. El mensaje que
acompaña el enlace de Clip también reemplaza cualquier texto incompleto del
modelo y anuncia el total canónico, incluido el envío.

### Fallo del agente: revisión humana, sin regreso al bot legacy

Cuando el agente nuevo no puede atender un turno (por ejemplo, falta la carta,
falla el modelo o ocurre una excepción), el canal marca la conversación para
revisión humana, pausa las respuestas automáticas, avisa al equipo y corta el
turno. El mismo mensaje ya no continúa por `brain.js`; así se evita reintroducir
los errores del bot anterior. La prueba estructural está en
`test/fase-agente-fallo-handoff.mjs`.

### Pago por enlace solicitado después de una llamada

El flujo de voz ahora normaliza tanto `enlace de pago` como `enlace_pago`
antes de guardar el pedido y marca `requierePagoAnticipado`. Así, cuando una
persona llama y después manda su folio por WhatsApp, el pedido ya aparece en
el panel como `pendiente_pago`; el enlace se genera de forma idempotente y el
pedido solo pasa a emisión después del webhook verificado de Clip. La prueba
`test/fase-voz-enlace-pago.mjs` cubre las dos etiquetas y confirma que la marca
se coloca antes de `registrarPedido()`.

### Solicitudes de catering para Mapolato Obispado

Se agregó el perfil comercial configurable `cotizacion_perfil=catering`,
activado solo para Mapolato Obispado. La entrada se desvía antes del agente de
menú y usa la sesión comercial durable para recopilar nombre, número de
invitados, lugar y fecha. No expone herramientas de pedido ni permite
`<ORDEN_CONFIRMADA>`; si el turno rompe el contrato, se pausa y se manda a
revisión humana. Al completar los cuatro datos se crea un borrador de
cotización con servicio genérico pendiente de revisión y el cliente recibe
únicamente el aviso de que el equipo se pondrá en contacto. La prueba
`test/fase-catering.mjs` cubre el detector, los campos obligatorios y las
instrucciones de no ofrecer platillos.

Estos cambios quedaron en los commits `d74f27d`, `bb7b08d` y `4db2a64`,
desplegados en Railway como `a8851b4d-8379-4592-931a-f0d0cffce26e`;
`/health` respondió 200
después del despliegue.

### Menú en imágenes cuando el cliente lo solicita

El menú automático de Mapolato Obispado está activo con cuatro páginas de
imagen. Se corrigió el detector para que las frases personalizadas del panel
sean adicionales a las frases básicas (`menú`, `carta`, `precios`, etc.). Así,
variantes como “pásame el menú” también envían las imágenes configuradas; solo
se usa el menú textual si Meta o el almacenamiento no permiten entregar una
imagen. El cambio quedó en `16599d9`, desplegado como
`ad6bd078-de74-4b7f-9944-8b26a559e342`; `/health` respondió 200.

---

## 1. La arquitectura anterior, y por qué no se podía encender

```
mensaje -> continuidad -> brain.js
             |
             +-- el MODELO emite un PEDIDO ENTERO en <ORDEN_PREVIEW>
             +-- si no lo emite, se le PIDE OTRA VEZ (extraerBorradorForzado)
             +-- propuestasDesdeBorrador() deduce POR DIFERENCIA qué quiso cambiar
             +-- reconciliar() decide sobre ese diff
             +-- validarOrdenPropuesta() vuelve a decidir, con OTRAS reglas
```

Y el Mesero Digital —7.300 líneas, 24 suites, ~470 aserciones verdes— colgaba
de esto:

```
atenderTurno()  <-  sombraDelMesero.js  <-  whatsapp-meta.js:1876
                                            detrás de `if (!modo.meseroSombra)`
```

**Un solo sitio de llamada en todo `src/`, y era la sombra.** `modo.mesero`
—la bandera productiva `mesero_whatsapp_v1`— no la leía nadie. Poner esa clave
en `true` no cambiaba una línea de lo que el negocio contestaba.

No es que el Mesero estuviera mal probado. Es que **no había nada que
encender**: activar no estaba a una bandera de distancia, estaba a una
integración de distancia, y esa integración nunca se escribió porque toca dos
componentes protegidos.

## 2. La arquitectura nueva

```
WhatsApp
  -> continuidad existente (dedup wamid, FOR UPDATE, advisory lock)   SIN TOCAR
  -> whatsapp-meta.js: modoDelPedido(negocio, teléfono)
       proceso? negocio? ESTE teléfono en el canario?   -> si no, sigue el bot de siempre
  -> canalDelAgente.atenderConAgente()
       carga estado REAL (conversacion_estado) + carta REAL (menu_*)
  -> agenteDelMesero: bucle
       modelo -> tool_use -> [esquema] -> [máquina de estados] -> [libro] -> ejecutor
       ejecutor -> reconciliar()  <- LA ÚNICA AUTORIDAD
       RELECTURA del pedido -> tool_result -> el modelo sigue
  -> el modelo redacta DESPUÉS de todas las herramientas
  -> registrarPedido() (la puerta de siempre) -> emitirPedido() (ruta operacional durable)
  -> WhatsApp
```

La diferencia en una frase: **el modelo ya no emite un estado, emite
operaciones, y cada una vuelve con lo que realmente pasó.**

### Lo que se reutilizó tal cual

| Pieza | Para qué |
|---|---|
| `services/whatsappContinuidad.js` | dedup por `wamid`, agrupación 6 s, `FOR UPDATE`, `pg_advisory_lock`, ejecución interrumpida. **No se construyó Redis ni BullMQ**: no hay evidencia de que Postgres no alcance. |
| `orders/carritoDelPedido.js` `reconciliar()` | la autoridad. Toda mutación pasa por aquí y sigue exigiendo evidencia en lo que DIJO el cliente. |
| `mesero-whatsapp/motorTransaccional.js` | ya era un ejecutor de acciones; le faltaba el emisor. |
| `mesero-whatsapp/consultasDelMenu.js` | `buscar_producto` y `ver_opciones_producto` son esto. |
| `mesero-whatsapp/resumenDelPedido.js` | resumen desde el carrito validado + `huellaDelResumen`. |
| `mesero-whatsapp/faseConversacional.js` `loQueFalta()` | incluye «un domicilio sin dirección NO está listo». |
| `orders/orderManager.js` `registrarPedido()` | única puerta de creación de pedidos, con su gate P0. |
| `conversacion_estado` (migración 076) | el estado del agente entre turnos, en su propio espacio de nombres. **Una tabla menos.** |

### Lo que se retiró del camino crítico

| Se retira | Por qué |
|---|---|
| `<ORDEN_PREVIEW>` / `<ORDEN_CONFIRMADA>` | el modelo ya no emite un pedido entero. |
| `extraerBorradorForzado()` (2.ª llamada al modelo) | no hay borrador que arrancarle. |
| `propuestasDesdeBorrador()` (el diff) | las operaciones llegan explícitas. |
| `clasificarTurnoPostPreview()` | la huella del resumen hace el trabajo, con datos y no con léxico. |
| **el menú dentro del prompt** | la carta se consulta con una herramienta. Un menú memorizado es de donde salen los platillos que no existen. |
| 3 de los 4 tipos de aclaración | con `producto_id` obligatorio, un renglón ambiguo no puede nacer. Queda «grupo obligatorio sin elegir», y se deduce del carrito. |
| el estado conversacional guardado | el estado se CALCULA del carrito. Un estado guardado es una opinión, y se desincroniza. |

**Nada de esto se ha borrado de `brain.js`.** El camino viejo sigue entero y es
el que atiende a todo el mundo fuera del canario. Retirarlo es un paso
posterior, cuando el agente lleve tráfico.

## 3. Las herramientas (12)

| Herramienta | Efecto | Qué garantiza |
|---|---|---|
| `ver_pedido` | no | el modelo nunca supone el contenido del pedido |
| `buscar_producto` | no | sin resultados = NO existe; varios = pregunta, no elige |
| `ver_opciones_producto` | no | grupos y cardinalidad reales del negocio |
| `agregar_producto` | sí | exige `producto_id` real; opciones validadas contra ese producto |
| `modificar_linea` | sí | cantidad, opciones, `sin_opciones` (quitar), nota |
| `quitar_linea` | sí | por `linea_id`; el verbo lo sigue exigiendo el reconciliador |
| `definir_entrega` | sí | modalidad y/o dirección; un domicilio sin dirección no queda listo |
| `definir_pago` | sí | solo acepta métodos habilitados para el bot; normaliza alias y exige evidencia del cliente |
| `definir_cliente` | sí | el teléfono ya lo tiene Xabor |
| `cancelar_pedido` | sí | desenlace de conversación, no edición de carrito |
| `confirmar_pedido` | sí | **exige la huella del resumen que el cliente leyó** |
| `pedir_humano` | sí | legal incluso con el pedido confirmado |

Esquema Zod estricto (`additionalProperties: false`); el JSON Schema que ve el
modelo se **deriva** del mismo Zod, así que no pueden divergir.

## 4. La máquina de estados

```
navegando -> armando -> aclarando -> listo -> confirmado
                 \                      \
                  +--> cancelado         +--> escalado
                                          +--> fallido
```

**El estado no se guarda, se calcula** del carrito real. Solo se guardan los
cuatro hechos irreversibles. Se retiró `confirmando` del diseño: su única
función era recordar que se mostró un resumen, y eso ya lo lleva la huella.

Legalidad: leer siempre; mutar solo en los cuatro estados en curso;
`confirmar_pedido` **solo desde `listo`**; `pedir_humano` también desde
`confirmado`. «No se puede cambiar un pedido confirmado» no necesita una regla
por herramienta: no hay ninguna mutación legal ahí.

## 5. Invariantes

Se comprueban en **todos** los fixtures, diga lo que diga cada uno.

| Invariante crítica | Cómo se detecta |
|---|---|
| `producto_inventado` | un renglón que no está en ninguna carta |
| `cruce_multiempresa` | un renglón de la carta de OTRO negocio |
| `mutacion_no_autorizada` | el pedido cambió en un turno sin ninguna herramienta aplicada |
| `confirmacion_distinta` | lo mandado a cocina != el pedido real |
| `precio_incorrecto` | el total != suma de la carta |
| `efecto_repetido` | la misma operación registrada dos veces |
| `pedido_duplicado` | dos confirmaciones en una conversación |

## 6. Resultados

```
test/fase-agente-tools.mjs        62 pasadas, 0 fallidas    (contrato, ejecutor, FSM, libro,
                                                             pagos y modalidades)
test/fase-agente-canario.mjs      17 pasadas, 0 fallidas    (alcance, kill switch, sombra,
                                                             bot legacy apagado)
test/replay-mesero.mjs            26 pasadas, 0 fallidas    (conversaciones completas)
test/fase-agente-estado.mjs        lectura fallida rechazada, sin inventar estado nuevo
test/fase-agente-emision.mjs       registro enlazado a emitirPedido; enlace de pago solo
                                   después del folio; falla de Clip no duplica el pedido;
                                   enlace anuncia total y envío canónicos
test/fase-agente-gate-de-pago.mjs  5 pasadas, 0 fallidas; enlace nace pendiente_pago y
                                   no emite comanda antes del webhook verificado
test/fase-agente-ciclos.mjs        un pedido nuevo rota la identidad del libro
test/fase-agente-fallo-handoff.mjs  5 invariantes: fallo del agente pausa y avisa;
                                   nunca vuelve al bot legacy
test/fase-agente-confirmacion-perdida.mjs  COMMIT con respuesta perdida: no nace
                                   otro pedido Y alguien se entera (18 casos, 5 mordidas)
test/fase-agente-indice-local.mjs  índice único y libro probados en Postgres local; ROLLBACK
test/fase-agente-recorrido-operacional.mjs  13 pasadas, 0 fallidas
                                   EL RECORRIDO COMPLETO con servidor real:
                                   webhook → agente → registro → emisión →
                                   panel (WS real) → impresión (Edge real)
                                   + caída tras COMMIT y revisión humana en Postgres
npm run mesero:eval               invariantes críticas: 0/7   PUERTA: ABIERTA
mesero:eval -- --modelo            última corrida: 0 críticas, 26/26
                                   correctos; PUERTA: ABIERTA
30 suites del Mesero anterior     verdes sin base de datos
4 suites con base de datos        verdes sobre una base DEDICADA (ver §11)
```

**Pruebas de mordida** — cada garantía desactivada por separado, y dónde cae:

| garantía desactivada | caen |
|---|---|
| el `producto_id` no se resuelve contra la carta | B3 |
| las opciones no se validan contra el producto | B4 B5 B6 B7 |
| la máquina de estados sin guardia | D4 E3 |
| la huella del resumen sin comparar | E2 |
| el libro sin idempotencia | F1 F6 |
| lo ofrecido no se limita a un candidato | G2 |
| los esquemas dejan de ser estrictos | A3 A5 |
| el reconciliador deja de decidir | C1 C2 C3 G2 G3 |
| el pedido no se relee tras mutar | B7 E4 |
| el canario deja de acotar | A1 A2 C4 |
| la llave del proceso deja de hacer falta | B1 |
| la lista deja de mandar sobre el porcentaje | A4 |
| el porcentaje se vuelve aleatorio | A5 |
| «true» deja de ser la palabra exacta | B3 |
| el agente se observa a sí mismo | C2 |
| un error de lectura ya no cae apagado | B4 |
| la guardia del libro solo bloquea confirmaciones con éxito | P10 |
| un error sin clasificar se degrada a rechazo seguro | P11 |
| escalar deja de ser legal desde un estado terminal | P12 P13 P15 |
| un handoff que no se entrega se da por hecho | P14 |
| el adaptador interpreta `false` del canal como aviso entregado | P14b |
| el adaptador solo mira la señal del libro, no el turno roto | P15 P16 |
| la conversación no se congela tras una confirmación rota | P16 |
| el agente registra el pedido pero no lo emite | R3 R4 R6 |
| las tres capas del handoff, apagadas a la vez | R9 |

### Tres defectos REALES que encontró el replay

No los introdujo el código nuevo: los descubrió, y llevaban tiempo ahí.

1. **«quita el waffle, el café sí lo quiero» borraba los dos.** El corte de
   alcance asume objeto después del verbo; el español lo antepone con clítico.
   Regla general de gramática: con clítico antes del verbo de pedir, el alcance
   se corta en el límite de cláusula anterior. Una enumeración sin verbo propio
   («quita el waffle, la coca y ya») sigue quitando las dos.
2. **«sin huevo» no quitaba nada.** Vaciar un grupo era *inexpresable*: la lista
   vacía se caía del borrador y el reconciliador conservaba lo viejo (y hacía
   bien: eso es lo que arregló `fase-mesero-suma-grupos`). Ahora se distingue
   array vacío —una decisión— de omisión, y vaciar sigue necesitando que el
   cliente lo pidiera.
3. **«dos bowls iguales» entregaba uno.** Dos acciones idénticas en el mismo
   turno son dos peticiones, no un reintento: la clave de operación lleva el
   ordinal por contenido.

## 7. Humo con el modelo real

El 20-sep se ejecutó con `claude-sonnet-5`, clave de prueba del usuario y
Postgres local. El catálogo de prueba contenía 24 categorías y 26 productos.
Con PAR Hotcakes y PAR Cafe, el modelo agregó dos líneas, fijó recogida y pago
en efectivo, mostró el resumen de $120 y confirmó tras el «sí» explícito.
Resultado: un efecto **simulado** de confirmación, cero llamadas ilegales y
ningún pedido registrado. Una primera conversación sobre chilaquiles encontró
grupos obligatorios sin opciones en el catálogo local: el agente rechazó la
opción inexistente y escaló. Ese fixture no sirve para demostrar una compra.

El replay corre el sistema entero con un **modelo de guion**. Eso prueba que
Xabor decide bien —rechaza lo no autorizado, no inventa productos, no confirma
de más, no aplica dos veces— y **no prueba nada** sobre si el modelo entiende a
una persona ni sobre si llama a las herramientas correctas.

El humo exige un guion explícito para que coincida con la carta elegida:

```bash
node scripts/mesero-humo.mjs --negocio <uuid> --guion "producto real|entrega|pago|sí, confirmo"
```

Sin efectos (no registra, no escala, no imprime). `--registrar` se rechaza:
los pedidos reales solo se prueban mediante el canario autorizado.
La clave del humo se pasa directamente al cliente del modelo para evitar
importar `server.js` y arrancar los jobs de la aplicación durante la prueba.

Segunda medición con modelo real, sobre los 26 fixtures:

```bash
ANTHROPIC_API_KEY=... npm run mesero:eval -- --modelo
```

**Última corrida completa, 20-sep**
(`informes/mesero-eval-modelo-6d77443.json`): **0 críticas, 26/26 fixtures
correctos; puerta abierta**. Hizo 121 llamadas al modelo, con 664 663 tokens
de entrada, 11 558 de salida y 8,9 s por conversación en promedio. La clave
`ANTHROPIC_API_KEY` ya existía en el entorno de usuario de Windows; el proceso
de prueba tuvo que cargarla porque no la había heredado. No se guardó en el repo.

La medición anterior al ajuste del prompt fue 14/26, con 0 críticas
(`informes/mesero-eval-modelo-6d77443-pre-ajustes.json`, local). Se corrigieron
la búsqueda de un nombre exacto, el agregado inmediato de productos pedidos,
el manejo de opciones pendientes, los cambios de modalidad y el cierre tras
un resumen confirmado. El medidor ahora compara por significado las variantes
equivalentes de recoger/domicilio y suma cantidades de renglones idénticos:
tres renglones de una unidad equivalen a uno de una y otro de dos. Sigue
distinguiendo productos y opciones diferentes.

La primera corrida había informado una crítica `mutacion_no_autorizada` en
`mensaje-duplicado-de-meta`. El replay guardaba solo la segunda ejecución de
un mensaje duplicado y podía atribuir a ella la mutación válida de la primera.
Se reprodujo sin API; el medidor ahora conserva ambas ejecuciones y una
regresión con respuestas distintas pasa. El informe previo se conservó como
`informes/mesero-eval-modelo-6d77443-pre-medidor.json` (local, ignorado por Git).

## 8. Pasos exactos para la SOMBRA

La sombra no responde, no registra, no imprime, no cobra, no escala y escribe
su libro en memoria. Funciona con el bot productivo apagado.

1. En Railway, sobre la rama de despliegue vigente (**no `main`** — ver
   CLAUDE.md), variables del servicio:
   ```
   MESERO_AGENTE_SHADOW=true
   ```
2. En `configuracion`, para el negocio a observar:
   ```sql
   INSERT INTO configuracion (negocio_id, clave, valor)
   VALUES ('<uuid>', 'mesero_agente_shadow', 'true')
   ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = 'true';
   ```
3. Aplicar las migraciones (ver §11).
4. Leer en los logs de Railway (**hora UTC-6**, no UTC):
   `[SOMBRA-AGENTE] {...}` — una línea JSON por turno, sin PII.
5. Apagar: quitar `MESERO_AGENTE_SHADOW` o poner la clave del negocio a
   `'false'`. Cualquiera de las dos basta.

## 9. Pasos exactos para el CANARIO

Autorizado y activado el 21-sep únicamente para el teléfono de prueba terminado
en `9919` de Mapolato Obispado. `mesero_agente_porcentaje='0'`: ningún otro
teléfono entra al agente nuevo.

Prueba real cerrada el 21-sep: el primer turno quedó `listo` con cuatro
operaciones aplicadas; el «Sí» del cliente ejecutó una sola
`confirmar_pedido`, creó `XAB-0446`, emitió `nuevo_pedido`, registró la compra
durable y creó el trabajo de impresión. No hubo handoff ni error. La prueba se
hizo con `negocios.bot_whatsapp_activo=false`; no fue necesario abrir el bot
legacy para los demás clientes.

1. **Gate previo.** El bloqueo operacional está cerrado: el pedido llega al
   panel y a la impresión con el mismo folio, y está probado
   (`test/fase-agente-recorrido-operacional.mjs`, §6). La evaluación con modelo
   real del 20-sep **pasó 26/26 con 0 críticas** (§7).
2. Variable del servicio:
   ```
   MESERO_AGENTE_MODE=true
   ```
3. Alcance **explícito** — sin esto no atiende a nadie, que es el diseño:
   ```sql
   INSERT INTO configuracion (negocio_id, clave, valor) VALUES
     ('<uuid>', 'mesero_agente_v1',        'true'),
     ('<uuid>', 'mesero_agente_telefonos', '528781234567')   -- los de prueba
   ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = EXCLUDED.valor;
   ```
4. Ampliar por porcentaje solo después, y por pasos: `mesero_agente_porcentaje`
   a `'5'`, luego `'25'`. El reparto es **estable por teléfono**: un cliente no
   salta entre bots a mitad de pedido.
5. **Kill switch — tres niveles, del más rápido al más fino:**

   | quitar | alcance | efecto |
   |---|---|---|
   | `MESERO_AGENTE_MODE` | todos los negocios | inmediato, sin redeploy de código |
   | `mesero_agente_v1='false'` | un negocio | al siguiente mensaje (no hay caché) |
   | vaciar `mesero_agente_telefonos` y poner porcentaje a `'0'` | unos clientes | al siguiente mensaje |

   En los tres casos se vuelve a la configuración legacy del negocio. Si su bot
   legacy está activo, ese bot responde; si está apagado, el mensaje queda
   guardado sin respuesta automática, como ocurría antes del canario.

6. **Verificar que llegó, no suponerlo.** `/health` responde 200 con el build
   viejo igual que con el nuevo. Lo que prueba: una conversación de prueba
   desde un número de la lista, y `[AGENTE] evento=atendido` en los logs.

## 10. Variables de entorno nuevas

| Variable | Para qué | Sin ella |
|---|---|---|
| `MESERO_AGENTE_MODE` | habilita el agente productivo | apagado |
| `MESERO_AGENTE_SHADOW` | habilita la sombra | apagada |
| `MESERO_AGENTE_MODELO` | modelo del agente | `claude-sonnet-5` |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_HOST` | trazas externas | solo la línea `[AGENTE-TRAZA]` en el log |
| `CORPUS_SALT` | seudónimo estable del corpus | el script se niega a exportar |
| `DATABASE_PUBLIC_URL` | leer producción desde fuera | el `DATABASE_URL` de la app es red interna y no se alcanza |

Claves de `configuracion` por negocio: `mesero_agente_v1`,
`mesero_agente_shadow`, `mesero_agente_telefonos`, `mesero_agente_porcentaje`.

## 11. Migraciones

La 084 crea el libro de operaciones y es requisito del agente productivo.
El script verifica que el camino crítico (pedidos, mensajes, configuración,
negocios) no cambió y aborta si algo difiere.

```bash
node scripts/predeploy-084-agente-operaciones.mjs   # libro de operaciones
```

Reverso: `migrations/084_agente_operaciones_down.sql`.
La 085 crea una tabla experimental sin consumidor y no es requisito del camino
productivo actual: no aplicarla por inercia.

**No hace falta migración para el estado del agente**: vive en
`conversacion_estado` (076) con su propio `session_id`.

### La base local estaba atrasada — cómo se levantó

Cuatro suites caían con `ECONNREFUSED ::1:5432`, y el síntoma engañaba: no
faltaba Postgres —`pg-restv2` llevaba días arriba en el 55453— sino las
variables. Sin `DATABASE_URL` el pool se va al 5432 por omisión y el error
no menciona jamás el archivo que falta cargar (`dev-local.env.cmd`).

Cargadas las variables, apareció el problema de verdad: **`edged1` tenía la
084 aplicada pero le faltaban la 080, 081, 082 y 083.** El síntoma tampoco
se parecía a su causa — `fase-estacion-meseros` devolvía siete 500 con
«Error interno del módulo de restaurante», que es el mensaje genérico; el
de verdad (`column c.descuento_monto does not exist`, de la 082) solo se ve
llamando a `listarMesas()` a mano, porque la suite se traga la salida del
servidor hijo.

Las suites NO se corren sobre `edged1`, que es una base compartida con otras
sesiones. Se usa una **dedicada**, que es lo que ya hacían las ramas
anteriores (`edged1_msh_rama`, `edged1_ais_base`…):

```powershell
# 1. copia de la base local, sin tocar la compartida
docker exec pg-restv2 psql -U postgres -c "CREATE DATABASE edged1_agrescate TEMPLATE edged1"
# 2. DATABASE_URL apuntando a la copia, y las migraciones que faltaban
node scripts/predeploy-079-rewards-canal-tienda.mjs
node scripts/predeploy-080-clientes-tienda.mjs
node scripts/predeploy-081-crm-clientes-negocio.mjs
node scripts/predeploy-082-restaurante-cobro.mjs
node scripts/predeploy-083-restaurante-division-consumo.mjs
node scripts/predeploy-084-agente-operaciones.mjs
```

Al terminar: **108 tablas** en `public`, y las cuatro suites en verde. Los
predeploy son idempotentes; volver a correr la 084 ya aplicada no hace nada.

`fase-agente-recorrido-operacional.mjs` crea su propio negocio de prueba
(carta, sucursal, terminal Edge, canario) marcado con el prefijo `AGR ` y lo
retira al terminar. El negocio tiene un slug único por ejecución; la limpieza
solo usa ese `negocio_id`. Se comprobó con 13 casos en `edged1_agrescate` y
cero negocios `agr-recorrido-%` residuales. La prueba **se niega a correr
contra un Postgres que no sea local**: escribe pedidos y compras reales.

## 12. Rollback

| Qué | Cómo | Deja algo atrás |
|---|---|---|
| Apagar el agente | quitar `MESERO_AGENTE_MODE` | no |
| Apagar un negocio | `mesero_agente_v1='false'` | no |
| Volver al build anterior | redeploy del commit previo de la rama de despliegue | la tabla 084, vacía e inerte |
| Deshacer la migración | `084_agente_operaciones_down.sql` | no |

El camino viejo (`brain.js`) no se modificó. La única edición en
`whatsapp-meta.js` es un bloque que, si el agente no puede o está apagado, se
aparta y deja seguir el flujo de siempre línea por línea.

## 13. Qué necesita aprobación humana

1. **Activar el canario** — atiende clientes reales.
2. **Desplegar** — CLAUDE.md: el despliegue es un acto explícito
   (`railway redeploy --yes --from-source`) y sobre la rama configurada en
   Railway, **no `main`**.
3. **Merge a `main`** o a la rama de despliegue.
4. **Correr el corpus contra producción** — lectura de conversaciones reales,
   aunque salgan anonimizadas.

## 14. Fallos restantes y riesgos

**Fallos preexistentes, comprobados idénticos en `a90c8d0`** (worktree del
commit base, misma base, mismo puerto):

| suite | resultado | en la rama | en la base |
|---|---|---|---|
| `fase-bot-calla-y-avisa` | S1, S2 (parseo de borrador JSON) | 22/2 | 22/2 |
| `fase-vision-v2-universal` | 1 caso | 62/1 | 62/1 |

Riesgos que quedan abiertos:

- **Emisión operacional: PROBADA de punta a punta.** Era el bloqueo principal
  y ya no lo es. `test/fase-agente-recorrido-operacional.mjs` corre el
  recorrido entero con el servidor real, Postgres real y el WebSocket del
  panel real: un webhook de WhatsApp entra por el sitio de llamada de verdad
  (`whatsapp-meta.js`), el agente arma y confirma, `registrarPedido` crea el
  folio, `emitirPedido` reclama la deuda de la 063 y de ahí salen las tres
  patas. La afirmación que cierra el riesgo es una sola: **registro, panel,
  impresión y compra durable miran el MISMO folio** (R6).

  De mentira hay exactamente tres cosas, y ninguna del lado de Xabor: el
  MODELO (un mock HTTP que devuelve `tool_use`), META (el mock de siempre) y
  el PAPEL (una terminal Edge falsa que habla el protocolo real de
  `edge/connection.js` y confirma el trabajo). Quien valida, reconcilia,
  registra y emite es el código de producción.

  La mordida: desconectar `emitir` del registro tumba R3, R4 y R6 — el pedido
  nace y no llega a nadie, que es justo el defecto que esta prueba existe
  para detectar.

  **Lo que sigue sin demostrar**, dicho para que nadie lo dé por hecho: que
  una EC Line 80mm escupa papel y que el navegador del panel dibuje la
  comanda. Eso pide hardware y un navegador delante. Lo que sí queda probado
  es que los dos reciben el folio correcto, que es la parte que un despliegue
  no arregla si está mal.
- **Resultado incierto del registro.** Si la conexión cae justo después del
  COMMIT de `registrarPedido`, el agente puede recibir un error sin saber si el
  pedido quedó creado. El libro ya bloquea un segundo intento en esa
  conversación y solicita intervención humana; la 084 tiene una restricción
  única para cerrar también la carrera entre dos turnos concurrentes. El
  índice y el libro pasaron una prueba transaccional en Postgres local.
  `test/fase-agente-confirmacion-perdida.mjs` corre ahora el caso entero sin
  base: turno que confirma, COMMIT hecho, respuesta perdida y estado SIN
  guardar; el turno siguiente rehidrata el estado anterior, el modelo vuelve a
  confirmar y no nace un segundo pedido —ni con la fila en `error` ni con la
  fila en `pendiente`, ni con la reentrega del mismo webhook—. Dos mordidas
  apagan las garantías (la guardia que solo bloqueara éxitos; el error
  degradado a rechazo seguro) y exigen que con ellas el duplicado aparezca.
  Y ese mismo caso corre ahora **contra Postgres** en
  `fase-agente-recorrido-operacional.mjs` (R8–R12): `registrarPedido` escribe
  de verdad y es la RESPUESTA la que se pierde, así que el COMMIT es real y
  quien bloquea el segundo intento es el índice único REAL de la 084, no su
  equivalente en memoria. R12 deja escrita la consecuencia operativa que
  obliga a llamar a una persona: el pedido existe en Postgres y NO llegó ni
  al panel ni al papel. No se debe pedir al modelo que reintente a ciegas.
- **La caída después del COMMIT ya avisa a una persona. CORREGIDO.** El defecto
  era de tres capas y se cerró en las tres. `pedir_humano` era **ilegal desde
  `fallido`**, así que el `catch` de `atenderTurnoConHerramientas` —que marca
  `fallido` y *luego* escala— escalaba al vacío: `efectos.escalar` no llegaba a
  correr, el cliente leía «te paso con alguien del equipo» y el pedido que sí
  quedó en Postgres no aparecía por ningún lado. Ahora:
  1. `pedir_humano` es legal en **todos** los estados (`LEGALIDAD` en
     `maquinaDeEstados.js`). Escalar no muta el pedido, cambia de manos la
     conversación, así que no le toca la regla de «ninguna mutación en un
     terminal» — y un terminal es justo cuando más falta hace una persona.
  2. `escalarYSalir` **comprueba** que el handoff se aplicara. Si no, lo grita
     (`[AGENTE] ALERTA handoff_no_entregado`) y lo devuelve como
     `handoffPendiente`, para que el adaptador —que es quien sabe a quién
     avisar— tenga un último intento. El texto prometía una persona sin
     comprobar que la hubiera; ya no.
  3. El adaptador mira el desenlace también en el camino **normal**, no solo
     en su `catch`: `atenderTurnoConHerramientas` no relanza, devuelve con
     `error`, y por eso ese `catch` jamás veía este caso. La decisión vive en
     `desenlaceDelTurno()`, separada del efecto para poder probarse sin base.
     Un turno que intentó confirmar y reventó pide `AGENTE_ESTADO_INCIERTO`,
     que es el aviso que le sirve a la operación: «puede haber un pedido sin
     dueño, revisa el panel».

  El aviso sale **antes** de `guardarEstado`: si la misma caída se lleva el
  guardado, lo que no se puede perder es la llamada a la persona. Si el agente
  ya había escalado dentro del turno, el operador recibe dos avisos sobre el
  mismo incidente; es deliberado, porque el segundo dice algo que el primero
  no, y suprimirlo pedía un mecanismo de cuenta que también puede fallar
  callado.

  Cubierto por P12–P15 y P17 de `test/fase-agente-confirmacion-perdida.mjs`, con
  mordidas: revertir la legalidad tumba P12, P13 y P15; revertir la lectura
  del adaptador tumba P15 y P16. Y comprobado también **contra la base**, en
  R9: tras la caída salen dos avisos, `AGENTE_PIDE_HUMANO` y
  `AGENTE_ESTADO_INCIERTO`. R13 comprueba además que la continuidad de WhatsApp
  actualiza una conversación ya marcada para revisión con el motivo preciso.
  P14b comprueba que un `false` de `enviarARevision` no se anuncia como entrega.
  Apagar las tres capas a la vez tumba R9 — pero
  deja ver la defensa en profundidad funcionando: con la legalidad y la
  lectura del adaptador rotas, la capa que comprueba el handoff todavía
  llamó a una persona (`AGENTE_HANDOFF_PENDIENTE`). Lo que R9 exige es el
  aviso PRECISO, el que dice que puede haber un pedido sin dueño.
- **Un ciclo nuevo tras esa caída ya no puede duplicar. CORREGIDO por lo
  anterior.** El agujero era que, con el estado guardado como `fallido`,
  «quiero hacer otro pedido» abría otro ciclo (`cicloDelAgente.js`) y la
  guardia del libro es por `conversacion_id`: en el ciclo nuevo no encuentra la
  confirmación anterior. Ahora el adaptador marca `estado.confirmacionIncierta`
  en cuanto la confirmación revienta —no solo cuando un turno posterior llega a
  ver la señal `incierta`—, y esa marca congela la conversación: `cicloParaTurno`
  no abre ciclo nuevo mientras esté puesta. P16 lo prueba y su mordida enseña el
  duplicado naciendo sin ella.

  Queda el límite de siempre: la marca vive en el estado, y el estado puede no
  guardarse. En ese reparto lo que bloquea es el libro, que es lo que prueban
  P3, P6 y P7.
- **Pedidos posteriores.** Un pedido nuevo explícito tras un estado terminal
  abre otro ciclo y otra identidad en el libro. Las consultas sobre el pedido
  anterior conservan el ciclo previo. Faltan pruebas con lenguaje real para
  medir si los clientes formulan el nuevo pedido de manera reconocible.
- **Outbox experimental.** La migración 085 y `outbox.js` siguen en la rama,
  pero no hay consumidor y el agente no escribe allí. No se deben usar como
  evidencia de entrega operacional ni habilitar sus efectos sin una revisión
  separada.
- **Calidad del modelo fuera de los fixtures.** La última corrida pasó 26/26
  casos (§7) y el primer pedido real del canario se completó correctamente,
  pero una conversación no representa todavía el lenguaje de todos los
  clientes. Hace falta acumular más tráfico observado antes de ampliar el
  porcentaje.
- **Coste por turno sin cuantificar en dinero.** La última corrida real hizo
  121 llamadas, consumió 664 663 tokens de entrada y 11 558 de salida, y tardó
  en promedio 8,9 s por conversación. Falta traducirlo a coste monetario.
- **`registrarPedido` revalida con `validarOrdenPropuesta`**, que sigue siendo
  un segundo juego de reglas junto al reconciliador. No se tocó a propósito —es
  el gate P0 y la única puerta de creación de pedidos—, pero es la duplicación
  de autoridad que queda por resolver.
- **`sin_opciones` sobre un grupo obligatorio** deja el renglón pendiente, que
  es correcto, pero si el cliente nunca contesta el pedido no avanza. Hoy sale
  por `pedir_humano` tras dos intentos.
