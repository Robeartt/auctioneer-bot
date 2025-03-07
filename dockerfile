FROM node:20-alpine

RUN apk add --no-cache sqlite bash

WORKDIR /app

COPY package*.json ./
COPY ./init_db.sql ./
COPY ./migrate_db_v1_to_v2.sql ./
COPY ./lib/ ./lib/
COPY ./start.sh ./
COPY ./migrations.sh ./

RUN npm install

RUN chmod +x start.sh
run chmod +x migrations.sh

ENTRYPOINT ["./start.sh"]