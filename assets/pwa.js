(() => {
  'use strict';
  if (!['http:', 'https:'].includes(location.protocol)) return;

  const help = document.getElementById('pwaHelp');
  const mode = matchMedia('(display-mode: standalone)');
  function showMode() {
    const standalone = mode.matches || navigator.standalone === true;
    document.documentElement.toggleAttribute('data-standalone', standalone);
    document.getElementById('pwaMode').textContent = standalone ? '当前以独立应用模式运行。' : '安装后请从桌面图标打开镜头台。';
    document.getElementById('pwaInstructions').hidden = standalone;
  }
  help.hidden = false;
  showMode();
  mode.addEventListener?.('change', showMode);
  window.addEventListener('pageshow', showMode);

  const status = document.getElementById('pwaOffline');
  if (!isSecureContext || !('serviceWorker' in navigator)) {
    status.textContent = '此环境无法准备离线文件，可继续在线使用。';
    return;
  }
  status.textContent = '正在准备离线文件…';
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(registration => {
    function updateStatus() {
      if (registration.waiting && registration.active) {
        status.textContent = '新版已就绪。保存工作并关闭所有镜头台窗口及标签页，再打开即可更新。';
      } else if (registration.active?.state === 'activated') {
        status.textContent = '离线文件已就绪。可离线使用本地档案，生图需要联网。';
      }
    }
    function observe(worker) {
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'redundant' && !registration.active) {
          status.textContent = '离线文件准备失败，请联网后重新打开。';
        } else {
          updateStatus();
        }
      });
    }
    observe(registration.installing);
    observe(registration.active);
    registration.addEventListener('updatefound', () => observe(registration.installing));
    navigator.serviceWorker.ready.then(updateStatus);
    updateStatus();
  }).catch(() => {
    status.textContent = '离线文件准备失败，请联网后重新打开。';
  });
})();
