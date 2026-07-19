// Servicio de Text-to-Speech con ElevenLabs
// Convierte texto a audio y lo guarda temporalmente para que Twilio lo reproduzca

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = join(__dirname, '../../public/audio');
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB'; // Voz en español por defecto

// Asegura que exista el directorio de audio
mkdirSync(AUDIO_DIR, { recursive: true });

function limpiarParaVoz(texto) {
  return texto
    .replace(/<[^>]+>/g, '')           // quitar marcadores tipo <ENVIAR_MENU>
    .replace(/\*\*/g, '')              // quitar negritas markdown
    .replace(/\*/g, '')                // quitar itálicas
    .replace(/#{1,6}\s/g, '')          // quitar headers
    .replace(/\$(\d)/g, '$1 pesos')    // "$180" → "180 pesos"
    .replace(/MXN/g, 'pesos')
    .replace(/—/g, ',')
    .replace(/\n{2,}/g, '. ')          // párrafos → pausa
    .replace(/\n/g, ', ')
    .trim();
}

export async function sintetizarVoz(texto, callSid, sufijo = '') {
  texto = limpiarParaVoz(texto);
  if (!ELEVENLABS_API_KEY) {
    throw new Error('ELEVENLABS_API_KEY no configurada');
  }

  console.log(`[ElevenLabs] Sintetizando: "${texto.substring(0, 60)}..."`);

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text: texto,
        model_id: 'eleven_multilingual_v2', // Soporta español mexicano
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.4,
          use_speaker_boost: true
        }
      })
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ElevenLabs error ${response.status}: ${error}`);
  }

  // Guardar el archivo de audio
  const nombreArchivo = `${callSid}-${sufijo}.mp3`;
  const rutaArchivo = join(AUDIO_DIR, nombreArchivo);
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(rutaArchivo, buffer);

  // URL pública donde Twilio puede acceder al audio
  const baseUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
  const audioUrl = `${baseUrl}/audio/${nombreArchivo}`;

  console.log(`[ElevenLabs] Audio guardado: ${audioUrl}`);
  return audioUrl;
}
