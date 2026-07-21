// Manages the single Python inference worker process and its NDJSON
// stdio protocol. Replaces the entire Docker instance circus from V2.
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const { WORKER_DIR } = require('./pythonEnv');
const WORKER_SCRIPT = path.join(WORKER_DIR, 'worker.py');

class TagWorker {
  constructor(pythonPath, { onLog = () => {}, onExit = () => {}, env = {} } = {}) {
    this.pythonPath = pythonPath;
    this.onLog = onLog;
    this.onExit = onExit;
    this.env = env;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.alive = false;
  }

  start() {
    this.proc = spawn(this.pythonPath, ['-u', WORKER_SCRIPT], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...this.env },
    });
    this.alive = true;

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { this.onLog(`worker: ${line}`); return; }
      const waiter = this.pending.get(msg.id);
      if (waiter) {
        this.pending.delete(msg.id);
        waiter.resolve(msg);
      }
    });

    this.proc.stderr.on('data', (buf) => {
      String(buf).split(/\r?\n/).forEach((l) => {
        const t = l.trim();
        // HF download progress bars & warnings — surface quietly
        if (t) this.onLog(t);
      });
    });

    this.proc.on('exit', (code) => {
      this.alive = false;
      const err = new Error(`Worker exited (code ${code})`);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      this.onExit(code);
    });
    this.proc.on('error', (err) => {
      this.alive = false;
      this.onLog(`Worker spawn error: ${err.message}`);
    });
  }

  request(cmd, fields = {}, timeoutMs = 0) {
    if (!this.alive) return Promise.reject(new Error('Worker is not running'));
    const id = this.nextId++;
    const payload = JSON.stringify({ id, cmd, ...fields });
    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Worker request '${cmd}' timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs);
      }
      this.pending.set(id, {
        resolve: (msg) => { if (timer) clearTimeout(timer); resolve(msg); },
        reject: (err) => { if (timer) clearTimeout(timer); reject(err); },
      });
      this.proc.stdin.write(payload + '\n');
    });
  }

  // Generous timeout: the first cold import of the ML libraries on a slow
  // disk can take well over 30s.
  hello() { return this.request('hello', {}, 180000); }
  init(model, threshold, parallel, hfToken) { return this.request('init', { model, threshold, parallel, hfToken }, 30000); }
  warmup() { return this.request('warmup', {}); } // no timeout: first run downloads models
  tag(imagePath, jsonOut) { return this.request('tag', { path: imagePath, jsonOut }); }

  async stop() {
    if (!this.alive) return;
    try { await this.request('shutdown', {}, 5000); } catch { /* force below */ }
    if (this.alive && this.proc) this.proc.kill();
  }
}

module.exports = { TagWorker };
