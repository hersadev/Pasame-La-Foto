require('dotenv').config();

const express = require('express');
const cookieSession = require('cookie-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const archiver = require('archiver');
const sharp = require('sharp');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');

const app = express();

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const THUMB_DIR = path.join(UPLOAD_DIR, '.thumbs');
const DATA_DIR = path.join(UPLOAD_DIR, '.data');
const WM_THUMB_DIR = path.join(UPLOAD_DIR, '.wm-thumbs');
const WM_DISPLAY_DIR = path.join(UPLOAD_DIR, '.wm-display');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const MEDIA_META_PATH = path.join(DATA_DIR, 'media-meta.json');
const EXPIRATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 días desde la fecha del evento
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const IS_HTTPS = PUBLIC_URL.startsWith('https://');

// Sin valores por defecto: un despliegue con el .env a medio configurar
// no debe arrancar con credenciales o secretos de sesión adivinables.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD_HASH_B64 = process.env.ADMIN_PASSWORD_HASH_B64;
const SESSION_SECRET = process.env.SESSION_SECRET;
for (const [name, value] of Object.entries({ ADMIN_EMAIL, ADMIN_PASSWORD_HASH_B64, SESSION_SECRET })) {
  if (!value) {
    console.error(`Falta ${name} en el .env. Copia .env.example y complétalo antes de arrancar.`);
    process.exit(1);
  }
}
// El hash bcrypt viaja en base64 en el .env: docker-compose interpreta "$"
// como sustitución de variables al leer env_file y corrompe el hash en crudo.
const ADMIN_PASSWORD_HASH = Buffer.from(ADMIN_PASSWORD_HASH_B64, 'base64').toString('utf8');

// Límites y compresión (configurables en .env)
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || '100', 10); // por archivo
const MAX_TOTAL_GB = parseFloat(process.env.MAX_TOTAL_GB || '20'); // total del evento
const IMAGE_MAX_SIDE = parseInt(process.env.IMAGE_MAX_SIDE || '2560', 10); // lado mayor tras comprimir
const IMAGE_QUALITY = parseInt(process.env.IMAGE_QUALITY || '82', 10); // calidad JPEG
const THUMB_SIZE = 480; // miniaturas de la galería

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(THUMB_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(WM_THUMB_DIR, { recursive: true });
fs.mkdirSync(WM_DISPLAY_DIR, { recursive: true });

if (IS_HTTPS) app.set('trust proxy', 1); // necesario para que la cookie "secure" funcione tras un proxy HTTPS

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'default-src': ["'self'"],
        'style-src': ["'self'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:'],
        'media-src': ["'self'"],
        'script-src': ["'self'"],
      },
    },
  })
);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// El login del admin está integrado en la página principal
app.get('/admin.html', (req, res) => res.redirect('/'));
// La sesión viaja firmada en la cookie (sin estado en el servidor):
// sobrevive a reinicios y rebuilds mientras SESSION_SECRET no cambie
app.use(
  cookieSession({
    name: 'pasame-la-foto.sid',
    secret: SESSION_SECRET,
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 días
    sameSite: 'lax',
    secure: IS_HTTPS,
  })
);

// Máximo 10 intentos de login por IP cada 15 minutos
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos, prueba de nuevo más tarde' },
});

// ---------- Subida de archivos ----------

// Whitelist cerrada de mimetype -> extensión: el nombre final en disco nunca
// depende del originalname que manda el cliente (evita XSS almacenado vía
// nombre de archivo) ni de mimetypes peligrosos como image/svg+xml.
const ALLOWED_MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heic',
  'image/avif': '.avif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
  'video/x-msvideo': '.avi',
  'video/3gpp': '.3gp',
};

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = ALLOWED_MIME_EXT[file.mimetype];
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_EXT[file.mimetype]) cb(null, true);
    else cb(new Error('Solo se permiten fotos y videos en formatos admitidos'));
  },
});

// ---------- Helpers ----------

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.avif']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.3gp']);

function mediaType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'other';
}

function safeFilePath(name) {
  // Evita path traversal: el archivo debe existir dentro de UPLOAD_DIR
  const resolved = path.resolve(UPLOAD_DIR, name);
  if (!resolved.startsWith(UPLOAD_DIR + path.sep)) return null;
  return resolved;
}

