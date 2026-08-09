// Simulador de impresora térmica de red.
//
// Existe para poder probar el camino completo -- comanda → routing → job →
// Edge → socket TCP → bytes -- sin una impresora física y sin tocar la LAN
// de ningún restaurante. Guarda todo lo que recibe para poder afirmar en una
// prueba que la comanda salió, una sola vez, por el destino correcto.
//
// Modos que sabe simular, que son los fallos reales que va a haber en sitio:
//
//   online                acepta, guarda los bytes y cierra ordenadamente
//   silenciosa            acepta, lee TODO y NUNCA cierra. Es el
//                         comportamiento de muchas térmicas reales, y el que
//                         destapó que exigir el FIN del peer no era genérico
//   timeout               acepta y no lee ni responde nunca
//   cortar                lee y revienta la conexión con RST (caso ambiguo)
//   rechazar_al_conectar  acepta y revienta ANTES de leer un solo byte
//   cerrar_al_conectar    cierra ordenadamente antes de que terminemos
//   lento                 responde, pero con retraso
import net from 'node:net';

export function crearImpresoraSimulada({ nombre = 'simulada', puerto = 0 } = {}) {
  const recibidos = [];
  let modo = 'online';
  let retrasoMs = 0;
  let servidor = null;
  let puertoReal = null;
  const conexiones = new Set();

  function manejar(socket) {
    conexiones.add(socket);
    socket.on('close', () => conexiones.delete(socket));
    socket.on('error', () => {});

    if (modo === 'timeout') return;                  // ni una respuesta

    // RST inmediato, sin leer nada: el Edge no llegó a enviar un byte, así
    // que el resultado NO es ambiguo -- es un fallo reintentable.
    if (modo === 'rechazar_al_conectar') {
      if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy();
      else socket.destroy();
      return;
    }

    // Cierre ordenado antes de tiempo.
    if (modo === 'cerrar_al_conectar') { socket.end(); return; }

    const trozos = [];
    socket.on('data', (d) => {
      trozos.push(d);
      if (modo === 'cortar') {
        // Bytes recibidos y conexión reventada sin cierre ordenado: el Edge
        // no puede saber si la impresora llegó a imprimirlos.
        //
        // `resetAndDestroy()` y no `destroy()`: destroy() con el buffer de
        // lectura ya vacío manda un FIN normal, que es indistinguible de un
        // cierre correcto. Lo que ocurre de verdad cuando alguien apaga la
        // impresora o se suelta el cable es un RST -- o silencio -- y eso es
        // lo que hay que simular para que la prueba valga algo.
        recibidos.push({ nombre, bytes: Buffer.concat(trozos), texto: Buffer.concat(trozos).toString('latin1'), parcial: true, en: Date.now() });
        if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy();
        else socket.destroy();
      }
    });

    socket.on('end', () => {
      if (modo === 'cortar') return;
      // La impresora que NUNCA cierra: registra lo recibido y deja el socket
      // abierto. El transporte tiene que dar el envío por bueno igual.
      if (modo === 'silenciosa') {
        const bytes = Buffer.concat(trozos);
        recibidos.push({ nombre, bytes, texto: bytes.toString('latin1'), parcial: false, en: Date.now() });
        return;
      }
      const bytes = Buffer.concat(trozos);
      const guardar = () => {
        recibidos.push({ nombre, bytes, texto: bytes.toString('latin1'), parcial: false, en: Date.now() });
        socket.end();
      };
      if (retrasoMs > 0) setTimeout(guardar, retrasoMs);
      else guardar();
    });
  }

  return {
    nombre,
    get puerto() { return puertoReal; },
    recibidos,

    async encender() {
      if (servidor) return puertoReal;
      await new Promise((resolver, rechazar) => {
        // allowHalfOpen: sin esto Node contesta el FIN del cliente por su
        // cuenta en cuanto lo recibe, y el simulador nunca llega a decidir
        // si responde tarde, si corta o si no responde. Con half-open, el
        // cierre lo controla este código -- que es justo lo que se prueba.
        servidor = net.createServer({ allowHalfOpen: true }, manejar);
        servidor.once('error', rechazar);
        servidor.listen(puerto, '127.0.0.1', () => {
          puertoReal = servidor.address().port;
          resolver();
        });
      });
      return puertoReal;
    },

    // Apagar de verdad el puerto: es lo que produce un ECONNREFUSED real,
    // no simulado, contra el transporte de producción.
    async apagar() {
      if (!servidor) return;
      for (const c of conexiones) { try { c.destroy(); } catch {} }
      conexiones.clear();
      await new Promise((r) => servidor.close(r));
      servidor = null;
    },

    // Vuelve a escuchar EN EL MISMO PUERTO: así una prueba puede apagar la
    // impresora, comprobar el reintento y volverla a encender sin cambiar la
    // configuración del job.
    async reencender() {
      if (servidor) return puertoReal;
      await new Promise((resolver, rechazar) => {
        servidor = net.createServer({ allowHalfOpen: true }, manejar);
        servidor.once('error', rechazar);
        servidor.listen(puertoReal, '127.0.0.1', resolver);
      });
      return puertoReal;
    },

    modo(nuevo, { retraso = 0 } = {}) { modo = nuevo; retrasoMs = retraso; },
    limpiar() { recibidos.length = 0; },
    get conexionesAbiertas() { return conexiones.size; },
  };
}
