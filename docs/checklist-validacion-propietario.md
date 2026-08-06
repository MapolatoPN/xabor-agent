# Checklist de validación en navegador — Frentes A y B (propietario)

12 pasos, ~15 minutos, desde `https://xabor.mx`. Cada paso indica si es
**[LECTURA]** (no cambia nada) o **[MODIFICA]** (crea o cambia datos —
hazlo solo si estás de acuerdo con el efecto descrito).

1. **[LECTURA]** Inicia sesión como Superadmin → pestaña **Central de
   Operaciones**. Debes ver los 4 negocios: Nonna Maye, Alora y Mapolato en
   etapa "Activo"; Carnitas Moreno en "Invitación enviada".
2. **[LECTURA]** Abre la **Ficha** de Carnitas Moreno: la sección Cuenta
   debe mostrar la invitación (vigente o expirada según la hora) y "SIN
   acceso todavía"; el checklist con pasos automáticos calculados.
3. **[LECTURA]** Prueba los filtros del listado (etapa "Activo" vs
   "Invitación enviada") y la paginación.
4. **[MODIFICA — dato de acompañamiento real]** En la ficha de Carnitas,
   botón "Editar implementación": captura responsable y siguiente acción
   reales (p. ej. "llamar a Xiomar"). Esto escribe en el registro de
   implementación (es su propósito).
5. **[MODIFICA — sesión temporal auditada]** En la ficha de **Alora**
   (nunca Carnitas): "Entrar como soporte". Debes aterrizar en el panel de
   Alora con la barra naranja "Estás administrando Alora… como Superadmin".
6. **[LECTURA]** Con esa sesión de soporte, abre en otra pestaña
   `https://xabor.mx/superadmin.html`: sus datos NO deben cargar (las APIs
   responden 403 — la consola está bloqueada desde soporte).
7. **[MODIFICA — cierra tu propia sesión]** Botón "Salir y volver a
   Superadmin". Vuelve a iniciar sesión: la sesión de soporte anterior ya
   no sirve.
8. **[LECTURA]** Pestaña **Auditoría**: deben aparecer
   `sesion_soporte_iniciada` y `sesion_soporte_cerrada` de los pasos 5–7.
9. **[LECTURA]** Pestaña **Red de Repartidores** → subvista **Central de
   reparto**: carga la tabla (hoy puede estar vacía si no hay servicios de
   domicilio activos); prueba el filtro por estado.
10. **[LECTURA]** En la misma subvista verifica que los nombres de negocio
    son legibles (no UUIDs) y que ningún pedido de Rappi aparece.
11. **[LECTURA]** Repite los pasos 1 y 9 desde tu teléfono: sin desbordes
    horizontales; las tablas se desplazan dentro de su tarjeta.
12. **[LECTURA]** Panel de Nonna Maye con una sesión normal de cliente:
    comandas y chat operan igual que siempre (regresión visual rápida).

Cualquier resultado distinto: anota el paso y el mensaje exacto — no
intentes corregir desde la interfaz.
