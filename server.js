require('dotenv').config();

const express = require('express');
const cookieSession = require('cookie-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const archiver = require('archiver');
const sharp = require('sharp');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');

const app = express();

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(UPLOAD_DIR, '.data');
const USERS_PATH = path.join(DATA_DIR, 'users.json');
const INVITES_PATH = path.join(DATA_DIR, 'invites.json');
const EXPIRATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 días desde la fecha del evento
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const IS_HTTPS = PUBLIC_URL.startsWith('https://');

// Sin valores por defecto: un despliegue con el .env a medio configurar
// no debe arrancar con un secreto de sesión adivinable.
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.error('Falta SESSION_SECRET en el .env. Copia .env.example y complétalo antes de arrancar.');
  process.exit(1);
}

// Límites y compresión (configurables en .env)
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || '100', 10); // por archivo
const MAX_TOTAL_GB = parseFloat(process.env.MAX_TOTAL_GB || '20'); // total por evento
const IMAGE_MAX_SIDE = parseInt(process.env.IMAGE_MAX_SIDE || '2560', 10); // lado mayor tras comprimir
const IMAGE_QUALITY = parseInt(process.env.IMAGE_QUALITY || '82', 10); // calidad JPEG
const THUMB_SIZE = 480; // miniaturas de la galería

fs.mkdirSync(DATA_DIR, { recursive: true });

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
// event.html solo tiene sentido bajo /e/<id> (app.js saca el evento de la URL)
app.get('/event.html', (req, res) => res.redirect('/'));
app.use(express.static(path.join(__dirname, 'public')));
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

// Máximo 5 registros por IP cada hora
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados registros, prueba de nuevo más tarde' },
});

// ---------- Usuarios y eventos ----------
// Cada cuenta tiene su evento: los archivos viven en uploads/<eventId>/ y la
// estructura interna replica la del proyecto original (miniaturas, cachés de
// marca de agua y metadatos en subcarpetas ocultas del propio evento).

const EVENT_ID_RE = /^[a-z0-9]{10}$/;
const USERNAME_RE = /^[a-z0-9._-]{3,30}$/;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function newEventId() {
  return Array.from({ length: 10 }, () => ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)]).join('');
}

function eventDirs(eventId) {
  const dir = path.join(UPLOAD_DIR, eventId);
  return {
    id: eventId,
    dir,
    thumbs: path.join(dir, '.thumbs'),
    wmThumbs: path.join(dir, '.wm-thumbs'),
    wmDisplay: path.join(dir, '.wm-display'),
    settingsPath: path.join(dir, '.data', 'settings.json'),
    mediaMetaPath: path.join(dir, '.data', 'media-meta.json'),
  };
}

