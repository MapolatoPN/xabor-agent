# Contratos de salud, tiempos límite y observabilidad

## Tres endpoints, no uno (Parte 35)

Hoy hay un solo `/health` que devuelve `{status, listo}`. Propuesta:

| Endpoint | Responde | Se cae si… |
|---|---|---|
| `/health` | el proceso está vivo | solo si el proceso murió |
| `/readiness` | puede recibir tráfico | el arranque no terminó o la base no responde |
| `/dependencies` | estado por dependencia | nunca; es informativo |

Estados: `healthy`, `degraded`, `unready`.

**Regla:** una dependencia externa no debe tumbar el proceso. Que Meta no
responda es `degraded`, no `unready`: el panel, el POS y el restaurante siguen
funcionando. Si `/health` dependiera de Meta, un incidente de Meta haría que el
proxy reiniciara Xabor en bucle.

## Tiempos límite (Parte 36)

Auditado el árbol: hay llamadas a servicios externos (Meta, Resend, Clip,
Rappi) **sin tiempo límite explícito**. Un `fetch` sin `AbortSignal.timeout`
puede quedarse colgado hasta el límite del sistema operativo, reteniendo un
socket y una promesa.

| Servicio | Límite | Reintentos |
|---|---|---|
| Meta (enviar) | 10 s | vía outbox, con retroceso exponencial |
| Meta (marcar leído) | 5 s | ninguno; es cosmético |
| Resend | 10 s | 2, con retroceso |
| Clip | 15 s | ninguno; es dinero, se marca |
| Rappi | 10 s | 2 |

Ningún reintento infinito. Ninguna cola sin límite.

## Interruptores de circuito (Parte 37)

Sin librería por moda. Solo donde hay valor demostrado: si Meta falla N veces
seguidas, dejar de intentar un rato y acumular en el outbox en vez de saturar
el bucle de eventos con envíos que van a fallar. El outbox ya tiene el
retroceso exponencial; el interruptor es la siguiente vuelta.

## Contrapresión (Parte 38)

Una avalancha de webhooks no debe tumbar Xabor. El diseño ya ayuda: el webhook
solo persiste, que es barato y acotado. Los workers tienen concurrencia
limitada por el `limite` del claiming. La profundidad de la cola es observable.

## Métricas mínimas (Parte 48)

```
mode_local                        el Edge está en modo degradado
cloud_connected                   hay conexión con la nube
last_sync_at                      última sincronización correcta
pending_local_ops                 operaciones sin subir
sync_conflicts                    conflictos sin revisar
whatsapp_inbox_pending            eventos por procesar
whatsapp_outbox_pending           mensajes por enviar
whatsapp_oldest_pending_seconds   edad del más viejo  ← la que importa
cloud_worker_health               workers vivos
edge_last_seen                    última señal del Edge
```

`metricasWhatsapp()` ya devuelve las de WhatsApp. Las del Edge existen en
`journal.resumen()`.

## Alertas futuras (Parte 49)

Sin contratar nada esta noche. Umbrales propuestos:

| Alerta | Umbral | Por qué |
|---|---|---|
| Cola de entrada creciendo | más viejo > 5 min | un cliente esperando |
| Salida atascada | más viejo > 10 min | un cliente sin su confirmación |
| Conflictos sin revisar | > 0 durante 1 h | hay dinero esperando decisión |
| Edge sin aparecer | > 15 min en horario | el restaurante puede estar a ciegas |
| Retraso de sincronización | > 200 operaciones | el turno se acumula |
| Base inaccesible | inmediata | todo lo demás depende |

## Seguridad del plano local (Parte 50)

- El Edge escucha en la LAN, **nunca** en `0.0.0.0` sin autenticación.
- Endpoint operativo separado del de administración. La tablet no puede tocar
  configuración.
- Cada petición valida negocio y sucursal **contra el contexto local del
  Edge**, jamás contra identificadores que mande el cliente.
- CORS restringido a los orígenes de la LAN configurados.

## Datos en reposo (Parte 51)

Se cachea localmente lo mínimo: menú, mesas, verificadores de PIN, cuentas
abiertas del turno. **No** se guardan tokens de Meta, ni secretos de nube, ni
`PANEL_SECRET`, ni datos personales del cliente más allá de lo que la comanda
necesita.
