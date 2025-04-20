// --- START OF index.js (v1.4.7 - Fixed Global Progress Counter) ---
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');             // Base fs module
const fsPromises = fs.promises; // Promises API
const fsSync = require('fs');         // Sync for createReadStream
const path = require('path');
const { exec } = require('child_process');
const http = require('http');
const https = require('https');
const os = require('os');
const dns = require('dns').promises;
const net = require('net');
const readline = require('readline'); // For reading line-delimited JSON logs

// --- Configuration Constants ---
const PERMANENT_INSTANCE_PORT = 5000;
const ADDITIONAL_INSTANCE_START_PORT = 5001; // Base port for additional instances
const CONNECTION_COOLDOWN_MS = 5000; // Cooldown before stopping containers
const MAX_CONCURRENT_CONNECTIONS_PER_INSTANCE = 1; // *** IMPORTANT: Start with 1 when using many instances ***
const SOCKET_TIMEOUT_MS = 45000; // Timeout for underlying socket connection
const REQUEST_TIMEOUT_MS = 90000; // Timeout for the entire Axios request
const CONNECTION_RESET_THRESHOLD = 5; // Consecutive failures before marking instance unhealthy
const MAX_FILE_RETRIES = 3; // Retries per image file before marking as skipped/corrupted
const DOCKER_STARTUP_TIMEOUT_MS = 90000; // Increased timeout for Docker container readiness check (esp. on first pull)
const DOCKER_POLL_INTERVAL_MS = 2500; // How often to check if API is ready during startup
const STAGGERED_STARTUP_BATCH_SIZE = 3; // Start additional instances in batches of this size
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']); // Define globally

// --- Global State ---
let mainWindow;
let processingState = { isPaused: false, isCanceled: false };
let isProcessing = false;
let healthCheckInterval = null;
let logCounter = 0; // Counter for potentially throttling UI updates

// --- Instance Management State ---
let instanceRegistry = { isPermanentInstanceRunning: false, permanentInstanceId: null, additionalInstances: [] };
let instanceHealthStatus = []; // Tracks health (failures, etc.) per instance index
let connectionPools = {}; // Holds http.Agent instances per instance index

// --- Corrupted File Tracking ---
const corruptedFiles = new Map(); // Tracks filePath -> retryCount

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
async function fileExists(filePath) {
  try { await fsPromises.access(filePath, fs.constants.F_OK); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; console.warn(`access error ${filePath}: ${error.message}`); return false;}
}
async function directoryExists(dirPath) {
    try { const stats = await fsPromises.stat(dirPath); return stats.isDirectory(); }
    catch (error) { if (error.code === 'ENOENT') return false; console.warn(`stat error ${dirPath}: ${error.message}`); return false; }
}
function yieldToUI() {
  return new Promise(resolve => { setImmediate(() => { if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) mainWindow.webContents.send('force-update'); setTimeout(resolve, 0); }); });
}
function sendLogToRenderer(message, type = '') {
  if (!mainWindow || mainWindow.isDestroyed()) return; const logMessage = (typeof message === 'string') ? message : JSON.stringify(message); mainWindow.webContents.send('log', logMessage, type); logCounter++; if (type === 'error' || type === 'warning' || logCounter % 50 === 0) { if (!mainWindow.isFocused()) mainWindow.webContents.send('force-update'); }
}
async function isPortInUse(port) {
  return new Promise((resolve) => { const server = net.createServer(); server.once('error', (err) => resolve(err.code === 'EADDRINUSE')); server.once('listening', () => server.close(() => resolve(false))); server.on('close', () => {}); server.listen(port, '127.0.0.1'); });
}

// --- HTTP Agent & Axios Instance Management ---
const createHttpAgent = (instanceIndex) => {
  return new http.Agent({ keepAlive: true, maxSockets: MAX_CONCURRENT_CONNECTIONS_PER_INSTANCE, maxFreeSockets: Math.max(1, Math.floor(MAX_CONCURRENT_CONNECTIONS_PER_INSTANCE / 2)), timeout: SOCKET_TIMEOUT_MS, freeSocketTimeout: 30000, scheduling: 'lifo', name: `autotagger-agent-${instanceIndex}` });
};
function createAxiosInstance(instanceIndex) {
  if (!connectionPools[instanceIndex]) { sendLogToRenderer(`Creating new connection pool for instance #${instanceIndex + 1}`, 'info'); connectionPools[instanceIndex] = createHttpAgent(instanceIndex); }
  return axios.create({ httpAgent: connectionPools[instanceIndex], httpsAgent: connectionPools[instanceIndex], timeout: REQUEST_TIMEOUT_MS, maxRedirects: 3, validateStatus: (status) => status >= 200 && status < 500, maxContentLength: Infinity, maxBodyLength: Infinity });
}
function resetConnectionPool(instanceIndex) {
  if (connectionPools[instanceIndex]) { sendLogToRenderer(`Resetting connection pool for instance #${instanceIndex + 1}.`, 'info'); try { connectionPools[instanceIndex].destroy(); } catch (e) { sendLogToRenderer(`Error destroying pool #${instanceIndex + 1}: ${e.message}`, 'error'); } delete connectionPools[instanceIndex]; }
}

