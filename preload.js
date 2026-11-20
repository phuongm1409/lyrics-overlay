const { contextBridge, ipcRenderer } = require('electron');

const events = new Set(['locked', 'track', 'progress', 'status', 'settings', 'notice', 'editor:import', 'google:state']);
const actions = new Set([
  'overlay:lock', 'overlay:hit-areas', 'overlay:drag-start', 'overlay:drag-end', 'overlay:close', 'overlay:upload', 'overlay:menu',
  'editor:open', 'editor:init', 'editor:save', 'editor:clientId', 'editor:connect',
  'google:state', 'google:configure', 'google:sign-in', 'google:sync', 'google:disconnect', 'google:open-folder',
  'settings:get', 'settings:set', 'settings:reset', 'settings:preview'
]);

contextBridge.exposeInMainWorld('api', {
  on(channel, listener) {
    if (events.has(channel)) ipcRenderer.on(channel, (_, value) => listener(value));
  },
  invoke(channel, value) {
    return actions.has(channel) ? ipcRenderer.invoke(channel, value) : Promise.reject(new Error('Unknown action'));
  }
});
