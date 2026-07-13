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

// ---------- Modales (sustituyen a confirm() y prompt() del navegador) ----------
// Cada uno devuelve una promesa: el confirm resuelve a true/false y el
// prompt al texto introducido o null (Cancelar / fondo / Escape).

const confirmModal = document.getElementById('confirmModal');
const confirmText = document.getElementById('confirmText');
const confirmOk = document.getElementById('confirmOk');

let confirmResolve = null;

function confirmDialog(message, okLabel = 'Confirmar') {
  confirmText.textContent = message;
  confirmOk.textContent = okLabel;
  confirmModal.hidden = false;
  return new Promise((resolve) => (confirmResolve = resolve));
}

function settleConfirm(value) {
  if (!confirmResolve) return;
  confirmModal.hidden = true;
  confirmResolve(value);
  confirmResolve = null;
}

confirmOk.addEventListener('click', () => settleConfirm(true));
document.getElementById('confirmCancel').addEventListener('click', () => settleConfirm(false));
confirmModal.querySelector('[data-close]').addEventListener('click', () => settleConfirm(false));

const promptModal = document.getElementById('promptModal');
const promptTitle = document.getElementById('promptTitle');
const promptText = document.getElementById('promptText');
const promptInput = document.getElementById('promptInput');

let promptResolve = null;

function promptDialog({ title, message, value = '', type = 'text', placeholder = '' }) {
  promptTitle.textContent = title;
  promptText.textContent = message;
  promptInput.type = type;
  if (type === 'number') promptInput.step = 'any';
  else promptInput.removeAttribute('step');
  promptInput.placeholder = placeholder;
  promptInput.value = value;
  promptModal.hidden = false;
  promptInput.focus();
  promptInput.select();
  return new Promise((resolve) => (promptResolve = resolve));
}

function settlePrompt(value) {
  if (!promptResolve) return;
  promptModal.hidden = true;
  promptResolve(value);
  promptResolve = null;
}

document.getElementById('promptForm').addEventListener('submit', (e) => {
  e.preventDefault();
  settlePrompt(promptInput.value);
});
document.getElementById('promptCancel').addEventListener('click', () => settlePrompt(null));
promptModal.querySelector('[data-close]').addEventListener('click', () => settlePrompt(null));

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!confirmModal.hidden) settleConfirm(false);
  if (!promptModal.hidden) settlePrompt(null);
});

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
  await Promise.all([loadInvites(), loadStorage(), loadUsers()]);
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
      if (!(await confirmDialog(`¿Revocar el código ${code}? Nadie podrá registrarse con él.`, 'Revocar'))) return;
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

// ---------- Almacenamiento global ----------

const storageChip = document.getElementById('storageChip');
const storageMeter = document.getElementById('storageMeter');
const storageFill = document.getElementById('storageFill');

const STORAGE_WARN_PCT = 0.8;

async function loadStorage() {
  const { totalBytes, usedBytes, freeBytes, pct } = await api('/storage');
  const percent = Math.round(pct * 100);
  const warn = pct >= STORAGE_WARN_PCT;
  storageFill.style.width = `${percent}%`;
  storageMeter.classList.toggle('storage-warn', warn);
  storageMeter.setAttribute('aria-valuenow', percent);
  storageChip.textContent = `${percent}% ocupado`;
  storageChip.className = `chip ${warn ? 'chip-warn' : 'chip-ok'}`;
  document.getElementById('storageUsed').textContent = fmtGB(usedBytes);
  document.getElementById('storageFree').textContent = fmtGB(freeBytes);
  document.getElementById('storageTotal').textContent = fmtGB(totalBytes);
}

// ---------- Usuarios ----------

