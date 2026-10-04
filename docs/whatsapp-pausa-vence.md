# Las pausas del bot por conversación vencen

**Problema (P3, 3-oct-2026).** Una pausa del bot en una conversación nunca
vencía. Puede venir de «Tomar conversación», de un traspaso del agente a una
persona o de una solicitud de persona, factura o evento. Solo la quitaba el
botón del panel o `soltar()` (`whatsappContinuidad.js`), y `soltar()` libera
únicamente tres dudas de catálogo a los 30 min. Obispado acumuló 63 pausas
activas: esos clientes no recibían respuesta cuando volvían a escribir, días
después.

**Decisiones del dueño (3-oct).**
- La pausa vence a las 12 horas sin mensajes del personal, **incluidas las que
  pone el personal**. Estas solo se encienden después de la fase 2 del panel
  (ver abajo).
- Los avisos se revisan **al entrar al sistema**, no por WhatsApp.
- Todo nace apagado, por bandera y por negocio.

## Banderas (tabla `configuracion`, por negocio, nacen apagadas)

| Clave | Valor | Efecto |
|---|---|---|
| `whatsapp_pausa_vence_horas` | número | Enciende el vencimiento. Vacío, 0, negativo o inválido = apagado. Si vale menos de 6, se sube a 6: por debajo, el agente retomaría un carrito viejo (`HORAS_PARA_REABRIR`). |
| `whatsapp_pausa_vence_simular` | `'true'` | Solo registra en la bitácora (y en el log `[PAUSA-VENCE]`) lo que liberaría. No toca ninguna pausa. |
| `whatsapp_pausa_vence_manuales` | `'true'` | También vencen las pausas que puso una persona o cuyo origen se desconoce. **No encender antes de la fase 2 del panel.** |
| `whatsapp_pausa_vence_sin_atender` | `'true'` | También vencen las peticiones de persona que nadie del equipo contestó. Revierte una decisión escrita en `whatsappContinuidad.js`, así que va apagada salvo visto bueno. |
| `whatsapp_pausa_vence_aviso_whatsapp` | `'true'` | Además, manda UN resumen por WhatsApp al encargado (`wa_admin_numero`) por negocio y corrida, con los últimos 4 dígitos del teléfono. Apagada por la decisión del dueño de revisar al entrar al sistema. |

No hay pantalla para ponerlas: van por SQL o por `PUT /api/config`. Para
apagarlas se borra la clave:
`DELETE FROM configuracion WHERE negocio_id=… AND clave LIKE 'whatsapp_pausa_vence_%'`.

## La regla

El job corre cada 5 minutos (en `server.js`, `services/vencimientoPausasWhatsapp.js`)
y solo en los negocios con la bandera. Una pausa vuelve al bot solo si se
cumple TODO lo siguiente (`services/pausaVencePolitica.js`, con una prueba por
cada guarda):

- **Interruptor maestro.** El bot del negocio está encendido.
- **Origen.** La pausa es **automática**: hay una revisión del sistema y nadie
  la tomó. Si es manual, huérfana o de origen desconocido, solo vence con
  `…_manuales` encendida.
- **Motivo.** El motivo de la revisión está en la lista cerrada que vence.
  - Nunca vencen los de dinero o efecto incierto (`AGENTE_ESTADO_INCIERTO`,
    `COMPROBANTE_PAGO`, `EJECUCION_*`, `REENTREGA_LEGADA`, `PAGO_*`, …), ni
    un motivo desconocido.
  - Los tres de `soltar()` siguen siendo suyos, salvo que el negocio lo haya
    apagado (`bot_revision_minutos` <= 0).
- **Peticiones de persona.** Si la pausa nació de una petición de persona,
  alguien del equipo tuvo que escribir después de la revisión, salvo con
  `…_sin_atender` encendida. Cuentan como petición los motivos `SOLICITUD_*`,
  `AGENTE_PIDE_HUMANO`, `FACTURACION_*` y `CATERING_*`. También los tres del
  rescate, porque al cliente se le prometió una persona:
  - `FORMULARIO_NO_CARGA`
  - `AGENTE_FALLO_REPETIDO`
  - `AGENTE_NO_PUDO_ATENDER` (el turno que reventó)
