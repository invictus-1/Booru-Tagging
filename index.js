// --- START OF index.js (Fix for fs.constants and mode check review) ---
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const axios = require('axios');
const FormData = require('form-data');
// --- FS Import Changes ---
const fs = require('fs');             // Import the base 'fs' module
const fsPromises = fs.promises; // Get the promises API from the base module
const fsSync = require('fs'); // Keep sync version *only* for createReadStream if needed
// --- End FS Import Changes ---
const path = require('path');
const { exec } = require('child_process');
const http = require('http');
const https = require('https');
const os = require('os');
const dns = require('dns').promises;
const net = require('net');

// --- Configuration Constants ---
const PERMANENT_INSTANCE_PORT = 5000;
const ADDITIONAL_INSTANCE_START_PORT = 5001;
const CONNECTION_COOLDOWN_MS = 10000;
const MAX_CONCURRENT_CONNECTIONS_PER_INSTANCE = 3;
const SOCKET_TIMEOUT_MS = 45000;
const REQUEST_TIMEOUT_MS = 90000;
const CONNECTION_RESET_THRESHOLD = 5;
const MAX_FILE_RETRIES = 3;
const DOCKER_STARTUP_TIMEOUT_MS = 60000;
const DOCKER_POLL_INTERVAL_MS = 2000;

// --- Global State ---
let mainWindow;
let processingState = { isPaused: false, isCanceled: false };
let isProcessing = false;
let healthCheckInterval = null;
let logCounter = 0;

// --- Instance Management State ---
let instanceRegistry = { isPermanentInstanceRunning: false, permanentInstanceId: null, additionalInstances: [] };
let instanceHealthStatus = [];
let connectionPools = {};

// --- Corrupted File Tracking ---
const corruptedFiles = new Map();

function trackFileRetry(filePath) {
    const count = corruptedFiles.get(filePath) || 0;
    corruptedFiles.set(filePath, count + 1);
    return count + 1;
}

function isFileCorrupted(filePath) {
    return (corruptedFiles.get(filePath) || 0) >= MAX_FILE_RETRIES;
}

function clearCorruptedFiles() {
    corruptedFiles.clear();
}

// --- Utility Functions ---

/**
 * Helper to check if a file exists asynchronously.
 * USES fsPromises.access and fs.constants.F_OK
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function fileExists(filePath) {
  try {
    // Use fsPromises.access but fs.constants
    await fsPromises.access(filePath, fs.constants.F_OK); // <--- FIX Applied Here
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
        return false; // File does not exist is not an unexpected error
    }
    // Log other errors but treat as non-existent for safety
    console.warn(`Unexpected error checking file existence for ${filePath}: ${error.message}`);
    return false; // Treat unexpected errors as file not existing
  }
}

/**
 * Helper to check if a directory exists asynchronously.
 * USES fsPromises.stat
 * @param {string} dirPath
 * @returns {Promise<boolean>}
 */
async function directoryExists(dirPath) {
    try {
        // Use fsPromises.stat
        const stats = await fsPromises.stat(dirPath); // <--- FIX Applied Here (using fsPromises)
        return stats.isDirectory();
    } catch (error) {
        if (error.code === 'ENOENT') {
            return false; // Directory does not exist
        }
        // Log other errors but treat as non-existent
        console.warn(`Unexpected error checking directory existence for ${dirPath}: ${error.message}`);
        return false; // Treat unexpected errors as directory not existing
    }
}


/**
 * Yields control to the event loop and potentially updates the UI.
 */
function yieldToUI() {
  return new Promise(resolve => {
    setImmediate(() => {
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
            mainWindow.webContents.send('force-update');
        }
      setTimeout(resolve, 0);
    });
  });
}

/**
 * Sends a log message to the renderer process, ensuring UI updates.
 */
function sendLogToRenderer(message, type = '') {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const logMessage = (typeof message === 'string') ? message : JSON.stringify(message);
  mainWindow.webContents.send('log', logMessage, type);
  logCounter++;
  if (type === 'error' || type === 'warning' || logCounter % 20 === 0) {
    if (!mainWindow.isFocused()) {
        mainWindow.webContents.send('force-update');
    }
  }
}

/**
 * Checks if a TCP port is currently in use on localhost.
 */
async function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      resolve(err.code === 'EADDRINUSE');
    });
    server.once('listening', () => {
      server.close(() => resolve(false));
    });
    server.listen(port, '127.0.0.1');
  });
}