// --- API & Docker Instance Health Checks ---
async function checkApiRunning(port, timeout = 5000) {
    const url = `http://localhost:${port}`; try { const healthCheckAxios = axios.create({ timeout: timeout, validateStatus: () => true, httpAgent: new http.Agent({ keepAlive: false }), httpsAgent: new https.Agent({ keepAlive: false }) }); const response = await healthCheckAxios.get(url); return response.status < 500; } catch (error) { return false; }
}
async function waitForApiReady(port, totalTimeout = DOCKER_STARTUP_TIMEOUT_MS, pollInterval = DOCKER_POLL_INTERVAL_MS) {
    const startTime = Date.now(); while (Date.now() - startTime < totalTimeout) { if (processingState.isCanceled) { sendLogToRenderer(`API wait canceled for port ${port}.`, 'warning'); return false; } if (await checkApiRunning(port, pollInterval * 0.8)) { await yieldToUI(); return true; } await yieldToUI(); await new Promise(resolve => setTimeout(resolve, pollInterval)); } sendLogToRenderer(`API on port ${port} did not ready in ${totalTimeout / 1000}s ✗`, 'error'); await yieldToUI(); return false;
}
function initializeInstanceHealth(instanceCount) {
  instanceHealthStatus = Array.from({ length: instanceCount }, (_, index) => ({ index: index, consecutiveFailures: 0, totalRequests: 0, successfulRequests: 0, isHealthy: true, }));
}
function updateInstanceHealth(instanceIndex, success) {
  if (!instanceHealthStatus[instanceIndex]) return; const health = instanceHealthStatus[instanceIndex]; health.totalRequests++; if (success) { health.successfulRequests++; if (!health.isHealthy) { sendLogToRenderer(`Instance #${instanceIndex + 1} recovered ✓`, 'success'); health.isHealthy = true; resetConnectionPool(instanceIndex); } health.consecutiveFailures = 0; } else { health.consecutiveFailures++; if (health.isHealthy && health.consecutiveFailures >= CONNECTION_RESET_THRESHOLD) { health.isHealthy = false; sendLogToRenderer(`Instance #${instanceIndex + 1} UNHEALTHY after ${CONNECTION_RESET_THRESHOLD} failures ✗`, 'error'); resetConnectionPool(instanceIndex); } }
}
function isInstanceHealthy(instanceIndex) {
  return instanceHealthStatus[instanceIndex]?.isHealthy ?? false;
}
async function checkAndRecoverInstances() {
  /* sendLogToRenderer('Periodic health check...'); */ await yieldToUI(); const instancesToCheck = [ ...(instanceRegistry.isPermanentInstanceRunning ? [{ port: PERMANENT_INSTANCE_PORT, index: 0, containerId: instanceRegistry.permanentInstanceId }] : []), ...instanceRegistry.additionalInstances.map((inst, i) => ({ port: inst.port, index: (instanceRegistry.isPermanentInstanceRunning ? 1 : 0) + i, containerId: inst.containerId })) ]; if (instancesToCheck.length === 0) return;
  for (const instanceInfo of instancesToCheck) { if (processingState.isCanceled) break; const { port, index, containerId } = instanceInfo; const wasHealthy = isInstanceHealthy(index); const isApiResponding = await checkApiRunning(port); await yieldToUI();
    if (!isApiResponding) { if (wasHealthy) { sendLogToRenderer(`Instance #${index + 1} (Port ${port}) unresponsive. Marking unhealthy, attempting recovery...`, 'error'); if (instanceHealthStatus[index]) instanceHealthStatus[index].isHealthy = false; resetConnectionPool(index); }
      try { if (containerId) await stopContainer(containerId, port, index); await yieldToUI(); if (await isPortInUse(port)) { sendLogToRenderer(`Port ${port} still in use. Cannot restart Instance #${index + 1}.`, 'error'); continue; } const newContainerId = await startContainer(port, index); await yieldToUI();
        if (newContainerId) { if (index === 0 && instanceRegistry.isPermanentInstanceRunning) instanceRegistry.permanentInstanceId = newContainerId; else { const regIndex = instanceRegistry.additionalInstances.findIndex(inst => inst.port === port); if (regIndex !== -1) instanceRegistry.additionalInstances[regIndex].containerId = newContainerId; } const recovered = await waitForApiReady(port);
           if (recovered && instanceHealthStatus[index]) { instanceHealthStatus[index].isHealthy = true; instanceHealthStatus[index].consecutiveFailures = 0; sendLogToRenderer(`Instance #${index + 1} (Port ${port}) RECOVERED ✓`, 'success'); resetConnectionPool(index); }
           else if (!recovered) { sendLogToRenderer(`Instance #${index + 1} (Port ${port}) failed recovery ✗`, 'error'); if (instanceHealthStatus[index]) instanceHealthStatus[index].isHealthy = false; await stopContainer(newContainerId, port, index); }
        } else { sendLogToRenderer(`Failed to start replacement container #${index + 1} ✗`, 'error'); if (instanceHealthStatus[index]) instanceHealthStatus[index].isHealthy = false; }
      } catch (error) { sendLogToRenderer(`Error during recovery #${index + 1}: ${error.message}`, 'error'); if (instanceHealthStatus[index]) instanceHealthStatus[index].isHealthy = false; }
    } else if (!wasHealthy) { sendLogToRenderer(`Instance #${index + 1} (Port ${port}) responding again ✓`, 'success'); if (instanceHealthStatus[index]) { instanceHealthStatus[index].isHealthy = true; instanceHealthStatus[index].consecutiveFailures = 0; } resetConnectionPool(index); } await yieldToUI();
  } await yieldToUI();
}

// --- Request Retry Logic ---
async function enhancedRetryRequest(fn, instanceIndex, maxRetries = MAX_FILE_RETRIES, initialDelay = 1500) {
  let lastError; for (let attempt = 1; attempt <= maxRetries; attempt++) { if (processingState.isCanceled) throw lastError || new Error('Processing canceled by user'); if (!isInstanceHealthy(instanceIndex)) { const healthMsg = `Instance #${instanceIndex + 1} unhealthy. Skip attempt ${attempt}.`; if (attempt === 1) sendLogToRenderer(healthMsg, 'warning'); throw lastError || new Error(healthMsg); } while (processingState.isPaused && !processingState.isCanceled) { await new Promise(resolve => setTimeout(resolve, 200)); await yieldToUI(); } if (processingState.isCanceled) throw lastError || new Error('Processing canceled by user');
    try { const result = await fn(); if (result?.status) { if (result.status >= 200 && result.status < 300) { updateInstanceHealth(instanceIndex, true); return result; } else if (result.status >= 400 && result.status < 500) { sendLogToRenderer(`Instance #${instanceIndex+1} API client error ${result.status}. No retry.`, 'warning'); updateInstanceHealth(instanceIndex, false); const clientError = new Error(`API client error ${result.status}`); clientError.isClientError = true; clientError.status = result.status; throw clientError; } else { throw new Error(`API unexpected status ${result.status}`); } } else { updateInstanceHealth(instanceIndex, true); return result; } }
    catch (error) { lastError = error; if (error.message === 'Processing canceled by user' || error.isClientError) throw error; const isNetworkError = error.code && ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ERR_SOCKET_CONNECTION_TIMEOUT'].includes(error.code); const isTimeoutError = error.message.toLowerCase().includes('timeout'); const isServerError = error.response && error.response.status >= 500;
      if (isNetworkError || isTimeoutError || isServerError) { sendLogToRenderer(`Instance #${instanceIndex+1} failed (Attempt ${attempt}/${maxRetries}): ${error.message}. Retrying...`, 'warning'); updateInstanceHealth(instanceIndex, false); if (attempt >= maxRetries) break; const backoff = initialDelay * Math.pow(1.8, attempt - 1); const jitter = backoff * (Math.random() * 0.4 + 0.8); const waitTime = Math.min(Math.max(500, jitter), 20000); const waitEndTime = Date.now() + waitTime; while(Date.now() < waitEndTime) { if (processingState.isCanceled) throw new Error('Canceled during retry wait'); if (processingState.isPaused) await new Promise(resolve => setTimeout(resolve, 200)); else await new Promise(resolve => setTimeout(resolve, Math.min(200, waitEndTime - Date.now()))); await yieldToUI(); } }
      else { sendLogToRenderer(`Instance #${instanceIndex+1} unexpected error (Attempt ${attempt}/${maxRetries}): ${error.message}. No retry.`, 'error'); updateInstanceHealth(instanceIndex, false); throw error; } } }
  sendLogToRenderer(`Instance #${instanceIndex+1} FAILED after ${maxRetries} attempts: ${lastError.message}`, 'error'); updateInstanceHealth(instanceIndex, false); throw lastError;
}

// --- Electron App Lifecycle & Window Management ---
function createWindow() {
  mainWindow = new BrowserWindow({ width: 850, height: 700, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, }, }); mainWindow.loadFile('index.html'); mainWindow.on('closed', () => { mainWindow = null; }); /* mainWindow.webContents.openDevTools(); */
}
app.whenReady().then(createWindow); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', async (event) => {
  if (isProcessing) { sendLogToRenderer('Quit requested during processing. Cancelling...', 'warning'); processingState.isCanceled = true; event.preventDefault(); await new Promise(resolve => setTimeout(resolve, 3000)); if (isProcessing) sendLogToRenderer('Forcing quit...'); } const hasActiveContainers = instanceRegistry.additionalInstances.length > 0 || (instanceRegistry.isPermanentInstanceRunning && instanceRegistry.permanentInstanceId); if (hasActiveContainers) { if (!event.defaultPrevented) event.preventDefault(); sendLogToRenderer('Shutting down Docker containers...'); try { await shutdownAllContainers(); } catch (error) { console.error("Pre-quit cleanup error:", error); } finally { app.quit(); } } else if (isProcessing && event.defaultPrevented) { app.quit(); }
});
const handleShutdown = async (signal) => {
    console.log(`Received ${signal}. Shutting down...`); sendLogToRenderer(`Received ${signal}. Shutting down...`, 'warning'); if (isProcessing) { processingState.isCanceled = true; await new Promise(resolve => setTimeout(resolve, 1500)); } try { await shutdownAllContainers(); } catch(error){ console.error("Signal cleanup error:", error); } finally { process.exit(0); }
};
process.on('SIGINT', () => handleShutdown('SIGINT')); process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('uncaughtException', async (error) => {
    console.error('--- UNCAUGHT EXCEPTION ---', error); if (mainWindow && !mainWindow.isDestroyed()) { sendLogToRenderer(`FATAL ERROR: ${error.message}\n${error.stack}`, 'error'); dialog.showErrorBox('Fatal Error', `Critical error:\n${error.message}\n\nCheck log & restart.`); } try { if (isProcessing) processingState.isCanceled = true; await shutdownAllContainers(); } catch (cleanupError) { console.error('Emergency cleanup error:', cleanupError); } finally { if (app && !app.isReady()) process.exit(1); else if (app) app.exit(1); else process.exit(1); }
});

