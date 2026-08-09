# Xabor Edge — runbook

Operaciones del día a día. Sin credenciales reales en ningún ejemplo.

## Instalar un Edge nuevo

1. Panel → **Configuración → Impresión → Nuevo Edge**. Nombre reconocible
   ("PC Caja", "PC Barra"), no "Edge 1".
2. **Generar código de emparejamiento**. Válido 15 minutos, un solo uso.
3. En la PC: copiar `edge/`, crear `edge/.env` con la URL y lo que entrega el
   canje del código.
4. `node edge/index.js`.
5. Comprobar en el panel que aparece conectado.

## Dar de alta una impresora

Panel → **Configuración → Impresión → Nueva impresora**:

- **Edge**: el que la alcanza por red.
- **Transporte**: `tcp_raw` para impresoras de red; `mock` para dejar el
  reparto configurado antes de que llegue el hardware.
- **Host y puerto**: los reales, levantados en sitio. **No suponer el 9100.**
- **Ancho**: 42 columnas ≈ 80 mm, 32 ≈ 58 mm.

Después: **Test Print**, y comprobar de qué impresora salió el papel.

## Configurar el reparto

Panel → **Configuración → Impresión → Reglas**. Por categoría para lo normal,
por producto para las excepciones:

- `agregar` suma destinos (chilaquiles: su estación **y** cocina general).
- `exclusivo` sustituye los de la categoría.
- La **cuenta** se configura como documento; nunca hereda reglas de cocina.

## Diagnóstico

### No sale nada por ninguna impresora

1. ¿El Edge aparece conectado en el panel? Si no: ¿la PC está encendida?
   ¿tiene internet? ¿el proceso corre?
2. Mirar el log del Edge. `conexion.rechazada` es credencial inválida o
   revocada → generar un emparejamiento nuevo.
3. Si el Edge está conectado y hay pendientes, es cosa de las impresoras.

### No sale por UNA impresora

Panel → **Estado**. Cada impresora muestra su último error:

| Error | Qué pasa | Qué hacer |
|---|---|---|
| `ECONNREFUSED` | La IP responde pero ese puerto no escucha | Puerto equivocado |
| `ETIMEDOUT` | Nadie responde | Impresora apagada, sin red o IP equivocada |
| `EHOSTUNREACH` | No hay ruta | Está en otra red |
| `CONEXION_CORTADA` | Se cortó a media transmisión | Cable, corriente o red inestable |
| `CONFIG_INVALIDA` | Falta host o puerto | Completar la configuración |

Al resolverlo, el Edge reintenta solo. No hace falta reiniciarlo.

### Hay trabajos en `enviado`

Es el desenlace bueno: los bytes salieron y la impresora no protestó. **No
significa que se haya confirmado el papel** — una térmica no lo confirma. Si
el papel no salió estando en `enviado`, es cosa del hardware (sin papel,
atasco) y se resuelve reimprimiendo.

### Hay trabajos en `agotado`

Se acabaron los reintentos automáticos. **No se perdió nada.** Arreglar la
causa y usar **Reimprimir** en el trabajo.

### Hay trabajos en `incierto`

Los bytes salieron y se perdió la confirmación: puede que el papel saliera y
puede que no. **Ir a mirar la impresora.** Si no salió, reimprimir; si salió,
darlo por bueno y seguir. Xabor no lo reintenta solo a propósito: sacaría el
mismo platillo dos veces.

## Ver la cola local

Con el Edge detenido, en la PC:

```bash
node -e "import('./edge/storage/index.js').then(async m => { const a = m.crearAlmacen({rutaDatos:'./edge/datos'}); console.log(a.contarPorEstado()); a.cerrar(); })"
```

## Reimprimir

Panel → **Impresión → Trabajos** → **Reimprimir**, con motivo. Crea un trabajo
**nuevo** que apunta al original; el papel sale marcado `*** REIMPRESION ***`.
El trabajo viejo no se toca: es la evidencia de lo que pasó.

## Revocar o rotar una credencial

Panel → **Configuración → Impresión → Edges → Revocar**. La siguiente
autenticación falla y las conexiones abiertas se caen.

Para rotar: revocar, generar emparejamiento nuevo, canjearlo en la PC y
reiniciar el proceso. **Los trabajos pendientes no se pierden**: siguen en la
nube y se entregan cuando el Edge vuelva.

Revocar cuando: se retira una PC, deja de trabajar alguien con acceso a ella,
o hay sospecha de que el token se filtró.

## Respaldo y recuperación de la cola local

La cola local es **caché**, no la fuente de verdad: el estado real vive en la
nube. Si el archivo se corrompe o se borra, el Edge arranca vacío y la nube le
reenvía lo que no esté confirmado.

Para respaldar de todos modos, con el Edge detenido, copiar `edge/datos/`.

Si un `edge-cola.json` se corrompe, el Edge lo respalda como
`.corrupto-<fecha>.bak` y sigue. Con SQLite en WAL eso no debería ocurrir.

## Detener y arrancar

`Ctrl+C` (o detener el servicio) espera a que termine el envío en curso; no
corta una impresión a la mitad. Al arrancar retoma lo pendiente.

## Qué NO hacer

- **No correr dos Edges con la misma credencial.** El servidor cierra el
  anterior para no duplicar comandas, pero deja de ser predecible cuál
  imprime.
- **No borrar trabajos de la base a mano** para "limpiar". Usar los estados.
- **No cambiar la IP de una impresora** sin actualizarla también en el panel.
- **No poner el token en un chat, un correo o una nota.** Si se necesita en
  otra PC, se genera un emparejamiento nuevo.
