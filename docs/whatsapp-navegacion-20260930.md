# Navegación del menú Mapo — 30 septiembre 2026

Base: `46beff8`. Rama: `fix/whatsapp-retomar-opciones`.

El menú inicial se consumía como una confirmación: después de elegir una
opción, otra elección del mismo menú se rechazaba por diálogo antiguo o token
consumido. Ahora solo `menu_mapo` admite volver a elegir en el mismo ciclo.
Conserva negocio, teléfono, mensaje de origen, estado de envío, ventana de
30 minutos, interruptores, pausas humanas y barreras de pedido registrado.
Los formularios y las confirmaciones mantienen su consumo de una sola vez.
Cambiar de servicio conserva el carrito y rechaza el formulario anterior.

Los subtítulos describen la acción del cliente: elegir platillos, enviar datos
para facturar, solicitar cotización y hablar con una persona.

## Validación local

Node 22.23.3 en Docker, PostgreSQL aislado `test_botones_retomar_20260930`,
preload `test/red-solo-local.mjs`, Meta y modelo simulados.

- `test/fase-inicio-mapo-db.mjs`: 15/15.
- `test/fase-flows-db.mjs`: 26/26.
- `test/fase-botones-persistencia.mjs`: 27/27; incluye concurrencia y fallo
  después del registro sin duplicación del pedido local.
- `scripts/check-inicio-mapo.mjs`: correcto.
- `scripts/check-direccion-zonas.mjs`: 22 correctas, cero fallos.
- `git diff --check`: correcto.

## Dirección: alcance de la evidencia

La nueva regresión comprueba que una dirección ya guardada permanece al
completar el formulario y aparece en el resumen sin volver a solicitarla.
El ejecutor ya incluye la corrección para `cbtis34` frente a `Cbtis 34`;
sus pruebas también pasan. No se modificó el tratamiento de direcciones.

No se recuperaron las conversaciones reales mencionadas en la captura ni se
reprodujo todavía su fallo de interpretación. Se solicitó el texto y el
formulario del caso al dueño; no debe considerarse resuelto ese incidente
solo porque la conservación de una dirección guardada pasó las pruebas.

Cambios locales para revisión, sin integración, push ni despliegue. No se
modificaron datos productivos ni se enviaron mensajes, cobros o tickets reales.
