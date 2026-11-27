FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build && mkdir -p /app/uploads && chown -R 1000:1000 /app

USER 1000

ENV NODE_ENV=production
ENV PORT=7860

EXPOSE 7860

CMD ["npm", "start"]
