# Xabor Agent — Guía de instalación y prueba

## 1. Copiar el proyecto a tu máquina

Mueve la carpeta `xabor-agent` a donde quieras trabajar, por ejemplo:
```
C:\Users\mario\proyectos\xabor-agent
```

## 2. Instalar dependencias

Abre una terminal en la carpeta del proyecto y ejecuta:
```bash
npm install
```

Esto instalará: Express, Anthropic SDK, Twilio, WebSocket (`ws`) y dotenv.

## 3. Crear el archivo .env

Copia el archivo de ejemplo:
```bash
cp .env.example .env
```

Abre `.env` y rellena tu API key de Anthropic:
```
ANTHROPIC_API_KEY=sk-ant-api03-TU-KEY-AQUÍ
```

(Las demás keys las agregaremos en módulos posteriores)

## 4. Probar el agente en terminal (Módulo 1)

```bash
npm run chat
```

Verás algo así:
```
🌮🌮🌮🌮🌮🌮🌮🌮🌮🌮🌮🌮🌮🌮🌮🌮🌮🌮🌮🌮
  AGENTE XABOR — Modo prueba en terminal
  Escribe "salir" para terminar
🌮🌮🌮🌮🌮🌮🌮🌮🌮🌮🌮🌮🌮🌮🌮🌮🌮🌮🌮🌮

🤖 Xabor: ¡Hola! Bienvenido a Xabor...

👤 Tú: _
```

Prueba un pedido completo:
- Pide algo del menú
- Di que ya es todo
- Elige modalidad (recoger/domicilio)
- Da tu nombre y teléfono
- Confirma el pedido

Cuando lo confirmes verás el JSON del pedido en la terminal.

## 5. Probar el servidor y panel (Módulo 3)

Arranca el servidor:
```bash
npm start
```

Luego abre en el navegador:
- Panel de comandas: http://localhost:3000
- Estado del servidor: http://localhost:3000/health

Para probar enviando un pedido desde otra terminal:
```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"prueba-1","mensaje":"Hola"}'
```

## 6. Actualizar el menú

Edita el archivo `src/data/menu.json` con tus productos reales.
El agente usa ese archivo directamente — sin reinicios ni compilaciones.

## 7. Próximos módulos

- **Módulo 2**: Conectar WhatsApp Sandbox de Twilio
- **Módulo 4**: Activar llamadas de voz con Deepgram + ElevenLabs
  - Necesitarás `DEEPGRAM_API_KEY` y `ELEVENLABS_API_KEY`
  - Y exponer el servidor públicamente con `ngrok` para que Twilio lo alcance

---

## Estructura del proyecto

```
xabor-agent/
├── src/
│   ├── agent/
│   │   ├── brain.js          ← Lógica Claude API
│   │   ├── chat-test.js      ← Prueba en terminal
│   │   ├── prompts.js        ← System prompts
│   │   └── session.js        ← Estado conversaciones
│   ├── channels/
│   │   ├── voice.js          ← Webhook llamadas Twilio
│   │   └── whatsapp.js       ← Webhook WhatsApp Twilio
│   ├── data/
│   │   ├── menu.json         ← ✏️ EDITA ESTE con tu menú real
│   │   └── rules.json        ← ✏️ EDITA ESTE con tus reglas
│   ├── orders/
│   │   └── orderManager.js   ← Gestión de pedidos + WS
│   ├── services/
│   │   ├── deepgram.js       ← STT (voz → texto)
│   │   └── elevenlabs.js     ← TTS (texto → voz)
│   └── server.js             ← Servidor principal
├── panel/
│   └── index.html            ← Panel de comandas
├── .env                      ← Tus keys (NO subir a git)
└── .env.example              ← Plantilla de keys
```
