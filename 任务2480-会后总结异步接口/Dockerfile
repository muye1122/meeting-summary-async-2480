FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm install --no-save @vitejs/plugin-react@^4.3.4 vite@^6.0.7
COPY . .
RUN npm run build

EXPOSE 3001 4173
CMD ["node", "server.js"]
