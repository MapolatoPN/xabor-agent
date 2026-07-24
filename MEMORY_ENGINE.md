# XABOR Memory Engine — Documento de Arquitectura
**Versión 1.1 — Julio 2026**
**Clasificación: Documento fundacional del producto**

---

## Principio Innegociable: Estabilidad Operacional Primero

> **El restaurante nunca deja de vender mientras evolucionamos el producto.**

Este principio tiene prioridad sobre cualquier nueva funcionalidad, fecha de entrega o decisión de arquitectura. No es negociable.

XABOR hoy procesa pedidos reales sobre un flujo crítico:

```
WhatsApp → IA → Pedido → Comanda → Impresión → Repartidor → Confirmación
```

Cada componente de ese flujo — `brain.js`, `whatsapp-meta.js`, `orderManager.js`, el panel de comandas, la impresión térmica, la notificación al repartidor — es infraestructura de producción activa. Una interrupción no es un bug de software. Es un restaurante que deja de vender.

### Reglas de desarrollo derivadas de este principio

**Antes de tocar cualquier componente crítico**, el desarrollador debe:
1. Identificar el riesgo explícitamente ("este cambio afecta el path de confirmación de pedidos")
2. Proponer una alternativa desacoplada si existe
3. Obtener aprobación del dueño antes de proceder

**Los cinco componentes protegidos** (requieren aprobación explícita antes de cualquier modificación):
- `brain.js` — lógica conversacional del agente
- `whatsapp-meta.js` — recepción y envío de mensajes
- `orderManager.js` — registro y estado de pedidos
- Panel de comandas (JavaScript de impresión y gestión de estados)
- `server.js` rutas de pedidos activos (`/pedidos`, `/pedidos/:id/estado`)

**Estrategia por defecto para nuevas funcionalidades:**
- Módulos nuevos en archivos nuevos — nunca modificar un archivo crítico para agregar una feature nueva si existe otra opción
- Feature flags en `configuracion` (tabla ya existente) para activar/desactivar sin redeploy
- Rutas API nuevas no bloquean las existentes
- Jobs en background nunca en el path síncrono de respuesta al cliente

**Protocolo ante duda:**
Si una funcionalidad no puede implementarse sin riesgo sobre los componentes protegidos, la respuesta correcta es: construir un módulo independiente primero, validarlo en producción sin afectar el flujo crítico, y solo entonces integrar.

---

## Prefacio: Una crítica antes de comenzar

Antes de diseñar, necesito objetar tres supuestos que aparecen en la visión inicial y que, si no se cuestionan ahora, crearán deuda arquitectónica seria.

**Objeción 1: "El agente aprende"**
El aprendizaje automático genuino requiere volumen de datos. Un restaurante con 30 pedidos diarios tardará meses en tener datos suficientes para que un modelo aprenda algo estadísticamente significativo. Si construyes "aprendizaje por restaurante", construirás algo frágil que funciona mal en los primeros 12 meses de cada cliente — exactamente cuando el producto necesita impresionar.

La solución correcta no es aprendizaje individual. Es **aprendizaje federado entre restaurantes**: patrones anónimos y agregados de toda la red XABOR que benefician a cada restaurante desde el primer día. Un restaurante nuevo ya sabe, gracias a otros 200, que los clientes que preguntan precio tres veces sin comprar tienen 78% de probabilidad de abandono. Ese es el moat real.

**Objeción 2: Las 11 entidades con memoria completa**
Proveedores, inventario, decisiones del negocio, configuraciones — tienen valor, pero no el mismo valor que clientes, productos y conversaciones. Construir memoria completa para todo desde el inicio es el camino más rápido al abandono del proyecto. La arquitectura debe tierar las entidades por ROI, no tratarlas igual.

**Objeción 3: "La memoria es el motor central"**
Filosóficamente correcto. Arquitectónicamente peligroso si se interpreta como "una tabla grande donde guardamos todo". La memoria debe tener tres capas distintas con responsabilidades distintas. Confundirlas produce un sistema lento, acoplado y difícil de escalar. El diseño de capas es la decisión más importante de este documento.

