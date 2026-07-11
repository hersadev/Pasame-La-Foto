const state = { items: [], isAdmin: false, viewerIndex: -1, selected: new Set() };

const gallery = document.getElementById('gallery');
const emptyState = document.getElementById('emptyState');
const stats = document.getElementById('stats');
const fileInput = document.getElementById('fileInput');
const progress = document.getElementById('progress');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const toastEl = document.getElementById('toast');

const selectionBar = document.getElementById('selectionBar');
const selectionCount = document.getElementById('selectionCount');

const loginBtn = document.getElementById('loginBtn');
const adminMenuBtn = document.getElementById('adminMenuBtn');
const adminMenu = document.getElementById('adminMenu');
const menuQr = document.getElementById('menuQr');
const menuZipAll = document.getElementById('menuZipAll');
const menuSettings = document.getElementById('menuSettings');
const menuLogout = document.getElementById('menuLogout');
const selectAllTop = document.getElementById('selectAllTop');
const selectAllTopLabel = document.getElementById('selectAllTopLabel');
const loginModal = document.getElementById('loginModal');
const qrModal = document.getElementById('qrModal');
const qrImage = document.getElementById('qrImage');
const loginForm = document.getElementById('loginForm');
const loginError = document.getElementById('loginError');

const settingsModal = document.getElementById('settingsModal');
const settingsForm = document.getElementById('settingsForm');
const eventDateInput = document.getElementById('eventDate');
const watermarkTextInput = document.getElementById('watermarkText');

const uploadPermModal = document.getElementById('uploadPermModal');
const uploadPermOk = document.getElementById('uploadPermOk');
const uploadPermCancel = document.getElementById('uploadPermCancel');

const viewer = document.getElementById('viewer');
const viewerContent = document.getElementById('viewerContent');
const viewerActions = document.getElementById('viewerActions');
const viewerDownload = document.getElementById('viewerDownload');
const viewerDelete = document.getElementById('viewerDelete');

// Disuasión básica contra guardar archivos (no es seguridad real).
// El admin queda exento y puede usar el click derecho con normalidad.
document.addEventListener('contextmenu', (e) => {
  if (!state.isAdmin) e.preventDefault();
});
document.addEventListener('dragstart', (e) => {
  if (!state.isAdmin) e.preventDefault();
});

// ---------- Toast ----------

let toastTimer;
function toast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('toast-error', isError);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 3200);
}

// ---------- Sesión ----------

async function refreshSession() {
  const res = await fetch('/api/me');
  const { isAdmin } = await res.json();
  state.isAdmin = isAdmin;
  document.body.classList.toggle('is-admin', isAdmin);
  loginBtn.hidden = isAdmin;
  adminMenuBtn.hidden = !isAdmin;
  selectAllTop.hidden = !isAdmin;
  if (!isAdmin) state.selected.clear();
  updateSelectionBar();
}

loginBtn.addEventListener('click', () => {
  loginError.textContent = '';
  loginModal.hidden = false;
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: document.getElementById('email').value,
      password: document.getElementById('password').value,
    }),
  });
  if (res.ok) {
    loginModal.hidden = true;
    loginForm.reset();
    await refreshSession();
    await loadGallery(); // re-pide /api/media: las URLs de fotos cambian según el rol
    toast('Sesión de administrador iniciada');
  } else {
    loginError.textContent = 'Credenciales incorrectas';
  }
});

// ---------- Menú de administrador ----------
// Desplegable anclado al botón "más opciones" (no un modal): se abre hacia
// abajo, bajo la barra superior, y se cierra al tocar fuera o con Escape.

adminMenuBtn.addEventListener('click', () => {
  adminMenu.hidden = !adminMenu.hidden;
});

document.addEventListener('click', (e) => {
  if (adminMenu.hidden) return;
  if (adminMenu.contains(e.target) || adminMenuBtn.contains(e.target)) return;
  adminMenu.hidden = true;
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !adminMenu.hidden) adminMenu.hidden = true;
});

menuQr.addEventListener('click', () => {
  adminMenu.hidden = true;
  qrImage.src = '/qr';
  qrModal.hidden = false;
});

menuZipAll.addEventListener('click', () => {
  adminMenu.hidden = true;
  window.location.href = '/api/admin/zip?all=1';
});

