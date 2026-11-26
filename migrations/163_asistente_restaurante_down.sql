-- Reversa MANUAL de la 163 (nadie la ejecuta en automático: solo con psql y a
-- propósito). Antes de correrla, regresa al binario anterior o apaga la
-- bandera asistente_restaurante_v1 en todas las sucursales: el binario nuevo
-- escribe aquí cada mañana.
--
-- Borra los avisos del asistente, las opiniones y lo silenciado. Son avisos,
-- no ventas, cortes ni facturas: nada más los lee.

DROP TABLE IF EXISTS asistente_restaurante_silenciados;
DROP TABLE IF EXISTS asistente_restaurante_opiniones;
DROP TABLE IF EXISTS asistente_restaurante_hallazgos;
DROP TABLE IF EXISTS asistente_restaurante_corridas;