function requireAdmin(req, res, next) {
  if (req.session.isAdmin) return next();
  res.status(401).json({ error: 'No autorizado' });
}

function thumbPathFor(name) {
  return path.join(THUMB_DIR, path.basename(name).replace(/\.[^.]+$/, '') + '.jpg');
}

// ---------- Configuración y metadatos (sin base de datos: todo en JSON) ----------

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function readSettings() {
  return readJson(SETTINGS_PATH, { eventDate: null, watermarkText: '' });
}

function writeSettings(settings) {
  writeJson(SETTINGS_PATH, settings);
}

function readMediaMeta() {
  return readJson(MEDIA_META_PATH, {});
}

function writeMediaMeta(meta) {
  writeJson(MEDIA_META_PATH, meta);
}

function canGuestDownload(name, meta) {
  return meta[name]?.downloadable === 'all';
}

function deleteMedia(name) {
  const filePath = safeFilePath(name);
  if (!filePath || !fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  const thumb = thumbPathFor(name);
  if (fs.existsSync(thumb)) fs.unlinkSync(thumb);
  const wmThumb = path.join(WM_THUMB_DIR, path.basename(name));
  if (fs.existsSync(wmThumb)) fs.unlinkSync(wmThumb);
  const wmDisplay = path.join(WM_DISPLAY_DIR, path.basename(name));
  if (fs.existsSync(wmDisplay)) fs.unlinkSync(wmDisplay);
  const meta = readMediaMeta();
  if (meta[name]) {
    delete meta[name];
    writeMediaMeta(meta);
  }
  return true;
}

// Genera (o reutiliza de caché) una versión con marca de agua de texto.
// La caché se invalida sola si settings.json es más reciente que el archivo cacheado.
async function getWatermarked(sourcePath, cacheDir) {
  const cachedPath = path.join(cacheDir, path.basename(sourcePath));
  const settingsMTime = fs.existsSync(SETTINGS_PATH) ? fs.statSync(SETTINGS_PATH).mtimeMs : 0;
  if (fs.existsSync(cachedPath) && fs.statSync(cachedPath).mtimeMs >= settingsMTime) {
    return cachedPath;
  }
  const { watermarkText } = readSettings();
  const image = sharp(sourcePath);
  const { width, height } = await image.metadata();
  const fontSize = Math.max(12, Math.round((width || 800) * 0.032));
  const escaped = String(watermarkText)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <text x="${width - 14}" y="${height - 14}" text-anchor="end" font-family="'Playfair Display', serif"
      font-style="italic" font-size="${fontSize}" fill="white" fill-opacity="0.9"
      style="paint-order: stroke; stroke: rgba(0,0,0,0.5); stroke-width: ${Math.max(1, fontSize * 0.06)}px">${escaped}</text>
  </svg>`;
  await image.composite([{ input: Buffer.from(svg) }]).toFile(cachedPath);
  return cachedPath;
}

// Sirve `sourcePath` con marca de agua si aplica (imagen + texto configurado + no admin);
// si algo falla al generarla, sirve el original para no romper la vista.
// La misma URL sirve contenido distinto según la sesión (admin ve el original,
// el invitado la versión con marca de agua): sin "no-store" el navegador podría
// reutilizar en caché la versión de invitado al iniciar sesión como admin.
async function sendMaybeWatermarked(req, res, sourcePath, cacheDir) {
  const { watermarkText } = readSettings();
  const isImage = mediaType(sourcePath) === 'image';
  res.setHeader('Cache-Control', 'no-store');
  if (!req.session.isAdmin && isImage && watermarkText) {
    try {
      const wmPath = await getWatermarked(sourcePath, cacheDir);
      res.setHeader('Content-Disposition', 'inline');
      return res.sendFile(wmPath);
    } catch {
      // sigue abajo y sirve el original
    }
  }
  res.setHeader('Content-Disposition', 'inline');
  res.sendFile(sourcePath);
}

// Rechaza subidas cuando el evento ya ocupa el máximo configurado
function checkTotalSpace(req, res, next) {
  const total = fs
    .readdirSync(UPLOAD_DIR)
    .map((f) => path.join(UPLOAD_DIR, f))
    .filter((p) => fs.statSync(p).isFile())
    .reduce((sum, p) => sum + fs.statSync(p).size, 0);
  if (total > MAX_TOTAL_GB * 1024 ** 3) {
    return res.status(507).json({ error: 'Se ha alcanzado el espacio máximo del evento' });
  }
  next();
}

// Comprime una imagen recién subida y genera su miniatura.
// Los videos se guardan tal cual (transcodificar requeriría ffmpeg).
async function processUpload(file) {
  let finalPath = file.path;

  if (file.mimetype.startsWith('image/')) {
    const dst = path.join(UPLOAD_DIR, path.basename(file.path, path.extname(file.path)) + '.jpg');
    const tmp = dst + '.tmp';
    try {
      await sharp(file.path)
        .rotate() // respeta la orientación EXIF
        .resize({ width: IMAGE_MAX_SIDE, height: IMAGE_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: IMAGE_QUALITY, mozjpeg: true })
        .toFile(tmp);
      if (fs.statSync(tmp).size < fs.statSync(file.path).size) {
        fs.unlinkSync(file.path);
        fs.renameSync(tmp, dst);
        finalPath = dst;
      } else {
        fs.unlinkSync(tmp); // ya estaba bien comprimida
      }
    } catch {
      // formato que sharp no puede leer (p.ej. HEIC): se guarda el original
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }

    try {
      await sharp(finalPath)
        .rotate()
        .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover' })
        .jpeg({ quality: 70 })
        .toFile(thumbPathFor(finalPath));
    } catch {
      // sin miniatura la galería usa el archivo completo
    }
  }

  return path.basename(finalPath);
}

// ---------- API pública (invitados) ----------

// Subir uno o varios archivos (las imágenes se comprimen al recibirlas)
app.post('/api/upload', checkTotalSpace, upload.array('files', 20), async (req, res, next) => {
  try {
    const downloadable = req.body.downloadable === 'all' ? 'all' : 'admin';
    const finalNames = await Promise.all(req.files.map(processUpload));
    const meta = readMediaMeta();
    for (const name of finalNames) meta[name] = { downloadable };
    writeMediaMeta(meta);
    res.json({ ok: true, count: req.files.length });
  } catch (err) {
    next(err);
  }
});

// Listar los archivos subidos
app.get('/api/media', (req, res) => {
  const meta = readMediaMeta();
  // El contenido de /media y /thumbs depende de la sesión (admin ve el
  // original, el invitado la versión con marca de agua) pero la ruta sería
  // idéntica para los dos; algunos navegadores reutilizan igualmente una
  // imagen ya vista para esa misma URL aunque el servidor mande "no-store".
  // Con esta marca en la query, admin e invitado nunca comparten URL.
  const roleTag = req.session.isAdmin ? 'a' : 'g';
  const files = fs
    .readdirSync(UPLOAD_DIR)
    .filter((f) => mediaType(f) !== 'other')
    .map((f) => {
      const stat = fs.statSync(path.join(UPLOAD_DIR, f));
      const hasThumb = fs.existsSync(thumbPathFor(f));
      return {
        id: f,
        type: mediaType(f),
        url: `/media/${f}?v=${roleTag}`,
        thumb: hasThumb ? `/thumbs/${path.basename(thumbPathFor(f))}?v=${roleTag}` : null,
        uploadedAt: stat.mtimeMs,
        canDownload: req.session.isAdmin || canGuestDownload(f, meta),
      };
    })
    .sort((a, b) => b.uploadedAt - a.uploadedAt);
  res.json(files);
});

// Servir una miniatura (con marca de agua para invitados si está configurada)
app.get('/thumbs/:name', async (req, res) => {
  const resolved = path.resolve(THUMB_DIR, req.params.name);
  if (!resolved.startsWith(THUMB_DIR + path.sep) || !fs.existsSync(resolved)) return res.status(404).end();
  await sendMaybeWatermarked(req, res, resolved, WM_THUMB_DIR);
});

// Servir un archivo SOLO para visualización (inline, no como descarga;
// con marca de agua para invitados si está configurada)
app.get('/media/:name', async (req, res) => {
  const filePath = safeFilePath(req.params.name);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).end();
  await sendMaybeWatermarked(req, res, filePath, WM_DISPLAY_DIR);
});

// Descargar un archivo si está permitido para todos (o si es el admin); siempre sin marca de agua
app.get('/api/download/:name', (req, res) => {
  const filePath = safeFilePath(req.params.name);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).end();
  const meta = readMediaMeta();
  if (!req.session.isAdmin && !canGuestDownload(req.params.name, meta)) {
    return res.status(403).json({ error: 'Descarga no permitida' });
  }
  res.download(filePath);
});

// ---------- Autenticación admin ----------

app.post('/api/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const validEmail = typeof email === 'string' && email === ADMIN_EMAIL;
  // bcrypt.compare siempre se ejecuta, aunque el email ya sea inválido,
  // para no filtrar por temporización si el email existe o no.
  const validPassword = typeof password === 'string' && (await bcrypt.compare(password, ADMIN_PASSWORD_HASH));
  if (validEmail && validPassword) {
    req.session.isAdmin = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Credenciales incorrectas' });
});

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ isAdmin: !!req.session.isAdmin });
});

// ---------- API admin ----------

// Descargar un archivo (attachment fuerza la descarga)
app.get('/api/admin/download/:name', requireAdmin, (req, res) => {
  const filePath = safeFilePath(req.params.name);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).end();
  res.download(filePath);
});

// Descargar varios archivos en un ZIP (?files=a.jpg,b.mp4), o toda la galería (?all=1)
app.get('/api/admin/zip', requireAdmin, (req, res) => {
  const names =
    req.query.all === '1'
      ? fs.readdirSync(UPLOAD_DIR).filter((f) => mediaType(f) !== 'other')
      : String(req.query.files || '').split(',').filter(Boolean);
  const files = names.map(safeFilePath).filter((p) => p && fs.existsSync(p));
  if (!files.length) return res.status(400).json({ error: 'Sin archivos válidos' });
  res.attachment('pasame-la-foto.zip');
  const zip = archiver('zip', { zlib: { level: 1 } }); // fotos/videos ya vienen comprimidos
  zip.on('error', (err) => res.destroy(err));
  zip.pipe(res);
  for (const f of files) zip.file(f, { name: path.basename(f) });
  zip.finalize();
});

// Borrar varios archivos a la vez
app.post('/api/admin/delete', requireAdmin, (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  const deleted = ids.filter(deleteMedia).length;
  res.json({ ok: true, deleted });
});

// Borrar un archivo
app.delete('/api/admin/media/:name', requireAdmin, (req, res) => {
  if (!deleteMedia(req.params.name)) return res.status(404).json({ error: 'No existe' });
  res.json({ ok: true });
});

// ---------- Ajustes del evento (fecha para la expiración, texto de marca de agua) ----------

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json(readSettings());
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const { eventDate, watermarkText } = req.body || {};
  if (eventDate && Number.isNaN(new Date(eventDate).getTime())) {
    return res.status(400).json({ error: 'Fecha de evento no válida' });
  }
  const settings = readSettings();
  settings.eventDate = eventDate || null;
  settings.watermarkText = String(watermarkText || '').slice(0, 80);
  writeSettings(settings);
  res.json({ ok: true });
});

// ---------- Código QR ----------

// PNG con el QR que apunta a la web (configurable con PUBLIC_URL en .env)
app.get('/qr', async (req, res) => {
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const png = await QRCode.toBuffer(base, { width: 600, margin: 2 });
  res.type('png').send(png);
});

// ---------- Expiración automática del evento ----------
// 30 días después de la fecha de evento fijada por el admin, se borra todo
// el contenido subido. La fecha vuelve a null para poder reutilizar el
// despliegue en un evento siguiente (la marca de agua se conserva).

function clearDir(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile()) fs.unlinkSync(p);
  }
}

function checkExpiration() {
  const settings = readSettings();
  if (!settings.eventDate) return;
  const expiresAt = new Date(settings.eventDate).getTime() + EXPIRATION_MS;
  if (Date.now() < expiresAt) return;

  clearDir(UPLOAD_DIR);
  clearDir(THUMB_DIR);
  clearDir(WM_THUMB_DIR);
  clearDir(WM_DISPLAY_DIR);
  writeMediaMeta({});
  settings.eventDate = null;
  writeSettings(settings);
  console.log('Evento expirado: se ha borrado todo el contenido subido.');
}

checkExpiration();
setInterval(checkExpiration, 60 * 60 * 1000);

// ---------- Manejo de errores ----------

app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `Archivo demasiado grande (máximo ${MAX_FILE_MB} MB)` });
  }
  console.error(err.message);
  res.status(400).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`Pásame la foto escuchando en http://localhost:${PORT}`);
});
