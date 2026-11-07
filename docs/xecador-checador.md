# Xecador · checador digital (registro electrónico de jornada)

Módulo `personal` de Xabor. Lo administra solo el administrador de cada negocio
(el Superadmin no tiene acceso). Meta del dueño: A, B1, B2, B3 y B6 listos antes
del 1 de enero de 2027; B4 y B5 después. Piloto en Acuña.

## Fases

| Fase | Qué es | Migración |
|---|---|---|
| A | Catálogo completo del empleado: sucursal, fecha de ingreso, NSS, jornada con vigencia, PIN (solo hash), baja con motivo de catálogo, versión del expediente | 128 |
| B1 | Tablet autorizada por sucursal, checadas de solo inserción, PIN en pausa temporal con aviso, foto opcional | 129 |
| B2 | Correcciones: evento nuevo con motivo, autor y fecha; la checada original no se toca | 130 |
| B3 | Sin conexión: la tablet guarda y sincroniza; hora del servidor con reloj monotónico; PIN verificado al sincronizar. Además: IP de cada checada contra la habitual de la sucursal, «Para revisar» con «Revisada», aviso de empleados activos sin PIN | 131 |
| B6 | Exportación básica por empleado y periodo (CSV y PDF) | (por hacer) |
| B4 | Cálculos: horas por día y semana contra la jornada, horas extra, máximo semanal por año configurable | (después) |
| B5 | Aceptación semanal del empleado | (después) |

## Orden de despliegue

Las migraciones van en el runner del Pre-Deploy (`scripts/predeploy-run-032-033.mjs`)
en orden: 127 → 128 → 129 → 130 → 131. Cada predeploy necesita a la anterior y
falla cerrado si no está. Para revertir: primero el código y después las
migraciones en orden inverso (131 → 130 → 129 → 128); cada reversa se niega a
correr si ya hay datos que se perderían.

Las reglas de cada tabla (CHECK y llaves) van fuera del `CREATE TABLE`: si
alguna falta, volver a aplicar la migración la repone (con el mismo nombre).

## Sin conexión (B3)

Decisiones del dueño del 6 y 7-nov-2026. Una checada guardada sin internet
**nunca se pierde**: lo dudoso se registra igual y queda «para revisar».

- **Hora.** No se confía en el reloj de la tablet. Cada respuesta del servidor
  trae su hora firmada para esa tablet; sin internet, la tablet mide el tiempo
  transcurrido con su reloj monotónico (`performance.now()`). Al sincronizar,
  la hora oficial es esa referencia más el transcurrido. La hora del reloj de
  la tablet se guarda aparte: si difiere más de 2 minutos, «reloj desfasado».
  Sin referencia válida (la tablet se reinició sin internet), se usa la de la
  tablet y se marca «sin hora del servidor».
- **PIN.** Se verifica al sincronizar. La tablet lo cifra en el momento con la
  llave pública del servidor (ECDH P-256 + HKDF + AES-GCM, atado a la clave de
  esa checada) y no lo puede volver a leer. Un PIN que no es —o una
  confirmación que ya no se puede verificar— se registra con «PIN no válido» y
  aviso al administrador. Un número que no es de nadie no tiene a quién
  registrarse: queda el aviso. La respuesta a la tablet es la misma en todos
  los casos.
- **Orden.** Sin conexión no se exige el orden del turno (pudo checar en otra
  tablet mientras tanto); la vista del día marca lo que quedó fuera de orden.
- **IP.** Cada checada guarda la suya. La habitual de la sucursal es la más
  frecuente de los últimos 14 días, con al menos 5 checadas; una distinta se
  marca, no se bloquea.
- **«Para revisar».** Junta lo marcado (reloj desfasado, sin hora del servidor,
  PIN no válido, otra sucursal, empleado de baja, IP distinta, sin foto). El
  administrador lo corrige desde el día si hace falta y lo marca «Revisada»
  con una nota: una sola vez, con autor, de solo inserción.

## Requisitos acordados para B5 (aceptación semanal)

Anotados el 7-nov-2026 por decisión del dueño:

- El resumen semanal del empleado muestra **cada corrección** de esa semana:
  hora original, hora corregida, motivo y quién la hizo.
- Si se corrige una checada de una semana **ya aceptada**, la aceptación de esa
  semana pasa a **«requiere nueva aceptación»** y se le vuelve a pedir al
  empleado.
- Si el empleado no responde, el estado queda **«sin respuesta»**, nunca
  «aceptado».
- Además del enlace, la semana se puede revisar y aceptar en la tablet del
  checador con número + PIN.
- Se guarda quién aceptó (o señaló como incorrecto, con comentario), cuándo y
  desde dónde. El canal de envío va desacoplado: primero el enlace, WhatsApp
  después.
