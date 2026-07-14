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
const Stripe = require('stripe');
const { sendMail } = require('./mailer');

const app = express();

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(UPLOAD_DIR, '.data');
const USERS_PATH = path.join(DATA_DIR, 'users.json');
const INVITES_PATH = path.join(DATA_DIR, 'invites.json');
const PURCHASES_PATH = path.join(DATA_DIR, 'purchases.json');
const DEFAULT_USAGE_DAYS = 15; // ventana de uso desde el día de inicio que fija el usuario
// URL pública del servicio. Es la ÚNICA fuente de la base para los enlaces que
// salen del servidor (email de recuperación, código de la compra, aviso de
// caducidad y el QR del evento). Nunca se deriva de la cabecera Host de la
// petición: esa cabecera la controla el cliente, así que un atacante podría
// pedir el reset de otra cuenta con "Host: dominio-atacante" y hacer que el
// enlace del correo —con el token válido— apunte a su servidor. Por eso es
// obligatoria (como SESSION_SECRET): sin ella no se arranca.
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const IS_HTTPS = PUBLIC_URL.startsWith('https://');

// Credenciales del SuperAdministrador. Sin ellas en el .env, el panel /admin
// y toda la API /api/sa/* quedan desactivados (responden 404).
const SUPERADMIN_USER = process.env.SUPERADMIN_USER || '';
const SUPERADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD || '';
const SUPERADMIN_ENABLED = Boolean(SUPERADMIN_USER && SUPERADMIN_PASSWORD);

// Buzón del formulario de contacto de la landing. Si el SMTP está configurado,
// SMTP_USER existe siempre, así que el fallback garantiza destinatario; sin
// SMTP, el mailer imprime el mensaje en el log (útil en local).
const CONTACT_EMAIL = (process.env.CONTACT_EMAIL || process.env.SMTP_USER || '').trim();

// Compra directa con Stripe. Con las dos claves en el .env, la landing vende
// los planes con pago con tarjeta y el webhook envía el código por email; sin
// ellas, la compra queda desactivada y la contratación sigue siendo por el
// formulario de contacto. Se exigen las dos a la vez: cobrar sin webhook
// dejaría pagos hechos sin código entregado.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_ENABLED = Boolean(STRIPE_SECRET_KEY && STRIPE_WEBHOOK_SECRET);
const stripe = STRIPE_ENABLED ? new Stripe(STRIPE_SECRET_KEY) : null;
if (!STRIPE_ENABLED && (STRIPE_SECRET_KEY || STRIPE_WEBHOOK_SECRET)) {
  console.warn(
    'Stripe a medio configurar: hacen falta STRIPE_SECRET_KEY y STRIPE_WEBHOOK_SECRET a la vez. La compra directa queda desactivada.'
  );
}

// Planes a la venta. Lo que se cobra y lo que concede cada código (espacio y
// días de uso) sale siempre de esta tabla: la usan el pago con Stripe, el
// generador de códigos del panel de SuperAdministrador y la landing (que solo
// muestra estos datos, nunca los decide).
const PLANS = {
  basico: { name: 'Galería Básica', quotaGB: 3, usageDays: 15, priceCents: 1500 },
  grande: { name: 'Galería Grande', quotaGB: 5, usageDays: 25, priceCents: 2000 },
};

// Sin valores por defecto: un despliegue con el .env a medio configurar
// no debe arrancar con un secreto de sesión adivinable.
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.error('Falta SESSION_SECRET en el .env. Copia .env.example y complétalo antes de arrancar.');
  process.exit(1);
}

// Obligatoria y bien formada: los enlaces que salen por email se construyen con
// ella (ver comentario arriba). En local vale http://localhost:3000.
if (!/^https?:\/\/.+/.test(PUBLIC_URL)) {
  console.error('Falta PUBLIC_URL en el .env (p.ej. https://fotos.tudominio.com o http://localhost:3000). Es la base de los enlaces que se envían por email; sin ella no se arranca.');
  process.exit(1);
}

// Límites y compresión (configurables en .env)
// Por archivo. 25 MB cubre de sobra la foto de cualquier móvil (3-15 MB) sin
// dejar que un atacante infle cada subida; quien necesite originales de cámara
// puede subirlo en el .env.
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || '25', 10);
// Tope de la petición completa (todos los archivos juntos). Junto al límite por
// archivo de multer acota lo que una sola petición puede costar en disco y CPU.
const MAX_REQUEST_MB = parseInt(process.env.MAX_REQUEST_MB || '200', 10);
const MAX_TOTAL_GB = parseFloat(process.env.MAX_TOTAL_GB || '3'); // total por evento
// Tope global de todos los eventos. Opcional: sin definir (o 'auto'), el límite
// se calcula del espacio libre real del disco; con cifra, actúa como techo fijo.
const MAX_GLOBAL_GB = parseFloat(process.env.MAX_GLOBAL_GB); // NaN = automático
const DISK_RESERVE_GB = parseFloat(process.env.DISK_RESERVE_GB || '2'); // franja del disco que las fotos nunca ocupan
const IMAGE_MAX_SIDE = parseInt(process.env.IMAGE_MAX_SIDE || '2560', 10); // lado mayor tras comprimir
const IMAGE_QUALITY = parseInt(process.env.IMAGE_QUALITY || '82', 10); // calidad JPEG
const THUMB_SIZE = 480; // miniaturas de la galería
// Techo de píxeles que sharp acepta al abrir una imagen subida. Frena las
// "bombas de descompresión" (archivos pequeños que declaran dimensiones
// gigantes y disparan la memoria al decodificar). 128 MP cubre cualquier
// sensor de móvil actual y queda muy por debajo del default de sharp (~268 MP).
const MAX_IMAGE_PIXELS = 128 * 1e6;

fs.mkdirSync(DATA_DIR, { recursive: true });

if (IS_HTTPS) app.set('trust proxy', 1); // necesario para que la cookie "secure" funcione tras un proxy HTTPS

app.use(
  helmet({
    // HSTS explícito para no depender del default de helmet: 2 años y
    // subdominios incluidos cuando el sitio va por HTTPS. En despliegues solo
    // HTTP (local) se desactiva: los navegadores lo ignorarían igualmente,
    // pero así no se envía una cabecera que no aplica.
    strictTransportSecurity: IS_HTTPS ? { maxAge: 63072000, includeSubDomains: true } : false,
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
// Freno del webhook: la firma ya corta el abuso real, pero sin límite un
// flujo de peticiones con firma falsa gastaría CPU en constructEvent. Holgado
// de sobra para Stripe (un evento por compra más algún reintento).
const webhookLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones' },
});

// Webhook de Stripe: la firma se verifica sobre el cuerpo en crudo, así que la
// ruta se registra ANTES de express.json() (que lo consumiría). Aquí llega la
// confirmación real del pago —la vuelta del navegador a la landing es solo
// cosmética— y de aquí sale el código de invitación hacia el email del
// comprador. checkout.session.completed cubre el pago con tarjeta;
// async_payment_succeeded, los métodos que confirman más tarde.
app.post('/api/stripe/webhook', webhookLimiter, express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
  if (!STRIPE_ENABLED) return res.status(404).json({ error: 'No encontrado' });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch {
    return res.status(400).json({ error: 'Firma no válida' });
  }
  const isPaymentEvent =
    event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded';
  if (isPaymentEvent && event.data.object.payment_status === 'paid') {
    try {
      await fulfillPurchase(event.data.object);
    } catch (err) {
      // Con un 500, Stripe reintenta el webhook: fulfillPurchase es idempotente
      // y el reintento retoma justo lo que faltó (p.ej. solo el email).
      console.error(`Error atendiendo el pago ${event.data.object.id}:`, err.message);
      return res.status(500).json({ error: 'Error interno' });
    }
  }
  res.json({ received: true });
});

