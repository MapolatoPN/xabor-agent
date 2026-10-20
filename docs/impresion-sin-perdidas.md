# Impresión sin pérdidas (Fase 0 de Configuración → Impresoras)

Rama `feat/impresion-sin-perdidas`, sobre `prod/mesero-shadow-v3` (a40144f, lo
que corre en producción el 20-oct-2026). Solo servidor y panel: se publica con
un despliegue de Railway y **no hay que tocar ninguna PC**.

## Qué pasó en Acuña

Lectura de producción del 20-oct-2026 (solo lectura):

- Las 12 categorías de Acuña apuntan a «POS Printer 203DPI Series 2», del
  equipo **PC-ACUNA-CAJA**, sin conexión desde el 8-sep. El equipo que
  imprime es **ACUÑA - CAJQA** (alta el 9-oct).
- La ruta por categoría gana sobre «Cocina», y nada revisaba si el equipo de
  la impresora estaba conectado. Del 5 al 13-oct, **~53 pedidos** mandaron
  su comanda solo al equipo apagado. El trabajo se quedó `pendiente` para
  siempre. El navegador no imprimió de respaldo, porque había trabajos. Y
  no hubo aviso: solo existía cuando no se creaba ningún trabajo.
- El 13-oct a las 22:10 alguien desactivó Series 2. El motor ignora las
  rutas a impresoras desactivadas, así que desde entonces todo cae en
  Cocina y sale bien. Pero el hueco seguía abierto para el siguiente equipo
  que se desconecte.
- Quedan **70 trabajos `pendiente`** en PC-ACUNA-CAJA (56 comandas, 8
  tickets, 3 cancelaciones, 3 pruebas). Ver «Limpieza».

## Qué cambia

**Disponible** = el equipo tiene su conexión abierta en este momento, o dio
señal (autenticación o latido, cada 25 s) en los últimos **2 minutos**. La
gracia es para un corte de red de segundos: ese trabajo espera en cola y sale
al reconectar, como siempre.

1. **Comanda (pedido y mesa).** Un destino cuyo equipo no está disponible se
   manda a «Cocina» de un equipo disponible. No se duplica lo que Cocina ya
   recibía: los chilaquiles van a su estación *y* a cocina general, y salen
   una sola vez. Los platillos conservan el orden en que se capturaron.
2. **Sin ninguna Cocina disponible**, el trabajo se queda esperando a su
   equipo, como antes. Ahora el pedido queda con **alerta** y el panel avisa.
3. **Cancelaciones.** Mismo criterio. Si la estación o la caja no están, el
   aviso sale en Cocina o en otra impresora de «Cancelaciones».
4. **Ticket y cuenta.** Un documento entero **nunca** cae en Cocina. Si una de
   sus impresoras no está, sale solo en las otras del mismo documento. Si no
   hay ninguna, espera.
5. **Caducidad: 60 minutos.** Al reconectar, un equipo ya no recibe trabajos
   de más de una hora. Siguen en la tabla, con su estado, como evidencia.
6. **Panel.**
   - Comanda desviada: aviso «🖨 #123: Series 2 no está conectada; la comanda
     salió en Series», y la etiqueta azul de la tarjeta lleva «↪» con el
     detalle.
   - Comanda en espera: aviso rojo y etiqueta roja «⚠ Impresora sin
     conexión», que sube al resumen de la tarjeta, con la sugerencia de
     «Reenviar a cocina».
   - Mesas: la respuesta al mesero trae el mismo texto en sus avisos.

**Qué no cambia:**
- Con todos los equipos conectados, el reparto es idéntico al de antes.
- Sin la inyección de conexión (scripts, pruebas viejas), también.
- La prueba de impresora sigue yendo a la impresora elegida.
- Los pedidos programados imprimen al activarse, no al crearse: la caducidad
  no los toca.

## Pruebas

`node test/fase-impresion-sin-perdidas.mjs`: 18 de 18.
- **Sin base:** motor (1–6) y etiqueta del panel (7–9), más la inyección en
  `server.js` (18).
- **Con Postgres (10–17):**
  - pedido desviado;
  - corte de 30 s que no desvía;
  - todo caído: alerta y aviso;
  - sin inyección: igual que antes;
  - mesa;
  - cancelación;
  - ticket con dos cajas;
  - caducidad 61/59 min.

