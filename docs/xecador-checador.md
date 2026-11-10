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
| B6 | Exportación básica por empleado y periodo (CSV y PDF) con eventos, correcciones y aceptación; formato con versión | (sin migración) |
| Solo PIN | La tablet pide solo el PIN, sin el número de empleado; cada PIN es único en el negocio y lejos de los demás | 132 |
| PIN + cara | Tras el PIN, la tablet compara la cara con la registrada (con consentimiento); si no coincide, se registra igual y queda para revisar. Ver `docs/xecador-cara.md` | 134 |
| B4 | Cálculos: horas por día y semana contra la jornada, horas extra, máximo semanal por año configurable | (después) |
| B5 | Aceptación semanal del empleado | (después) |

## Orden de despliegue

Las migraciones van en el runner del Pre-Deploy (`scripts/predeploy-run-032-033.mjs`)
en orden: 127 → 128 → 129 → 130 → 131 → 132 → 134. Cada predeploy necesita a la
anterior y falla cerrado si no está. Para revertir: primero el código y después
las migraciones en orden inverso (134 → 132 → 131 → 130 → 129 → 128); cada reversa se
niega a correr si ya hay datos que se perderían. La 132 no guarda nada que no
se pueda reconstruir: el código anterior no la usa, así que basta revertir el
código para volver a número + PIN.

## Solo con el PIN (132)

Decisión del dueño del 7-nov-2026: el número de empleado sobraba en la tablet.

- **Cómo se reconoce.** Junto al hash del PIN (scrypt, con sal propia) el
  servidor guarda un índice: el HMAC del PIN con una llave propia, atado al
  negocio. La base lo hace único por negocio, contando las bajas: dos
  empleados nunca comparten PIN y el de alguien que se fue no se le da a otro.
- **PIN nuevo.** Siempre de 6 dígitos y no trivial. Se descarta si él o lo que
  se teclea por error al escribirlo (un dígito distinto, dos vecinos
  volteados) ya es de otro empleado: un dedazo da «PIN incorrecto», nunca la
  checada de un compañero.
- **PIN anteriores.** Los generados antes de la 132 no traen índice: se
  reconocen comparando con su hash y reciben su índice la primera vez que el
  empleado checa. No hay que repartir PIN nuevos. Lo mismo pasa si cambia el
  secreto del servidor (cada índice lleva la huella de su llave).
- **Intentos fallidos.** Un PIN equivocado no es de nadie: lo frena la pausa de
  la tablet (muchos fallos en poco tiempo → un minuto en pausa y aviso).
- **Sin conexión.** La tablet no sabe de quién es el PIN (no guarda nada de los
  empleados): el empleado elige qué registra y el servidor lo reconoce al
  sincronizar. Un PIN que no es de nadie no tiene a quién registrarse: queda
  un aviso con la hora y la tablet, y el administrador la agrega con una
  corrección.
- **Tablets con la página anterior.** El servidor sigue aceptando número + PIN
  (y las checadas que ya estaban en su cola) con las reglas de antes.

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

## Exportación (B6)

Checador → «Exportar registro». Solo lee: no escribe nada en la base.

- **Qué sale.** Cada checada de la tablet (en línea y sin conexión), cada
  checada agregada por el administrador y, debajo de cada una, sus
  correcciones con motivo, autor y fecha. Se ven las dos: lo original y lo que
  cuenta. Lo anulado sigue saliendo, marcado. También lo que quedó para
  revisar, su revisión y lo fuera de orden.
- **Periodo.** Días completos en la hora de los negocios (America/Matamoros),
  «hasta» incluido; el cambio de horario lo resuelve la zona. Una checada que
  una corrección movió fuera del periodo sale por su hora original.
- **CSV.** De un empleado o de todos los que tienen algo en el periodo (con
  las bajas), hasta un año. Una fila por checada, agregada o corrección; UTF-8
  con BOM (Excel lee los acentos) y lo escrito por una persona no se abre como
  fórmula.
- **PDF.** De un empleado, hasta tres meses, agrupado por semana. Se imprime
  con Chromium sin JavaScript y sin red: solo con lo que trae la página.
- **Resumen (CSV, 7-nov-2026, pedido de Mario).** Para leerlo, no para una
  inspección: un renglón por turno con fecha, día, número, empleado, entrada,
  descansos, salida, horas trabajadas y observaciones en palabras sencillas
  («Sin salida», «En turno», «Corregida por el administrador», «Para revisar:
  …»). Usa lo que CUENTA (correcciones aplicadas, sin lo anulado). Un turno va
  de la entrada a la salida; lo que llega más de 16 h después de su última
  checada ya es otro turno (la regla de la tablet). Cada turno es del día de su
  primera checada; para no partir un turno de noche se mira lo que cuenta 7
  días antes y 2 días después del periodo. Horas = salida − entrada −
  descansos, con tiempo real (el cambio de horario no suma ni resta una hora);
  si falta la entrada, la salida o el inicio de un descanso, va vacío y la
  observación lo dice. Sin versión ni lo original: eso es el registro.
- **Aceptación.** Cada semana dice «No solicitada» hasta que exista B5; nunca
  «Aceptada» sin que el empleado acepte.
- **Sin cálculos de jornada.** El resumen suma el tiempo de cada turno, pero no
  calcula extras, retardos ni faltas contra la jornada asignada: eso es B4.
- **Formato.** Todo lo que decide cómo se ve el archivo vive en
  `src/services/exportacionFormato.js` (textos, columnas del CSV y diseño del
  PDF), con su `VERSION` (hoy `xecador-registro-1`) en cada fila y en cada
  hoja. Cuando la STPS publique las disposiciones generales se cambia ese
  archivo y se sube la versión; `exportacionService.js` solo junta los datos.
- **Rutas.** `GET /api/personal/checador/exportar.csv` y `exportar.pdf`, con
  `desde`, `hasta` (AAAA-MM-DD) y `empleado_id` (obligatorio en el PDF). El
  CSV con `vista=resumen` es el resumen por turno (`resumen-jornada_….csv`);
  sin `vista` o con `vista=completo`, el registro. Las mismas puertas que el
  resto del módulo; la descarga es privada y sin caché.

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
  checador con su PIN.
- Se guarda quién aceptó (o señaló como incorrecto, con comentario), cuándo y
  desde dónde. El canal de envío va desacoplado: primero el enlace, WhatsApp
  después.
