-- Identidad de pago independiente del correo de acceso a Xabor.
-- No inferir ni reescribir el correo de los contratos anteriores.
BEGIN;
ALTER TABLE suscripciones_basico_mp ADD COLUMN IF NOT EXISTS correo_pagador TEXT;
DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='basico_mp_correo_pagador'
 AND conrelid='suscripciones_basico_mp'::regclass) THEN
 ALTER TABLE suscripciones_basico_mp ADD CONSTRAINT basico_mp_correo_pagador CHECK (
 correo_pagador IS NULL OR (
  length(correo_pagador) <= 254 AND correo_pagador = lower(btrim(correo_pagador))
  AND correo_pagador ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
 ));
END IF;
END $$;
COMMIT;