---

## I. El Concepto Central

XABOR no es un POS. No es un CRM. No es un chatbot.

**XABOR es el restaurante que nunca olvida.**

La premisa competitiva es esta: mientras cualquier otro sistema empieza desde cero cuando un cliente vuelve después de seis meses, XABOR ya sabe quién es, qué le gusta, cuánto gasta, cuándo compra y cómo tratarlo. Y mientras más tiempo usa un restaurante XABOR, más inteligente se vuelve. Eso crea un costo de cambio que no es funcional — es informacional. Nadie abandona su memoria.

El **Memory Engine** es la infraestructura que hace posible esa promesa. No es un módulo. Es la capa transversal que alimenta cada función del sistema.

---

## II. Las Tres Capas de Memoria

Este es el diseño más importante del documento. La memoria no es una tabla. Son tres capas con propósitos distintos.

```
┌─────────────────────────────────────────────────────────────┐
│  CAPA 3: MEMORIA APRENDIDA                                  │
│  Patrones, predicciones, scores, anomalías                  │
│  → Actualización: jobs nocturnos + eventos críticos         │
│  → Fuente: agregación cross-tenant (toda la red XABOR)      │
├─────────────────────────────────────────────────────────────┤
│  CAPA 2: MEMORIA COMPUTADA                                  │
│  Perfiles enriquecidos, segmentos, métricas calculadas      │
│  → Actualización: jobs programados cada N horas             │
│  → Fuente: Capa 1 de este restaurante                       │
├─────────────────────────────────────────────────────────────┤
│  CAPA 1: MEMORIA CRUDA (Event Log)                          │
│  Registro inmutable de todo lo que ocurrió                  │
│  → Actualización: tiempo real, en cada evento               │
│  → Fuente: todas las acciones del sistema                   │
└─────────────────────────────────────────────────────────────┘
```

### Capa 1 — Memoria Cruda (Event Log)

Un registro append-only e inmutable de cada evento que ocurre en el restaurante. Nunca se edita. Nunca se borra.

```
evento_id        UUID
restaurant_id    TEXT        ← multi-tenancy
tipo_evento      TEXT        ← 'pedido_confirmado', 'mensaje_enviado', 'cliente_regreso'...
entidad_tipo     TEXT        ← 'cliente', 'producto', 'empleado'...
entidad_id       TEXT        ← telefono, sku, nombre...
payload          JSONB       ← datos del evento (flexible)
ocurrido_at      TIMESTAMPTZ
sesion_id        TEXT        ← para agrupar conversaciones
canal            TEXT        ← 'whatsapp', 'rappi', 'presencial'
```

Esta capa es la fuente de verdad histórica. Todo lo demás se deriva de aquí. Si mañana quieres calcular una métrica que hoy no existe, puedes hacerlo porque tienes todos los eventos desde el primer día.

Ejemplo de eventos que se registran:
- `cliente_primer_contacto`
- `menu_solicitado`
- `precio_consultado`
- `pedido_iniciado`
- `pedido_confirmado`
- `pedido_cancelado`
- `pago_recibido`
- `cliente_no_respondio` (conversación abandonada)
- `mensaje_recuperacion_enviado`
- `cliente_reactivado`
- `producto_agotado_reportado`
- `descuento_aplicado`
- `queja_escalada`
- `campana_enviada`
- `campana_respondida`

### Capa 2 — Memoria Computada

Perfiles y métricas derivadas de los eventos. Se recalculan periódicamente. Son los datos que el agente consulta antes de responder y el dashboard muestra al dueño.

Esta capa vive en tablas relacionales normales. No es un sistema especial — es SQL inteligente corriendo sobre el event log.

