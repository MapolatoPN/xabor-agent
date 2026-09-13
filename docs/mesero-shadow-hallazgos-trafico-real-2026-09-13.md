# El primer día de tráfico real del Mesero Shadow

**Fecha:** 13 de septiembre de 2026
**Negocio observado:** Obispado (bot apagado, `mesero_whatsapp_shadow='true'`)
**Build observado:** `da2266e5ac030e9b54ce9402e18b8f650b0ab541`
**Rama de la corrección:** `feat/whatsapp-mesero`

## Lo que salió bien, y no se toca

El aislamiento funcionó exactamente como se diseñó: 54 mensajes entrantes, 54
compuertas evaluadas, 54 observaciones, **0 respuestas, 0 pedidos, 0 efectos, 0
errores**. Diez de esas conversaciones eran de `tienda_online`. Nada de este
documento cambia esa parte.

Lo que falló es otra cosa: **la calidad de la observación**. De 46 turnos con
pedido en curso, **21 acabaron escalados** a un humano hipotético por
`DEMASIADAS_ACLARACIONES`, y después de eso la copia dejaba de mirar
(`llamadas_modelo: 0`). Un observador que se calla en el 46 % de los turnos no
está midiendo al mesero: está midiendo su propio defecto.

---

## A. La causa

Eran tres, y se alimentaban entre ellas.

### A.1 La pregunta no se quedaba pegada: renacía

La hipótesis inicial —que `resolverPendiente()` no resolvía— era la correcta
para el contador, pero no para la pregunta repetida. Siguiendo el log turno por
turno apareció otra cosa.

`observarMeseroEnSombra()` se llama **una vez por mensaje y sin esperarla**,
mientras el canal agrupa seis segundos. Con dos mensajes seguidos —que es como
escribe la gente— las dos observaciones leían el MISMO estado guardado, tardaban
~800 ms en el modelo, y la última en terminar pisaba a la primera. En el log hay
tres grupos de registros con el mismo `antes.turno`:

```
14:27:23.447  y  14:27:24.196
14:28:16      y  14:28:17
14:28:57      y  14:28:58
```

El cliente escribió «Quiero unos Chilaquiles…» y «Frijolitos y papas…» con 750 ms
de diferencia. El renglón de chilaquiles y el texto de su ciclo desaparecieron
del contexto sombra. A partir de ahí el modelo re-proponía un artículo que ya no
tenía respaldo, el código lo frenaba —correctamente— y **volvía a generar la
misma aclaración**. La «pregunta pegada» que se veía en el log no era una
pregunta guardada: era la misma pregunta **regenerada** cada turno.

**Corrección:** una cola de uno por conversación en `sombraDelMesero.js`. La
segunda observación espera a la primera y arranca del estado que aquella dejó.
Sigue sin bloquear al canal —nadie espera ese `await`— y el tope de tiempo sigue
aplicando a cada paso.

### A.2 El pendiente guardaba la frase, no el motivo

La estructura vieja era `{clave, pregunta, turno, veces}`. Guardar la **frase
redactada** tiene dos consecuencias, y las dos se vieron:

- una pregunta sobrevive a su motivo, porque nada la ata al renglón ni al grupo
  que la originó;
- y cuando el motivo cambia (otros candidatos), la frase vieja se sigue usando.

### A.3 El contador subía con cualquier turno

`veces` se incrementaba por el hecho de que el pendiente siguiera abierto, no
por que el cliente hubiera fallado en contestarlo. Preguntar por el
estacionamiento, dar la dirección o pedir otro producto contaban como
«aclaración fallida». Tres turnos de conversación normal bastaban para escalar.

---

## B. Los pendientes: el ciclo de vida nuevo

Un pendiente ya no es una frase. Es un descriptor con identidad propia:

```js
{
  clave,              // tipo:lid:grupo:dato — las partes vacías no dejan hueco
  tipo,               // opcion_ambigua | grupo_requerido | termino_ambiguo | …
  lid, producto,      // de qué renglón es
  grupo, dato,        // qué se pregunta
  candidatos,         // entre qué opciones
  evidenciaOrigen,    // qué dijo el cliente cuando nació
  turnoCreacion,
  turnoVisto,
  turnoUltimaPregunta,
  intentos,
}
```