function createEventDirs(ev) {
  for (const d of [ev.dir, ev.thumbs, ev.wmThumbs, ev.wmDisplay, path.dirname(ev.settingsPath)]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function readUsers() {
  return readJson(USERS_PATH, {});
}

function writeUsers(users) {
  writeJson(USERS_PATH, users);
}

function readInvites() {
  return readJson(INVITES_PATH, []);
}

function writeInvites(codes) {
  writeJson(INVITES_PATH, codes);
}

// eventId del usuario con sesión iniciada (o null)
function sessionEventId(req) {
  const username = req.session.user;
  if (!username) return null;
  return readUsers()[username]?.eventId || null;
}

function isEventAdmin(req, eventId) {
  return sessionEventId(req) === eventId;
}

// Valida el :eventId de la URL y deja el evento en req.event
function loadEvent(req, res, next) {
  const { eventId } = req.params;
  if (!EVENT_ID_RE.test(eventId)) return res.status(404).json({ error: 'Evento no encontrado' });
  const ev = eventDirs(eventId);
  if (!fs.existsSync(ev.dir)) return res.status(404).json({ error: 'Evento no encontrado' });
  req.event = ev;
  next();
}

function requireEventAdmin(req, res, next) {
  if (isEventAdmin(req, req.event.id)) return next();
  res.status(401).json({ error: 'No autorizado' });
}

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
  // loadEvent corre antes que multer, así que req.event ya está resuelto
  destination: (req, file, cb) => cb(null, req.event.dir),
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

function safeFilePath(ev, name) {
  // Evita path traversal: el archivo debe existir dentro del evento
  const resolved = path.resolve(ev.dir, name);
  if (!resolved.startsWith(ev.dir + path.sep)) return null;
  return resolved;
}

function thumbPathFor(ev, name) {
  return path.join(ev.thumbs, path.basename(name).replace(/\.[^.]+$/, '') + '.jpg');
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

function readSettings(ev) {
  return readJson(ev.settingsPath, { eventDate: null, watermarkText: '', eventName: '' });
}

function writeSettings(ev, settings) {
  writeJson(ev.settingsPath, settings);
}

function readMediaMeta(ev) {
  return readJson(ev.mediaMetaPath, {});
}

function writeMediaMeta(ev, meta) {
  writeJson(ev.mediaMetaPath, meta);
}

function canGuestDownload(name, meta) {
  return meta[name]?.downloadable === 'all';
}

function deleteMedia(ev, name) {
  const filePath = safeFilePath(ev, name);
  if (!filePath || !fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  const thumb = thumbPathFor(ev, name);
  if (fs.existsSync(thumb)) fs.unlinkSync(thumb);
  const wmThumb = path.join(ev.wmThumbs, path.basename(name));
  if (fs.existsSync(wmThumb)) fs.unlinkSync(wmThumb);
  const wmDisplay = path.join(ev.wmDisplay, path.basename(name));
  if (fs.existsSync(wmDisplay)) fs.unlinkSync(wmDisplay);
  const meta = readMediaMeta(ev);
  if (meta[name]) {
    delete meta[name];
    writeMediaMeta(ev, meta);
  }
  return true;
}

// Genera (o reutiliza de caché) una versión con marca de agua de texto.
// La caché se invalida sola si el settings.json del evento es más reciente.
async function getWatermarked(ev, sourcePath, cacheDir) {
  const cachedPath = path.join(cacheDir, path.basename(sourcePath));
  const settingsMTime = fs.existsSync(ev.settingsPath) ? fs.statSync(ev.settingsPath).mtimeMs : 0;
  if (fs.existsSync(cachedPath) && fs.statSync(cachedPath).mtimeMs >= settingsMTime) {
    return cachedPath;
  }
  const { watermarkText } = readSettings(ev);
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
// La misma URL sirve contenido distinto según la sesión (el admin del evento ve
// el original, el invitado la versión con marca de agua): sin "no-store" el
// navegador podría reutilizar en caché la versión de invitado tras el login.
async function sendMaybeWatermarked(req, res, ev, sourcePath, cacheDir) {
  const { watermarkText } = readSettings(ev);
  const isImage = mediaType(sourcePath) === 'image';
  res.setHeader('Cache-Control', 'no-store');
  if (!isEventAdmin(req, ev.id) && isImage && watermarkText) {
    try {
      const wmPath = await getWatermarked(ev, sourcePath, cacheDir);
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
    .readdirSync(req.event.dir)
    .map((f) => path.join(req.event.dir, f))
    .filter((p) => fs.statSync(p).isFile())
    .reduce((sum, p) => sum + fs.statSync(p).size, 0);
  if (total > MAX_TOTAL_GB * 1024 ** 3) {
    return res.status(507).json({ error: 'Se ha alcanzado el espacio máximo del evento' });
  }
  next();
}

// Comprime una imagen recién subida y genera su miniatura.
// Los videos se guardan tal cual (transcodificar requeriría ffmpeg).
async function processUpload(ev, file) {
  let finalPath = file.path;

  if (file.mimetype.startsWith('image/')) {
    const dst = path.join(ev.dir, path.basename(file.path, path.extname(file.path)) + '.jpg');
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
        .toFile(thumbPathFor(ev, finalPath));
    } catch {
      // sin miniatura la galería usa el archivo completo
    }
  }

  return path.basename(finalPath);
}

// ---------- Autenticación y registro ----------

// Hash de una contraseña aleatoria: cuando el usuario no existe se compara
// contra él igualmente, para que la respuesta tarde lo mismo que con un
// usuario real (no filtra por temporización si un nombre existe o no).
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 12);

// Crear cuenta + evento con un código de invitación de un solo uso
app.post('/api/register', registerLimiter, async (req, res) => {
  const { username, password, inviteCode } = req.body || {};
  const user = String(username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(user)) {
    return res.status(400).json({ error: 'Nombre de usuario no válido: 3-30 caracteres entre letras minúsculas, números y ". _ -"' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  }
  const code = String(inviteCode || '').trim().toUpperCase();
  const invites = readInvites();
  if (!invites.includes(code)) {
    return res.status(403).json({ error: 'Código de invitación no válido' });
  }
  const users = readUsers();
  if (users[user]) {
    return res.status(409).json({ error: 'Ese nombre de usuario ya existe' });
  }

  const eventId = newEventId();
  createEventDirs(eventDirs(eventId));
  users[user] = { passwordHash: await bcrypt.hash(password, 12), eventId, createdAt: Date.now() };
  writeUsers(users);
  writeInvites(invites.filter((c) => c !== code)); // el código se consume
  req.session.user = user;
  res.json({ ok: true, eventId });
});

app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const user = String(username || '').trim().toLowerCase();
  const account = readUsers()[user];
  const validPassword =
    typeof password === 'string' && (await bcrypt.compare(password, account ? account.passwordHash : DUMMY_HASH));
  if (account && validPassword) {
    req.session.user = user;
    return res.json({ ok: true, eventId: account.eventId });
  }
  res.status(401).json({ error: 'Credenciales incorrectas' });
});

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const username = req.session.user || null;
  const eventId = sessionEventId(req);
  res.json({ user: eventId ? username : null, eventId });
});

// ---------- Página y API pública del evento (invitados) ----------

// La galería: la misma página para invitados y para el admin del evento
app.get('/e/:eventId', (req, res) => {
  const { eventId } = req.params;
  if (!EVENT_ID_RE.test(eventId) || !fs.existsSync(path.join(UPLOAD_DIR, eventId))) {
    return res
      .status(404)
      .send('<!doctype html><html lang="es"><meta charset="utf-8"><title>Evento no encontrado</title><body style="font-family:sans-serif;text-align:center;padding:3rem"><h1>Evento no encontrado</h1><p>Revisa el enlace o el código QR.</p><a href="/">Ir al inicio</a></body></html>');
  }
  res.sendFile(path.join(__dirname, 'public', 'event.html'));
});

// Nombre del evento (público: el hero de la galería lo muestra a los invitados)
app.get('/api/e/:eventId/info', loadEvent, (req, res) => {
  const { eventName } = readSettings(req.event);
  res.json({ eventName: eventName || '' });
});

// Subir uno o varios archivos (las imágenes se comprimen al recibirlas)
app.post('/api/e/:eventId/upload', loadEvent, checkTotalSpace, upload.array('files', 20), async (req, res, next) => {
  try {
    const downloadable = req.body.downloadable === 'all' ? 'all' : 'admin';
    const finalNames = await Promise.all(req.files.map((f) => processUpload(req.event, f)));
    const meta = readMediaMeta(req.event);
    for (const name of finalNames) meta[name] = { downloadable };
    writeMediaMeta(req.event, meta);
    res.json({ ok: true, count: req.files.length });
  } catch (err) {
    next(err);
  }
});

// Listar los archivos subidos
app.get('/api/e/:eventId/media', loadEvent, (req, res) => {
  const ev = req.event;
  const meta = readMediaMeta(ev);
  const admin = isEventAdmin(req, ev.id);
  // El contenido de media y thumbs depende de la sesión (el admin ve el
  // original, el invitado la versión con marca de agua) pero la ruta sería
  // idéntica para los dos; algunos navegadores reutilizan igualmente una
  // imagen ya vista para esa misma URL aunque el servidor mande "no-store".
  // Con esta marca en la query, admin e invitado nunca comparten URL.
  const roleTag = admin ? 'a' : 'g';
  const files = fs
    .readdirSync(ev.dir)
    .filter((f) => mediaType(f) !== 'other')
    .map((f) => {
      const stat = fs.statSync(path.join(ev.dir, f));
      const hasThumb = fs.existsSync(thumbPathFor(ev, f));
      return {
        id: f,
        type: mediaType(f),
        url: `/e/${ev.id}/media/${f}?v=${roleTag}`,
        thumb: hasThumb ? `/e/${ev.id}/thumbs/${path.basename(thumbPathFor(ev, f))}?v=${roleTag}` : null,
        uploadedAt: stat.mtimeMs,
        canDownload: admin || canGuestDownload(f, meta),
      };
    })
    .sort((a, b) => b.uploadedAt - a.uploadedAt);
  res.json(files);
});

// Servir una miniatura (con marca de agua para invitados si está configurada)
app.get('/e/:eventId/thumbs/:name', loadEvent, async (req, res) => {
  const resolved = path.resolve(req.event.thumbs, req.params.name);
  if (!resolved.startsWith(req.event.thumbs + path.sep) || !fs.existsSync(resolved)) return res.status(404).end();
  await sendMaybeWatermarked(req, res, req.event, resolved, req.event.wmThumbs);
});

// Servir un archivo SOLO para visualización (inline, no como descarga;
// con marca de agua para invitados si está configurada)
app.get('/e/:eventId/media/:name', loadEvent, async (req, res) => {
  const filePath = safeFilePath(req.event, req.params.name);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).end();
  await sendMaybeWatermarked(req, res, req.event, filePath, req.event.wmDisplay);
});

// Descargar un archivo si está permitido para todos (o si es el admin del evento); siempre sin marca de agua
app.get('/api/e/:eventId/download/:name', loadEvent, (req, res) => {
  const filePath = safeFilePath(req.event, req.params.name);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).end();
  const meta = readMediaMeta(req.event);
  if (!isEventAdmin(req, req.event.id) && !canGuestDownload(req.params.name, meta)) {
    return res.status(403).json({ error: 'Descarga no permitida' });
  }
  res.download(filePath);
});

// ---------- API admin del evento ----------

// Descargar un archivo (attachment fuerza la descarga)
app.get('/api/e/:eventId/admin/download/:name', loadEvent, requireEventAdmin, (req, res) => {
  const filePath = safeFilePath(req.event, req.params.name);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).end();
  res.download(filePath);
});