// --- Docker Management Functions ---
async function checkDockerAvailability() {
    sendLogToRenderer('Checking Docker availability...'); return new Promise((resolve) => { exec('docker --version', (error, stdout, stderr) => { if (error) { sendLogToRenderer('Docker command failed.', 'error'); resolve(false); return; } exec('docker ps', (psError, psStdout, psStderr) => { if (psError) { sendLogToRenderer(`Docker daemon not responding: ${psStderr || psError.message}.`, 'error'); resolve(false); } else { sendLogToRenderer(`Docker available: ${stdout.trim()} & Daemon responding ✓`, 'success'); resolve(true); } }); }); });
}
async function startContainer(port, instanceIndex) {
    const imageName = 'ghcr.io/danbooru/autotagger'; const command = `docker run -d --rm -p ${port}:5000 ${imageName}`; sendLogToRenderer(`Starting Instance #${instanceIndex + 1} on host port ${port}...`); await yieldToUI(); return new Promise((resolve) => { exec(command, { timeout: 30000 }, (error, stdout, stderr) => { if (error) { const errorMsg = (stderr || error.message).trim(); sendLogToRenderer(`Failed start Instance #${instanceIndex + 1} (Port ${port}): ${errorMsg}`, 'error'); if (errorMsg.includes('port is already allocated')) sendLogToRenderer(`Error: Port ${port} already in use.`, 'error'); else if (errorMsg.includes('Cannot connect to the Docker daemon')) sendLogToRenderer(`Error: Cannot connect Docker daemon.`, 'error'); resolve(null); } else { const containerId = stdout.trim(); if (!containerId) { sendLogToRenderer(`Instance #${instanceIndex + 1} started but no container ID? Stderr: ${stderr}`, 'error'); resolve(null); } else { sendLogToRenderer(`Instance #${instanceIndex + 1} container started: ${containerId.substring(0, 12)}...`); resolve(containerId); } } }); });
}
async function stopContainer(containerId, port, instanceIndex) {
    if (!containerId) return true; const command = `docker stop ${containerId}`; await yieldToUI(); return new Promise((resolve) => { exec(command, { timeout: 20000 }, (error, stdout, stderr) => { if (error) { const errorMsg = (stderr || error.message).trim(); if (!errorMsg.includes('No such container')) sendLogToRenderer(`Warning stopping #${instanceIndex + 1} (Cont ${containerId.substring(0,12)}): ${errorMsg}`, 'warning'); } else sendLogToRenderer(`Instance #${instanceIndex + 1} (Cont ${stdout.trim().substring(0,12)}) stopped.`); resolve(true); }); });
}
async function stopAdditionalContainers() {
  if (instanceRegistry.additionalInstances.length === 0) return; sendLogToRenderer(`Stopping ${instanceRegistry.additionalInstances.length} additional instances...`); await yieldToUI(); const instancesToStop = [...instanceRegistry.additionalInstances]; instanceRegistry.additionalInstances = []; const stopPromises = instancesToStop.map((instance, i) => { const logIndex = (instanceRegistry.isPermanentInstanceRunning ? 1 : 0) + i; return stopContainer(instance.containerId, instance.port, logIndex); }); await Promise.all(stopPromises); for (let i = 0; i < instancesToStop.length; i++) { const logIndex = (instanceRegistry.isPermanentInstanceRunning ? 1 : 0) + i; resetConnectionPool(logIndex); } sendLogToRenderer('Additional instances stop issued.'); await yieldToUI();
}
async function shutdownAllContainers() {
  sendLogToRenderer('Shutting down all managed containers...'); const allInstancesToStop = [ ...instanceRegistry.additionalInstances.map((inst, i) => ({ ...inst, index: (instanceRegistry.isPermanentInstanceRunning ? 1 : 0) + i })), ...(instanceRegistry.isPermanentInstanceRunning && instanceRegistry.permanentInstanceId ? [{ containerId: instanceRegistry.permanentInstanceId, port: PERMANENT_INSTANCE_PORT, index: 0 }] : []) ]; const numToStop = allInstancesToStop.length; instanceRegistry.additionalInstances = []; instanceRegistry.permanentInstanceId = null; instanceRegistry.isPermanentInstanceRunning = false;
  if (numToStop > 0) { sendLogToRenderer(`Stopping ${numToStop} container(s)...`); const stopPromises = allInstancesToStop.map(inst => stopContainer(inst.containerId, inst.port, inst.index)); try { await Promise.all(stopPromises); sendLogToRenderer('All containers stop issued.'); } catch (stopError) { sendLogToRenderer(`Bulk stop error: ${stopError.message}`, 'error'); } } else sendLogToRenderer('No managed containers to stop.');
  const poolKeys = Object.keys(connectionPools); if (poolKeys.length > 0) poolKeys.forEach(key => resetConnectionPool(parseInt(key, 10))); connectionPools = {}; await yieldToUI();
}

// --- Function to Read Append-Style Log (NDJSON) ---
async function readAppendLogToMap(logFilePath) {
    const logDataMap = new Map(); if (!(await fileExists(logFilePath))) return logDataMap; let fileStream;
    try { fileStream = fs.createReadStream(logFilePath, { encoding: 'utf8' }); const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity }); let lineNumber = 0;
        for await (const line of rl) { lineNumber++; const trimmedLine = line.trim(); if (trimmedLine) { try { const entry = JSON.parse(trimmedLine); if (entry?.imagePath && typeof entry.imagePath === 'string') { const normalizedPath = path.normalize(entry.imagePath); logDataMap.set(normalizedPath, entry); } } catch (e) { sendLogToRenderer(`Warning: Skipping corrupted log line ${lineNumber}: ${e.message}`, 'warning'); } } if (lineNumber % 1000 === 0) await yieldToUI(); } return logDataMap;
    } catch (readError) { sendLogToRenderer(`Error reading log file ${logFilePath}: ${readError.message}`, 'error'); return new Map(); } finally { if (fileStream && !fileStream.destroyed) fileStream.destroy(); }
}

// --- IPC Handlers ---
ipcMain.handle('select-folder', async () => { // Single folder selector
    if (!mainWindow) {
        console.error("Main: Cannot show folder dialog: mainWindow is not available.");
        return null;
    }
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) {
        return null;
    } else {
        return result.filePaths[0];
    }
});

