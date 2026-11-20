# Campañas de WhatsApp con plantilla

Pedido de Mario, 20-nov-2026 («sí, prepáralas»). Cómo se manda hoy una
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
   imagen de encabezado, botones de respuesta rápida, de liga o de código de
   cupón. Meta la revisa; suele tardar minutos, a veces horas.
2. En el panel: **Clientes → Campañas → Nueva campaña**. La lista de
   plantillas sale de la cuenta del negocio; las que Xabor no puede mandar
   aparecen aparte con el motivo (no aprobada, encabezado de video, etc.).
3. Llenar las variables: cada una puede ser **el nombre del cliente** (con un
   respaldo, por omisión «cliente», para quien no tiene nombre) o un **texto
   fijo**.
4. Elegir a quién: todos, VIP, frecuentes, en riesgo, dormidos, nuevos o por
   puntos de Rewards (los mismos grupos de antes).
5. **Revisar**: muestra cómo se verá el mensaje, a cuántos le llega, a quién
   se deja fuera y por qué, y el costo aproximado.
6. **Mandarme una prueba** (opcional, recomendado): llega al número que se
   escriba; máximo 5 cada 10 minutos.
7. **Mandar**: pide confirmación y deja la campaña en cola. El historial
   muestra el avance y se actualiza solo mientras se está mandando.

## 3. Reglas que cuidan al negocio

- **Horario**: solo de 9:00 a 20:59, hora del negocio. Fuera de ese horario
  la cola espera y sigue al día siguiente.
- **Una campaña a la vez** por negocio.
- **No repetir en la semana**: quien recibió una campaña en los últimos 7
  días se deja fuera (casilla en el formulario, encendida por omisión).
- **Bajas**: quien le dijo a Meta que no quiere promociones del negocio
  (error 131050 en una campaña anterior) nunca vuelve a la lista.
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
- **Detener**: botón en el historial; lo que no salió queda cancelado.
- Solo **administradores** con el módulo de WhatsApp. El negocio sale siempre
  de la sesión.

## 4. Qué se ve en el historial

En cola, enviados, entregados, leídos, «no llegó» (con la explicación del
código de Meta), sin confirmar, cancelados y cuántos respondieron.

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
- El público son los clientes del negocio (tabla `clientes`). Un número de 10
  dígitos se toma como celular mexicano, igual que en el resto del sistema.
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

Las rutas viejas `/api/admin/campanas` siguen existiendo (las campañas de
texto ya mandadas se ven en el mismo historial), pero el panel ya no tiene
formulario de texto libre.

## 8. Publicar y verificar

1. La rama sale de la rama de despliegue. Antes de publicar, revisar que no
   haya avanzado: `git log <base>..origin/prod/mesero-shadow-v3`. Si avanzó,
   rebasar y volver a correr las dos suites.
2. La migración 142 la aplica el Pre-Deploy (`predeploy-142`). Es aditiva: las
   campañas de texto existentes quedan con `tipo = 'texto'`.
3. Después del despliegue, comprobar que producción sirve la pantalla nueva:
   `/app` debe incluir `campanas-wa.js?v=<huella>` y `/campanas-wa.js` debe
   responder 200 con `window.XaborCampanasWa`.
4. Prueba real: crear la plantilla, hacer **Revisar** y **Mandarme una
   prueba** al número del dueño. Mandar la primera campaña a un grupo chico.

**Reversa**: volver al commit anterior. La 142 puede quedarse (el código viejo
ignora las columnas nuevas); si hace falta quitarla, a mano y a propósito:
`psql -f migrations/142_campanas_whatsapp_plantilla_down.sql`.
