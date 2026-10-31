# WhatsApp autoservicio

## Qué hace el cliente

Entra a su panel, va a **Config → WhatsApp**, y pulsa **Conectar WhatsApp**.
Meta le pide iniciar sesión con su propia cuenta, elegir su portafolio
comercial, su cuenta de WhatsApp Business y su número. Cuando termina, vuelve
a Xabor y ve su número conectado.

No copia nada. No pega ningún token. No abre el Business Manager en otra
pestaña para buscar un identificador.

## Qué hacía antes

El panel le mostraba cuatro campos de texto: Access Token, Phone Number ID,
Verify Token y número admin. Eso no es configuración, es pedirle al cliente
que haga de integrador. Un restaurante no tiene por qué saber qué es un
Phone Number ID, y cada campo que le pedimos copiar es una oportunidad de
pegarlo mal o de mandárnoslo en una captura por WhatsApp.

Los tres primeros ya no se le piden. El backend los sigue aceptando para
soporte, pero desaparecieron de la pantalla del cliente.

## Qué activos conserva el cliente

**Todos.** Xabor no mueve ni reclama nada:

- la página de Facebook sigue siendo suya
- el portafolio comercial sigue siendo suyo
- la cuenta de WhatsApp Business sigue siendo suya
- el número sigue siendo suyo

No hace falta transferir la página al portafolio de Xabor. El onboarding usa
los activos a los que el cliente ya tiene acceso en Meta.

Si algún día se desconecta, esos activos siguen intactos: lo único que se
retira es el permiso que Xabor tenía sobre ellos.

## Qué permisos necesita Xabor

Los que Meta exige para operar la integración: leer los mensajes que llegan
al número, responderlos, y suscribir la cuenta para recibir los webhooks. Ni
uno más.

## Cómo se garantiza que un negocio no toca el de otro

El negocio va **dentro del `state` firmado**, no en el cuerpo de la petición.
Cuando el administrador de un restaurante pulsa Conectar, Xabor firma un
state con su negocio (sacado de su sesión, jamás de lo que mande el
navegador) y ese state es el único que el callback va a mirar.

Consecuencias:

- mandar `negocioId` en el cuerpo no sirve de nada: se ignora
- reescribir el negocio dentro del state invalida la firma
- el state es de un solo uso y vence: reusarlo se rechaza
- un número ya vinculado a otro negocio no se le puede robar

Solo el rol `admin` del negocio puede conectar. Un mesero o un operador
reciben 403.

## Errores que pueden aparecer

| Lo que ve el cliente | Qué pasó |
|---|---|
| El número ya no existe en esa cuenta de WhatsApp | Meta devolvió el error 33: el número se borró en Meta |
| Ese número ya está registrado en otra configuración | El número está tomado |
| Falta completar la verificación del número en Meta | Meta pide verificar antes de seguir |
| El permiso que diste a Xabor caducó | El token expiró; hay que reconectar |
| Tu usuario de Meta no tiene permisos suficientes | La cuenta con la que inició sesión no administra esa WABA |
| No pudimos completar la conexión con Meta | Cualquier otra cosa. El detalle técnico queda en nuestros logs, no en su pantalla |

Nunca se le muestra un stacktrace, un JSON de Graph API ni un mensaje de
error crudo de Meta.

## Nombre visible en revisión

Meta revisa el nombre que verán los clientes. Mientras lo revisa, **WhatsApp
puede estar conectado y funcionando**. Por eso "En revisión" se pinta en
ámbar, no en rojo, y no desmiente el estado de conexión. Solo "Rechazado" es
un problema que requiere acción.

## El permiso vence a los 60 días

El permiso que Meta le da a Xabor al conectar (usuario del sistema) **vence a
los 60 días**. El de Obispado, conectado el 30-ago-2026, venció el 29-oct a
las 15:02 hora local. Al día siguiente el bot no pudo contestar a nadie, y
nadie se enteró en todo el día: cada respuesta fallida pasaba a una persona, y
la alerta al administrador sale por WhatsApp, con ese mismo permiso vencido.

Desde el 31-oct, `services/vigilanciaCredencialWhatsapp.js` corre cada 10
minutos. Por cada integración WhatsApp activa, consulta el número a Meta con
la credencial del negocio: es una lectura, nunca un mensaje.
- **Si Meta la rechaza** (401, o los códigos 190 o 102):
  - la tarjeta de WhatsApp pasa a «Requiere reconexión»;
  - los equipos del negocio reciben una notificación push, con un
    recordatorio cada 4 h, solo entre 7 y 22 h.
- **El estado de la integración no cambia.** Cambiarlo cortaría la recepción
  de mensajes.
- La marca (`ultimo_error_codigo = 'credencial:…'`) se quita al reconectar o
  cuando la credencial vuelve a funcionar.
- **Si la credencial sirve**, cada 6 h se pregunta a Meta cuándo vence
  (`/debug_token`). La fecha se guarda en `token_expira_at` y se avisa 7, 3 y
  1 días antes.
- «Verificar conexión» hace la misma consulta. Antes respondía «Todo listo»
  aunque el permiso estuviera vencido.
- Se apaga por negocio con `whatsapp_vigilancia_credencial = 'false'` en
  `configuracion`.

El arreglo siempre es el mismo: Configuración → Integraciones → WhatsApp →
**Reconectar**.

## Qué NO hace Xabor

- No mueve páginas de Facebook a su portafolio
- No crea un portafolio comercial en nombre del cliente sin que él lo elija
- No enciende la atención automática al conectar: eso lo decide el negocio
  después, con su propio interruptor
- No manda un mensaje real al verificar la conexión
- No borra la WABA, la página ni el número desde Xabor

## Lo que todavía no está resuelto

**El anti-replay del `state` vive en memoria del proceso.** Está anotado como
deuda en la auditoría de puntos únicos de fallo. Con una sola instancia
funciona; con dos, un state consumido en una podría reusarse en la otra. Esta
fase **no lo empeora** — usa el mismo mecanismo que ya usaba Superadmin — pero
tampoco lo cierra. Antes de activar réplicas hay que moverlo a la base.

**El campo de API key de Anthropic sigue visible** en Config. No se tocó
porque no pude verificar si algún negocio depende de una clave propia, y
quitarle un campo del que dependa sería una regresión que no puedo probar.
Queda como decisión pendiente.
