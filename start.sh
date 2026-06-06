#!/bin/bash

# Start Redis server in the background
echo "Starting Redis Server..."
redis-server --daemonize yes

# Wait for Redis to start
sleep 2

# Start Astro application in standalone Node mode
echo "Starting Astro Server..."
node dist/server/entry.mjs
