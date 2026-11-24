# Campañas de WhatsApp con plantilla

Pedido de Mario, 20-nov-2026 («sí, prepáralas»); saneamiento del 21-nov
(migración 143: bajas, tandas, teléfonos del negocio e internos). Cómo se manda hoy una
campaña masiva por WhatsApp desde el panel (Clientes → Campañas), qué reglas
la cuidan y cómo se publica. Escrito para el dueño y para el siguiente que
toque esto.

## 1. Por qué cambió

La pantalla anterior mandaba **texto libre**. WhatsApp solo entrega texto
libre a quien le escribió al negocio en las últimas 24 horas; a los demás Meta
los rechaza después, con el error 131047, y el panel los contaba como
«enviados». Además, si Railway reiniciaba a media campaña, el envío se cortaba
sin decirlo.

Para escribirle a cualquier cliente, Meta exige una **plantilla aprobada**
(categoría Marketing o Utilidad). Cada mensaje de plantilla se cobra.

## 2. Cómo se usa

1. **Crear la plantilla en WhatsApp Manager** (business.facebook.com →
   WhatsApp Manager → Plantillas de mensajes). Categoría *Marketing* para
   promociones. Puede llevar variables (`{{1}}`, `{{2}}` o con nombre), una
   imagen de encabezado, botones de liga o de código de cupón. Meta la revisa;
   suele tardar minutos, a veces horas.
   - Una de **Marketing debe llevar el botón de baja** («Detener promociones»,
     la opción de Meta *Marketing opt-out*). Sin él Xabor la muestra como «no
     se puede mandar»: el cliente no tendría cómo pedir que ya no le manden.
   - Los demás botones de **respuesta rápida** («Quiero pedir») tampoco se
     aceptan: el bot no contesta ese toque y el cliente se queda sin
     respuesta. En su lugar, un botón de **liga** a la tienda en línea.
2. En el panel: **Clientes → Campañas → Nueva campaña**. La lista de
   plantillas sale de la cuenta del negocio; las que Xabor no puede mandar
   aparecen aparte con el motivo (no aprobada, encabezado de video, etc.).
3. Llenar las variables: cada una puede ser **el nombre del cliente** (con un
   respaldo, por omisión «cliente», para quien no tiene nombre) o un **texto
   fijo**.
4. Elegir a quién: todos, VIP, frecuentes, en riesgo, dormidos, nuevos o por
   puntos de Rewards. «Todos» es la **Lista de Clientes** del negocio, menos
   quienes se dieron de baja, los teléfonos del negocio y los internos (el
   formulario lo dice en una línea).
5. **Tanda** (opcional): cuántos mensajes como máximo en 24 h (por omisión
   250, o 50 si el número todavía está en el nivel de 50 de Meta; de 10 a
   100,000) y el porcentaje de rechazos que la pausa (10 % por omisión, de 2 a
   50).
6. **Revisar**: muestra cómo se verá el mensaje, a cuántos le llega, a quién
   se deja fuera y por qué, cuántos van sin nombre (y cómo les llega con el
   respaldo), en cuántas tandas sale y el costo aproximado.
7. **Mandarme una prueba** (opcional, recomendado): llega al número que se
   escriba; máximo 5 cada 10 minutos.
8. **Mandar**: pide confirmación y deja la campaña en cola. El historial
   muestra el avance y se actualiza solo mientras se está mandando.

## 3. Reglas que cuidan al negocio

- **Horario**: solo de 9:00 a 20:59, hora del negocio. Fuera de ese horario
  la cola espera y sigue al día siguiente.
- **Una campaña a la vez** por negocio.
- **No repetir en la semana**: quien recibió una campaña en los últimos 7
  días se deja fuera (casilla en el formulario, encendida por omisión).
- **Bajas**: quien tocó «Detener promociones» en una campaña, o le dijo a
  Meta que no quiere promociones del negocio (error 131050), queda con la
  baja **anotada en el cliente** (consentimiento de WhatsApp en «no», con su
  fecha y de dónde vino) y nunca vuelve a la lista. Un trabajo cada 2 minutos
  la anota leyendo los mensajes que el webhook ya guarda; no toca el webhook.
