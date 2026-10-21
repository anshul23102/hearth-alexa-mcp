# Two stages: compile TypeScript, then ship only compiled JS + production dependencies, running as a non-root user.
# NOTE: this Dockerfile has not been built in the environment it was written in (no Docker available there);
# the same compiled output (npm run build && npm run start:prod) is what CI and local runs exercise.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production PORT=3939 HEARTH_DB=/data/hearth.db
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY web ./web
COPY data ./data
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 3939
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/http.js"]
