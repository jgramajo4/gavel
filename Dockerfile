FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY integrations ./integrations
RUN npm ci --omit=dev && chown -R node:node /app
USER node
EXPOSE 8080
ENTRYPOINT ["node","packages/governance-index/bin/gavel-indexer.js"]
CMD ["serve"]
