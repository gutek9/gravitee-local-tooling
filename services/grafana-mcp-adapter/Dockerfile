FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json /app/
RUN npm ci --omit=dev

COPY server.js /app/server.js
COPY grafanaClient.js /app/grafanaClient.js
COPY helpers.js /app/helpers.js
COPY lokiDiscovery.js /app/lokiDiscovery.js
COPY logsLinks.js /app/logsLinks.js
COPY customerCsv.js /app/customerCsv.js
COPY customerMapLoader.js /app/customerMapLoader.js
COPY customerMatch.js /app/customerMatch.js
# Optional: the customer map snapshot is a LOCAL fallback cache and is
# deliberately not committed (this repo is public; the customer list is not).
# The bracket form makes the COPY a no-op when the file is absent, so a fresh
# clone still builds - the adapter then fetches from GitHub and degrades with a
# clear message if that is unreachable.
COPY customers-snapshot.jso[n] /app/

CMD ["node", "server.js"]
