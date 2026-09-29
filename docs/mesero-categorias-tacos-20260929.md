# Categorías, cantidades y notas para cocina — 29 sep 2026

## Alcance autorizado

El dueño solicitó categorías dentro del formulario de WhatsApp, agregar tacos
por cantidades y publicar las correcciones para el mismo número piloto. Esta
entrega incluye las notas por platillo del commit `1b92eba`.

- Menú: categoría → platillos de esa categoría → opciones del platillo, sin
  terminar el formulario ni mandar un mensaje entre cada selección.
- Tacos: tortilla explícita por lote y cantidad de cada guiso (0–20). Es un
  selector numérico nativo, NO un control visual +/- personalizado.
- Notas opcionales por platillo o guiso: máximo 300 caracteres. Si se piden
  varias piezas de un mismo renglón, comparten opciones y nota. Preparaciones
  distintas se capturan con Agregar más, en otro renglón/lote.
- Agregar más, Guardar y ver categorías y ORDEN COMPLETA. El botón Atrás
  solicita una revisión actualizada; conserva renglones ya guardados, no guarda
  silenciosamente una selección incompleta de la pantalla abandonada.
- Entrega y pago conservan su pantalla existente. La confirmación comercial
  ocurre después del resumen canónico, no al guardar selecciones del formulario.

Las categorías, precios y productos salen exclusivamente de la carta publicada
para WhatsApp. Se respeta el orden comercial y se desempata por identidad para
evitar que empates de SQL cambien posiciones entre lecturas.

## Tacos y límites

El lote admite hasta 12 guisos simultáneos: precio positivo y un único grupo
Tortilla con Harina/Maíz sin recargo y cardinalidad compatible con una elección.
La identidad de la tortilla se resuelve para cada producto, nunca por un índice
compartido ni por texto del modelo. El catálogo piloto leído ofrecía 11 tacos
compatibles. Productos con otras opciones, como Frijol o TACOS genérico, siguen
disponibles en Otros tacos → Elegir y personalizar un taco; no se inventan sus
opciones. Si crece el catálogo, los que excedan 12 conservan esa ruta individual.

El límite defensivo del borrador es 50 renglones, no tres platillos. Las cantidades
son enteras de 1–20 por renglón. Un 0 en tacos significa no agregar ese guiso y
limpia su nota oculta; no elimina renglones guardados anteriormente.

## Seguridad y compatibilidad

- Nueva clave `whatsapp_flow_categorias_id`, con prioridad sobre el Flow
  repetible anterior. Sin esa clave, el recorrido anterior no cambia.
- Foto durable `repetible_v1` con `presentacion: categorias_v1`; el cliente
  devuelve únicamente token y revisión al finalizar. Precios e identidades se
  resuelven contra la foto del servidor y se revalidan contra catálogo vigente.
- Guardado del lote completo bajo los locks existentes: dos procesos o doble
  envío no duplican renglones. Las opciones inválidas no dejan cambios parciales.
- Cantidades y notas generan comandos del ejecutor canónico, con autorización
  exacta no serializable; no se convierten las notas en instrucciones comerciales.
- Continúan corte maestro, pausa humana, piloto, ventana de 24 horas al enviar,
  firma/cifrado, caducidad, revisión de precio y confirmación única.
- El transporte solo admite el ID activo configurado para data_exchange. Un
  formulario anterior o un ID ajeno no se envían como formulario nuevo.
- Sin migración, cambios a zonas, tarifas, pagos, impresoras o componentes
  protegidos. No se reinician conversaciones ni se amplía el canario.

## Verificación

- `scripts/check-flow-categorias.mjs`: selección filtrada, cantidades,
  tortillas con índices distintos, notas independientes, rechazo atómico,
  regreso al menú, empates del catálogo, contrato anterior y barreras de envío.
- `npm run test:incident`: gate obligatorio y regresiones en verde. La nueva
  suite se importa en serie porque sus pruebas de transporte varían variables
  de entorno; ejecutarla concurrentemente produjo una interferencia de pruebas,
  corregida sin debilitar verificaciones.
- `npm run mesero:tools`: 66/66.
- `test/fase-flows-webhook.mjs --categorias`: dos procesos y webhook cifrado,
  tacos 2 de bistec + 3 de papa y 2 mixtos, notas por renglón, Atrás, reinicio,
  recibo repetido y una única orden LOCAL de $415; ninguna llamada al modelo.
