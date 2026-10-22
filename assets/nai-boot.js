'use strict';
/* Start only after every classic-script module and UI adapter has been loaded. */

(async () => {
  applyTheme(document.documentElement.dataset.theme || 'studio');
  NaiAdapters.init({ onChange: saveSettings, getPresets: apiPresets });
  renderApiPresets();
  loadSettings();
  updateWordForm();
  switchView('create');
  renderWords();
  renderCharacters();
  try {
    document.documentElement.dataset.stage = 'opening-db';
    await openDB();
    await initVibes();
    await initWorkbenchFeatures();
    document.documentElement.dataset.stage = 'migrating';
    await migrateLegacyData();
    document.documentElement.dataset.stage = 'refreshing';
    await refreshData();
    document.documentElement.dataset.stage = 'ready';
    $('dbState').textContent = '本地配方档案已就绪';
  } catch (error) {
    $('dbState').textContent = '本地档案不可用';
    setStatus('无法打开本地档案', 'err', error.message);
  }
})();
