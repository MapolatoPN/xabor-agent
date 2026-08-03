// Servidor HTTPS mínimo que simula un endpoint real de push (FCM/Mozilla)
// para las pruebas de notificaciones (Bloque 4) -- nunca se envía a un
// servicio de push real durante las pruebas. La librería web-push SIEMPRE
// usa https.request internamente (sin importar el esquema del endpoint),
// así que el mock tiene que hablar TLS de verdad -- se genera un
// certificado autofirmado en memoria con node-forge (ya es dependencia del
// proyecto) para no depender de openssl externo ni de archivos en disco.
// El proceso que llama a este mock necesita NODE_TLS_REJECT_UNAUTHORIZED=0
// para aceptar el certificado autofirmado (ver arrancarPushMock).
import { createServer } from 'https';
import forge from 'node-forge';

function generarCertificadoAutofirmado() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const attrs = [{ name: 'commonName', value: 'localhost' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey);
  return {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

export function arrancarPushMock() {
  let statusForzado = null; // si se fija, la próxima entrega responde con ese código
  const { cert, key } = generarCertificadoAutofirmado();

  const server = createServer({ cert, key }, (req, res) => {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const status = statusForzado;
      statusForzado = null; // se autolimpia tras una sola entrega
      res.writeHead(status || 201, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, () => resolve({
      baseUrl: `https://localhost:${server.address().port}`,
      forzarStatusSiguienteEntrega: (status) => { statusForzado = status; },
      detener: () => server.close(),
    }));
  });
}

// Genera una suscripción "real" (claves EC válidas) apuntando al mock --
// web-push cifra el payload con estas claves antes de enviarlo, así que
// tienen que ser criptográficamente válidas aunque el mock nunca las
// descifre.
import { createECDH, randomBytes } from 'crypto';
export function generarSuscripcionFalsa(baseUrl, idUnico = randomBytes(6).toString('hex')) {
  const curva = createECDH('prime256v1');
  curva.generateKeys();
  return {
    endpoint: `${baseUrl}/push/${idUnico}`,
    keys: {
      p256dh: curva.getPublicKey('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}
