FROM node:24-alpine AS build
RUN npm i -g pnpm@12.18.0
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY web/package.json web/
COPY server/package.json server/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY web web
COPY server server
RUN pnpm --filter web build \
 && pnpm --filter server deploy --prod --legacy /out

FROM alpine:3.22
# Only the node binary: no npm, yarn or corepack in the runtime image.
RUN apk add --no-cache libstdc++ && mkdir /data && chown 1000:1000 /data
COPY --from=build /usr/local/bin/node /usr/local/bin/node
WORKDIR /app/server
COPY --from=build /out/node_modules node_modules
COPY --from=build /out/package.json ./
COPY server/src src
COPY --from=build /app/web/dist ../web/dist
ENV DATA_DIR=/data HOST=0.0.0.0 PORT=5858 NODE_ENV=production
VOLUME /data
EXPOSE 5858
USER 1000
CMD ["node", "src/index.ts"]
