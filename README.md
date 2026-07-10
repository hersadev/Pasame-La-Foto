# 📸 Pásame la foto

Galería colaborativa de fotos y videos para cualquier evento. Los invitados escanean un código QR, suben sus recuerdos desde el móvil y ven al momento lo que comparten los demás. Sin apps, sin registros, sin base de datos.

## ✨ Características

- 📱 **Pensada para el móvil**: el invitado escanea el QR, pulsa "Añadir fotos" y listo.
- 🖼️ **Galería en vivo** con miniaturas ligeras y visor a pantalla completa (fotos y videos).
- 🗜️ **Compresión automática** de las fotos al subirlas (redimensionado + JPEG optimizado con sharp) y miniaturas de 480 px para que la galería cargue rápido.
- 🔒 **Modo administrador** integrado en la misma página: descarga individual o en ZIP, borrado múltiple y acceso al código QR.
- 📷 **QR autogenerado** por el servidor (`/qr`), listo para imprimir y poner en las mesas.
- 🐳 **Despliegue en un comando** con Docker.
- 🗃️ **Sin base de datos**: los archivos viven en la carpeta `uploads/`, fáciles de copiar o respaldar.

## 🚀 Puesta en marcha

### Con Docker (recomendado)

```bash
cp .env.example .env    # edita las credenciales del admin
docker compose up -d --build
```

### Sin Docker

Requiere Node.js 18 o superior.

```bash
cp .env.example .env    # edita las credenciales del admin
npm install
npm start               # o npm run dev para reinicio automático
```

La web queda en `http://localhost:3000`.

## ⚙️ Configuración (`.env`)

| Variable | Por defecto | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor. |
| `ADMIN_EMAIL` | *(obligatoria)* | Email del administrador. |
| `ADMIN_PASSWORD_HASH_B64` | *(obligatoria)* | Hash bcrypt de la contraseña del administrador, en base64 (evita que el `$` del hash choque con la sustitución de variables de docker-compose). Genéralo con `node -e "console.log(Buffer.from(require('bcryptjs').hashSync('tu-contraseña', 12)).toString('base64'))"`. |
| `SESSION_SECRET` | *(obligatoria)* | Cadena aleatoria larga para firmar las sesiones. |
| `PUBLIC_URL` | URL del propio servidor | URL pública a la que apunta el código QR. Si empieza por `https://`, la cookie de sesión se marca como `secure`. |

El servidor no arranca si falta alguna de las variables obligatorias.
| `MAX_FILE_MB` | `100` | Tamaño máximo por archivo (MB). |
| `MAX_TOTAL_GB` | `20` | Espacio total del evento; al alcanzarlo se rechazan subidas. |
| `IMAGE_MAX_SIDE` | `2560` | Lado mayor (px) de las fotos tras comprimirlas. |
| `IMAGE_QUALITY` | `82` | Calidad JPEG de la compresión. |

## 🧭 Uso

- **Invitados**: entran por el QR, suben fotos y videos y ven la galería. No tienen botón de descarga.
- **Admin**: el icono del candado (arriba a la derecha) abre el login. Con la sesión iniciada aparecen los botones de descargar y borrar sobre cada archivo y en el visor, la selección múltiple (descarga en ZIP y borrado en lote) y el acceso al código QR para descargarlo e imprimirlo.

## 🛠️ Cómo funciona por dentro

- Las **fotos se comprimen al recibirse**: se redimensionan a `IMAGE_MAX_SIDE` px y se recomprimen a JPEG. Si la versión comprimida no es más pequeña que la original, se conserva la original. Cada foto genera una miniatura en `uploads/.thumbs/` que es la que carga la galería; el archivo completo solo se sirve al abrir el visor.
- Los **videos no se transcodifican** (requeriría ffmpeg y mucha CPU); los móviles ya los comprimen bastante. Se limitan por tamaño con `MAX_FILE_MB`.
- El "no poder descargar" de los invitados es **disuasorio** (sin botón de descarga, clic derecho bloqueado, `Content-Disposition: inline`). Quien puede ver un archivo en el navegador siempre puede acabar guardándolo.

## 🧰 Stack

Node.js + Express, con multer (subidas), sharp (compresión y miniaturas), cookie-session (sesión del admin firmada en la cookie, sin estado en el servidor), qrcode (código QR) y archiver (ZIP). Frontend en HTML, CSS y JavaScript sin frameworks.

## 🔒 Seguridad

- El nombre de archivo guardado en disco se deriva de una whitelist cerrada de mimetypes permitidos (nunca del nombre original que manda el cliente), lo que evita inyección de contenido en el nombre y bloquea formatos peligrosos como SVG.
- La contraseña del admin se guarda hasheada con bcrypt (`ADMIN_PASSWORD_HASH`); nunca en texto plano.
- El login está limitado a 10 intentos por IP cada 15 minutos.
- Cabeceras de seguridad con helmet (CSP, `X-Content-Type-Options`, etc.).
- La cookie de sesión se marca `secure` automáticamente cuando `PUBLIC_URL` usa HTTPS.
- El servidor rechaza arrancar si falta `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH` o `SESSION_SECRET`.

## 🗺️ Pendiente

- Transcodificación de video con ffmpeg y miniaturas de video.
- Paginación de la galería para eventos grandes.
- Nombre del invitado al subir.
