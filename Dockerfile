FROM node:20-alpine

# fontconfig + una fuente base: sin esto sharp no puede dibujar el texto de
# la marca de agua sobre las imágenes (el composite no falla, pero el texto
# sale invisible por no encontrar ninguna fuente que rasterizar). ttf-dejavu
# queda como respaldo si la fuente elegante de abajo no se pudiera cargar.
RUN apk add --no-cache fontconfig ttf-dejavu

# Fuente elegante para la marca de agua (Playfair Display Italic).
# Se instala como fuente del sistema porque el renderizador SVG de sharp no
# soporta @font-face con la fuente incrustada en base64: solo encuentra
# fuentes ya registradas en fontconfig.
COPY assets/fonts/ /usr/share/fonts/truetype/wedding/
RUN fc-cache -f

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js mailer.js ./
COPY public ./public

# uploads/ se monta como volumen y el proceso escribe ahí: debe pertenecer al
# usuario sin privilegios con el que corremos. No arrancamos como root para que
# un fallo en el manejo de archivos no dé control del contenedor entero.
RUN mkdir -p /app/uploads && chown -R node:node /app
USER node

EXPOSE 3000

CMD ["node", "server.js"]
