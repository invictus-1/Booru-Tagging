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

const OWN_VENV_DIR = path.join(DATA_ROOT, '.venv');
const REQUIREMENTS = path.join(WORKER_DIR, 'requirements.txt');

// Booru Suite: reuse the old Booru Tagger V3 environment in place when it's
// ready and built from the same requirements — saves a multi-GB CUDA
// reinstall. Falls back to (and builds) the suite's own venv otherwise.
// The last ready environment is remembered in userData (shared by `npm start`
// and the installed build), so the installed app finds it too.
function knownVenvFile() {
  try { return electronApp ? path.join(electronApp.getPath('userData'), 'known-venv.txt') : null; } catch { return null; }
}
function rememberVenv(dir) {
  const f = knownVenvFile();
  if (!f) return;
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, dir, 'utf8'); } catch { /* best effort */ }
}
function legacyVenvDirs() {
  const out = [];
  const f = knownVenvFile();
  try { if (f && fs.existsSync(f)) out.push(fs.readFileSync(f, 'utf8').trim()); } catch { /* */ }
  out.push(path.join(__dirname, '..', '..', 'Booru Tagger V3', '.venv')); // dev sibling
  try { if (electronApp) out.push(path.join(electronApp.getPath('appData'), 'Booru Tagger', '.venv')); } catch { /* */ }
  return out.filter(Boolean);
}
// Bump to force a one-time environment upgrade on existing installs.
const SETUP_VERSION = '2-cuda';

const isWin = process.platform === 'win32';

function pythonIn(venvDir) {
  return isWin
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

function venvReady(venvDir) {
  try {
    return fs.existsSync(pythonIn(venvDir)) &&
      fs.readFileSync(path.join(venvDir, '.ready'), 'utf8').trim() === requirementsHash();
  } catch {
    return false;
  }
}

let resolvedVenv = null;
function venvDir() {
  if (resolvedVenv && venvReady(resolvedVenv)) return resolvedVenv;
  if (venvReady(OWN_VENV_DIR)) return (resolvedVenv = OWN_VENV_DIR);
  for (const d of legacyVenvDirs()) if (venvReady(d)) return (resolvedVenv = d);
  return OWN_VENV_DIR;
}

function venvPython() {
  return pythonIn(venvDir());
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
  return venvReady(venvDir());
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
  if (isReady()) {
    if (venvDir() !== OWN_VENV_DIR) onProgress(`Reusing existing Python environment: ${venvDir()}`);
    rememberVenv(venvDir());
    return venvPython();
  }
  resolvedVenv = OWN_VENV_DIR;
  const VENV_DIR = OWN_VENV_DIR;

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

  fs.writeFileSync(path.join(VENV_DIR, '.ready'), requirementsHash());
  rememberVenv(VENV_DIR);
  onProgress('Environment ready ✓');
  return venvPython();
}

module.exports = { ensureEnvironment, isReady, venvPython, WORKER_DIR };
