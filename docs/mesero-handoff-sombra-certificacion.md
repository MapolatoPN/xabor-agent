# Handoff del Mesero en sombra — certificación local

## Alcance y base

Continuación del trabajo detenido de Claude sobre `6372e42` en
`feat/mesero-post-shadow-v3`. Los cuatro archivos que dejó se conservaron y
se completaron en `feat/mesero-handoff-sombra-certificado`.

La base original era `17fc153`. BASE_A de esta continuación, confirmada por
Git remoto y Railway SUCCESS: `f9b8e1478423df8ccdfd33a361944ef271812f98`.
El delta son únicamente precuenta, render térmico y sus pruebas; no se
solapa con Mesero/WhatsApp. Se incorpora al candidato local para certificar
contra producción actual. Este trabajo no autoriza push, deploy ni activar
flags productivos.

## Frontera real auditada

`src/channels/whatsapp-meta.js`, `procesarConClaude`: el resultado del
cerebro aporta `resultado.orden`. Justo antes de entregarla se realizan:

1. `orden.canal = 'whatsapp'`.
2. `orden.cliente.telefono = orden.cliente.telefono || telefono`.
3. `orden.negocioId = negocioId`.
4. `orden.telefono_conversacion = telefono`.
5. `registrarPedido(resultado.orden, 'whatsapp')` cruza al sistema real.

El handoff de sombra reproduce las cuatro asignaciones y no realiza la quinta.
El remitente identifica la conversación; el teléfono dictado por el cliente
puede ser otro para la entrega y debe conservarse. La identidad de negocio,
canal y remitente se inyecta desde el canal, nunca desde el borrador.

La conexión anterior estaba incompleta: el observador devolvía el handoff,
pero el canal no enviaba `canal`/`telefonoConversacion` ni publicaba su línea.
Ahora esas tres líneas se agregan exclusivamente en la función de observación,
bajo las mismas puertas existentes: Mesero en sombra habilitado y bot callado.
El camino que crea pedidos permanece intacto.

## Confirmación, idempotencia y propuesta

`handoffDeSombra` usa `construirPedidoHipotetico`, los bloqueos existentes y
la transición `fase === 'confirmando'`. Exige identidad completa. Un carrito
completo sin confirmación no está listo. Repetir «confirmo» no genera otro
handoff; observar otra vez el mismo resultado permite distinguir `yaObservado`
de `nuevo`. Una modificación exige nuevo resumen y nueva confirmación.

El estado por conversación conserva la última huella. Solo `nuevo` produce
`[SOMBRA-MESERO-HANDOFF]`; la propuesta interna permanece disponible para las
pruebas. Nada se persiste. La huella SHA-256 truncada es determinista y considera
identidad, cliente, modalidad, pago, productos, cantidades, modificadores y
notas. `_lid` y tiempos no forman parte de ella.

Ejemplo final del fixture (datos sintéticos; `_lid` lo asigna el observador):

```json
{
  "negocioId": "negocio-del-fixture",
  "canal": "whatsapp",
  "telefono_conversacion": "remitente-del-fixture",
  "cliente": {"calle": "Reforma 200", "telefono": "remitente-del-fixture"},
  "modalidad": "entrega a domicilio",
  "forma_pago": "efectivo",
  "items": [{
    "producto_id": 107,
    "categoria_id": 26,
    "nombre": "Chilaquiles Mixtos",
    "cantidad": 1,
    "modificadores": [
      {"grupo": "Salsa", "opciones": ["Suiza", "Chipotle"]},
      {"grupo": "Guarniciones", "opciones": ["Frijolitos con chorizo"]},
      {"grupo": "Proteina", "opciones": ["Huevos Estrellados"]}
    ],
    "_lid": "identificador-del-mismo-renglon"
  }]
}
```

No lleva precios, total, subtotal, descuentos, promociones, costo de envío,
folio, id, timestamp productivo ni estado persistido. Es una propuesta para
validación, no un pedido creado. No inventa sucursal: se resuelve aguas abajo.

## Observabilidad y datos personales

El log incluye negocio, el mismo `conv` que la observación del turno, turno,
ready/nuevo/ya-observado, confirmación vigente, huella, códigos de bloqueo,
conteos, modalidad y pago. El remitente sale como hash en grupos de cinco para
evitar falsos positivos de teléfono en la guardia. No se vuelca la propuesta.

