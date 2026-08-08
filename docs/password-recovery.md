# Recuperación de contraseña — "¿Olvidaste tu contraseña?"

Rama `feat/password-recovery` (base de producción a93930a). **Migración
nueva: 042** (`password_reset_tokens` + `usuarios.sesiones_invalidas_antes`).

## Qué resolvía y qué no

Hasta ahora, un administrador o un miembro del personal que olvidaba su
contraseña **no tenía salida**: las invitaciones (migración 012) solo sirven
para la contraseña **inicial** y las emite un superadmin. Para un SaaS que se
instala en restaurantes ajenos eso no es aceptable: cada olvido era un ticket
de soporte.

## Quién puede recuperar

Una cuenta **administrativa**: con correo, con contraseña y con al menos una
membresía activa en un negocio activo.

**Un mesero no.** No tiene correo ni contraseña — su acceso es un PIN, y quien
se lo repone es un administrador desde *Usuarios*. Son dos sistemas separados
a propósito y este flujo **nunca toca `pin_hash`**. La consulta que decide
quién es elegible excluye explícitamente el rol `mesero`.

## El flujo

1. En `/login-negocio.html`, **¿Olvidaste tu contraseña?** abre un campo de
   correo.
2. `POST /api/auth/negocio/forgot-password` con `{ email }`.
3. Si el correo corresponde a una cuenta elegible, se genera un token
   aleatorio de 32 bytes y se envía por correo el enlace
   `https://xabor.mx/restablecer-contrasena?token=…`.
4. `/restablecer-contrasena` valida el enlace con
   `GET /api/auth/reset-password/:token` y muestra el formulario.
5. `POST /api/auth/negocio/reset-password` con `{ token, password,
   passwordConfirm }` cambia la contraseña y consume el enlace.

## Respuesta genérica: no se enumeran cuentas

La solicitud responde **siempre** lo mismo — existe o no la cuenta, esté
activa o no, tenga membresía o no:

> Si existe una cuenta asociada a ese correo, enviaremos instrucciones para
> restablecer la contraseña.

Mismo `status`, mismo cuerpo, mismas cabeceras. Decir "ese correo no existe"
convertiría el formulario en un detector de clientes de Xabor. Ni siquiera un
error interno se distingue desde afuera. El correo se normaliza (recortado y
en minúsculas) para que quien lo teclea con mayúsculas o espacios encuentre su
cuenta igual.

> Nota: el login administrativo compara el correo **exacto** como está
> guardado; esa diferencia es previa a esta fase y no se tocó aquí.

## El token

| | |
|---|---|
| Origen | `randomBytes(32)` → 256 bits, base64url |
| En la base | **solo** su `SHA-256` (`token_hash`), nunca el token |
| Vigencia | **60 minutos** |
| Usos | **uno**; `used_at` lo marca dentro de la transacción |
| Solicitudes repetidas | la nueva **revoca** las anteriores: solo sirve el último enlace |
| Dónde aparece en claro | únicamente en el correo enviado |

El consumo va en **una transacción** con `SELECT … FOR UPDATE` sobre el token:
dos peticiones simultáneas con el mismo enlace no lo usan las dos. Un intento
inválido (contraseñas que no coinciden, contraseña corta) **no** quema el
enlace.

Un enlace revocado responde igual que uno inexistente (`invalido`): no hay
razón para contarle a nadie que existió.

Es el mismo mecanismo ya probado de `invitaciones_usuario`; no se inventó
nada nuevo.

## Contraseña nueva

Misma política y **el mismo hash** que el resto del sistema (`hashPassword`,
scrypt con salt por registro, formato `salt:hash`): mínimo 8 caracteres, no
puede ser igual al correo, se pide confirmación. No hay un segundo algoritmo.

## Sesiones abiertas

Las sesiones de Xabor son tokens firmados **sin registro server-side** (ver
`src/services/session.js`), así que no existe una lista de sesiones vivas que
borrar. En vez de inventar un sistema de sesiones nuevo, 042 agrega
`usuarios.sesiones_invalidas_antes`: al restablecer la contraseña se marca
`NOW()`, y cualquier sesión cuyo `iat` sea anterior se rechaza con **401
`SESION_REVOCADA`**.

