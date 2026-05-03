# syntax=docker/dockerfile:1
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js index.html ./
COPY db ./db
COPY scripts ./scripts

ENV NODE_ENV=production
ENV PORT=3333

EXPOSE 3333

USER node

CMD ["node", "server.js"]
