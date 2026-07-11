# 📸 Pásame la foto

Galería colaborativa de fotos y videos para eventos, multiportal. Cada organizador (una boda, un cumpleaños…) crea su propio portal con un código de invitación: tiene su galería, su panel de administración y su código QR. Los invitados escanean el QR, suben sus recuerdos desde el móvil y ven al momento lo que comparten los demás. Sin apps y sin base de datos.

## ✨ Características

- 🏠 **Un portal por evento**: cada cuenta tiene su propia galería aislada en una URL aleatoria no adivinable (`/e/x7k2m9q4ab`).
- 🎟️ **Registro con código de invitación**: solo crea portal quien tenga un código generado por el dueño del servidor (`npm run invitacion`).
- 📱 **Pensada para el móvil**: el invitado escanea el QR, pulsa "Añadir fotos" y listo. Sin registro para invitados.
- 🖼️ **Galería en vivo** con miniaturas ligeras y visor a pantalla completa (fotos y videos).
- 🗜️ **Compresión automática** de las fotos al subirlas (redimensionado + JPEG optimizado con sharp) y miniaturas de 480 px para que la galería cargue rápido.
- 🔒 **Panel de administración** en la propia galería: descarga individual o en ZIP, borrado múltiple, marca de agua, nombre del evento y expiración automática.
- 📷 **QR por evento** autogenerado (`/e/<id>/qr`), listo para imprimir y poner en las mesas.
- 🐳 **Despliegue en un comando** con Docker.
- 🗃️ **Sin base de datos**: cuentas y archivos viven en la carpeta `uploads/`, fáciles de copiar o respaldar.

## 🚀 Puesta en marcha

### Con Docker (recomendado)

```bash
cp .env.example .env    # pon un SESSION_SECRET aleatorio
docker compose up -d --build
docker compose exec pasame-la-foto npm run invitacion   # genera un código de invitación
```

### Sin Docker

Requiere Node.js 18 o superior.

```bash
cp .env.example .env    # pon un SESSION_SECRET aleatorio
npm install
npm start               # o npm run dev para reinicio automático
npm run invitacion      # genera un código de invitación
```

La web queda en `http://localhost:3000`. Con el código de invitación, cada organizador crea su portal desde la portada (usuario + contraseña) y desde su panel descarga el QR que da acceso a su galería.

## ⚙️ Configuración (`.env`)

| Variable | Por defecto | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor. |
| `SESSION_SECRET` | *(obligatoria)* | Cadena aleatoria larga para firmar las sesiones. El servidor no arranca sin ella. |
| `PUBLIC_URL` | URL del propio servidor | URL pública base de los códigos QR. Si empieza por `https://`, la cookie de sesión se marca como `secure`. |
| `MAX_FILE_MB` | `100` | Tamaño máximo por archivo (MB). |
| `MAX_TOTAL_GB` | `20` | Espacio máximo por evento; al alcanzarlo se rechazan subidas. |
| `IMAGE_MAX_SIDE` | `2560` | Lado mayor (px) de las fotos tras comprimirlas. |
| `IMAGE_QUALITY` | `82` | Calidad JPEG de la compresión. |

## 🧭 Uso

- **Dueño del servidor**: genera códigos de invitación con `npm run invitacion` (cada código vale para un solo registro) y se los pasa a los organizadores.
- **Organizador (admin de su evento)**: entra en la portada, crea su portal con el código de invitación y accede con su usuario y contraseña. En su galería tiene el menú de administración: código QR, descarga en ZIP, borrado múltiple y ajustes (nombre del evento, fecha y marca de agua). El candado de su galería lleva de vuelta al login.
- **Invitados**: entran por el QR, suben fotos y videos y ven la galería de ese evento. No necesitan cuenta y no tienen botón de descarga (salvo en archivos marcados como descargables para todos).

## 🛠️ Cómo funciona por dentro

- **Cada evento es una carpeta**: `uploads/<eventId>/` guarda los archivos subidos, sus miniaturas (`.thumbs/`), las cachés de marca de agua (`.wm-thumbs/`, `.wm-display/`) y sus metadatos (`.data/settings.json`, `.data/media-meta.json`). Las cuentas viven en `uploads/.data/users.json` y los códigos de invitación pendientes en `uploads/.data/invites.json`.
- Las **fotos se comprimen al recibirse**: se redimensionan a `IMAGE_MAX_SIDE` px y se recomprimen a JPEG. Si la versión comprimida no es más pequeña que la original, se conserva la original. La galería carga las miniaturas; el archivo completo solo se sirve al abrir el visor.
- Los **videos no se transcodifican** (requeriría ffmpeg y mucha CPU); los móviles ya los comprimen bastante. Se limitan por tamaño con `MAX_FILE_MB`.
- La **expiración es por evento**: 30 días después de la fecha que fije cada admin, su contenido se borra automáticamente. La cuenta, el nombre y la marca de agua se conservan para poder reutilizar el portal.
- El "no poder descargar" de los invitados es **disuasorio** (sin botón de descarga, clic derecho bloqueado, `Content-Disposition: inline`). Quien puede ver un archivo en el navegador siempre puede acabar guardándolo.

## 🧰 Stack

Node.js + Express, con multer (subidas), sharp (compresión y miniaturas), bcryptjs (contraseñas), cookie-session (sesión firmada en la cookie, sin estado en el servidor), qrcode (códigos QR) y archiver (ZIP). Frontend en HTML, CSS y JavaScript sin frameworks.

## 🔒 Seguridad

- Cada galería vive en una URL aleatoria de 10 caracteres: sin el QR o el enlace no se puede encontrar, y el id se valida con una whitelist estricta antes de tocar el disco.
- Un usuario solo puede administrar su propio evento: las rutas de admin comprueban que la sesión corresponde al evento de la URL.
- El registro exige un código de invitación de un solo uso; sin código no se pueden crear cuentas.
- Las contraseñas se guardan hasheadas con bcrypt (12 rondas); nunca en texto plano. El login compara siempre contra un hash (aunque el usuario no exista) para no filtrar nombres por temporización.
- El nombre de archivo guardado en disco se deriva de una whitelist cerrada de mimetypes permitidos (nunca del nombre original que manda el cliente), lo que evita inyección de contenido en el nombre y bloquea formatos peligrosos como SVG.
- Login limitado a 10 intentos por IP cada 15 minutos; registro a 5 por hora.
- Cabeceras de seguridad con helmet (CSP, `X-Content-Type-Options`, etc.).
- La cookie de sesión se marca `secure` automáticamente cuando `PUBLIC_URL` usa HTTPS.
- El servidor rechaza arrancar si falta `SESSION_SECRET`.

## 🗺️ Pendiente

- Cambio y recuperación de contraseña.
- Transcodificación de video con ffmpeg y miniaturas de video.
- Paginación de la galería para eventos grandes.
- Nombre del invitado al subir.