// Descargar varios archivos en un ZIP (?files=a.jpg,b.mp4), o toda la galería (?all=1)
app.get('/api/e/:eventId/admin/zip', loadEvent, requireEventAdmin, (req, res) => {
  const ev = req.event;
  const names =
    req.query.all === '1'
      ? fs.readdirSync(ev.dir).filter((f) => mediaType(f) !== 'other')
      : String(req.query.files || '').split(',').filter(Boolean);
  const files = names.map((n) => safeFilePath(ev, n)).filter((p) => p && fs.existsSync(p));
  if (!files.length) return res.status(400).json({ error: 'Sin archivos válidos' });
  res.attachment('pasame-la-foto.zip');
  const zip = archiver('zip', { zlib: { level: 1 } }); // fotos/videos ya vienen comprimidos
  zip.on('error', (err) => res.destroy(err));
  zip.pipe(res);
  for (const f of files) zip.file(f, { name: path.basename(f) });
  zip.finalize();
});

// Borrar varios archivos a la vez
app.post('/api/e/:eventId/admin/delete', loadEvent, requireEventAdmin, (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  const deleted = ids.filter((id) => deleteMedia(req.event, id)).length;
  res.json({ ok: true, deleted });
});

// Borrar un archivo
app.delete('/api/e/:eventId/admin/media/:name', loadEvent, requireEventAdmin, (req, res) => {
  if (!deleteMedia(req.event, req.params.name)) return res.status(404).json({ error: 'No existe' });
  res.json({ ok: true });
});

