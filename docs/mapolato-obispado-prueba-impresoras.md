# Mapolato Obispado — procedimiento de levantamiento y prueba

Procedimiento para la visita. Todo lo de la fase 1 es **de solo lectura**: no
cambia una IP, no desinstala nada, no reinicia ninguna impresora.

## Reglas de la visita

- **No cambiar la IP de ninguna impresora.** Wansoft las tiene configuradas;
  cambiar una es dejar al restaurante sin imprimir.
- **No desinstalar ni detener Wansoft.** El piloto es en paralelo.
- **No hacer factory reset a ninguna impresora**, por más tentador que sea el
  botón de la parte de atrás.
- Si algo hay que cambiar, se anota y se decide fuera del horario de servicio.

---

## Fase 1 — Levantamiento (solo lectura)

### 1.1 Datos de la PC

```powershell
hostname
[System.Environment]::OSVersion.VersionString
node --version
ipconfig /all
```

Anotar en el inventario: nombre del equipo, versión de Windows, versión de
Node (si existe), IP y si es Ethernet o WiFi.

### 1.2 Qué hay en la red

```powershell
arp -a
```

Aparecerán las IP de la subred con su MAC. Las impresoras térmicas suelen
tener MAC de fabricantes reconocibles (Epson, Star, Xprinter, Bixolon). Anotar
todas las candidatas: **no** se prueba nada todavía.

### 1.3 Qué impresoras conoce Windows

```powershell
Get-Printer | Select-Object Name, DriverName, PortName, Shared
Get-PrinterPort | Select-Object Name, PrinterHostAddress, PortNumber
```

Aquí suele estar la respuesta completa: `PrinterHostAddress` es la IP y
`PortNumber` el puerto. Anotar el **nombre exacto** de cada impresora en
Windows — hace falta si más adelante se usa el transporte por spooler.

Alternativa por interfaz gráfica: *Panel de control → Dispositivos e
impresoras → clic derecho en la impresora → Propiedades de impresora →
pestaña Puertos*.

### 1.4 Identificar cuál es cuál

Si hay cuatro IP y no está claro cuál corresponde a qué estación, **usar la
función de prueba de Windows** (imprime la página de prueba del propio
driver), una por una, e ir a ver de qué impresora salió el papel. Pegar una
etiqueta física a cada una con su IP.

No usar todavía Xabor para esto: primero hay que saber qué es qué.

### 1.5 Confirmar que el puerto responde

Para cada IP y puerto anotados:

```powershell
Test-NetConnection -ComputerName 192.168.1.50 -Port 9100
```

`TcpTestSucceeded : True` significa que el puerto acepta conexiones. Si da
`False`, probar los otros puertos habituales (9100, 9101, 9102, 515 para LPR)
antes de dar la impresora por perdida. **Anotar el puerto real, no el
supuesto** — Xabor no asume el 9100 en ninguna parte.

### 1.6 Página de configuración de la impresora

La mayoría de térmicas imprimen su propia configuración —IP, MAC, velocidad,
ancho— manteniendo pulsado el botón de avance de papel mientras se enciende.
El procedimiento exacto depende del modelo; si no se conoce, **no insistir**:
los datos ya se obtuvieron en 1.3 y 1.5.

Llenar `docs/mapolato-obispado-inventario-impresoras.md` con lo levantado.

---

## Fase 2 — Instalar Xabor Edge

Solo cuando el inventario esté completo.

1. Instalar Node 22.5 o superior si no está (con menos también funciona; ver
   `edge/README.md`).
2. Copiar la carpeta `edge/` a la PC.
3. En el panel de Xabor: **Configuración → Impresión → Nuevo Edge**, poner el
   nombre del equipo y generar el **código de emparejamiento**.
4. En la PC: `node edge/setup.js` (o crear `edge/.env` con los datos que
   entrega el emparejamiento).
5. Arrancar: `node edge/index.js`. Debe aparecer `edge.listo` y
   `conexion.autenticada`.
6. En el panel: **Configuración → Impresión → Estado**. El Edge tiene que
   aparecer conectado.

---

## Fase 3 — Alta de impresoras y prueba física

Una por una, **en este orden**, y sin pasar a la siguiente hasta que la
anterior imprima:

1. Dar de alta `TICKETS` con su IP y puerto reales, transporte `tcp_raw`.
2. **Test Print** desde el panel. Comprobar que sale papel **de la impresora
   correcta** — el ticket dice a qué impresora y desde qué Edge salió.
3. Repetir con `CHILAQUILES`, `COCINA GENERAL` y `BEBIDAS`.

Si una no imprime, mirar el estado en el panel: dirá el último error.
`ECONNREFUSED` es puerto equivocado; `ETIMEDOUT` es IP equivocada o impresora
apagada.

---

## Fase 4 — Routing y comanda de prueba

4. Configurar las reglas en **Configuración → Impresión → Reglas**:
   - categoría *Fuertes* → COCINA GENERAL
   - categoría *Ensaladas* → COCINA GENERAL
   - categoría *Bebidas* → BEBIDAS
   - producto *Chilaquiles* → CHILAQUILES (modo **agregar**)
   - documento *cuenta* → TICKETS
5. Abrir una mesa de prueba y capturar la orden demo:
   1 chilaquiles (salsa verde, bistec, frijoles y papas, "sin cebolla"),
   1 ensalada, 2 coca-colas.
6. Mandar la comanda. Comprobar:

| Impresora | Debe salir |
|---|---|
| CHILAQUILES | 1 chilaquiles con sus cuatro modificadores y la nota |
| COCINA GENERAL | 1 chilaquiles + 1 ensalada |
| BEBIDAS | 2 coca-colas |
| TICKETS | **nada** |

7. Agregar un café y mandar la **segunda ronda**. Debe salir **solo el café**,
   en BEBIDAS. Si sale la comanda completa otra vez, parar y reportar.
8. Pedir la cuenta. Debe salir **solo** en TICKETS.

---

## Fase 5 — Prueba de resistencia (la que de verdad importa)

9. **Apagar CHILAQUILES.** Mandar una comanda con chilaquiles y una coca.
   - BEBIDAS debe imprimir.
   - El panel debe mostrar CHILAQUILES con pendientes y su último error.
   - **La comanda tiene que haberse guardado igual**: el mesero no puede ver
     un error por una impresora apagada.
10. **Encender CHILAQUILES.** Sin tocar nada más, debe imprimir sola en menos
    de un minuto.
11. Comprobar que salió **una sola vez**. Si salen dos papeles, parar y
    reportar: es el fallo más grave posible.
12. **Cerrar Xabor Edge** (Ctrl+C) con una comanda pendiente. Volver a
    arrancarlo. Debe terminar el trabajo pendiente, una sola vez.
13. **Desconectar el internet de la PC** treinta segundos y volver a
    conectarlo. El Edge debe reconectar solo y no perder nada.

---

## Qué anotar al terminar

- Qué funcionó a la primera y qué no.
- Tiempo entre mandar la comanda y que salga el papel.
- Si el ancho del papel es correcto (¿se corta el texto? ¿sobra margen?).
- Si la comanda se lee bien **desde donde está el cocinero**, no desde la mano.
- Cualquier diferencia con lo que imprime Wansoft hoy.