ipcMain.handle('select-folders', async () => { // <-- Handler for the "Browse..." button
    console.log("Main: Received 'select-folders' request.");
    if (!mainWindow) {
        console.error("Main: Cannot show folder dialog, mainWindow is null.");
        return [];
    }
    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: "Select Input Folder(s)",
            properties: ['openDirectory', 'multiSelections']
        });
        console.log("Main: dialog.showOpenDialog result:", result);
        if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
            console.log("Main: Folder selection canceled or no paths.");
            return [];
        } else {
            console.log("Main: Returning paths:", result.filePaths);
            return result.filePaths;
        }
    } catch (error) {
         console.error("Main: Error in 'select-folders' handler:", error);
         return [];
    }
});

ipcMain.handle('analyze-folder', async (event, inputFolder) => {
    await yieldToUI(); const results = { folderPath: inputFolder, hasJsonFolder: false, jsonCount: 0, logCount: 0, missingCount: 0, imageCount: 0, error: null }; try { const jsonFolder = path.join(inputFolder, 'Json'); const logFilePath = path.join(jsonFolder, 'processed_log.json'); results.hasJsonFolder = await directoryExists(jsonFolder); let existingLogMap = new Map(); if (results.hasJsonFolder) { results.jsonCount = (await fsPromises.readdir(jsonFolder)).filter(f => f.toLowerCase().endsWith('.json') && f !== 'processed_log.json').length; existingLogMap = await readAppendLogToMap(logFilePath); results.logCount = existingLogMap.size; let missingPaths = []; let checkCount = 0; for (const [normalizedImagePath, entry] of existingLogMap.entries()) { if (entry?.status === 'success') { const jsonName = path.basename(normalizedImagePath, path.extname(normalizedImagePath)) + '.json'; const expectedJsonPath = path.join(jsonFolder, jsonName); if (!(await fileExists(expectedJsonPath))) { missingPaths.push(normalizedImagePath); } } checkCount++; if (checkCount % 500 === 0) await yieldToUI(); } results.missingCount = missingPaths.length; if (results.missingCount > 0) sendLogToRenderer(`Analysis ${path.basename(inputFolder)}: ${results.missingCount} images logged success but missing JSON!`, 'warning'); } const imageExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']); const folderContents = await fsPromises.readdir(inputFolder); let imageFilesCount = 0; for(let i=0; i < folderContents.length; i++) { const file = folderContents[i]; const fullPath = path.join(inputFolder, file); try { const stats = await fsPromises.stat(fullPath); if (stats.isFile() && imageExts.has(path.extname(file).toLowerCase())) imageFilesCount++; } catch (statError) { if (statError.code !== 'ENOENT') console.warn(`Could not stat file ${fullPath}: ${statError.message}`); } if (i % 200 === 0) await yieldToUI(); } results.imageCount = imageFilesCount; } catch (error) { console.error(`Error analyzing folder ${inputFolder}:`, error); results.error = error.message; } return results;
});
ipcMain.handle('check-api-connection', async (event, apiBaseUrl = `http://localhost:${PERMANENT_INSTANCE_PORT}`) => {
    try { const isRunning = await checkApiRunning(parseInt(new URL(apiBaseUrl).port, 10) || PERMANENT_INSTANCE_PORT); return { success: true, isRunning }; } catch (error) { return { success: false, error: error.message }; }
});
ipcMain.on('toggle-pause', () => {
    processingState.isPaused = !processingState.isPaused; sendLogToRenderer(`Main process: Pause state toggled to ${processingState.isPaused}`); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pause-state-changed', processingState.isPaused);
});
ipcMain.on('cancel-processing', () => {
    if (!isProcessing) return; processingState.isCanceled = true; sendLogToRenderer('Main process: Cancel request received.', 'warning'); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('processing-canceled');
});


// --- Core Image Processing Logic ---
async function processSingleImageFile(imagePath, jsonFolder, apiEndpoint, instanceIndex) {
    const imageFile = path.basename(imagePath); const timestamp = new Date().toISOString(); if (isFileCorrupted(imagePath)) return { success: false, imagePath, timestamp, status: 'skipped', error: `Previously failed ${MAX_FILE_RETRIES} attempts` }; const jsonFileName = path.basename(imageFile, path.extname(imageFile)) + '.json'; const jsonFilePath = path.join(jsonFolder, jsonFileName); let fileStream = null;
    try { if (processingState.isCanceled) throw new Error('Processing canceled by user'); try { if (!(await fileExists(imagePath))) throw new Error(`Image file not found: ${imageFile}`); fileStream = fsSync.createReadStream(imagePath); } catch (streamError) { trackFileRetry(imagePath); return { success: false, imagePath, timestamp, status: 'failed', error: `Failed stream for ${imageFile}: ${streamError.message}` }; } fileStream.on('error', (streamReadError) => { sendLogToRenderer(`Error reading stream ${imageFile}: ${streamReadError.message}`, 'error'); if (fileStream && !fileStream.destroyed) fileStream.destroy(); }); const formData = new FormData(); formData.append('file', fileStream, { filename: imageFile }); formData.append('format', 'json'); const axiosInstance = createAxiosInstance(instanceIndex); const response = await enhancedRetryRequest(() => axiosInstance.post(apiEndpoint, formData, { headers: formData.getHeaders() }), instanceIndex); await fsPromises.writeFile(jsonFilePath, JSON.stringify(response.data, null, 2)); return { success: true, imagePath, timestamp, status: 'success' }; }
    catch (error) { const retryCount = trackFileRetry(imagePath); const isCorrupt = retryCount >= MAX_FILE_RETRIES; let status = 'failed'; if (processingState.isCanceled) status = 'canceled'; else if (isCorrupt) status = 'skipped'; const errorMsg = error.message || 'Unknown error during processing'; if (status === 'skipped') sendLogToRenderer(`Instance #${instanceIndex+1}: File ${imageFile} marked CORRUPTED after ${retryCount} attempts: ${errorMsg} ✗`, 'error'); else if (status === 'failed') { if (error.isClientError) sendLogToRenderer(`Instance #${instanceIndex+1}: API Client Error ${error.status} for ${imageFile}. Won't retry. ✗`, 'error'); else sendLogToRenderer(`Instance #${instanceIndex+1}: Error processing ${imageFile} (Attempt ${retryCount}/${MAX_FILE_RETRIES}): ${errorMsg} ✗`, 'warning'); } return { success: false, imagePath, timestamp, status: status, error: errorMsg }; }
    finally { if (fileStream && !fileStream.destroyed) fileStream.destroy(); }
}

// --- processBatch: Add callback param and call it ---
async function processBatch(folderPath, imageFiles, jsonFolder, apiEndpoint, startIndex, batchSize, instanceIndex = 0, reportGlobalProgress) { // Added reportGlobalProgress
    const batchLog = [];
    const endIndex = Math.min(startIndex + batchSize, imageFiles.length);
    const totalInFolder = imageFiles.length; // For instance progress

    // --- Progress Tracking (for single instance) ---
    const instanceTotalEst = totalInFolder;
    let instanceCurrent = startIndex;

    function updateInstanceProgressUI_Single(file = '') {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('progress-instance', {
                instance: instanceIndex, current: instanceCurrent, total: instanceTotalEst, folder: folderPath, file: file
            });
        }
    }
    updateInstanceProgressUI_Single();

    for (let i = startIndex; i < endIndex; i++) {
        const imageFile = imageFiles[i];
        const imagePath = path.join(folderPath, imageFile);

        if (processingState.isCanceled) break;
        while (processingState.isPaused && !processingState.isCanceled) { await new Promise(resolve => setTimeout(resolve, 200)); await yieldToUI(); }
        if (processingState.isCanceled) break;

        instanceCurrent = i;
        updateInstanceProgressUI_Single(imageFile);
        await yieldToUI();

        const result = await processSingleImageFile(imagePath, jsonFolder, apiEndpoint, instanceIndex);
        batchLog.push(result);

        // --- Call Global Progress Callback ---
        // Only report if not canceled during the file process itself (status will reflect)
        if (result.status !== 'canceled' || !processingState.isCanceled) {
             reportGlobalProgress(result.status); // Call the passed-in callback
        }
        // ------------------------------------

        await yieldToUI(); // Yield after reporting
    }

    instanceCurrent = Math.min(endIndex, totalInFolder);
    updateInstanceProgressUI_Single(); // Clear filename

    const success = batchLog.filter(r => r.status === 'success').length;
    const failed = batchLog.filter(r => r.status === 'failed').length;
    const skipped = batchLog.filter(r => r.status === 'skipped').length;

    return { success, failed, skipped, processedLog: batchLog };
}


