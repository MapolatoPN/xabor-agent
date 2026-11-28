# Asistente del restaurante, Fase 3: IA y resumen por WhatsApp

Aprobado por el dueño el 27-nov-2026. Todo nace **apagado** en cada sucursal:
lo enciende quien recibe los avisos del asistente, en Configuración ›
🤖 Asistente › «Redacción con IA y resumen por WhatsApp».

## Qué hace

1. **Redacción con IA** (casilla «Redactar los avisos y el resumen con IA»).
   Cada mañana, después de calcular los avisos con las reglas de siempre, la
   IA (Claude Opus 5.5) elige el orden y redacta título, explicación y «qué
   hacer». Xabor revisa la respuesta antes de guardarla:
   - cada número del texto tiene que ser uno de los que calcularon las reglas
     (o una fecha del aviso);
   - nada de «porque…», «debido a…» ni causas que la IA no puede saber;
   - nada que parezca un dato personal (teléfonos, correos);
   - largos máximos y sin saltos de línea;
   - los avisos de control (descuentos, cancelaciones, cortesías…) no se
     pueden quitar.
   Si algo no cuadra, ese aviso sale con el texto de las reglas. Si la
   respuesta entera no sirve, salen los avisos de siempre. Los números de
   «Ver números» son siempre los de las reglas.
2. **Resumen diario** (casilla y hora, de 18:00 a 23:30; de siempre 21:30).
   La venta del día hasta esa hora contra el mismo día de la semana pasada
   hasta la misma hora. Los pedidos grandes van aparte para no inflar la
   comparación. Hasta 3 puntos y una sugerencia. Un día sin ventas no se
   manda.
3. **Resumen semanal** (casilla). Los lunes a las 9:00: la semana pasada
   (lunes a domingo) contra la anterior. Espera a que termine la revisión de
   la mañana, o a las 10:00, lo que pase primero. Después de las 14:00 ya no
   se manda.
4. **Tope de gasto de la IA** por sucursal y por mes (de US$1 a US$50; de
   siempre US$10). Antes de cada llamada se calcula el peor caso; si con él se
   pasaría del tope, la IA no se llama y todo sale con el texto de siempre. La
   campanita avisa una vez al mes. Subir el tope reactiva la IA el mismo mes.

El resumen solo se manda a **un número por sucursal**, el que se escribe en la
tarjeta. Vacío = no se manda nada. En la bitácora y en el registro de envíos
quedan solo los últimos 4 dígitos.

## La plantilla de WhatsApp (hay que darla de alta)

Un mensaje del negocio que no contesta a uno del cliente en las últimas 24 h
solo puede salir con una **plantilla aprobada por Meta**. La plantilla se da de
alta **en la cuenta de WhatsApp de cada sucursal** (cada una tiene la suya): en
WhatsApp Manager › Plantillas de mensajes › Crear plantilla.

| Campo | Valor |
|---|---|
| Nombre | `xabor_resumen_asistente_v1` |
| Categoría | Utilidad (`UTILITY`) |
| Idioma | Español (México) — `es_MX` |
| Encabezado | ninguno |
| Pie | ninguno |
| Botones | ninguno |

Cuerpo (copiar tal cual, con sus saltos de línea):

```
Resumen de {{1}} ({{2}}):
• Venta: {{3}}
• {{4}}
• {{5}}
• {{6}}
Sugerencia: {{7}}
Mensaje automático de Xabor; el detalle está en Reportes.
```

Ejemplos para el formulario de Meta (datos inventados):

| Variable | Qué lleva | Ejemplo |
|---|---|---|
| `{{1}}` | la sucursal | Sucursal Centro |
| `{{2}}` | el periodo | jueves 26 nov |
| `{{3}}` | la venta y la comparación | $12,400 hasta las 21:30, 8 % más que el jueves pasado ($11,480) |
| `{{4}}` | punto 1 | 2 pedidos grandes por $3,100 van aparte |
| `{{5}}` | punto 2 | Las bebidas bajaron 15 % contra su promedio |
| `{{6}}` | punto 3, o «—» si no hay | — |
| `{{7}}` | la sugerencia | El viernes pasado vendiste $13,900: prepara insumos para un día parecido |

