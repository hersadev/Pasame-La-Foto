// Genera un código de invitación de un solo uso y lo deja en
// uploads/.data/invites.json (el registro lo consume al usarse).
// Uso:  npm run invitacion            -> plan básico (3 GB, 15 días)
//       npm run invitacion -- grande  -> plan grande (5 GB, 25 días)
// Con Docker:  docker compose exec pasame-la-foto npm run invitacion
//
// Misma tabla de planes que server.js (duplicada aquí para que el script siga
// funcionando suelto, sin arrancar el servidor): si cambias un plan, cámbialo
// en los dos sitios.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'uploads', '.data');
const INVITES_PATH = path.join(DATA_DIR, 'invites.json');

const PLANS = {
  basico: { quotaGB: 3, usageDays: 15 },
  grande: { quotaGB: 5, usageDays: 25 },
};

const planKey = (process.argv[2] || 'basico').toLowerCase();
const plan = PLANS[planKey];
if (!plan) {
  console.error(`Plan desconocido "${planKey}". Planes disponibles: ${Object.keys(PLANS).join(', ')}.`);
  process.exit(1);
}

// Sin caracteres que se confunden entre sí (I/1, O/0)
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function block(n) {
  return Array.from({ length: n }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
}

fs.mkdirSync(DATA_DIR, { recursive: true });

let invites = [];
try {
  invites = JSON.parse(fs.readFileSync(INVITES_PATH, 'utf8'));
} catch {
  // sin archivo todavía: se crea con este primer código
}

const code = `${block(4)}-${block(4)}`;
invites.push({ code, quotaGB: plan.quotaGB, usageDays: plan.usageDays, source: 'manual', createdAt: Date.now() });
fs.writeFileSync(INVITES_PATH, JSON.stringify(invites, null, 2));

console.log(`Código de invitación creado (${planKey}, ${plan.quotaGB} GB, ${plan.usageDays} días): ${code}`);
console.log(`Códigos sin usar: ${invites.length}`);
