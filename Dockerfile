FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js ai.js chat.js chat-http.js desktop.js ./
COPY downloads ./downloads
COPY public ./public
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
