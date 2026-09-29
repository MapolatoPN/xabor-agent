# Horarios de medianoche — 29 septiembre 2026

## Incidente y autorización

El dueño guardó lunes 04:30–00:00 y martes 07:30–00:45. Su saludo posterior
seguía recibiendo «cerrado». La configuración sí estaba persistida; el código
exigía apertura <= hora < cierre sin representar el cambio de día. Una prueba
contra el evaluador anterior falló incluso el lunes a las 04:30.
El dueño autorizó «corrije y despleiga».

Base productiva comprobada: `afea8b0204880750ffe64dd3e2c7f3d6af8a2eff`.
Rama de corrección: `fix/horarios-medianoche-20260929`, worktree propio de Codex.

## Corrección y riesgo revisado

- `horarioSemanal.js`: evaluador puro común. Cada jornada pertenece al día
  de apertura; si cierre < apertura, termina al día siguiente. 00:00 y 24:00
  funcionan como final de jornada. El cierre exacto es excluyente.
- Un día semanal desmarcado impide iniciar una jornada nueva, sin cancelar
  el resto de la noche anterior. Un cierre especial de fecha completa sí
  bloquea también ese resto. Los cierres anticipados nunca amplían servicio.
- Horarios inválidos o iguales no se convierten en 24 horas. Para servicio
  completo explícito se conserva 00:00–24:00.
- El Mesero y la Tienda, incluidos sus validadores de pedidos programados,
  consumen la misma decisión. La Tienda carga las excepciones existentes y
  comunica el cierre efectivo; se conserva la zona horaria del negocio.
- No cambia interpretación de promociones, precios, cobros, anticipación de
  programados, scheduler, emisión ni impresión. No hay migración nueva.
- No se modifican componentes protegidos, panel ni configuración productiva.
  Es una corrección compartida de horarios, no una excepción de pruebas ni una
  apertura forzada. El martes antes de 07:30 sigue cerrado tras terminar el lunes.

## Evidencia

- `scripts/check-horarios-medianoche.mjs`: **61 escenarios**, código productivo
  de Mesero, canal, Tienda y validadores; incluye el saludo real de las 22:20,
  medianoche, 00:45, cierre exacto, reapertura, cierres especiales, horarios
  inválidos, cambio de semana/año y ambas 01:30 del cambio de horario fronterizo.
  Integrado en `predeploy-check-incidentes`.
- `test/fase-horario-medianoche-db.mjs`: Postgres local desechable, lectura y
  guardado reales; cerrado → medianoche → nocturno → cerrado → cierre especial,
  SIN reiniciar. Cero pedidos y cero envíos; outbox no despachado.
  Una primera aserción esperaba llamada al modelo con «Hola»; se ajustó porque
  el saludo retoma correctamente el borrador de forma determinista.
- Fuera de horario **12/12**, programados **56/56**, zona horaria **25/25**.
- Continuidad determinista OK, canónico **19/19**, herramientas **66/66**,
  replay **26/26**.
- Gate obligatorio dentro de imagen Docker Node 20, sin red: **OK**.
- Pruebas locales con `test/red-solo-local.mjs`; no proveedores reales.
- Gates productivos de datos **12/12** y financiero **OK**, en solo lectura.
- `git diff --check`: OK. Revisión local del diff, no auditoría independiente.

## Configuración preservada

Lectura previa en transacción `READ ONLY`, cerrada con `ROLLBACK`:
Obispado solo prueba, porcentaje 0, teléfono del dueño en formatos 52 y 521,
ambas banderas interactivas activas; Acuña apagado. Se conservan íntegros
`reglas_atencion` y `timezone=America/Matamoros`, sin cambiar horarios.

Huella SHA-256 previa de esas nueve filas (clave, valor, updated_at), ordenadas:
`a3b91e1b7a0e9fe51382601e1cf9a762b53206d0fb85feac1da1d912234e1676`.
Sirve para verificar después del despliegue que ninguna cambió.

## Publicación

Publicado `54384d26457a0fc40ea4aff703132e4b75654cc4` mediante fast-forward de
`prod/mesero-shadow-v3`, desde la base comprobada. Incluye también el commit
de documentación `5f469ea` del despliegue anterior, sin cambios funcionales.

Railway: **SUCCESS**, deployment `a43107be-477f-4a1b-9ed2-8e244c46f2e4`,
servicio `xabor-agent`, proyecto `honest-tenderness`, entorno `production`.
El `commitHash` coincide exactamente. Tras comprobar que el push no inició
build, se solicitó una sola vez `redeploy --from-source`, con identificadores
explícitos. No se subió el checkout raíz ni se modificaron variables.

Logs: gate financiero OK; barrera de datos 12/12; «Todos los pasos completados».
HTTP `/health`: **200** después de SUCCESS. No se usó health como prueba de SHA.

La lectura posterior `READ ONLY` finalizada en `ROLLBACK` produjo la MISMA
huella de configuración indicada arriba. Acuña sigue apagado; Obispado conserva
el canario restringido. Sin migraciones nuevas ni reinicio de conversación.

Con el evaluador corregido y las reglas leídas de producción (sin ejecutar
efectos): el saludo del lunes a las 22:20 resulta abierto. A las 10:16:35 UTC
de la comprobación, eran las 05:16 del martes en America/Matamoros, por lo que
resulta cerrado/antes de apertura hasta las 07:30: la corrección no fuerza abrir.

No se envió un mensaje real, cobro ni impresión para verificar el despliegue.
Esto no certifica todos los flujos del bot. Esta constancia queda en un commit
local de documentación, sin otro push ni despliegue.
