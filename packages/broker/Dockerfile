FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/broker/package.json ./packages/broker/
COPY packages/shared ./packages/shared
COPY packages/broker ./packages/broker
RUN npm install --workspace=@sandbox-dev/shared --workspace=@sandbox-dev/broker
RUN npm run build -w @sandbox-dev/shared && npm run build -w @sandbox-dev/broker

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
WORKDIR /app/packages/broker
EXPOSE 8080
CMD ["node", "dist/index.js"]
