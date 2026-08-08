# Estación de meseros — acceso operativo por PIN

Rama `feat/estacion-meseros-pin` (hija de `feat/usuarios-mesero-pin`, base de
producción 968b50d). **Sin migración nueva**: usa la 041 que ya traía la rama
padre (email nullable + `pin_hash`). 042 sigue libre.

## Qué resuelve

Un mesero no tiene correo ni contraseña, así que no puede entrar por el panel.
Ahora entra por `/mesero/<slug-del-negocio>` en la tablet del local o en su
celular: elige su nombre, teclea su PIN y cae directo en la operación de mesas.

## Flujos separados a propósito

| | Login administrativo | Estación de meseros |
|---|---|---|
| Ruta | `POST /api/auth/negocio/login` | `POST /api/auth/mesero/login` |
| Identidad | correo + contraseña | slug del negocio + mesero + PIN |
| Sesión | cookie normal | cookie con `est: true` en el payload firmado |
| Alcance | panel completo según rol | solo operación de Restaurante |

El PIN **nunca** es contraseña del login administrativo, y una sesión normal no
puede convertirse en sesión de estación: la marca va dentro del token firmado.

## El negocio siempre viene del slug

Dos restaurantes pueden tener un "Juan" con PIN 1234 y ambos son válidos, así
que un PIN suelto no identifica a nadie. La URL (`/mesero/mapolato-acuna`) fija
el negocio antes de pedir credenciales, y toda la validación queda acotada a
ese `negocio_id`.

**Enumerar nombres**: `GET /api/auth/mesero/opciones?negocio=<slug>` devuelve
los nombres de los meseros activos de ese negocio — sin correos, sin hashes,
sin usuarios administrativos. Es el mismo dato del gafete dentro del local y
evita teclear el nombre exacto en una tablet compartida. Un slug inexistente y
un negocio sin Restaurante responden idéntico (404 "Restaurante no
disponible"), así que la pantalla no confirma qué negocios existen. El login
acepta el id sin haber pedido la lista, por si algún negocio prefiere no
publicarla.

## Errores

Mesero inexistente, de otro negocio, inactivo, sin PIN o PIN equivocado →
**mismo 401 "Mesero o PIN incorrecto"**. Solo se distingue **"Restaurante no
disponible"** (negocio inactivo o módulo apagado), que es un estado operativo
que el personal necesita entender y no revela credenciales.

## Sesión

Cookie `xabor_sesion` HttpOnly, `SameSite=Lax`, `Secure` en producción, **12 h**
(el mismo `DURACION_MS` del resto). `POST /api/auth/mesero/logout` limpia la
cookie **y revoca el token server-side**, así que una copia de la cookie deja de
servir. Botón **Salir** visible en la pantalla de mesas.

`requireOperacionRestaurante` es la única puerta por la que entra una sesión de
estación, y en **cada request** relee el estado real: mesero activo, con rol
`mesero` y con PIN, negocio activo y módulo `restaurante` activo. Desactivar al
mesero o apagar Restaurante corta la sesión abierta al instante — no se confía
en lo que decía la cookie al iniciar.

## Permisos

**Puede** (mismas rutas de siempre, con su sesión): ver mesas, abrir mesa,
consultar cuenta, agregar productos con modificadores, dividir (cálculo),
mover mesa, enviar comanda, y leer el menú (`GET /api/menu`) para tomar la
orden.

**No puede**: Usuarios, Config, integraciones, Superadmin, ventas/reportes,
edición de menú (`/api/admin/menu/*`) ni ninguna otra ruta del panel — las dos
puertas administrativas (`requireSesionNegocio` y `resolverNegocioSeguro`)
rechazan el rol `mesero` con 403. El ocultamiento en la UI es comodidad; el
candado está en el backend.

**Cobro y cierre**: se conserva el contrato actual sin inventar política nueva.
`pagos` y `cerrar` siguen pidiendo sesión de panel (admin/staff), así que la
estación no cobra ni cierra; cancelar item, reabrir y revertir venta siguen
siendo de admin. Si el negocio quiere que el mesero cobre, es una decisión de
producto aparte.

## Operación

En sesión de estación la mesa se asigna **automáticamente** al mesero
autenticado: no se le vuelve a preguntar quién es y no puede abrir a nombre de
otro aunque mande otro id. En sesión administrativa o de soporte se conserva el
selector explícito con PIN, y un superadmin en soporte sigue sin poder
autoasignarse.

**Reasignar mesero en una cuenta abierta** no existe en el core y **no** se
agregó aquí. Política actual: cualquier usuario con acceso al negocio puede
operar una mesa ya abierta por otro (la cuenta conserva a su mesero
responsable); no hay bloqueo por mesero.

## Rate limiting del PIN

`rateLimitMiddleware` por `(IP, negocio)`: 10 intentos / 5 min en el login y 60
/ min en el selector. **Limitación documentada**: el contador vive en memoria
del proceso, así que con varias instancias el límite es por instancia (no se
agregó Redis). La llave incluye el negocio para que el tanteo contra un
restaurante no deje sin servicio a los demás.

## PIN

4–6 dígitos, scrypt con salt por registro, en `usuarios.pin_hash` (separado de
`password_hash`). Nunca se devuelve por API ni se escribe en logs.
**Recomendación futura**: rechazar PINs triviales (0000, 1234, 1111) al darlos
de alta; no se implementó en este MVP.

## Pruebas

`test/fase-estacion-meseros.mjs` (22 casos), incluida la tablet compartida
(Juan opera y sale, María entra sin heredar sesión) y la revocación en
caliente. Más `fase-usuarios-mesero-pin` (23) y la regresión completa.
