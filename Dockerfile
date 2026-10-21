FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm i tsx
COPY . .
ENV PORT=3939 HEARTH_DB=/data/hearth.db
VOLUME /data
EXPOSE 3939
CMD ["npx", "tsx", "src/http.ts"]
