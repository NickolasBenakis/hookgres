# Builds the library from this checkout and runs the playground.
FROM node:24-alpine
WORKDIR /app
RUN npm install --global pnpm@10.33.3
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node", "examples/playground/server.ts"]
