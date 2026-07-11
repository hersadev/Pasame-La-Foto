// Genera un código de invitación de un solo uso y lo deja en
// uploads/.data/invites.json (el registro lo consume al usarse).
// Uso:  npm run invitacion
// Con Docker:  docker compose exec pasame-la-foto npm run invitacion

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'uploads', '.data');
const INVITES_PATH = path.join(DATA_DIR, 'invites.json');

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
invites.push(code);
fs.writeFileSync(INVITES_PATH, JSON.stringify(invites, null, 2));

console.log(`Código de invitación creado: ${code}`);
console.log(`Códigos sin usar: ${invites.length}`);