// ---------- Ajustes del evento (nombre, fecha para la expiración, marca de agua) ----------

app.get('/api/e/:eventId/admin/settings', loadEvent, requireEventAdmin, (req, res) => {
  res.json(readSettings(req.event));
});

app.post('/api/e/:eventId/admin/settings', loadEvent, requireEventAdmin, (req, res) => {
  const { eventDate, watermarkText, eventName } = req.body || {};
  if (eventDate && Number.isNaN(new Date(eventDate).getTime())) {
    return res.status(400).json({ error: 'Fecha de evento no válida' });
  }
  const settings = readSettings(req.event);
  settings.eventDate = eventDate || null;
  settings.watermarkText = String(watermarkText || '').slice(0, 80);
  settings.eventName = String(eventName || '').slice(0, 60);
  writeSettings(req.event, settings);
  res.json({ ok: true });
});

// ---------- Código QR del evento ----------

// PNG con el QR que apunta a la galería del evento (la base se configura con PUBLIC_URL)
app.get('/e/:eventId/qr', loadEvent, requireEventAdmin, async (req, res) => {
  const base = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const png = await QRCode.toBuffer(`${base}/e/${req.event.id}`, { width: 600, margin: 2 });
  res.type('png').send(png);
});

// ---------- Expiración automática de los eventos ----------
// 30 días después de la fecha fijada por cada admin, se borra el contenido
// subido a su evento. La fecha vuelve a null para poder reutilizar el portal
// en un evento siguiente (la cuenta, el nombre y la marca de agua se conservan).

function clearDir(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile()) fs.unlinkSync(p);
  }
}

function checkExpiration() {
  const users = readUsers();
  for (const { eventId } of Object.values(users)) {
    const ev = eventDirs(eventId);
    if (!fs.existsSync(ev.dir)) continue;
    const settings = readSettings(ev);
    if (!settings.eventDate) continue;
    const expiresAt = new Date(settings.eventDate).getTime() + EXPIRATION_MS;
    if (Date.now() < expiresAt) continue;

    clearDir(ev.dir);
    clearDir(ev.thumbs);
    clearDir(ev.wmThumbs);
    clearDir(ev.wmDisplay);
    writeMediaMeta(ev, {});
    settings.eventDate = null;
    writeSettings(ev, settings);
    console.log(`Evento ${eventId} expirado: se ha borrado todo el contenido subido.`);
  }
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
