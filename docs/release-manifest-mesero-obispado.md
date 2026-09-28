# Manifiesto de liberación: Mesero de WhatsApp de Mapolato Obispado

> **Candidato LOCAL, sin push ni despliegue** (27-sep-2026). Este documento
> sustituye como evidencia a `.ai/HANDOFF.md`, que describe el despliegue
> `b83da41` y ya no corresponde al estado actual. Nada de lo que sigue se
> ejecutó contra producción: los pasos de despliegue, reversión y activación
> son instrucciones para Mario.

## 1. Veredicto en cuatro niveles

| Nivel | Estado | Qué falta |
|---|---|---|
| **Código listo para desplegar** | **Sí.** Pruebas en verde salvo los fallos históricos de §9, que son idénticos en la base; las mutaciones muerden; las barreras pasan también en un contexto Docker simulado | — |
| **Despliegue** | **NO-GO hoy.** Faltan comprobaciones de solo lectura que no se pueden hacer desde aquí | §12 (GO/NO-GO) y la autorización de Mario |
| **Activación del bot** (atención general) | **Fuera de esta liberación.** Obispado sigue con `bot_whatsapp_activo = false` | Canario completo y una decisión aparte del dueño |
| **Activación limitada al teléfono canario** | **Después del despliegue verificado**, con autorización propia | §11-B y el runbook de `docs/mesero-pedido-canonico.md` §17 |

## 2. Commit candidato

- Rama local `fix/voz-retirada`. El candidato es **el commit que agrega este
  archivo**; su padre es `3ae112cd22885bb291de8d6953a875cfefc82699`. Un archivo
  no puede llevar el hash de su propio commit, así que se obtiene con:

  ```powershell
  git -C C:\xabor-agent log -1 --format=%H --diff-filter=A -- docs/release-manifest-mesero-obispado.md
  ```

- El commit está en el repositorio compartido `C:\xabor-agent` (los worktrees
  comparten objetos), pero **no está en GitHub**: la rama no tiene upstream.

## 3. Qué corre hoy y cadena hasta el candidato

**Producción corre, según la evidencia local, `41c003b`.** No se consultó
Railway ni la base de producción para este documento. La evidencia:

- `origin/prod/mesero-shadow-v3` = `41c003be6491698b24e39a59d344051328a54969`,
  actualizado por el push del 26-sep a las 08:56 (hora de esta PC, que va
  atrasada ~1 h).
- La memoria del proyecto registra `41c003b` como «lo que corre producción»
  desde el 26-sep. La tarea que iba a publicar el arreglo de Mesas
  (`b033563`) ese día a las 4 pm se quedó detenida en su primer comando: su
  sesión sigue «en ejecución» desde las 20:01 UTC del 26-sep y el puntero no se
  movió. Su guarda de horario impide que publique aunque alguien la reanude,
  pero conviene cerrarla.

**Se confirma en Railway antes de desplegar** (paso 0.2 de §10). El vault
verificó `81be95e` con Railway el 26-sep a las ~05:05 UTC; `41c003b` salió
después ese mismo día.

`git log 3ae112c..41c003b` está vacío: el candidato contiene todo lo desplegado.
El arreglo de Mesas (`b033563`, rama `fix/mesas-cuenta-intuitiva`) **no** está
en el candidato. Si alguien lo publica antes, hay que integrarlo primero.