Los motivos de bloqueo podían contener nombres libres de productos o datos
del cliente: ahora el log conserva solo códigos de un conjunto cerrado.
Las etiquetas de modalidad/pago desconocidas salen como `otro`; los datos
internos originales no se modifican. Los campos de cliente solo se cuentan.

## Auditoría del validador

`src/orders/validadorOrden.js:validarOrdenPropuesta` no es una función pura:
consulta catálogo, modificadores, configuración y métodos de pago; depende
del estado de la base, horarios y promociones. Emite logs de ajustes/rechazos.
`cargarReglas` lee configuración; `calcularPromociones` consulta promociones e
historial de compras y usa la hora actual para elegibilidad.

En el camino de cálculo leído no hay reserva de folio, inserción de pedido ni
llamada a reserva de promociones. `reservarUsosPromociones` es una función
separada con escrituras, no invocada por `calcularPromociones`. Esto no vuelve
puro al grafo: importa `database.js` y servicios que exponen escrituras y
dependencias operativas. No se conectó el validador a la sombra ni se declara
certificado para ejecutarlo allí. Una futura integración requiere una frontera
de lectura explícita y una auditoría separada de efectos transitivos.

## Verificación reproducible

- `node test/fase-mesero-handoff-sombra.mjs`: S1–S27 y ampliaciones de identidad,
  PII, fixture completo por observador en serie y ráfaga.
- `node test/mordidas-mesero-handoff.mjs`: SH1–SH8 en copia temporal. Cada
  mutación debe fallar en su caso esperado y recuperar verde al restaurarse.
- `fase-mesero-sombra-canal`: MS17 entra por webhook con servicios simulados,
  confirma dos veces, comprueba una línea de handoff, identidad y cero pedidos
  en ambas tablas, además de cero respuestas al cliente.
- Las guardias V8/Y7/Y7b vigilan el grafo; el handoff alcanza únicamente su
  constructor puro y `node:crypto`. C13 se corrigió para distinguir comentarios
  explicativos de código ejecutable, conservando los imports prohibidos.
- Regresión y paridad se ejecutan en serie contra PostgreSQL local
  `localhost:55453/edged1_v3`, nunca contra producción.

## Límites conservados

La obligatoriedad de dirección por modalidad sigue limitada por la metadata
actual (C3). La sombra calcula un resumen hipotético que el cliente real aún
no ve mientras el bot está apagado: certifica decisiones del observador, no un
consentimiento productivo nuevo. Su estado vive en memoria y no sobrevive un
reinicio. No se cambia TTL/reset ni el orden de métodos `ORDER BY mp.orden`.
No se activa bot, Mesero productivo, pagos, impresión ni Rewards. El smoke real
y cualquier publicación quedan para una autorización posterior.

## Resultado final — 18 de septiembre de 2026

- Handoff: 33/33 casos (incluye fixture completo en serie y ráfaga).
- Mutaciones SH1–SH8: 8/8 detectadas, con restauración verde después de cada una.
- Webhook local: 17/17, incluido MS17 de confirmación repetida sin persistencia.
- Regresión completa sobre la base actual: 39/39 suites, en serie, cero fallos.
- Paridad legacy con Mesero apagado: referencia y candidato terminan con
  código 0; las trazas completas coinciden al excluir únicamente `etiqueta`.
  SHA-256 compartido:
  `cf9ef74b44de28da31c89b220d6d8e9ea8df02dbf50a419217dfc691e5fa3b63`.
- BASE_B: Git remoto y Railway SUCCESS siguen en
  `f9b8e1478423df8ccdfd33a361944ef271812f98`, igual a BASE_A.
- Cero diff contra BASE_A en `panel/`, `edge/`, `src/server.js` y
  `src/services/database.js`. Se conservan los ocho commits anteriores de
  cierre/autoridad/artefacto en la rama candidata; no se atribuyen a esta fase.
- Sin push, deploy, activación de flags ni smoke con tráfico real.

La evidencia local queda bajo
`C:/Users/mario/AppData/Local/Temp/claude/C--xabor-agent/8a57ec0c-163e-4db7-ac8c-ed14e4fe5c2d/scratchpad/`:
`corridas/codex-handoff-completa/` contiene las 39 salidas; las trazas de
paridad son `paridad-v3-codex-handoff-base.json` y
`paridad-v3-codex-handoff-candidato.json`.

**SHADOW DE HANDOFF CERTIFICADO — LISTO PARA SMOKE REAL DE CIERRE SIN PERSISTENCIA**
