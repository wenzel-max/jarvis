'use strict';
// Atualização automática pelo GitHub Releases (electron-updater). Só roda no app instalado (empacotado).
// O repositório precisa ser público para o app baixar as versões sem chave; sendo privado, a checagem
// falha com 404 e isso só vai para o diagnóstico, sem incomodar.

const CHECK_EVERY_MS = 6 * 3600e3;

function create({ isPackaged, settings, log = () => {}, load = () => require('electron-updater').autoUpdater, setTimer = setInterval }) {
  let updater = null;
  let timer = null;

  async function check() {
    if (!isPackaged || !settings().autoUpdate) return 'desligado';
    try {
      updater ??= load();
      updater.autoDownload = true;
      updater.autoInstallOnAppQuit = true;
      updater.logger = null;
      if (!updater.__jarvisWired) {
        updater.__jarvisWired = true;
        updater.on('update-not-available', (i) => log('app', `atualização: nenhuma versão nova (a mais recente é a ${i?.version ?? 'atual'})`));
        updater.on('update-available', (i) => log('app', `atualização ${i?.version ?? ''} encontrada, baixando`));
        updater.on('update-downloaded', (i) => log('app', `atualização ${i?.version ?? ''} baixada: instala ao fechar o Jarvis`));
        updater.on('error', (e) => log('app', `atualização: ${String(e?.message ?? e).split('\n')[0].slice(0, 160)}`));
      }
      log('app', 'atualização: procurando versão nova');
      await updater.checkForUpdates();
      return 'ok';
    } catch (e) {
      log('app', `atualização: ${String(e?.message ?? e).split('\n')[0].slice(0, 160)}`);
      return 'erro';
    }
  }

  function start(firstDelayMs = 90000) {
    const first = setTimeout(check, firstDelayMs);
    first.unref?.();
    timer = setTimer(check, CHECK_EVERY_MS);
    timer.unref?.();
  }

  return { check, start, stop: () => { clearInterval(timer); } };
}

module.exports = { create };
