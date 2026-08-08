# Hotfix — Carrera de arranque / carga inicial de pedidos

Rama `hotfix/startup-pedidos-race` (base 95ddc96, el commit desplegado).
**Sin migración, sin cambios de esquema, sin tocar producción.**

## La causa

`server.listen(PORT)` se ejecutaba **en paralelo** a la cadena de arranque:

```js
initDB()
  .then(() => resolverNegocioActualPorDefecto())
  .then((negocioId) => seedMenuDesdeJSON(menuJSON, negocioId))
  .then(() => cargarPedidosDesdeDB())
  .then(() => cargarConfig())
  .then(() => cargarIntegraciones())
  .catch(e => console.error('[DB] Error al inicializar:', e.message));

server.listen(PORT, ...);   // ← no esperaba a nada de lo anterior
```

Es decir: el puerto se abría, `/health` respondía 200 y Railway daba el
deployment por bueno **mientras el estado en memoria todavía se estaba
reconstruyendo**.

`cargarPedidosDesdeDB()` hacía:

```js
pedidos.length = 0;            // ← borra TODO
for (const p of activos) pedidos.push(p);   // ← repuebla con la fotografía
```

La fotografía (`SELECT ... FROM pedidos_activos`) se toma al principio. Un
pedido creado después de esa lectura y antes del reemplazo **quedaba
persistido en la base pero borrado de la memoria**. Como la API resuelve los
pedidos activos desde memoria (`obtenerPedidoPorId`), el resultado era un
404 **"Pedido no encontrado" sobre una fila que sí existía** — y la comanda,
el enlace de pago o la oferta a repartidores dejaban de poder emitirse para
ese pedido hasta el siguiente reinicio.

Lo mismo aplicaba a `cargarConfig()` y `cargarIntegraciones()`: peticiones
atendidas durante esa ventana veían configuración e integraciones a medio
cargar.

**Ventana medida** (local, base sana): **0–51 ms** entre el primer `/health`
200 y el fin de la carga de pedidos. Bajo carga real se alarga, que es
justo cuando se manifestó: `fase-pos-envios` empezó a fallar de forma
intermitente con ese 404 exacto.

## La corrección

1. **El puerto no se abre hasta terminar el bootstrap** (src/server.js). La
   cadena pasó a una función `arrancar()` con `await` explícitos, y
   `server.listen` es el último paso. Mientras el bootstrap corre, el puerto
   está **cerrado**: ninguna petición —POS, WhatsApp, Rappi, panel,
   WebSocket— puede entrar sobre estado parcial. Railway reintenta el
   healthcheck hasta `healthcheckTimeout = 60` (railway.toml) y el bootstrap
   tarda ~1 s.
2. **Un bootstrap fallido no se sirve como sano**: `arrancar()` loguea
   `[Startup] ERROR ...` (solo el mensaje, jamás credenciales) y hace
   `process.exit(1)`. Railway conserva el deployment anterior en vez de
   promover uno que perdería pedidos.
3. **Segunda barrera en la carga** (src/orders/orderManager.js):
   `cargarPedidosDesdeDB()` ya no descarta lo que no está en su fotografía.
   Conserva los pedidos creados durante la carga, no los duplica, y el
   contador de folios toma el máximo entre la base, la fotografía y lo
   creado en memoria — **nunca retrocede** por debajo de un folio ya
   entregado a un cliente. Además ahora propaga el error en vez de tragarlo,
   para que el arranque pueda fallar de verdad.
4. **Readiness observable**: `/health` responde
   `{ status: 'ok', listo: true, timestamp }`. Como el puerto solo existe
   después del bootstrap, si contesta es porque está listo; `listo` lo hace
   explícito sin romper el contrato anterior.

Logs de arranque: `[Startup] Inicializando base...`,
`[Startup] Cargando pedidos...`, `[Startup] Pedidos cargados: N`,
`[Startup] Aplicación lista para tráfico`.

## Por qué no se resolvió solo con readiness/503

Un flag con 503 deja el puerto abierto y obliga a decidir ruta por ruta qué
es "operativo". Cerrar el puerto hasta estar listo es más pequeño, no tiene
huecos por olvido y es lo que Railway ya sabe manejar con su healthcheck. El
flag `appReady` existe igual, pero como consecuencia, no como sustituto.

## Pruebas

`test/fase-startup-readiness.mjs` (9 casos): el puerto no acepta conexiones
antes de terminar la carga inicial; `/health` solo responde ya listo;
el primer pedido y una ráfaga de 20 tras quedar listo quedan en base **y** en
memoria; **reproducción determinista** de la ventana (se retiene la carga
justo después de su fotografía, se crea un pedido en medio y debe
sobrevivir); el contador no retrocede; consistencia total memoria↔base con
tenant correcto; cero folios duplicados; y un bootstrap con la base caída
sale con código ≠ 0, sin declararse listo y sin abrir el puerto.

Contraste contra el código anterior (95ddc96): la misma suite falla 4 de 9,
incluida la reproducción del borrado de memoria. Con el arreglo: 9/9.

`fase-pos-envios` (la suite que descubrió el fallo) y `fase-chat-manual` se
ejecutan repetidamente para confirmar que dejaron de ser intermitentes, y
`fase-folio-concurrencia` verifica que el P0 de folios sigue intacto.

## Rollback

Redeploy del commit anterior (95ddc96). No hay migración ni datos nuevos: el
cambio es de orden de arranque y de reconciliación en memoria, así que
volver atrás solo reabre la ventana.
