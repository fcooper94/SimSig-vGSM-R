/**
 * chatterbox-manager.js — Manages the local Chatterbox TTS + Whisper STT server
 *
 * On first use:
 *   1. Downloads Python 3.11 embeddable (~12MB)
 *   2. Installs pip + dependencies (chatterbox-tts, faster-whisper, fastapi, uvicorn)
 *   3. Downloads voice samples
 *   4. Starts the server
 *
 * On subsequent launches:
 *   - Starts the server immediately from the cached install
 *
 * Everything is stored in %APPDATA%/vgsm-r/chatterbox/
 */

const { app } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const INSTALL_DIR = path.join(app.getPath('userData'), 'chatterbox');
const PYTHON_DIR = path.join(INSTALL_DIR, 'python');
const VOICES_DIR = path.join(INSTALL_DIR, 'voices');
const SERVER_SCRIPT = path.join(INSTALL_DIR, 'server.py');
const PYTHON_EXE = path.join(PYTHON_DIR, 'python.exe');

const PYTHON_EMBED_URL = 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip';
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';

const REQUIRED_PACKAGES = [
  'chatterbox-tts',
  'faster-whisper',
  'fastapi',
  'uvicorn',
];

// PyTorch with CUDA — install from PyTorch index
const PYTORCH_PACKAGES = [
  'torch==2.6.0',
  'torchaudio==2.6.0',
];
const PYTORCH_INDEX = 'https://download.pytorch.org/whl/cu126';

let serverProcess = null;
let _onProgress = null; // callback for progress updates

function setProgressCallback(cb) {
  _onProgress = cb;
}

function progress(stage, percent, detail) {
  console.log(`[Chatterbox] ${stage}: ${percent}% — ${detail}`);
  if (_onProgress) _onProgress({ stage, percent, detail });
}

function isInstalled() {
  return fs.existsSync(PYTHON_EXE) && fs.existsSync(SERVER_SCRIPT);
}

function isRunning() {
  return serverProcess !== null && !serverProcess.killed;
}

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = (url.startsWith('https') ? https : http).get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Follow redirect
        file.close();
        fs.unlinkSync(dest);
        downloadFile(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      const total = parseInt(response.headers['content-length'] || '0', 10);
      let downloaded = 0;
      response.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total > 0) {
          const pct = Math.round((downloaded / total) * 100);
          progress('download', pct, `${(downloaded / 1024 / 1024).toFixed(1)}MB / ${(total / 1024 / 1024).toFixed(1)}MB`);
        }
      });
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });
    request.on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = execFile(command, args, {
      timeout: options.timeout || 600000,
      maxBuffer: 50 * 1024 * 1024,
      ...options,
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${command} failed: ${err.message}\n${stderr}`));
      else resolve(stdout);
    });
  });
}

async function install() {
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  fs.mkdirSync(PYTHON_DIR, { recursive: true });
  fs.mkdirSync(VOICES_DIR, { recursive: true });

  // Step 1: Download Python embeddable
  if (!fs.existsSync(path.join(PYTHON_DIR, 'python.exe'))) {
    progress('setup', 5, 'Downloading Python 3.11...');
    const zipPath = path.join(INSTALL_DIR, 'python.zip');
    await downloadFile(PYTHON_EMBED_URL, zipPath);

    progress('setup', 10, 'Extracting Python...');
    // Use PowerShell to extract (built-in on Windows)
    await runCommand('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -Path "${zipPath}" -DestinationPath "${PYTHON_DIR}" -Force`,
    ]);
    fs.unlinkSync(zipPath);

    // Enable pip in embedded Python — uncomment "import site" in python311._pth
    const pthFile = path.join(PYTHON_DIR, 'python311._pth');
    if (fs.existsSync(pthFile)) {
      let content = fs.readFileSync(pthFile, 'utf8');
      content = content.replace('#import site', 'import site');
      fs.writeFileSync(pthFile, content);
    }
  }

  const embeddedPython = path.join(PYTHON_DIR, 'python.exe');

  // Step 2: Install pip
  if (!fs.existsSync(path.join(PYTHON_DIR, 'Scripts', 'pip.exe'))) {
    progress('setup', 15, 'Installing pip...');
    const getPipPath = path.join(INSTALL_DIR, 'get-pip.py');
    await downloadFile(GET_PIP_URL, getPipPath);
    await runCommand(embeddedPython, [getPipPath, '--no-warn-script-location'], { timeout: 120000 });
    fs.unlinkSync(getPipPath);
  }

  const pip = path.join(PYTHON_DIR, 'Scripts', 'pip.exe');

  // Step 3: Install PyTorch with CUDA
  progress('setup', 20, 'Installing PyTorch (this may take a few minutes)...');
  await runCommand(pip, [
    'install', '--no-warn-script-location', ...PYTORCH_PACKAGES,
    '--index-url', PYTORCH_INDEX,
  ], { timeout: 600000 });

  // Step 4: Install other dependencies
  progress('setup', 55, 'Installing AI voice engine...');
  await runCommand(pip, [
    'install', '--no-warn-script-location', ...REQUIRED_PACKAGES,
  ], { timeout: 600000 });

  // Step 5: Copy server.py
  progress('setup', 90, 'Finalizing...');
  const srcServer = path.join(__dirname, 'chatterbox-server.py');
  if (fs.existsSync(srcServer)) {
    fs.copyFileSync(srcServer, SERVER_SCRIPT);
  }

  // Step 6: Copy voice samples if bundled
  const bundledVoices = path.join(__dirname, 'voices');
  if (fs.existsSync(bundledVoices)) {
    const files = fs.readdirSync(bundledVoices);
    for (const f of files) {
      if (f.endsWith('.wav')) {
        fs.copyFileSync(path.join(bundledVoices, f), path.join(VOICES_DIR, f));
      }
    }
  }

  progress('setup', 100, 'Installation complete!');
}

async function start() {
  if (isRunning()) return true;

  if (!isInstalled()) {
    await install();
  }

  return new Promise((resolve) => {
    progress('start', 0, 'Starting AI voice server...');

    serverProcess = spawn(PYTHON_EXE, [SERVER_SCRIPT], {
      env: {
        ...process.env,
        VOICES_DIR: VOICES_DIR,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProcess.stdout.on('data', (data) => {
      console.log(`[Chatterbox] ${data.toString().trim()}`);
    });
    serverProcess.stderr.on('data', (data) => {
      console.error(`[Chatterbox] ${data.toString().trim()}`);
    });
    serverProcess.on('exit', (code) => {
      console.log(`[Chatterbox] Server exited with code ${code}`);
      serverProcess = null;
    });

    // Poll health endpoint until ready
    let attempts = 0;
    const maxAttempts = 60; // 60 seconds
    const check = () => {
      attempts++;
      const req = http.get('http://127.0.0.1:8099/health', (res) => {
        if (res.statusCode === 200) {
          progress('start', 100, 'Server ready');
          resolve(true);
        } else if (attempts < maxAttempts) {
          setTimeout(check, 1000);
        } else {
          resolve(false);
        }
      });
      req.on('error', () => {
        if (attempts < maxAttempts) {
          setTimeout(check, 1000);
        } else {
          resolve(false);
        }
      });
      req.setTimeout(2000, () => { req.destroy(); });
    };
    setTimeout(check, 2000); // give it 2s to start
  });
}

function stop() {
  if (serverProcess && !serverProcess.killed) {
    console.log('[Chatterbox] Stopping server...');
    serverProcess.kill();
    serverProcess = null;
  }
}

module.exports = { isInstalled, isRunning, install, start, stop, setProgressCallback };
