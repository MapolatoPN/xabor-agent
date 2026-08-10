# Resultados del caos

Semilla fija `20260810`. Reproducible:

```
SEED=20260810 node test/fase-resilience-chaos.mjs
```

## La prueba maestra

| Caso | Qué se simuló | Resultado |
|---|---|---|
| A | Nube sana, 100 operaciones | 100/100 sincronizadas, 0 rechazadas |
| B/C | Nube caída, 500 operaciones más, reinicio del Edge a mitad | el turno continuó; identidad y generación sobrevivieron |
| C | Journal completo tras el reinicio | 600/600 operaciones |
| C | Proyección reconstruida desde el journal | determinista, sin estado a medias |
| D | Vuelve la nube | 500 reconciliadas, **0 perdidas** |
| E | Reenviar el journal entero tres veces | **0 filas nuevas**, 0 aceptadas |
| F | Dos dispositivos offline en la misma mesa | 0 colisiones; aditivas fusionadas |
| F | Los dos cierran la misma cuenta | exactamente **1 conflicto**, visible |
| G | Edge que pierde su journal | amnesia detectada, con la última secuencia |
| H/J | 1000 webhooks, 341 duplicados inyectados | **1000 eventos lógicos** |
| H | Dos workers, 106 crashes inyectados | **0 procesados dos veces**, 0 perdidos |
| I | Todos los eventos en un estado explicable | 1000 procesados, ninguno evaporado |
| I | Fallo al persistir | visible: el webhook no puede contestar 200 |
| G-nube | Muere un worker de salida con 40 en vuelo | 80 enviados + 40 **inciertos** = 120 |

**18 de 18.** Cero promesas sin capturar en toda la ejecución.

## Los números que importan

```
restaurante: 100 online + 500 offline = 600 operaciones
reconciliadas 500 · duplicadas 0 · PERDIDAS 0
reinicios del Edge 1 · intentos de sync 7 (5 contra nube caída)
whatsapp: 1000 eventos lógicos · 341 duplicados inyectados · 106 crashes
conflictos pendientes de revisión: 1
```

## Separación honesta

Igual que en el gate de impresión, no se mezclan dos cosas distintas:

- **Duplicado lógico evitable: 0.** Ningún caso en que nuestra lógica creara
  dos veces la misma operación.
- **Caso ambiguo: 40 salientes `incierto`.** Sus workers murieron con el envío
  en vuelo. Meta pudo haberlos recibido o no; no hay forma de saberlo. Se
  marcan y los decide una persona. **No se maquillan como enviados.**

## Lo que este caos NO cubre

- No hay dos procesos de nube de verdad: los workers son concurrentes dentro
  del mismo proceso contra la misma base. El claiming con `SKIP LOCKED` sí es
  el mecanismo real, pero **no se probó el desplazamiento de WebSocket entre
  procesos distintos**.
- No se simula latencia ni partición parcial: la nube está viva o muerta, no
  lenta. Un Railway que responde en 14 segundos, que es lo que ocurrió de
  verdad, es un caso distinto y **no está cubierto**.
- No hay hardware. No salió papel.
