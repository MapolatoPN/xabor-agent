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
