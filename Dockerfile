FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
ENV HOST=0.0.0.0 PORT=3000 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000
CMD ["npm", "start"]
