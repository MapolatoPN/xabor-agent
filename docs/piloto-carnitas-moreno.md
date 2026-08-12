# Piloto Carnitas Moreno — plan de instalación y validación de dos impresoras

**Estado: preparación. Nada instalado, ningún pairing generado, producción
intocada.** Base validada: instalador v1.1.0 (SHA256
`10D69E115273E6F6D8AE83B4F3CF69AE63B24CC8D61D83F1390FADC90BE9829B`),
backend `5e93537`, piloto de Acuña GREEN post-reboot con UNA impresora.

**El riesgo nuevo y único de esta visita: routing físico con DOS
impresoras, en especial routing por categoría. Nada de eso está validado
en hardware real todavía — Acuña solo validó destino simple con una.**

## 1. Estado actual de Carnitas Moreno (verificado en producción, solo lectura, 2026-08-12)

| Dato | Valor |
|---|---|
| Negocio | `Carnitas Moreno` (`fd75dfd0-35fc-42cf-a7ac-b052dec30e14`), activo |
| Sucursal | 1: `Principal` (`83c65caa-da1b-4bb3-8b2a-2364e8033788`), activa |
| Terminales | **0** — sin terminal previa, sin fantasmas ni duplicados |
| Impresoras registradas | **0** |
| Rutas de impresión | **0** |
| Emparejamientos previos | **0** |
| Trabajos de impresión | **0** |
| Módulo `impresion` | `pendiente` (no activo todavía) |
| Módulo `pos` | activo |
| Menú | 4 categorías: Carnitas (4 prod.), Tacos (2), Chicharron Regio (4), Bebidas (1) |

## 2. Terminal recomendada

**Crear terminal NUEVA** — no hay nada que re-emparejar: cero terminales,
cero emparejamientos. No existe riesgo de duplicado porque no hay original.
Nombre sugerido: `PC-CARNITAS-CAJA` (mismo patrón que Acuña).

## 3. Plan de pairing (flujo normal de UI, sin PowerShell frente al cliente)

1. Nosotros (antes o durante, desde el panel admin de Carnitas):
   Config → Impresoras → **"Conectar equipo"** → crea la terminal y genera
   el código (un solo uso, caduca en minutos — generarlo cuando la PC ya
   esté lista, no antes de salir de casa).
2. En la PC del restaurante: doble clic al Setup → escribe el código y el
   nombre del equipo → Instalar → listo.
3. El código viaja en claro UNA vez y no se guarda; si caduca o se pierde,
   se genera otro desde el mismo botón, sin costo.

**NO generar ningún código todavía** — se genera en sitio.

## 4. Mapa impresora física ↔ nombre de Windows — NO VALIDADO

| Impresora física | Conexión piloto | Nombre Windows esperado | Estado |
|---|---|---|---|
| SUZWIP 58 mm (USB/BT) | **USB** (no Bluetooth en el piloto) | desconocido — suele ser algo como `POS58`, `POS Printer 58mm`, o el nombre del driver genérico | **NO VALIDADO** |
| OFICHIDO OS518 58 mm | USB | desconocido — mismo caso | **NO VALIDADO** |

El nombre comercial casi nunca es el nombre del spooler. **Riesgo real:
ambas son térmicas de 58 mm genéricas y pueden instalarse con el MISMO
driver y nombres casi idénticos** (`POS58 Printer`, `POS58 Printer (Copy 1)`).
Parte del trabajo en sitio es identificar físicamente cuál es cuál: mandar
test page de Windows a una, ver cuál escupe papel, anotar. No asumir.

## 5. Plan Cocina / Caja

- SUZWIP u OFICHIDO → **Cocina** (58 mm) — la que esté físicamente en cocina.
- La otra → **Caja / Ticket** (58 mm).
- Asignación desde Config → Impresoras (self-service), ancho **58 mm**
  (→ 32 columnas). Primero destino simple; categorías después y solo si
  los gates 1-6 pasan.

## 6. Prueba de routing (el gate nuevo)

Preparación en el panel (solo si A y B individuales ya imprimieron):

- Caso A — destino simple Cocina: prueba de impresión a la impresora
  Cocina → papel SOLO en Cocina.
