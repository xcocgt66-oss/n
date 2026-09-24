FROM mcr.microsoft.com/playwright:v1.55.0-noble
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js ai.js chat.js ./
COPY downloads ./downloads
COPY public ./public
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
