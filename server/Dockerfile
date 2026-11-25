FROM node:22-alpine
WORKDIR /app
COPY shared/ ./shared/
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev
COPY server/src ./server/src
COPY server/public ./server/public
COPY server/edition.json ./server/
# Til "nulstil adgangskode" i enkel tilstand: docker compose exec holymoly node /app/scripts/enkel.js nulstil <brugernavn>
COPY scripts/enkel.js ./scripts/
ENV NODE_ENV=production DATA_DIR=/data PORT=8080 TRUST_PROXY=1
# /data skal findes og ejes af "node" (uid 1000) i billedet – ellers opretter Docker en ny volumen ejet af root,
# og serveren (der ikke kører som root) kan ikke gemme sin database
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8080
USER node
WORKDIR /app/server
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
