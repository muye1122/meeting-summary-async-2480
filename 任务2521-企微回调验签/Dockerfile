# Callback POC + mock API + built demo UI in one image (acceptance / demo use).
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

ENV PORT=3001
ENV H5_PORT=4173
ENV NODE_ENV=production
EXPOSE 3001 4173

CMD ["node", "server.js"]
