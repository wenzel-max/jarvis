'use strict';
const { contextBridge, ipcRenderer } = require('electron');

let askCounter = 0;

contextBridge.exposeInMainWorld('jarvis', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  listVoices: () => ipcRenderer.invoke('tts:voices'),
  synthesize: (opts) => ipcRenderer.invoke('tts:synthesize', opts),
  getWeather: (lat, lon) => ipcRenderer.invoke('weather:get', lat, lon),
  searchCity: (query) => ipcRenderer.invoke('geo:search', query),
  askAi: async (req, onSentence) => {
    const id = ++askCounter;
    const listener = (_e, m) => { if (m.id === id) onSentence(m.text); };
    ipcRenderer.on('ai:sentence', listener);
    try {
      return await ipcRenderer.invoke('ai:ask', { ...req, id });
    } finally {
      ipcRenderer.removeListener('ai:sentence', listener);
    }
  },
  googleStatus: () => ipcRenderer.invoke('google:status'),
  googleConnect: (creds) => ipcRenderer.invoke('google:connect', creds),
  googleDisconnect: () => ipcRenderer.invoke('google:disconnect'),
  agendaToday: () => ipcRenderer.invoke('agenda:today'),
  spotifyStatus: () => ipcRenderer.invoke('spotify:status'),
  spotifyConnect: (creds) => ipcRenderer.invoke('spotify:connect', creds),
  spotifyDisconnect: () => ipcRenderer.invoke('spotify:disconnect'),
  mediaControl: (action, value) => ipcRenderer.invoke('media:control', { action, value }),
  wakeWindow: () => ipcRenderer.invoke('win:wake'),
  conversationEnded: () => ipcRenderer.invoke('win:conversation-ended'),
  onToggleListen: (cb) => ipcRenderer.on('cmd:toggle-listen', () => cb()),
  appVersion: () => ipcRenderer.invoke('app:version'),
  usageSummary: () => ipcRenderer.invoke('usage:summary'),
  memoryList: () => ipcRenderer.invoke('memory:list'),
  memoryRemove: (id) => ipcRenderer.invoke('memory:remove', id),
  memoryClear: () => ipcRenderer.invoke('memory:clear'),
  onReminder: (cb) => ipcRenderer.on('reminder:fire', (_e, r) => cb(r)),
  log: (kind, text) => ipcRenderer.invoke('log:write', kind, text),
  logTail: () => ipcRenderer.invoke('log:tail'),
  logClear: () => ipcRenderer.invoke('log:clear'),
  logFolder: () => ipcRenderer.invoke('log:folder'),
  transcribe: (audio, mime) => ipcRenderer.invoke('stt:transcribe', { audio, mime }),
  cancelAi: () => ipcRenderer.invoke('ai:cancel'),
  aiKeyStatus: () => ipcRenderer.invoke('ai:key-status'),
  setAiKey: (key, provider) => ipcRenderer.invoke('ai:key-set', key, provider),
  openLink: (url) => ipcRenderer.invoke('shell:open', url),
  setFullscreen: (on) => ipcRenderer.invoke('win:fullscreen', on),
  quit: () => ipcRenderer.invoke('app:quit'),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
});