- **Fallas del sistema.** Vencen sin que nadie escriba:
  `AGENTE_RESPUESTA_NO_ENTREGADA`, `AGENTE_RESPUESTA_VENCIDA`,
  `RESPUESTA_TRUNCADA`, `SALIDA_INTERNA_NO_PUBLICABLE` y `SIN_CARTA_WHATSAPP`.
- **Dinero y efectos sin conciliar.** Se mira lo que guardó el agente, no solo
  el motivo de la revisión. No vence si ocurre cualquiera de estas cosas:
  - El estado del agente tiene `confirmacionIncierta`.
  - **El libro de operaciones tiene una `confirmar_pedido` en `pendiente` o
    `error` de esta conversación.** Cuenta si es del ciclo vigente del agente
    (sea cual sea su fecha) o de cualquier ciclo del teléfono desde 30 min
    antes de la pausa. La marca del estado se pierde si el commit del turno
    falla, que es justo el caso de `AGENTE_NO_PUDO_ATENDER`. La reserva del
    libro, en cambio, es durable y ocurre antes del efecto. Reiniciar el agente
    con identidad nueva saltaría su índice único y su conciliación.
  - Su último traspaso, el outbox (`humano_motivo` o un `handoff`) o la traza
    del turno (`motivo_handoff`) anotaron un motivo de dinero o incierto. En
    texto libre basta una palabra de dinero (pago, cobro, transferencia,
    transfirió, cargo, efectivo, cambio, voucher, ticket, reembolso, SPEI, OXXO…).
    La lista es ancha a propósito: un «cambio en su pedido» también retiene.
  - Hay un pedido de ese cliente esperando el pago con enlace, en
    `pedidos_activos` o en `pedidos_programados` (`datos.estado='pendiente_pago'`,
    `activado = FALSE`). Cuenta tanto `cliente.telefono` como
    `telefono_conversacion`.
- **Nadie está atendiendo ahora.** No hay un takeover vigente de la Business
  App ni un turno en curso. Sin revisión, tampoco puede haber un lote
  pendiente.
- **El cliente no está esperando.** Su último mensaje no puede estar esperando
  respuesta de una persona dentro de la ventana de 24 h de Meta. Ese último
  mensaje incluye audios y stickers, que solo existen en `whatsapp_entradas`.
  Se compara contra el último mensaje del **personal**, no contra el recibo del
  bot.
- **Tiempo.** Pasaron N horas desde lo último del personal. Cuenta el inicio de
  la pausa o de la revisión, y el último mensaje del personal: panel,
  documento, eco de la Business App o `last_business_app_message_at`.

Todas las edades se calculan en SQL con `now()`, porque `mensajes.timestamp`
no tiene zona.

## Al liberar

Todo ocurre en una transacción:

- **Candado.** Toma el candado `wa:<negocio>:<teléfono>`, el mismo de la
  continuidad y del botón.
- **Filas bloqueadas.** Bloquea con `FOR UPDATE` la fila de
  `conversaciones_control` y la de `whatsapp_conversaciones`. Así un mensaje
  que llegue en ese momento (`recibir`) espera y no se marca `revisado`, y un
  «Tomar» espera y gana después.
- **Datos frescos.** Relee la conversación, compara la huella y vuelve a
  decidir con los datos nuevos.
- **Fila de control.** El `UPDATE` de `conversaciones_control` va condicionado
  a la identidad leída (`updated_at`). Si no había fila (revisión sin pausa) y
  ahora existe, alguien la tomó: no se toca nada.
- **Misma semántica que «Revisé y atendí».**
  - Las entradas en revisión o pendientes pasan a `revisado`.
  - Se quita la revisión y su número sube en 1.
  - Se borra la sesión legada.
  - El agente se reinicia como `agente:<tel>:r<rev>`.
  - Por último, `bot_pausado=false`.
- **Registro y aviso.** Escribe una fila en `conversaciones_pausa_vencimientos`
  (migración 113) y manda el evento WS `bot_pausado`.

Como mucho libera 50 conversaciones por corrida.

**Dónde se ve.** Lo durable es la bitácora 113. `/estado-bot` entrega
`pausaVence` (las banderas) y `ultimoVencimiento` (la última liberación), pero
el panel de hoy todavía no los pinta (fase 2). El resumen por WhatsApp es
opcional. Su columna `aviso` vale `aceptado` cuando Meta aceptó el envío, lo
que **no** prueba que llegó: fuera de la ventana de 24 h el rechazo llega
después, por el webhook de estados. Vale `no_aplica` en simulación o con el
resumen apagado.