- **Fuera siempre**: los teléfonos del negocio (el WhatsApp de cada sucursal,
  que se registra solo, y los que el administrador agregue en Clientes →
  📞 Teléfonos del negocio), los clientes marcados **interno / empresa** y
  los repartidores del negocio.
- **Tandas**: no se intenta más que el tope en 24 h; lo que falta sigue solo
  cuando hay cupo. El historial dice «Tanda completa: sigue en 24 h».
- **Pausa automática**: si, contados desde 20 intentos, los rechazos (los que
  Meta no aceptó más los que después no llegaron) pasan el umbral (10 % por
  omisión), la campaña se pausa y dice por qué. **Reanudar** es a mano y
  vuelve a medir desde cero. También se puede **Pausar** a mano.
- **Repetidos y números inválidos** se quitan antes de contar.
- **La lista no cambia a escondidas**: si entre «Revisar» y «Mandar» cambió el
  número de destinatarios, no se crea nada y se pide revisar otra vez.
- **Dinero**: si la red se cae a medio envío, ese mensaje queda «sin
  confirmar» y **nunca se reintenta solo** (podría cobrarse dos veces).
- **Se detiene sola** si Meta rechaza la cuenta o la plantilla (pausada,
  deshabilitada, pago pendiente, token vencido), si el WhatsApp se
  desconecta, o si los primeros 5 envíos fallan todos con el mismo código.
  El motivo se muestra en el historial.
- **«Baja la velocidad»** (límite de Meta): la campaña espera 2 minutos y
  sigue.
- **Detener**: botón en el historial; lo que no salió queda cancelado. Una
  campaña pausada sigue ocupando el turno del negocio hasta que se reanuda o
  se detiene.
- Solo **administradores** con el módulo de WhatsApp. El negocio sale siempre
  de la sesión.

## 4. Qué se ve en el historial

En cola, enviados, entregados, leídos, «no llegó» (con la explicación del
código de Meta), sin confirmar, cancelados, cuántos respondieron y cuántos se
dieron de baja; si está pausada, el motivo.

Entregados y leídos dependen de los acuses que Meta manda al webhook, que
Xabor guarda solo si el negocio tiene encendida la configuración
`whatsapp_trazabilidad_formularios_v1`. Sin ella, la campaña se manda igual,
pero esas columnas se quedan en cero; el formulario lo advierte.

## 5. Costos (aproximados)

Los fija Meta por mensaje entregado y por país. Xabor muestra una estimación
con tarifas fijas en `src/services/campanasWaPlantillas.js`
(`TARIFA_APROX_USD`: Marketing ≈ US$0.045, Utilidad ≈ US$0.0085 para México).
El cobro real llega en la factura de Meta; las tarifas se revisan si Meta las
cambia.

## 6. Límites conocidos

- Encabezados de **video o documento**, carruseles y Flows no se pueden
  mandar todavía; aparecen como «no compatibles».
- Las plantillas se crean en WhatsApp Manager, no desde Xabor.
- La lista de plantillas necesita el identificador de la cuenta de WhatsApp
  Business del negocio, que guarda la conexión por registro integrado. Un
  negocio conectado a la antigua (solo con variables de entorno) ve el aviso
  «No encontramos la cuenta…» y debe reconectar su WhatsApp.
- El público es la Lista de Clientes del negocio (`clientes_negocio`, 10
  dígitos, celular mexicano). Desde la 143 ya no se lee la tabla vieja
  `clientes`, así que «Todos» puede ser menos gente que antes.
- El bot no contesta el toque de «Detener promociones»: la baja se anota, pero
  el cliente no recibe una confirmación escrita.
- Una baja que el cliente da desde el menú del chat de WhatsApp (no desde el
  mensaje) no llega como mensaje; se respeta en el siguiente envío, cuando Meta
  responde 131050.
- Un «BAJA» escrito por el cliente en el chat no lo da de baja
  automáticamente; la baja que se respeta es la que el cliente le da a Meta
  desde el propio mensaje de marketing.

## 7. Piezas

