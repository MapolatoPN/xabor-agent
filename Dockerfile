# Dockerfile para Railway -- necesario porque Railpack (builder por
# defecto de Railway sin Dockerfile propio) no instala las librerias de
# sistema que el Chromium empaquetado por `puppeteer` requiere para
# arrancar (libnss3, libatk-bridge, libgtk-3, etc.). Sin este Dockerfile,
# el primer puppeteer.launch() en produccion falla con
# "error while loading shared libraries: libnss3.so".
#
# Ver docs/decision-puppeteer-vs-pdfkit.md para la recomendacion de
# migrar a PDFKit a mediano plazo -- este Dockerfile es la solucion
# correcta MIENTRAS Puppeteer siga en uso para cotizaciones.
FROM node:20-slim

# Dependencias de sistema para que el Chromium de Puppeteer arranque.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
# Puppeteer descarga su propio Chromium en el postinstall -- no se usa
# --ignore-scripts, se necesita exactamente esa descarga.
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
