# Comanda de cocina: los modificadores como lista y en grande

Rama `feat/comanda-modificadores-legibles`, base de producción `ea1eb4e`.
Sin migración. No se tocan el enrutado de impresoras, la cuenta del cliente,
la precuenta, el ticket pagado, Rappi, WhatsApp ni Rewards.

## El síntoma y la causa

En el papel de cocina los modificadores se leían como un párrafo apretado y
en letra chica. Son dos causas distintas, y las dos estaban en el papel al
mismo tiempo:

1. **Tamaño.** El renderer del Edge imprimía el producto en doble alto
   (ESC/POS `GS ! 1`) y los modificadores en tamaño normal: la mitad de alto,
   justo en el renglón que dice qué lleva el platillo.
2. **Párrafo.** El POS, la tienda en línea y los envíos arman `notas`
   pegando ahí el texto de los modificadores (`textoModificadores`), porque
   antes existían papeles que no sabían de modificadores. En una comanda que
   YA los imprime como lista, esa nota los repetía envueltos en dos o tres
   renglones. Ejemplo real de Mapolato (pedido XAB-0376):

   ```
   1 AGUAS NATURALES
      Tamaño: Grande 1 Litro
      Sabor: Limonada
      NOTA: Tamaño: Grande 1 Litro · Sabor:
      Limonada · que tenga mucho limon
   ```

   De esas cinco líneas, la única información nueva es «que tenga mucho
   limon».

## Lo que hace el cambio

```
1 AGUAS NATURALES
  > Tamaño: Grande 1 Litro        ← doble alto
  > Sabor: Limonada               ← doble alto
  NOTA: que tenga mucho limon     ← doble alto y negritas
```

- **Una línea por opción**, con viñeta `>` y sangría de dos. Da igual cómo
  llegue el modificador: objeto `{grupo, opcion}` (POS, tienda, WhatsApp),
  texto ya formateado `"Salsa: Mole"` (Restaurante) o texto suelto.
- **Doble alto** en los modificadores y en la nota. El producto conserva
  doble alto **y** negritas, así que la jerarquía no se pierde.
- **La nota deja de repetir los modificadores.** Solo se recorta lo que es
  repetición literal, al principio o al final, con los separadores que usan
  los flujos (` · ` y `, `). Si algo no calza exactamente, la nota se imprime
  entera: perder una nota de cocina sería mucho peor que imprimirla dos
  veces.

## Dónde vive

| Archivo | Qué hace |
|---|---|
| `edge/renderers/modificadores.js` | Nuevo. `lineasDeModificadores` y `notaSinModificadores`: el criterio, puro y sin dependencias. |
| `edge/renderers/index.js` | `renderComanda` imprime la lista en doble alto y usa la nota ya limpia. `renderCuenta` **no cambia**. |
| `src/services/impresionService.js` | `itemsParaComanda` arma los items de los tres payloads de comanda (pedido, mesa y reenvío) con la nota limpia. |
| `src/server.js` | El camino antiguo de comanda de mesa manda `modificadores` aparte; `notas` conserva la mezcla para un print-agent viejo. |
| `panel/index.html` | `comandaHTML`: un renglón por opción, 15 px (antes 12), nota 15 px (antes 11 px en cursiva), producto 16 px, cantidad 18 px. Y escapa el producto y la nota, que antes iban crudos. |

El módulo vive en `edge/` porque el Edge se instala solo —el instalador copia
`edge/*`, nunca `src/`— y el servidor lo importa desde ahí. Una sola
implementación: si se duplicara, el papel y el payload acabarían diciendo
cosas distintas. El panel es un HTML suelto que no puede importar módulos, así
que tiene una copia de las dos funciones; la suite compara las dos
implementaciones caso por caso para que no se separen.

## Cómo llega al papel del negocio

Son dos despliegues distintos, y conviene no confundirlos:

- **El servidor** (Railway) hace que la nota deje de repetir los
  modificadores. Eso se ve en el papel **aunque la terminal siga con el Edge
  anterior**, porque lo que cambia es el payload.
- **El Edge** es el que dibuja el papel, y **no se actualiza solo**: hay que
  copiar la carpeta `edge/` en la PC del negocio y reiniciar el servicio (ver
  «Actualizar un Edge» en `docs/xabor-edge-runbook.md`). Sin ese paso, la
  lista sigue saliendo en tamaño normal.

## Pruebas

`test/fase-comanda-modificadores.mjs` (20 casos) sobre los tres caminos, con
las formas reales que viajan hoy en Mapolato: una línea por opción con
viñeta; doble alto comprobado recorriendo el flujo ESC/POS byte por byte (y
que el tamaño vuelva a normal antes del pie); objetos y textos se leen igual;
la nota conserva solo lo escrito a mano; la nota que es puro modificador
desaparece; los modificadores pegados con `, ` al final; siete casos de notas
que **no** se deben perder; la comanda sigue sin precios, con mesa, mesero,
ronda, impresora, marca de reimpresión y corte; la cuenta del cliente no
cambia; el payload del servidor limpia en los tres sitios; el panel pinta un
renglón por opción, con la letra mayor y escapando el contenido; y las dos
implementaciones coinciden.

Mordidas (desactivar una garantía y ver fallar la suite): tamaño normal en
los modificadores; volver a juntarlos en un renglón; que el renderer no
limpie la nota; que la nota se pierda entera; reconocer solo la repetición
exacta; que el servidor mande la nota sin limpiar; que el panel vuelva a
agrupar en 12 px; y que el panel y el Edge usen criterios distintos. Las ocho
se detectan.

Regresión verde: `fase-print-routing`, `fase-print-jobs`, `fase-edge-e2e`,
`fase-panel-html-render`, `fase-impresion-self-service`,
`fase-tienda-impresion-edge-e2e`, `fase-modificadores-grupo-identidad`,
`fase-restaurante-precuenta`, `fase-precuenta-papel`,
`fase-ticket-final-contrato`, `fase-restaurante-mesas`,
`fase-restaurante-cobro-caja`, `fase-restaurante-division-consumo`.
`fase-comanda-edge-exclusiva` falla en sus 5 casos `[PANEL]`
(`upsertPedidoEnTablero is not defined`); falla igual con el panel de
producción y es anterior a este cambio.

## Lo que quedó fuera

- **El nombre del producto se parte a 21 columnas** (`Math.floor(ancho / 2)`)
  porque el bloque se envuelve como si el doble alto también duplicara el
  ancho, y no lo hace: `GS ! 1` solo estira la altura. Por eso sale «TACO DE
  HUEVO CON / TOCINO» partido a la mitad. Es anterior a este cambio y se
  arregla en una línea, pero toca el renglón del producto: va aparte.
- **Agrupar las opciones repetidas** («Guarniciones» aparece dos veces
  seguidas). Se puede colapsar el grupo y dejar las opciones debajo; suma una
  línea por grupo y conviene decidirlo viendo papel real.
- **Las ventas `RM-*`** guardan los modificadores mezclados dentro de
  `notas` (así lo hace `cerrarCuenta`). No afecta a la comanda de cocina, que
  va por el camino de mesa, pero sí a lo que se ve en el historial.
