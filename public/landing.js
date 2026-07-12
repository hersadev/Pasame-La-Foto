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

toggleAuth.addEventListener('click', () => {
  const showRegister = registerForm.hidden;
  registerForm.hidden = !showRegister;
  loginForm.hidden = showRegister;
  toggleAuth.textContent = showRegister
    ? 'Ya tengo cuenta: iniciar sesión'
    : '¿Tienes un código de invitación? Crea tu portal';
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