Ejemplo para la entidad Cliente:
```
ticket_promedio          NUMERIC
total_gastado            NUMERIC
pedidos_total            INTEGER
dias_entre_compras_prom  NUMERIC
ultimo_pedido_hace_dias  INTEGER
dia_favorito             TEXT        ← 'viernes'
hora_favorita            INTEGER     ← 20 (8pm)
modalidad_favorita       TEXT
pago_favorito            TEXT
productos_favoritos      TEXT[]
acepta_promociones       BOOLEAN
sensibilidad_precio      TEXT        ← 'alta', 'media', 'baja'
segmento                 TEXT        ← 'nuevo', 'frecuente', 'vip', 'en_riesgo', 'dormido'
score_abandono           NUMERIC     ← 0-100, probabilidad de no volver
ultima_actualizacion     TIMESTAMPTZ
```

### Capa 3 — Memoria Aprendida

Patrones que emergen cuando se agregan datos de muchos restaurantes. Esta capa responde preguntas que ningún restaurante puede responder solo:

- ¿Qué tan probable es que un cliente que pregunta precios 3 veces sin comprar complete un pedido?
- ¿Qué tipo de mensaje de recuperación tiene mayor conversión un viernes por la noche?
- ¿Qué productos tienden a comprarse juntos en restaurantes con perfil similar?

Esta capa es el diferenciador que convierte XABOR en una plataforma, no solo en un producto. Empieza vacía y se vuelve más inteligente con cada restaurante que se incorpora.

**Importante**: los datos de esta capa son siempre anónimos y agregados. Nunca se expone información de un restaurante a otro. Un restaurante solo recibe el modelo aprendido, no los datos fuente.

---

## III. Entidades y su Memoria

Las entidades se agrupan en tres tiers por ROI de implementación.

### Tier 1 — Prioridad máxima (Fase 1-2)

Estas tres entidades generan el 90% del valor del Memory Engine.

#### CLIENTE
La entidad más importante del sistema. Cada número de WhatsApp es una relación comercial que debe comprenderse completamente.

**Qué recuerda:**
- Comportamiento de compra (frecuencia, ticket, horario, canal, modalidad)
- Preferencias de producto (favoritos, rechazados, nunca probados pero consultados)
- Sensibilidad comercial (responde a promociones, precio máximo histórico, reacción a aumentos de precio)
- Estado de relación (nuevo, activo, en riesgo, dormido, recuperado)
- Historial de comunicación (mensajes enviados, campañas recibidas, respuestas)
- Score predictivo de abandono y de conversión

**Señal crítica que la mayoría ignora:** la diferencia entre lo que el cliente *pregunta* y lo que *compra*. Un cliente que siempre pregunta por ensaladas pero nunca las pide es una oportunidad de upsell con fricción conocida. Esa fricción (precio, porción, duda) debe poder identificarse eventualmente desde los mensajes.

#### PRODUCTO
Cada producto tiene un ciclo de vida comercial que el sistema debe entender.

**Qué recuerda:**
- Demanda por horario, día de semana, temporada, clima (si se integra)
- Pares frecuentes (qué se pide junto)
- Tasa de recompra (¿el cliente vuelve por esto?)
- Impacto de cambios de precio en demanda
- Menciones sin compra (el cliente preguntó pero no pidió — fricción)
- Rentabilidad por canal (Rappi vs. WhatsApp vs. presencial)
- Tendencia (creciendo, estable, declinando)

#### CONVERSACIÓN
Cada conversación es una transacción comercial, tenga o no pedido final.

**Estados comerciales (no solo estados técnicos):**
```
primer_contacto       → Cliente escribió por primera vez
explorando            → Pidió menú o información
con_intencion         → Preguntó precio específico, confirmó dirección, nombró producto
en_proceso            → Pedido iniciado pero no confirmado
cerrada_con_venta     → Pedido confirmado
cerrada_sin_venta     → Conversación terminó sin pedido (oportunidad pendiente)
recuperada            → Volvió a comprar tras un seguimiento
```

El paso de `con_intencion` a `cerrada_sin_venta` es el evento más valioso que el sistema puede detectar. Es el carrito abandonado del restaurante.

### Tier 2 — Alta prioridad (Fase 2-3)

#### CAMPAÑA
Cada mensaje masivo enviado es un experimento. El sistema debe registrar qué se envió, a quién, cuándo, con qué resultado.

