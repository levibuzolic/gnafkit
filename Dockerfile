FROM oven/bun:1.3.10 AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tsconfig.json ./

FROM busybox:1.36.1-uclibc AS busybox

FROM oven/bun:1.3.10-distroless

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/src ./src
COPY --from=busybox /bin/busybox /busybox

EXPOSE 3000

CMD ["bun", "src/cli.mts", "serve"]