// Límite explícito para no depender del default de Express (100 KB). Los JSON
// de esta API son diminutos (login, ajustes, contacto); 50 KB sobra.
app.use(express.json({ limit: '50kb' }));
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

// Máximo 5 solicitudes de recuperación de contraseña por IP cada hora
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes, prueba de nuevo más tarde' },
});

// Máximo 5 mensajes de contacto por IP cada hora: cada envío acaba en el
// buzón del SuperAdministrador, así que conviene frenar el spam de raíz.
const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados mensajes seguidos, prueba de nuevo más tarde' },
});

// Máximo 10 inicios de compra por IP cada 15 minutos: cada uno crea una sesión
// de pago en Stripe, así que conviene frenar a un script que las genere en masa.
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de compra, prueba de nuevo en unos minutos' },
});

// Máximo 20 descargas ZIP por IP cada 15 minutos: el ZIP empaqueta en directo
// (archiver + disco), así que conviene frenar clics repetidos o abuso.
const zipLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas descargas, prueba de nuevo en unos minutos' },
});

// Tope de subidas por IP. La subida no exige sesión (los invitados suben sin
// registrarse, por diseño) y cada petición cuesta disco + CPU de sharp, así que
// sin freno un script podría inundar el servidor. El límite es holgado a
// propósito: en un evento real muchos invitados comparten la misma IP pública
// (el WiFi del local), y cada petición admite hasta 20 archivos, así que 200
// peticiones cada 10 min dan margen de sobra al uso legítimo mientras cortan un
// flujo automatizado de miles de peticiones.
const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas subidas seguidas, prueba de nuevo en unos minutos' },
});

// Máximo 20 intentos de restablecer contraseña por IP cada 15 minutos. El token
// es de 256 bits (imposible de adivinar), pero el límite evita usar esta ruta
// como martillo de lecturas de disco sin coste para el atacante.
const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos, prueba de nuevo más tarde' },
});

// ---------- Usuarios y eventos ----------
// Cada cuenta tiene su evento: los archivos viven en uploads/<eventId>/ y la
// estructura interna replica la del proyecto original (miniaturas, cachés de
// marca de agua y metadatos en subcarpetas ocultas del propio evento).

const EVENT_ID_RE = /^[a-z0-9]{10}$/;
const USERNAME_RE = /^[a-z0-9._-]{3,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const RESET_TOKEN_MS = 60 * 60 * 1000; // 1 hora de validez del enlace de recuperación

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

// invites.json guarda una lista mixta: los códigos antiguos son una cadena
// suelta y los nuevos un objeto con el plan que conceden ({ code, quotaGB,
// usageDays, source, email, createdAt }). Las cadenas siguen valiendo y se
// registran con los valores por defecto, como siempre.
function inviteCodeOf(entry) {
  return typeof entry === 'string' ? entry : entry.code;
}

function findInvite(invites, code) {
  return invites.find((entry) => inviteCodeOf(entry) === code) || null;
}

// Registro de compras con Stripe, indexado por id de sesión de Checkout: da
// idempotencia a los webhooks (Stripe puede repetirlos) y deja al
// SuperAdministrador el histórico con el código y el email de cada comprador.
function readPurchases() {
  return readJson(PURCHASES_PATH, {});
}

function writePurchases(purchases) {
  writeJson(PURCHASES_PATH, purchases);
}

// eventId del usuario con sesión iniciada (o null).
// La sesión viaja firmada en la cookie, sin estado en el servidor, así que no se
// puede "revocar" una cookie ya emitida. Para poder cerrar sesión en todos los
// dispositivos y expulsar a un atacante tras un cambio de contraseña, cada cuenta
// lleva un `sessionEpoch`: la cookie guarda el epoch con el que se emitió y aquí
// se rechaza si no coincide con el actual. Incrementar el epoch (logout / reset)
// invalida de golpe cualquier cookie anterior. Las cuentas y cookies antiguas sin
// epoch valen 0 en ambos lados, así que un despliegue no desloguea a nadie válido.
function sessionEventId(req) {
  const username = req.session.user;
  if (!username) return null;
  const account = readUsers()[username];
  if (!account) return null;
  if ((req.session.epoch || 0) !== (account.sessionEpoch || 0)) return null;
  return account.eventId || null;
}

function isEventAdmin(req, eventId) {
  return sessionEventId(req) === eventId;
}

// Cuenta dueña de un evento (o null): users.json es pequeño, la búsqueda lineal basta
function accountForEvent(eventId) {
  return Object.values(readUsers()).find((acc) => acc.eventId === eventId) || null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Ventana de uso de una cuenta: empieza a las 00:00 (hora del servidor) del
// día de inicio que fijó el usuario y dura `usageDays` días completos; con los
// 15 por defecto, el día 16 la cuenta caduca y se borra todo.
function eventWindow(account) {
  const startDate = account?.startDate || null;
  if (!startDate || !DATE_RE.test(startDate)) {
    return { startDate: null, expiresAt: null, daysLeft: null, active: false };
  }
  const usageDays = account.usageDays || DEFAULT_USAGE_DAYS;
  const startMs = new Date(`${startDate}T00:00:00`).getTime();
  const expiresAt = startMs + usageDays * DAY_MS;
  const now = Date.now();
  return {
    startDate,
    usageDays,
    expiresAt,
    daysLeft: Math.max(0, Math.ceil((expiresAt - now) / DAY_MS)),
    active: now >= startMs && now < expiresAt,
  };
}

// Cierra el evento a los invitados fuera de la ventana de uso. El dueño con
// sesión puede entrar antes del inicio para prepararlo (ajustes, QR), pero
// nadie —tampoco él— puede usar la galería fuera de sus días.
function requireActiveEvent(req, res, next) {
  if (eventWindow(accountForEvent(req.event.id)).active) return next();
  if (isEventAdmin(req, req.event.id)) return next();
  res.status(403).json({ error: 'La galería no está abierta en este momento' });
}

// Igual que requireActiveEvent pero sin excepción para el dueño: subir fotos
// solo está permitido dentro de los días de uso.
function requireActiveEventStrict(req, res, next) {
  if (eventWindow(accountForEvent(req.event.id)).active) return next();
  res.status(403).json({ error: 'La galería no está abierta en este momento' });
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

// Registrarse no compromete la ventana de uso: el organizador puede explorar
// su portal sin fijar el día de inicio. Solo al "publicar" algo de cara a los
// invitados (código QR, marca de agua, nombre del evento) se le exige fijarlo;
// el frontend reconoce el código START_DATE_REQUIRED y abre el modal de fecha.
function startDateRequired(res) {
  return res
    .status(409)
    .json({ error: 'Antes de continuar, fija el día de inicio de tu evento', code: 'START_DATE_REQUIRED' });
}

function requireStartDate(req, res, next) {
  const account = readUsers()[req.session.user];
  if (account?.startDate) return next();
  startDateRequired(res);
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
    else cb(new Error('Solo se permiten fotos en formatos admitidos'));
  },
});

// ---------- Helpers ----------

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.avif']);

function mediaType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  return 'other';
}