**Qué recuerda:**
- Segmento objetivo
- Texto del mensaje
- Tasa de apertura (respuesta)
- Tasa de conversión (pedido posterior en N horas)
- Ingreso generado atribuible
- Por qué funcionó o no (análisis posterior con IA)

El objetivo a largo plazo es que el sistema sepa, antes de enviar, cuál variante de mensaje tiene más probabilidad de convertir para un segmento dado.

#### EMPLEADO / OPERADOR DEL PANEL
El sistema observa cómo opera cada persona del equipo.

**Qué recuerda:**
- Velocidad promedio de cambio de estados (nuevo → preparando → listo → entregado)
- Tasa de cancelación durante su turno
- Descuentos aplicados y por qué
- Quejas durante su turno
- Pedidos atendidos por hora

**Advertencia**: esta entidad es políticamente sensible. Los datos de rendimiento de empleados deben diseñarse con cuidado — quién los ve, cómo se presentan, si los empleados son notificados. Construirla mal genera conflictos laborales. Construirla bien genera equipos más eficientes.

#### REPARTIDOR
Similar al empleado, pero con métricas de campo.

**Qué recuerda:**
- Tiempo promedio de entrega por zona
- Tasa de pedidos entregados vs. intentados
- Incidencias reportadas por clientes
- Disponibilidad y patrones de turno

### Tier 3 — Valor real, pero Fase 3-4

#### DECISIÓN DEL NEGOCIO
Esta es la entidad más subestimada y potencialmente la más poderosa a largo plazo.

Cada vez que el dueño toma una decisión relevante — sube un precio, cambia un proveedor, agrega un producto, modifica un horario — el sistema lo registra como un evento con fecha.

Tres meses después, cuando las ventas de cierto producto caen, el sistema puede correlacionar: "Las ventas de Chicken Louisiana bajaron 30% en las semanas posteriores al aumento de precio de $180 a $220 el 15 de marzo."

Ningún sistema hace esto hoy. El dueño nunca sabe por qué ocurrieron las cosas — solo que ocurrieron.

**Qué registra:**
- Tipo de decisión (precio, proveedor, menú, horario, promoción, contratación)
- Fecha y responsable
- Valor anterior y nuevo
- Justificación (campo de texto libre)
- Impacto medido N semanas después (calculado automáticamente)

#### PRODUCTO-PROVEEDOR / INVENTARIO
Relevante para operaciones, menos para ventas. Incluir en Fase 3 cuando la base de clientes y el motor comercial estén maduros.

#### SUCURSAL (Multi-location)
Aplica cuando un restaurante tiene múltiples ubicaciones. Permite comparación de desempeño entre sucursales. Diseñar desde el inicio en el schema (restaurant_id + branch_id) aunque la UI multi-sucursal llegue en Fase 4.

---

## IV. Flujo de Memoria en el Sistema

Este es el ciclo completo desde un evento hasta un insight.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EVENTO ENTRANTE: Cliente escribe un mensaje de WhatsApp
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
         │
         ▼