| # | Commit | Qué hace |
|---|---|---|
| — | `41c003b` | **Producción** (según la evidencia local) |
| 1 | `e670905` | Mesero: pedido canónico (esquema 2), commit atómico del turno, outbox con paso a persona, carta de WhatsApp (`whatsapp_productos`) que gobierna al agente y al bot legacy; sin carta, ningún bot contesta. Migraciones 098 y 099 |
| 2 | `c647091` | Retira `POST /chat` (público, llegaba al modelo). El menú en imagen solo sale si se revisó contra la carta vigente; si no, sale en texto. Migración 100 |
| 3 | `9499a81` | Retira el canal de voz: `/webhook/voice`, `/ws/voice`, `voice.js`, ElevenLabs y Deepgram (decisión del dueño) |
| 4 | `81b1494` | WebSocket en lista cerrada: solo `/ws/panel`, `/ws/superadmin` y `/ws/print-agent`; se retira la raíz del print-agent legado, que entregaba comandas sin credencial |
| 5 | `acdd35a` | `/ws/print-agent` blindado: 64 KiB por mensaje, JSON solo objeto, errores contenidos, escucha de `error` en toda conexión; `initDB` deja de sembrar el legado |
| 6 | `3ae112c` | Upgrade de panel y Superadmin contenido: un reset TCP ya no termina el proceso. Una cookie `xabor_sesion=%` tampoco (en producción lo termina con **una** petición anónima) |
| 7 | **candidato** | Sin envío a todos los sockets: un `/ws/print-agent` sin autenticar no recibe nada y un Edge recibe solo lo de su negocio, sucursal y terminal |

## 4. Qué cambia para la operación al desplegar (con el bot apagado)

- **Se cierran caídas totales del proceso** que hoy se provocan a voluntad:
  - una cookie mal codificada (sin credencial);
  - un reset TCP durante la autenticación del panel;
  - un `null` o UTF-8 inválido por WebSocket.
- **Se cierran puertas sin autenticar:**
  - `/chat` y la voz, que llegaban al modelo y a `registrarPedido`;
  - la raíz del print-agent legado;
  - la fuga de `broadcast()`: el folio entregado por un repartidor y los
    eventos de Rappi llegaban a cualquier `/ws/print-agent` sin credencial, a
    los Edge y paneles de otros negocios y a Superadmin.
- **Bot legacy de cualquier negocio con el bot encendido** (Acuña es el caso
  conocido): desde este despliegue solo vende su carta publicada de WhatsApp.
  Sin carta, la conversación pasa a una persona. El gate del predeploy bloquea
  el despliegue si un bot encendido no tiene carta.
- **Menú en imagen:** todo menú en imagen activo sale **en texto** hasta que su
  administrador lo revise en Menú › Menú automático.
- **Panel:** aparece Menú › Productos para WhatsApp (solo administrador).
- **Voz:** `/webhook/voice` deja de existir. Si algún número de Twilio aún
  apunta ahí, esa llamada falla. Es la decisión del 27-sep.
- **Edge:** no cambia. El árbol `edge/` es idéntico al de `41c003b`. Lo que
  corre en la PC de Obispado no se toca con un despliegue.

## 5. Migraciones requeridas

Las aplica **solas** el Pre-Deploy de Railway
(`scripts/predeploy-run-032-033.mjs`, arreglo `SCRIPTS`) antes de arrancar el
binario nuevo. Si una falla, Railway conserva el despliegue anterior.

| Migración | Commit | Qué hace | Reversión |
|---|---|---|---|
| `098_catalogo_whatsapp` | `e670905` | Tabla `whatsapp_productos`; la primera vez siembra la carta desde lo publicado en Tienda | `098_…_down.sql` (se pierde la selección) |
| `099_agente_turnos` | `e670905` | Traza de turnos y columnas del outbox (`enviando`, `incierto`, `humano_*`) | `099_…_down.sql` |
| `100_revision_menu_whatsapp` | `c647091` | Huellas de la carta y de las imágenes para el menú en imagen. No aprueba ningún menú | `100_…_down.sql` |

Las tres son aditivas e idempotentes, y el código de `41c003b` no lee ninguno
de sus objetos: para revertir el código no hace falta tocarlas. Los commits
4 a 7 no traen migraciones.

## 6. Configuración

- **Variables de Railway:** ninguna nueva. Sobran `ELEVENLABS_API_KEY`,
  `ELEVENLABS_VOICE_ID` y `DEEPGRAM_API_KEY`: nadie las lee, se pueden quitar
  después.