function safeFilePath(ev, name) {
  // El nombre debe ser un archivo suelto de la raíz del evento, nunca una ruta:
  // así se descartan travesías (../) y, sobre todo, los accesos a las subcarpetas
  // ocultas del evento (.data, .thumbs, .wm-*) donde viven metadatos y ajustes.
  // Express decodifica %2f a "/" en los parámetros, por lo que un "basename"
  // distinto del nombre recibido delata un intento de bajar de directorio.
  if (typeof name !== 'string' || name !== path.basename(name) || name.startsWith('.')) return null;
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
  // Escritura atómica: primero a un temporal y luego rename (atómico dentro
  // del mismo sistema de ficheros). Si el proceso muere a media escritura
  // (OOM, docker stop, disco lleno), el JSON definitivo nunca queda truncado;
  // con todo el estado en estos ficheros, un users.json corrupto perdería
  // todas las cuentas.
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
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

// SVG del texto de la marca de agua, con el mismo aspecto en las fotos reales
// y en la vista previa del panel de ajustes.
function watermarkSvg(width, height, text) {
  const fontSize = Math.max(12, Math.round((width || 800) * 0.032));
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <text x="${width - 14}" y="${height - 14}" text-anchor="end" font-family="'Playfair Display', serif"
      font-style="italic" font-size="${fontSize}" fill="white" fill-opacity="0.9"
      style="paint-order: stroke; stroke: rgba(0,0,0,0.5); stroke-width: ${Math.max(1, fontSize * 0.06)}px">${escaped}</text>
  </svg>`;
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
  const image = sharp(sourcePath, { limitInputPixels: MAX_IMAGE_PIXELS });
  const { width, height } = await image.metadata();
  const svg = watermarkSvg(width, height, watermarkText);
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

// Tamaño total (bytes) de un directorio, incluyendo subcarpetas: aparte de las
// fotos, cada evento guarda miniaturas y cachés de marca de agua que también
// ocupan disco y deben contar para la cuota.
function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else if (entry.isFile()) {
      try {
        total += fs.statSync(p).size;
      } catch {
        // el archivo puede desaparecer mientras recorremos; se ignora
      }
    }
  }
  return total;
}

// Espacio ocupado por todos los eventos juntos (bytes)
function totalUploadsSize() {
  let total = 0;
  for (const entry of fs.readdirSync(UPLOAD_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) total += dirSize(path.join(UPLOAD_DIR, entry.name));
  }
  return total;
}

// Límite global en bytes para las fotos: lo ya ocupado más el espacio libre
// real del disco donde vive uploads/, menos una reserva para que el sistema
// (logs, actualizaciones) nunca se quede sin sitio. Se consulta el disco en
// cada uso, así que ampliarlo en el servidor se refleja sin reiniciar. Si
// MAX_GLOBAL_GB está en el .env, actúa además como techo fijo.
function globalLimitBytes(usedBytes) {
  let limit = Infinity;
  try {
    const st = fs.statfsSync(UPLOAD_DIR);
    limit = usedBytes + Math.max(0, st.bavail * st.bsize - DISK_RESERVE_GB * 1024 ** 3);
  } catch {
    // sin statfs en este sistema de archivos: queda el techo del .env
  }
  if (!Number.isNaN(MAX_GLOBAL_GB)) limit = Math.min(limit, MAX_GLOBAL_GB * 1024 ** 3);
  if (!Number.isFinite(limit)) limit = 15 * 1024 ** 3; // último recurso: el tope histórico
  return limit;
}

// Cuota de un evento en GB: la general, salvo que el SuperAdministrador le
// haya concedido más espacio a esa cuenta en concreto.
function eventQuotaGB(eventId) {
  const account = accountForEvent(eventId);
  return account?.quotaGB || MAX_TOTAL_GB;
}

// Rechaza subidas cuando el evento (cuota individual) o el conjunto del servidor
// (disco compartido) ya no tienen sitio. Se suma el Content-Length como cota
// superior de lo que llega para frenar antes de escribir nada en disco; multer
// impone además el límite real por archivo, así que un Content-Length falseado
// no permite saltarse la cuota más allá de una petición.
function checkTotalSpace(req, res, next) {
  const incoming = parseInt(req.headers['content-length'], 10) || 0;

  // Tope duro por petición: sin él, 20 archivos al máximo permitido por multer
  // harían peticiones enormes de forma "legítima". Un Content-Length falseado a
  // la baja rompe el parseo de la propia petición, así que la cota es efectiva.
  if (incoming > MAX_REQUEST_MB * 1024 ** 2) {
    return res.status(413).json({ error: `Subida demasiado grande (máximo ${MAX_REQUEST_MB} MB por envío)` });
  }

  const eventUsed = dirSize(req.event.dir);
  if (eventUsed + incoming > eventQuotaGB(req.event.id) * 1024 ** 3) {
    return res.status(507).json({ error: 'Se ha alcanzado el espacio máximo del evento' });
  }

  const globalUsed = totalUploadsSize();
  if (globalUsed + incoming > globalLimitBytes(globalUsed)) {
    return res.status(507).json({ error: 'El almacenamiento del servidor está lleno por ahora, inténtalo más tarde' });
  }

  next();
}

// Comprime una imagen recién subida y genera su miniatura.
async function processUpload(ev, file) {
  let finalPath = file.path;

  if (file.mimetype.startsWith('image/')) {
    const dst = path.join(ev.dir, path.basename(file.path, path.extname(file.path)) + '.jpg');
    const tmp = dst + '.tmp';
    try {
      await sharp(file.path, { limitInputPixels: MAX_IMAGE_PIXELS })
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
      await sharp(finalPath, { limitInputPixels: MAX_IMAGE_PIXELS })
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

// Cola de procesado en segundo plano: comprimir y generar miniaturas con
// sharp consume CPU; hacerlo dentro de la petición de subida bloquearía el
// event loop cuando varios invitados suben fotos a la vez. Con concurrencia
// limitada, el archivo se guarda tal cual y se sirve así (sin miniatura)
// hasta que le llega su turno; la respuesta al cliente no espera a esto.
const UPLOAD_PROCESS_CONCURRENCY = 2;
let activeUploadJobs = 0;
const uploadQueue = [];

function enqueueUploadProcessing(ev, file) {
  uploadQueue.push({ ev, file });
  pumpUploadQueue();
}

function pumpUploadQueue() {
  while (activeUploadJobs < UPLOAD_PROCESS_CONCURRENCY && uploadQueue.length) {
    const { ev, file } = uploadQueue.shift();
    activeUploadJobs++;
    processUpload(ev, file)
      .then((finalName) => {
        // Si la compresión renombró el archivo (p.ej. .png -> .jpg), la
        // entrada de metadatos (permiso de descarga) debe seguir al nuevo nombre.
        if (finalName === file.filename) return;
        const meta = readMediaMeta(ev);
        if (meta[file.filename]) {
          meta[finalName] = meta[file.filename];
          delete meta[file.filename];
          writeMediaMeta(ev, meta);
        }
      })
      .catch((err) => console.error(`Error procesando "${file.filename}":`, err.message))
      .finally(() => {
        activeUploadJobs--;
        pumpUploadQueue();
      });
  }
}

// ---------- Autenticación y registro ----------

// Hash de una contraseña aleatoria: cuando el usuario no existe se compara
// contra él igualmente, para que la respuesta tarde lo mismo que con un
// usuario real (no filtra por temporización si un nombre existe o no).
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 12);

// Crear cuenta + evento con un código de invitación de un solo uso
app.post('/api/register', registerLimiter, async (req, res) => {
  const { username, password, email, inviteCode } = req.body || {};
  const user = String(username || '').trim().toLowerCase();
  if (!USERNAME_RE.test(user)) {
    return res.status(400).json({ error: 'Nombre de usuario no válido: 3-30 caracteres entre letras minúsculas, números y ". _ -"' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  }
  const userEmail = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(userEmail)) {
    return res.status(400).json({ error: 'Introduce un email válido: lo usaremos si necesitas recuperar tu contraseña' });
  }
  const code = String(inviteCode || '').trim().toUpperCase();

  // Pre-chequeo para no gastar el hash con datos inválidos. No es autoritativo:
  // se vuelve a validar dentro de la sección crítica de abajo.
  if (!findInvite(readInvites(), code)) {
    return res.status(403).json({ error: 'Código de invitación no válido' });
  }
  if (readUsers()[user]) {
    return res.status(409).json({ error: 'Ese nombre de usuario ya existe' });
  }

  // El hash es la única operación asíncrona; se hace ANTES de tocar los
  // ficheros. Así el bloque leer-comprobar-consumir de abajo no tiene ningún
  // `await` entre medias y, en el bucle de eventos de un solo hilo de Node,
  // se ejecuta atómicamente: dos registros concurrentes con el mismo código
  // no pueden intercalarse ni canjearlo dos veces.
  const passwordHash = await bcrypt.hash(password, 12);

  const invites = readInvites();
  const invite = findInvite(invites, code);
  if (!invite) {
    return res.status(403).json({ error: 'Código de invitación no válido' });
  }
  const users = readUsers();
  if (users[user]) {
    return res.status(409).json({ error: 'Ese nombre de usuario ya existe' });
  }

  const eventId = newEventId();
  createEventDirs(eventDirs(eventId));
  // El plan del código (si lo lleva) fija los días de uso y la cuota de la
  // cuenta; los códigos antiguos, sin plan, conservan los valores por defecto.
  const plan = typeof invite === 'string' ? {} : invite;
  users[user] = {
    passwordHash,
    eventId,
    email: userEmail,
    createdAt: Date.now(),
    sessionEpoch: 1,
    startDate: null, // se pedirá desde el portal al aplicar cambios (marca de agua, QR)
    usageDays: plan.usageDays || DEFAULT_USAGE_DAYS,
  };
  if (plan.quotaGB) users[user].quotaGB = plan.quotaGB;
  writeUsers(users);
  writeInvites(invites.filter((entry) => inviteCodeOf(entry) !== code)); // el código se consume
  req.session.user = user;
  req.session.epoch = 1;
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
    req.session.epoch = account.sessionEpoch || 0;
    return res.json({ ok: true, eventId: account.eventId });
  }
  res.status(401).json({ error: 'Credenciales incorrectas' });
});

app.post('/api/logout', (req, res) => {
  // Además de borrar la cookie de este navegador, se sube el epoch de la cuenta
  // para invalidar cualquier otra sesión abierta (o una cookie robada): "cerrar
  // sesión" debe expulsar de verdad, no solo en el dispositivo actual.
  const username = req.session.user;
  if (username) {
    const users = readUsers();
    if (users[username]) {
      users[username].sessionEpoch = (users[username].sessionEpoch || 0) + 1;
      writeUsers(users);
    }
  }
  req.session = null;
  res.json({ ok: true });
});

// Solicitar recuperación de contraseña: responde igual exista o no ese email
// para no filtrar qué correos están registrados.
app.post('/api/forgot-password', forgotPasswordLimiter, async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const genericResponse = { ok: true, message: 'Si ese email tiene una cuenta, te hemos enviado un enlace para restablecer la contraseña' };
  if (!EMAIL_RE.test(email)) return res.json(genericResponse);

  const users = readUsers();
  const entry = Object.entries(users).find(([, acc]) => acc.email === email);
  if (!entry) return res.json(genericResponse);
  const [username, account] = entry;

  const token = crypto.randomBytes(32).toString('hex');
  account.resetTokenHash = crypto.createHash('sha256').update(token).digest('hex');
  account.resetTokenExpires = Date.now() + RESET_TOKEN_MS;
  writeUsers(users);

  const link = `${PUBLIC_URL}/?resetToken=${token}`;
  try {
    await sendMail({
      to: email,
      subject: 'Recupera tu contraseña — Pásame la foto',
      text: `Hola ${username},\n\nPara restablecer tu contraseña, entra en este enlace (caduca en 1 hora):\n${link}\n\nSi no lo has pedido tú, ignora este correo.`,
    });
  } catch (err) {
    console.error('Error enviando el email de recuperación:', err.message);
  }
  res.json(genericResponse);
});

app.post('/api/reset-password', resetPasswordLimiter, async (req, res) => {
  const { token, password } = req.body || {};
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  }
  if (typeof token !== 'string' || !token) {
    return res.status(400).json({ error: 'Enlace no válido o caducado' });
  }
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const users = readUsers();
  const entry = Object.entries(users).find(
    ([, acc]) => acc.resetTokenHash === tokenHash && acc.resetTokenExpires > Date.now()
  );
  if (!entry) return res.status(400).json({ error: 'Enlace no válido o caducado' });
  const [username, account] = entry;

  account.passwordHash = await bcrypt.hash(password, 12);
  delete account.resetTokenHash;
  delete account.resetTokenExpires;
  // Cambiar la contraseña cierra cualquier sesión anterior (p.ej. la del atacante
  // que forzó el reset o una cookie robada); esta petición estrena epoch.
  account.sessionEpoch = (account.sessionEpoch || 0) + 1;
  writeUsers(users);

  req.session.user = username;
  req.session.epoch = account.sessionEpoch;
  res.json({ ok: true, eventId: account.eventId });
});

app.get('/api/me', (req, res) => {
  const username = req.session.user || null;
  const eventId = sessionEventId(req);
  res.json({ user: eventId ? username : null, eventId });
});

// ---------- Contacto (landing) ----------

// Formulario público de la landing: el mensaje llega por email al buzón del
// SuperAdministrador (CONTACT_EMAIL) con reply-to del remitente, para poder
// responder —por ejemplo con un código de invitación— desde el propio correo.
app.post('/api/contact', contactLimiter, async (req, res) => {
  const body = req.body || {};
  // Sin saltos de línea en lo que viaja en cabeceras (asunto): nodemailer ya
  // las sanea, pero mejor que un nombre raro no ensucie el asunto del correo.
  const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const email = String(body.email || '').trim().toLowerCase();
  const message = String(body.message || '').trim().slice(0, 2000);
  const topic = body.topic === 'contratar' ? 'Quiere contratar el servicio' : 'Consulta general';

  if (!name) return res.status(400).json({ error: 'Dinos tu nombre para poder responderte' });
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Introduce un email válido: es donde te responderemos' });
  }
  if (message.length < 10) return res.status(400).json({ error: 'Cuéntanos algo más en el mensaje' });

  try {
    await sendMail({
      to: CONTACT_EMAIL,
      replyTo: email,
      subject: `Contacto web: ${topic} — ${name}`,
      text: `Nombre: ${name}\nEmail: ${email}\nMotivo: ${topic}\n\n${message}`,
    });
  } catch (err) {
    console.error('Error enviando el mensaje de contacto:', err.message);
    return res.status(500).json({ error: 'No se pudo enviar el mensaje, inténtalo de nuevo más tarde' });
  }
  res.json({ ok: true });
});

// ---------- Compra directa (Stripe Checkout) ----------
// El comprador elige plan en la landing y paga en la página de Stripe: el
// servidor solo crea la sesión de pago y, cuando el webhook confirma el cobro,
// genera el código de invitación y lo envía por email. La tarjeta nunca pasa
// por aquí.

// Planes a la venta y si la compra directa está activa (lo consulta la landing
// para decidir si los botones compran o llevan al formulario de contacto)
app.get('/api/plans', (req, res) => {
  res.json({
    enabled: STRIPE_ENABLED,
    plans: Object.entries(PLANS).map(([id, plan]) => ({
      id,
      name: plan.name,
      priceEur: plan.priceCents / 100,
      quotaGB: plan.quotaGB,
      usageDays: plan.usageDays,
    })),
  });
});

// Crea la sesión de pago y devuelve la URL de la página de Stripe. El email no
// se pide aquí: lo recoge la propia página de pago y llega en el webhook.
app.post('/api/checkout', checkoutLimiter, async (req, res) => {
  if (!STRIPE_ENABLED) return res.status(404).json({ error: 'No encontrado' });
  const planKey = String((req.body || {}).plan || '');
  const plan = PLANS[planKey];
  if (!plan) return res.status(400).json({ error: 'Plan no válido' });
  const base = PUBLIC_URL;
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'eur',
            unit_amount: plan.priceCents,
            product_data: {
              name: `Pásame la foto — ${plan.name}`,
              description: `${plan.quotaGB} GB de espacio y ${plan.usageDays} días de galería para tu evento. Recibirás tu código de invitación en tu email.`,
            },
          },
        },
      ],
      metadata: { plan: planKey },
      success_url: `${base}/?compra=exito`,
      cancel_url: `${base}/?compra=cancelada#contratar`,
      locale: 'es',
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Error creando la sesión de pago:', err.message);
    res.status(500).json({ error: 'No se pudo iniciar el pago, inténtalo de nuevo en unos minutos' });
  }
});

