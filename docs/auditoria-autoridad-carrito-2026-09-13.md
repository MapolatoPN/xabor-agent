# Auditoría en frío de la autoridad nueva del carrito

Rama `feat/whatsapp-mesero`. Base auditada: `00b0998`, que es lo que quedó de la
noche del Mesero Digital.

## El principio

> Un `lid` identifica el objetivo, pero NO constituye evidencia para
> modificarlo. Tener el `lid` correcto nunca debe ser suficiente por sí mismo
> para cambiar el pedido.

Y su recíproco, que resultó ser el que más daño hacía:

> Un `lid` INCORRECTO no debe poder redirigir un cambio autorizado hacia la
> línea equivocada.

## La autoridad nueva, una por una

| Capacidad | Quién puede invocarla | Qué exige además del `lid` | Con `lid` inexistente | Con `lid` de otra línea |
|---|---|---|---|---|
| **`lid` en un item propuesto** | solo el mesero (el modelo nunca ve el `lid`) | que el nombre no sea ajeno al del renglón (`parecido >= 0`) | se ignora, cae al emparejamiento normal | se rechaza el emparejamiento |
| **`quitarPorLid`** | solo el mesero, con cuatro candados | verbo de quitar en lo DICHO de este turno; renglón intacto; una sola línea; misma cláusula; sin otro objeto | no quita nada | no llega a plantearse |
| **`atribuidoPorLid`** | solo el mesero | el número en el mensaje; plausible; sin pregunta con números ajenos; el turno es un acto de cantidad; el cliente no nombró nada de la carta | no afecta a ningún renglón | solo un `lid`, y de una referencia resuelta |
| **`dichoDelTurno` / `dichoDelCiclo`** | cualquiera | que cada palabra esté en lo que el cliente escribió | — | — |
| **`evidenciaAceptada`** | solo el mesero | nombre EXACTO del catálogo que se ofreció | — | — |

Ninguna afecta a más de una línea salvo `quitarPorLid`, y ahí ahora se exige
exactamente una: dos o más se preguntan.

**Con evidencia vieja:** `quitarPorLid` mide el verbo sobre el turno, no sobre
el ciclo (A7). `atribuidoPorLid` mide el número sobre el turno (A12). La
`evidenciaAceptada` caduca con la propuesta a los dos turnos.

**Con ambigüedad:** se pregunta y no se aplica, en las cinco vías.

**¿Puede alguna saltarse las reglas anteriores?** No: cada una sustituye una
ATRIBUCIÓN (a qué renglón) por otra atribución igual de determinista, y ninguna
sustituye una EVIDENCIA. El peor caso de un llamador roto es volver al
comportamiento de `main`.

## Lo que se encontró, y se corrigió

Seis defectos reales, todos reproducidos ejecutando el código.

1. **Un `lid` equivocado renombraba la línea del cliente.** Con «los chilaquiles
   sin cebolla» y una propuesta apuntando a los hotcakes, la rama NOMBRE de
   `fusionar` veía que el cliente sí había dicho «chilaquiles» y renombraba. El
   platillo desaparecía. → El `lid` ahora tiene que ser plausible.

2. **`emparejar()` del motor casaba por nombre y primer libre.** Con dos ramen
   iguales y proteínas distintas, «al de pollo karaage ponle huevo» —con el
   modelo ACERTANDO— convertía el de cerdo en un segundo karaage y ponía el
   huevo en el equivocado. Cero preguntas. → Usa `parecido`, la misma función
   que el reconciliador.

3. **El acotamiento del texto autorizante no se comprobaba.** Un llamador podía
   pasar «ponme una Coca Cola» como «lo que dijo el cliente». → Se exige que
   cada palabra esté en lo que escribió; si no, se ignora y queda la traza.

4. **La evidencia de un «sí» autorizaba de más.** Iba concatenada al texto del
   cliente, así que respaldaba también modificadores y notas; y comparada por
   palabras, aceptar «Café de Olla» autorizaba «Café Americano». → Canal propio,
   comparación exacta, y alcanza solo a que el renglón exista.

5. **La vía de baja borraba lo que no era.** «Quítale la cebolla al primero»
   borraba el platillo; «quítale todo el picante» vaciaba el pedido; «el otro
   déjalo igual, quita el café» borraba el otro; «quítalos, los chilaquiles» se
   llevaba dos. → Cuatro candados: una línea, misma cláusula, sin otro objeto, y
   la frase manda sobre la referencia.

6. **La atribución por foco cogía números que no eran cantidades.** «Somos 3»,
   «Morelos 12», «a las 2». Y su guarda se apagaba entera cuando no había
   catálogo. → Se exige que el turno sea un acto de cantidad, la guarda se mide
   con la vara del reconciliador, y sin catálogo no se atribuye.

