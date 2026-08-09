# Xabor Edge — hoja de ruta del modo sin conexión

**Nada de este documento está implementado.** Es el diseño para una fase
posterior, escrito ahora para que las decisiones de Edge V1 no la bloqueen.

## Qué resuelve V1 y qué no

Xabor Edge V1 hace **impresión local resiliente**: si se cae internet, lo que
ya está en la cola se sigue imprimiendo y reintentando, y nada se pierde.

Lo que **no** hace: capturar pedidos nuevos sin internet. Abrir una mesa,
agregar productos o mandar una ronda necesitan la nube. Con la conexión caída,
el restaurante puede terminar lo que tenía en marcha, pero no empezar nada.

Confundir las dos cosas sería el error de comunicación más caro posible:
"Xabor funciona sin internet" y "Xabor sigue imprimiendo si se cae internet"
no significan lo mismo.

## Lo que haría falta

### Catálogo en local

El Edge tendría que mantener una copia del menú (categorías, productos,
precios, modificadores) y de los meseros con su PIN, sincronizada mientras hay
conexión. Sin eso no se puede ni pintar la pantalla de captura.

### Operación local

Mesas, cuentas, items, rondas y cobros en efectivo tendrían que poder crearse
contra el almacén local y sincronizarse después.

### Identificadores: el punto crítico

**Los folios globales no sirven como identificador offline.**
`pedidos_activos.folio` es una secuencia global; dos Edges desconectados
generarían el mismo número y al reconectar chocarían. Este proyecto ya tuvo un
incidente de folios y no hay que repetirlo desde otro ángulo.

El diseño correcto es de dos capas:

1. **Id local**: un UUID que genera el Edge al crear la operación. Nunca
   cambia y es la clave con la que se deduplica al sincronizar.
2. **Folio de Xabor**: lo asigna la nube al reconciliar, y es el que ve el
   cliente.

Mientras está sin conexión, la comanda se imprime con una referencia local
visible (`LOCAL-A7F3`, por ejemplo). Al sincronizar se le asigna su folio. La
cocina nunca ve un número que después cambie de significado.

### Cola de sincronización

Operaciones locales pendientes de subir, en orden, con reintentos. La misma
disciplina de idempotencia que ya usa la impresión: id determinista, y
comprobar **de verdad** si la nube ya la tenía.

### Conflictos

Los casos reales que habría que resolver, no en abstracto:

- La misma mesa abierta en la nube y en el Edge durante el corte.
- Un pago registrado offline sobre una cuenta que la nube ya cerró.
- Un producto que cambió de precio mientras el Edge estaba desconectado.
- Dos Edges del mismo local operando desconectados a la vez.

La regla de partida: **lo que ya se cobró no se recalcula**. El dinero
registrado es un hecho, no una derivada del catálogo.

### Reconciliación

Un informe de lo ocurrido durante el corte: qué se creó offline, qué folio le
tocó, qué chocó y qué decidió el sistema. Sin ese informe nadie puede confiar
en la caja del día.

## Por qué no ahora

El modo sin conexión multiplica por varias veces la superficie de fallo del
sistema, y ninguno de esos fallos es visible hasta que el restaurante ya
depende de él. La secuencia sensata es:

1. **Edge V1** (esta fase): impresión resiliente. Se prueba en Obispado.
2. **Piloto en paralelo con Wansoft**, con impresión real, durante días.
3. Solo cuando la impresión sea aburrida y confiable, plantear el offline.

Y antes de eso hay algo más urgente y más barato: caja y corte completos, que
son buena parte de lo que hoy obliga a seguir pagando Wansoft.