// Atiende un pago confirmado (lo llama el webhook): crea el código de
// invitación con el plan comprado, lo apunta en purchases.json y lo envía por
// email. Idempotente por sesión de pago: un webhook repetido no genera códigos
// ni correos duplicados y, si solo falló el email, el reintento de Stripe
// reintenta únicamente el envío (el código ya creado se reutiliza).
// Frena webhooks duplicados que lleguen a la vez. OJO: es un Set en memoria,
// solo protege dentro de este proceso. Con el despliegue actual (un único
// contenedor) basta, pero si algún día se escala a varias réplicas, dos
// webhooks simultáneos en procesos distintos podrían crear dos códigos: hay
// una ventana entre readPurchases() y writePurchases(). Antes de escalar
// horizontalmente, sustituir esto por un candado compartido (BD o similar).
const fulfillingSessions = new Set();

async function fulfillPurchase(session) {
  const planKey = session.metadata?.plan;
  const plan = PLANS[planKey];
  if (!plan) throw new Error(`plan desconocido "${planKey}"`);
  if (fulfillingSessions.has(session.id)) return;
  fulfillingSessions.add(session.id);
  try {
    const purchases = readPurchases();
    let purchase = purchases[session.id];
    if (purchase?.emailedAt) return; // compra ya atendida del todo

    const email = purchase?.email || session.customer_details?.email || '';
    if (!purchase) {
      const code = newInviteCode();
      const invites = readInvites();
      invites.push({
        code,
        quotaGB: plan.quotaGB,
        usageDays: plan.usageDays,
        source: 'stripe',
        email,
        createdAt: Date.now(),
      });
      writeInvites(invites);
      purchase = {
        plan: planKey,
        code,
        email,
        amountTotal: session.amount_total,
        createdAt: Date.now(),
        emailedAt: null,
      };
      purchases[session.id] = purchase;
      writePurchases(purchases);
      console.log(`Compra ${session.id}: ${plan.name} para ${email || 'sin email'}, código ${purchase.code}`);
    }

    // Sin email (no debería pasar: la página de pago lo exige) no hay a quién
    // escribir; el código queda visible en el panel para entregarlo a mano.
    if (!email) {
      console.error(`Compra ${session.id} sin email de comprador: entrega el código ${purchase.code} a mano desde /admin.`);
      return;
    }

    const base = PUBLIC_URL;
    await sendMail({
      to: email,
      replyTo: CONTACT_EMAIL || undefined,
      subject: 'Tu código de invitación — Pásame la foto',
      text: `¡Gracias por tu compra!

Aquí tienes tu código de invitación, de un solo uso:

    ${purchase.code}

Tu ${plan.name} incluye:
- ${plan.quotaGB} GB de espacio para las fotos de tu evento
- ${plan.usageDays} días de galería desde el día de inicio que tú fijes (al terminar, las fotos y la cuenta se borran del servidor)

Para crear tu portal:
1. Entra en ${base}/#acceso
2. Pulsa «¿Tienes un código de invitación? Crea tu portal»
3. Elige tu usuario y contraseña e introduce el código

Los días no empiezan a contar hasta que fijes el día de inicio desde tu portal: puedes crear tu cuenta hoy y dejarlo todo preparado con calma.

Si necesitas ayuda, responde a este correo y te echamos una mano.

¡Que disfrutes tu evento!
— Pásame la foto`,
    });

    // El envío se apunta releyendo el archivo: el sello de "email enviado" no
    // debe perderse aunque otra compra haya escrito entre medias.
    const latest = readPurchases();
    latest[session.id] = { ...purchase, emailedAt: Date.now() };
    writePurchases(latest);
  } finally {
    fulfillingSessions.delete(session.id);
  }
}

