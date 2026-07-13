// Servicio de Speech-to-Text con Deepgram
// Recibe una URL de grabación de Twilio y devuelve el texto transcrito

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen';

export async function transcribirAudio(audioUrl) {
  if (!DEEPGRAM_API_KEY) {
    throw new Error('DEEPGRAM_API_KEY no configurada');
  }

  console.log(`[Deepgram] Transcribiendo: ${audioUrl}`);

  // Construir URL con parámetros
  const params = new URLSearchParams({
    model: 'nova-2',          // Modelo más preciso de Deepgram
    language: 'es-419',       // Español latinoamericano (incluye México)
    smart_format: 'true',     // Formatea números, fechas, etc.
    punctuate: 'true',        // Añade puntuación
    utterances: 'false'
  });

  const responseConParams = await fetch(`${DEEPGRAM_URL}?${params}`, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${DEEPGRAM_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ url: audioUrl })
  });

  if (!responseConParams.ok) {
    const error = await responseConParams.text();
    throw new Error(`Deepgram error ${responseConParams.status}: ${error}`);
  }

  const data = await responseConParams.json();

  // Extraer el texto de la transcripción
  const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript;

  if (!transcript) {
    console.warn('[Deepgram] Transcripción vacía');
    return '';
  }

  console.log(`[Deepgram] Resultado: "${transcript}"`);
  return transcript;
}
