# Botones: despliegue y canario — 28 sep 2026

## Resultado

Publicado **e7ad0e40a140b9fd6a586235300e18a2039e3645** sobre `ab37545`, mediante
fast-forward de `prod/mesero-shadow-v3`. El dueño autorizó continuar con la
revisión, despliegue y canario limitado en esta conversación.

Railway confirmó **SUCCESS** para el deployment
`6c73d1ce-ee78-4a94-9c4c-ce0b0a677c0c`, creado a las 23:52:24 UTC.
Servicio `xabor-agent`, entorno `production`, proyecto `honest-tenderness`.
La identidad se verificó con el `commitHash` de Railway, no solo con `/health`.
`/health` respondió HTTP 200 antes y después de activar el canario.

El push no generó deployment durante las comprobaciones. Se ejecutó una sola
vez `railway redeploy --yes --from-source`, con proyecto, entorno y servicio
explícitos, después de comprobar el SHA remoto. No se subió el checkout principal
ni se usó `railway up` desde un worktree.

## Revisión previa

- Base remota y build productivo: ambos `ab37545`; no había avance adicional.
- Revisión del diff de transporte, asociación/reserva de botones, cierre y
  persistencia, reconciliador y migraciones. Sin hallazgos bloqueantes en esta
  revisión local; no se presenta como auditoría independiente.
- Panel, caja, `orderManager.js`, `database.js`, `restauranteService.js`, Edge e
  instalador sin diferencias respecto de la base. Conservadas 101 y 102.
- Riesgo principal: botones accionan el pedido real. Se exige asociación durable,
  contexto/identidad vigente, reserva, barreras de atención y catálogo actual;
  la activación queda limitada a un teléfono. Un cierre confirmado sí puede
  generar pedido, pago o impresión mediante los mecanismos normales.
- Repetido el gate obligatorio dentro de la imagen local, sin red: OK.
- Gate de datos productivos antes de publicar: **12/12**, con conexiones de solo
  lectura. Obispado y Acuña tenían el corte maestro apagado.
- Carta publicada de Obispado: 76 productos, 12 categorías. Mixtos: $205 base;
  Salsa, Proteína y Guarniciones admiten cada uno de 1 a 2 elecciones. No se
  modificaron catálogo, precios ni cardinalidades.
- Integración WhatsApp activa, número registrado y aplicación suscrita según
  los registros existentes. No se hizo una nueva verificación empresarial en Meta.

La batería previa y las correcciones están en
[la integración validada](botones-integracion-vigente-20260928.md): canónico DB
34/34, herramientas 66/66, replay 26/26, E2E mixtos y licuado, persistencia,
outbox, canario abierto/cerrado y regresiones de caja/cancelaciones.

## Despliegue

Se añadió únicamente `WHATSAPP_INTERACTIVOS=true` al servicio de Railway con
`skipDeploys=true`; se aplicó en el deployment del commit indicado. Las demás
variables no se cambiaron. `MESERO_AGENTE_MODE=true` ya existía.

El runner normal aplicó las migraciones 103/104; las tablas de preguntas y
botones y la columna `datos` se verificaron posteriormente en solo lectura.
Los logs del deployment registraron que todos los pasos del predeploy,
incluidos el gate financiero y el gate de datos, terminaron correctamente.
No se ejecutaron migraciones productivas a mano desde esta máquina.

## Activación auditada

Después de SUCCESS se hizo un preflight READ ONLY terminado en ROLLBACK y luego
una transacción acotada exclusivamente a Mapolato Obispado. Exigió que la
configuración previa no hubiera cambiado, el bot siguiera apagado, existieran
103/104 y no hubiera revisión humana, takeover, entradas en curso ni outbox
pendiente/incierto para el teléfono de prueba.

Estado posterior:

```text
bot_whatsapp_activo=true
bot_whatsapp_solo_prueba=true
mesero_agente_v1=true
mesero_agente_porcentaje=0
mesero_agente_shadow=false
mesero_agente_telefonos=528787899919,5218787899919
whatsapp_interactivos_v1=true
whatsapp_interactivos_elecciones_v1=true
```

Las dos formas representan el mismo teléfono. La barrera de prueba impide
atender automáticamente a los demás clientes, incluso mediante el motor legacy.
Se comprobaron las dos formas admitidas y tres números ajenos rechazados con
las funciones de alcance del mismo commit, sin enviar mensajes.

Auditoría en `auditoria_plataforma`:
`b5c704ee-ffc1-435b-b803-eb9328900e8d`, 23:53:56 UTC,
acción `activar_canario_botones_whatsapp`. Conserva valores anteriores/nuevos,
commit y contexto que identifica a Codex ejecutando la autorización de Mario;
actor autorizado: Mario (`mario@xabor.mx`). Configuración, corte maestro y
auditoría se comprometieron juntos. No se cambió ningún otro negocio.

Verificación posterior de solo lectura: gate **12/12**, Acuña apagado, solo
Obispado con botones habilitados y ningún envío/entrada pendiente del teléfono
de prueba en esa lectura. No se quitaron pausas ni revisión humana.

## Prueba pendiente desde el teléfono

No se enviaron mensajes de prueba, pedidos, pagos ni impresiones. Tampoco se
reinició o borró el historial. El borrador previo seguía sin folio, sin hechos
terminales y sin efecto incierto, revisión 199; llevaba más de diez horas sin
actividad. La regla existente caduca esos borradores al siguiente texto.

Escribir «Quiero unos chilaquiles mixtos», elegir Roja y después Verde y
terminar con «Listo con estas». Algunas selecciones aparecen como lista
«Elegir opción» en vez de botones individuales por el número/largo de opciones.
Comprobar luego proteína y guarniciones. **No pulsar Confirmar en esta primera
prueba visual**: no es una simulación y podría crear una comanda real.

La visualización y aceptación por Meta real se acreditan con esa prueba; no se
declaran verificadas por las pruebas con mocks ni por encender las banderas.

El Edge físico de caja sigue sin comprobarse. Esta entrega no cambia el
protocolo ni el límite WebSocket que ya corría en `ab37545`; no certifica nuevas
funciones offline ni sustituye aquella comprobación.

Si aparece un fallo, pausar el bot desde el interruptor auditado y conservar
hora, texto, wamids y estado. Para retirar botones usar los interruptores sin
borrar tablas ni desplegar un binario que desconozca los grupos abiertos.

Esta constancia se guarda en un commit documental local posterior al deploy;
no se hace otro push a producción solo para publicar este reporte.