Además, «quita los dos» ahora pregunta en vez de callarse: antes la referencia
resolvía, la baja no salía y nadie decía nada.

## Lo que NO se corrigió, y por qué

La auditoría dejó 28 hallazgos confirmados. Los seis de arriba cubren doce de
ellos. Los demás **no se tocaron a propósito**: son errores de INTERPRETACIÓN
del mesero, no agujeros de autoridad, y el mesero solo corre en sombra — donde
no puede llegarle a un cliente. Arreglarlos a ciegas la misma noche que se
conecta la observación sería cambiar veinte cosas y desplegar sin saber cuáles
de ellas importan en tráfico real. Eso es justo lo que la sombra existe para
evitar.

Todos quedan visibles en el registro de sombra: `bloqueado`, `ambiguedades` y
`propuestas` los muestran turno a turno.

### Los que sí llegan a un negocio en V2 sin mesero

Estos dos son PREVIOS al mesero y valen para cualquier negocio con
`pedido_reconciliador_v2`. No son de esta auditoría pero salieron de ella:

- **NOTAS no comprueba de qué renglón habla el cliente.** Con «la BBQ bien
  cocida», la nota puede aterrizar en la Clásica. `cantidad` y `modificadores`
  sí exigen atribución; `notas` no.
- **La cantidad de un renglón NUEVO se autoriza con todo el ciclo.** «Y una
  coca» puede entrar como 2 si el número está en cualquier turno anterior.
  `depurarNuevo` usa `ctx.dicho`, no el turno.

### CERRADO después: la familia del consentimiento

Los cinco que compartían raíz —20, 22, 27, 28 y 29— se corrigieron en una
segunda pasada. La raíz era una sola línea de `leerRespuesta`:

> «nombrarla y no negarla es aceptarla»

Convertía una coincidencia de palabras en consentimiento. Ahora una propuesta
solo pasa a aceptada con una **señal afirmativa explícita**; nombrar solo
desempata entre lo ya ofrecido, y solo después de que esa señal exista. Además
las cláusulas que son pregunta se apartan antes de mirar nada, la negación se
reconoce también al final de la frase, y elegir otra cosa rechaza la ofrecida.

Están fijados en `test/fase-mesero-consentimiento.mjs` (22 casos) con cinco
mordidas que tumban.

### Los que quedan abiertos (solo sombra)

| # | Qué pasa |
|---|---|
| 3 | La elección de presentación (nombre + id) no llega a `fusionar` por el camino del mesero |
| 4 | Un cambio congelado no produce pregunta: `recolectarAclaraciones` no lee `congelados` |
| 7 | Un renglón que el modelo inventa puede BLOQUEAR un cambio de cantidad legítimo |
| 8 | El mismo renglón fantasma bloquea un «quítale la cebolla» |
| 13 | Un modificador que el modelo estructura tarde anula un «quítalo», en silencio |
| 14 | Un renglón nacido en el mismo turno no se puede cancelar en esa frase |
| 23 | La cortesía («¿me puedes…?») clasifica la orden como consulta y se descarta callando |
| 30 | «Ponme uno más de hotcakes» duplica el renglón en foco en vez de agregar hotcakes |

Ocho, más los dos previos de arriba que sí llegan a un negocio en V2 sin mesero
(la nota sin atribución y la cantidad de un renglón nuevo): **diez en total**.

Tres de ellos —4, 13 y 14— comparten una forma: el sistema decide no aplicar
algo y **no lo dice**. `recolectarAclaraciones` solo lee `ambiguos`,
`porConfirmar`, términos y grupos; nunca `congelados` ni `sinRespaldo`. Es el
siguiente grupo que abordaría, y probablemente con un solo cambio.

## Las dos mordidas que no muerden

Se preguntó explícitamente por ellas.

**E6 — el clon del carrito productivo en la sombra.** Quitarlo no tumba nada, y
seguirá sin tumbar nada mientras `reconciliar` no mute su entrada. **Queda como
invariante estructural, no como mordida.** Inventar una prueba que «detectara»
el clon obligando a algo a mutar mediría el andamio.

Lo que sí se añadió es `V2b`: se le presta a la observación un carrito
CONGELADO en profundidad. Hoy pasa; el día que alguien introduzca una escritura,
se pone rojo aunque el clon siga en su sitio. Eso es lo que de verdad hay que
vigilar.

**E9 — el emparejamiento por `lid` explícito.** En la sesión anterior no tumbaba
nada porque no había ninguna garantía que morder: el `lid` se aceptaba sin
comprobar. Ahora hay una —la plausibilidad— y **la mordida tumba `A2`**, que es
exactamente el caso pedido: la similitud textual apunta a una línea, el `lid`
apunta a otra, y el `lid` por sí solo no autoriza.
