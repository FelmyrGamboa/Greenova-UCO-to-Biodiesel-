# Greenova website: the Vite dev server on port 8443 (npm run dev). It forwards /api to the backend
# at GREENOVA_API (http://backend:8000 in docker-compose.yaml). Built with context ../frontend.
# Node 22: Vite 8 needs Node 20.19+ or 22.12+.
FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
# npm ci installs exactly the lock file; npm install is the fallback if the lock file was made on
# another kind of computer and misses a package for the Pi.
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY . .
ENV PORT=8443
EXPOSE 8443
CMD ["sh", "-c", "npm run dev -- --port ${PORT}"]
