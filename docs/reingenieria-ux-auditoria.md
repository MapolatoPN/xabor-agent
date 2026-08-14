# Reingeniería UX — Auditoría del panel (2026-08-14)

Base: `02119db` (producción). Panel: `panel/index.html`, **7,274 líneas**, SPA de un
archivo con 18 tabs planos conmutados por `mostrarTab()` (divs `vista-*`).
Módulos por negocio vía `data-modulo` + `MODULOS` (GET /api/auth/me); roles
admin/staff vía clase `admin-only`. Bottom-nav móvil: comandas/POS/chats/corte.

## Mapa PANTALLA → FUNCIÓN → ENDPOINTS → DESTINO PROPUESTO

| Pantalla actual (vista) | Función | Endpoints principales | Destino propuesto |
|---|---|---|---|
| Comandas (`vista-comandas`, main) | Tablero de pedidos activos + programados + acciones (estado, cancelar, devolución, factura, pago) | WS panel, `/api/pedidos-programados`, `/pedidos/{id}/estado`, `/api/admin/pedido/{id}/*` | **OPERACIÓN → Pedidos activos** (misma vista, primera pestaña) |
| POS (`vista-presencial`) | Captura mostrador con cobro inmediato (efectivo/terminal/mixto, descuento, billete/cambio) | `/api/pedido-presencial`, `/api/menu` | **OPERACIÓN → captura** de modalidades *Para llevar* (cobro al crear) — deja de ser tab |
| Envíos (`vista-envios`) | Captura recoger/domicilio (cliente, teléfono, dirección, envío) + enlace de pago + repartidor | `/api/pos/envios`, `/api/pos/envios/{id}/enlace-pago`, `/{id}/solicitar-repartidor`, `/api/pos/pedidos` | **OPERACIÓN → captura** de *Recoger* y *Domicilio* — deja de ser tab |
| Restaurante (link `/restaurante`) | Mesas/meseros/cuentas (página aparte) | rutas `/api/restaurante/*` | **OPERACIÓN → modalidad Restaurante** (link desde el selector de modalidad; la página no se reescribe) |
| Corte (`vista-corte`) | Corte de caja | `/api/corte-caja`, fondo | **ADMINISTRACIÓN** |
| Chats (`vista-chats`) | Conversaciones WhatsApp + composer + fotos/PDF (WhatsApp CONGELADO) | `/api/conversaciones`, `/api/conversacion/*`, `/api/send-message`, `/api/imagenes/enviar`, `/api/documentos/enviar` | **CLIENTES → Chats** (sin tocar lógica) |
| Historial (`vista-historial`) | Pedidos entregados | `/api/historial` | **OPERACIÓN → Historial** (del ciclo del pedido) |
| Ventas (`vista-ventas`) | Reporte ventas/resumen | `/api/ventas*` | **ADMINISTRACIÓN** |
| Llamadas (`vista-llamadas`) | Llamadas + transcripciones (voz) | `/api/llamadas*` | **AUTOMATIZACIÓN** |
| Menú (`vista-menu`) | Editor de categorías/productos/modificadores/disponibilidad | `/api/admin/menu/*` | **CATÁLOGO** |
| Bot (`vista-entrenamiento`) | Entrenamiento/simulador del bot | `/api/admin/bot-simulador/*` | **AUTOMATIZACIÓN** |
| Estado (`vista-diagnostico`) | Diagnóstico técnico | `/api/admin/diagnostico`, checklist | **CONFIGURACIÓN → tarjeta Estado del sistema** (admin) |
| Config (`vista-config`) | *Scroll infinito*: negocio+horarios (`config-form`), operativa/atención (`reglas-form`), WhatsApp (`wa-autoservicio` — CONGELADO), menú automático (`wa-menu`), impresoras (`impresoras-panel`), Rappi (`int-form` + botón subir menú), bot on/off (`bot-whatsapp-form`), cotizaciones (logo/color/IVA), métodos de pago, SAT e.firma | `/api/config`, `/api/config/operativa`, `/api/config/whatsapp/menu*`, `/api/impresion/*`, `/api/admin/integraciones`, `/api/admin/rappi/subir-menu`, `/api/bot-whatsapp`, `/api/admin/metodos-pago`, `/api/admin/sat/*` | **CONFIGURACIÓN = portada de tarjetas** (ver abajo) + reubicaciones |
| Repartidores (`vista-repartidores`) | Roster + actividad | `/api/admin/repartidores*` | **OPERACIÓN → Repartidores** (son parte de la entrega) |
| Clientes (`vista-clientes`) | Clientes, oportunidades, campañas | `/api/admin/clientes*`, `/api/admin/campanas*` | **CLIENTES** |
| Rewards (`vista-rewards`) | Fidelidad | `/api/rewards/*` | **CLIENTES** |
| Cotizaciones (`vista-cotizaciones`) | Cotizaciones comerciales | `/api/cotizaciones*` | **CLIENTES** (relación comercial) |
| Usuarios (`vista-usuarios`) | Staff/roles/PIN | `/api/admin/usuarios*` | **ADMINISTRACIÓN** |