// --- HTTP Agent & Axios Instance Management --- (No changes needed here)
const createHttpAgent = (instanceIndex) => { /* ... as before ... */
  return new http.Agent({
    keepAlive: true,
    maxSockets: MAX_CONCURRENT_CONNECTIONS_PER_INSTANCE,
    maxFreeSockets: Math.max(1, Math.floor(MAX_CONCURRENT_CONNECTIONS_PER_INSTANCE / 2)),
    timeout: SOCKET_TIMEOUT_MS,
    freeSocketTimeout: 30000,
    scheduling: 'lifo',
    name: `autotagger-agent-${instanceIndex}`
  });
};
function createAxiosInstance(instanceIndex) { /* ... as before ... */
  if (!connectionPools[instanceIndex]) {
    sendLogToRenderer(`Creating new connection pool for instance #${instanceIndex + 1}`);
    connectionPools[instanceIndex] = createHttpAgent(instanceIndex);
  }
  return axios.create({
    httpAgent: connectionPools[instanceIndex],
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 3,
    validateStatus: (status) => status >= 200 && status < 500,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
}
function resetConnectionPool(instanceIndex) { /* ... as before ... */
  if (connectionPools[instanceIndex]) {
    sendLogToRenderer(`Resetting connection pool for instance #${instanceIndex + 1}`, 'warning');
    try {
      connectionPools[instanceIndex].destroy();
    } catch (e) {
      sendLogToRenderer(`Error destroying connection pool for instance #${instanceIndex + 1}: ${e.message}`, 'error');
    }
    delete connectionPools[instanceIndex];
  }
}


// --- API & Docker Instance Health Checks --- (No changes needed here)
async function checkApiRunning(port, timeout = 5000) { /* ... as before ... */
    const url = `http://localhost:${port}`;
    try {
        const healthCheckAxios = axios.create({
            timeout: timeout,
            validateStatus: () => true,
            httpAgent: new http.Agent({ keepAlive: false }),
            httpsAgent: new https.Agent({ keepAlive: false }),
        });
        const response = await healthCheckAxios.get(url);
        return response.status < 500;
    } catch (error) {
        return false;
    }
}
async function waitForApiReady(port, totalTimeout = DOCKER_STARTUP_TIMEOUT_MS, pollInterval = DOCKER_POLL_INTERVAL_MS) { /* ... as before ... */
    const startTime = Date.now();
    // sendLogToRenderer(`Waiting up to ${totalTimeout / 1000}s for API on port ${port} to respond...`); // Less verbose
    while (Date.now() - startTime < totalTimeout) {
        if (await checkApiRunning(port, pollInterval * 0.8)) {
            sendLogToRenderer(`API on port ${port} is ready ✓`, 'success');
            await yieldToUI();
            return true;
        }
        if (processingState.isCanceled) return false;
        await yieldToUI();
        await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
    sendLogToRenderer(`API on port ${port} did not become ready within ${totalTimeout / 1000}s timeout ✗`, 'error');
    await yieldToUI();
    return false;
}
function initializeInstanceHealth(instanceCount) { /* ... as before ... */
  instanceHealthStatus = Array.from({ length: instanceCount }, () => ({
    consecutiveFailures: 0, totalRequests: 0, successfulRequests: 0, isHealthy: true,
  }));
}
function updateInstanceHealth(instanceIndex, success) { /* ... as before ... */
  if (!instanceHealthStatus[instanceIndex]) return;
  const health = instanceHealthStatus[instanceIndex];
  health.totalRequests++;
  if (success) {
    health.successfulRequests++;
    if (!health.isHealthy) {
        sendLogToRenderer(`Instance #${instanceIndex + 1} appears to have recovered. Marking as healthy. ✓`, 'success');
        health.isHealthy = true;
        resetConnectionPool(instanceIndex);
    }
    health.consecutiveFailures = 0;
  } else {
    health.consecutiveFailures++;
    if (health.isHealthy && health.consecutiveFailures >= CONNECTION_RESET_THRESHOLD) {
      health.isHealthy = false;
      sendLogToRenderer(`Instance #${instanceIndex + 1} marked as UNHEALTHY after ${CONNECTION_RESET_THRESHOLD} consecutive failures ✗`, 'error');
      resetConnectionPool(instanceIndex);
    }
  }
}
function isInstanceHealthy(instanceIndex) { /* ... as before ... */
  return instanceHealthStatus[instanceIndex]?.isHealthy ?? false;
}
async function checkAndRecoverInstances() { /* ... as before ... */
  sendLogToRenderer('Performing health check and recovery on Docker instances...');
  await yieldToUI();
  const instancesToCheck = [
    ...(instanceRegistry.isPermanentInstanceRunning ? [{ port: PERMANENT_INSTANCE_PORT, index: 0, containerId: instanceRegistry.permanentInstanceId }] : []),
    ...instanceRegistry.additionalInstances.map((inst, i) => ({ port: inst.port, index: i + 1, containerId: inst.containerId }))
  ];
  for (const instanceInfo of instancesToCheck) {
    if (processingState.isCanceled) break;
    const { port, index, containerId } = instanceInfo;
    const wasHealthy = isInstanceHealthy(index);
    const isApiResponding = await checkApiRunning(port);
    await yieldToUI();
    if (!isApiResponding) {
      if (wasHealthy) {
         sendLogToRenderer(`Instance #${index + 1} (Port ${port}) became unresponsive. Attempting recovery...`, 'error');
         if (instanceHealthStatus[index]) instanceHealthStatus[index].isHealthy = false;
         resetConnectionPool(index);
      } else {
         // sendLogToRenderer(`Unhealthy Instance #${index + 1} (Port ${port}) remains unresponsive. Recovery attempt...`, 'warning'); // Less verbose
      }
      try {
        if (containerId) await stopContainer(containerId, port, index);
        await yieldToUI();
        if (await isPortInUse(port)) {
            sendLogToRenderer(`Port ${port} still in use after stop. Cannot restart Instance #${index + 1}.`, 'error');
            continue;
        }
        const newContainerId = await startContainer(port, index);
        await yieldToUI();
        if (newContainerId) {
           if (index === 0) instanceRegistry.permanentInstanceId = newContainerId;
           else { const regIndex = instanceRegistry.additionalInstances.findIndex(inst => inst.port === port); if (regIndex !== -1) instanceRegistry.additionalInstances[regIndex].containerId = newContainerId; }
           const recovered = await waitForApiReady(port);
           if (recovered && instanceHealthStatus[index]) {
             instanceHealthStatus[index].isHealthy = true; instanceHealthStatus[index].consecutiveFailures = 0;
             sendLogToRenderer(`Instance #${index + 1} (Port ${port}) recovered successfully ✓`, 'success');
             resetConnectionPool(index);
           } else if (!recovered) {
             sendLogToRenderer(`Instance #${index + 1} (Port ${port}) failed to recover (API not ready) ✗`, 'error');
             if (instanceHealthStatus[index]) instanceHealthStatus[index].isHealthy = false;
             await stopContainer(newContainerId, port, index);
           }
        } else {
            sendLogToRenderer(`Failed to start replacement container for Instance #${index + 1} (Port ${port}) ✗`, 'error');
            if (instanceHealthStatus[index]) instanceHealthStatus[index].isHealthy = false;
        }
      } catch (error) {
        sendLogToRenderer(`Error during recovery for Instance #${index + 1} (Port ${port}): ${error.message}`, 'error');
        if (instanceHealthStatus[index]) instanceHealthStatus[index].isHealthy = false;
      }
    } else if (!wasHealthy) {
      sendLogToRenderer(`Instance #${index + 1} (Port ${port}) is responding again. Marking as healthy. ✓`, 'success');
      if (instanceHealthStatus[index]) { instanceHealthStatus[index].isHealthy = true; instanceHealthStatus[index].consecutiveFailures = 0; }
      resetConnectionPool(index);
    }
    await yieldToUI();
  }
  // sendLogToRenderer('Health check and recovery attempt completed.'); // Less verbose
  await yieldToUI();
}


// --- Request Retry Logic --- (No changes needed here)
async function enhancedRetryRequest(fn, instanceIndex, maxRetries = MAX_FILE_RETRIES, initialDelay = 1500) { /* ... as before ... */
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (processingState.isCanceled) throw lastError || new Error('Processing canceled by user');
    if (!isInstanceHealthy(instanceIndex)) {
        const healthMsg = `Instance #${instanceIndex + 1} is marked unhealthy. Skipping request attempt ${attempt}.`;
        if (attempt === 1) sendLogToRenderer(healthMsg, 'warning');
        throw lastError || new Error(healthMsg);
    }
    while (processingState.isPaused && !processingState.isCanceled) { await new Promise(resolve => setTimeout(resolve, 200)); await yieldToUI(); }
    if (processingState.isCanceled) throw lastError || new Error('Processing canceled by user');
    try {
      const result = await fn();
      if (result?.status) {
          if (result.status >= 200 && result.status < 300) { updateInstanceHealth(instanceIndex, true); return result; }
          else if (result.status >= 400 && result.status < 500) { sendLogToRenderer(`Instance #${instanceIndex+1} received API error ${result.status} (Attempt ${attempt}/${maxRetries}). Won't retry client errors.`, 'warning'); return result; }
          else { throw new Error(`API returned unexpected status ${result.status}`); }
      } else { updateInstanceHealth(instanceIndex, true); return result; }
    } catch (error) {
      lastError = error;
      if (error.message === 'Processing canceled by user') throw error;
      if (error.response && error.response.status >= 400 && error.response.status < 500) { sendLogToRenderer(`Instance #${instanceIndex+1} received API error ${error.response.status} (Attempt ${attempt}/${maxRetries}). Won't retry client errors.`, 'warning'); throw error; }
      sendLogToRenderer(`Instance #${instanceIndex+1} request failed (Attempt ${attempt}/${maxRetries}): ${error.message}. Retrying...`, 'warning');
      updateInstanceHealth(instanceIndex, false);
      if (attempt >= maxRetries) break;
      const backoff = initialDelay * Math.pow(1.8, attempt - 1);
      const jitter = backoff * (Math.random() * 0.4 + 0.8);
      const waitTime = Math.min(Math.max(500, jitter), 20000);
      const waitEndTime = Date.now() + waitTime;
      while(Date.now() < waitEndTime) {
          if (processingState.isCanceled) throw new Error('Processing canceled by user during retry wait');
          if (processingState.isPaused) await new Promise(resolve => setTimeout(resolve, 200));
          else await new Promise(resolve => setTimeout(resolve, Math.min(200, waitEndTime - Date.now())));
          await yieldToUI();
      }
    }
  }
  sendLogToRenderer(`Instance #${instanceIndex+1} request FAILED after ${maxRetries} attempts: ${lastError.message}`, 'error');
  updateInstanceHealth(instanceIndex, false);
  throw lastError;
}

// --- Electron App Lifecycle & Window Management --- (Ensure webPreferences are correct)
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800, height: 650,
    webPreferences: {
      nodeIntegration: true,    // <-- Correct for NO preload
      contextIsolation: false, // <-- Correct for NO preload
      backgroundThrottling: false,
      // preload: path.join(__dirname, 'preload.js') // Ensure this is commented out or removed
    },
  });
  mainWindow.loadFile('index.html');
  mainWindow.on('closed', () => { mainWindow = null; });
}
app.whenReady().then(createWindow);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', async (event) => { /* ... as before ... */
  if (isProcessing) {
    sendLogToRenderer('Cancel requested due to app quit during processing...', 'warning');
    processingState.isCanceled = true; event.preventDefault();
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (!isProcessing && (instanceRegistry.additionalInstances.length > 0 || instanceRegistry.permanentInstanceId)) {
      sendLogToRenderer('Shutting down Docker containers before quitting...'); event.preventDefault();
      try { await shutdownAllContainers(); } catch (error) { console.error("Error during pre-quit container shutdown:", error); } finally { app.quit(); }
  } else if (isProcessing) {
      sendLogToRenderer('Forcing quit after cancellation timeout...');
      try { await shutdownAllContainers(); } catch {} finally { app.quit(); }
  }
});
const handleShutdown = async (signal) => { /* ... as before ... */
    console.log(`Received ${signal}. Shutting down gracefully...`);
    if (isProcessing) { processingState.isCanceled = true; await new Promise(resolve => setTimeout(resolve, 1000)); }
    try { await shutdownAllContainers(); } catch(error){ console.error("Error shutting down containers:", error); } finally { process.exit(0); }
};
process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('uncaughtException', async (error) => { /* ... as before ... */
    console.error('UNCAUGHT EXCEPTION:', error); sendLogToRenderer(`FATAL ERROR: ${error.message}\n${error.stack}`, 'error');
    try { if (isProcessing) processingState.isCanceled = true; await shutdownAllContainers(); } catch (cleanupError) { console.error('Error during emergency cleanup:', cleanupError); }
    finally { if (app && !app.isReady()) { process.exit(1); } else if (app) { app.exit(1); } else { process.exit(1); } }
});

