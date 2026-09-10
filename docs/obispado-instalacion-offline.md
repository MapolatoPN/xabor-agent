# Obispado — instalación del modo sin internet

Qué hay que poner en cada máquina y qué hay que probar en sitio. Estado al
**9 de septiembre de 2026**, rama `offline/sala-v1`, **sin desplegar**.

> **Esto todavía NO demuestra que Obispado pueda operar sin internet.** El
> recorrido completo pasa contra impresoras y cajón **simulados**. Lo que falta
> es exactamente lo que no se puede hacer desde aquí: la prueba física.

## La instalación

| Estación | Rol | Qué corre |
|---|---|---|
| Caja principal | **Cobra TODO**, sin excepción | **Xabor Edge** + panel |
| Meseros 1 y 2 | Solo capturan | Solo navegador |
| Para llevar | **Solo captura** — no cobra | Solo navegador |
| 4 impresoras | Chilaquiles · Cocina general · Bebidas · Tickets | En red por switch |
| Cajón de dinero | Conexión física **sin confirmar** | Se asume colgado de la impresora de tickets por RJ11; **hay que verificarlo en sitio** |

> **Para llevar NO cobra.** Toma el pedido y lo manda a cocina; el cliente paga
> en la caja principal, igual que una mesa. Si el sistema le permitiera cobrar
> ahí, habría dinero entrando por dos puntos y el arqueo dejaría de cuadrar.
>
> **El cajón no está confirmado físicamente.** Se asume colgado de la impresora
> de tickets porque es lo habitual, pero nadie ha mirado el cable. Si estuviera
> colgado de otra impresora —o conectado por USB a la PC— el pulso ESC/POS no
> lo abre y hay que rehacer esa parte. Es de las primeras cosas que mirar.

**El Edge va en la caja** por dos razones: es la máquina que se queda encendida
y es la que tiene el cajón. Si esa PC se apaga durante un corte, la sala se
para igual — la cola sobrevive en disco, pero mientras está apagada no hay a
quién hablarle.

## La regla del navegador que decide todo

Una página servida por **https** no puede hacer `fetch` a **http**: el
navegador lo bloquea como contenido mixto y **no hay forma de pedir permiso
desde el código**. La única excepción del estándar es `localhost`.

Consecuencia directa:

- **Caja**: el Edge corre ahí, llega por `http://localhost:7071`. Funciona
  desde `https://xabor.mx` sin hacer nada.
- **Meseros y para llevar**: **no** pueden alcanzar `http://192.168.x.x:7071`
  desde `https://xabor.mx`, por más que la red esté perfecta y cableada.

Por eso el Edge sirve **también el panel**. Durante un corte, esas tres
estaciones abren `http://<ip-de-la-caja>:7071/` y ahí todo es del mismo origen.

## Qué configurar en cada máquina

### Caja principal

1. Instalar **Node 18+** (con 22.5+ usa el SQLite integrado; con menos, un JSON
   con escritura atómica — los dos funcionan y ninguno compila nada).
2. Generar el código de emparejamiento en **Config → Impresoras → Conectar
   equipo** y correr el instalador del Edge.
3. **IP fija** o reserva por DHCP en el router. Si la IP del Edge cambia, las
   otras tres estaciones se quedan sin modo local.
4. Abrir el puerto **7071/TCP** en el Firewall de Windows para la red privada.
5. Comprobar: `http://localhost:7071/local/salud` responde con el `negocioId`.

### Meseros 1 y 2, y para llevar

1. Nada que instalar. Solo el navegador.
2. **Marcador "Xabor local"** apuntando a `http://<ip-de-la-caja>:7071/`.
   Es lo que se abre cuando no hay internet.
3. Abrir el panel normal (`https://xabor.mx/app`) al menos una vez **con
   internet**, para que el service worker cachee la pantalla.

### En el panel, antes del corte

- Cada mesero y la caja necesitan **PIN** (Usuarios). Sin PIN no hay sesión
  local: la foto del catálogo solo lleva a quien tiene uno.
- El rol importa: `mesero` captura, `cajero`/`admin` cobra.
- **Config → Impresoras**: las cuatro registradas, con su ruta por categoría,
  y la casilla **Cocina** marcada donde toque.

## Pruebas físicas — impresoras

Con Wansoft **encendido y sin tocar**, fuera del servicio al público.

1. **Test Print en las cuatro.** Anotar marca, modelo, IP, puerto y ancho de
   papel en `mapolato-obispado-inventario-impresoras.md`, que hoy está vacío.
2. **Ancho correcto**: que el texto no se corte. 80 mm ≈ 42 columnas, 58 ≈ 32.
3. **Acentos**: que "Chilaquiles con Jalapeño" salga legible (se manda en
   latin1).
4. **Corte de papel**: que corte solo al final del ticket.
5. **Ruteo por categoría** — lo que nunca se ha validado en hardware: una
   comanda con chilaquiles + un refresco + un platillo de cocina general tiene
   que salir en **tres** impresoras, cada una con lo suyo y nada más.
6. **Segunda ronda**: agregar un postre y mandar comanda. Debe salir **solo el
   postre**, no la ronda anterior.
7. **Resistencia**: apagar la impresora de bebidas, mandar una comanda mixta,
   comprobar que las otras imprimen. Encenderla y comprobar que lo pendiente
   sale **una sola vez**.
8. **Ticket de caja**: que la cuenta salga en TICKETS y **nunca** en cocina.

## Pruebas físicas — cajón de dinero

Es lo único del cajón que no se puede probar desde aquí.

1. **Cobro en efectivo** → el cajón abre mientras sale el ticket.
2. **Si no abre**: probar el otro pin. El código lo soporta (`pin: 0` es la
   patilla 2, `pin: 1` la 5) y depende de cómo esté cableado ese cajón. Es lo
   **primero** que hay que intentar.
3. **Precuenta** (la que se lleva a la mesa) → **no** debe abrir.
4. **Reimpresión** de un ticket ya cobrado → **no** debe abrir.
5. **Cobro con terminal bancaria** → **no** debe abrir.
6. **Cobro mixto** (tarjeta + efectivo) → **sí** debe abrir: hay que dar cambio.
7. **Comanda de cocina** → **no** debe abrir, jamás.

## Prueba física del corte

Fuera de servicio, con Wansoft intacto:

1. Abrir dos mesas desde los dos meseros.
2. **Desconectar el cable de internet del router** (no el switch: la red
   interna tiene que seguir viva).
3. Las tres estaciones abren su marcador "Xabor local" e inician con su PIN.
4. Capturar, mandar comandas, cobrar en caja, cerrar.
5. Reiniciar la PC de la caja a media mesa. Comprobar que al volver siguen ahí.
6. Reconectar internet. Comprobar que todo sube y que el corte del día cuadra.