- Caso B — destino simple Caja: ticket → papel SOLO en Caja.
- Caso C — routing por categoría (el crítico):
  1. Regla `ambito=categoria`, clave `Bebidas` → impresora **Caja**.
  2. Sin regla de categoría para `Carnitas` (cae al defecto `comanda` → Cocina).
  3. Comanda de prueba con 2 items: 1 producto de `Carnitas` + 1 de `Bebidas`.
  4. Esperado físico: **hoja de Carnitas sale en Cocina, hoja de Bebidas
     sale en Caja, una hoja por impresora, cero duplicados.**
  - El motor (`routingEngine.js`) resuelve: categoría específica gana;
    lo sin regla cae al defecto de `comanda`; misma impresora nunca
    imprime dos veces el mismo item. Eso está probado en unit tests —
    lo que NO está probado es el papel real. GREEN solo con papel.

## 7. Riesgos específicos de esta visita

1. **Drivers duplicados/idénticos** de las dos térmicas 58 mm genéricas
   (mismo driver → nombres confusos; identificar físicamente cuál es cuál).
2. **Routing por categoría jamás validado en hardware.**
3. Bluetooth de la SUZWIP: NO usarlo en el piloto; si el USB falla, es
   plan B explícito, no default.
4. Módulo `impresion` está `pendiente` — verificar al llegar que el panel
   de Config → Impresoras es accesible para el admin del negocio; si algo
   lo bloquea, activarlo desde Superadmin es cambio de configuración
   permitido (no es deploy).
5. Cortador: la OS518 y la SUZWIP pueden diferir en auto-corte; si el
   ticket "corta mal" es config del renderer/driver, no defecto del Edge.
6. SmartScreen avisará (Setup sin firma) — "Más información → Ejecutar de
   todas formas", explicado al cliente con naturalidad.

## 8. Checklist de visita

### FASE 1 — Preflight (antes de abrir el Setup)

