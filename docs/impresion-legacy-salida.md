# La salida del camino de impresión legado

> **RETIRADO el 27-sep-2026.** La raíz WebSocket `/` ya no existe: el upgrade es
> una lista cerrada (`/ws/panel`, `/ws/superadmin`, `/ws/print-agent`) y
> cualquier otra ruta recibe 404 antes de consultar la base. Evidencia (lectura
> de producción): Mapolato Obispado imprime por Edge autenticado (1,082 trabajos
> confirmados en 7 días), la cola `impresion_legacy_emitida` nunca tuvo filas y
> en los 20 despliegues conservados no hubo ni una línea «Conexión legado».
> Se borraron `resolverNegocioLegacyUnico`, `reclamarTrabajosLegacyPendientes`,
> `devolverTrabajoLegacyAPendiente` y `fase-impresion-legacy-aislada.mjs`; sus
> garantías vigentes las cubre `test/fase-websocket-lista-cerrada.mjs` y las
> vigila `scripts/check-websocket-lista-cerrada.mjs`. El MODO de impresión
> `legacy` de `printRouter` sigue (solo cuando Edge no se hace cargo de un negocio
> con `print_agent_legacy_activo = 'true'`), pero ya no tiene destino: el trabajo
> queda `pendiente` en `impresion_legacy_emitida`. Lo de abajo es historia.

> **La bandera ya no se siembra (27-sep-2026, segunda vuelta).** `initDB()`
> insertaba `print_agent_legacy_activo = 'true'` para `nonna-maye` en cada
> arranque, con `ON CONFLICT DO NOTHING`: si alguien borraba la fila, el
> siguiente arranque la devolvía. Ya no lo hace, y
> `scripts/check-websocket-lista-cerrada.mjs` falla si esa siembra vuelve, sea en
> `src/`, en una migración o en un script de predeploy. Una base que ya tenga la
> fila la conserva. Retirarla es una decisión aparte, con autorización
> explícita del dueño, y este es el SQL (NO se ha ejecutado en ninguna base
> externa):
>
> ```sql
> BEGIN;
> -- Antes: debe salir exactamente una fila (nonna-maye | true).
> SELECT n.slug, c.valor FROM configuracion c JOIN negocios n ON n.id = c.negocio_id
>  WHERE c.clave = 'print_agent_legacy_activo';
> DELETE FROM configuracion
>  WHERE clave = 'print_agent_legacy_activo'
>    AND valor = 'true'
>    AND negocio_id = (SELECT id FROM negocios WHERE slug = 'nonna-maye');
> -- Debe responder DELETE 1. Después: cero filas con la bandera.
> SELECT count(*) FROM configuracion WHERE clave = 'print_agent_legacy_activo';
> COMMIT;  -- ROLLBACK si algo no cuadra
> ```
>
> Sin la fila, `resolverModoImpresion` devuelve `configuracion_ausente` para
> Nonna Maye, que es el mismo estado que Mapolato Obispado, el negocio que
> imprime por Edge. No toca negocios, terminales, trabajos ni
> `impresion_legacy_emitida`.

## Historia (hasta el 27-sep-2026)

Todo lo que sigue es pasado. Se conserva para entender por qué existen
`impresion_legacy_emitida` y el modo `legacy` de `printRouter`.

- **Qué era.** El print-agent anterior a Xabor Edge se conectaba a la raíz `/`
  del WebSocket sin ninguna identidad (ni credencial, ni cabecera, ni query) e
  imprimía todo lo que le llegaba, sin deduplicar.
- **Primera auditoría (septiembre de 2026).** Con solo el repositorio a la
  vista, se concluyó que `/` no podía retirarse todavía: `initDB()` sembraba
  `print_agent_legacy_activo = 'true'` para `nonna-maye` e
  `installer/windows/README.md` lo declaraba pendiente de migrar. Mientras
  tanto se acotó la ruta:
  - la conexión quedaba asignada al único negocio legado, con 403 si había
    cero o más de uno;
  - al reconectar recibía solo sus pendientes, con un `printJobId`
    determinista;
  - `destinatarios = 0` dejó de contar como impreso: el trabajo quedaba
    `pendiente` en `impresion_legacy_emitida` (migración 053);
  - se borró el volcado global `obtenerTodosPedidosParaWebSocketLegacy`.

  El agente viejo nunca mandó acuse de recibo: «entregado» nunca significó
  «salió el papel».
- **Retiro (27-sep-2026).** La lectura de producción de arriba mostró que nadie
  usaba el legado. `81b1494` cerró el upgrade en una lista cerrada y borró la
  resolución y la entrega del legado; `acdd35a` quitó la siembra de la bandera.
- **Pruebas.** `test/fase-impresion-legacy-aislada.mjs`, que fijaba el
  comportamiento acotado, se borró con el retiro. Lo vigente lo cubren
  `test/fase-websocket-lista-cerrada.mjs` y
  `scripts/check-websocket-lista-cerrada.mjs`.