La comprobación viaja dentro de la consulta de membresía que **ya** se hace en
cada request autenticado (`obtenerMembresiaUsuarioNegocio`), así que no cuesta
una consulta extra. Aplica a las rutas HTTP (`requireSesionNegocio`,
`resolverNegocioSeguro`) y también al WebSocket del panel.

**Limitación conocida**: la marca es por usuario, no por sesión, así que
cierra *todas* sus sesiones — que es justo lo que se quiere después de un
olvido de contraseña. La sesión de estación de un mesero no se ve afectada
(un mesero no pasa por este flujo).

## Rate limit

| Endpoint | Llave | Límite |
|---|---|---|
| `forgot-password` | IP | 20 / 15 min |
| `forgot-password` | correo normalizado | **3 / 15 min** |
| `reset-password/:token` (validar) | IP | 20 / min |
| `reset-password` (consumir) | IP | 10 / min |

El límite **por correo** es el que de verdad protege a la persona: evita que
alguien le llene el buzón. El de IP se deja holgado a propósito, porque un
restaurante entero sale por la misma IP y nadie debe quedarse sin recuperar su
contraseña por culpa de un compañero. Ninguna de las dos llaves deja sin
servicio a otros negocios.

Es el mismo `rateLimit` en memoria del proceso que ya usa el resto del
sistema, con la **misma limitación documentada**: con varias instancias el
conteo es por instancia (no se agregó Redis).

## Correo

Reutiliza la infraestructura de las invitaciones (Resend por `fetch`, mismo
remitente `acceso@xabor.mx`, mismo manejo de fallos). **No se agregó ningún
proveedor.** Fuera de producción no se envía nada.

El correo lleva el saludo, el enlace, cuánto dura y "si no fuiste tú, ignora
este mensaje". **No** lleva contraseña, hash, nombre del negocio ni datos
internos. El enlace **no** se imprime en ningún log ni se devuelve por HTTP:
el correo es el único camino por el que sale del servidor.

Si el correo falla (proveedor caído, sin API key), la respuesta pública no
cambia — de lo contrario el tiempo o el error delatarían qué cuentas existen.

## Migración 042

- `password_reset_tokens` (`id`, `usuario_id`, `token_hash`, `expires_at`,
  `used_at`, `revoked_at`, `created_at`), con índice único sobre el hash.
- `usuarios.sesiones_invalidas_antes TIMESTAMPTZ NULL`.

**Sin `negocio_id`**: la recuperación es sobre la identidad, no sobre un
negocio. El mismo correo puede pertenecer a varios negocios y su contraseña es
una sola; amarrar el token a un tenant obligaría a elegir uno arbitrariamente.
Los permisos por negocio siguen viviendo en `usuario_negocios`.

Aditiva y reejecutable. Sin backfill: nace vacía y no invalida la sesión de
nadie. El predeploy (`scripts/predeploy-042-password-reset.mjs`, agregado al
runner) verifica que ningún usuario haya cambiado y aborta el deploy si algo
no cuadra.

**Rollback**: `042_password_reset_tokens_down.sql` es seguro en cualquier
momento — borra la tabla (artefactos transitorios) y la columna. Efecto
secundario: las sesiones que se habían invalidado vuelven a aceptarse hasta su
expiración natural (máximo 12 h). Las contraseñas ya cambiadas **no** se
revierten.

## Pruebas

`test/fase-password-recovery.mjs` (25 casos): enlace visible en el login,
solicitud, respuesta idéntica para correo existente e inexistente
(cuerpo, status y cabeceras), normalización, token aleatorio, hash en base y
token en claro ausente del esquema completo, expiración, un solo uso, segunda
solicitud invalidando la primera, contraseña vieja invalidada y nueva
funcionando, revocación de sesiones, mesero intacto (PIN idéntico), cuentas
desactivadas y sin membresía, rate limit, ausencia del enlace en respuestas y
logs, e invitaciones y login administrativo sin cambios.

El límite por correo **no se relaja para las pruebas**: los casos que necesitan
pedir varios enlaces usan cada uno su propia cuenta, como pasaría con personas
distintas.
