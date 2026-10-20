# Greenova website (Vite + React). Built by docker-compose.yaml with ../frontend as the build context.
# Node 22 on Debian: Vite 8 needs Node 20.19+ / 22.12+.
FROM node:22-slim

WORKDIR /app

# Packages first, so a code change doesn't reinstall them.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV PORT=8443
EXPOSE 8443

# npm run dev = vite --host 0.0.0.0 (port from PORT; /api goes to GREENOVA_API).
CMD ["npm", "run", "dev"]