Reglas que respeta Xabor al llenar las variables (si no, Meta rechaza el
envío): ninguna va vacía (se usa «—»), ninguna lleva saltos de línea, cada una
mide como mucho 200 caracteres y el cuerpo completo no pasa de 1,024.

**Riesgo conocido:** Meta puede reclasificar la plantilla como Marketing. Si lo
hace, cada envío se cobra como Marketing; el mensaje sale igual.

## Cómo se prueba

En la tarjeta, después de guardar el número: **Enviar prueba**. Manda la
plantilla con un texto de prueba al número guardado (nunca a uno que venga en
la petición). Máximo 5 pruebas por hora y sucursal. La tarjeta dice si Meta la
aceptó o por qué no; los últimos 5 envíos aparecen debajo del botón.

## Qué pasa cuando algo falla

| Caso | Qué se ve | ¿Se reintenta? |
|---|---|---|
| La plantilla no existe o no está aprobada (Meta 132001) | Campanita: «El resumen por WhatsApp no salió» | No |
| La sucursal no tiene WhatsApp conectado | Campanita, mismo aviso | No |
| Meta no contestó a tiempo | Registro «Sin confirmar»; campanita | No (podría duplicarse) |
| La IA falla, tarda o responde algo que no cuadra | Nada: sale el texto de siempre | — |
| Se llegó al tope de gasto | Campanita, una vez al mes | — |

Un resumen se manda una sola vez por sucursal, tipo y día (lo garantiza un
índice único de la base); dos servidores a la vez no lo duplican.

## Dónde vive

- Migración `165_asistente_ia_resumen.sql` (y su `_down.sql`); predeploy
  `scripts/predeploy-165-asistente-ia-resumen.mjs`.
  - `asistente_restaurante_corridas.ia`: cómo le fue a la IA esa mañana.
  - `asistente_restaurante_resumenes`: cada envío (diario, semanal, prueba).
  - `asistente_restaurante_gasto_ia`: cada llamada a la IA, con su costo.
  - Dos tipos nuevos de la campanita: `asistente_resumen_fallo` y
    `asistente_tope_ia`.
- La configuración va en `configuracion`, clave `asistente_restaurante_resumen`
  (JSON), por sucursal.
- Código: `src/asistenteRestaurante/ia.js` (llamada y tope),
  `redaccion.js` (revisión del texto de los avisos), `resumen.js` (cálculo y
  variables), `envioResumen.js` (el reloj de cada minuto y el envío).

## El reporte de las 22:01 se retiró

El reporte de corte de caja por WhatsApp de las 22:01 (`enviarReporteDiario`)
usaba un solo número global y la conexión de un negocio por omisión, y Meta lo
rechazaba cada noche. Se quitó del servidor. `POST
/api/admin/reporte-diario/enviar` sigue siendo solo para superadmin y responde
410. `WHATSAPP_ADMIN_NUMERO` se queda: la usan las alertas de quejas.

## Reversa

- Sin tocar código: apagar las casillas en la tarjeta de cada sucursal.
- Código: volver al despliegue anterior. Las tablas nuevas no estorban al
  código viejo (la Fase 2 no las lee).
- Base, solo a propósito y a mano: `psql -f
  migrations/165_asistente_ia_resumen_down.sql`. Borra los registros de envío,
  el gasto de la IA y los avisos de la campanita de los dos tipos nuevos.
- **Orden: primero el código, después la base.** El código de la Fase 3 sin la
  165 no termina la corrida de la mañana (anota en `corridas.ia`, que la 165
  agrega). Al revés no pasa nada: el código de la Fase 2 con la 165 aplicada
  funciona igual que hoy.