// ---------- Página y API pública del evento (invitados) ----------

function closedPage(title, message) {
  return `<!doctype html><html lang="es"><meta charset="utf-8"><title>${title}</title><body style="font-family:sans-serif;text-align:center;padding:3rem"><h1>${title}</h1><p>${message}</p><a href="/">Ir al inicio</a></body></html>`;
}

// La galería: la misma página para invitados y para el admin del evento.
// Fuera de la ventana de uso, los invitados ven una página informativa;
// el dueño puede entrar antes del inicio para preparar el evento.
app.get('/e/:eventId', (req, res) => {
  const { eventId } = req.params;
  if (!EVENT_ID_RE.test(eventId) || !fs.existsSync(path.join(UPLOAD_DIR, eventId))) {
    return res.status(404).send(closedPage('Evento no encontrado', 'Revisa el enlace o el código QR.'));
  }
  const window = eventWindow(accountForEvent(eventId));
  if (!window.active && !isEventAdmin(req, eventId)) {
    const notStarted = !window.startDate || Date.now() < new Date(`${window.startDate}T00:00:00`).getTime();
    return res
      .status(403)
      .send(
        notStarted
          ? closedPage('La galería aún no está abierta', 'El organizador todavía no ha abierto este evento. Vuelve a intentarlo más adelante.')
          : closedPage('El evento ha finalizado', 'Esta galería ya no está disponible.')
      );
  }
  res.sendFile(path.join(__dirname, 'public', 'event.html'));
});