menuSettings.addEventListener('click', async () => {
  adminMenu.hidden = true;
  const res = await fetch('/api/admin/settings');
  const settings = await res.json();
  eventDateInput.value = settings.eventDate || '';
  watermarkTextInput.value = settings.watermarkText || '';
  settingsModal.hidden = false;
});

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await fetch('/api/admin/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventDate: eventDateInput.value || null,
      watermarkText: watermarkTextInput.value,
    }),
  });
  if (res.ok) {
    settingsModal.hidden = true;
    toast('Ajustes guardados');
  } else {
    toast('No se pudieron guardar los ajustes', true);
  }
});

menuLogout.addEventListener('click', async () => {
  adminMenu.hidden = true;
  await fetch('/api/logout', { method: 'POST' });
  await refreshSession();
  await loadGallery(); // re-pide /api/media: las URLs de fotos cambian según el rol
  toast('Sesión cerrada');
});

// Cerrar modales tocando el fondo
for (const modal of [loginModal, qrModal, settingsModal]) {
  modal.querySelector('[data-close]').addEventListener('click', () => (modal.hidden = true));
}

// ---------- Modal de confirmación ----------
// Sustituye al confirm() del navegador: devuelve una promesa que se
// resuelve a true (Borrar) o false (Cancelar / fondo / Escape).

const confirmModal = document.getElementById('confirmModal');
const confirmText = document.getElementById('confirmText');

let confirmResolve = null;

function confirmDialog(message) {
  confirmText.textContent = message;
  confirmModal.hidden = false;
  return new Promise((resolve) => (confirmResolve = resolve));
}

function settleConfirm(value) {
  if (!confirmResolve) return;
  confirmModal.hidden = true;
  confirmResolve(value);
  confirmResolve = null;
}

document.getElementById('confirmOk').addEventListener('click', () => settleConfirm(true));
document.getElementById('confirmCancel').addEventListener('click', () => settleConfirm(false));
confirmModal.querySelector('[data-close]').addEventListener('click', () => settleConfirm(false));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !confirmModal.hidden) settleConfirm(false);
});

// ---------- Selección múltiple (admin) ----------
// Con sesión de admin, cada miniatura muestra su círculo de selección.
// La barra de acciones aparece en cuanto hay algo marcado.

function toggleSelected(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  updateSelectionBar();
}

function clearSelection() {
  state.selected.clear();
  updateSelectionBar();
  renderGallery();
}

function updateSelectionBar() {
  const n = state.selected.size;
  selectionCount.textContent = n;
  selectionBar.hidden = n === 0;
  document.body.classList.toggle('selecting', n > 0);
  updateSelectAllTop();
}

function updateSelectAllTop() {
  const allSelected = state.items.length > 0 && state.selected.size === state.items.length;
  selectAllTopLabel.textContent = allSelected ? 'Deseleccionar todo' : 'Seleccionar todo';
  selectAllTop.classList.toggle('active', allSelected);
}

document.getElementById('selCancel').addEventListener('click', clearSelection);

function toggleSelectAll() {
  if (!state.items.length) return toast('No hay nada que seleccionar', true);
  if (state.selected.size === state.items.length) state.selected.clear();
  else state.items.forEach((i) => state.selected.add(i.id));
  updateSelectionBar();
  renderGallery();
}

document.getElementById('selAll').addEventListener('click', toggleSelectAll);
selectAllTop.addEventListener('click', toggleSelectAll);

document.getElementById('selDownload').addEventListener('click', () => {
  if (!state.selected.size) return toast('No hay nada seleccionado', true);
  const files = [...state.selected].map(encodeURIComponent).join(',');
  window.location.href = `/api/admin/zip?files=${files}`;
});

document.getElementById('selDelete').addEventListener('click', async () => {
  const n = state.selected.size;
  if (!n) return toast('No hay nada seleccionado', true);
  if (!(await confirmDialog(`Se borrarán ${n} archivo(s) definitivamente.`))) return;
  const res = await fetch('/api/admin/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [...state.selected] }),
  });
  if (res.ok) {
    const { deleted } = await res.json();
    toast(`${deleted} archivo(s) borrado(s)`);
    state.selected.clear();
    updateSelectionBar();
    loadGallery();
  } else {
    toast('No se pudo borrar', true);
  }
});