| # | Chequeo | GO | STOP si |
|---|---|---|---|
| 1 | Windows 10/11 (winver) | 10+ | Windows 8 o anterior (Get-Printer no existe → discovery fallará) |
| 2 | Arquitectura x64 (Configuración → Sistema → Acerca de) | x64 | ARM o x86 (el Node empaquetado es x64) |
| 3 | Cuenta con permisos de administrador | sí | sin admin y sin nadie que conozca la clave |
| 4 | Espacio libre en C: | ≥ 2 GB | < 500 MB |
| 5 | Internet estable (abrir https://xabor.mx en el navegador) | carga | sin internet — el pairing no puede canjear |
| 6 | Windows Update sin reinicio pendiente | limpio | reinicio pendiente → reiniciar ANTES de instalar |
| 7 | Servicio Spooler corriendo (`services.msc` → Cola de impresión) | RUNNING | detenido y no arranca |
| 8 | Impresora A visible en Configuración → Impresoras | visible | no aparece → primero resolver driver, sin Xabor de por medio |
| 9 | Impresora B visible | visible | ídem |
| 10 | Nombre EXACTO de cada una anotado (y cuál es físicamente cuál) | anotado | nombres idénticos sin poder distinguirlas → renombrar en Windows primero |
| 11 | Test page de Windows en A → papel sale | sale | no sale → es problema de driver/hardware, NO instalar Xabor todavía |
| 12 | Test page de Windows en B → papel sale | sale | ídem |
| 13 | USB directo a la PC (sin hub si es posible) | directo | — (hub = anotarlo como riesgo) |

**Regla: si 8-12 no están en GO, la visita se convierte en "arreglar
impresoras en Windows", y Xabor se instala solo cuando Windows ya imprime
solo.** El test page de Windows es el deslinde: si Windows no imprime,
ningún software encima va a hacerlo.

### FASES 2-4 — Instalación (cliente-facing)

1. Setup ya copiado en la PC (USB), hash verificado ANTES de la visita o
   discretamente al llegar:
   `Get-FileHash <ruta> -Algorithm SHA256` = `10D69E11...829B`.
2. En el panel: Config → Impresoras → Conectar equipo → código en pantalla.
3. Doble clic al Setup como administrador → SmartScreen → continuar.
4. Escribir código + nombre `PC-CARNITAS-CAJA` → Instalar → Finalizar.
5. Validación discreta nuestra (PowerShell admin, fuera de la vista):
   - `sc.exe query XaborEdge` → RUNNING
   - `sc.exe qc XaborEdge` → LocalSystem, AUTO_START (delayed), dependencia Spooler
   - `Test-Path "C:\Program Files\Xabor\Edge\node\node.exe"` → True
   - config: `urlNube = wss://xabor.mx/ws/print-agent`, terminalId el recién creado (sin mostrar token)
   - log: `conexion.autenticada` con el terminalId correcto

### FASES 5-6 — Descubrimiento y asignación

1. Config → Impresoras: el equipo aparece conectado; la lista muestra las
   dos impresoras de Windows (si dice "Leyendo las impresoras…", se
   resuelve solo en segundos — es el comportamiento nuevo validado en Acuña).
2. Por cada impresora, EN ORDEN y de una en una:
   prueba física → papel → anotar nombre Windows ↔ aparato físico.
3. Solo cuando ambas imprimieron individualmente: asignar Cocina (58 mm)
   y Caja/Ticket (58 mm). Sin categorías todavía.

### FASE 7 — Routing (sección 6 de este documento)

### FASE 8 — Duplicados y fallback (no destructivo sin avisar)

- Repetir caso C: exactamente una hoja por impresora, cero popup de Chrome.
- Con autorización explícita en sitio: apagar la impresora de Cocina,
  mandar una comanda, verificar que el trabajo queda encolado con estado
  comprensible; encenderla y verificar que sale UNA vez (recuperación de
  cola validada en Acuña, pero con una sola impresora).

### FASE 9 — Reboot

Reiniciar Windows, no tocar nada: servicio solo, conectado, dos impresoras
visibles, discovery limpio, prueba Cocina y prueba Caja.

### FASE 10 — Operación controlada

Un pedido de práctica desde el POS con 1 item de Carnitas + 1 bebida:
comanda en Cocina, ticket en Caja, una copia de cada, `worker.enviado` en
logs, ACK correcto, cero popup.

## 9. Rollback / plan B

| Síntoma | Acción (configuración primero, nunca deploy) |
|---|---|
| Impresora no aparece en Windows | Problema de driver/USB: puerto distinto, reinstalar driver del fabricante. Xabor no participa todavía. |
| En Windows sí, en Xabor no | Botón de actualizar lista; verificar Spooler; revisar log del Edge (`impresoras.enumeracion`); si el equipo acaba de arrancar, esperar los segundos del "consultando". |
| Imprime basura | Driver equivocado (usar el genérico ESC/POS del fabricante) o transporte mal asignado. Config, no código. |
| Corta mal | Config del driver (avance/corte) o ancho mal elegido; verificar 58 mm → 32 columnas. |
| Discovery se queda en "consultando" | Esperar el ciclo (~20 s max) y refrescar; revisar log del Edge; reiniciar el SERVICIO (services.msc), nunca a mano por consola frente al cliente. |
| Edge no conecta | Internet/firewall del local (¿portal cautivo? ¿bloqueo WSS?); ver log `conexion.abriendo`/`error`. |
| Servicio no arranca | Reiniciar Windows una vez; ver `edge.log`; si persiste, reinstalar con el MISMO Setup (repara sin pedir código nuevo — validado). |
| Routing manda a la impresora equivocada | Revisar reglas en Config (categoría vs defecto); corregir la regla y repetir. Es config. |
| Duplicados | Revisar reglas redundantes (la UNIQUE en DB ya lo impide por impresora); si es real y reproducible con reglas limpias: STOP, anotar, NO parchar en sitio. |
| Nada funciona y el negocio necesita operar | El POS sigue funcionando sin impresión Edge (el flujo de venta no depende de él). Desactivar la asignación y programar segunda visita. |

**Durante la visita: NO deploy, NO tocar producción más allá de la
configuración normal del negocio (pairing/impresoras/rutas de Carnitas),
NO migración 047.**

## 10. Criterio de aceptación (se llena en sitio)

| Ítem | Resultado |
|---|---|
| EDGE / SERVICIO | pendiente |
| IMPRESORA COCINA | pendiente |
| IMPRESORA CAJA | pendiente |
| ROUTING SIMPLE | pendiente |
| ROUTING POR CATEGORÍA | pendiente |
| REBOOT | pendiente |
| **CARNITAS MORENO** | **pendiente** |

Regla dura: GREEN de routing exige papel real en la impresora correcta.
Un YELLOW aceptable para operar como piloto parcial: ambas impresoras en
destino simple GREEN pero categoría pendiente (se opera con Cocina/Caja
simples y la categoría se activa en una segunda visita).