**Comparación con producción.** Se corrieron 27 suites que tocan impresión,
el panel o el WebSocket en la rama y en a40144f, cada una sobre una copia
desechable de Postgres. Resultado: los mismos números en las dos. Cuatro
suites fallan igual en ambas, por entorno local o fallos ya conocidos:
- `fase-flows-direccion-db`, 0/14;
- `fase-upgrade-errores`, 2/7;
- `fase-websocket-lista-cerrada`, L10;
- `fase-comanda-modificadores`, 15.

Hubo dos excepciones, ya corregidas en la rama:

- `fase-edge-gate` 14c fijaba sus trabajos en una fecha absoluta del 9-ago:
  con la caducidad no salía ninguno. Ahora usa una hora relativa (hace 10
  minutos) y sigue midiendo lo mismo: el cursor con microsegundos.
- `fase-tienda-impresion-edge-e2e` (4 y 5) exigía `alerta: false` con un
  Edge vinculado que todavía no se conecta. Ese silencio es justo lo de
  Acuña: ahora exige `alerta: true` y la lista `en_espera`. Su caso 9b,
  con navegador real, pasa con la etiqueta nueva y sin errores de
  JavaScript.

**Mordidas** (cada garantía desactivada por separado):

| Se desactiva | Casos que caen |
|---|---|
| la consulta de conexión (todo disponible) | 10, 12, 14, 15, 16 |
| la gracia de 2 min (solo socket vivo) | 11 |
| quitar duplicados al desviar | 2 |
| el orden de captura al desviar | 1 |
| la caducidad al reconectar | 17 |
| la alerta de la espera | 12 |
| el aviso al panel | 12 |
| ticket desviado a Cocina en vez de a otra caja | 16 |
| el respaldo de la cancelación | 15 |
| el desvío de la mesa | 14 |
| el desvío del pedido | 10, 12 |
| la etiqueta roja del panel | 7 |
| la inyección en `server.js` | 18 |

**Límite conocido.** La idempotencia es por pedido e impresora. Si un pedido
se desvió a Cocina y luego se REEMITE (recuperación tras una caída del
servidor) cuando la estación ya volvió, la estación recibe también su
papel. Es un papel de más, nunca uno de menos. «Reenviar a cocina» es
reimpresión a propósito y no cuenta.

## Limpieza (escritura en producción: la corre Mario)

`scripts/ops/impresion-sin-perdidas-2026-10/pendientes-viejos.mjs` marca como
`cancelado` los trabajos de más de 60 min de equipos sin señal, con un motivo.
Simulacro por omisión, respaldo y reversa. Ver los comandos en el PR.

Las 12 rutas de Acuña a Series 2 ya no hacen nada: la impresora está
desactivada y, si alguien la reactivara sin conexión, ahora se desvía a
Cocina. Quitarlas es de la Fase 1 («Olvidar equipo»).

## Cómo probarlo después de publicar

1. **Reparto normal.** Con la PC de cocina encendida, manda un pedido de
   prueba o usa «Reenviar a cocina» en uno existente. La comanda sale igual
   que siempre y la etiqueta es azul, sin «↪».
2. **Desvío.** Hoy ninguna sucursal tiene dos equipos conectados (Acuña:
   solo ACUÑA - CAJQA; Obispado: solo «caja»), así que en producción no se
   puede provocar sin una segunda PC. Lo cubren los casos 10, 14 y 15 con
   Postgres. Si algún día hay dos: en una sucursal con dos equipos, apaga el servicio «Xabor
   Edge» del equipo de una estación y espera 3 minutos. Manda un platillo de
   esa estación: debe salir en Cocina, con el aviso verde en el panel y «↪»
   en la etiqueta.
3. **Espera.** Con la única PC apagada más de 3 minutos, un pedido muestra el
   aviso rojo y la etiqueta «⚠ Impresora sin conexión». Al encender la PC
   antes de 60 minutos, la comanda sale sola.
4. **Imprimir prueba** en Configuración → Impresoras sigue igual: sale en esa
   impresora o espera a su equipo.
5. **Probar notificaciones** no cambia: la Fase 0 no toca las notificaciones
   push.
