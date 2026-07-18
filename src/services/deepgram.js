// Servicio de Speech-to-Text con Deepgram
// Recibe una URL de grabación de Twilio y devuelve el texto transcrito

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen';

export async function transcribirAudio(audioUrl) {
  if (!DEEPGRAM_API_KEY) {
    throw new Error('DEEPGRAM_API_KEY no configurada');
  }

  console.log(`[Deepgram] Descargando grabación de Twilio: ${audioUrl}`);

  // Twilio requiere autenticación para descargar grabaciones.
  // Descargamos el audio nosotros primero y lo enviamos a Deepgram como binario.
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;

  const twilioResp = await fetch(`${audioUrl}.mp3`, {
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64')
    }
  });

  if (!twilioResp.ok) {
    throw new Error(`Error descargando grabación de Twilio: ${twilioResp.status}`);
  }

  const audioBuffer = await twilioResp.arrayBuffer();
  console.log(`[Deepgram] Audio descargado (${audioBuffer.byteLength} bytes), enviando a Deepgram...`);

  // Enviar el audio binario a Deepgram
  const params = new URLSearchParams({
    model: 'nova-2',
    language: 'es-419',
    smart_format: 'true',
    punctuate: 'true'
  });

  const resp = await fetch(`${DEEPGRAM_URL}?${params}`, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${DEEPGRAM_API_KEY}`,
      'Content-Type': 'audio/mpeg'
    },
    body: audioBuffer
  });

  if (!resp.ok) {
    const error = await resp.text();
    throw new Error(`Deepgram error ${resp.status}: ${error}`);
  }

  const data = await resp.json();
  const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript;

  if (!transcript) {
    console.warn('[Deepgram] Transcripción vacía');
    return '';
  }

  console.log(`[Deepgram] Resultado: "${transcript}"`);
  return transcript;
}