// --- processWithMultipleInstances: Add callback param and use it in worker ---
async function processWithMultipleInstances(folderPath, imageFiles, jsonFolder, apiEndpoints, reportGlobalProgress) { // Added reportGlobalProgress
  const imageQueue = [...imageFiles];
  const totalFilesInFolder = imageFiles.length; // For instance progress
  const resultsLog = []; // Still needed for saving log file
  const instanceCount = apiEndpoints.length;
  const instanceTotalEst = Math.ceil(totalFilesInFolder / instanceCount) || 1;
  const instanceProgress = Array.from({ length: instanceCount }, () => ({ current: 0, file: '' }));

  function updateInstanceProgressUI(instanceIndex) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('progress-instance', { instance: instanceIndex, current: instanceProgress[instanceIndex].current, total: instanceTotalEst, folder: folderPath, file: instanceProgress[instanceIndex].file }); }

  async function instanceWorker(instanceIndex, endpoint) {
      while (true) {
          if (processingState.isCanceled || !isInstanceHealthy(instanceIndex)) break;
          while (processingState.isPaused && !processingState.isCanceled) { await new Promise(resolve => setTimeout(resolve, 200)); await yieldToUI(); }
          if (processingState.isCanceled) break;

          const imageFile = imageQueue.shift();
          if (!imageFile) break;

          const imagePath = path.join(folderPath, imageFile);
          instanceProgress[instanceIndex].current++;
          instanceProgress[instanceIndex].file = imageFile;
          updateInstanceProgressUI(instanceIndex);
          await yieldToUI();

          const result = await processSingleImageFile(imagePath, jsonFolder, endpoint, instanceIndex);
          resultsLog.push(result); // Add to log for this folder

          // --- Call Global Progress Callback ---
          if (result.status !== 'canceled' || !processingState.isCanceled) {
              reportGlobalProgress(result.status); // Use the callback passed to parent function
          }
          // -----------------------------------

          instanceProgress[instanceIndex].file = ''; // Clear filename in instance progress
          updateInstanceProgressUI(instanceIndex);
          await yieldToUI(); // Yield after reporting
      }
      instanceProgress[instanceIndex].file = ''; // Final clear
      updateInstanceProgressUI(instanceIndex);
  }

  const workerPromises = apiEndpoints.map((endpoint, index) =>
    isInstanceHealthy(index)
    ? instanceWorker(index, endpoint) // worker calls reportGlobalProgress via closure
    : (sendLogToRenderer(`Instance #${index+1} unhealthy, worker not started.`, 'warning'), Promise.resolve())
  );
  await Promise.all(workerPromises);

  // Calculate results *for this specific folder* based on the log collected by workers
  const finalSuccess = resultsLog.filter(r => r.status === 'success').length;
  const finalFailed = resultsLog.filter(r => r.status === 'failed').length;
  let finalSkipped = resultsLog.filter(r => r.status === 'skipped').length;
  const finalCanceled = resultsLog.filter(r => r.status === 'canceled').length; // Check if needed

  if (finalCanceled > 0) sendLogToRenderer(`Folder ${path.basename(folderPath)}: ${finalCanceled} ops canceled during processing.`, 'warning');
  if (imageQueue.length > 0) { // Files left in queue due to cancel/unhealthy instance
      sendLogToRenderer(`Folder ${path.basename(folderPath)}: ${imageQueue.length} files unprocessed. Adding as skipped.`, 'warning');
      imageQueue.forEach(unprocessedFile => resultsLog.push({ success: false, imagePath: path.join(folderPath, unprocessedFile), timestamp: new Date().toISOString(), status: processingState.isCanceled ? 'canceled' : 'skipped', error: 'Not processed' }));
      finalSkipped += imageQueue.length; // Count these towards skipped for the folder summary
  }
  // Return results specifically for *this folder* to allow log saving
  return { success: finalSuccess, failed: finalFailed, skipped: finalSkipped, processedLog: resultsLog };
}