**La frase no se guarda en ningún momento.** `aclaraciones.js` la vuelve a
redactar a partir del descriptor, así que una pregunta no puede sobrevivir al
estado que la originó.

Cada turno se reconcilian contra lo guardado (`sincronizarPendientes`), y de ahí
salen los cuatro desenlaces que ahora se pueden contar:

| desenlace | cuándo |
|---|---|
| `creados` | el descriptor no existía |
| `resueltos` | existía y ya no hace falta |
| `cancelados` | existía y **su línea desapareció** — no se resolvió, se cayó con ella |
| `obsoletos` | existía con OTROS candidatos: la pregunta de antes ya no lo representa, así que se rehace desde cero (intentos a 0, sin marca de preguntado) |

La resolución es **genérica**: no hay una regla por tipo de pregunta. Un
pendiente vive mientras viva su motivo, y el motivo está en el carrito, no en el
mensaje — existe la línea y su grupo sigue sin elegir
(`pendientesQueSiguenVivos`). Por eso un turno que hable de otra cosa ya no lo
da por contestado.

---

## C. El cambio de tema: la regla exacta

> Un pendiente **solo** cuenta un intento fallido si (1) ya existía antes de este
> turno, (2) el mensaje contestaba **a él**, y (3) sigue sin poder resolverse.

«Contestaba a él» se decide por tipo, en `respondeAlPendiente`:

- **con candidatos** (`opcion_ambigua`, `grupo_requerido`, `termino_ambiguo`…):
  que el cliente nombre alguno de ellos, medido con `palabrasQueLaSostienen`
  contra **las candidatas** y no contra la carta entera;
- **dato operativo** (`modalidad`, `pago`, `productos`): que la intención del
  turno sea la que resuelve ese dato (`DEFINIR_MODALIDAD`, `DEFINIR_PAGO`,
  `AGREGAR_PRODUCTO`).

Todo lo demás es cambiar de tema, y cambiar de tema no es fallar.

---

## D. Qué incrementa ahora el contador

Solo `anotarIntentoFallido`, y solo desde la regla de arriba. `DEMASIADAS_ACLARACIONES`
sigue disparándose con `intentos >= 3`, pero ahora tres significa **tres
respuestas del cliente a la misma pregunta que siguen sin separar las
candidatas** — no tres turnos.

No se subió el límite. Se arregló lo que contaba.

---

## E. El handoff en sombra

En producción escalar es terminal: el bot deja de atender y una persona toma la
conversación. Eso **no cambia**.

Observando es distinto. Si la copia también se detiene, se deja de aprender
exactamente cuando la conversación se pone interesante. Se separan dos cosas que
hasta ahora eran una:

```
habriaEscalado    en producción, aquí habría pasado a un humano
dejarDeObservar   la copia se detiene
```

Con `observando: true` (que solo pasa `sombraDelMesero.js`) ocurre lo primero y
no lo segundo:

- `ctx.habriaEscalado = { turno, motivo }` se fija **una vez**, en su turno, y
  sobrevive al guardado del contexto;
- el resultado sigue siendo un turno normal, con su carrito y sus decisiones;
- **todos los turnos posteriores van marcados** `post_handoff_shadow=true`,
  porque son contrafactuales: en producción el bot no habría estado ahí. Su
  `pedido_hipotetico` no se puede leer como «lo que el cliente habría pedido».

El evento `whatsapp_mesero_handoff_hipotetico` se emite una sola vez, con el
turno en que ocurrió; los siguientes emiten `whatsapp_mesero_post_handoff`.

---

## H. PII en los logs

El shadow registró nombres de calles. La instrucción fue explícita: **no
construir un detector universal de topónimos**, y mirar antes qué detecta Xabor
ya. Lo que había:

| dónde | qué |
|---|---|
| `agent/brain.js:52-53` | `DICE_RECOGER` / `DICE_DOMICILIO` — la intención de modalidad |
| `agent/brain.js:752` | `pendiente === 'direccion'`: lo que contesta a la pregunta ES la dirección, entera, sin analizar el texto. Y su regla de corte: «un "sí" o un "gracias" no es una calle» (menos de tres palabras) |
| `orders/carritoDelPedido.js:278` | `PREGUNTAS_CON_NUMEROS = {direccion, telefono, codigo_postal, numero_exterior}` |
| `agent/prompts.js:653, 911-913` | los campos de entrega: `calle`, `colonia`, `entre_calles` |
| `utils/direccionRepartidor.js` | cómo se formatea una ubicación: `Col. <colonia>, calle <calle>` |

