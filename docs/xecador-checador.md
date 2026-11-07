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
| B3 | Sin conexión: la tablet guarda y sincroniza; hora del servidor con reloj monotónico; PIN verificado al sincronizar | (por hacer) |
| B6 | Exportación básica por empleado y periodo (CSV y PDF) | (por hacer) |
| B4 | Cálculos: horas por día y semana contra la jornada, horas extra, máximo semanal por año configurable | (después) |
| B5 | Aceptación semanal del empleado | (después) |

## Orden de despliegue

Las migraciones van en el runner del Pre-Deploy (`scripts/predeploy-run-032-033.mjs`)
en orden: 127 → 128 → 129 → 130. Cada predeploy necesita a la anterior y falla
cerrado si no está. Para revertir: primero el código y después las migraciones
en orden inverso (130 → 129 → 128); cada reversa se niega a correr si ya hay
datos que se perderían.

Las reglas de cada tabla (CHECK y llaves) van fuera del `CREATE TABLE`: si
alguna falta, volver a aplicar la migración la repone (con el mismo nombre).

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