┌─────────────────────────────────────┐
│  1. IDENTIFICACIÓN                  │
│  ¿Quién es? Buscar en clientes      │
│  por número de teléfono             │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│  2. CONSULTA DE MEMORIA (Capa 2)    │
│  Cargar perfil completo:            │
│  - Historial de compras             │
│  - Productos favoritos              │
│  - Estado comercial actual          │
│  - Última conversación              │
│  - Segmento y score de abandono     │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│  3. ENRIQUECIMIENTO DE CONTEXTO     │
│  Construir system prompt dinámico   │
│  con la memoria del cliente +       │
│  patrones aprendidos (Capa 3)       │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│  4. RESPUESTA DEL AGENTE (GPT-4o)   │
│  Genera respuesta personalizada     │
│  Clasifica intención del mensaje    │
│  Detecta señales comerciales        │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│  5. REGISTRO EN EVENT LOG (Capa 1)  │
│  - mensaje_recibido                 │
│  - intencion_detectada              │
│  - respuesta_enviada                │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│  6. ACTUALIZACIÓN ASÍNCRONA         │
│  Job en background:                 │
│  - Recalcular estado conversación   │
│  - Detectar si hay oportunidad      │
│  - Actualizar último contacto       │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│  7. DASHBOARD SE ACTUALIZA          │
│  El panel del dueño refleja en      │
│  tiempo real el estado comercial    │
│  de cada conversación               │
└─────────────────────────────────────┘
```

**Principio crítico**: los pasos 1-4 deben ocurrir en menos de 2 segundos (en el path de respuesta del agente). Los pasos 5-7 ocurren de forma asíncrona y nunca bloquean la respuesta al cliente.

---

## V. Procesos en Segundo Plano

Los jobs son el sistema nervioso autónomo del Memory Engine. Se ejecutan sin intervención humana y convierten datos crudos en conocimiento.

### Jobs en Tiempo Real (event-driven, < 1 minuto)

| Job | Trigger | Acción |
|-----|---------|--------|
| `clasificar_intencion` | Cada mensaje recibido | Detectar intent y actualizar estado de conversación |
| `detectar_abandono` | Sin respuesta después de X minutos | Crear oportunidad pendiente, notificar al panel |
| `notificar_oportunidad` | Nueva oportunidad detectada | Badge en panel, alerta al dueño si es > $500 |

### Jobs Periódicos (cron, cada hora)

| Job | Frecuencia | Acción |
|-----|-----------|--------|
| `enriquecer_perfiles` | Cada 2h | Recalcular métricas de clientes activos del día |
| `detectar_clientes_riesgo` | Cada 4h | Score de abandono > 70: mover a segmento en_riesgo |
| `sincronizar_segmentos` | Cada 2h | Reclasificar clientes por actividad reciente |
| `monitorear_productos` | Cada 4h | Detectar caídas o picos de demanda inusuales |

### Jobs Nocturnos (cron, 2am CST)

| Job | Descripción |
|-----|-------------|
| `recalculo_full_perfiles` | Recalcular todas las métricas de todos los clientes |
| `generar_insights_dia` | Resumen del día: conversiones, oportunidades, anomalías |
| `segmentacion_completa` | Reclasificar toda la base de clientes |
| `analizar_campanas` | Calcular conversión de campañas enviadas en últimas 48h |
| `detectar_patrones_productos` | Identificar tendencias de demanda semana a semana |
| `preparar_sugerencias_gerente` | Generar las 3-5 acciones recomendadas para el día siguiente |
| `actualizar_modelos_cross_tenant` | Contribuir datos anónimos a la Capa 3 compartida |

### El Resumen Nocturno (el producto más importante)

Cada mañana, antes de que el dueño abra el panel, el sistema debe haber preparado una respuesta a la pregunta:

> *¿Qué hizo mi restaurante ayer y qué necesita de mí hoy?*

Este resumen no es un reporte de ventas. Es una agenda de decisiones. Ejemplo:

```
Buenos días. Ayer fue un buen día.

Ventas: $9,840 (+18% vs. el mismo día de la semana pasada)
Pedidos cerrados por el agente: 23
Clientes recuperados: 4 (+$1,680)

Lo que necesita tu atención hoy:
→ 9 oportunidades pendientes. 3 son clientes VIP.
→ Lesly Mireles lleva 18 días sin comprar. Compra cada viernes.
   Hoy es jueves. ¿Enviarle mensaje?
→ El Chicken Louisiana vendió 40% menos esta semana.
   Última vez que pasó fue cuando cambiamos el proveedor de pollo.
→ María (staff) tardó 45 min en promedio en marcar pedidos como listos ayer.
   El promedio del equipo es 18 min.
