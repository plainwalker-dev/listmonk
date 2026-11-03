FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
USER node
ENV MCP_TRANSPORT=http MCP_HOST=0.0.0.0 MCP_PORT=3100
EXPOSE 3100
CMD ["node", "src/index.mjs"]
