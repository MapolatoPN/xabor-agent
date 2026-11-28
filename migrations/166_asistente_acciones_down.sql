-- Reversa MANUAL de la 166 (nadie la ejecuta en automático: solo con psql y a
-- propósito). Antes de correrla, regresa al binario anterior (795e77ad): el
-- nuevo anota aquí cada botón que se pulsa.
--
-- Borra solo el registro de botones usados del asistente. No son ventas,
-- cortes, facturas ni campañas: las campañas que salieron siguen intactas.

DROP TABLE IF EXISTS asistente_restaurante_acciones;
