# Xecador · PIN + cara (fase 1, migración 134)

El empleado checa con su PIN, como siempre. Si el negocio lo enciende y ese
empleado tiene su cara registrada, la tablet además le pide mirar a la cámara y
girar un poco la cabeza, y el servidor compara la cara con la registrada.
**La cara nunca impide checar**: si no coincide, o no se pudo ver, la checada
se registra igual y queda «Para revisar».

Decisiones del dueño (10-nov-2026): los empleados firmaron el consentimiento de
reconocimiento facial y datos biométricos; se prueba primero en Acuña; después
de unas semanas se mide qué tanto acierta y el dueño decide si se pasa a «solo
cara».

## Cómo se enciende

1. **Motor en el servidor.** Sin motor no se puede encender ni registrar nada
   (la pantalla lo dice). La variable `XECADOR_CARA_MOTOR` elige el motor:
   - sin la variable: no hay motor (así está producción hoy);
   - `prueba`: el motor de las pruebas automáticas. **Se niega a arrancar con
     `NODE_ENV=production`.**
   - El motor real (detector y comparador de modelos abiertos con licencia
     comercial) llega en un cambio aparte.
2. **Llave.** Usa `INTEGRATIONS_ENCRYPTION_KEY` (la de las integraciones), de
   la que deriva una propia para las caras. Sin ella, falla cerrado.
3. **Consentimiento.** Empleados › tarjeta › **Cara**: se marca «firmó el
   consentimiento» con su fecha (no futura). Sin esa fecha, la base no guarda
   ninguna cara.
4. **Registro.** En el mismo diálogo, con el empleado presente: «Registrar
   cara» abre la cámara y toma 5 fotos de frente. Hacen falta 3 buenas de la
   misma persona; si no, dice por qué (sin cara clara, de lado, más de una
   cara, no parecen de la misma persona). Si se parece a la cara de otro
   empleado, pide confirmar que es otra persona y lo deja escrito.
5. **Interruptor.** Empleados › Checador › «Cara al checar»: *Apagado* (nace
   así) o *Pedir la cara a quien la tenga registrada*.

## Qué pasa al checar

| Resultado | Cuándo | La checada |
|---|---|---|
| `no_requerida` | El interruptor está apagado | Normal |
| `sin_registro` | El empleado no tiene cara registrada (o se registró con otra llave u otro motor) | Normal; la tablet no le pide la cara |
| `coincide` | Es la misma persona y giró la cabeza | Normal. **No se guarda foto** |
| `no_coincide` | La cara no se parece a la registrada | Para revisar, con aviso al administrador y la foto de frente guardada |
| `no_verificada` | Sin cámara, sin cara clara, más de una cara, de lado, sin girar, o el motor falló | Para revisar, con la foto si la hubo |

En «Para revisar», **Comparar** muestra la foto de la checada junto a la
registrada. Sin conexión, la tablet guarda las fotos con la checada y el
servidor compara al sincronizar.

## Qué se guarda y quién lo ve

- Tabla `xecador_caras`: una fila por empleado con las huellas numéricas de la
  cara y una foto de referencia, **cifradas** (AES-256-GCM) y atadas a su
  negocio y expediente: copiadas a otro expediente no se abren.
- Solo el administrador del negocio. El staff, otro negocio y el Superadmin no.
- **Se borran solas** (lo hace la base, con su evento en la bitácora) al
  retirar el consentimiento o al dar de baja al empleado. Al reactivarlo no
  vuelven: hay que anotar el consentimiento y registrar otra vez.
- «Borrar cara» borra la cara y deja el consentimiento.
- La bitácora del expediente cuenta cada consentimiento, registro y borrado,
  con su autor.

## Despliegue y reversa

- La 134 va en el runner del Pre-Deploy después de la 132 y nace apagada: sin
  motor configurado, nada cambia para nadie.
- Reversa: primero el código; después, si se quiere, `migrations/134_xecador_cara_down.sql`
  con `psql`. Borra las caras (son datos biométricos), el interruptor y la fecha
  del consentimiento (que sigue escrita en la bitácora). En las checadas queda
  cómo salió la cara, porque son de solo inserción.

## Pruebas

`test/fase-xecador-cara.mjs` (motor de prueba, base local `test_*`): reglas de
la cara, cifrado, triggers de la base, servidor real (con y sin motor) y
navegador con cámara simulada. `test/fase-xecador-migracion.mjs` (bloque V)
prueba el predeploy-134 y su reversa.