- `test/fase-flows-webhook.mjs --repetible`: ocho platillos con notas distintas,
  reinicio y una única orden LOCAL de $1120; compatibilidad conservada.
- `test/fase-flows-db.mjs`: 18/18, incluidas pausas, precio cambiado, ventana
  vencida, contexto ajeno, payload falso y reintentos.
- Postgres desechable `test_botones_observaciones_20260929`; bloqueo de red
  externa y Meta/modelo simulados. Sin mensajes, cobros o tickets reales.

El test HTTP asigna orden explícito a los productos ficticios. Antes de ello,
un empate de orden intercambió la posición de los dos tacos: el total observado
era correcto para lo elegido, pero la expectativa del test era incorrecta.

No se reejecutó la suite DB canónica completa; su fallo histórico `05-06`
(«la segunda»), documentado previamente, no se corrige ni certifica aquí.
No hay prueba visual móvil nueva todavía. Se intentó abrir la vista previa de
Meta pero esta sesión no dispone de navegador. La documentación de
[enrutamiento de Meta](https://developers.facebook.com/docs/whatsapp/flows/reference/flowjson/#routing-rules)
se consultó para el modelo de avance y refresco al regresar. El recorrido de
Guardar y ver categorías y el botón Atrás deben comprobarse en el piloto móvil.

## Meta y publicación

Definición final validada por Meta, sin errores:

- Flow `1579871723825809`.
- Nombre `xabor_categorias_agrupado_21a672a8687f`.
- SHA256 `21a672a8687f5c3ff2cc1a1423b2bc45ebbad45ae06cfefbbfb42df4449a716e`.
- Endpoint existente `https://xabor.mx/webhook/flows/pedido`.
- Un primer borrador (`2048077759180114`) fue rechazado por tres EmbeddedLink
  en una pantalla; se corrigió a dos enlaces y un selector Otros tacos. El
  segundo (`1820386719209000`) validó, pero se reemplazó antes de publicación
  para incorporar refresh_on_back. No se activaron esos borradores.
- Meta reporta advertencia WABA 141006 de facturación para conversaciones
  iniciadas por empresa. No se modifica facturación; este piloto responde a
  mensajes del usuario dentro de la ventana permitida.

Base productiva verificada: `6f39861bf788fbd2d2bcefa47b1cc6413d2fe7e9`, Railway
`e51f5763-25e6-4233-8bcc-7241f127d7e7`, SUCCESS.

## Despliegue y activación completados

- Commit de código `6d5618756389ed4b31320cf76404f4417358b41d`, con `1b92eba`
  (notas) incluido. Push fast-forward de `6f39861` a la rama de producción.
- Meta confirmó `PUBLISHED` para `1579871723825809`; definición sin errores.
- El push no creó un despliegue automático tras las comprobaciones. Se ejecutó
  una sola vez `railway redeploy --yes --from-source`, verificando antes la rama
  remota exacta, sin editar configuración de Railway.
- Railway `2f8a48df-43b4-4ee0-9a03-b75e2ff7f986`: **SUCCESS**, commit exacto
  `6d5618756389ed4b31320cf76404f4417358b41d`. Predeploy completo sin fallos;
  logs incluyen la regresión nueva de categorías. `/health` respondió HTTP 200.
- Solo se agregó `whatsapp_flow_categorias_id=1579871723825809` a Mapolato
  Obispado (`5de544d8-9a0a-4972-9c92-fd48ff22de66`). El script comprobó bot de
  prueba, porcentaje 0, teléfonos limitados al mismo dueño y Flow publicado.
  No modificó carritos, conversaciones, pausas, corte maestro ni tarifas.
- Esta actualización documental se conserva en Git local sin otro push, para
  no disparar un despliegue adicional solo por registrar la evidencia.

Pendiente: prueba visual móvil del formulario nuevo desde un mensaje nuevo
en el teléfono piloto. No se enviaron mensajes reales ni se crearon pedidos
de negocio para simular esa verificación. Probar categorías de ida y vuelta,
dos guisos con cantidades distintas, chilaquiles mixtos con observaciones,
Agregar más y ORDEN COMPLETA. Las pruebas no requieren seguir un orden fijo.

Reversión de presentación: retirar únicamente `whatsapp_flow_categorias_id`
del negocio piloto mediante operación revisada; se conserva el antiguo
`whatsapp_flow_repetible_id=3021606251515164`. No vaciar carritos, borrar estados
ni tocar el corte maestro. Los formularios viejos se sujetan a vigencia y deben
reabrirse desde un mensaje nuevo.
