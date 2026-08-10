# Hoja de ruta de resiliencia

Clasificación honesta. Lo probado en simulador no se cuenta como resuelto en
producción, y lo diseñado no se cuenta como hecho.

## Implementado y probado esta noche

| Qué | Dónde | Evidencia |
|---|---|---|
| Sincronización idempotente por `(negocio, operation_id)` | `src/services/syncService.js` | 18 casos + caos |
| Cuatro resultados explícitos, nunca un 200 ambiguo | ídem | casos 2, 3, 10, 13 |
| El duplicado devuelve el efecto original | ídem | caso 3 |
| Detección de conflictos con revisión humana | ídem | casos 10-12 |
| Rechazo de folio como identidad offline | ídem | caso 6 |
| Orden por secuencia, no por reloj | ídem | caso 15 |
| Detección de amnesia del Edge | ídem | caso 18 |
| Journal local durable con proyección reconstruible | `edge/journal/index.js` | caos B/C |
| Buzón de entrada durable con dedupe | `src/services/whatsappDurable.js` | 20 casos |
| Claiming distribuido con `SKIP LOCKED` y lease | ídem | casos 7-9 |
| Buzón de salida con estado `incierto` | ídem | casos 16-17 |
| Eventos huérfanos se guardan en vez de tirarse | ídem | casos 5-6 |
| Métricas de cola con edad del más viejo | ídem | caso 19 |
| Migración 044 aditiva | `migrations/044_…sql` | aplicada en base limpia |

## Diseñado, no implementado

1. **API local del Edge** para que la tablet opere contra la LAN.
2. **Caché de menú con versión** y actualización que no cambie la
   configuración a mitad de una comanda.
3. **PIN offline con TTL y versión**, con su limitación de revocación.
4. **Interfaz en modo degradado** con el indicador de modo.
5. **Revocación de sesiones distribuida** (hoy en memoria, P0 de seguridad).
6. **Folio calculado en la base** en vez de en el array de proceso.
7. **Desplazamiento de terminal entre procesos** — bloquea las réplicas.
8. **Rate limit y anti-replay de OAuth compartidos.**
9. **`/readiness` y `/dependencies`** separados de `/health`.
10. **Reescritura del handler del webhook** para usar el inbox.

## Requiere infraestructura

1. Ingreso de webhooks fuera de Railway.
2. Cola durable independiente.
3. Segunda región o segundo proveedor.
4. Réplica de Postgres y PITR verificado con una restauración real.
5. Monitoreo con alertas de verdad.

## Requiere hardware

Nada de esto se puede cerrar sin ir a Obispado: impresión física, prueba en la
PC real, piloto en turno.

## No cubierto

- Corte de caja offline (fuera de alcance por decisión).
- Clip sin conexión: **imposible**, requiere internet. Se marca no disponible
  sin bloquear el resto.
- Latencia y partición parcial: el caos simula caída total, no un Railway
  lento. El incidente real fue de lentitud.
- Semántica de reintentos de Meta: **bloqueado**, sin acceso a la documentación
  oficial en esta sesión.

## Orden recomendado

1. Reescribir el webhook para usar el inbox durable (mayor riesgo actual de
   pérdida real, y los cimientos ya están).
2. Revocación de sesiones distribuida (agujero de seguridad).
3. API local del Edge + PIN offline.
4. Interfaz en modo degradado.
5. Desplazamiento distribuido, y solo entonces plantearse réplicas.
6. Ingreso fuera de Railway.
