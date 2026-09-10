# Mapolato Obispado — paridad con Wansoft

Qué cubre Xabor hoy de lo que hace Wansoft en Obispado, y qué falta. Se
actualiza después de cada fase.

Estado al **9 de agosto de 2026**, tras Xabor Edge V1.

> ## Auditoría del 9 de septiembre de 2026
>
> Hecha contra el código, no contra este documento. La tabla de abajo tenía un
> mes y **mentía en las dos direcciones**: daba por faltante algo que ya está
> hecho, y no registraba dos brechas que sí importan.
>
> **Ya no es cierto que falte:**
>
> - **Corte de turno.** Existe completo en `src/services/cortesCaja.js`:
>   movimientos, corte vivo, cierre con **efectivo contado**, ticket de corte y
>   fecha operativa con zona horaria. `fase-cortes-caja` 38/38. Era la brecha
>   que este documento llamaba "la más grande" y "lo que sostiene la
>   suscripción a Wansoft".
> - **UI de configuración de impresión.** Está (`Config → Impresoras`, commit
>   `7c89cc4`), con asistente de vinculación del equipo y rutas por categoría.
> - **Caja parcial.** Pagos divididos, métodos y propinas funcionan; con el
>   corte completo, "Caja" pasa a CUBIERTO salvo por el cajón (ver abajo).
>
> **Brechas que este documento no registraba y son bloqueantes:**
>
> - **El cajón de dinero no existe en el código.** Búsqueda en todo el repo: no
>   hay comando de pulso ESC/POS ni equivalente, ni en `edge/renderers/escpos.js`
>   ni en el print-agent legado. Toda coincidencia de "drawer" es el menú
>   lateral del panel en móvil. La caja principal de Obispado **no podrá abrir
>   el cajón desde el sistema**. O se implementa (es chico: va en el renderer y
>   en el ticket de caja) o se acepta explícitamente que se abre a mano.
> - **El inventario de las cuatro impresoras está vacío.** Las cuatro en
>   "PENDIENTE LEVANTAMIENTO EN SITIO": sin marca, IP, puerto, ancho de papel ni
>   confirmación de ESC/POS. No se puede configurar lo que no se ha medido.
>
> **Sobre la impresión, con más precisión que "EN MOCK":** el único piloto verde
> con hardware real es **Acuña, con UNA impresora y destino simple**. El piloto
> de dos impresoras (Carnitas Moreno) se planeó el 12 de agosto y su documento
> no se volvió a tocar. Obispado estrenaría **cuatro** con ruteo por categoría
> —chilaquiles aparte de cocina general—, que es exactamente lo que ese piloto
> iba a validar por primera vez.
>
> **Falsa alarma que conviene no repetir:** una corrida de la batería completa
> mostró `fase-restaurante-e2e-piloto` en 3/24, lo que parecía indicar que el
> módulo de restaurante no estaba listo. No era eso: eran dos aserciones
> desatrasadas (activaba `restaurante` sin `menu`, que hoy es dependencia). Con
> eso corregido, **24/24**. Aislados, el núcleo está sólido: mesas 28/28,
> operación 30/30, meseros 22/22, ruteo de impresión 20/20, cortes 38/38.
>
> **Sin conexión:** sigue siendo la brecha mayor, pero ya no está solo diseñada.
> Ver `xabor-edge-offline-diseno.md`: el motor local de sala, la sincronización
> idempotente y la foto del catálogo están construidos y probados (43 pruebas).
> Falta que las PCs de sala alcancen al Edge por la red local y el failover en
> el panel.
>
> **Veredicto:** no cancelar Wansoft todavía. Piloto en paralelo, decisión sobre
> el cajón, y levantamiento físico de las impresoras antes que nada.

## Escala de estados

| Estado | Significa |
|---|---|
| **CUBIERTO** | Funciona en producción y se ha usado de verdad |
| **PARCIAL** | Funciona, pero le falta algo para sustituir a Wansoft |
| **EN MOCK** | Implementado y probado, **sin hardware real todavía** |
| **PENDIENTE HARDWARE** | El código está; falta el levantamiento en sitio |
| **FALTA** | No existe |

## Tabla

