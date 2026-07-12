// Añade un botón de "ver contraseña" (ojo) a todos los campos de contraseña
// de la página. Se envuelve cada input en un contenedor posicionado para que
// el botón quede dentro del propio campo, sin tocar el HTML de los formularios.

const EYE_OPEN =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M12 5c5 0 9.3 3.1 11 7-1.7 3.9-6 7-11 7S2.7 15.9 1 12c1.7-3.9 6-7 11-7zm0 2C8.2 7 4.8 9.1 3.2 12 4.8 14.9 8.2 17 12 17s7.2-2.1 8.8-5C19.2 9.1 15.8 7 12 7zm0 1.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7z"/></svg>';
const EYE_CLOSED =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M3.4 2 2 3.4l3.4 3.4C3.4 8.2 1.9 10 1 12c1.7 3.9 6 7 11 7 2 0 3.8-.5 5.4-1.3l3.2 3.2 1.4-1.4L3.4 2zM12 17c-3.8 0-7.2-2.1-8.8-5 .8-1.5 2-2.8 3.6-3.7l2.2 2.2a3.5 3.5 0 0 0 4.5 4.5l1.7 1.7c-1 .2-2 .3-3.2.3zm9.8-5c-.6 1-1.3 2-2.3 2.8l-1.5-1.4c.7-.6 1.2-1.2 1.6-1.9C18 8.6 15 7 12 7c-.5 0-1 0-1.4.1L8.9 5.4C9.9 5.1 10.9 5 12 5c5 0 9.3 3.1 11 7-.3.7-.7 1.4-1.2 2z"/></svg>';

for (const input of document.querySelectorAll('input[type="password"]')) {
  const wrapper = document.createElement('div');
  wrapper.className = 'pw-field';
  input.parentNode.insertBefore(wrapper, input);
  wrapper.appendChild(input);

  const toggle = document.createElement('button');
  toggle.type = 'button'; // que no envíe el formulario
  toggle.className = 'pw-toggle';
  toggle.innerHTML = EYE_OPEN;
  toggle.setAttribute('aria-label', 'Mostrar contraseña');
  toggle.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.innerHTML = show ? EYE_CLOSED : EYE_OPEN;
    toggle.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
    input.focus();
  });
  wrapper.appendChild(toggle);
}
