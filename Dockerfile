# Two stages: compile TypeScript, then ship only compiled JS + production dependencies, running as a non-root user.
# It was written where Docker was not available; the `docker` job in .github/workflows/ci.yml builds it and smoke-tests the
# container on every push. The same compiled output (npm run build && npm run start:prod) is what local runs exercise.
FROM node:25-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:25-slim
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
