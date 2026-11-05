FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

FROM node:22-alpine
RUN apk add --no-cache tini
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev
COPY --from=builder /app/dist ./dist
USER node
EXPOSE 3100
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
