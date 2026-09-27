-- Auditoria de la carta de WhatsApp - VARIANTE A: ANTES de la 098.
-- Usar solo si  SELECT to_regclass('public.whatsapp_productos');  devuelve NULL.
-- Solo lectura. No publica, no inserta, no selecciona productos por nombre:
-- las columnas r_* son banderas heuristicas para REVISAR, no para decidir.
-- La seleccion final de la carta la decide el DUENO de cada negocio: esta consulta
-- solo lista lo que se publicaria o ya esta publicado. No publica "todo" ni elige
-- productos por nombre. Correr con: psql <URL> -q -v ON_ERROR_STOP=1 --csv -f <archivo> -o carta.csv
BEGIN READ ONLY;

WITH k AS (
  -- Letras acentuadas por codigo (el SQL queda 100% ASCII y no se corrompe al
  -- pegarlo desde PowerShell). chr() devuelve el caracter Unicode en UTF8.
  SELECT chr(225)||chr(233)||chr(237)||chr(243)||chr(250)||chr(252)||chr(241)
       ||chr(193)||chr(201)||chr(205)||chr(211)||chr(218)||chr(220)||chr(209) AS con_acento,
         'aeiouunaeiouun'::text AS sin_acento
),
negocios_con_flags AS (
  SELECT n.id AS negocio_id, n.nombre AS negocio,
         n.bot_whatsapp_activo IS TRUE AS bot_whatsapp_activo,
         EXISTS (SELECT 1 FROM configuracion cf
                  WHERE cf.negocio_id = n.id AND cf.clave = 'mesero_agente_v1'
                    AND cf.valor ~* '^[[:space:]]*true[[:space:]]*$') AS mesero_agente_v1
    FROM negocios n
   WHERE n.activo IS NOT FALSE
),
bots AS (
  SELECT * FROM negocios_con_flags
   WHERE bot_whatsapp_activo OR mesero_agente_v1
),
publicacion AS (
  -- MISMA seleccion que la siembra de migrations/098_catalogo_whatsapp.sql:53-59
  -- (tienda_productos publicado, unido a menu_productos del MISMO negocio).
  SELECT tp.negocio_id, tp.producto_id, 'sembraria_098'::text AS origen
    FROM tienda_productos tp
    JOIN menu_productos p
      ON p.id = tp.producto_id AND p.negocio_id = tp.negocio_id
   WHERE tp.publicado = TRUE
),
filas AS (
  SELECT b.negocio, b.negocio_id, b.bot_whatsapp_activo, b.mesero_agente_v1,
         c.id AS categoria_id, c.nombre AS categoria, c.activa AS categoria_activa,
         p.id AS producto_id, p.nombre AS producto, p.precio,
         tpp.precio_tienda, p.disponible, p.agotado, pub.origen,
         ' ' || regexp_replace(translate(lower(coalesce(c.nombre, '')), k.con_acento, k.sin_acento),
                               '[^a-z0-9]+', ' ', 'g')
         || ' ~ '
         || regexp_replace(translate(lower(coalesce(p.nombre, '')), k.con_acento, k.sin_acento),
                           '[^a-z0-9]+', ' ', 'g') || ' ' AS texto
    FROM bots b
    CROSS JOIN k
    LEFT JOIN publicacion pub ON pub.negocio_id = b.negocio_id
    LEFT JOIN menu_productos p
      ON p.id = pub.producto_id AND p.negocio_id = pub.negocio_id
    LEFT JOIN menu_categorias c
      ON c.id = p.categoria_id AND c.negocio_id = p.negocio_id
    LEFT JOIN tienda_productos tpp
      ON tpp.negocio_id = p.negocio_id AND tpp.producto_id = p.id AND tpp.publicado = TRUE
),
evaluado AS (
  SELECT f.*,
         -- La carta que ve el bot: publicado y categoria activa del mismo negocio
         -- (src/services/catalogoWhatsapp.js:76-84).
         (f.producto_id IS NOT NULL AND f.categoria_activa IS TRUE) AS en_carta_bot,
         -- Lo que cuenta el release gate (scripts/release-gate.mjs:80-86).
         (f.producto_id IS NOT NULL AND f.categoria_activa IS TRUE
           AND f.disponible IS NOT FALSE AND f.agotado IS NOT TRUE) AS vendible
    FROM filas f
),
marcado AS (
  SELECT e.*,
         count(*) FILTER (WHERE e.en_carta_bot) OVER w AS carta_del_negocio,
         count(*) FILTER (WHERE e.vendible)     OVER w AS vendibles_del_negocio,
         e.texto ~ ' (extras?|adicional|adicionales|agregados?|complementos?|toppings?|sueltos?|sueltas?|piezas?|modificador|modificadores) ' AS r_extra,
         e.texto ~ ' (internos?|internas?|staff|empleados?|colaboradores?|cortesias?|mermas?|no usar|no vender|ocultos?|ocultas?|descontinuados?|descontinuadas?|obsoletos?|duplicados?|duplicadas?|copia|gratis) ' AS r_interno,
         e.texto ~ ' (insumos?|materias? primas?|inventario|granel|ingredientes?|costales?|bultos?|mayoreo|proveedor|proveedores) ' AS r_insumo,
         e.texto ~ ' (empaques?|envases?|desechables?|contenedor|contenedores|charolas?|bolsas?|popotes?|cubiertos?|servilletas?|domos?|unicel|recipientes?|packaging|para llevar|to go|togo) ' AS r_empaque,
         e.texto ~ ' (pruebas?|probar|test[a-z0-9]*|demos?|ejemplos?|borrar|eliminar|temporal|temporales|tmp|temp|dummy|sample|xxx+|zzz+|asdf[a-z0-9]*|qwerty|sin nombre|nuevo producto|producto nuevo|nueva categoria|categoria nueva) ' AS r_prueba,
         (e.producto_id IS NOT NULL AND (e.precio IS NULL OR e.precio <= 0)) AS r_precio_cero,
         (e.producto_id IS NOT NULL AND (e.disponible IS FALSE OR e.agotado IS TRUE)) AS r_no_disponible_o_agotado,
         (e.producto_id IS NOT NULL AND e.categoria_activa IS NOT TRUE) AS r_categoria_inactiva,
         (e.precio_tienda IS NOT NULL AND e.precio_tienda IS DISTINCT FROM e.precio) AS r_precio_tienda_distinto
    FROM evaluado e
  WINDOW w AS (PARTITION BY e.negocio_id)
)
SELECT m.negocio, m.negocio_id, m.bot_whatsapp_activo, m.mesero_agente_v1,
       m.categoria_id, m.categoria, m.categoria_activa,
       m.producto_id, m.producto, m.precio, m.precio_tienda,
       m.disponible, m.agotado, m.origen,
       m.en_carta_bot, m.vendible, m.carta_del_negocio, m.vendibles_del_negocio,
       m.r_extra, m.r_interno, m.r_insumo, m.r_empaque, m.r_prueba,
       m.r_precio_cero, m.r_no_disponible_o_agotado, m.r_categoria_inactiva,
       m.r_precio_tienda_distinto,
       NULLIF(concat_ws('; ',
         CASE WHEN m.producto_id IS NULL THEN 'NEGOCIO SIN PRODUCTOS PUBLICADOS' END,
         CASE WHEN m.vendibles_del_negocio = 0 THEN 'release gate lo bloquea (0 vendibles)' END,
         CASE WHEN m.r_extra THEN 'extra/adicional/pieza' END,
         CASE WHEN m.r_interno THEN 'interno/cortesia' END,
         CASE WHEN m.r_insumo THEN 'insumo' END,
         CASE WHEN m.r_empaque THEN 'empaque' END,
         CASE WHEN m.r_prueba THEN 'prueba/demo' END,
         CASE WHEN m.r_precio_cero THEN 'precio 0 o nulo' END,
         CASE WHEN m.r_no_disponible_o_agotado THEN 'no disponible o agotado' END,
         CASE WHEN m.producto_id IS NOT NULL AND m.categoria_id IS NULL
                THEN 'sin categoria del negocio: el bot no lo vera'
              WHEN m.r_categoria_inactiva THEN 'categoria inactiva: el bot no lo vera' END,
         CASE WHEN m.r_precio_tienda_distinto THEN 'precio tienda distinto (WhatsApp cobra el del menu)' END
       ), '') AS revisar
  FROM marcado m
 ORDER BY m.negocio, m.negocio_id, m.categoria, m.categoria_id, m.producto, m.producto_id;

ROLLBACK;
