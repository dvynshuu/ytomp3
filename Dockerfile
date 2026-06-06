FROM node:22-slim

# Install system dependencies (Redis and FFmpeg)
RUN apt-get update && apt-get install -y \
    redis-server \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package configuration
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy the rest of the application
COPY . .

# Build Astro standalone server
RUN npm run build

# Fix potential Windows CRLF line ending issues in start.sh and make it executable
RUN sed -i 's/\r$//' start.sh && chmod +x start.sh

# Expose Astro default port (Hugging Face expects port 7860 by default)
EXPOSE 7860
ENV PORT=7860
ENV HOST=0.0.0.0
ENV REDIS_URL=redis://127.0.0.1:6379

# Use start.sh to run Redis and Node server together
CMD ["./start.sh"]