- **Para el despliegue:** nada que cambiar en la base.
- **Para el canario (no para el despliegue):**
  - `MESERO_AGENTE_MODE=true` en el proceso de Railway; sin ella, el agente no
    atiende a nadie;
  - en `configuracion` de Obispado: `mesero_agente_telefonos` (el teléfono del
    dueño, en sus dos formas 52/521), `mesero_agente_porcentaje=0`,
    `mesero_agente_shadow=false`, `bot_whatsapp_solo_prueba=true` y
    `mesero_agente_v1=true`, más `negocios.bot_whatsapp_activo=true`.

  Todas estas claves ya existen en `41c003b`: el candidato no agrega ninguna.

## 7. Estado esperado de `bot_whatsapp_activo`

- **Antes y después del despliegue: sin cambio.** Para Obispado se espera
  `false`: la atención automática está pausada desde el 25-sep
  (`docs/canario-contrato-y-liberacion.md`).
- **El despliegue no puede encenderlo.** El único código que lo escribe es
  `actualizarBotWhatsappActivoNegocio`: el interruptor del panel y de
  Superadmin, con auditoría. Ni `initDB`, ni las migraciones 098-100, ni el
  predeploy lo tocan.
- **Canario:** `true` solo junto con `bot_whatsapp_solo_prueba=true` y la lista
  de un teléfono. Así ningún bot, ni el legacy, contesta a un número fuera de
  la lista.
- No se leyó el valor de producción. El paso 0.5 lo lee y lo guarda antes de
  tocar nada.

## 8. Compatibilidad del Edge de Obispado

El candidato lleva el **Edge simple**: sus mensajes caben en 64 KiB, el mayor
es de 63,173 bytes. Aplica a toda versión publicada del Edge; solo los builds
de las ramas offline mandan lotes que no caben (`sala_lote`, `llevar_lote`).
**Qué versión está instalada en la PC de Obispado no se puede demostrar
localmente.** La comprobación de solo lectura, de un minuto, está en
`docs/ws-limite-mensajes-edge.md` («Comprobación manual antes de desplegar»).
El límite de 64 KiB no se subió: el modo offline no es parte de esta liberación.

## 9. Pruebas ejecutadas y resultados

Todas locales:
- cada ítem en su propia base desechable, copiada de la plantilla
  `test_r4_mod_tpl` del contenedor local `pg-candidato`;
- Meta, el modelo y las impresoras simulados;
- red externa bloqueada por una precarga (`bloqueo-red.mjs`) que anota todo
  intento de salir.

Ningún WhatsApp real, cobro ni papel. El mismo lote se corrió sobre la rama y
sobre la base `3ae112c`, con la suite nueva copiada.

**Estáticas**
- `node --check` de los archivos modificados: OK.
- `git diff --check`: OK.
- Barreras (`check-websocket-lista-cerrada`, con la sección 8 nueva, y
  `check-voz-retirada`): OK.
- `predeploy-check-incidentes` completo **dentro de un contexto Docker
  simulado** (el árbol con `.dockerignore` aplicado, sin `test/`, `docs/` ni
  los `.md`): exit 0.

**Suite nueva, `test/fase-print-agent-aislamiento.mjs`** (servidor real):
**rama 8/8; base `3ae112c` 3/8**. En la base, una conexión sin credencial
recibió `rappi_menu_aprobado`, `rappi_cancelacion` de una tienda ajena y el
`actualizar_estado` del repartidor. Lo mismo recibieron los Edge de A, el
panel y el Edge de B, y Superadmin. Estabilidad: 10 de 10 corridas seguidas
en verde (~9 s cada una), además de las 2 del lote y 2 sueltas.

**Mutaciones: todas muerden.**
- 10 con servidor real, cada una cae en su caso:
  - sin clase en `broadcastNegocio` → I5;
  - sin negocio → I6;
  - a todos → I1;
  - trabajo sin terminal → I5;
  - trabajo a cualquier socket → I1;
  - Superadmin sin clase → I1;
  - vuelve la copia global del repartidor → I1;
  - Rappi a todos → I1;
  - sin comparar el token → I4;
  - rutas sin sucursal → I5.