// --- Docker Management Functions --- (No changes needed here)
async function checkDockerAvailability() { /* ... as before ... */
    return new Promise((resolve) => {
        exec('docker --version', (error, stdout, stderr) => {
            if (error) { sendLogToRenderer('Docker command failed. Is Docker installed?', 'error'); resolve(false); }
            else { exec('docker ps', (psError, psStdout, psStderr) => {
                     if (psError) { sendLogToRenderer(`Docker daemon not responding: ${psStderr || psError.message}. Is it running?`, 'error'); resolve(false); }
                     else { sendLogToRenderer(`Docker available: ${stdout.trim()} & Daemon responding.`, 'success'); resolve(true); } });
            } }); });
}
async function startContainer(port, instanceIndex) { /* ... as before ... */
    const imageName = 'ghcr.io/danbooru/autotagger';
    const command = `docker run -d --rm -p ${port}:5000 ${imageName}`;
    // sendLogToRenderer(`Starting Instance #${instanceIndex + 1} on port ${port}...`); // Less verbose
    await yieldToUI();
    return new Promise((resolve) => {
        exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
            if (error) { const errorMsg = stderr || error.message; sendLogToRenderer(`Failed to start Instance #${instanceIndex + 1} (Port ${port}): ${errorMsg}`, 'error'); resolve(null); }
            else { const containerId = stdout.trim(); if (!containerId) { sendLogToRenderer(`Instance #${instanceIndex + 1} (Port ${port}) started but no container ID? Stderr: ${stderr}`, 'error'); resolve(null); }
                   else { sendLogToRenderer(`Instance #${instanceIndex + 1} (Port ${port}) started: ${containerId.substring(0, 12)}...`); resolve(containerId); }
            } }); });
}
async function stopContainer(containerId, port, instanceIndex) { /* ... as before ... */
    if (!containerId) return true;
    const command = `docker stop ${containerId}`;
    // sendLogToRenderer(`Stopping Instance #${instanceIndex + 1} (Port ${port}, Container ${containerId.substring(0,12)})...`); // Less verbose
    await yieldToUI();
    return new Promise((resolve) => {
        exec(command, { timeout: 15000 }, (error, stdout, stderr) => {
            if (error) { const errorMsg = stderr || error.message; if (!errorMsg.includes('No such container')) { sendLogToRenderer(`Warn stopping Instance #${instanceIndex + 1}: ${errorMsg}`, 'warning'); } }
            else { /* sendLogToRenderer(`Instance #${instanceIndex + 1} (Port ${port}) stopped.`); */ } // Less verbose
            resolve(true);
        }); });
}
async function stopAdditionalContainers() { /* ... as before ... */
  if (instanceRegistry.additionalInstances.length === 0) return;
  sendLogToRenderer(`Stopping ${instanceRegistry.additionalInstances.length} additional API instances...`); await yieldToUI();
  const instancesToStop = [...instanceRegistry.additionalInstances]; instanceRegistry.additionalInstances = [];
  const stopPromises = instancesToStop.map((instance, i) => stopContainer(instance.containerId, instance.port, i + 1));
  await Promise.all(stopPromises);
  for (let i = 0; i < instancesToStop.length; i++) { resetConnectionPool(i + 1); }
  sendLogToRenderer('Additional instances stopped.'); await yieldToUI();
}
async function shutdownAllContainers() { /* ... as before ... */
  sendLogToRenderer('Shutting down all managed Docker containers...');
  const instancesToStop = [ ...instanceRegistry.additionalInstances.map((inst, i) => ({ ...inst, index: i+1 })), ...(instanceRegistry.permanentInstanceId ? [{ containerId: instanceRegistry.permanentInstanceId, port: PERMANENT_INSTANCE_PORT, index: 0 }] : []) ];
  instanceRegistry.additionalInstances = []; instanceRegistry.permanentInstanceId = null; instanceRegistry.isPermanentInstanceRunning = false;
  if (instancesToStop.length > 0) {
     sendLogToRenderer(`Attempting to stop ${instancesToStop.length} container(s)...`);
     const stopPromises = instancesToStop.map(inst => stopContainer(inst.containerId, inst.port, inst.index));
     try { await Promise.all(stopPromises); sendLogToRenderer('All managed containers stop command issued.'); }
     catch (stopError) { sendLogToRenderer(`Error during bulk container stop: ${stopError.message}`, 'error'); }
  } else { sendLogToRenderer('No managed containers were registered to stop.'); }
  const poolKeys = Object.keys(connectionPools);
  if (poolKeys.length > 0) { poolKeys.forEach(key => resetConnectionPool(parseInt(key, 10))); /* sendLogToRenderer('All connection pools reset.'); */ } // Less verbose
  connectionPools = {}; await yieldToUI();
}

