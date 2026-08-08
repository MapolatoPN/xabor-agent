# Landing de xabor.mx — v2

Rama `feat/landing-xabor-v2` (base de producción ffaf14b). **Sin migración,
sin cambios de backend** salvo el logotipo compartido: es marca y marketing.

## Qué estaba mal

La landing anterior vendía **"un bot de WhatsApp"**:

> Convierte tus mensajes de WhatsApp en pedidos organizados

Ese posicionamiento se quedó corto. Xabor hoy también captura en **POS**,
opera **mesas, meseros, modificadores y comandas**, coordina **entregas** y
registra **pagos**. Un visitante que llegaba a la página no tenía forma de
enterarse: el hero era una conversación de WhatsApp gigante y el resto de la
página giraba alrededor del bot.

Además, la sección "así se ve por dentro" no mostraba producto real, y la
navegación tenía más entradas de las necesarias.

## Posicionamiento nuevo

> **Todo tu negocio, del pedido a la entrega.**
> Recibe pedidos por WhatsApp, captura en el mostrador, atiende mesas con
> comandas y coordina a tus repartidores. Una sola operación, un solo lugar.

WhatsApp sigue presente y con peso propio, pero como **un módulo**, no como
toda la historia.

## Estructura

1. **Hero** — promesa, dos CTAs y un mockup de la operación: la lista de
   pedidos con los tres orígenes reales (WhatsApp, Restaurante, POS) y dos
   tarjetas flotantes ("Comanda enviada", "Repartidor en camino").
2. **Todo en un solo lugar** — los seis módulos: WhatsApp, POS, Restaurante,
   Entregas, Pagos y Equipo.
3. **Así funciona** — cuatro pasos: entra el pedido → Xabor lo organiza → tu
   equipo opera → todo queda registrado.
4. **Por dentro** — pestañas que controla la persona (Pedidos, Restaurante,
   POS, Entregas). **Nada rota solo**: no hay carrusel automático.
5. **Xabor Restaurante** — sección oscura con el tablero de mesas y el
   asistente de modificadores.
6. **Para quién es** — seis segmentos concretos de negocios de comida.
7. **Por qué Xabor** — seis diferenciadores, sin cifras inventadas.
8. **Precio** — dos tarjetas. La izquierda es el **precio regular** ($990 MXN
   al mes + $2,500 de instalación); la derecha va marcada como **promoción
   temporal**. Se dice explícitamente que **no hay comisión por pedido**.
9. **Diseñado para operación real** — señales de confianza honestas.
10. **Preguntas** — ocho dudas reales, respondidas con lo que el sistema hace.
11. **CTA final + formulario** — el mismo `POST /api/public/prospectos`.
12. **Footer** — producto, empezar, Xabor, aviso de privacidad.

## Los mockups son producto real

Están construidos con HTML y CSS, no son capturas ni invenciones: el tablero
usa los **estados reales** ("Disponible", "Por enviar", "Cobrando"), la
comanda muestra **rondas** con su sello de cocina, el asistente muestra
"Paso 2 de 3" con el extra de $30 del bistec, y los folios siguen el formato
`XAB-####`.

**No se muestra nada que el sistema no haga**: sin inventario, sin
facturación, sin dashboards falsos, sin integraciones no confirmadas y sin
operación sin conexión.

## Diseño

- Fondo claro, superficies blancas, una sección oscura para Restaurante.
- El naranja de marca (`#FF6B35`) es **acento y acción**, nunca fondo de
  página. Sin gradientes gratuitos ni glassmorphism.
- **Sin framework y sin fuentes remotas**: tipografía del sistema, un solo
  sprite SVG de iconos, CSS propio (~19 KB). La página no carga JavaScript de
  terceros.
- Puntos de quiebre en 1200, 1080, 860 y 680 px. Verificado sin scroll
  horizontal en 1440×900, 1366×768, 768×1024, 430×932 y 390×844.

## Lo que se conservó tal cual

- El **formulario de demostración** completo: mismos campos, mismo honeypot,
  mismo consentimiento y el mismo `POST /api/public/prospectos`. Solo cambió
  su presentación.
- Los **precios publicados**: $990 al mes y $2,500 de instalación.
- El **aviso de privacidad** y su enlace.

## Pruebas

`test/fase-landing-v2.mjs` (20 casos): el H1 ya no es el del bot, las cuatro
patas del producto están nombradas, las secciones existen y las anclas del
menú llevan a algo, el flujo tiene sus cuatro pasos, las pestañas no se mueven
solas, Restaurante muestra su UI real, hay segmentos concretos, el CTA es
consistente y no aparecen flujos inexistentes, el formulario sigue apuntando
al endpoint que guarda, el precio es el real, el aviso de privacidad responde,
la marca y el SEO están declarados, ningún asset da 404, el HTML no está roto
y no se coló un framework.

## La promoción de agosto

La tarjeta promocional tenía un problema de lectura: decía *"Bonificada ·
Instalación $2,500"* y *"Sí aplica · Mensualidad $990 MXN al mes"*, lo que se
entendía como **$990 en agosto y otros $990 en septiembre**. No es la oferta.

La oferta es: **$990 MXN cubre agosto y septiembre juntos**, con la
instalación incluida; a partir de octubre corre la mensualidad normal de $990.

Por eso el monto va en un bloque propio, más grande que el precio regular
(54 px contra 34 px en escritorio), con los dos meses arriba y la frase
"Total por los dos meses juntos, no por mes" debajo. Las dos filas de abajo
resuelven las dudas inmediatas —qué pasa con la instalación y qué pasa
después— y la vigencia declara *agosto de 2026*.

El **cupo de "5 negocios" se retiró**: la promoción ahora se limita por
tiempo, no por número de negocios. Estaba escrito a mano en la landing (nada
en backend ni en la base), así que quitarlo no tuvo más efecto que el texto.

`fase-landing-v2` vigila la lectura ambigua explícitamente: falla si la
tarjeta vuelve a decir "mensualidad $990 al mes", si desaparece la frase de
"total por los dos meses", o si el monto promocional deja de dominar
tipográficamente sobre el regular.