- 12 contra la barrera (sección 8).
- Los archivos se restauraron y verificaron por hash.

**Lote de 54 ítems.** Rama contra base `3ae112c`: **53 de 54 idénticos**. La
única diferencia es la suite nueva (8/8 contra 3/8). Resultados de la rama:

| Grupo | Resultado |
|---|---|
| WebSocket y Edge: aislamiento 8/8, payload 10/10, lista cerrada 13/13, upgrade 7/7, voz retirada 11/11, `/chat` retirado 12/12 | verde |
| Impresión Edge: autoservicio 44/44, self-service 56/56, print-jobs 43/43, routing 20/20, comanda Edge exclusiva 23/23, modificadores 20/20, edge-gate 40/40, edge-e2e 19/19, chaos 7/7, standalone 6/6, arranque 6/6, viaje 9/9, instalador 10/10, canje 4/4, config instalada | verde |
| Repartidor y Rappi: tiempo real 26/26, portal 12/12, Rappi catálogo y precios 15/15, permisos del operador 11/11 | verde |
| Pedidos y emisión: dedupe de `nuevo_pedido`, emisión durable y crash real, cutover 063, compra crítica, restaurante 15/15, tienda y pagos en línea, aislamiento P0 29/29 | verde |
| WhatsApp simulado y dedup: firma de Meta 25/25, continuidad del webhook 10/10, turnos agrupados 14/14, confirmación perdida, recorrido operacional, menú automático 57/57, sin carta, carta legacy 16/16, gate de carta 13/13, revisión del menú 27/27 | verde |
| `npm run test:incident` 19/19 · `mesero:tools` 66/66 · `mesero:replay` 26/26 · `test:pedido-canonico` (canónico, DB, catálogo, outbox, carta legacy) 19+34+10+25+16 | verde |
| Canario con horario **abierto** y **cerrado**: una sola respuesta ante reentrega simultánea; cliente fuera de la lista en atención manual | verde |
| `predeploy-check-incidentes` | verde |

**Fallos históricos o intermitentes** (idénticos en la base; ninguno toca lo
que cambia este candidato):

| Suite | Caso | Qué es |
|---|---|---|
| `fase-tienda-impresion-edge-e2e` | 9b | Puppeteer: «Node is either not clickable or not an Element» al pulsar en la tarjeta. Falla igual en la base |
| `fase-tienda-recuperacion-crash` | A, K5 | A: el servidor de la recuperación no levanta en 90 s en este entorno. K5: aserción sobre `agregarPedido` del panel. Iguales en la base |
| `fase-p0-aislamiento-pedidos` | — (29/29) | 1 conexión bloqueada a `api.payclip.com:443`: la guarda de red la corta, como en cada corrida |
| `fase-edge-e2e` | 9 | Intermitente: 4/20 en `3ae112c` y 2/20 en `acdd35a` (medido el 27-sep). En este lote pasó 19/19 |

## 10. Despliegue: pasos exactos (NO ejecutados)

**Paso 0: comprobaciones de solo lectura** (con autorización de Mario):

1. Git, desde `C:\xabor-agent`:
   ```powershell
   git fetch origin
   git rev-parse origin/prod/mesero-shadow-v3        # 41c003be6491698b24e39a59d344051328a54969
   git merge-base --is-ancestor origin/prod/mesero-shadow-v3 <CANDIDATO>; $LASTEXITCODE   # 0
   git log --oneline <CANDIDATO>..origin/prod/mesero-shadow-v3                             # vacío
   ```
2. Railway: el último despliegue del servicio `xabor-agent` es `SUCCESS` con
   `commitHash` `41c003b…`:
   ```powershell
   Push-Location C:\xabor-agent
   $f = "$env:TEMP\rw.json"; railway status --json 2>$null | Set-Content $f -Encoding utf8
   $d = ((Get-Content $f -Raw | ConvertFrom-Json).environments.edges.node.serviceInstances.edges | Where-Object { $_.node.serviceName -eq 'xabor-agent' }).node.latestDeployment
   "$($d.meta.branch)  $($d.meta.commitHash)  $($d.status)"
   Pop-Location
   ```
