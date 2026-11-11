-- ============================================================
-- XABOR — Migración 136: número consecutivo por sucursal.
--
-- El folio XAB- sale de UNA secuencia para todos los negocios
-- (folio_pedido_seq, 059): Obispado y Acuña se intercalan, y en la lista de
-- «Pedidos del día» de una sucursal faltan los números que tomó la otra. Un
-- hueco no significaba nada. Mario pidió (10-nov-2026) que cada sucursal lleve
-- su propia numeración, para que un hueco sea algo que explicar.
--
-- Es un número ADICIONAL. El folio XAB- no cambia: sigue siendo la identidad
-- del pedido para pagos, impresión, facturas y WhatsApp.
--
-- Decisiones de Mario:
--   - Se muestra como prefijo + número (OB-152). El prefijo vive en
--     configuracion, clave `numero_sucursal_prefijo`.
--   - No se reinicia nunca.
--   - Empieza en 1 al encenderlo; los pedidos viejos no se numeran.
--   - Nace APAGADO para todos: se enciende por sucursal con la clave
--     `numero_sucursal_activo` = 'true'. Esta migración no escribe ninguna.
--
-- SIN HUECOS. Una secuencia no sirve: nextval no se revierte con el ROLLBACK,
-- así que un INSERT fallido dejaría un número perdido. El contador es una fila
-- por negocio que se incrementa dentro de la misma transacción del pedido: si
-- el pedido no se guarda, el número tampoco se consume.
--
-- NUNCA RECHAZA UN PEDIDO. Todo el trabajo va dentro de un bloque EXCEPTION:
-- ante cualquier error (cerrojo que tarda más de 3 s, tabla dañada, número
-- repetido), el pedido se guarda SIN número y queda un WARNING en el log. La
-- Caja enseña los pedidos que se quedaron sin número.
--
-- ORDEN DE LOS TRIGGERS. Los BEFORE del mismo evento corren en orden
-- alfabético, y si uno devuelve NULL el INSERT se descarta y los siguientes ya
-- no corren. Por eso este se llama trg_zz_…: corre después de la barrera de
-- folios (trg_barrera_folio_historico, 061, que descarta folios ya
-- reclamados) y de trg_pedidos_activos_estado_json (086). Un INSERT que la
-- barrera descarta no gasta número.
--
-- ON CONFLICT (folio) DO NOTHING. Los BEFORE corren antes de que Postgres vea
-- el conflicto, así que un re-guardado del mismo folio (whatsapp-meta, el
-- scheduler de programados, la venta de mesa) gastaría un número que luego se
-- descarta. Con el cerrojo del contador ya tomado, si el folio ya está en
-- pedidos_activos no se numera.
--
-- EL LEDGER. pedido_numeros_sucursal guarda qué folio recibió cada número y
-- sobrevive al DELETE del pedido: es lo que permite decir «falta OB-130: era
-- XAB-3170 y se eliminó». Un programado que vuelve a la agenda (062 borra la
-- fila) y se reactiva con el mismo folio recupera SU número.
--
-- Aditiva y reejecutable. No cambia ninguna fila existente.
-- ============================================================

-- La fila del pedido lleva su número. Nullable: los pedidos de antes de
-- encenderlo y los de una sucursal apagada no tienen.
ALTER TABLE pedidos_activos ADD COLUMN IF NOT EXISTS numero_sucursal integer;

-- Un contador por negocio. Sin FK a negocios a propósito, como
-- folios_pedido_usados: dar de baja un negocio no debe tropezar con esto.
CREATE TABLE IF NOT EXISTS pedido_numero_sucursal_contador (
  negocio_id  uuid        NOT NULL,
  ultimo      integer     NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pedido_numero_sucursal_contador_pkey PRIMARY KEY (negocio_id),
  CONSTRAINT pedido_numero_sucursal_contador_ultimo CHECK (ultimo >= 0)
);

-- Qué folio recibió cada número. La PK garantiza que un número se da una sola
-- vez por sucursal; el UNIQUE, que un folio tiene un solo número.
CREATE TABLE IF NOT EXISTS pedido_numeros_sucursal (
  negocio_id   uuid        NOT NULL,
  numero       integer     NOT NULL,
  folio        text        NOT NULL,
  asignado_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pedido_numeros_sucursal_pkey PRIMARY KEY (negocio_id, numero),
  CONSTRAINT pedido_numeros_sucursal_folio_unico UNIQUE (negocio_id, folio),
  CONSTRAINT pedido_numeros_sucursal_numero_positivo CHECK (numero > 0)
);

