const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const loginError = document.getElementById('loginError');
const registerError = document.getElementById('registerError');
const toggleAuth = document.getElementById('toggleAuth');

// Con sesión ya iniciada, directo a su galería. Al volver de la página de
// pago (?compra=…) no se salta: el aviso de la compra importa más.
(async function init() {
  if (new URLSearchParams(location.search).has('compra')) return;
  try {
    const res = await fetch('/api/me');
    const me = await res.json();
    if (me.eventId) location.replace(`/e/${me.eventId}`);
  } catch {
    // sin conexión con la API se queda en el login
  }
})();

function setAuthMode(showRegister) {
  registerForm.hidden = !showRegister;
  loginForm.hidden = showRegister;
  toggleAuth.textContent = showRegister
    ? 'Ya tengo cuenta: iniciar sesión'
    : '¿Tienes un código de invitación? Crea tu portal';
}

toggleAuth.addEventListener('click', () => setAuthMode(registerForm.hidden));

// Enlaces de la landing que preparan una sección antes de saltar a su ancla:
// - data-auth="register": abre el formulario de registro en #acceso
// - data-topic: preselecciona el motivo del formulario de contacto
document.addEventListener('click', (e) => {
  const authLink = e.target.closest('[data-auth="register"]');
  if (authLink) setAuthMode(true);
  const topicLink = e.target.closest('[data-topic]');
  if (topicLink) document.getElementById('ctTopic').value = topicLink.dataset.topic;
});

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  const { ok, data } = await postJson('/api/login', {
    username: document.getElementById('loginUser').value,
    password: document.getElementById('loginPass').value,
  });
  if (ok) location.href = `/e/${data.eventId}`;
  else loginError.textContent = data.error || 'Credenciales incorrectas';
});

registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  registerError.textContent = '';
  const { ok, data } = await postJson('/api/register', {
    username: document.getElementById('regUser').value,
    email: document.getElementById('regEmail').value,
    password: document.getElementById('regPass').value,
    inviteCode: document.getElementById('regCode').value,
  });
  if (ok) location.href = `/e/${data.eventId}`;
  else registerError.textContent = data.error || 'No se pudo crear el portal';
});

// ---------- Compra directa (Stripe) ----------

const purchaseBanner = document.getElementById('purchaseBanner');
const purchaseBannerText = document.getElementById('purchaseBannerText');

function showPurchaseBanner(message, isWarn = false) {
  purchaseBannerText.textContent = message;
  purchaseBanner.classList.toggle('lp-banner-warn', isWarn);
  purchaseBanner.hidden = false;
}

document.getElementById('purchaseBannerClose').addEventListener('click', () => {
  purchaseBanner.hidden = true;
});

// Vuelta de la página de pago de Stripe. El código lo entrega el servidor por
// email cuando Stripe confirma el cobro; aquí solo se avisa. La URL se limpia
// para que recargar o compartirla no repita el aviso.
const compra = new URLSearchParams(location.search).get('compra');
if (compra === 'exito') {
  showPurchaseBanner('¡Pago completado! En un momento recibirás tu código de invitación por email (revisa también el spam). Con él, crea tu portal en la sección «Tu cuenta».');
} else if (compra === 'cancelada') {
  showPurchaseBanner('El pago se canceló y no se te ha cobrado nada. Si tuviste algún problema, escríbenos y te ayudamos.', true);
}
if (compra) history.replaceState(null, '', location.pathname + location.hash);

// Sin Stripe configurado en el servidor, los botones de compra llevan al
// formulario de contacto: la contratación vuelve a ser por email.
let buyEnabled = true;
(async function loadPlans() {
  try {
    const res = await fetch('/api/plans');
    buyEnabled = Boolean((await res.json()).enabled);
  } catch {
    buyEnabled = false;
  }
  if (!buyEnabled) {
    for (const btn of document.querySelectorAll('[data-plan]')) btn.textContent = 'Solicitar por email';
  }
})();

function goToContactToHire() {
  document.getElementById('ctTopic').value = 'contratar';
  location.hash = '#contacto';
}

for (const btn of document.querySelectorAll('[data-plan]')) {
  btn.addEventListener('click', async () => {
    if (!buyEnabled) return goToContactToHire();
    btn.disabled = true;
    try {
      const { ok, data } = await postJson('/api/checkout', { plan: btn.dataset.plan });
      if (ok && data.url) {
        location.href = data.url; // página de pago de Stripe
        return;
      }
      showPurchaseBanner(data.error || 'No se pudo iniciar el pago, inténtalo de nuevo en unos minutos.', true);
    } catch {
      showPurchaseBanner('No se pudo iniciar el pago, inténtalo de nuevo en unos minutos.', true);
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------- Formulario de contacto ----------

const contactForm = document.getElementById('contactForm');
const contactError = document.getElementById('contactError');

contactForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  contactError.textContent = '';
  const submitBtn = contactForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  const email = document.getElementById('ctEmail').value.trim();
  const { ok, data } = await postJson('/api/contact', {
    name: document.getElementById('ctName').value,
    email,
    topic: document.getElementById('ctTopic').value,
    message: document.getElementById('ctMessage').value,
  });
  submitBtn.disabled = false;
  if (ok) {
    document.getElementById('ctSuccessEmail').textContent = email;
    contactForm.hidden = true;
    document.getElementById('contactSuccess').hidden = false;
  } else {
    contactError.textContent = data.error || 'No se pudo enviar el mensaje, inténtalo de nuevo';
  }
});