3. Edge de Obispado: la comprobación de `docs/ws-limite-mensajes-edge.md`
   debe decir **Edge simple**.
4. Carta de WhatsApp: la consulta de solo lectura de
   `docs/mesero-pedido-canonico.md` §18 (con `DATABASE_PUBLIC_URL`). Si un
   negocio con bot encendido no tiene carta, el gate detendrá el despliegue:
   hay que decidir antes, negocio por negocio, entre publicar en Tienda,
   publicar por SQL o apagar su bot.
5. Obispado: la consulta de `docs/mesero-pedido-canonico.md` §17, paso 3,
   para guardar `bot_whatsapp_activo` y las claves del canario antes de tocar
   nada.
6. Ventana fuera del servicio de Obispado, con alguien que pueda mirar la
   impresión.

**Paso 1: publicar.** Avance directo, sin `--force`:
```powershell
git -C C:\xabor-agent push origin <CANDIDATO>:refs/heads/prod/mesero-shadow-v3
```

**Paso 2: desplegar.** Esperar ~75 s y leer Railway (el comando del paso
0.2). Solo si **no** apareció un despliegue con `commitHash` = candidato:
```powershell
Push-Location C:\xabor-agent; railway redeploy --yes --from-source --json; Pop-Location
```
Nunca las dos cosas. Leer el estado cada 30 s hasta `SUCCESS`, `FAILED` o
`CRASHED`.

**Paso 3: verificar** (solo lectura):
- Railway: `SUCCESS` con el `commitHash` del candidato.
- Log del Pre-Deploy:
  - `[predeploy-098] Catálogo de WhatsApp verificado (…)`,
    `[predeploy-099] Traza de turnos y respuestas del outbox verificadas.` y
    `[predeploy-100] Revisión del menú en imagen contra la carta verificada.`;
  - `OK  todo negocio con un bot de WhatsApp encendido tiene carta publicada para WhatsApp`;
  - las líneas `OK:` de las barreras (lista cerrada con «6 recorridos de
    wss.clients», voz retirada, superficie de la carta);
  - `[predeploy-run] Todos los pasos completados.`
- Huella del build: `https://xabor.mx/app` contiene `btn-carta-whatsapp`, que
  `41c003b` no tiene. `/health` 200 no prueba nada por sí solo.
- Log de la aplicación: `[PrintAgent] Terminal autenticada — terminal=<Obispado>`
  tras el reinicio. Además, ninguna repetición de
  `[WS] conexión cerrada por un frame inválido tipo=print-agent` y ningún
  `mensaje no reconocido … tipo=solicitar_catalogo`.
- **No** probar en producción las fallas corregidas (cookie `%`, rutas
  WebSocket desconocidas, `/chat`) mientras no esté confirmado el despliegue:
  contra `41c003b` tumbarían el proceso o expondrían datos.

## 11. Pruebas desde el teléfono (Mario, después del despliegue)

**A. Con el bot apagado** (no afecta a ningún cliente):
1. `https://xabor.mx/app`: iniciar sesión. Comandas carga los pedidos del día y
   se actualiza sola (tiempo real).
2. Menú › Productos para WhatsApp: se abre y muestra lo que el bot podría
   vender en Obispado. Es la carta que hay que revisar antes del canario.
3. Impresión: el Edge de Obispado aparece conectado. «Probar impresora» saca
   una hoja de prueba; es opcional y decide Mario.
4. Escribir desde el teléfono al WhatsApp de Obispado. Si el paso 0.5 confirmó
   el bot apagado, **no** debe llegar respuesta automática, y el mensaje debe
   aparecer en Chats del panel.
5. La siguiente comanda real sale **una vez** en cocina.

**B. Canario** (solo con autorización aparte, runbook §17 pasos 3 a 6):
1. Conversación nueva desde el teléfono del canario: saludo; pedir el menú
   (sale en texto, salvo que la imagen esté revisada); un platillo con opciones
   (p. ej. dos guarniciones); modalidad; pago; resumen; **una** confirmación.