De ahí sale `src/mesero-whatsapp/redaccionPII.js`. No importa nada de `brain.js`
—el observador no puede tocarlo, y hay una prueba sobre el grafo de imports que
lo comprueba—; copia dos expresiones de doce palabras y lo dice en el comentario.

**Lo que se reconoce es el MARCO, no el nombre.** Las palabras con las que se
enmarca un domicilio (`calle`, `col.`, `blvd`, `entre calles`, `#208`, `C.P.`,
`mza 4`…), no los lugares. Cuando el marco aparece, se tapa el fragmento entero
—con topónimo incluido— sin haber tenido que saber que lo era.

Y la dirección se trata como una **racha**, no como un fragmento suelto, porque
«Nogal 900, Álamos» son dos trozos y el segundo por sí solo no se distingue de
nada:

```
marco                 se tapa, y lo que sigue queda bajo sospecha
habla de la carta     se conserva, y corta la racha
cifra de 2+ dígitos   se tapa, y lo que sigue queda bajo sospecha
bajo sospecha         se tapa
nada de eso           se conserva
```

El marco gana sobre la carta a propósito: «Calle Naranja 900» es una dirección
aunque haya jugo de naranja en el menú. Equivocarse hacia tapar un platillo
cuesta un dato de análisis; equivocarse hacia publicar dónde vive alguien cuesta
bastante más.

El vocabulario de la carta sale del **catálogo real del negocio**. No hay lista
de platillos en el código, igual que en el resto del mesero.

### Las tres capas, en orden

1. **correo, coordenadas y enlaces** (`redactarContacto`) — no dependen de
   ningún contexto, y tienen que irse **antes** de la máscara de dígitos: unas
   coordenadas convertidas en `##.####` siguen siendo coordenadas;
2. **la dirección** (`redactarDireccion`) — la única capa que sabe distinguir
   «Calle Naranja 900» de «jugo de naranja»;
3. **las rachas de dígitos** — un teléfono suelto no lleva marco de dirección.

### Lo que NO se toca

Producto, modificadores, candidatos, intenciones, referencias y aclaraciones
salen intactos. Un log en el que todo dice `[REDACTADO]` no responde ninguna de
las preguntas por las que se puso a observar.

Salida real de `textoSeguro`, generada ejecutando el módulo:

| entra | sale |
|---|---|
| `Quiero unos Chilaquiles suizos` | `Quiero unos Chilaquiles suizos` |
| `un jugo de naranja porfa` | `un jugo de naranja porfa` |
| `son 2 chilaquiles y 1 omelet` | `son 2 chilaquiles y 1 omelet` |
| `bueno 3 tortas` | `bueno 3 tortas` |
| `chile relleno 2` | `chile relleno 2` |
| `voy en camino` | `voy en camino` |
| `mandame la ubicacion del local` | `mandame la ubicacion del local` |
| `ensalada de col con zanahoria` | `ensalada de col con zanahoria` |
| `Calle Naranja 900` | `[DIRECCION_REDACTADA]` |
| `Calle Naranjos 900 col. Alamos` | `[DIRECCION_REDACTADA]` |
| `vivo en Hidalgo 4521` | `[DIRECCION_REDACTADA]` |
| `Col 20 de Noviembre 45` | `[DIRECCION_REDACTADA]` |
| `mandenmelo a mi casa, Blvd Cbtis 34 #208 Col Guillen` | `mandenmelo a mi casa, [DIRECCION_REDACTADA]` |
| `Calle Nogal 900, y unos chilaquiles` | `[DIRECCION_REDACTADA], y unos chilaquiles` |
| `llamame al 8781234567` | `llamame al ###` |
| `escribeme a ana.lopez+pedidos@gmail.com` | `escribeme a [EMAIL_REDACTADO]` |
| `estoy en 25.426801, -100.987654` | `estoy en [COORDENADAS_REDACTADAS]` |

### Cuatro defectos que encontró una revisión adversarial del redactor

