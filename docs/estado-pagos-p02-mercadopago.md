# P0-2 (Mercado Pago): dónde quedó — reproducido y entendido, NO cerrado

Estado: **bloqueo abierto**. El último checkpoint verde de la rama es `0e2c78d`.
El trabajo en curso está en `docs/WIP-p02-mercadopago.patch.txt` (no aplicado).

## Lo que la documentación oficial dice (verificado esta noche)

`GET /checkout/preferences/search?external_reference=` devuelve, por elemento:
`id`, `client_id`, `collector_id`, `date_created`, `expiration_date_from/to`,
`items`, `marketplace`, `site_id`, `sponsor_id`.

**No devuelve `init_point` ni `external_reference`.**

Por lo tanto la recuperación honesta son DOS pasos:

    search por external_reference  ->  id
    GET /checkout/preferences/{id} ->  external_reference real + init_point
    verificar que ese external_reference es el de NUESTRA fila
    adoptar

El mock anterior inventaba `init_point` dentro del search, así que la prueba
pasaba por un campo que la API real no garantiza.

## Lo que ya está implementado en el WIP y VERIFICADO

- `buscarCheckoutPorReferencia` en dos pasos, con verificación de
  `external_reference` en el GET individual.
- Mock alineado a la forma documentada (search sin URL, GET individual con URL).
- Casos que **pasan** con el WIP aplicado:
  - `2d` recupera y adopta sin crear una segunda preferencia;
  - `2f` demuestra que la URL salió del GET individual, no del search.

## Lo que falta y por qué no se cerró

Tres casos obligatorios quedaron en rojo con el WIP aplicado:

- `2g` search vacío tras la respuesta perdida -> no debe crear otra preferencia;
- `2h` dos preferencias con la misma referencia -> anomalía, jamás `elements[0]`;
- `2i` el GET individual devuelve otra referencia -> no adoptar.

La lógica de producto para los tres está escrita (reintentos con espera
configurable, `preferencias_duplicadas`, `preferencia_ajena`,
`creacion_ambigua_sin_resolver`, y `CreacionAmbiguaError` en los tres caminos).
Lo que **no está demostrado** es que los fixtures de la prueba manipulen el mock
como la prueba supone: 2d y 2f pasan, así que la rama de ambigüedad SÍ se
ejecuta y el search SÍ se llama; el fallo apunta a cómo la prueba oculta,
duplica o altera las preferencias del mock, no necesariamente al código.

**No se dio por bueno.** Mañana: depurar los tres fixtures primero, confirmar si
el código también falla, y sólo entonces cerrar el P0.

## Riesgo mientras siga abierto

Read-after-write del search de Mercado Pago no está garantizado en la
documentación. Hasta cerrar esto, una creación ambigua de MP puede resolverse
creando una segunda preferencia si el search responde vacío por indexación
tardía. El pedido no cocina sin dinero verificado (esa invariante no depende de
esto), pero el cliente podría ver dos checkouts.