## Reubicaciones dentro de Config (portada de tarjetas)

| Tarjeta | Contiene (bloques actuales) | Estado de cobertura |
|---|---|---|
| Negocio | `config-form` (nombre, dirección, contacto, horarios) | ✓ si nombre+horarios |
| Operación | `reglas-form` (modalidades, preparación, entregas, zonas, políticas, atención automática on/off) | ✓ si reglas guardadas |
| Pagos | `metodos-pago-form` + proveedores de enlace | ✓ si ≥1 método habilitado |
| Integraciones | WhatsApp (**CONGELADO**, solo tarjeta), Rappi (`int-form`), IA (etiqueta "Inteligencia artificial", sin API keys visibles) | por integración |
| Facturación | SAT e.firma + Facturapi | ✓ si módulo configurado |
| Equipos e impresión | `impresoras-panel` (wizard Edge + multidestino) — sale de "config comportamiento" y se muestra como equipo | ✓/⚠ según `cobertura` |
| Documentos comerciales | `cfg-cotizaciones` (logo/color/vigencia) — solo si módulo | ✓ |
| Estado del sistema | `vista-diagnostico` embebido | — |

**Acciones operativas que salen de Config:** "Subir menú a Rappi" → CATÁLOGO
(junto al editor de menú); imágenes del menú automático (`wa-menu`) → CATÁLOGO
(es contenido del menú) con su lógica intacta; "pausar atención automática" →
AUTOMATIZACIÓN.

## El pedido (entidad única — auditado, NO se cambia backend)

- **Canales:** `whatsapp`, `voz`, `pos` (envíos), `presencial` (mostrador),
  `rappi`, `prueba_admin`. Gate LLM (`CANALES_ORDEN_LLM`) intacto.
- **Estados backend:** `nuevo → en_preparacion → listo → entregado | cancelado`
  (+ `pendiente_pago` del P0). Restaurante (mesas) maneja cuentas propias en
  `/restaurante`. **La UI traduce, no inventa estados.**
- **Modalidades backend:** `recoger en tienda` y `entrega a domicilio`
  (POS Envíos: tipo `recoger|domicilio`); mostrador = presencial (cobro al
  crear); restaurante = mesas. → El selector de modalidad mapea:
  *Restaurante* → `/restaurante`; *Para llevar* → captura presencial;
  *Recoger* → envíos tipo `recoger`; *Domicilio* → envíos tipo `domicilio`.
  Cero motores nuevos, cero duplicación de pedidos.

## Etiquetas de estado por modalidad (traducción visual)

- Para llevar/mostrador: Nuevo → En preparación → Listo → Entregado.
- Recoger: … → Listo **para recoger** → Entregado.
- Domicilio: … → Listo → (repartidor: Buscando/Asignado/En camino vía red v2) → Entregado.
- Restaurante: cuentas de mesa (página propia, sin cambios).

## Riesgos identificados antes de tocar

1. `mostrarTab` es el conmutador universal: se conserva; la nueva navegación
   solo agrupa los botones que lo llaman (cero cambios de lógica de vistas).
2. Los tests de contrato del panel (fase-impresion-*, fase-menu-*,
   fase-whatsapp-menu-automatico, fase-c-*) asertan literales del HTML:
   mover bloques de lugar es seguro; **renombrar funciones o borrar literales
   no lo es** — se moverán nodos DOM, no se reescribirán.
3. WhatsApp congelado: `wa-autoservicio` y toda su lógica se mueven de lugar
   en el DOM sin editar una sola línea de su JS.
4. Bottom-nav móvil mapea comandas/presencial/chats/corte — se actualiza a las
   nuevas áreas equivalentes.
5. Multi-tenant: todo pasa por `apiFetch` (sesión) — no se agrega ninguna
   llamada con negocioId de frontend.

## Estado de implementación (2026-08-14, rama feat/reingenieria-ux)

| Fase | Commit | Contenido |
|---|---|---|
| UX-2 Navegación agrupada | `1036976` | Sidebar por áreas (Operación/Catálogo/Clientes/Automatización/Administración/Configuración), mismos ids y permisos |
| UX-3 Pedido por modalidad + Inicio | `49adec9` | Botón primario "+ Nuevo pedido" (sidebar/Inicio/bottom-nav) → selector Restaurante/Para llevar/Recoger/Domicilio que rutea a la captura existente; vista Inicio con pedidos activos en vivo, ventas de hoy y cobertura de impresión |
| UX-4 Config por tarjetas | `bb04066` | Portada de 8 tarjetas con chips de cobertura ✓/⚠/○; bloques movidos intactos a subsecciones; wa-menu y "Subir menú a Rappi" → Catálogo; interruptor de atención automática → Automatización; WhatsApp movido sin tocar su JS |
| UX-4 contrato de tests | `b88fd0c` | fase-whatsapp-menu-automatico: el contrato del menú automático apunta a Catálogo |
| UX-5 estados por modalidad | `0928771` | etiquetaEstadoPedido: "Listo para recoger"/"Listo para enviar" según modalidad, solo visual, en vivo, no se imprime |