La primera versión de esta capa tenía dos agujeros y dos excesos. Ninguno se
dedujo leyendo: los cuatro se comprobaron ejecutando el módulo.

| defecto | qué hacía | arreglo |
|---|---|---|
| `n[ºo]\s*\d` sin `\b` | casaba dentro de cualquier palabra acabada en «-no»: `bueno 3 tortas`, `chile relleno 2`, `cafe americano 2` se publicaban como `[DIRECCION_REDACTADA]` | frontera de palabra en **todos** los patrones |
| `camino`, `cerrada`, `ubicacion` como marco | borraban «voy en camino» y «mándame la ubicación del local», que no son el domicilio de nadie | fuera; queda `mi ubicacion` |
| sin marco para «vivo en …» | `vivo en Hidalgo 4521` salía entera: la única capa que la tocaba era la máscara de dígitos, y dejaba el nombre de la calle | `vivo en`, `vivimos en`, `mi casa esta en` |
| `item.notas` en crudo | la nota del renglón entraba al registro por `pedido_hipotetico` y `antes_items` **sin pasar por ninguna capa**: era la puerta trasera | la nota pasa por `textoSeguro` como el mensaje |

El tercero es el que más importa: lo dejaba pasar incluso **la prueba que
certificaba que el log no llevaba PII** (`V7` en `fase-mesero-multiempresa`),
porque su aserción medía la máscara de dígitos y no la capa de direcciones.

### Falsos positivos conocidos

- **«col morada»** y parecidos: `col` seguida de un nombre se toma por colonia,
  porque «Col Guillén» —el caso del incidente real— se escribe así, y «Col 20 de
  Noviembre» empieza por cifra. Las preposiciones y artículos están excluidos, de
  modo que «ensalada de col con zanahoria» y «col a la mexicana» no se tocan.
- Bajo modalidad **a domicilio**, un fragmento con una cifra de dos o más
  dígitos que no hable de la carta se redacta («llego en 15 minutos»). Es
  deliberado: en esa posición, la mayoría de las cifras son la casa.

### Lo que sigue escapando, y se dice

- Un número de casa de **una sola cifra** sin marco («Hidalgo 4»).
- Una dirección **sin ninguna cifra y sin marco** («por el rumbo de la escuela»).

Las dos son el precio de no tener una lista de topónimos. Con marco —que es como
se escribe la mayoría— caen; sin él, no hay señal que las distinga de una frase
cualquiera, y taparlas obligaría a tapar frases cualesquiera.

---

## I. Métricas nuevas

Eventos en `metricasMesero.js`:

| evento | campos |
|---|---|
| `whatsapp_mesero_pendientes` | `creados`, `resueltos`, `cancelados`, `obsoletos`, `vivos` |
| `whatsapp_mesero_aclaracion_repetida` | `tipo`, `intentos` |
| `whatsapp_mesero_handoff_hipotetico` | `motivo`, `turno_del_escalado` — una vez por conversación |
| `whatsapp_mesero_post_handoff` | `fase` — uno por turno contrafactual |

Campos nuevos del registro de sombra: `habria_escalado`, `turno_del_escalado`,
`post_handoff_shadow`, `pendientes[]` (clave, tipo, intentos, desde,
preguntado), `ciclo_pendientes` (los cinco contadores del turno),
`aclaraciones_repetidas`, `direccion_redactada`, `contacto_redactado`.

> **Los eventos se construían y se tiraban.** `atenderTurno` produce la lista de
> `[MESERO] evento=…` en cada turno, pero `sombraDelMesero` no la leía y nadie
> la imprimía: en el modo observado los cuatro contadores nuevos no llegaban a
> ningún log. Ahora la observación los devuelve y el canal los escribe, y los
> mismos números viajan además dentro de la línea JSON del registro —que es lo
> que se lee para seguir una conversación entera.

Con esto se pueden calcular las dos cifras que se pidieron:

```
% pendientes resueltos = resueltos / (creados)
aclaraciones por pedido = suma(creados) por conversación
```

---

## Lo que este cambio NO hace

No añade recomendaciones, ni upselling, ni memoria histórica. No toca producción,
ni el Mesero V1, ni Railway, ni la rama congelada de deploy. No cambia el
comportamiento productivo del handoff. No relaja ningún límite: `TOPE_ACLARACIONES`
sigue siendo 3.
