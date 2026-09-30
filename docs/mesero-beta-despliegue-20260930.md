# Despliegue beta y Node 22 — 30 septiembre 2026

Autorización del dueño: «despliega». Este reporte actualiza el estado local
descrito en `mesero-node22-20260930.md` y no autoriza ampliar el piloto.

## Producción verificada

- Commit activo: `833585dc5ae33f3319e7b12c428297062fb5ec87`.
- Railway: `be78585c-49e1-4eda-b320-d0f644415fcf`, **SUCCESS**.
- `/health`: HTTP 200, `status=ok`, `listo=true`, comprobado después del
  despliegue. La identidad del build se verificó también en Railway.
- Runtime consultado dentro del servicio: **Node 22.23.3** y
  **Puppeteer 25.12.0**.
- Logs del predeploy: barrera de datos, gate financiero y runner completados.

## Integración y publicación simultánea

El candidato `ea63e5b` integra las correcciones de continuidad de la beta,
el endurecimiento de archivos/dependencias y Node 22 sobre producción
`0ccbdea`. Se comprobó que conservaba exactamente los cinco archivos de la
tienda v2 incorporados por esa base. Se publicó por fast-forward, sin force.

Railway no inició automáticamente el despliegue observado, por lo que se
ejecutó `redeploy --from-source` explícito. Nuestro deployment fue
`c0c1e9bb-998a-4d42-8ce4-44059b837f66`.

Coincidió con una publicación independiente de la tienda web por otra sesión:
`82a45b90-088b-4f31-be97-a94daa2fe742`, cuyo mensaje CLI identificaba `5a480d0`.
Posteriormente producción avanzó a `833585d`: su padre es exactamente
`ea63e5b` y su único cambio adicional es `panel/tienda.html` (tienda web).
Se verificaron la ascendencia, el diff y el SHA remoto. El deployment final
conserva ambos trabajos; los dos anteriores aparecen como REMOVED. No se
canceló trabajo ajeno ni se hizo otra publicación para sobrescribirlo.

## Pruebas del candidato integrado

En Docker Node 22, con Meta/modelos simulados y PostgreSQL local desechable:

- `npm run test:incident`: verde, incluido canónico 19/19.
- `npm run mesero:tools`: 66/66; `mesero:replay`: 26/26, cero invariantes críticas.
- `fase-tienda-diseno-v2.mjs`: 11/11 sobre el candidato `ea63e5b`.
- `test:runtime` y `test:archivos`: verdes, incluido PDF real.
- `fase-beta-hibrida-db.mjs`: 11/11.
- `fase-flows-webhook.mjs --carrito`: verde; categorías, tacos, mixtos,
  observaciones, bajas múltiples, cantidades, deshacer, reinicio, dos procesos
  y exactamente una confirmación de un pedido sintético local.
- Gate de incidentes en la imagen sin montar código fuente: verde.
- `npm audit --omit=dev`: cero vulnerabilidades reportadas en la imagen.
- `npm run test:incident` repetido sobre el código final `833585d` en el
  mismo runtime aislado: verde; canónico 19/19.

La batería completa previa de Node 22 está en `mesero-node22-20260930.md`.
Estas pruebas no equivalen a una conversación real en el teléfono.

## Configuración preservada y siguiente prueba

Inspección remota de solo lectura antes y después: valores sin cambios.
`bot_whatsapp_solo_prueba=true`, porcentaje general del agente `0` y beta
limitada al teléfono del dueño terminado en **9919**, con su alias 52/521 en
las listas del agente y Flows. Su conversación no está pausada. El maestro
está activo, pero no se abrió la atención automática general.

No se ampliaron listas, no se enviaron mensajes de prueba, no se cambiaron
tarifas/zonas/horarios y no se publicaron nuevos assets de Meta. El catálogo
nativo continúa apagado; su validación real con Meta permanece pendiente.
No hay migraciones nuevas propias de esta actualización; se ejecutó el
runner existente del despliegue.

Siguiente paso: prueba del dueño en el mismo teléfono. No afirmar que el
recorrido real está certificado antes de revisar esa conversación.

`STATUS_CODEX: DESPLEGADO_PILOTO_SOLO_DUENO_ESPERANDO_PRUEBA_REAL`
