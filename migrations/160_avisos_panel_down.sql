-- Reversa MANUAL de la 160 (nadie la ejecuta en automático: solo con psql y a
-- propósito). Antes de correrla, regresa al binario anterior: el nuevo guarda
-- aquí los avisos del panel y, sin la tabla, cada aviso se pierde (el bot y
-- los pedidos siguen igual: guardar un aviso nunca detiene nada).
--
-- Borra los avisos guardados. Son avisos, no ventas ni cortes: nada más los lee.

DROP TABLE IF EXISTS avisos_panel;