// --- IPC Handlers --- (Ensure analyze-folder uses fsPromises)
ipcMain.handle('select-folder', async () => { /* ... as before ... */
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: 'Select Folder Containing Images' });
  return !result.canceled ? result.filePaths[0] : null;
});
ipcMain.handle('select-folders', async () => { /* ... as before ... */
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'multiSelections'], title: 'Select Folder(s) Containing Images' });
  return !result.canceled ? result.filePaths : [];
});
ipcMain.handle('analyze-folder', async (event, inputFolder) => { /* ... Uses fileExists/directoryExists which use fsPromises ... */
  // sendLogToRenderer(`Analyzing folder: ${inputFolder}`); // Less verbose
  await yieldToUI();
  const results = { hasJsonFolder: false, jsonCount: 0, logCount: 0, missingCount: 0, imageCount: 0, error: null };
  try {
    const jsonFolder = path.join(inputFolder, 'Json');
    results.hasJsonFolder = await directoryExists(jsonFolder);
    // sendLogToRenderer(`Checking for JSON folder at: ${jsonFolder} - Found: ${results.hasJsonFolder}`);
    if (results.hasJsonFolder) {
      const allFilesInJson = await fsPromises.readdir(jsonFolder); // Use fsPromises
      results.jsonCount = allFilesInJson.filter(f => f.toLowerCase().endsWith('.json') && f !== 'processed_log.json').length;
      // sendLogToRenderer(`Found ${results.jsonCount} JSON files.`); await yieldToUI();
      const logFilePath = path.join(jsonFolder, 'processed_log.json');
      if (await fileExists(logFilePath)) {
        try {
          const logContent = await fsPromises.readFile(logFilePath, 'utf8'); // Use fsPromises
          const logData = JSON.parse(logContent); if (!Array.isArray(logData)) throw new Error("Log data not array");
          results.logCount = logData.length; // sendLogToRenderer(`Found log with ${results.logCount} entries.`);
          let missingPaths = [];
          for (let i=0; i < logData.length; i++) { const entry = logData[i]; if (entry?.status === 'success' && typeof entry.imagePath === 'string') { const jsonName = path.basename(entry.imagePath, path.extname(entry.imagePath)) + '.json'; if (!(await fileExists(path.join(jsonFolder, jsonName)))) missingPaths.push(entry.imagePath); } if (i % 200 === 0) await yieldToUI(); }
          results.missingCount = missingPaths.length; if (results.missingCount > 0) sendLogToRenderer(`Folder ${path.basename(inputFolder)}: ${results.missingCount} images logged as success but missing JSON files.`, 'warning');
        } catch (logError) { sendLogToRenderer(`Error reading/parsing log file: ${logError.message}`, 'error'); }
      } // else { sendLogToRenderer('No processing log found.'); }
    }
    const imageExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
    const folderContents = await fsPromises.readdir(inputFolder); // Use fsPromises
    let imageFilesCount = 0;
    for(let i=0; i < folderContents.length; i++) { const file = folderContents[i]; const fullPath = path.join(inputFolder, file); try { const stats = await fsPromises.stat(fullPath); if (stats.isFile() && imageExts.has(path.extname(file).toLowerCase())) imageFilesCount++; } catch (statError) { if (statError.code !== 'ENOENT') console.warn(`Could not stat file ${fullPath}: ${statError.message}`); } if (i % 200 === 0) await yieldToUI(); }
    results.imageCount = imageFilesCount; // sendLogToRenderer(`Found ${results.imageCount} image files.`);
  } catch (error) { console.error('Error analyzing folder:', error); sendLogToRenderer(`Error analyzing folder ${path.basename(inputFolder)}: ${error.message}`, 'error'); results.error = error.message; }
  return results;
});
ipcMain.handle('check-api-connection', async (event, apiBaseUrl = `http://localhost:${PERMANENT_INSTANCE_PORT}`) => { /* ... as before ... */
  try {
    const urlObj = new URL(apiBaseUrl); const port = parseInt(urlObj.port, 10); if (isNaN(port)) throw new Error(`Invalid API base URL: ${apiBaseUrl}`);
    const isRunning = await checkApiRunning(port);
    // if (isRunning) sendLogToRenderer(`API connection check to ${apiBaseUrl} successful.`, 'success');
    // else sendLogToRenderer(`API connection check to ${apiBaseUrl} failed.`, 'error');
    return { success: isRunning, error: isRunning ? null : `API not responding at ${apiBaseUrl}` };
  } catch (error) { console.error('API connection check error:', error); sendLogToRenderer(`API connection check to ${apiBaseUrl} failed: ${error.message}`, 'error'); return { success: false, error: error.message }; }
});
ipcMain.on('toggle-pause', () => { /* ... as before ... */
  if (!isProcessing) return; processingState.isPaused = !processingState.isPaused;
  sendLogToRenderer(`Processing ${processingState.isPaused ? 'PAUSED' : 'RESUMED'} by user.`, processingState.isPaused ? 'warning' : 'success');
  mainWindow.webContents.send('pause-state-changed', processingState.isPaused);
});
ipcMain.on('cancel-processing', () => { /* ... as before ... */
  if (isProcessing && !processingState.isCanceled) { processingState.isCanceled = true;
    sendLogToRenderer('Cancel request received. Finishing current operations and cleaning up...', 'warning');
    mainWindow.webContents.send('processing-canceled');
  }
});

