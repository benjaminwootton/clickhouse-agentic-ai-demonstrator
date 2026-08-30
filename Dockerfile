FROM node:22-slim
WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev
COPY server/ ./server/
COPY website/ ./website/
EXPOSE 3000
CMD ["node", "server/server.js"]
