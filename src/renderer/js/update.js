window.updateAPI.onStatus(({ message, detail }) => {
  document.getElementById('update-message').textContent = message;
  document.getElementById('update-detail').textContent = detail || '';
});

window.updateAPI.onProgress(({ percent }) => {
  document.getElementById('progress-bar-fill').style.width = `${percent}%`;
});
