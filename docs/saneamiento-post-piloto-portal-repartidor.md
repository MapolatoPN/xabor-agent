# Saneamiento post-piloto — Portal Operativo del Repartidor (2026-08-07)

Registro de las acciones de saneamiento tras el piloto controlado en
producción (deployment 6edfb515, commit 98c2758). Respaldo previo a toda
mutación: `C:\xabor-backups\pre-saneamiento-piloto-20260807-074839.dump`
(430 KB, 58 TABLE DATA verificadas con pg_restore -l).

## 1. Repartidores de prueba — DESACTIVADOS ✔

`UPDATE repartidores SET activo = FALSE` acotado por id + negocio + nombre:

- id 50 "Repartidor Piloto Portal" (Mapolato Acuña) → `activo=false`
- id 51 "Repartidor Piloto B" (Mapolato Acuña) → `activo=false`

`obtenerRepartidorPorToken` exige `activo = TRUE`, así que sus tokens
quedaron inválidos de inmediato (verificado contra producción: ambos
responden 401). Las filas se conservan para auditoría del piloto.
Reversible con `UPDATE ... SET activo = TRUE` si se quisiera repetir una
prueba. Los archivos temporales con los tokens y el localStorage del
navegador de prueba fueron borrados.

## 2. Tokens de repartidor — diagnóstico (SIN cambios)

El hallazgo del piloto ("un token antiguo seguía siendo válido") se
reformula tras revisar código y base:

- **No existe un "formato antiguo"**: TODOS los tokens de producción miden
  32 hex (`randomBytes(16).toString('hex')`, `database.js:2893`), incluidos
  los recién creados. 33 repartidores activos (31 Nonna Maye + los 2 del
  piloto ya desactivados), todos con este formato.
- El token hallado en el navegador era el del repartidor real id 45
  ("Mario Cantú", Nonna Maye), guardado en `localStorage` por una sesión
  anterior en esa máquina.
- **El problema real**: los tokens son credenciales permanentes — sin
  expiración, sin invalidación en servidor ("Salir" solo limpia el
  navegador), almacenados en claro en la tabla. Con 128 bits de entropía el
  riesgo no es adivinarlos, sino su persistencia en dispositivos
  compartidos.

Opciones propuestas (requieren autorización; las de código requieren
pruebas + deploy):

a. **Rotación puntual** del token del id 45 (un UPDATE; invalida la sesión
   actual de ese repartidor, que tendría que volver a entrar con su
   teléfono).
b. **Endpoint de logout real** (`POST /api/repartidor/logout` que rote el
   token) + rotación en cada login.
c. **Expiración** (columna `token_expira_at` + renovación en uso) y/o
   **hash en reposo** (guardar sha256 del token, como ya hacen las
   sesiones del panel).

## 3. PILOTO-0001 — RETENIDO (decisión pendiente de autorización)

Estado actual: `pedidos_activos`, `estado='entregado'`, notas
"PILOTO PORTAL REPARTIDOR — NO CLIENTE REAL". Ya está en el estado
terminal estándar (`archivarPedidoActivo` solo marca `entregado`; no hay
tabla de archivo separada).

Impacto medido: `obtenerVentas`/`obtenerResumenVentas` leen
`pedidos_activos` por rango de `created_at` excluyendo solo `cancelado` →
el pedido suma **$150 (+$50 envío) en cualquier reporte de Mapolato Acuña
cuyo rango incluya el 2026-08-07** (no solo el corte de hoy). Mapolato no
tiene ventas reales, así que no contamina ningún negocio operativo.

Opciones (ninguna ejecutada):

a. **Dejarlo** — auditoría intacta; $150 marcados como prueba en los
   reportes de Mapolato para siempre.
b. **Marcarlo `cancelado`** con `datos.cancelacion.motivo='PILOTO — no
   venta real'` — sale de ventas/corte conservando la fila; a cambio, la
   métrica de entregas del repartidor piloto (evidencia del piloto) baja a
   0 y un "entregado→cancelado" es semánticamente atípico.
c. **`eliminarPedido('PILOTO-0001')`** (mecanismo estándar de borrado
   admin) — desaparece de todo; se pierde la evidencia en base (este
   documento y el reporte del piloto quedarían como único registro).

Recomendación: (b) si la prioridad es reportes limpios, (a) si la
prioridad es auditoría. Nota: el teléfono ficticio 8787899919 también dejó
perfil en la memoria de clientes (solo recálculo interno; sin mensajes).

## 4. Plantilla inicial de WhatsApp para repartidores — propuesta ACTUALIZADA ✔

`docs/plantilla-nueva-servicio-reparto-v2-propuesta.md` estaba redactada
antes del hotfix de la oferta segura y contradecía la política desplegada:

- `{{3}}` decía `formatearUbicacionRepartidor()` con dirección CON número
  exterior — corregido a `formatearEntregaOferta()` (Col./calle **sin**
  número antes de aceptar, igual que el mensaje libre en producción).
- Ejemplos y fallbacks actualizados (`Zona por confirmar`, etc.).
- Paso 8 del plan de activación actualizado al flujo vigente: el GET
  muestra pantalla de revisión sin consumir token, la aceptación es POST,
  y tras aceptar existe "Ver mi entrega" → `/repartidor.html`.

Sigue **pendiente del propietario**: someter la plantilla a Meta (pasos
manuales en ese documento). Sin plantilla aprobada, la oferta solo llega a
repartidores con ventana de 24 h abierta.

## Restricciones respetadas

Sin deploy, sin merge, sin DELETE, sin tocar Meta/Clip/plantillas reales,
sin tocar Nonna Maye ni Carnitas Moreno; Corte con Propinas sigue pausada
(7434223). Cambios de datos en producción: únicamente el UPDATE de
`activo` de los 2 repartidores de prueba (sección 1).
