-- Rollback deliberadamente NO destructivo de la 090.
--
-- La 090 no cambia esquema: añade `terminadoEn` a fotografías JSON existentes.
-- Esa clave es compatible hacia atrás; los binarios anteriores conservan los
-- campos desconocidos al serializar el estado.
--
-- No hay forma de distinguir después entre una fecha rellenada por la 090 y
-- una escrita legítimamente por el código nuevo. Borrar todas las claves sería
-- pérdida de datos y, para los estados `fallido`, no habría libro de operaciones
-- desde el que reconstruirlas. Por eso volver al binario anterior no requiere
-- ni autoriza modificar las conversaciones vivas.

DO $rollback$
BEGIN
  RAISE NOTICE '090 down: no-op seguro; terminadoEn es compatible hacia atrás y no se borra';
END
$rollback$;
