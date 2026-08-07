FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
COPY package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/sandbox-runtime/package.json ./packages/sandbox-runtime/
RUN --mount=type=cache,target=/root/.npm npm ci --workspace=@sandbox-dev/shared --workspace=@sandbox-dev/sandbox-runtime
COPY packages/shared ./packages/shared
COPY packages/sandbox-runtime ./packages/sandbox-runtime
RUN npm run build -w @sandbox-dev/shared && npm run build -w @sandbox-dev/sandbox-runtime

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
WORKDIR /app/packages/sandbox-runtime
EXPOSE 8090
CMD ["node", "dist/index.js"]