| Capacidad | Estado | Detalle |
|---|---|---|
| **Meseros** | CUBIERTO | Login por PIN, estación en `/mesero/:slug`, permisos por rol |
| **Mesas** | CUBIERTO | Tablero con estados, apertura atómica, mover mesa |
| **Toma de orden** | CUBIERTO | Categorías, grid de productos, capturado en taps |
| **Modificadores** | CUBIERTO | Asistente por grupos, reglas de mínimo/máximo, extras con precio |
| **Rondas** | CUBIERTO | Solo lo pendiente sale en cada ronda; doble clic no duplica |
| **Comandas (digital)** | CUBIERTO | Numeradas, con snapshot, auditadas |
| **Impresión CHILAQUILES** | EN MOCK | Routing y transporte probados contra simulador. **Falta hardware** |
| **Impresión COCINA GENERAL** | EN MOCK | Ídem, incluido el caso de un item a dos destinos |
| **Impresión BEBIDAS** | EN MOCK | Ídem |
| **Impresión CUENTA** | EN MOCK | Va solo a TICKETS; probado que nunca cae en cocina |
| **Reimpresión** | EN MOCK | Crea trabajo nuevo, conserva el original, marca el papel |
| **Cola y reintentos** | EN MOCK | Cola persistente, backoff, recuperación tras reinicio |
| **Estado de impresoras** | EN MOCK | Pendientes, último error, lo que necesita atención |
| **Caja** | PARCIAL | Pagos divididos, métodos y propinas. Falta arqueo completo |
| **Corte de turno** | FALTA | Rama `feat/corte-propinas-por-metodo` pausada, sin integrar |
| **Operación sin internet** | FALTA | Solo diseñada: `docs/xabor-edge-offline-roadmap.md` |
| **Configuración por el admin** | PARCIAL | Menú, mesas y meseros sí. Impresión: backend listo, **falta UI** |
| **Ticket con logotipo del negocio** | FALTA | `/logo.png` es un archivo único para todos los negocios |
| **Facturación / CFDI** | FALTA | Nunca ha estado en alcance |

## Por qué la impresión NO está en CUBIERTO

Está probada de punta a punta —routing, cola, reintentos, ACK, aislamiento,
20 rondas concurrentes sin perder ni duplicar— pero **contra impresoras
simuladas**. Hasta que salga papel de las cuatro impresoras de Obispado, decir
"cubierto" sería falso.

Lo que puede fallar en sitio y no se puede saber antes:

- El modelo real no habla ESC/POS crudo, o quiere otro juego de comandos.
- El puerto no es el que suponíamos (por eso no hay ningún 9100 por defecto).
- El ancho de papel no coincide y el texto se corta.
- El corte de papel no responde al comando estándar.
- La red del local hace algo raro con las conexiones persistentes.

## Bloqueantes

### Antes de la prueba física

1. Levantar el inventario de las cuatro impresoras y de la PC
   (`docs/mapolato-obispado-inventario-impresoras.md`).
2. Desplegar la migración 043 y el código de Edge a producción (**no
   autorizado todavía**).
3. Confirmar que hay una PC que pueda quedarse encendida en el local.

### Antes de un piloto en paralelo con Wansoft

1. Test Print correcto en las cuatro impresoras.
2. Comanda demo con reparto múltiple, verificada en papel.
3. Prueba de resistencia: apagar una impresora, comprobar que las demás
   imprimen, encenderla y comprobar que sale **una sola vez**.
4. UI de configuración de impresión (hoy solo hay API).
5. Alguien del restaurante entrenado para leer el estado y reimprimir.

### Antes de cancelar Wansoft

1. Piloto en paralelo estable varios días, con volumen real.
2. **Caja y corte de turno completos** — hoy es la brecha más grande.
3. Decisión sobre el modo sin conexión: o se implementa, o se acepta
   explícitamente que sin internet no se toman pedidos.
4. Ticket con el logotipo de cada negocio.
5. Plan de vuelta atrás documentado y probado: qué se hace si Xabor falla un
   sábado a las 14:00.

## Lo siguiente, en orden

1. **Visita a Obispado**: levantamiento + prueba física.
2. **UI de configuración de impresión**: hoy el backend está y la interfaz no.
3. **Caja y corte**: la brecha real que sostiene la suscripción a Wansoft.
4. Ticket multi-negocio.
5. Recién entonces, el modo sin conexión.
