'use strict';
// Segundo plano: o Jarvis fica na bandeja do Windows ao fechar a janela, continua ouvindo "Jarvis",
// aparece quando é chamado e some de novo depois da conversa. Atalhos globais mostram/escondem e ligam/desligam a escuta.
// As peças do Electron entram por parâmetro, para testar sem Electron.

const SHORTCUTS = { toggleWindow: 'Control+Alt+J', toggleListen: 'Control+Alt+M' };

function create({ Tray, Menu, nativeImage, globalShortcut, iconPath, getWin, send, quit, settings, log = () => {} }) {
  let tray = null;
  let quitting = false;
  let shownByWake = false;

  const win = () => { const w = getWin(); return w && !w.isDestroyed() ? w : null; };
  const enabled = () => !!settings().backgroundMode;

  function show({ byWake = false } = {}) {
    const w = win();
    if (!w) return false;
    shownByWake = byWake && !w.isVisible();   // só esconde sozinho o que ele mesmo mostrou
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
    return true;
  }

  function hide() {
    const w = win();
    if (!w) return;
    shownByWake = false;
    w.hide();
  }

  const toggleWindow = () => { const w = win(); if (!w) return; (w.isVisible() && !w.isMinimized() ? hide : show)(); };
  const toggleListen = () => send('cmd:toggle-listen');

  function buildMenu() {
    return Menu.buildFromTemplate([
      { label: 'Mostrar o Jarvis', click: () => show() },
      { label: 'Ligar ou desligar a escuta', click: toggleListen },
      { type: 'separator' },
      { label: 'Fechar o Jarvis', click: () => { quitting = true; quit(); } },
    ]);
  }

  function start() {
    try {
      tray = new Tray(nativeImage.createFromPath(iconPath));
      tray.setToolTip('Jarvis');
      tray.setContextMenu(buildMenu());
      tray.on('click', toggleWindow);
    } catch (e) {
      log('app', `bandeja indisponível: ${e.message}`);
      tray = null;
    }
    for (const [name, accel] of Object.entries(SHORTCUTS)) {
      try {
        const ok = globalShortcut.register(accel, name === 'toggleWindow' ? toggleWindow : toggleListen);
        if (!ok) log('app', `atalho ${accel} já está em uso por outro programa`);
      } catch (e) {
        log('app', `atalho ${accel} falhou: ${e.message}`);
      }
    }
  }

  function stop() {
    try { globalShortcut.unregisterAll(); } catch { /* saindo */ }
    tray?.destroy?.();
    tray = null;
  }

  /** Ligado ao evento 'close' da janela: com o modo ligado, fechar só esconde. */
  function onClose(event) {
    if (quitting || !enabled() || !tray) return false;
    event.preventDefault();
    hide();
    return true;
  }

  return {
    start, stop, show, hide, toggleWindow, onClose,
    markQuitting: () => { quitting = true; },
    /** O renderer avisa que a conversa acabou: se a janela foi mostrada pelo "Jarvis", esconde de novo. */
    conversationEnded: () => { if (shownByWake && enabled()) hide(); },
    get hasTray() { return !!tray; },
  };
}

module.exports = { create, SHORTCUTS };