// ---------- Compresión de imágenes en el cliente ----------
// Reduce el peso antes de subir; si algo falla se usa el archivo original
// (el servidor vuelve a comprimir de todos modos en processUpload).

const MAX_CLIENT_SIDE = 2000;

async function compressImage(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/heic' || file.type === 'image/heif') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_CLIENT_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1) return file; // ya es lo bastante pequeña
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file; // formato no soportado por el navegador: se sube tal cual
  }
}

// ---------- Subida con progreso ----------

let pendingFiles = null;

fileInput.addEventListener('change', () => {
  if (!fileInput.files.length) return;
  pendingFiles = [...fileInput.files];
  uploadPermModal.querySelector('input[value="all"]').checked = true;
  uploadPermModal.hidden = false;
});

uploadPermCancel.addEventListener('click', () => {
  uploadPermModal.hidden = true;
  pendingFiles = null;
  fileInput.value = '';
});

uploadPermModal.querySelector('[data-close]').addEventListener('click', () => uploadPermCancel.click());

uploadPermOk.addEventListener('click', async () => {
  const downloadable = uploadPermModal.querySelector('input[name="downloadable"]:checked').value;
  const files = pendingFiles;
  uploadPermModal.hidden = true;
  pendingFiles = null;
  if (!files || !files.length) return;

  const total = files.length;
  progress.hidden = false;
  progressBar.style.width = '0%';
  progressText.textContent = 'Comprimiendo…';

  const compressed = await Promise.all(files.map(compressImage));

  const formData = new FormData();
  for (const file of compressed) formData.append('files', file);
  formData.append('downloadable', downloadable);

  progressText.textContent = 'Subiendo…';

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload');
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    progressBar.style.width = pct + '%';
    progressText.textContent = `Subiendo… ${pct}%`;
  };
  xhr.onload = () => {
    progress.hidden = true;
    fileInput.value = '';
    if (xhr.status === 200) {
      toast(total === 1 ? '¡Recuerdo compartido, gracias! 🤍' : `¡${total} recuerdos compartidos, gracias! 🤍`);
      loadGallery();
    } else {
      let msg = 'Error al subir';
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
      toast(msg, true);
    }
  };
  xhr.onerror = () => {
    progress.hidden = true;
    fileInput.value = '';
    toast('Error de conexión al subir', true);
  };
  xhr.send(formData);
});

// ---------- Galería ----------

async function loadGallery() {
  const res = await fetch('/api/media');
  state.items = await res.json();
  renderGallery();
}

function renderGallery() {
  gallery.innerHTML = '';
  const items = state.items;

  emptyState.hidden = items.length > 0;
  updateSelectAllTop();

  const photos = items.filter((i) => i.type === 'image').length;
  const videos = items.length - photos;
  stats.textContent = items.length
    ? [photos && `${photos} foto${photos > 1 ? 's' : ''}`, videos && `${videos} video${videos > 1 ? 's' : ''}`]
        .filter(Boolean)
        .join(' · ')
    : '';

  items.forEach((item, index) => {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.style.animationDelay = `${Math.min(index * 30, 400)}ms`;

    if (item.type === 'image') {
      const img = document.createElement('img');
      img.src = item.thumb || item.url; // miniatura ligera; el original solo en el visor
      img.loading = 'lazy';
      tile.appendChild(img);
    } else {
      // preload=none: con muchos videos la galería no descarga nada hasta abrirlos
      const video = document.createElement('video');
      video.src = item.url;
      video.muted = true;
      video.preload = 'none';
      video.disablePictureInPicture = true;
      tile.appendChild(video);
      tile.insertAdjacentHTML('beforeend', '<span class="play-badge">▶</span>');
    }

    if (state.isAdmin) {
      const actions = document.createElement('div');
      actions.className = 'tile-actions';

      const downloadLink = document.createElement('a');
      downloadLink.className = 'tile-btn';
      downloadLink.href = `/api/admin/download/${encodeURIComponent(item.id)}`;
      downloadLink.title = 'Descargar';
      downloadLink.textContent = '⬇';
      downloadLink.addEventListener('click', (e) => e.stopPropagation());

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'tile-btn';
      deleteBtn.title = 'Borrar';
      deleteBtn.textContent = '🗑';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteItem(item);
      });

      actions.appendChild(downloadLink);
      actions.appendChild(deleteBtn);
      tile.appendChild(actions);

      // Círculo de selección, siempre visible para el admin
      const check = document.createElement('button');
      check.className = 'tile-check';
      check.textContent = '✓';
      check.title = 'Seleccionar';
      check.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSelected(item.id);
        tile.classList.toggle('selected', state.selected.has(item.id));
      });
      tile.appendChild(check);
      tile.classList.toggle('selected', state.selected.has(item.id));
    } else if (item.canDownload) {
      const actions = document.createElement('div');
      actions.className = 'tile-actions';

      const downloadLink = document.createElement('a');
      downloadLink.className = 'tile-btn';
      downloadLink.href = `/api/download/${encodeURIComponent(item.id)}`;
      downloadLink.title = 'Descargar';
      downloadLink.textContent = '⬇';
      downloadLink.addEventListener('click', (e) => e.stopPropagation());

      actions.appendChild(downloadLink);
      tile.appendChild(actions);
    }

    tile.addEventListener('click', () => openViewer(index));
    gallery.appendChild(tile);
  });
}

