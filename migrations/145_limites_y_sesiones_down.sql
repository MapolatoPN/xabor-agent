-- Reversa de la 145. Despliega primero el binario anterior a la 145: el nuevo
-- lee y escribe las dos tablas en cada login, PIN y cierre de sesión.
-- Lo que se pierde: los intentos en curso (los contadores vuelven a cero) y
-- las sesiones cerradas que aún no vencían (vuelven a valer hasta sus 12 h),
-- igual que pasaba con cada despliegue antes de la 145.
DROP TABLE IF EXISTS sesiones_revocadas;
DROP TABLE IF EXISTS limites_acceso;
