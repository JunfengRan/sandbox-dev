FROM node:20-alpine AS builder
WORKDIR /app
COPY packages/sandbox-runtime/package.json ./
COPY packages/sandbox-runtime/tsconfig.json ./
COPY packages/sandbox-runtime/src ./src
RUN npm install && npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
EXPOSE 8090
CMD ["node", "dist/index.js"]
