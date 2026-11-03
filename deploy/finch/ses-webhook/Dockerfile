FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node server.mjs ./server.mjs
USER node
CMD ["node", "server.mjs"]
