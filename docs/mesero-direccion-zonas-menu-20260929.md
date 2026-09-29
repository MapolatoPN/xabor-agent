# Dirección, zonas y menú en imágenes — 29 septiembre 2026

## Alcance y autorización

El dueño confirmó las correcciones tras reportar dirección solicitada dos veces,
tarifa de $60 sin atender reglas y menú en texto. Durante el trabajo configuró
las zonas personalmente y aclaró: «YA CONFIGURE LAS ZONAS».
**No se escribe `reglas_atencion` ni se reemplazan esas zonas.**

Se trabaja en `feat/flows-pedido-agrupado-20260929`, worktree propio de Codex.
Base local `d268f4b`; producción antes del cambio `24af388`.
No hay cambios en componentes protegidos, migraciones, credenciales, definición
del Flow, pagos, impresión ni alcance del canario. No se reinicia ni confirma
la conversación real.

## Diagnóstico y correcciones

1. La primera dirección fue rechazada con `direccion_sin_respaldo`: el cliente
   escribió `cbtis34` y el modelo propuso `Cbtis 34`. Ahora se admite separar
   letras y números solo al validar direcciones, sin permitir números distintos
   ni sustituir sufijos de domicilio. No se relaja la validación de otros textos.
2. El ejecutor dependía del argumento opcional `zona_entrega` del modelo. Ahora
   busca nombres de zonas configuradas en el destino validado y aplica su
   tarifa. Tolera acentos, guiones y nombres compuestos sin espacios; `/` separa
   alias configurados. No hay nombres ni precios del negocio codificados en la
   implementación. Si aparecen zonas con tarifas distintas exige aclaración.
3. Cambiar dirección recalcula la tarifa y volver de «Agregar más» conserva la
   correspondiente al destino. Recoger sigue costando cero. Sin coincidencia
   se usa la tarifa base configurada; esto no es un geocodificador ni una
   validación de cobertura por coordenadas.
4. El canal deja de añadir automáticamente un importe de envío antes de tener
   la dirección. El resumen y el registro final usan el mismo cálculo vigente.

Configuración leída, sin mutación: base $60; UTNC $150; Cervecera $150;
Coca Cola $120; Cartonera $120; COMISION FEDERAL / CARBON 2 $200.
Lo que guarde el dueño posteriormente sigue teniendo prioridad.

## Menú: operación autorizada, ya ejecutada

Las cuatro imágenes estaban presentes, pero su revisión quedó en `carta_cambio`
tras renombrar un producto. No se desactivó esa protección ni se forzó el envío.
Con la confirmación del dueño se registró la revisión delegada mediante el
servicio existente, con transacción y comparación de ambas huellas:

- Carta: `c1:fa0dd7604584462b6b9cce13364b25fa`.
- Imágenes: `i1:fc78cbbb6b9a6e51d5d85aa9c3c9464e`.
- Estado: `carta_cambio` → `vigente`.

`scripts/revalidar-menu-piloto-20260929.mjs` limita la operación a ese negocio,
usuario aprobador y huellas; `verificar` es de solo lectura. No se enviaron
imágenes reales desde las pruebas. Falta comprobar su recepción con un mensaje
del dueño solicitando el menú. Otro cambio de carta vuelve a exigir revisión.

## Pruebas y revisión del diff

- Regresiones de dirección y zonas: inicialmente 8 OK / 9 fallos; corregidas y
  ampliadas a **22/22**, incluidas tarifas, alias, ambigüedad y números falsos.
- `predeploy-check-incidentes`: **OK**, incluye la nueva suite.
- `mesero:tools`: **66/66**.
- Pedido canónico puro: **19/19**; reglas del asistente **9/9**; emisión y ciclos OK.
- Postgres desechable `test_botones_direccion_20260929`, red limitada a localhost:
  pedido canónico **34/35**. El caso nuevo 02b acepta la primera dirección,
  resuelve Centro sin argumento del modelo, muestra $40 de envío y registra
  $235 solo después de confirmar. Promoción 08-27 también pasa con $40 de envío
  y $235 total; se corrige su expectativa antigua de $30/$225, no la regla.
- **Fallo previo separado:** 05-06, escribir «la segunda» tras preguntar salsa,
  deja `modificadores=[]`. Reproducido también en `d268f4b` sin estos cambios,
  en worktree independiente `direccion-baseline-20260929`. No se omite ni se
  cambia su expectativa; solo se añade diagnóstico al mensaje de aserción.
- HTTP del Flow repetible: **OK**, ocho platillos, dos procesos cifrados,
  doble toque, reinicio tras tercero, una única salida y un pedido LOCAL de
  $1120 tras confirmar; ninguna llamada al modelo ni a Meta real.
- `git diff --check`: OK.

Revisión de alcance: la corrección modifica solo el ejecutor de entrega y el
anuncio del costo en el canal. Las zonas proceden de configuración, no del
importe propuesto por el modelo. El formulario conserva su definición y el
canario su alcance. El fallo 05-06 impide afirmar que toda la suite esté verde;
no es una regresión introducida por este cambio.

## Publicación

Candidato local probado. Pendiente registrar commit/despliegue verificado.
No considerar `/health` como identificación suficiente del build.
