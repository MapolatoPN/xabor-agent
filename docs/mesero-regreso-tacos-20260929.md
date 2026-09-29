# Regreso y presentación de tacos — 29 septiembre 2026

## Incidente y causa

El dueño reportó que la flecha Atrás no regresaba desde Tacos, aunque
«Guardar y ver categorías» sí funcionaba. Reproducido localmente: una
solicitud `BACK` con `screen=TACOS` dejaba la pantalla en TACOS.

La implementación interpretaba `screen` como destino. Meta lo documenta
como la pantalla de origen, en el ejemplo Confirmation → Appointment Time:
[referencia refresh_on_back](https://developers.facebook.com/docs/whatsapp/flows/reference/flowjson/#additional-information-on-refresh-on-back).
Las pruebas anteriores enviaban `screen=MENU` y repetían la interpretación
equivocada; sus resultados no demostraban el comportamiento del cliente real.

## Corrección

- Historial de navegación guardado en el borrador del servidor. No se acepta
  un destino ni un historial del cliente.
- BACK recibe el origen y vuelve al paso anterior sin guardar campos
  incompletos, agregar platillos o alterar lo ya agregado.
- Entrega vuelve al origen real: Menú, Tacos o Platillo. Agregar más no
  acumula pantallas repetidas. Regresar al menú reinicia el historial.
- Un BACK repetido o con otro origen no retrocede nuevamente. FINAL no
  vuelve a abrirse. Borradores anteriores sin historial vuelven al menú.
- La revisión se incrementa al navegar: formularios de un paso anterior no
  pueden guardar usando una revisión antigua.

Presentación:

- Tacos ya no muestra «Elige una categoría para comenzar».
- Nombres/precios con texto de cuerpo en negrita, en vez de encabezados
  grandes. Sin cambiar nombres, cantidades, precios ni catálogo.
- Se eligen cantidades y después tortilla. La sección de tortilla se
  muestra y es obligatoria solo si hay tacos seleccionados. No se exige
  tortilla al volver sin elegir tacos o al terminar lo ya guardado.
- Notas visibles solo para guisos con cantidad; eliminar una cantidad
  oculta y limpia su nota. Cantidad vacía/null equivale a no seleccionar;
  cantidades inválidas y notas sin piezas siguen rechazándose.
- Se elimina «lote» del texto al cliente. Una indicación distingue volver
  sin agregar de guardar la selección.

## Riesgo y pruebas

Cambios limitados a `flowCategorias.js`, definición de la presentación y
regresiones. Sin componentes protegidos, migraciones, precios, pausas,
conversaciones, listas del piloto o credenciales modificadas.

- `scripts/check-flow-categorias.mjs`: navegación desde los tres orígenes,
  borrador anterior, reinicio serializado, reintentos, campos extra en BACK
  sin efectos, estado terminal y requisitos visuales.
- `npm run test:incident`: gate obligatorio, continuidad y 19/19 canónicos.
- `npm run mesero:tools`: 66/66.
- `test/fase-flows-webhook.mjs --categorias`: webhook cifrado, dos procesos,
  BACK concurrente, reinicios, volver desde Entrega y terminar sin duplicar.
  Un único pedido LOCAL de $415, mismas cantidades y notas.
- `test/fase-flows-db.mjs`: 18/18; barreras y recibos conservados.
- `git diff --check` y comprobaciones sintácticas.

Pruebas de DB solo en Postgres desechable local con red externa bloqueada,
Meta/modelo simulados. No se enviaron mensajes reales, cobraron pagos ni
imprimieron tickets. La vista real en móvil sigue pendiente.

## Validación de Meta, sin activar

Borrador final `1908733896776951`, nombre
`xabor_categorias_agrupado_4aa4f8fe429e`, estado **DRAFT**, sin errores JSON.
SHA256: `4aa4f8fe429e65f9f540d5ae8355ec26c64044ec1281e4e7b315d24c7ca04210`.
Endpoint existente: `https://xabor.mx/webhook/flows/pedido`.

El primer borrador `1908440823852863` fue rechazado: `required` no acepta
expresiones compuestas, solo booleanos o enlaces a datos booleanos. Se usó
un componente If con un campo obligatorio dentro, y Meta validó el segundo
borrador. El primero no se publicó ni activó.

Permanece la advertencia WABA 141006 de facturación para conversaciones
iniciadas por la empresa. No se modifica facturación ni se envían plantillas.

## Antes de integrar o activar

Entregar el diff para revisión y obtener autorización de despliegue. La
configuración activa sigue apuntando a `1579871723825809`, con nueve
personas autorizadas y porcentaje cero. No se hizo push ni despliegue aquí.

Tras revisión, desplegar el código y verificar el commit real de Railway;
publicar el borrador validado y cambiar solo `whatsapp_flow_categorias_id`,
conservando ambas listas del piloto. El script anterior de activación exige
un único teléfono: no usarlo ni debilitar su protección para este piloto
ampliado. Verificar los nueve números explícitamente al activar.

La activación de un Flow nuevo invalida formularios anteriores abiertos;
las pruebas móviles deben empezar desde una invitación nueva. No borrar
conversaciones para forzar esa prueba. Revertir presentación requiere
restaurar únicamente el ID anterior; no modificar listas ni tarifas.
