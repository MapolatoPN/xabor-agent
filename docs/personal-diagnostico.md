# Módulo Personal — diagnóstico de arquitectura

Antes de escribir código. Qué se reutiliza, qué falta, qué decide el negocio y
en qué orden se construye. Estado: **diagnóstico; nada implementado.**

Mapolato Obispado es el piloto, no el destinatario: no habrá nombres, ids ni
reglas suyas en el código.

## 1. Lo que YA existe y se reutiliza

Esto es lo que más ahorra, y conviene mirarlo antes de proponer tabla nueva.

| Necesidad del encargo | Lo que ya hay |
|---|---|
| Aislamiento por negocio | `negocios`, y la convención `negocio_id` obligatorio y fail-closed en todo servicio |
| Sucursales | `sucursales`, y **`usuario_sucursales`** (usuario ↔ sucursal, con `activo`) — es justo "empleados autorizados en una o varias sucursales" |
| Persona ligada a un negocio | `usuarios` (negocio_id, nombre, email, activo, `pin_hash`) + `usuario_negocios` (rol, activo) |
| Activación por Superadmin | `negocio_modulos` (negocio_id, modulo, estado) + `validarCombinacion`/`DEPENDENCIAS` |
| Gate en cada ruta | `requireModulo('personal')`, `resolverNegocioSeguro(rol)`, `requireAdminSeguro` |
| Ajustes por negocio | `configuracion` (negocio_id, clave, valor) |
| PIN con hash | `services/password.js` — scrypt con salt por registro, `hashPin`/`verifyPin`. **No se inventa criptografía nueva** |
| Jornadas y días operativos | `cortesCaja.js`: `zonaHorariaNegocio`, `fechaOperativaDe`, `rangoUtcDeFecha`, `instanteLocal`. Ya resuelven horario de verano y bordes de día |
| Auditoría de plataforma | `registrarAuditoriaPlataforma` |
| Ventas para el dashboard | `pedidos_activos` + `calcularCorteVivo` (ventas por día operativo) |

**Un empleado NO es un `usuario` nuevo.** Un empleado es una persona del
negocio que puede además tener acceso; se modela como tabla propia con
`usuario_id` **opcional**. Si se forzara a crear un `usuario` por cada empleado
de cocina, cada alta de personal crearía una credencial de acceso que nadie
pidió.

## 2. Lo que NO existe y hay que decidir

### Almacén privado de archivos — el hueco real

No hay ninguno. La única imagen del sistema es `tienda_productos.imagen_url`,
es decir **una URL**, no un archivo guardado. Y el disco de Railway es efímero:
lo que se escriba en el contenedor desaparece en el siguiente despliegue.

Las selfies de checada son obligatoriamente privadas y con retención
configurable, así que hacen falta bytes guardados de verdad.

**Decisión propuesta (reversible): `bytea` en Postgres**, con retención.
Una selfie comprimida a ~640px ronda 40 KB. Veinte empleados × 4 movimientos ×
30 días ≈ **96 MB al mes**, que con una retención de 90 días se estabiliza en
~290 MB. Es asumible y no añade proveedor, credenciales ni dependencia nueva
—que además el encargo prohíbe inventar—. Si algún día se quiere object
storage, se cambia el adaptador de lectura/escritura sin tocar el modelo.

Las fotos NUNCA se sirven por URL pública: van por una ruta autenticada que
comprueba negocio, sucursal y permiso en cada petición.

### La cámara no funciona desde el Edge por IP

`getUserMedia` exige contexto seguro: solo `https://` o `localhost`. El panel
servido por el Edge en `http://192.168.x.x:7071` **no puede pedir la cámara**,
y no hay forma de saltárselo sin desactivar seguridad del navegador.

Consecuencia de diseño, y hay que decirla antes de construir: **el reloj
checador vive en la nube** (`https://xabor.mx`), o en la propia máquina del
Edge por `localhost`. El encargo ya dice que este módulo no incluye asistencia
offline; esto lo confirma por una razón técnica dura, no por alcance.

### Rol de gerente

Hoy `usuario_negocios.rol` maneja `admin` / `staff` / `mesero`. El encargo pide
un **gerente** con acceso acotado a sus sucursales y **sin acceso salarial por
defecto**. Se propone añadir el valor `gerente` y que su alcance salga de
`usuario_sucursales`, más un permiso explícito para lo salarial.

## 3. Esquema propuesto

Todas con `negocio_id NOT NULL REFERENCES negocios(id)`. Las que tienen sentido
por sucursal llevan `sucursal_id`.

- **`personal_empleados`** — nombre, `usuario_id` (opcional), teléfono, correo,
  puesto, fecha de ingreso, estatus, notas, `sucursal_principal_id`,
  periodicidad, tipo de sueldo (semanal/quincenal/diario/por hora), sueldo base
  `NUMERIC(10,2)`, `foto_id`. **Baja lógica**: nunca borrado físico si tiene
  asistencias o prenóminas.