function fmtGB(bytes) {
  const gb = bytes / 1024 ** 3;
  if (gb >= 0.1) return `${+gb.toFixed(1)} GB`;
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

function detailItem(label, value) {
  const item = document.createElement('div');
  item.className = 'detail-item';
  const dt = document.createElement('span');
  dt.className = 'detail-label';
  dt.textContent = label;
  let dd = value;
  if (!(value instanceof Node)) {
    dd = document.createElement('span');
    dd.textContent = value;
  }
  item.append(dt, dd);
  return item;
}

// Espacio usado de la cuenta con su propia barra (misma rampa que la global)
function spaceDetail(u) {
  const pct = Math.min(100, Math.round((u.usedBytes / (u.quotaGB * 1024 ** 3)) * 100));
  const wrap = document.createElement('div');
  wrap.className = 'detail-space';
  const text = document.createElement('span');
  text.textContent = `${fmtGB(u.usedBytes)} de ${u.quotaGB} GB (${pct}%)`;
  const track = document.createElement('div');
  track.className = `storage-track detail-track${pct >= 80 ? ' storage-warn' : ''}`;
  const fill = document.createElement('div');
  fill.className = 'storage-fill';
  fill.style.width = `${pct}%`;
  track.appendChild(fill);
  wrap.append(text, track);
  return wrap;
}

const openRows = new Set(); // usuarios con el desplegable abierto (sobrevive a las recargas de la lista)

async function loadUsers() {
  const users = await api('/users');
  usersBody.innerHTML = '';
  usersEmpty.hidden = users.length > 0;

  for (const u of users) {
    const tr = document.createElement('tr');
    tr.className = 'user-row';

    const tdUser = document.createElement('td');
    const name = document.createElement('strong');
    name.textContent = u.username;
    tdUser.appendChild(name);

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
    tdDays.textContent = `${u.usageDays} día${u.usageDays === 1 ? '' : 's'}`;

    const tdSpace = document.createElement('td');
    tdSpace.textContent = `${fmtGB(u.usedBytes)} de ${u.quotaGB} GB`;

    const tdToggle = document.createElement('td');
    tdToggle.className = 'cell-toggle';
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'row-toggle';
    toggleBtn.setAttribute('aria-expanded', 'false');
    toggleBtn.setAttribute('aria-label', `Detalles de ${u.username}`);
    toggleBtn.textContent = '▾';
    tdToggle.appendChild(toggleBtn);

    tr.append(tdUser, tdEvent, tdStatus, tdDays, tdSpace, tdToggle);

    // Fila desplegable: datos completos de la cuenta y sus acciones
    const detailsTr = document.createElement('tr');
    detailsTr.className = 'user-details';
    detailsTr.hidden = true;
    const detailsTd = document.createElement('td');
    detailsTd.colSpan = 6;

    const gallery = document.createElement('a');
    gallery.href = `/e/${u.eventId}`;
    gallery.target = '_blank';
    gallery.rel = 'noopener';
    gallery.textContent = u.eventId;

    const info = document.createElement('div');
    info.className = 'details-grid';
    info.append(
      detailItem('Email', u.email || '—'),
      detailItem('Galería del evento', gallery),
      detailItem('Cuenta creada', fmtDay(u.createdAt)),
      detailItem('Día de inicio', u.startDate ? fmtDay(u.startDate) : 'Sin fijar'),
      detailItem('Caduca', u.startDate ? `${fmtDay(u.expiresAt)}${u.active ? ` (quedan ${u.daysLeft} día${u.daysLeft === 1 ? '' : 's'})` : ''}` : '—'),
      detailItem('Días de uso', `${u.usageDays} día${u.usageDays === 1 ? '' : 's'}`),
      detailItem('Espacio', spaceDetail(u))
    );

    const actions = document.createElement('div');
    actions.className = 'cell-actions';
    actions.append(
      actionBtn('Modificar días', 'btn-ghost', async () => {
        const value = await promptDialog({
          title: 'Días de uso',
          message: `Días de uso totales para "${u.username}" (ahora ${u.usageDays}).`,
          value: u.usageDays,
          type: 'number',
        });
        if (value === null) return;
        patchUser(u.username, { usageDays: value }, 'Días de uso actualizados');
      }),
      actionBtn('Modificar espacio', 'btn-ghost', async () => {
        const value = await promptDialog({
          title: 'Cuota de espacio',
          message: `Cuota en GB para "${u.username}" (ahora ${u.quotaGB} GB).`,
          value: u.quotaGB,
          type: 'number',
        });
        if (value === null) return;
        patchUser(u.username, { quotaGB: value }, 'Cuota actualizada');
      }),
      actionBtn('Modificar inicio', 'btn-ghost', async () => {
        const value = await promptDialog({
          title: 'Día de inicio',
          message: `Día de inicio para "${u.username}". Déjalo vacío para que vuelva a elegirlo.`,
          value: u.startDate || '',
          type: 'date',
        });
        if (value === null) return;
        patchUser(u.username, { startDate: value.trim() || null }, 'Día de inicio actualizado');
      }),
      actionBtn('Eliminar cuenta', 'btn-danger', async () => {
        if (!(await confirmDialog(`¿Eliminar la cuenta "${u.username}" y TODAS las fotos de su evento? Esta acción no se puede deshacer.`, 'Eliminar'))) return;
        try {
          await api(`/users/${encodeURIComponent(u.username)}`, { method: 'DELETE' });
          toast('Usuario eliminado');
          loadUsers();
          loadStorage();
        } catch (err) {
          toast(err.message, true);
        }
      })
    );

    const panel = document.createElement('div');
    panel.className = 'details-panel';
    panel.append(info, actions);
    detailsTd.appendChild(panel);
    detailsTr.appendChild(detailsTd);

    const setOpen = (open) => {
      detailsTr.hidden = !open;
      tr.classList.toggle('row-open', open);
      toggleBtn.setAttribute('aria-expanded', String(open));
      if (open) openRows.add(u.username);
      else openRows.delete(u.username);
    };
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a')) return; // el enlace al evento no pliega/despliega
      setOpen(detailsTr.hidden);
    });
    if (openRows.has(u.username)) setOpen(true);

    usersBody.append(tr, detailsTr);
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
