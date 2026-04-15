FROM node:20-alpine

WORKDIR /app

# Install deps first for better layer caching
COPY package.json ./
RUN npm install --omit=dev

# Copy the app
COPY server.js ./
COPY public ./public

# Railway mounts a volume here for persistence (members.json)
ENV DATA_DIR=/data
RUN mkdir -p /data

EXPOSE 8080

CMD ["node", "server.js"]
