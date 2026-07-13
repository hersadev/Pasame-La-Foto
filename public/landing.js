const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const loginError = document.getElementById('loginError');
const registerError = document.getElementById('registerError');
const toggleAuth = document.getElementById('toggleAuth');

// Con sesión ya iniciada, directo a su galería
(async function init() {
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
