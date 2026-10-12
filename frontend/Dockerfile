FROM node:20-alpine



#WORKDIR /app
#
#COPY . .
#
#RUN npm config set strict-ssl false
#RUN npm install && npm install react-router-dom
#
#
##CMD ["tail", "-f", "/dev/null"]
#CMD ["npm", "run", "dev"]




WORKDIR /app

# Installer outils de build
RUN apk add --no-cache bash git python3 make g++

# Copier les fichiers de config
COPY package*.json ./

# Réinstaller les dépendances proprement
RUN npm config set strict-ssl false \
    && npm install --force

# Copier le reste du code
COPY . .

# Rebuild des liens binaires (important pour vite)
RUN npm rebuild && npm rebuild vite

# Vérifier vite
RUN ls -l node_modules/.bin && node node_modules/vite/bin/vite.js --version

#CMD ["tail", "-f", "/dev/null"]
CMD ["npm", "run", "dev"]