2. Comprobar un solo folio, el pedido en el panel, **una** comanda impresa en
   Obispado y el total correcto.
3. Desde un teléfono **fuera** de la lista: no debe recibir respuesta del bot.
4. Antes de abrir más: domicilio, una corrección, una cancelación y la
   derivación a una persona, con evidencia.
5. Apagado inmediato en cualquier momento: el interruptor del bot en el panel.

## 12. Criterio GO / NO-GO

**GO para desplegar**, solo si se cumplen TODAS:
1. Las pruebas de §9 en verde, salvo los fallos históricos listados (idénticos
   en la base).
2. Producción confirmada en `41c003b` (Railway) y el candidato desciende de
   ella, sin nada publicado fuera del candidato.
3. Edge de Obispado = **simple** (comprobación manual).
4. Ningún negocio con bot encendido sin carta, o una decisión tomada por
   negocio (`docs/mesero-pedido-canonico.md` §18).
5. Valores de Obispado guardados (paso 0.5), con `bot_whatsapp_activo = false`.
6. Ventana fuera de servicio y autorización explícita de Mario.

**NO-GO** si falta cualquiera. En particular:
- Edge offline, o no se sabe cuál es;
- producción en otro commit;
- una carta vacía sin decisión;
- un fallo de prueba que no esté en la lista de históricos.

Si el Pre-Deploy falla, Railway conserva el despliegue anterior: no reintentar
sin entender por qué.

**GO para el canario:**
- despliegue verificado (§10, paso 3);
- autorización del dueño y su teléfono;
- carta de Obispado revisada;
- condición del menú en imagen (`docs/mesero-pedido-canonico.md` §17);
- `MESERO_AGENTE_MODE=true`.

**Atención general:** fuera de esta liberación.

## 13. Reversión (NO ejecutada)

1. **Inmediata:** Railway › servicio `xabor-agent` › Deployments › el
   despliegue anterior (`41c003b`) › Redeploy. Las migraciones se quedan: el
   código anterior no las lee.
2. **Alinear el puntero después**, sin `--force`, en un worktree temporal:
   ```powershell
   git -C C:\xabor-agent worktree add --detach "$env:TEMP\revertir-candidato" <CANDIDATO>
   git -C "$env:TEMP\revertir-candidato" revert --no-edit 41c003b..<CANDIDATO>
   git -C "$env:TEMP\revertir-candidato" push origin HEAD:refs/heads/prod/mesero-shadow-v3
   git -C C:\xabor-agent worktree remove "$env:TEMP\revertir-candidato"
   ```
3. **Solo el bot:** el interruptor del panel. Es inmediato y no necesita
   redespliegue.
4. **Costo de volver a `41c003b`:** reabre las caídas y las puertas de §4. Es
   solo para una emergencia.

## 14. Riesgos que quedan

- **Operativos, sin resolver desde aquí:**
  - el Edge instalado en Obispado;
  - el commit real de producción;
  - la carta de los negocios con bot encendido.
- **Express 4:** cualquier `throw` dentro de una ruta async termina el proceso.
  Ya están cerradas las puertas conocidas (cookie, upgrade, WebSocket), pero
  hay más rutas async sin `.catch`.
- **Rappi:** el webhook no exige firma. Además, `Menu Approved` con `store_id`
  y `rappi_menu_rechazado` nunca llegan a su rama: la de PING los tapa.
  Ninguno de los dos se emite ya por WebSocket.
- **Sin tope de conexiones:** no hay límite de conexiones anónimas a
  `/ws/print-agent`. Cada una vive 5 s y ya no recibe nada, pero ocupa memoria
  hasta 64 KiB.
- **Nonna Maye:** la fila `print_agent_legacy_activo` sigue en producción. Su
  SQL está sin ejecutar en `docs/impresion-legacy-salida.md` y ya no la lee
  nada.
- **Pruebas intermitentes:** `fase-edge-e2e`, caso 9, falla de vez en cuando
  también en la base (§9).