```

Eso es lo que diferencia a XABOR de cualquier POS: el sistema trabaja mientras el dueño duerme.

---

## VI. Arquitectura Multi-Tenant

XABOR como SaaS debe diseñarse para miles de restaurantes desde el primer día, incluso si hoy tiene uno.

### Principios de aislamiento

- Cada restaurante tiene un `restaurant_id` en todas las tablas
- Los perfiles de clientes, conversaciones y pedidos son siempre tenant-isolated
- Nunca se expone información de un restaurante a otro
- El número de teléfono de un cliente puede existir en múltiples restaurantes como entidades completamente independientes

### Inteligencia compartida (la ventaja de red)

La Capa 3 del Memory Engine es el espacio donde los restaurantes comparten conocimiento sin compartir datos:

```
Restaurant A  ──┐
Restaurant B  ──┼──► Anonymization ──► Agregación ──► Modelo compartido
Restaurant C  ──┘         │                                    │
                          │ (solo métricas, nunca datos crudos)│
                          └────────────────────────────────────┘
                                                               │
                          Todos los restaurantes reciben ◄─────┘
                          el modelo mejorado
```

Ejemplo concreto: cuando 500 restaurantes han registrado el patrón "cliente que pregunta precio 3 veces sin comprar", el modelo puede decirle al restaurante 501 — desde su primer día — cuál es la probabilidad de conversión de ese cliente y qué tipo de mensaje suele cerrar la venta.

### Consideraciones de privacidad

En México, la Ley Federal de Protección de Datos Personales (LFPDPPP) aplica. Esto no es opcional.

- Los números de teléfono son datos personales. Requieren aviso de privacidad y consentimiento.
- El historial de conversaciones es dato personal sensible.
- El aviso de privacidad debe mostrarse en el primer contacto del bot.
- Los clientes tienen derecho a solicitar eliminación de sus datos (derecho ARCO).
- La arquitectura debe soportar eliminación completa de un cliente sin corromper agregados históricos.

Diseñar esto desde el inicio es mucho más barato que cumplirlo después.

---

## VII. Roadmap por Fases

La priorización sigue un principio: impacto comercial primero, complejidad técnica después.

### Fase 1 — La Memoria Funciona (Meses 1-2)

**Objetivo**: el agente conoce a sus clientes y el dueño ve el estado comercial real.

Entregables:
- Event log table (`eventos`) implementada
- Job de enriquecimiento de perfiles (SQL sobre datos existentes)
- Inyección de contexto en `brain.js` (el agente recuerda)
- Segmentación básica: nuevo / frecuente / vip / en_riesgo / dormido
- Detección de conversaciones abandonadas (oportunidades pendientes)
- Tab "Clientes" en panel con ficha individual y estado comercial

Métrica de éxito: el agente saluda a Lesly por nombre y menciona su último pedido.

### Fase 2 — El Embudo Comercial (Meses 3-4)

**Objetivo**: XABOR muestra el ciclo completo de ventas, no solo los pedidos confirmados.

Entregables:
- Dashboard de gerente (conversiones, oportunidades, recuperaciones)
- Sistema de seguimiento manual (botón en panel para enviar mensaje de recuperación)
- Segmentación avanzada de clientes (filtros: VIP, dormidos, viernes-buyers, etc.)
- Campañas básicas: seleccionar segmento, redactar mensaje, enviar, medir
- Memoria de productos (productos favoritos, pares frecuentes, tendencias semanales)
- Score de abandono por cliente (predicción simple basada en días sin comprar)

Métrica de éxito: el dueño puede ver cuánto dinero potencial quedó sin cerrar ayer.

### Fase 3 — El Agente que Recomienda (Meses 5-8)

**Objetivo**: el sistema propone acciones, no solo muestra datos.

Entregables:
- Sugerencias proactivas diarias ("Lesly lleva 15 días sin comprar, ¿enviamos mensaje?")
- Seguimiento automático configurable (time-to-trigger, mensaje, descuento)
- Optimización de campañas (A/B de mensajes, mejores horarios de envío)
- Memoria de empleados (métricas de desempeño, presentadas con cuidado)
- Registro de decisiones del negocio (correlación cambios → impacto en ventas)
- Memoria de repartidores (tiempos, incidencias)
- Capa 3 inicial: primeros modelos cross-tenant con datos anonimizados

Métrica de éxito: una campaña sugerida por el sistema convierte mejor que una diseñada manualmente.

### Fase 4 — La Plataforma (Meses 9-14)

**Objetivo**: XABOR como sistema operativo completo del restaurante.

Entregables:
- Multi-sucursal (comparación de desempeño entre ubicaciones)
- Panel del gerente avanzado (benchmarks del sector: "tu tasa de conversión vs. restaurantes similares")
- API pública para integraciones (Rappi Analytics, Uber Eats, sistemas de contabilidad)
- Módulo de inventario con memoria (detección automática de faltantes basada en patrones de demanda)
- Gestión de proveedores con historial
- Reportes ejecutivos automatizados (PDF mensual para el dueño)
- Onboarding SaaS self-serve para nuevos restaurantes

Métrica de éxito: un restaurante puede incorporarse sin intervención del equipo XABOR.

### Fase 5 — La Red Aprende (Año 2+)

**Objetivo**: la red de restaurantes XABOR es más inteligente que cualquier restaurante individual.

Entregables:
- Modelos predictivos maduros entrenados en miles de restaurantes
- Demanda predictiva ("el próximo viernes de lluvia vende 40% más domicilios")
- Campañas completamente autónomas (el agente decide, ejecuta y mide sin intervención)
- XABOR Intelligence: insights de industria disponibles para todos los restaurantes
- Marketplace de automatizaciones (la comunidad comparte flujos exitosos)

Métrica de éxito: el valor del sistema crece sin que el equipo XABOR agregue features nuevas.

---

## VIII. Decisiones Arquitectónicas Críticas

Estas son las elecciones de diseño que más impactan el futuro del producto. Están documentadas aquí para que no se tomen por accidente.

### Event Sourcing desde el inicio

El event log no es opcional y no se agrega después. Si se construye la Capa 2 sin Capa 1, se pierde la capacidad de recalcular métricas históricas cuando se descubran nuevas preguntas de negocio. Toda la inteligencia futura depende de tener el historial crudo.

### Separar path de respuesta del agente de path de aprendizaje

El agente responde en < 2s. El aprendizaje puede tardar horas. Nunca poner lógica de recálculo en el path síncrono de respuesta. Usar colas o jobs asíncronos para todo lo que no es estrictamente necesario para enviar la respuesta al cliente.

### `restaurant_id` en todas las tablas, desde hoy

Aunque XABOR tenga un solo restaurante hoy, todas las tablas deben incluir `restaurant_id`. Agregarlo después requiere migración masiva y semanas de trabajo. Cuesta nada hacerlo bien desde el principio.

### No construir ML propio en Fase 1-2

GPT-4o con contexto bien construido es más que suficiente para los primeros 24 meses. El aprendizaje genuino llega en Fase 3-4 cuando hay suficientes datos. Intentar construir modelos propios antes tiene un costo de ingeniería enorme con retorno mínimo.

### La Capa 3 es el negocio SaaS, no el producto

Los modelos cross-tenant son lo que hace imposible que un restaurante replique XABOR internamente. Una API de GPT-4o + una base de datos cualquier desarrollador puede montarla. La red de datos anónimos de 1,000 restaurantes no se puede replicar. Proteger ese activo desde el diseño.

---

## IX. La Propuesta de Valor en Una Oración

Para el dueño del restaurante:

> *"Mientras tu restaurante opera, XABOR aprende. Mientras tú duermes, XABOR trabaja. Y mientras más tiempo lo usas, más inteligente se vuelve tu negocio."*

Para el inversionista o socio estratégico:

> *"XABOR construye el CRM de relaciones con clientes más rico del sector restaurantero en México, usando WhatsApp como canal primario y la IA como empleado comercial. El activo real no es el software — es la memoria acumulada de millones de interacciones entre restaurantes y sus clientes."*

---

*Este documento debe revisarse y actualizarse al inicio de cada fase. La arquitectura que no evoluciona se vuelve deuda.*

**Versión 1.0 — Mario Cantú & XABOR Engineering — Julio 2026**
