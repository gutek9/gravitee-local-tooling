FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json /app/
RUN npm ci --omit=dev

COPY server.js /app/server.js
COPY grafanaClient.js /app/grafanaClient.js
COPY helpers.js /app/helpers.js
COPY lokiDiscovery.js /app/lokiDiscovery.js
COPY logsLinks.js /app/logsLinks.js

CMD ["node", "server.js"]