// --- Core Image Processing Logic --- (Ensure uses fsPromises.writeFile)
async function processSingleImageFile(imagePath, jsonFolder, apiEndpoint, instanceIndex) { /* ... as before, ensure fsPromises.writeFile used ... */
    const imageFile = path.basename(imagePath); const timestamp = new Date().toISOString();
    if (isFileCorrupted(imagePath)) return { success: false, imagePath, timestamp, status: 'skipped', error: `Previously failed ${MAX_FILE_RETRIES} attempts` };
    const jsonFileName = path.basename(imageFile, path.extname(imageFile)) + '.json'; const jsonFilePath = path.join(jsonFolder, jsonFileName);
    let fileStream = null;
    try {
        if (processingState.isCanceled) throw new Error('Processing canceled by user');
        try { fileStream = fsSync.createReadStream(imagePath); } catch (streamError) { throw new Error(`Failed stream for ${imageFile}: ${streamError.message}`); }
        fileStream.on('error', (streamError) => { sendLogToRenderer(`Error reading stream ${imageFile}: ${streamError.message}`, 'error'); if (fileStream && !fileStream.destroyed) fileStream.destroy(); });
        const formData = new FormData(); formData.append('file', fileStream, { filename: imageFile }); formData.append('format', 'json');
        const axiosInstance = createAxiosInstance(instanceIndex);
        const response = await enhancedRetryRequest(() => axiosInstance.post(apiEndpoint, formData, { headers: formData.getHeaders() }), instanceIndex, MAX_FILE_RETRIES);
        if (response.status >= 200 && response.status < 300) {
            await fsPromises.writeFile(jsonFilePath, JSON.stringify(response.data, null, 2)); // Use fsPromises
            return { success: true, imagePath, timestamp, status: 'success' };
        } else { const apiErrorMsg = `API returned client error ${response.status} for ${imageFile}`; sendLogToRenderer(`Instance #${instanceIndex+1}: ${apiErrorMsg} ✗`, 'error'); trackFileRetry(imagePath); return { success: false, imagePath, timestamp, status: 'failed', error: apiErrorMsg }; }
    } catch (error) {
        const retryCount = trackFileRetry(imagePath); const isCorrupt = retryCount >= MAX_FILE_RETRIES; const status = processingState.isCanceled ? 'canceled' : (isCorrupt ? 'skipped' : 'failed'); const errorMsg = error.message || 'Unknown error';
        if (status === 'skipped') sendLogToRenderer(`Instance #${instanceIndex+1}: File ${imageFile} marked CORRUPTED after ${retryCount} attempts: ${errorMsg} ✗`, 'error');
        else if (status === 'failed') sendLogToRenderer(`Instance #${instanceIndex+1}: Error processing ${imageFile} (Attempt ${retryCount}/${MAX_FILE_RETRIES}): ${errorMsg} ✗`, 'warning');
        return { success: false, imagePath, timestamp, status: status, error: errorMsg };
    } finally { if (fileStream && !fileStream.destroyed) fileStream.destroy(); }
}
async function processWithMultipleInstances(folderPath, imageFiles, jsonFolder, apiEndpoints) { /* ... as before ... */
  const imageQueue = [...imageFiles]; const totalFiles = imageFiles.length; let processedCount = 0; const resultsLog = []; const instanceCount = apiEndpoints.length;
  const instanceProgress = Array.from({ length: instanceCount }, () => ({ current: 0, file: '' })); const instanceTotalEst = Math.ceil(totalFiles / instanceCount);
  function updateOverallProgressUI() { mainWindow.webContents.send('progress-folder', { current: processedCount, total: totalFiles, folder: folderPath, file: '' }); }
  function updateInstanceProgressUI(instanceIndex) { mainWindow.webContents.send('progress-instance', { instance: instanceIndex, current: instanceProgress[instanceIndex].current, total: instanceTotalEst, folder: folderPath, file: instanceProgress[instanceIndex].file }); }
  async function instanceWorker(instanceIndex, endpoint) {
    while (true) {
      if (processingState.isCanceled || !isInstanceHealthy(instanceIndex)) break; while (processingState.isPaused && !processingState.isCanceled) { await new Promise(resolve => setTimeout(resolve, 200)); await yieldToUI(); } if (processingState.isCanceled) break;
      const imageFile = imageQueue.shift(); if (!imageFile) break; processedCount++; updateOverallProgressUI();
      const imagePath = path.join(folderPath, imageFile); instanceProgress[instanceIndex].current++; instanceProgress[instanceIndex].file = imageFile; updateInstanceProgressUI(instanceIndex); await yieldToUI();
      const result = await processSingleImageFile(imagePath, jsonFolder, endpoint, instanceIndex); resultsLog.push(result); await yieldToUI();
    } instanceProgress[instanceIndex].file = ''; updateInstanceProgressUI(instanceIndex);
  }
  const workerPromises = apiEndpoints.map((endpoint, index) => isInstanceHealthy(index) ? instanceWorker(index, endpoint) : Promise.resolve());
  await Promise.all(workerPromises); processedCount = resultsLog.length; updateOverallProgressUI();
  const finalSuccess = resultsLog.filter(r => r.status === 'success').length; const finalFailed = resultsLog.filter(r => r.status === 'failed').length; const finalSkipped = resultsLog.filter(r => r.status === 'skipped').length; const finalCanceled = resultsLog.filter(r => r.status === 'canceled').length;
  if (finalCanceled > 0) sendLogToRenderer(`Folder ${path.basename(folderPath)}: ${finalCanceled} canceled operations.`, 'warning');
  return { success: finalSuccess, failed: finalFailed, skipped: finalSkipped, processedLog: resultsLog };
}
async function processBatch(folderPath, imageFiles, jsonFolder, apiEndpoint, startIndex, batchSize, instanceIndex = 0) { /* ... as before ... */
    const batchLog = []; const endIndex = Math.min(startIndex + batchSize, imageFiles.length); const totalInFolder = imageFiles.length;
    for (let i = startIndex; i < endIndex; i++) {
        const imageFile = imageFiles[i]; const imagePath = path.join(folderPath, imageFile);
        if (processingState.isCanceled) break; while (processingState.isPaused && !processingState.isCanceled) { await new Promise(resolve => setTimeout(resolve, 200)); await yieldToUI(); } if (processingState.isCanceled) break;
        mainWindow.webContents.send('progress-folder', { current: i, total: totalInFolder, folder: folderPath, file: imageFile }); await yieldToUI();
        const result = await processSingleImageFile(imagePath, jsonFolder, apiEndpoint, instanceIndex); batchLog.push(result); await yieldToUI();
    }
    const success = batchLog.filter(r => r.status === 'success').length; const failed = batchLog.filter(r => r.status === 'failed').length; const skipped = batchLog.filter(r => r.status === 'skipped').length;
    return { success, failed, skipped, processedLog: batchLog };
}