// --- Folder Processing: Add callback param and pass it down ---
async function processFolder(folderPath, apiEndpoints, confidenceThreshold, processMode, includeSubfolders, reportGlobalProgress) { // Added reportGlobalProgress
    const folderName = path.basename(folderPath);
    await yieldToUI();
    const resultSummary = { folder: folderPath, targeted: 0, savedLogEntries: 0 }; // Minimal summary for this folder

    try {
        let imageFiles = []; let subfolders = [];
        try {
            const dirents = await fsPromises.readdir(folderPath, { withFileTypes: true });
            for (let i = 0; i < dirents.length; i++) {
                 const d = dirents[i];
                 const isIgnoredDir = d.name === 'Json' || d.name.startsWith('.') || d.name.toLowerCase() === '$recycle.bin' || d.name.toLowerCase() === 'system volume information';
                 if (d.isDirectory() && !isIgnoredDir) {
                    if (includeSubfolders) subfolders.push(path.join(folderPath, d.name)); // Only add if includeSubfolders is true
                 } else if (d.isFile() && IMAGE_EXTENSIONS.has(path.extname(d.name).toLowerCase())) {
                     imageFiles.push(d.name);
                 }
                 if (i % 200 === 0) await yieldToUI();
            }
        } catch (readDirError) {
            sendLogToRenderer(`Error reading ${folderName}: ${readDirError.message}`, 'error');
            return; // Stop processing this folder on read error
        }

        const jsonFolder = path.join(folderPath, 'Json');
        try {
            if (!(await directoryExists(jsonFolder))) await fsPromises.mkdir(jsonFolder, { recursive: true });
            await yieldToUI();
        } catch (mkdirError) {
            sendLogToRenderer(`Error creating Json dir ${folderName}: ${mkdirError.message}`, 'error');
            return; // Stop processing this folder if Json dir fails
        }

        let filesToProcess = [];
        if (processMode === 'all') {
            filesToProcess = imageFiles;
        } else {
            // sendLogToRenderer(`Mode '${processMode}': Analyzing ${folderName}...`);
            await yieldToUI();
            const existingLogMap = await readAppendLogToMap(path.join(jsonFolder, 'processed_log.json'));
            const DEBUG_NEW_MODE = false; // Keep debug flag local if needed
            if (DEBUG_NEW_MODE && processMode === 'new') sendLogToRenderer(`[DEBUG] Read ${existingLogMap.size} log entries for ${folderName}`);
            let checkCount = 0;
            for (const imgFile of imageFiles) {
                const imgFullPath = path.join(folderPath, imgFile);
                const normalizedPath = path.normalize(imgFullPath);
                const baseName = path.basename(imgFile, path.extname(imgFile));
                const jsonPath = path.join(jsonFolder, `${baseName}.json`);
                let shouldProcess = false;
                const logEntry = existingLogMap.get(normalizedPath);

                if (processMode === 'new') {
                    if (!logEntry) { shouldProcess = true; if (DEBUG_NEW_MODE) sendLogToRenderer(`[DEBUG] ${imgFile} - Not in log. Process: true`); }
                    else if (logEntry.status !== 'success') { shouldProcess = true; if (DEBUG_NEW_MODE) sendLogToRenderer(`[DEBUG] ${imgFile} - In log, status=${logEntry.status}. Process: true`); }
                    else { if (DEBUG_NEW_MODE) sendLogToRenderer(`[DEBUG] ${imgFile} - In log, status=success. Process: false`); }
                } else if (processMode === 'missing') {
                    if (!(await fileExists(jsonPath))) { shouldProcess = true; }
                }

                if (shouldProcess) filesToProcess.push(imgFile);
                checkCount++;
                if (checkCount % 200 === 0) await yieldToUI();
            }
            sendLogToRenderer(`Mode '${processMode}': Targeting ${filesToProcess.length}/${imageFiles.length} images in ${folderName}.`);
        }
        resultSummary.targeted = filesToProcess.length;

        await yieldToUI();
        let folderProcessingLog = []; // Log for this folder's processed files

        if (filesToProcess.length > 0 && !processingState.isCanceled) {
            let folderResult; // Captures {success, failed, skipped, processedLog} for THIS folder
            if (apiEndpoints.length > 1) {
                folderResult = await processWithMultipleInstances(folderPath, filesToProcess, jsonFolder, apiEndpoints, reportGlobalProgress);
            } else if (apiEndpoints.length === 1) {
                let currentLog = [];
                let processedInFolder = 0;
                const batchSize = Math.max(5, MAX_CONCURRENT_CONNECTIONS_PER_INSTANCE * 5);
                while(processedInFolder < filesToProcess.length && !processingState.isCanceled) {
                    const batchResult = await processBatch(folderPath, filesToProcess, jsonFolder, apiEndpoints[0], processedInFolder, batchSize, 0, reportGlobalProgress);
                    currentLog = currentLog.concat(batchResult.processedLog);
                    processedInFolder += batchResult.processedLog.length;
                    await yieldToUI();
                }
                folderResult = {
                    success: currentLog.filter(r=>r.status==='success').length,
                    failed: currentLog.filter(r=>r.status==='failed').length,
                    skipped: currentLog.filter(r=>r.status==='skipped').length,
                    processedLog: currentLog
                 };
            } else {
                sendLogToRenderer(`Error: No API endpoints available for ${folderName}. Skipping ${filesToProcess.length} files.`, 'error');
                filesToProcess.forEach(() => reportGlobalProgress('skipped')); // Mark globally skipped
                folderResult = { success: 0, failed: 0, skipped: filesToProcess.length, processedLog: [] };
            }

            folderProcessingLog = folderResult.processedLog; // Use the log from the processing functions
            // *** No global counter updates here ***

            if (folderProcessingLog.length > 0) {
                const entriesWritten = await saveProcessingLog(folderPath, folderProcessingLog);
                resultSummary.savedLogEntries = entriesWritten;
                if (entriesWritten === -1) sendLogToRenderer(`Failed save log ${folderName}.`, 'error');
                else if (entriesWritten < folderProcessingLog.length) sendLogToRenderer(`Warn: ${entriesWritten}/${folderProcessingLog.length} log entries written ${folderName}.`, 'warning');
            }
        } else if (filesToProcess.length === 0) {
            // No files targeted in this folder
        } else { // Canceled before processing this folder's files
            sendLogToRenderer(`Skip processing ${folderName} due to cancel. ${filesToProcess.length} files were targeted.`);
            // Don't mark as skipped globally if canceled before start
        }
        await yieldToUI();

        // Recursive Call (only if not canceled and subfolders exist)
        if (includeSubfolders && subfolders.length > 0 && !processingState.isCanceled) {
            for (const subfolder of subfolders) {
                if (processingState.isCanceled) break;
                // Pass callback down recursively
                await processFolder(subfolder, apiEndpoints, confidenceThreshold, processMode, includeSubfolders, reportGlobalProgress);
                await yieldToUI();
                if (processingState.isCanceled) break;
            }
        }
    } catch (error) {
        console.error(`Error processing folder ${folderPath}:`, error);
        sendLogToRenderer(`FATAL folder error ${folderName}: ${error.message}`, 'error');
    }
    await yieldToUI();
    // No need to return resultSummary unless debugging per-folder counts
}


// --- Function to Save Processing Log ---
async function saveProcessingLog(inputFolder, newEntries) {
    if (!newEntries || newEntries.length === 0) return 0;
    const jsonFolder = path.join(inputFolder, 'Json');
    const logFilePath = path.join(jsonFolder, 'processed_log.json');
    let logStream = null;
    try {
        if (!(await directoryExists(jsonFolder))) await fsPromises.mkdir(jsonFolder, { recursive: true });
        logStream = fs.createWriteStream(logFilePath, { flags: 'a', encoding: 'utf8' });
        return new Promise((resolve, reject) => {
            let entriesWritten = 0;
            let streamError = null;
            logStream.on('error', (err) => { console.error('Log stream error:', err); streamError = err; if (logStream && !logStream.destroyed) logStream.destroy(); resolve(entriesWritten); }); // Resolve with count even on error
            logStream.on('finish', () => { if (!streamError) resolve(entriesWritten); });
            logStream.on('close', () => { if (!logStream.writableFinished && !streamError) resolve(entriesWritten); }); // Ensure resolution if closed prematurely
            newEntries.forEach(entry => { if (entry?.imagePath) { try { logStream.write(JSON.stringify(entry) + '\n'); entriesWritten++; } catch (stringifyError) { console.error('Log stringify error:', stringifyError); } } });
            logStream.end();
        });
    } catch (error) {
        console.error('Log setup error:', error);
        if (logStream && !logStream.destroyed) logStream.destroy();
        return -1; // Indicate setup error
    } finally {
       // Ensure stream is closed/destroyed in all paths if necessary
       // The promise above should handle closing on 'finish' or 'error'
    }
}


// --- Helper: Pre-scan folders to get total image count ---
async function getTotalImageCount(folders, processMode, includeSubfolders) {
    let totalCount = 0;
    const foldersToScan = [...folders];
    let scannedFolders = 0;

    sendLogToRenderer("Pre-scanning folders to calculate total image count...");
    await yieldToUI();

    while (foldersToScan.length > 0) {
        if (processingState.isCanceled) throw new Error("Scan canceled by user.");

        const currentFolder = foldersToScan.shift();
        scannedFolders++;
        if (scannedFolders % 10 === 0) {
             sendLogToRenderer(`Scanning folder ${scannedFolders}... (${path.basename(currentFolder)})`);
             await yieldToUI();
        }

        let imageFilesInFolder = [];
        let subfoldersInFolder = [];

        try {
            const dirents = await fsPromises.readdir(currentFolder, { withFileTypes: true });
            for (const d of dirents) {
                const isIgnoredDir = d.name === 'Json' || d.name.startsWith('.') || d.name.toLowerCase() === '$recycle.bin' || d.name.toLowerCase() === 'system volume information';
                if (d.isDirectory() && !isIgnoredDir) {
                     if (includeSubfolders) subfoldersInFolder.push(path.join(currentFolder, d.name)); // Only add if including subfolders
                } else if (d.isFile() && IMAGE_EXTENSIONS.has(path.extname(d.name).toLowerCase())) {
                    imageFilesInFolder.push(d.name);
                }
            }
            foldersToScan.push(...subfoldersInFolder); // Add discovered subfolders to the queue
        } catch (readDirError) {
            sendLogToRenderer(`Warning: Cannot scan directory ${path.basename(currentFolder)}: ${readDirError.message}. Skipping for count.`, 'warning');
            continue;
        }

        // --- Count based on mode ---
        if (processMode === 'all') {
            totalCount += imageFilesInFolder.length;
        } else {
            const jsonFolder = path.join(currentFolder, 'Json');
            const logFilePath = path.join(jsonFolder, 'processed_log.json');
            const existingLogMap = await readAppendLogToMap(logFilePath);

            for (const imgFile of imageFilesInFolder) {
                 const imgFullPath = path.join(currentFolder, imgFile);
                 const normalizedPath = path.normalize(imgFullPath);
                 let shouldCount = false;

                 if (processMode === 'new') {
                     const logEntry = existingLogMap.get(normalizedPath);
                     if (!logEntry || logEntry.status !== 'success') {
                         shouldCount = true;
                     }
                 } else if (processMode === 'missing') {
                      const baseName = path.basename(imgFile, path.extname(imgFile));
                      const jsonPath = path.join(jsonFolder, `${baseName}.json`);
                      if (!(await fileExists(jsonPath))) {
                          shouldCount = true;
                      }
                 }
                 if (shouldCount) {
                     totalCount++;
                 }
            }
             if(imageFilesInFolder.length > 500) await yieldToUI(); // Yield if checking many files
        }
    } // End while loop

    sendLogToRenderer(`Pre-scan complete. Total target images: ${totalCount}`);
    await yieldToUI();
    return totalCount;
}


