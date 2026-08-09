# Mapolato Obispado — inventario de impresoras

**Todo lo que dice PENDIENTE se levanta en sitio.** Nada de este documento se
ha rellenado por deducción: si un dato no está confirmado, está en blanco a
propósito. Una IP supuesta cuesta una tarde de visita.

Lo único que sabemos hoy es que existen **cuatro funciones físicas** y que
están en la red local del restaurante.

## Cómo llenar esto

Ver `docs/mapolato-obispado-prueba-impresoras.md`: lleva los comandos exactos,
todos de solo lectura. **No cambiar ninguna IP, no desinstalar Wansoft, no
hacer factory reset a ninguna impresora.**

---

## 1. TICKETS / CUENTA

| Campo | Valor |
|---|---|
| Función | Cuenta del cliente (la que se lleva a la mesa) |
| Marca | PENDIENTE LEVANTAMIENTO EN SITIO |
| Modelo | PENDIENTE LEVANTAMIENTO EN SITIO |
| IP | PENDIENTE LEVANTAMIENTO EN SITIO |
| Puerto | PENDIENTE LEVANTAMIENTO EN SITIO |
| MAC | PENDIENTE LEVANTAMIENTO EN SITIO |
| Ancho (58/80 mm) | PENDIENTE LEVANTAMIENTO EN SITIO |
| ESC/POS | PENDIENTE LEVANTAMIENTO EN SITIO |
| RAW TCP | PENDIENTE LEVANTAMIENTO EN SITIO |
| LPR | PENDIENTE LEVANTAMIENTO EN SITIO |
| Driver Windows | PENDIENTE LEVANTAMIENTO EN SITIO |
| Nombre en Windows | PENDIENTE LEVANTAMIENTO EN SITIO |
| Ubicación física | PENDIENTE LEVANTAMIENTO EN SITIO |
| Cómo la usa Wansoft | PENDIENTE LEVANTAMIENTO EN SITIO |
| Observaciones | |

## 2. CHILAQUILES

| Campo | Valor |
|---|---|
| Función | Estación de chilaquiles |
| Marca | PENDIENTE LEVANTAMIENTO EN SITIO |
| Modelo | PENDIENTE LEVANTAMIENTO EN SITIO |
| IP | PENDIENTE LEVANTAMIENTO EN SITIO |
| Puerto | PENDIENTE LEVANTAMIENTO EN SITIO |
| MAC | PENDIENTE LEVANTAMIENTO EN SITIO |
| Ancho (58/80 mm) | PENDIENTE LEVANTAMIENTO EN SITIO |
| ESC/POS | PENDIENTE LEVANTAMIENTO EN SITIO |
| RAW TCP | PENDIENTE LEVANTAMIENTO EN SITIO |
| LPR | PENDIENTE LEVANTAMIENTO EN SITIO |
| Driver Windows | PENDIENTE LEVANTAMIENTO EN SITIO |
| Nombre en Windows | PENDIENTE LEVANTAMIENTO EN SITIO |
| Ubicación física | PENDIENTE LEVANTAMIENTO EN SITIO |
| Cómo la usa Wansoft | PENDIENTE LEVANTAMIENTO EN SITIO |
| Observaciones | Recibe los chilaquiles **además** de cocina general |

## 3. COCINA GENERAL