// Nombre del evento (público: el hero de la galería lo muestra a los invitados)
app.get('/api/e/:eventId/info', loadEvent, requireActiveEvent, (req, res) => {
  const { eventName } = readSettings(req.event);
  res.json({ eventName: eventName || '' });
});

// Subir uno o varios archivos (las imágenes se comprimen al recibirlas).
// Solo dentro de la ventana de uso: fuera de ella nadie sube, tampoco el dueño.
app.post('/api/e/:eventId/upload', uploadLimiter, loadEvent, requireActiveEventStrict, checkTotalSpace, upload.array('files', 20), async (req, res, next) => {
  try {
    const downloadable = req.body.downloadable === 'all' ? 'all' : 'admin';
    const meta = readMediaMeta(req.event);
    for (const f of req.files) meta[f.filename] = { downloadable };
    writeMediaMeta(req.event, meta);
    res.json({ ok: true, count: req.files.length });
    // La compresión y las miniaturas se generan después de responder: no
    // bloquean al invitado que está subiendo ni a otros subiendo a la vez.
    for (const f of req.files) enqueueUploadProcessing(req.event, f);
  } catch (err) {
    next(err);
  }
});

// Listar los archivos subidos
app.get('/api/e/:eventId/media', loadEvent, requireActiveEvent, (req, res) => {
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
app.get('/e/:eventId/thumbs/:name', loadEvent, requireActiveEvent, async (req, res) => {
  const name = req.params.name;
  if (name !== path.basename(name) || name.startsWith('.')) return res.status(404).end();
  const resolved = path.resolve(req.event.thumbs, name);
  if (!resolved.startsWith(req.event.thumbs + path.sep) || !fs.existsSync(resolved)) return res.status(404).end();
  await sendMaybeWatermarked(req, res, req.event, resolved, req.event.wmThumbs);
});

// Servir un archivo SOLO para visualización (inline, no como descarga;
// con marca de agua para invitados si está configurada)
app.get('/e/:eventId/media/:name', loadEvent, requireActiveEvent, async (req, res) => {
  const filePath = safeFilePath(req.event, req.params.name);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).end();
  await sendMaybeWatermarked(req, res, req.event, filePath, req.event.wmDisplay);
});

// Descargar un archivo si está permitido para todos (o si es el admin del evento); siempre sin marca de agua
app.get('/api/e/:eventId/download/:name', loadEvent, requireActiveEvent, (req, res) => {
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

// Descargar varias fotos en un ZIP (?files=a.jpg,b.jpg), o toda la galería (?all=1)
app.get('/api/e/:eventId/admin/zip', zipLimiter, loadEvent, requireEventAdmin, (req, res) => {
  const ev = req.event;
  const names =
    req.query.all === '1'
      ? fs.readdirSync(ev.dir).filter((f) => mediaType(f) !== 'other')
      : String(req.query.files || '').split(',').filter(Boolean);
  const files = names.map((n) => safeFilePath(ev, n)).filter((p) => p && fs.existsSync(p));
  if (!files.length) return res.status(400).json({ error: 'Sin archivos válidos' });
  res.attachment('pasame-la-foto.zip');
  const zip = archiver('zip', { zlib: { level: 1 } }); // las fotos ya vienen comprimidas
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

// Espacio ocupado por el evento frente a su cuota, para avisar al organizador
// antes de que las subidas empiecen a rechazarse.
app.get('/api/e/:eventId/admin/storage', loadEvent, requireEventAdmin, (req, res) => {
  const usedBytes = dirSize(req.event.dir);
  const maxBytes = eventQuotaGB(req.event.id) * 1024 ** 3;
  res.json({ usedBytes, maxBytes, pct: Math.min(1, usedBytes / maxBytes) });
});

// ---------- Ajustes del evento (nombre, fecha para la expiración, marca de agua) ----------

app.get('/api/e/:eventId/admin/settings', loadEvent, requireEventAdmin, (req, res) => {
  const account = readUsers()[req.session.user];
  const window = eventWindow(account);
  res.json({
    ...readSettings(req.event),
    email: account?.email || '',
    startDate: window.startDate,
    usageDays: account?.usageDays || DEFAULT_USAGE_DAYS,
    expiresAt: window.expiresAt,
    daysLeft: window.daysLeft,
    active: window.active,
  });
});

// Fijar el día de inicio de la ventana de uso. Solo una vez: a partir de ahí
// únicamente el SuperAdministrador puede cambiarlo o dar más días.
app.post('/api/e/:eventId/admin/start-date', loadEvent, requireEventAdmin, (req, res) => {
  const startDate = String((req.body || {}).startDate || '');
  if (!DATE_RE.test(startDate) || Number.isNaN(new Date(`${startDate}T00:00:00`).getTime())) {
    return res.status(400).json({ error: 'Fecha de inicio no válida' });
  }
  const todayStart = new Date(new Date().toDateString()).getTime();
  if (new Date(`${startDate}T00:00:00`).getTime() < todayStart) {
    return res.status(400).json({ error: 'La fecha de inicio no puede ser anterior a hoy' });
  }
  const users = readUsers();
  const account = users[req.session.user];
  if (!account) return res.status(401).json({ error: 'No autorizado' });
  if (account.startDate) {
    return res.status(409).json({ error: 'El día de inicio ya está fijado y no se puede cambiar' });
  }
  account.startDate = startDate;
  writeUsers(users);
  res.json({ ok: true, ...eventWindow(account) });
});

app.post('/api/e/:eventId/admin/settings', loadEvent, requireEventAdmin, (req, res) => {
  const { eventDate, watermarkText, eventName, email } = req.body || {};
  if (eventDate && Number.isNaN(new Date(eventDate).getTime())) {
    return res.status(400).json({ error: 'Fecha de evento no válida' });
  }
  const userEmail = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(userEmail)) {
    return res.status(400).json({ error: 'Introduce un email válido para la recuperación de contraseña' });
  }
  const settings = readSettings(req.event);
  const newWatermark = String(watermarkText || '').slice(0, 80);
  const newName = String(eventName || '').slice(0, 60);
  // Cambiar lo que ven los invitados (nombre, marca de agua) exige tener fijado
  // el día de inicio; actualizar solo el email de recuperación no lo exige.
  const changesEvent = newWatermark !== (settings.watermarkText || '') || newName !== (settings.eventName || '');
  if (changesEvent && !readUsers()[req.session.user]?.startDate) {
    return startDateRequired(res);
  }
  settings.eventDate = eventDate || null;
  settings.watermarkText = newWatermark;
  settings.eventName = newName;
  writeSettings(req.event, settings);

  const users = readUsers();
  if (users[req.session.user]) {
    users[req.session.user].email = userEmail;
    writeUsers(users);
  }
  res.json({ ok: true });
});

// ---------- Vista previa de la marca de agua ----------
// Imagen "borrador" para que el organizador vea cómo quedará la marca de agua
// antes de guardarla: una escena neutra generada con sharp (no hay que
// empaquetar ninguna foto) sobre la que se estampa el mismo SVG que se aplica
// a las fotos reales. No exige día de inicio: es justo lo que ayuda a decidir.

const PREVIEW_W = 900;
const PREVIEW_H = 600;
let previewBasePromise = null;

function previewBase() {
  if (!previewBasePromise) {
    const scene = `<svg width="${PREVIEW_W}" height="${PREVIEW_H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#f7e8d3"/>
          <stop offset="0.55" stop-color="#f0cda2"/>
          <stop offset="1" stop-color="#e6b686"/>
        </linearGradient>
      </defs>
      <rect width="${PREVIEW_W}" height="${PREVIEW_H}" fill="url(#sky)"/>
      <circle cx="450" cy="330" r="95" fill="#faf3e6" fill-opacity="0.9"/>
      <ellipse cx="210" cy="530" rx="430" ry="160" fill="#caa06e" fill-opacity="0.75"/>
      <ellipse cx="730" cy="575" rx="470" ry="175" fill="#b3854f" fill-opacity="0.85"/>
    </svg>`;
    previewBasePromise = sharp(Buffer.from(scene)).jpeg({ quality: 85 }).toBuffer();
  }
  return previewBasePromise;
}

app.get('/api/e/:eventId/admin/wm-preview', loadEvent, requireEventAdmin, async (req, res, next) => {
  try {
    const text = String(req.query.text || '').slice(0, 80);
    let image = sharp(await previewBase());
    if (text) {
      image = image.composite([{ input: Buffer.from(watermarkSvg(PREVIEW_W, PREVIEW_H, text)) }]);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.type('jpeg').send(await image.jpeg({ quality: 85 }).toBuffer());
  } catch (err) {
    next(err);
  }
});

// ---------- Código QR del evento ----------

// PNG con el QR que apunta a la galería del evento (la base se configura con
// PUBLIC_URL). Exige el día de inicio: el QR es lo que se imprime y reparte,
// y sin ventana de uso llevaría a una galería que nunca abre.
app.get('/e/:eventId/qr', loadEvent, requireEventAdmin, requireStartDate, async (req, res) => {
  const png = await QRCode.toBuffer(`${PUBLIC_URL}/e/${req.event.id}`, { width: 600, margin: 2 });
  res.type('png').send(png);
});

// ---------- SuperAdministrador ----------
// Panel en /admin con credenciales del .env (SUPERADMIN_USER / SUPERADMIN_PASSWORD).
// Desde él se generan los códigos de invitación, se ven las cuentas activas y
// se gestionan: más días de uso, más espacio, eliminar, reprogramar el inicio.

// Comparación de tiempo constante: se comparan los hashes (longitud fija) para
// no filtrar por temporización ni la longitud ni el contenido de la credencial.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requireSuperadmin(req, res, next) {
  if (!SUPERADMIN_ENABLED) return res.status(404).json({ error: 'No encontrado' });
  if (req.session.superadmin) return next();
  res.status(401).json({ error: 'No autorizado' });
}

app.get('/admin', (req, res) => {
  if (!SUPERADMIN_ENABLED) return res.status(404).send(closedPage('No encontrado', 'Esta página no existe.'));
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.post('/api/sa/login', loginLimiter, (req, res) => {
  if (!SUPERADMIN_ENABLED) return res.status(404).json({ error: 'No encontrado' });
  const { username, password } = req.body || {};
  const userOk = safeEqual(username || '', SUPERADMIN_USER);
  const passOk = safeEqual(password || '', SUPERADMIN_PASSWORD);
  if (!userOk || !passOk) return res.status(401).json({ error: 'Credenciales incorrectas' });
  req.session.superadmin = true;
  res.json({ ok: true });
});

app.post('/api/sa/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/sa/me', (req, res) => {
  if (!SUPERADMIN_ENABLED) return res.status(404).json({ error: 'No encontrado' });
  res.json({ superadmin: !!req.session.superadmin });
});

// Almacenamiento global del servidor: total (disco real menos la reserva,
// con MAX_GLOBAL_GB como techo si está definido), ocupado y libre
app.get('/api/sa/storage', requireSuperadmin, (req, res) => {
  const usedBytes = totalUploadsSize();
  const totalBytes = globalLimitBytes(usedBytes);
  res.json({
    totalBytes,
    usedBytes,
    freeBytes: Math.max(0, totalBytes - usedBytes),
    pct: totalBytes > 0 ? Math.min(1, usedBytes / totalBytes) : 1,
  });
});

// Cuentas registradas, con su ventana de uso y el espacio que ocupan
app.get('/api/sa/users', requireSuperadmin, (req, res) => {
  const users = readUsers();
  const list = Object.entries(users).map(([username, account]) => {
    const ev = eventDirs(account.eventId);
    const window = eventWindow(account);
    return {
      username,
      email: account.email || '',
      eventId: account.eventId,
      createdAt: account.createdAt || null,
      startDate: window.startDate,
      usageDays: account.usageDays || DEFAULT_USAGE_DAYS,
      daysLeft: window.daysLeft,
      expiresAt: window.expiresAt,
      active: window.active,
      usedBytes: fs.existsSync(ev.dir) ? dirSize(ev.dir) : 0,
      quotaGB: eventQuotaGB(account.eventId),
    };
  });
  res.json(list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
});

// Gestionar una cuenta: más días de uso, más espacio o reprogramar el inicio
app.patch('/api/sa/users/:username', requireSuperadmin, (req, res) => {
  const users = readUsers();
  const account = users[req.params.username];
  if (!account) return res.status(404).json({ error: 'Usuario no encontrado' });
  const { usageDays, quotaGB, startDate, force } = req.body || {};

  if (usageDays !== undefined) {
    const days = parseInt(usageDays, 10);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return res.status(400).json({ error: 'Los días de uso deben estar entre 1 y 365' });
    }
    account.usageDays = days;
    delete account.expiryWarned; // con más días, el aviso de caducidad vuelve a proceder
  }
  if (quotaGB !== undefined) {
    const gb = parseFloat(quotaGB);
    if (!Number.isFinite(gb) || gb <= 0 || gb > 1000) {
      return res.status(400).json({ error: 'La cuota debe ser un número de GB válido' });
    }
    account.quotaGB = gb;
  }
  if (startDate !== undefined) {
    if (startDate === null || startDate === '') {
      account.startDate = null; // el usuario volverá a ver el modal de día de inicio
      delete account.expiryWarned;
    } else if (DATE_RE.test(String(startDate))) {
      const todayStart = new Date(new Date().toDateString()).getTime();
      if (new Date(`${startDate}T00:00:00`).getTime() < todayStart) {
        return res.status(400).json({ error: 'La fecha de inicio no puede ser anterior a hoy' });
      }
      account.startDate = String(startDate);
      delete account.expiryWarned;
    } else {
      return res.status(400).json({ error: 'Fecha de inicio no válida' });
    }
  }

  // Cambiar la fecha de inicio o los días de uso puede dejar la ventana ya
  // vencida (p.ej. bajar los días por debajo de los ya transcurridos): la
  // barrida horaria borraría el evento y TODAS sus fotos, sin papelera ni
  // vuelta atrás. No se hace en silencio: se exige confirmación explícita
  // (force) desde el panel. Solo se comprueba si el propio cambio toca las
  // fechas, para no bloquear una edición de cuota inofensiva.
  const datesChanged = startDate !== undefined || usageDays !== undefined;
  const result = eventWindow(account);
  if (datesChanged && result.startDate && result.expiresAt <= Date.now() && force !== true) {
    return res.status(409).json({
      error: 'Con estos ajustes el evento quedaría caducado y se borrarían todas sus fotos en la próxima limpieza. Confírmalo para continuar.',
      code: 'WOULD_EXPIRE',
    });
  }

  writeUsers(users);
  res.json({ ok: true, ...eventWindow(account), usageDays: account.usageDays, quotaGB: eventQuotaGB(account.eventId) });
});

// Eliminar una cuenta y todo su evento (libera el espacio al momento)
app.delete('/api/sa/users/:username', requireSuperadmin, (req, res) => {
  const users = readUsers();
  if (!users[req.params.username]) return res.status(404).json({ error: 'Usuario no encontrado' });
  removeAccount(users, req.params.username);
  writeUsers(users);
  res.json({ ok: true });
});

// Códigos de invitación sin usar, con el plan que concede cada uno (los
// antiguos, guardados como cadena suelta, se muestran con los valores por
// defecto, que es lo que aplicará el registro al canjearlos)
app.get('/api/sa/invites', requireSuperadmin, (req, res) => {
  res.json(
    readInvites().map((entry) => {
      const inv = typeof entry === 'string' ? { code: entry } : entry;
      return {
        code: inv.code,
        quotaGB: inv.quotaGB || MAX_TOTAL_GB,
        usageDays: inv.usageDays || DEFAULT_USAGE_DAYS,
        source: inv.source || 'manual',
        email: inv.email || null,
        createdAt: inv.createdAt || null,
      };
    })
  );
});

// Generar un código nuevo (mismo formato que scripts/invitacion.js)
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin caracteres que se confunden (I/1, O/0)

function newInviteCode() {
  const block = (n) => Array.from({ length: n }, () => INVITE_ALPHABET[crypto.randomInt(INVITE_ALPHABET.length)]).join('');
  return `${block(4)}-${block(4)}`;
}

app.post('/api/sa/invites', requireSuperadmin, (req, res) => {
  const planKey = String((req.body || {}).plan || 'basico');
  const plan = PLANS[planKey];
  if (!plan) return res.status(400).json({ error: 'Plan no válido' });
  const invites = readInvites();
  const code = newInviteCode();
  invites.push({ code, quotaGB: plan.quotaGB, usageDays: plan.usageDays, source: 'manual', createdAt: Date.now() });
  writeInvites(invites);
  res.json({ ok: true, code });
});

// Revocar un código sin usar
app.delete('/api/sa/invites/:code', requireSuperadmin, (req, res) => {
  const invites = readInvites();
  const code = String(req.params.code || '').toUpperCase();
  if (!findInvite(invites, code)) return res.status(404).json({ error: 'Código no encontrado' });
  writeInvites(invites.filter((entry) => inviteCodeOf(entry) !== code));
  res.json({ ok: true });
});

// Histórico de compras con Stripe: qué se compró, quién, el código que se
// generó y si ya se canjeó (deja de estar entre los códigos sin usar). Si el
// email de entrega falló, aparece pendiente para poder entregarlo a mano.
app.get('/api/sa/purchases', requireSuperadmin, (req, res) => {
  const unusedCodes = new Set(readInvites().map(inviteCodeOf));
  const list = Object.entries(readPurchases()).map(([sessionId, p]) => ({
    sessionId,
    plan: PLANS[p.plan]?.name || p.plan,
    code: p.code,
    email: p.email || null,
    amountTotal: p.amountTotal,
    createdAt: p.createdAt,
    emailedAt: p.emailedAt || null,
    redeemed: !unusedCodes.has(p.code),
  }));
  res.json(list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
});

// ---------- Expiración automática de las cuentas ----------
// Al acabar la ventana de uso (por defecto 15 días desde el día de inicio) se
// borra la carpeta completa del evento y la propia cuenta: el espacio queda
// libre y el código de invitación ya se consumió al registrarse. Dos días
// antes se avisa por email para que el organizador descargue sus fotos.

const EXPIRY_WARNING_DAYS = 2;

// Borra la carpeta del evento y la cuenta. `users` se muta; quien llama escribe.
function removeAccount(users, username) {
  const account = users[username];
  if (!account) return;
  const ev = eventDirs(account.eventId);
  fs.rmSync(ev.dir, { recursive: true, force: true });
  delete users[username];
}

function checkExpiration() {
  const users = readUsers();
  let dirty = false;
  for (const [username, account] of Object.entries(users)) {
    const window = eventWindow(account);
    if (!window.startDate) continue;

    if (Date.now() >= window.expiresAt) {
      removeAccount(users, username);
      dirty = true;
      console.log(`Cuenta "${username}" caducada: evento ${account.eventId} y cuenta eliminados.`);
      continue;
    }

    if (window.daysLeft <= EXPIRY_WARNING_DAYS && !account.expiryWarned && account.email) {
      account.expiryWarned = true; // se marca antes de enviar para no reintentar en bucle cada hora
      dirty = true;
      const expiryDate = new Date(window.expiresAt).toLocaleDateString('es-ES');
      const galleryLink = `${PUBLIC_URL}/e/${account.eventId}`;
      sendMail({
        to: account.email,
        subject: 'Tu galería caduca pronto — Pásame la foto',
        text: `Hola ${username},\n\nTu galería de Pásame la foto caducará el ${expiryDate}. Ese día se eliminarán definitivamente todas las fotos y tu cuenta.\n\nEntra y descarga el ZIP con todas tus fotos antes de esa fecha:\n${galleryLink}\n\n¡Gracias por usar Pásame la foto!`,
      }).catch((err) => console.error(`Error enviando el aviso de caducidad a "${username}":`, err.message));
    }
  }
  if (dirty) writeUsers(users);
}

checkExpiration();
setInterval(checkExpiration, 60 * 60 * 1000);

// ---------- Manejo de errores ----------

app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `Archivo demasiado grande (máximo ${MAX_FILE_MB} MB)` });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Petición demasiado grande' });
  }
  console.error(err.message);
  res.status(err.status || 400).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`Pásame la foto escuchando en http://localhost:${PORT}`);
});
