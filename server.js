require('dotenv').config();

const express = require('express');
const cookieSession = require('cookie-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const archiver = require('archiver');
const sharp = require('sharp');

const app = express();

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const THUMB_DIR = path.join(UPLOAD_DIR, '.thumbs');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'cambiame';

// Límites y compresión (configurables en .env)
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || '100', 10); // por archivo
const MAX_TOTAL_GB = parseFloat(process.env.MAX_TOTAL_GB || '20'); // total del evento
const IMAGE_MAX_SIDE = parseInt(process.env.IMAGE_MAX_SIDE || '2560', 10); // lado mayor tras comprimir
const IMAGE_QUALITY = parseInt(process.env.IMAGE_QUALITY || '82', 10); // calidad JPEG
const THUMB_SIZE = 480; // miniaturas de la galería

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(THUMB_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// El login del admin está integrado en la página principal
app.get('/admin.html', (req, res) => res.redirect('/'));
// La sesión viaja firmada en la cookie (sin estado en el servidor):
// sobrevive a reinicios y rebuilds mientras SESSION_SECRET no cambie
app.use(
  cookieSession({
    name: 'pasame-la-foto.sid',
    secret: process.env.SESSION_SECRET || 'pasame-la-foto-secret-cambiame',
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 días
    sameSite: 'lax',
  })
);

// ---------- Subida de archivos ----------

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^(image|video)\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Solo se permiten fotos y videos'));
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

function deleteMedia(name) {
  const filePath = safeFilePath(name);
  if (!filePath || !fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  const thumb = thumbPathFor(name);
  if (fs.existsSync(thumb)) fs.unlinkSync(thumb);
  return true;
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
}

// ---------- API pública (invitados) ----------

// Subir uno o varios archivos (las imágenes se comprimen al recibirlas)
app.post('/api/upload', checkTotalSpace, upload.array('files', 20), async (req, res, next) => {
  try {
    await Promise.all(req.files.map(processUpload));
    res.json({ ok: true, count: req.files.length });
  } catch (err) {
    next(err);
  }
});

// Listar los archivos subidos
app.get('/api/media', (req, res) => {
  const files = fs
    .readdirSync(UPLOAD_DIR)
    .filter((f) => mediaType(f) !== 'other')
    .map((f) => {
      const stat = fs.statSync(path.join(UPLOAD_DIR, f));
      const hasThumb = fs.existsSync(thumbPathFor(f));
      return {
        id: f,
        type: mediaType(f),
        url: `/media/${f}`,
        thumb: hasThumb ? `/thumbs/${path.basename(thumbPathFor(f))}` : null,
        uploadedAt: stat.mtimeMs,
      };
    })
    .sort((a, b) => b.uploadedAt - a.uploadedAt);
  res.json(files);
});

// Servir una miniatura
app.get('/thumbs/:name', (req, res) => {
  const resolved = path.resolve(THUMB_DIR, req.params.name);
  if (!resolved.startsWith(THUMB_DIR + path.sep) || !fs.existsSync(resolved)) return res.status(404).end();
  res.setHeader('Content-Disposition', 'inline');
  res.sendFile(resolved);
});

// Servir un archivo SOLO para visualización (inline, no como descarga)
app.get('/media/:name', (req, res) => {
  const filePath = safeFilePath(req.params.name);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).end();
  res.setHeader('Content-Disposition', 'inline');
  res.sendFile(filePath);
});

// ---------- Autenticación admin ----------

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
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

// Descargar varios archivos en un ZIP (?files=a.jpg,b.mp4)
app.get('/api/admin/zip', requireAdmin, (req, res) => {
  const names = String(req.query.files || '').split(',').filter(Boolean);
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

// ---------- Código QR ----------

// PNG con el QR que apunta a la web (configurable con PUBLIC_URL en .env)
app.get('/qr', async (req, res) => {
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const png = await QRCode.toBuffer(base, { width: 600, margin: 2 });
  res.type('png').send(png);
});

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