## Rendimiento: índices propuestos (NO aplicados)

Se midió con `EXPLAIN (ANALYZE, BUFFERS)` en una base desechable con unas 10
veces el volumen estimado de un negocio grande: 30 000 conversaciones, 500 000
entradas, 1 000 000 de mensajes, 300 000 filas de outbox, 200 000 turnos y
200 000 operaciones del libro.

| Consulta | Sin índices nuevos | Con los 5 índices |
|---|---|---|
| Relectura dentro de la transacción (con candados tomados) | 175–218 ms | 7–10 ms |
| Corrida global (1 000 candidatas, `LIMIT 500`) | 65,5 s | 5,0 s |

En la relectura, el costo está en `whatsapp_entradas` por negocio (123 ms) y en
el outbox (76 ms). En la corrida global, el costo está en la búsqueda de
motivos del agente en el outbox y en los turnos, que hoy recorre todo el
negocio por cada candidata (63 ms × 1 000).

Con el volumen actual de Obispado, que es unas 10 veces menor, la corrida
global debería rondar unos cientos de milisegundos. Aun así, crece con el
outbox. **Antes de encender la bandera en un negocio grande** hay que crear
estos índices en producción. Son aditivos y van con
`CONCURRENTLY`: no bloquean escrituras y no pueden ir dentro de una
transacción, así que tampoco caben en el runner del predeploy.

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_whatsapp_entradas_conversacion_recibido
  ON whatsapp_entradas (negocio_id, telefono, recibido_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agente_outbox_traspasos
  ON agente_outbox (negocio_id, created_at)
  WHERE humano_motivo IS NOT NULL OR tipo = 'handoff';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agente_turnos_traspasos
  ON agente_turnos (negocio_id, created_at)
  WHERE motivo_handoff IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agente_operaciones_confirmacion_abierta
  ON agente_operaciones (negocio_id, conversacion_id)
  WHERE herramienta = 'confirmar_pedido' AND estado IN ('pendiente', 'error');
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pedidos_activos_pendiente_pago
  ON pedidos_activos (negocio_id)
  WHERE estado = 'pendiente_pago';
```

Si un `CONCURRENTLY` falla, deja un índice `INVALID`. Se borra con
`DROP INDEX CONCURRENTLY` y se repite. Si la corrida global sigue pesando
después, el siguiente paso es dividir la lectura en dos fases: primero los
hechos baratos para todas las candidatas y después la evidencia del agente
solo para las que pasan. Hoy no hace falta.

## Encendido sugerido

1. Crear los índices de arriba en producción.
2. Poner `whatsapp_pausa_vence_horas = 12` y `whatsapp_pausa_vence_simular = true`.
3. Un día después, revisar la bitácora:
   `SELECT origen_pausa, motivo_revision, motivo_agente, round(horas_sin_personal) h, telefono FROM conversaciones_pausa_vencimientos WHERE negocio_id=… AND modo='simulado' ORDER BY created_at;`
4. Si está bien, poner `whatsapp_pausa_vence_simular = false`.
5. Las manuales, solo después de la fase 2 del panel.

## Fase 2 (archivos protegidos, requiere aprobación)

1. **`panel/index.html`, `actualizarBotonBot`.** La tarjeta del chat dice
   «Estás atendiendo esta conversación. **Pausa manual: no vence
   automáticamente.**», también en las pausas huérfanas. Con `…_manuales`
   encendida, esa frase sería falsa. El panel debería usar `pausaVence` y
   `ultimoVencimiento`, con textos como «Vuelve al bot si nadie del equipo
   escribe en N h» y «El bot retomó esta conversación a las HH:MM: la pausa
   venció». Esto mismo es el aviso «al entrar al sistema» que pidió el dueño:
   - una lista en Chats de lo que el bot retomó desde la última visita,
     leída de la bitácora 113, con una ruta nueva de solo lectura;
   - agregar a `MOTIVOS_REVISION_TEXTO` los motivos `AGENTE_PIDE_HUMANO`,
     `SOLICITUD_*`, `FACTURACION_*`, `FORMULARIO_NO_CARGA` y
     `AGENTE_FALLO_REPETIDO`.
2. **La bandeja de Chats** no se refresca con el evento `bot_pausado`: sigue
   mostrando «⚠ Requiere revisión» hasta recargar.
3. **`whatsapp-meta.js`:284.** El aviso al encargado («usen Revisé y
   atendí…») no menciona el vencimiento.
4. **El reinicio del agente está copiado** de `/reactivar` (server.js) al job.
   Extraerlo a una función común toca esa ruta, que no está protegida pero es
   crítica.

## Decisiones pendientes del dueño

1. **Pausas permanentes para números internos.** `clientes.es_interno` no
   detiene al bot. Hoy, la única forma de que el bot no le conteste a un
   proveedor, a un empleado o al número del encargado es una pausa manual. Con
   `…_manuales` encendida, esas pausas vencerían cada 12 h y el bot le
   contestaría a esa gente. Las opciones son:
   - (a) que el vencimiento nunca toque a un `es_interno = true`, un cambio de
     una línea en la consulta;
   - (b) una pausa «permanente», con columna nueva y opción en el panel
     (fase 2);
   - (c) una lista de números en `configuracion`.

   Mientras `…_manuales` siga apagada no hay riesgo, porque esas pausas son
   manuales.
2. **Peticiones de persona nunca contestadas.** ¿Encender `…_sin_atender`?
   Desde esta revisión aplica también al rescate (`FORMULARIO_NO_CARGA`,
   `AGENTE_FALLO_REPETIDO`) y al turno que reventó (`AGENTE_NO_PUDO_ATENDER`).
   Sin ella, esas conversaciones siguen en pausa hasta que alguien conteste.
3. **La ventana de 24 h.** Si el último mensaje del cliente no tiene respuesta
   del equipo, la pausa no vence hasta 24 h después de ese mensaje. En la
   práctica, una conversación que nadie contestó vence a las 24 h, no a las
   12. ¿Se mantiene?
4. **Listas de motivos.** Hay que confirmar tres cosas:
   - qué cuenta como petición (incluí `CATERING_*` y `AGENTE_HANDOFF_PENDIENTE`);
   - que `SIN_CARTA_WHATSAPP` vence como falla del sistema;
   - que una palabra de dinero en texto libre retiene para siempre, aunque sea
     un falso positivo («cambio de dirección» no retiene; «un cambio» sí).
5. **Un «Tomar» viejo vuelve manuales para siempre las pausas siguientes.** Ni
   el job ni `soltar()` dejan auditoría de devolución, así que la última acción
   registrada sigue siendo «tomar_conversacion». Es un fallo cerrado, pero con
   las manuales apagadas el cliente queda pausado. Arreglarlo exige que el job
   escriba una acción propia o que se ignore una toma anterior a la pausa
   vigente. ¿Cuál?
6. **Otras herramientas con efecto externo.** Solo `confirmar_pedido` retiene
   en el libro. Una `registrar_solicitud_evento` en `pendiente` o `error`
   podría duplicar la solicitud tras el reinicio. El daño es bajo, pero ¿se
   agrega?
7. **Alcance real de la fase 1.** Con las manuales apagadas, la mayoría de las
   63 pausas no vence: según el mapa, solo unas 20 tienen `updated_by` NULL. Lo
   que sí vence suele hacerlo a las 24 h del último mensaje del cliente. La
   decisión «12 h, incluidas las manuales» se cumple con la fase 2.
8. **El número de migración 113** puede chocar con otras ramas en curso.
9. **Antes de encender**, Mario puede correr esta consulta de solo lectura en
   producción:
   ```sql
   SELECT cc.updated_by IS NULL AS sin_usuario, w.requiere_revision, w.motivo, count(*),
          min(COALESCE(cc.updated_at, w.actualizado_at)), max(COALESCE(cc.updated_at, w.actualizado_at))
     FROM conversaciones_control cc
     FULL JOIN whatsapp_conversaciones w USING (negocio_id, telefono)
    WHERE COALESCE(cc.negocio_id, w.negocio_id) = '<obispado>'
      AND (cc.bot_pausado OR w.requiere_revision)
    GROUP BY 1, 2, 3
    ORDER BY 4 DESC;
   ```
