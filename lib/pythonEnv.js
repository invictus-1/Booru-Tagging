// First-run Python environment setup: finds a system Python, creates a
// private venv next to the app, installs worker dependencies. Idempotent —
// re-runs only if requirements.txt changed.
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Packaged builds: app code sits in a read-only asar archive, so the venv
// must live in userData and worker files ship via extraResources.
let electronApp = null;
try { electronApp = require('electron').app; } catch { /* tests outside electron */ }
const isPackaged = !!(electronApp && electronApp.isPackaged);

const WORKER_DIR = isPackaged
  ? path.join(process.resourcesPath, 'worker')
  : path.join(__dirname, '..', 'worker');
const DATA_ROOT = isPackaged
  ? electronApp.getPath('userData')
  : path.join(__dirname, '..');

const VENV_DIR = path.join(DATA_ROOT, '.venv');
const REQUIREMENTS = path.join(WORKER_DIR, 'requirements.txt');
const READY_MARKER = path.join(VENV_DIR, '.ready');
// Bump to force a one-time environment upgrade on existing installs.
const SETUP_VERSION = '2-cuda';

const isWin = process.platform === 'win32';

function venvPython() {
  return isWin
    ? path.join(VENV_DIR, 'Scripts', 'python.exe')
    : path.join(VENV_DIR, 'bin', 'python');
}

function requirementsHash() {
  return crypto.createHash('sha256')
    .update(fs.readFileSync(REQUIREMENTS, 'utf8'))
    .update(SETUP_VERSION)
    .digest('hex');
}

function hasNvidiaGpu() {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['-L'], { timeout: 10000 }, (err, stdout) => {
      resolve(!err && /GPU/i.test(String(stdout)));
    });
  });
}

function isReady() {
  try {
    return fs.existsSync(venvPython()) &&
      fs.readFileSync(READY_MARKER, 'utf8').trim() === requirementsHash();
  } catch {
    return false;
  }
}

function tryPython(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, [...args, '--version'], { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) return resolve(null);
      const out = `${stdout}${stderr}`.trim();
      const m = out.match(/Python (\d+)\.(\d+)/);
      if (m && (+m[1] > 3 || (+m[1] === 3 && +m[2] >= 9))) {
        resolve({ cmd, args, version: out });
      } else {
        resolve(null);
      }
    });
  });
}

async function findSystemPython() {
  const candidates = isWin
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];
  for (const [cmd, args] of candidates) {
    const found = await tryPython(cmd, args);
    if (found) return found;
  }
  return null;
}

function run(cmd, args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    const feed = (buf) => {
      String(buf).split(/\r?\n/).forEach((l) => { if (l.trim()) onLine(l.trim()); });
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', reject);
    child.on('close', (code) => {
      code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited with code ${code}`));
    });
  });
}

// Ensure the venv exists and deps are installed. onProgress(message) streams
// human-readable status to the UI.
async function ensureEnvironment(onProgress) {
  if (isReady()) return venvPython();

  const sys = await findSystemPython();
  if (!sys) {
    throw new Error(
      'Python 3.9+ was not found on this system. Install it from python.org ' +
      '(check "Add to PATH" during install), then restart the app.'
    );
  }
  onProgress(`Found ${sys.version}`);

  if (!fs.existsSync(venvPython())) {
    onProgress('Creating private Python environment (one-time)...');
    await run(sys.cmd, [...sys.args, '-m', 'venv', VENV_DIR], onProgress);
  }

  onProgress('Installing dependencies (one-time, a few minutes)...');
  await run(venvPython(), ['-m', 'pip', 'install', '--upgrade', 'pip', '--quiet'], onProgress);
  await run(venvPython(), ['-m', 'pip', 'install', '-r', REQUIREMENTS], onProgress);

  // NVIDIA machines: swap DirectML for CUDA. Much faster, thread-safe, and —
  // unlike DML — compatible with the PixAI model's ONNX graph. The [cuda,cudnn]
  // extras pull the whole CUDA runtime from pip; no CUDA Toolkit install needed.
  if (isWin && await hasNvidiaGpu()) {
    try {
      onProgress('NVIDIA GPU detected — installing CUDA runtime (enables PixAI on GPU)...');
      await run(venvPython(), ['-m', 'pip', 'uninstall', '-y', 'onnxruntime-directml'], onProgress);
      await run(venvPython(), ['-m', 'pip', 'install', 'onnxruntime-gpu[cuda,cudnn]>=1.21'], onProgress);
    } catch (err) {
      onProgress(`CUDA install failed (${err.message}) — falling back to DirectML.`);
      await run(venvPython(), ['-m', 'pip', 'install', 'onnxruntime-directml>=1.18'], onProgress);
    }
  }

  fs.writeFileSync(READY_MARKER, requirementsHash());
  onProgress('Environment ready ✓');
  return venvPython();
}

module.exports = { ensureEnvironment, isReady, venvPython, WORKER_DIR };
