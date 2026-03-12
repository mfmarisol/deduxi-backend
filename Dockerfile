FROM node:20-slim

ENV DEBIAN_FRONTEND=noninteractive

# Install chromium — let apt resolve all its own dependencies automatically
RUN apt-get update \
    && apt-get install -y chromium fonts-liberation --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV NODE_ENV=production

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 3001
CMD ["node", "server.js"]
