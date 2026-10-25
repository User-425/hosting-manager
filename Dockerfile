FROM node:20-slim

# Install system utilities & PM2 globally for hybrid runner support
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pm2

WORKDIR /app

# Copy package manifests and install dependencies
COPY package*.json ./
RUN npm install

# Copy application source code
COPY . .

# Provide fallback config if custom files are not present in build context
RUN test -f services.json || cp services.json.example services.json
RUN test -f .env || cp .env.example .env

# Expose default gateway port
ENV PORT=443
ENV NODE_ENV=production

EXPOSE 443

# Start hosting manager
CMD ["npm", "start"]
