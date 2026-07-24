FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json /app/
RUN npm ci --omit=dev

COPY server.js /app/server.js
COPY grafanaClient.js /app/grafanaClient.js
COPY helpers.js /app/helpers.js

CMD ["node", "server.js"]
