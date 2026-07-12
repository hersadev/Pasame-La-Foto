// Panel del SuperAdministrador (/admin): códigos de invitación y gestión de
// usuarios (más días, más espacio, reprogramar inicio, eliminar).

const loginView = document.getElementById('loginView');
const panelView = document.getElementById('panelView');
const saLoginForm = document.getElementById('saLoginForm');
const saLoginError = document.getElementById('saLoginError');
const inviteList = document.getElementById('inviteList');
const inviteEmpty = document.getElementById('inviteEmpty');
const usersBody = document.getElementById('usersBody');
const usersEmpty = document.getElementById('usersEmpty');
const toastEl = document.getElementById('toast');

let toastTimer;
function toast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('toast-error', isError);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 3200);
}

async function api(path, options = {}) {
  const res = await fetch(`/api/sa${path}`, {
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    showLogin();
    throw new Error('Sesión caducada');
  }
  if (!res.ok) throw new Error(data.error || 'Error inesperado');
  return data;
}

function showLogin() {
  loginView.hidden = false;
  panelView.hidden = true;
}

async function showPanel() {
  loginView.hidden = true;
  panelView.hidden = false;
  await Promise.all([loadInvites(), loadUsers()]);
}

// ---------- Códigos de invitación ----------

async function loadInvites() {
  const codes = await api('/invites');
  inviteList.innerHTML = '';
  inviteEmpty.hidden = codes.length > 0;
  for (const code of codes) {
    const li = document.createElement('li');
    li.className = 'invite-row';

    const span = document.createElement('span');
    span.className = 'invite-code';
    span.textContent = code;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn-ghost btn-compact';
    copyBtn.textContent = 'Copiar';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code);
        toast('Código copiado');
      } catch {
        toast('No se pudo copiar', true);
      }
    });

    const revokeBtn = document.createElement('button');
    revokeBtn.className = 'btn-danger btn-compact';
    revokeBtn.textContent = 'Revocar';
    revokeBtn.addEventListener('click', async () => {
      if (!confirm(`¿Revocar el código ${code}? Nadie podrá registrarse con él.`)) return;
      try {
        await api(`/invites/${encodeURIComponent(code)}`, { method: 'DELETE' });
        toast('Código revocado');
        loadInvites();
      } catch (err) {
        toast(err.message, true);
      }
    });

    li.append(span, copyBtn, revokeBtn);
    inviteList.appendChild(li);
  }
}

document.getElementById('genInvite').addEventListener('click', async () => {
  try {
    const { code } = await api('/invites', { method: 'POST', body: {} });
    toast(`Código creado: ${code}`);
    loadInvites();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- Usuarios ----------

function fmtGB(bytes) {
  const gb = bytes / 1024 ** 3;
  if (gb >= 0.1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function fmtDay(value) {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(`${value}T00:00:00`) : new Date(value);
  return date.toLocaleDateString('es-ES');
}

function statusChip(u) {
  if (!u.startDate) return { label: 'Sin fecha de inicio', cls: 'chip-muted' };
  if (u.active) return { label: `Activo — quedan ${u.daysLeft} día${u.daysLeft === 1 ? '' : 's'}`, cls: u.daysLeft <= 3 ? 'chip-warn' : 'chip-ok' };
  if (Date.now() < new Date(`${u.startDate}T00:00:00`).getTime()) {
    return { label: `Empieza el ${fmtDay(u.startDate)}`, cls: 'chip-muted' };
  }
  return { label: 'Caducado (pendiente de borrado)', cls: 'chip-warn' };
}

function actionBtn(label, cls, onClick) {
  const btn = document.createElement('button');
  btn.className = `${cls} btn-compact`;
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

async function patchUser(username, body, okMsg) {
  try {
    await api(`/users/${encodeURIComponent(username)}`, { method: 'PATCH', body });
    toast(okMsg);
    loadUsers();
  } catch (err) {
    toast(err.message, true);
  }
}

async function loadUsers() {
  const users = await api('/users');
  usersBody.innerHTML = '';
  usersEmpty.hidden = users.length > 0;

  for (const u of users) {
    const tr = document.createElement('tr');

    const tdUser = document.createElement('td');
    const name = document.createElement('strong');
    name.textContent = u.username;
    const email = document.createElement('div');
    email.className = 'cell-sub';
    email.textContent = u.email;
    tdUser.append(name, email);

    const tdEvent = document.createElement('td');
    const link = document.createElement('a');
    link.href = `/e/${u.eventId}`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = u.eventId;
    tdEvent.appendChild(link);

    const tdStatus = document.createElement('td');
    const { label, cls } = statusChip(u);
    const chip = document.createElement('span');
    chip.className = `chip ${cls}`;
    chip.textContent = label;
    tdStatus.appendChild(chip);

    const tdDays = document.createElement('td');
    tdDays.textContent = u.startDate
      ? `${fmtDay(u.startDate)} → ${fmtDay(u.expiresAt)} (${u.usageDays} días)`
      : `${u.usageDays} días (sin empezar)`;

    const tdSpace = document.createElement('td');
    tdSpace.textContent = `${fmtGB(u.usedBytes)} de ${u.quotaGB} GB`;

    const tdActions = document.createElement('td');
    tdActions.className = 'cell-actions';
    tdActions.append(
      actionBtn('Días', 'btn-ghost', () => {
        const value = prompt(`Días de uso totales para "${u.username}" (ahora ${u.usageDays}):`, u.usageDays);
        if (value === null) return;
        patchUser(u.username, { usageDays: value }, 'Días de uso actualizados');
      }),
      actionBtn('Espacio', 'btn-ghost', () => {
        const value = prompt(`Cuota en GB para "${u.username}" (ahora ${u.quotaGB} GB):`, u.quotaGB);
        if (value === null) return;
        patchUser(u.username, { quotaGB: value }, 'Cuota actualizada');
      }),
      actionBtn('Inicio', 'btn-ghost', () => {
        const value = prompt(
          `Día de inicio para "${u.username}" (AAAA-MM-DD, vacío para que vuelva a elegirlo):`,
          u.startDate || ''
        );
        if (value === null) return;
        patchUser(u.username, { startDate: value.trim() || null }, 'Día de inicio actualizado');
      }),
      actionBtn('Eliminar', 'btn-danger', async () => {
        if (!confirm(`¿Eliminar la cuenta "${u.username}" y TODAS las fotos de su evento? Esta acción no se puede deshacer.`)) return;
        try {
          await api(`/users/${encodeURIComponent(u.username)}`, { method: 'DELETE' });
          toast('Usuario eliminado');
          loadUsers();
        } catch (err) {
          toast(err.message, true);
        }
      })
    );

    tr.append(tdUser, tdEvent, tdStatus, tdDays, tdSpace, tdActions);
    usersBody.appendChild(tr);
  }
}

document.getElementById('reloadBtn').addEventListener('click', () => showPanel().catch(() => {}));

// ---------- Sesión ----------

saLoginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  saLoginError.textContent = '';
  const res = await fetch('/api/sa/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: document.getElementById('saUser').value,
      password: document.getElementById('saPass').value,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) showPanel().catch((err) => toast(err.message, true));
  else saLoginError.textContent = data.error || 'Credenciales incorrectas';
});

document.getElementById('saLogout').addEventListener('click', async () => {
  await fetch('/api/sa/logout', { method: 'POST' });
  showLogin();
});

(async function init() {
  try {
    const res = await fetch('/api/sa/me');
    const me = await res.json();
    if (me.superadmin) await showPanel();
    else showLogin();
  } catch {
    showLogin();
  }
})();