| Campo | Valor |
|---|---|
| Función | Cocina general (ve todo lo de comer) |
| Marca | PENDIENTE LEVANTAMIENTO EN SITIO |
| Modelo | PENDIENTE LEVANTAMIENTO EN SITIO |
| IP | PENDIENTE LEVANTAMIENTO EN SITIO |
| Puerto | PENDIENTE LEVANTAMIENTO EN SITIO |
| MAC | PENDIENTE LEVANTAMIENTO EN SITIO |
| Ancho (58/80 mm) | PENDIENTE LEVANTAMIENTO EN SITIO |
| ESC/POS | PENDIENTE LEVANTAMIENTO EN SITIO |
| RAW TCP | PENDIENTE LEVANTAMIENTO EN SITIO |
| LPR | PENDIENTE LEVANTAMIENTO EN SITIO |
| Driver Windows | PENDIENTE LEVANTAMIENTO EN SITIO |
| Nombre en Windows | PENDIENTE LEVANTAMIENTO EN SITIO |
| Ubicación física | PENDIENTE LEVANTAMIENTO EN SITIO |
| Cómo la usa Wansoft | PENDIENTE LEVANTAMIENTO EN SITIO |
| Observaciones | Es la que más volumen recibe: conviene confirmar que su papel aguanta el turno |

## 4. BEBIDAS

| Campo | Valor |
|---|---|
| Función | Barra / bebidas |
| Marca | PENDIENTE LEVANTAMIENTO EN SITIO |
| Modelo | PENDIENTE LEVANTAMIENTO EN SITIO |
| IP | PENDIENTE LEVANTAMIENTO EN SITIO |
| Puerto | PENDIENTE LEVANTAMIENTO EN SITIO |
| MAC | PENDIENTE LEVANTAMIENTO EN SITIO |
| Ancho (58/80 mm) | PENDIENTE LEVANTAMIENTO EN SITIO |
| ESC/POS | PENDIENTE LEVANTAMIENTO EN SITIO |
| RAW TCP | PENDIENTE LEVANTAMIENTO EN SITIO |
| LPR | PENDIENTE LEVANTAMIENTO EN SITIO |
| Driver Windows | PENDIENTE LEVANTAMIENTO EN SITIO |
| Nombre en Windows | PENDIENTE LEVANTAMIENTO EN SITIO |
| Ubicación física | PENDIENTE LEVANTAMIENTO EN SITIO |
| Cómo la usa Wansoft | PENDIENTE LEVANTAMIENTO EN SITIO |
| Observaciones | |

---

## PC donde correría Xabor Edge

| Campo | Valor |
|---|---|
| Nombre del equipo | PENDIENTE LEVANTAMIENTO EN SITIO |
| Sistema operativo | PENDIENTE LEVANTAMIENTO EN SITIO |
| Versión de Windows | PENDIENTE LEVANTAMIENTO EN SITIO |
| CPU | PENDIENTE LEVANTAMIENTO EN SITIO |
| RAM | PENDIENTE LEVANTAMIENTO EN SITIO |
| IP | PENDIENTE LEVANTAMIENTO EN SITIO |
| Ethernet o WiFi | PENDIENTE LEVANTAMIENTO EN SITIO |
| ¿Siempre encendida? | PENDIENTE LEVANTAMIENTO EN SITIO |
| ¿Hay usuario administrador disponible? | PENDIENTE LEVANTAMIENTO EN SITIO |
| ¿Wansoft corre en esta misma PC? | PENDIENTE LEVANTAMIENTO EN SITIO |
| Firewall / antivirus | PENDIENTE LEVANTAMIENTO EN SITIO |
| Versión de Node instalada | PENDIENTE LEVANTAMIENTO EN SITIO |
| ¿Se puede instalar como servicio de Windows? | PENDIENTE LEVANTAMIENTO EN SITIO |

**Por qué importa la versión de Node**: con 22.5 o superior, el Edge usa
SQLite integrado. Con menos, cae al almacén JSON — funciona igual, solo es
menos eficiente con colas muy grandes. En ningún caso hay que compilar nada.

**Por qué importa "siempre encendida"**: si la PC se apaga por la noche, las
comandas pendientes esperan en la nube y salen cuando vuelva. Nada se pierde,
pero nadie imprime mientras tanto.

**Por qué importa si Wansoft corre ahí**: durante el piloto en paralelo los
dos sistemas convivirán. Xabor Edge no toca los drivers ni el spooler que use
Wansoft — se conecta por TCP a las impresoras — pero conviene saberlo antes.
