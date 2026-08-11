FROM node:22-slim AS build
WORKDIR /app

COPY bot/package*.json bot/
COPY webapp/package*.json webapp/
RUN npm ci --prefix bot && npm ci --prefix webapp

COPY bot bot
COPY webapp webapp
RUN npm run build --prefix webapp && npm run build --prefix bot

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY bot/package*.json bot/
RUN npm ci --omit=dev --prefix bot && npm cache clean --force

COPY --from=build /app/bot/dist bot/dist
COPY --from=build /app/webapp/dist webapp/dist

# Long-polling keeps no inbound state, so a plain restart is always safe.
EXPOSE 3000
CMD ["node", "bot/dist/index.js"]
