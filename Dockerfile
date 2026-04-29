FROM node:20-alpine
WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm install --production
COPY server/ ./server/
COPY website/ ./website/
EXPOSE 3000
CMD ["node", "server/server.js"]