// --- Folder Processing --- (Ensure uses fsPromises.writeFile in saveProcessingLog, check mode logic)
async function saveProcessingLog(inputFolder, newEntries) { /* ... Uses fileExists/directoryExists which use fsPromises ... ensure fsPromises.writeFile */
  if (!newEntries || newEntries.length === 0) return 0;
  const jsonFolder = path.join(inputFolder, 'Json'); const logFilePath = path.join(jsonFolder, 'processed_log.json'); let logDataMap = new Map();
  try {
    if (!(await directoryExists(jsonFolder))) await fsPromises.mkdir(jsonFolder, { recursive: true }); // Use fsPromises
    if (await fileExists(logFilePath)) {
      try { const logContent = await fsPromises.readFile(logFilePath, 'utf8'); const existingLog = JSON.parse(logContent); if (Array.isArray(existingLog)) existingLog.forEach(item => { if (item?.imagePath) logDataMap.set(item.imagePath, item); }); else sendLogToRenderer(`Existing log ${logFilePath} corrupted. Starting fresh.`, 'warning'); }
      catch (readError) { sendLogToRenderer(`Error reading/parsing log ${logFilePath}: ${readError.message}. Starting fresh.`, 'warning'); logDataMap.clear(); }
    }
    newEntries.forEach(entry => { if (entry?.imagePath) logDataMap.set(entry.imagePath, entry); });
    const updatedLogData = Array.from(logDataMap.values());
    await fsPromises.writeFile(logFilePath, JSON.stringify(updatedLogData, null, 2)); // Use fsPromises
    await yieldToUI(); return updatedLogData.length;
  } catch (error) { console.error('Error saving processing log:', error); sendLogToRenderer(`Error saving log for ${path.basename(inputFolder)}: ${error.message}`, 'error'); return -1; }
}
async function processFolder(folderPath, apiEndpoints, confidenceThreshold, processMode, includeSubfolders) { /* ... Check mode logic using updated fileExists ... */
  const folderName = path.basename(folderPath); sendLogToRenderer(`--- Starting folder: ${folderName} ---`); await yieldToUI();
  const result = { folder: folderPath, total: 0, processed: 0, success: 0, failed: 0, skipped: 0 };
  try {
    let imageFiles = []; let subfolders = [];
    try { const dirents = await fsPromises.readdir(folderPath, { withFileTypes: true }); const imageExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']); for (let i=0; i < dirents.length; i++) { const d=dirents[i]; if (d.isDirectory() && d.name !== 'Json') subfolders.push(path.join(folderPath, d.name)); else if (d.isFile() && imageExts.has(path.extname(d.name).toLowerCase())) imageFiles.push(d.name); if (i % 100 === 0) await yieldToUI(); } /* sendLogToRenderer(`Folder ${folderName}: Found ${imageFiles.length} images, ${subfolders.length} subfolders.`); */ }
    catch (readDirError) { sendLogToRenderer(`Error reading directory ${folderName}: ${readDirError.message}. Skipping.`, 'error'); return result; }
    const jsonFolder = path.join(folderPath, 'Json');
    try { if (!(await directoryExists(jsonFolder))) { /* sendLogToRenderer(`Creating JSON folder: ${jsonFolder}`); */ await fsPromises.mkdir(jsonFolder, { recursive: true }); } await yieldToUI(); }
    catch (mkdirError) { sendLogToRenderer(`Error creating JSON folder ${jsonFolder}: ${mkdirError.message}. Skipping.`, 'error'); return result; }
    let filesToProcess = [];
    if (processMode === 'all') filesToProcess = imageFiles;
    else { /* sendLogToRenderer(`Mode '${processMode}': Checking existing JSON files in ${folderName}...`); */ let jsonCheckedCount = 0; const filesWithoutJson = []; for (const imgFile of imageFiles) { const baseName = path.basename(imgFile, path.extname(imgFile)); const jsonPath = path.join(jsonFolder, `${baseName}.json`); const exists = await fileExists(jsonPath); if (!exists) filesWithoutJson.push(imgFile); jsonCheckedCount++; if (jsonCheckedCount % 100 === 0) await yieldToUI(); } filesToProcess = filesWithoutJson; sendLogToRenderer(`Mode '${processMode}': Targeting ${filesToProcess.length} images (out of ${imageFiles.length}) in ${folderName}.`); }
    await yieldToUI(); result.total += filesToProcess.length;
    let folderProcessingLog = [];
    if (filesToProcess.length > 0 && !processingState.isCanceled) {
        // sendLogToRenderer(`Processing ${filesToProcess.length} files in ${folderName} using ${apiEndpoints.length} instance(s)...`); // Less verbose
        let folderResult; if (apiEndpoints.length > 1) folderResult = await processWithMultipleInstances(folderPath, filesToProcess, jsonFolder, apiEndpoints);
        else { let currentLog = []; let processedInFolder = 0; const batchSize = MAX_CONCURRENT_CONNECTIONS_PER_INSTANCE * 3; while(processedInFolder < filesToProcess.length && !processingState.isCanceled) { const batchResult = await processBatch(folderPath, filesToProcess, jsonFolder, apiEndpoints[0], processedInFolder, batchSize, 0); currentLog = currentLog.concat(batchResult.processedLog); processedInFolder += batchResult.processedLog.length; mainWindow.webContents.send('progress-folder', { current: processedInFolder, total: filesToProcess.length, folder: folderPath, file: '' }); await yieldToUI(); } folderResult = { success: currentLog.filter(r=>r.status==='success').length, failed: currentLog.filter(r=>r.status==='failed').length, skipped: currentLog.filter(r=>r.status==='skipped').length, processedLog: currentLog }; }
        folderProcessingLog = folderResult.processedLog; result.processed += folderProcessingLog.length; result.success += folderResult.success; result.failed += folderResult.failed; result.skipped += folderResult.skipped;
        if (folderProcessingLog.length > 0) { const totalLogged = await saveProcessingLog(folderPath, folderProcessingLog); if (totalLogged === -1) sendLogToRenderer(`Failed to save log for ${folderName}.`, 'error'); }
        // sendLogToRenderer(`Folder ${folderName} finished. Success: ${folderResult.success}, Failed: ${folderResult.failed}, Skipped: ${folderResult.skipped}.`);
    } else if (filesToProcess.length === 0) { /* sendLogToRenderer(`No files to process in ${folderName} based on mode.`); */ }
    else { /* sendLogToRenderer(`Skipping file processing in ${folderName} due to cancellation.`); */ } await yieldToUI();
    if (includeSubfolders && subfolders.length > 0 && !processingState.isCanceled) {
      // sendLogToRenderer(`Processing ${subfolders.length} subfolders within ${folderName}...`); // Less verbose
      await yieldToUI(); for (const subfolder of subfolders) { if (processingState.isCanceled) break; const subfolderResult = await processFolder(subfolder, apiEndpoints, confidenceThreshold, processMode, includeSubfolders); result.total += subfolderResult.total; result.processed += subfolderResult.processed; result.success += subfolderResult.success; result.failed += subfolderResult.failed; result.skipped += subfolderResult.skipped; await yieldToUI(); if (processingState.isCanceled) { /* sendLogToRenderer(`Subfolder processing stopped in ${folderName}.`); */ break; } }
      // if (!processingState.isCanceled) sendLogToRenderer(`Finished processing subfolders in ${folderName}.`);
    }
  } catch (error) { console.error(`Error processing folder ${folderPath}:`, error); sendLogToRenderer(`FATAL error processing folder ${folderName}: ${error.message}`, 'error'); }
  // sendLogToRenderer(`--- Completed folder: ${folderName} ---`); // Less verbose
  await yieldToUI(); return result;
}

// --- Main Process Images Handler --- (Ensure uses fsPromises in cleanup/checks if needed, though likely not)
ipcMain.handle('process-images', async (event, data) => { /* ... largely as before ... check docker availability, start instances, init health, loop folders, aggregate results, cleanup ... */
  const { folders, apiEndpoint: defaultApiEndpoint, confidenceThreshold, processMode, includeSubfolders, apiInstances } = data;
  if (isProcessing) throw new Error('Processing is already in progress.');
  isProcessing = true; processingState = { isPaused: false, isCanceled: false }; clearCorruptedFiles(); logCounter = 0;
  sendLogToRenderer(`=== Starting New Processing Job ===`); sendLogToRenderer(`Folders: ${folders.length}, Mode: ${processMode}, Subfolders: ${includeSubfolders}, Instances: ${apiInstances}`); await yieldToUI();
  if (!(await checkDockerAvailability())) { isProcessing = false; throw new Error("Docker not available/running."); }
  let apiEndpoints = []; instanceRegistry = { isPermanentInstanceRunning: false, permanentInstanceId: null, additionalInstances: [] }; instanceHealthStatus = []; connectionPools = {};
  try {
    sendLogToRenderer('Setting up Docker instances...'); let permanentReady = false; let permanentContainerId = null;
    if (await checkApiRunning(PERMANENT_INSTANCE_PORT)) { /* sendLogToRenderer(`Permanent instance (Port ${PERMANENT_INSTANCE_PORT}) already running.`); */ permanentReady = true; }
    else { /* sendLogToRenderer(`Attempting to start permanent instance on port ${PERMANENT_INSTANCE_PORT}...`); */ if (await isPortInUse(PERMANENT_INSTANCE_PORT)) throw new Error(`Port ${PERMANENT_INSTANCE_PORT} blocked.`); else { permanentContainerId = await startContainer(PERMANENT_INSTANCE_PORT, 0); if (permanentContainerId) { permanentReady = await waitForApiReady(PERMANENT_INSTANCE_PORT); if (!permanentReady) { sendLogToRenderer(`Permanent instance failed readiness check. Stopping...`, 'error'); await stopContainer(permanentContainerId, PERMANENT_INSTANCE_PORT, 0); permanentContainerId = null; } } } }
    if (permanentReady) { instanceRegistry.isPermanentInstanceRunning = true; instanceRegistry.permanentInstanceId = permanentContainerId; apiEndpoints.push(`http://localhost:${PERMANENT_INSTANCE_PORT}/evaluate`); }
    else if (apiInstances <= 1) throw new Error(`Failed permanent instance on port ${PERMANENT_INSTANCE_PORT}.`); else sendLogToRenderer(`Permanent instance failed, proceeding with additional instances only.`, 'warning');
    if (apiInstances > 1) { /* sendLogToRenderer(`Setting up ${apiInstances - 1} additional instance(s)...`); */ let additionalInstancesStarted = 0; for (let i = 0; i < apiInstances - 1; i++) { const port = ADDITIONAL_INSTANCE_START_PORT + i; const instanceIndex = i + 1; let instanceReady = false; let instanceContainerId = null; if (await checkApiRunning(port)) { /* sendLogToRenderer(`Additional instance #${instanceIndex+1} (Port ${port}) already running.`); */ instanceReady = true; } else if (await isPortInUse(port)) { sendLogToRenderer(`Port ${port} in use but API not responding. Skipping additional instance #${instanceIndex + 1}.`, 'error'); continue; } else { instanceContainerId = await startContainer(port, instanceIndex); if (instanceContainerId) { instanceReady = await waitForApiReady(port); if (!instanceReady) { sendLogToRenderer(`Additional instance #${instanceIndex+1} (Port ${port}) failed readiness. Stopping...`, 'warning'); await stopContainer(instanceContainerId, port, instanceIndex); instanceContainerId = null; } } } if (instanceReady) { apiEndpoints.push(`http://localhost:${port}/evaluate`); instanceRegistry.additionalInstances.push({ containerId: instanceContainerId, port }); additionalInstancesStarted++; } await yieldToUI(); if (processingState.isCanceled) break; } /* sendLogToRenderer(`Successfully prepared ${additionalInstancesStarted} additional instance(s).`); */ }
    if (apiEndpoints.length === 0) throw new Error("No API instances ready."); sendLogToRenderer(`=== Processing starting with ${apiEndpoints.length} active API instance(s) ===`);
    initializeInstanceHealth(apiEndpoints.length); if (healthCheckInterval) clearInterval(healthCheckInterval); healthCheckInterval = setInterval(async () => { if (!isProcessing || processingState.isCanceled) { if (healthCheckInterval) clearInterval(healthCheckInterval); healthCheckInterval = null; return; } try { await checkAndRecoverInstances(); } catch (hcError) { sendLogToRenderer(`Periodic health check error: ${hcError.message}`, 'error'); } }, 5 * 60 * 1000);
    let overallTotal = 0, overallProcessed = 0, overallSuccess = 0, overallFailed = 0, overallSkipped = 0;
    for (let i = 0; i < folders.length; i++) { if (processingState.isCanceled) { sendLogToRenderer(`Processing stopped after ${i} folders due to cancellation.`); break; } const folder = folders[i]; mainWindow.webContents.send('progress-overall', { current: i + 1, total: folders.length, folder: folder }); await yieldToUI(); const folderResult = await processFolder(folder, apiEndpoints, confidenceThreshold, processMode, includeSubfolders); overallTotal += folderResult.total; overallProcessed += folderResult.processed; overallSuccess += folderResult.success; overallFailed += folderResult.failed; overallSkipped += folderResult.skipped; }
    sendLogToRenderer('=== Overall Processing Summary ===', 'success'); sendLogToRenderer(`Folders processed: ${processingState.isCanceled ? 'Partial' : folders.length} / ${folders.length}`); sendLogToRenderer(`Target image files: ${overallTotal}`); sendLogToRenderer(`Attempted processing: ${overallProcessed}`); sendLogToRenderer(`Successful: ${overallSuccess}`, 'success'); sendLogToRenderer(`Failed: ${overallFailed}`, overallFailed > 0 ? 'error' : 'info'); sendLogToRenderer(`Skipped (potential corruption): ${overallSkipped}`, overallSkipped > 0 ? 'warning' : 'info'); if (processingState.isCanceled) sendLogToRenderer('Processing was CANCELED by the user.', 'warning');
    return { folderCount: folders.length, total: overallTotal, processed: overallProcessed, success: overallSuccess, failed: overallFailed, skipped: overallSkipped, canceled: processingState.isCanceled, instancesUsed: apiEndpoints.length };
  } catch (error) { console.error('Error during image processing job:', error); sendLogToRenderer(`FATAL PROCESSING ERROR: ${error.message}`, 'error'); mainWindow.webContents.send('processing-canceled'); throw error;
  } finally { sendLogToRenderer('=== Processing job finished. Starting cleanup... ==='); isProcessing = false; if (healthCheckInterval) clearInterval(healthCheckInterval); healthCheckInterval = null; /* sendLogToRenderer('Stopped periodic health checks.'); */ sendLogToRenderer(`Waiting ${CONNECTION_COOLDOWN_MS/1000}s for connection cooldown...`); await new Promise(resolve => setTimeout(resolve, CONNECTION_COOLDOWN_MS)); await stopAdditionalContainers(); Object.keys(connectionPools).forEach(key => resetConnectionPool(parseInt(key, 10))); /* sendLogToRenderer('Connection pools reset.'); */ sendLogToRenderer('=== Cleanup complete ==='); await yieldToUI(); }
});
// --- END OF index.js ---