- **`personal_empleado_sucursales`** — las autorizadas. Se separa de
  `usuario_sucursales` porque un empleado puede no tener `usuario`.
- **`personal_horarios`** y **`personal_horario_asignaciones`** — plantilla
  reutilizable + asignación con vigencia. El historial se conserva: cambiar el
  horario de hoy no puede reescribir cómo se evaluó el mes pasado.
- **`personal_checadas`** — empleado, negocio, sucursal, tipo
  (entrada/inicio_descanso/fin_descanso/salida), `ocurrido_at` (**hora del
  servidor**), `dispositivo_id`, `evidencia_id`, auditoría de correcciones.
  Índice único parcial por (empleado, tipo, ventana) para que un doble clic no
  cree dos.
- **`personal_evidencias`** — `bytea`, mime, bytes, `creado_at`, `expira_at`.
- **`personal_incidencias`** — tipo, fecha, monto/tiempo, comentario, creador,
  autorizador, fecha de autorización.
- **`personal_prenominas`** y **`personal_prenomina_conceptos`** — periodo,
  estado (BORRADOR→EN_REVISIÓN→APROBADA→PAGADA), quién y cuándo, y una
  **instantánea JSONB de las reglas y datos usados**. Sin esa foto, una
  prenómina pagada cambia de significado cuando alguien edita una regla.
- **`personal_config`** — o bien claves en `configuracion`. Se decidirá al
  implementar; `configuracion` ya existe y evita una tabla.

Dinero: `NUMERIC(10,2)` en base y **enteros de centavos en JavaScript**. Es la
misma lección que costó un defecto en sala: sumar flotantes impide cuadrar.

## 4. Migraciones propuestas

- **073** — `personal_empleados`, `personal_empleado_sucursales`, y el valor
  `'personal'` en el CHECK de `negocio_modulos` (mismo patrón aditivo de las
  015/026/028/039: se recrea el CHECK incluyendo el valor nuevo, nunca se quita
  ninguno).
- **074** — horarios, asignaciones, checadas y evidencias.
- **075** — incidencias.
- **076** — prenóminas y conceptos.

Cada una con su `predeploy-0NN-*.mjs` enganchado en el runner, que verifica que
las tablas quedan utilizables antes de confirmar.

## 5. Archivos que se tocarán

- `src/services/modulosDependencias.js` — `personal: ['usuarios']`.
- `src/server.js` — rutas bajo `requireModulo('personal')` y la de evidencias.
- `panel/index.html` — la entrada de menú (componente protegido: cambio mínimo).
- `panel/personal.html` y `panel/reloj.html` — pantallas nuevas, en archivos
  propios, igual que se hizo con `reconciliacion.html`.
- Servicios nuevos en `src/services/personal*.js`.

## 6. Riesgos

1. **La foto de la regla en la prenómina.** Sin instantánea, una prenómina
   pagada cambia sola cuando alguien edita una política. Es el riesgo que más
   caro sale y va desde la fase 1 de prenómina.
2. **Doble contabilización.** Incidencias, préstamos y periodos solapados. Se
   ataca con unicidad en base, no con comprobaciones en la aplicación.
3. **El gasto duplicado en Finanzas.** Vínculo único entre gasto y periodo, y
   reintento idempotente.
4. **Crecimiento de la base por las fotos.** Retención configurable desde el
   día uno, aunque el borrado automático llegue después.
5. **Privacidad.** Aviso previo antes de activar selfies, y ninguna afirmación
   de verificación biométrica: se guarda una foto, no se reconoce a nadie.

## 7. Fases (cada una con pruebas y commit)

1. Activación del módulo + `personal_empleados` + alta/edición/baja lógica +
   aislamiento y permisos. **Sin nada más.**
2. Horarios y asignaciones, con jornadas que cruzan medianoche.
3. Reloj checador y evidencias: secuencia, idempotencia, cámara.
4. Asistencias calculadas y vista diaria.
5. Incidencias.
6. Prenómina y estados.
7. Integración con Finanzas.
8. Dashboard.

## 8. Decisiones del negocio que NO voy a inventar

Se dejan como configuración explícita, vacía y pendiente:

- Si un retardo o una falta descuentan, y cuánto.
- Tolerancia de retardo en minutos.
- Duración esperada de descansos y si se pagan.
- Si las horas adicionales se pagan y a qué tarifa.
- Periodicidad predeterminada e inicio de semana.
- Retención de fotografías en días.
- Sueldos, puestos y datos de personas reales.

Mientras no estén definidas, el cálculo **muestra los conceptos y no aplica
ningún descuento**. Es preferible una prenómina que dice "esto no está
configurado" a una que descuenta dinero por una regla que nadie autorizó.