async function deleteItem(item) {
  if (!(await confirmDialog('Este archivo se borrará definitivamente.'))) return;
  const res = await fetch(`/api/admin/media/${item.id}`, { method: 'DELETE' });
  if (res.ok) {
    toast('Archivo borrado');
    if (!viewer.hidden) closeViewer();
    loadGallery();
  } else {
    toast('No se pudo borrar', true);
  }
}

// ---------- Visor ----------

function openViewer(index) {
  state.viewerIndex = index;
  renderViewer();
  viewer.hidden = false;
  document.body.style.overflow = 'hidden';
}

function renderViewer() {
  const item = state.items[state.viewerIndex];
  if (!item) return closeViewer();

  viewerContent.innerHTML = '';
  if (item.type === 'image') {
    const img = document.createElement('img');
    img.src = item.url;
    viewerContent.appendChild(img);
  } else {
    const video = document.createElement('video');
    video.src = item.url;
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('controlsList', 'nodownload');
    video.disablePictureInPicture = true;
    viewerContent.appendChild(video);
  }

  viewerActions.hidden = !state.isAdmin && !item.canDownload;
  viewerDelete.hidden = !state.isAdmin;
  viewerDownload.href = state.isAdmin ? `/api/admin/download/${item.id}` : `/api/download/${item.id}`;
}

function closeViewer() {
  viewer.hidden = true;
  viewerContent.innerHTML = '';
  document.body.style.overflow = '';
}

function viewerStep(delta) {
  const len = state.items.length;
  if (!len) return closeViewer();
  state.viewerIndex = (state.viewerIndex + delta + len) % len;
  renderViewer();
}

document.getElementById('viewerClose').addEventListener('click', closeViewer);

// Cerrar pinchando fuera de la foto/video (comportamiento de modal)
viewer.addEventListener('click', (e) => {
  if (e.target === viewer || e.target === viewerContent) closeViewer();
});
document.getElementById('viewerPrev').addEventListener('click', () => viewerStep(-1));
document.getElementById('viewerNext').addEventListener('click', () => viewerStep(1));
viewerDelete.addEventListener('click', () => deleteItem(state.items[state.viewerIndex]));

document.addEventListener('keydown', (e) => {
  if (viewer.hidden || !confirmModal.hidden) return;
  if (e.key === 'Escape') closeViewer();
  if (e.key === 'ArrowLeft') viewerStep(-1);
  if (e.key === 'ArrowRight') viewerStep(1);
});

// Deslizar para pasar de foto en el móvil
let touchStartX = null;
viewer.addEventListener('touchstart', (e) => (touchStartX = e.touches[0].clientX), { passive: true });
viewer.addEventListener('touchend', (e) => {
  if (touchStartX === null) return;
  const dx = e.changedTouches[0].clientX - touchStartX;
  touchStartX = null;
  if (Math.abs(dx) > 50) viewerStep(dx < 0 ? 1 : -1);
});

// ---------- Inicio ----------

(async function init() {
  await refreshSession();
  await loadGallery();
})();
