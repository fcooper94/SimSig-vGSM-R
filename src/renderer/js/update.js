const stepChecking = document.getElementById('step-checking');
const stepInitialising = document.getElementById('step-initialising');
const detailEl = document.getElementById('splash-detail');
const progressContainer = document.getElementById('progress-bar-container');
const progressFill = document.getElementById('progress-bar-fill');

window.updateAPI.onStatus(({ message, detail }) => {
  if (message === 'checking') {
    stepChecking.className = 'splash-step active';
    stepInitialising.className = 'splash-step';
  } else if (message === 'initialising') {
    stepChecking.className = 'splash-step done';
    stepInitialising.className = 'splash-step active';
    progressContainer.classList.remove('visible');
  }

  detailEl.textContent = detail || '';
});

window.updateAPI.onProgress(({ percent }) => {
  progressContainer.classList.add('visible');
  progressFill.style.width = `${percent}%`;
});
