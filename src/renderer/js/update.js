window.updateAPI.onStatus(({ message, detail }) => {
  document.getElementById('splash-status').textContent = message;
  document.getElementById('splash-detail').textContent = detail || '';
});

window.updateAPI.onProgress(({ percent }) => {
  document.getElementById('progress-bar-fill').style.width = `${percent}%`;
});
