FROM node:20-slim

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install --only=production

COPY . .

EXPOSE 10000

CMD [ "node", "telegram_advanced_bot.js" ]