| Pieza | Qué hace |
|---|---|
| `src/services/campanasWaPlantillas.js` | Reglas puras: análisis de plantillas, variables, teléfonos, códigos de Meta, costo, horario |
| `src/services/campanasWa.js` | Plantillas del negocio, vista previa, creación, cola, acuses, historial |
| `src/services/campanasWaRutas.js` | Rutas `/api/admin/campanas-wa*` (admin + módulo WhatsApp) |
| `src/server.js` | Registra las rutas; la cola corre cada 10 s y los acuses cada 2 min, fuera del camino de pedidos y del webhook |
| `panel/campanas-wa.js` | La pantalla (Clientes → Campañas) |
| `migrations/142_campanas_whatsapp_plantilla.sql` | Columnas nuevas en `campanas` y `campana_envios` (aditiva) |
| `scripts/predeploy-142-…mjs` | La aplica en el Pre-Deploy de Railway (está en `SCRIPTS` del runner) |
| `test/fase-campanas-wa.mjs` | Reglas puras y cableado |
| `test/fase-campanas-wa-db.mjs` | Contra Postgres y una Graph API simulada |
| `src/services/clientesSaneamiento.js` | Teléfonos del negocio (y el WhatsApp de la sucursal), marca de interno, bitácora |
| `src/services/clientesSaneamientoRutas.js` | Rutas `/api/admin/clientes/telefonos-negocio*` y `/api/admin/clientes/v2/:id/interno`, `…/bitacora` (solo admin) |
| `panel/clientes-saneamiento.js` | 📞 Teléfonos del negocio y la sección «Interno / empresa» de la ficha |
| `migrations/143_clientes_saneamiento.sql` | Teléfonos del negocio, internos, bitácora, tope y pausa, bajas por envío y el cursor (aditiva) |
| `test/fase-crm-clientes.mjs` (casos 15–18) | Internos, teléfonos del negocio y el reconciliador |
| `src/services/avisoPromociones.js` | Aviso de promociones por negocio (versiones), lo que ve la tienda y la aceptación al pedir en ella |
| `src/services/avisoPromocionesRutas.js` | Rutas `/api/admin/clientes/aviso-promociones` (GET y PUT, solo admin) |
| `panel/clientes-consentimiento.js` | 📣 Aviso de promociones (Clientes) |
| `migrations/146_aviso_promociones.sql` | Versiones del aviso; folio y versión en cada aceptación; una aceptación al pedir por cliente (aditiva) |
| `test/fase-consentimiento-promos.mjs` | La 146, el aviso, la aceptación al pedir, la Lista con los tres estados, las rutas y la tienda |

Las rutas viejas `/api/admin/campanas` siguen existiendo (las campañas de
texto ya mandadas se ven en el mismo historial), pero el panel ya no tiene
formulario de texto libre.

## 8. Publicar y verificar

1. La rama sale de la rama de despliegue. Antes de publicar, revisar que no
   haya avanzado: `git log <base>..origin/prod/mesero-shadow-v3`. Si avanzó,
   rebasar y volver a correr las dos suites.
2. La migración 142 la aplica el Pre-Deploy (`predeploy-142`). Es aditiva: las
   campañas de texto existentes quedan con `tipo = 'texto'`. La 143 va
   después (`predeploy-143`), también aditiva: nadie nace interno, las
   campañas de antes quedan sin tope ni umbral. La 146 (`predeploy-146`) va
   al final: los consentimientos que ya había no cambian, y el aviso de la
   tienda lo siembra el servidor al arrancar.
3. Después del despliegue, comprobar que producción sirve la pantalla nueva:
   `/app` debe incluir `campanas-wa.js?v=<huella>` y `/campanas-wa.js` debe
   responder 200 con `window.XaborCampanasWa`.
4. Prueba real: crear la plantilla, hacer **Revisar** y **Mandarme una
   prueba** al número del dueño. Mandar la primera campaña a un grupo chico.

**Reversa**: volver al commit anterior. La 142 puede quedarse (el código viejo
ignora las columnas nuevas); si hace falta quitarla, a mano y a propósito:
`psql -f migrations/142_campanas_whatsapp_plantilla_down.sql`. Si la 143 está
aplicada, **primero** `143_clientes_saneamiento_down.sql`: su índice de bajas
usa una columna de la 142. Para revertirse, la 146 no depende de las otras
dos; su reversa (`146_aviso_promociones_down.sql`) no borra consentimientos: las
aceptaciones al pedir se quedan como aceptaciones, sin folio ni versión.