-- La Caja busca los números asignados en un día.
CREATE INDEX IF NOT EXISTS pedido_numeros_sucursal_asignado
  ON pedido_numeros_sucursal (negocio_id, asignado_at);

-- Sin índice único sobre pedidos_activos (negocio_id, numero_sucursal), a
-- propósito: ese índice se revisa DESPUÉS del trigger, fuera de su bloque
-- EXCEPTION, y un choque ahí rechazaría el pedido. La unicidad la da la PK del
-- ledger; el trigger no reutiliza un número que ya lleve otra fila.

CREATE OR REPLACE FUNCTION xabor_numero_sucursal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
-- xabor-136-v2 (el predeploy verifica esta marca)
DECLARE
  v_activo     boolean;
  v_numero     integer;
  v_lock_prev  text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- El número no se edita: un UPDATE que lo toque conserva el que tenía.
    NEW.numero_sucursal := OLD.numero_sucursal;
    RETURN NEW;
  END IF;

  -- Solo este trigger numera: lo que traiga el INSERT se ignora.
  NEW.numero_sucursal := NULL;
  IF NEW.negocio_id IS NULL OR NEW.folio IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT lower(btrim(valor)) = 'true' INTO v_activo
      FROM configuracion
     WHERE negocio_id = NEW.negocio_id AND clave = 'numero_sucursal_activo';
    IF v_activo IS NOT TRUE THEN
      RETURN NEW;
    END IF;

    -- Los pedidos de una sucursal se numeran de uno en uno. Si otro pedido
    -- tiene el contador tomado más de 3 s, este se guarda sin número antes
    -- que hacer esperar al cliente.
    v_lock_prev := current_setting('lock_timeout');
    PERFORM set_config('lock_timeout', '3s', true);

    INSERT INTO pedido_numero_sucursal_contador (negocio_id) VALUES (NEW.negocio_id)
    ON CONFLICT (negocio_id) DO NOTHING;
    PERFORM 1 FROM pedido_numero_sucursal_contador
     WHERE negocio_id = NEW.negocio_id FOR UPDATE;

    -- Ya con el cerrojo (y una lectura nueva): si el folio ya está, este
    -- INSERT es un re-guardado que ON CONFLICT va a descartar. No gasta número.
    IF EXISTS (SELECT 1 FROM pedidos_activos WHERE folio = NEW.folio) THEN
      PERFORM set_config('lock_timeout', v_lock_prev, true);
      RETURN NEW;
    END IF;

    SELECT numero INTO v_numero
      FROM pedido_numeros_sucursal
     WHERE negocio_id = NEW.negocio_id AND folio = NEW.folio;

    IF v_numero IS NULL THEN
      UPDATE pedido_numero_sucursal_contador
         SET ultimo = ultimo + 1, updated_at = now()
       WHERE negocio_id = NEW.negocio_id
      RETURNING ultimo INTO v_numero;
      -- clock_timestamp y no now(): now() es el inicio de la transacción, y
      -- la Caja reparte los números por día según esta hora. Tomada bajo el
      -- cerrojo, crece en el mismo orden que los números.
      INSERT INTO pedido_numeros_sucursal (negocio_id, numero, folio, asignado_at)
      VALUES (NEW.negocio_id, v_numero, NEW.folio, clock_timestamp());
    ELSIF EXISTS (SELECT 1 FROM pedidos_activos
                   WHERE negocio_id = NEW.negocio_id AND numero_sucursal = v_numero) THEN
      -- El folio vuelve (programado reactivado) pero su número ya lo trae
      -- otra fila: no se repite.
      RAISE EXCEPTION 'el número % ya lo trae otro pedido', v_numero;
    END IF;

    NEW.numero_sucursal := v_numero;
    PERFORM set_config('lock_timeout', v_lock_prev, true);
    RETURN NEW;
  EXCEPTION WHEN others THEN
    -- El bloque se revierte entero (contador, ledger y lock_timeout); el
    -- pedido sigue adelante sin número.
    RAISE WARNING '[136] pedido % guardado sin número de sucursal: %', NEW.folio, SQLERRM;
    NEW.numero_sucursal := NULL;
    RETURN NEW;
  END;
END;
$$;

DROP TRIGGER IF EXISTS trg_zz_numero_sucursal ON pedidos_activos;
CREATE TRIGGER trg_zz_numero_sucursal
  BEFORE INSERT OR UPDATE OF numero_sucursal ON pedidos_activos
  FOR EACH ROW EXECUTE FUNCTION xabor_numero_sucursal();