// --- Main Process Images Handler: Define and use callback ---
ipcMain.handle('process-images', async (event, data) => {
    const { folders, apiEndpoint: defaultApiEndpoint, confidenceThreshold, processMode, includeSubfolders, apiInstances } = data;

    if (isProcessing) { throw new Error('Processing is already in progress.'); }
    isProcessing = true; processingState = { isPaused: false, isCanceled: false }; clearCorruptedFiles(); logCounter = 0;

    sendLogToRenderer(`=== Starting New Processing Job ===`);
    sendLogToRenderer(`Folders: ${folders.length}, Mode: ${processMode}, Subfolders: ${includeSubfolders}, Instances Requested: ${apiInstances}`);
    if (apiInstances > 1) sendLogToRenderer(`!!! Config: MAX_CONCURRENT_CONNECTIONS_PER_INSTANCE = ${MAX_CONCURRENT_CONNECTIONS_PER_INSTANCE}.`, 'warning');
    await yieldToUI();

    if (!(await checkDockerAvailability())) { isProcessing = false; throw new Error("Docker not available."); }

    let apiEndpoints = []; instanceRegistry = { isPermanentInstanceRunning: false, permanentInstanceId: null, additionalInstances: [] }; instanceHealthStatus = []; connectionPools = {};

    // --- Global Counters ---
    let globalTotalImageCount = 0; // Calculated during pre-scan
    let globalProcessedImageCount = 0; // Incremented by callback for each attempt
    let overallSuccess = 0;            // Incremented by callback
    let overallFailed = 0;             // Incremented by callback
    let overallSkipped = 0;            // Incremented by callback (skipped/corrupt/unhealthy instance)
    // ---------------------

    // --- Progress Update Callback ---
    const reportGlobalProgress = (resultStatus) => {
        // Only increment if we haven't been canceled *before* this report
        if (!processingState.isCanceled) {
            // Ensure counter doesn't exceed total (e.g., if scan was slightly off or files added/removed)
            if (globalProcessedImageCount < globalTotalImageCount) {
                 globalProcessedImageCount++; // Increment for any attempt reported (success, fail, skip)
            } else if (globalProcessedImageCount === globalTotalImageCount && resultStatus !== 'canceled') {
                // Allow counting outcome even if slightly over, but log warning
                console.warn("Processed count may exceed scanned total. Still counting result.");
            } // If > total, something is wrong, maybe log an error?

            // Count outcomes based on status
            if (resultStatus === 'success') overallSuccess++;
            else if (resultStatus === 'failed') overallFailed++;
            else if (resultStatus === 'skipped') overallSkipped++;
            // 'canceled' status usually means the single file finished, but loop check caught cancel later.
            // We don't increment overall counts for 'canceled' status here. The final summary handles unattempted files.

            // Send update to renderer
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('progress-global-images', {
                    current: Math.min(globalProcessedImageCount, globalTotalImageCount), // Cap visual display at total
                    total: globalTotalImageCount
                });
            }
        }
    };
    // ------------------------------

    try {
        // --- Pre-scan ---
        try {
             globalTotalImageCount = await getTotalImageCount([...folders], processMode, includeSubfolders);
             if (mainWindow && !mainWindow.isDestroyed()) {
                 mainWindow.webContents.send('progress-global-images', { current: 0, total: globalTotalImageCount });
             }
        } catch (scanError) {
             isProcessing = false; // Ensure state reset on scan error/cancel
             throw scanError;
        }
        if (globalTotalImageCount === 0 && !processingState.isCanceled) {
             sendLogToRenderer("No target images found based on selected folders and mode. Nothing to process.", "warning");
             isProcessing = false;
             return { folderCount: folders.length, total: 0, processed: 0, success: 0, failed: 0, skipped: 0, canceled: false, instancesUsed: 0 };
        }
        if (processingState.isCanceled) { // Check if scan was canceled
             isProcessing = false;
             throw new Error("Processing canceled during folder scan.");
        }

        // --- Setup Instances ---
        sendLogToRenderer('--- Setting up Docker instances ---');
        let permanentReady = false; let permanentContainerId = null;

        sendLogToRenderer(`Checking permanent instance on port ${PERMANENT_INSTANCE_PORT}...`);
        if (await checkApiRunning(PERMANENT_INSTANCE_PORT)) { sendLogToRenderer(`Permanent instance detected.`); permanentReady = true; }
        else { sendLogToRenderer(`Attempting to start permanent instance...`);
            if (await isPortInUse(PERMANENT_INSTANCE_PORT)) throw new Error(`Port ${PERMANENT_INSTANCE_PORT} blocked.`);
            permanentContainerId = await startContainer(PERMANENT_INSTANCE_PORT, 0);
            if (permanentContainerId) { permanentReady = await waitForApiReady(PERMANENT_INSTANCE_PORT); if (!permanentReady) { sendLogToRenderer(`Permanent failed readiness. Stopping...`, 'error'); await stopContainer(permanentContainerId, PERMANENT_INSTANCE_PORT, 0); permanentContainerId = null; } else sendLogToRenderer(`Permanent started ✓`); }
            else sendLogToRenderer(`Failed permanent container start.`, 'error');
        }
        if (permanentReady) { instanceRegistry.isPermanentInstanceRunning = true; instanceRegistry.permanentInstanceId = permanentContainerId; apiEndpoints.push(`http://localhost:${PERMANENT_INSTANCE_PORT}/evaluate`); }
        else { if (apiInstances <= 1) throw new Error(`Failed permanent instance.`); else sendLogToRenderer(`Permanent failed, proceeding additional.`, 'warning'); }
        await yieldToUI();
        const neededAdditional = apiInstances - apiEndpoints.length;
        if (neededAdditional > 0 && !processingState.isCanceled) {
            sendLogToRenderer(`Setting up ${neededAdditional} additional instance(s)...`); let additionalInstancesStarted = 0;
            for (let i = 0; i < neededAdditional; i += STAGGERED_STARTUP_BATCH_SIZE) { if (processingState.isCanceled) break;
                const batchEnd = Math.min(i + STAGGERED_STARTUP_BATCH_SIZE, neededAdditional); const currentBatchIndices = Array.from({length: batchEnd - i}, (_, k) => i + k); const logIndices = currentBatchIndices.map(idx => apiEndpoints.length + idx); sendLogToRenderer(`--- Starting batch (Overall Indices ${logIndices.map(li => li + 1).join(', ')}) ---`);
                const batchPromises = currentBatchIndices.map(batchIndex => { if (processingState.isCanceled) return Promise.resolve(null); const instanceIndex = apiEndpoints.length + batchIndex; const port = ADDITIONAL_INSTANCE_START_PORT + batchIndex;
                    return (async () => { let instanceReady = false; let instanceContainerId = null; if (await checkApiRunning(port)) instanceReady = true; else { if (await isPortInUse(port)) { sendLogToRenderer(`Port ${port} in use, skip #${instanceIndex + 1}.`, 'error'); return null; } else { instanceContainerId = await startContainer(port, instanceIndex); if (instanceContainerId) { instanceReady = await waitForApiReady(port); if (!instanceReady) { await stopContainer(instanceContainerId, port, instanceIndex); instanceContainerId = null; } } } } if (instanceReady) return { port, containerId: instanceContainerId, index: instanceIndex }; else return null; })(); });
                const batchResults = await Promise.all(batchPromises); for (const result of batchResults) { if (result) { apiEndpoints.push(`http://localhost:${result.port}/evaluate`); instanceRegistry.additionalInstances.push({ containerId: result.containerId, port: result.port }); additionalInstancesStarted++; } } sendLogToRenderer(`--- Finished batch. Total additional ready: ${additionalInstancesStarted}/${neededAdditional} ---`); await yieldToUI();
            } if (processingState.isCanceled) sendLogToRenderer('Instance startup canceled.', 'warning'); else sendLogToRenderer(`Successfully prepared ${additionalInstancesStarted}/${neededAdditional} additional instances.`);
        }
        if (apiEndpoints.length === 0) throw new Error("No API instances prepared.");
        if (processingState.isCanceled) { await shutdownAllContainers(); throw new Error("Canceled during instance startup."); }

        // --- Start Processing ---
        sendLogToRenderer(`=== Processing starting with ${apiEndpoints.length} active instances for ${globalTotalImageCount} target images ===`);
        initializeInstanceHealth(apiEndpoints.length);
        if (healthCheckInterval) clearInterval(healthCheckInterval); healthCheckInterval = setInterval(async () => { if (!isProcessing || processingState.isCanceled || processingState.isPaused) return; try { await checkAndRecoverInstances(); } catch (hcError) { sendLogToRenderer(`Health check error: ${hcError.message}`, 'error'); } }, 5 * 60 * 1000); // 5 minute health check

        // --- Main Processing Loop ---
        const totalFolders = folders.length;
        for (let i = 0; i < totalFolders; i++) {
            if (processingState.isCanceled) { sendLogToRenderer(`Processing loop canceled after ${i} folders.`); break; }
            const folder = folders[i];
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('progress-overall', { currentFolderIndex: i + 1, totalFolders: totalFolders, folder: folder });
            await yieldToUI();

            // Pass the callback down
            await processFolder(folder, apiEndpoints, confidenceThreshold, processMode, includeSubfolders, reportGlobalProgress);

            // *** No aggregation or global progress sending needed here anymore ***
            await yieldToUI();
        } // End folder loop

        // --- Log Summary ---
        sendLogToRenderer('=== Overall Processing Summary ===', 'success');
        sendLogToRenderer(`Folders Processed: ${processingState.isCanceled ? 'Partial' : folders.length}/${folders.length}`);
        sendLogToRenderer(`Target Images (Initial Scan): ${globalTotalImageCount}`);
        // Use the final global counters
        sendLogToRenderer(`Attempted Processing: ${globalProcessedImageCount}`);
        sendLogToRenderer(`Successful: ${overallSuccess}`, 'success');
        sendLogToRenderer(`Failed: ${overallFailed}`, overallFailed > 0 ? 'error' : 'info');
        sendLogToRenderer(`Skipped/Corrupted/Unhealthy: ${overallSkipped}`, overallSkipped > 0 ? 'warning' : 'info');

        let unattempted = 0;
        if (!processingState.isCanceled) {
            // If not canceled, calculate difference between target and attempted
            unattempted = Math.max(0, globalTotalImageCount - globalProcessedImageCount);
        } else {
            // If canceled, unattempted is total minus actually attempted
            unattempted = Math.max(0, globalTotalImageCount - globalProcessedImageCount);
        }

        if (processingState.isCanceled) {
            sendLogToRenderer(`Processing CANCELED. (${unattempted > 0 ? `${unattempted} target images were not attempted.` : 'All target images were attempted before cancel.'})`, 'warning');
        } else if (unattempted > 0) {
             // If not canceled, but still unattempted, implies an issue (e.g., error stopping processing early, unhealthy instances?)
             sendLogToRenderer(`Warning: ${unattempted} target images were not attempted. Check for errors or unhealthy instances.`, 'warning');
        }

        // Return final results using the global counters
        return {
            folderCount: folders.length,
            total: globalTotalImageCount,
            processed: globalProcessedImageCount,
            success: overallSuccess,
            failed: overallFailed,
            // Combine skipped from processing and unattempted due to cancel/error
            skipped: overallSkipped + unattempted,
            canceled: processingState.isCanceled,
            instancesUsed: apiEndpoints.length
         };

    } catch (error) {
        console.error('Error during image processing job:', error);
        sendLogToRenderer(`FATAL PROCESSING ERROR: ${error.message}\n${error.stack}`, 'error');
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('processing-canceled');
        processingState.isCanceled = true; // Ensure cancel state is set
        isProcessing = false; // Ensure processing state is reset
        // Re-throw the error to be caught by the renderer's invoke().catch()
        throw error;
    } finally {
        sendLogToRenderer('=== Processing job finished. Starting cleanup... ===');
        isProcessing = false; // Reset processing flag
        if (healthCheckInterval) { clearInterval(healthCheckInterval); healthCheckInterval = null; }
        sendLogToRenderer(`Waiting ${CONNECTION_COOLDOWN_MS/1000}s cooldown...`);
        await new Promise(resolve => setTimeout(resolve, CONNECTION_COOLDOWN_MS));
        await stopAdditionalContainers(); // Stop additional first
        Object.keys(connectionPools).forEach(key => resetConnectionPool(parseInt(key, 10))); // Reset pools after stopping
        if (instanceRegistry.isPermanentInstanceRunning && instanceRegistry.permanentInstanceId) {
            // Only stop permanent *IF* we started it (has containerId) and *NOT* canceled
             if (!processingState.isCanceled) {
                sendLogToRenderer(`Stopping permanent instance (started by this job)...`);
                await stopContainer(instanceRegistry.permanentInstanceId, PERMANENT_INSTANCE_PORT, 0);
                resetConnectionPool(0); // Reset its pool too
             } else {
                sendLogToRenderer(`Cleanup: Leaving permanent instance running due to cancel (started by this job).`);
             }
        } else if (instanceRegistry.isPermanentInstanceRunning && !instanceRegistry.permanentInstanceId) {
            // If it was pre-existing, log that we're leaving it
            sendLogToRenderer(`Cleanup: Permanent instance was pre-existing, leaving it running.`);
            resetConnectionPool(0); // Still reset the pool if we used it
        }
        // Reset registry and pools state completely
        instanceRegistry = { isPermanentInstanceRunning: false, permanentInstanceId: null, additionalInstances: [] };
        connectionPools = {};
        sendLogToRenderer('=== Cleanup complete ===');
        await yieldToUI();
    }
});
// --- END OF index.js ---