Verificación: 21 suites verdes (impresion-autoservicio 44, impresion-self-service 56,
whatsapp-menu-automatico 55, menu-multiimagen 16, seguridad-transaccional 18,
p0-aislamiento 29, whatsapp-coexistence 24, chat-imagenes 38, comanda-edge 23,
más el lote de contrato del panel), responsive desktop/tablet/móvil, gating
admin/staff y por módulos verificado con sesiones reales, 11 capturas de evidencia.
Sin deploy: pendiente de autorización.

## Revisión 2 (2026-08-14): Operación unificada y Pagos único

### Qué quedó UNIFICADO a nivel de producto

- **Entrada única al pedido:** "+ Nuevo pedido" (sidebar, Inicio, bottom-nav)
  → selector de modalidad. Mostrador y Envíos desaparecen del sidebar y del
  bottom-nav como destinos: el operador ya no elige módulos, elige cómo se
  atiende el pedido.
- **Cambio de modalidad en el lugar:** ambas capturas llevan el mismo
  encabezado con chips (Para llevar / Recoger / Domicilio / Mesas). Cambiar
  de chip cambia de captura sin volver al menú; `envTipo` mantiene los chips
  sincronizados con los botones internos de Envíos.
- **Retorno único:** "← Pedidos" en ambas capturas regresa al tablero
  (vista-comandas), que es el punto de seguimiento y cierre de todos los
  canales. Crear → seguir → cerrar ocurre sin nombrar módulos.
- **Pagos:** una sola ubicación (Configuración → Pagos): arriba los métodos
  reales (autoritativo, `metodos-pago-form`), abajo las notas e instrucciones
  de referencia de `reglas_atencion` (renderizadas ahí por `cargarReglasForm`
  con su propio botón de guardado). La sección Operación ya no menciona ni
  renderiza pagos.

### Qué permanece SEPARADO técnicamente (a propósito, cero backend tocado)

- `vista-presencial` y `vista-envios` siguen siendo vistas/motores de captura
  distintos (`/api/pedido-presencial` cobra al crear; `/api/pos/envios` crea
  con enlace de pago/repartidor). El encabezado compartido los presenta como
  un solo espacio; unificarlos en un solo formulario sería reescribir la
  captura y el riesgo no se justifica.
- `/restaurante` sigue siendo página aparte (workspace de mesas/meseros,
  misma UI que usan las tablets): el chip/tarjeta "Mesas" navega hacia allá.
- Las subvistas de Envíos (Nuevo pedido / Envíos activos / Historial) viven
  dentro de la captura de envíos; "Envíos activos" concentra acciones
  específicas de entrega (enlace de pago, solicitar repartidor) y se llega
  entrando a cualquier modalidad de envío.
- `reglas_atencion.pedidos.pago_aceptado`/`pago_instrucciones` siguen
  guardándose por `guardarReglas` en el mismo objeto de siempre — solo se
  RENDERIZAN en la sección Pagos (mismos ids; el guardado refleja feedback
  en ambos bloques).

### Hallazgos pre-existentes: resolución

- `pos-empty`: el id estaba duplicado entre el HTML estático y el re-render
  de `renderCarrito`, pero nadie lo referenciaba → se eliminó el atributo id
  (la clase `pos-order-empty` conserva los estilos).
- `wa-progreso`: FALSO duplicado — son dos plantillas de ramas mutuamente
  excluyentes dentro de `pintarWhatsappAutoservicio` (conectado vs no
  conectado); en el DOM solo existe una a la vez. Está dentro del código
  CONGELADO de WhatsApp y no se tocó; el contrato
  `fase-reingenieria-ux.mjs` fija que siga exactamente así.
- `bnav-corte`: ahora respeta `data-modulo="caja"` (negocios sin caja ya no
  lo ven en móvil).
- Secretos de desarrollo: `dev-local.cmd` ya no contiene valores; carga
  `dev-local.env.cmd` (en `.gitignore`, con `dev-local.env.example.cmd` como
  plantilla). Los valores que estuvieron commiteados eran del entorno local
  de pruebas (DB Docker), nunca de producción; quedan en el historial de la
  rama — reescribir historia pusheada requeriría force-push y no se hizo.
