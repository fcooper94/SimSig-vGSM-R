const stepChecking = document.getElementById('step-checking');
const stepDownloading = document.getElementById('step-downloading');
const stepInitialising = document.getElementById('step-initialising');
const detailEl = document.getElementById('splash-detail');
const progressContainer = document.getElementById('progress-bar-container');
const progressFill = document.getElementById('progress-bar-fill');

function setStep(active) {
  stepChecking.className = 'splash-step' + (active === 'checking' ? ' active' : (active === 'downloading' || active === 'installing' || active === 'initialising') ? ' done' : '');
  stepDownloading.className = 'splash-step' + (active === 'downloading' || active === 'installing' ? ' active' : active === 'initialising' ? ' done' : '');
  stepInitialising.className = 'splash-step' + (active === 'initialising' ? ' active' : '');
}

window.updateAPI.onStatus(({ message, detail }) => {
  setStep(message);

  if (message === 'downloading') {
    const dlSpan = stepDownloading.querySelector('span');
    if (detail) dlSpan.textContent = detail;
  } else if (message === 'installing') {
    const dlSpan = stepDownloading.querySelector('span');
    dlSpan.textContent = detail || 'Installing update...';
  }

  if (message === 'checking' || message === 'initialising') {
    detailEl.textContent = detail || '';
  }
});

window.updateAPI.onProgress(({ percent }) => {
  progressContainer.classList.add('visible');
  progressFill.style.width = `${percent}%`;
});
