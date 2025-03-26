const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs').promises; // Use fs.promises for async operations
const fsSync = require('fs'); // Keep sync version *only* for createReadStream if needed
const path = require('path');
const { exec } = require('child_process');
const http = require('http');
const https = require('https'); // Keep for potential future use
const os = require('os');
const dns = require('dns').promises;
const net = require('net'); // For isPortInUse

// --- Configuration Constants ---
const PERMANENT_INSTANCE_PORT = 5000;
const ADDITIONAL_INSTANCE_START_PORT = 5001;
const CONNECTION_COOLDOWN_MS = 10000; // Time to wait after processing before stopping containers
const MAX_CONCURRENT_CONNECTIONS_PER_INSTANCE = 3; // Max simultaneous requests *per* Docker instance
const SOCKET_TIMEOUT_MS = 45000; // Increased timeout for socket inactivity
const REQUEST_TIMEOUT_MS = 90000; // Increased overall request timeout (axios)
const CONNECTION_RESET_THRESHOLD = 5; // Consecutive errors before resetting connection pool
const MAX_FILE_RETRIES = 3; // Max attempts for a single file before marking as potentially corrupted
const DOCKER_STARTUP_TIMEOUT_MS = 60000; // Max time to wait for a Docker container API to become ready
const DOCKER_POLL_INTERVAL_MS = 2000; // How often to check if API is ready during startup

// --- Global State ---
let mainWindow;
let processingState = {
  isPaused: false,
  isCanceled: false,
};
let isProcessing = false; // Global flag to indicate active processing
let healthCheckInterval = null;
let logCounter = 0; // Counter for periodic UI updates

// --- Instance Management State ---
let instanceRegistry = {
  isPermanentInstanceRunning: false,
  permanentInstanceId: null,
  additionalInstances: [], // { containerId: string, port: number }[]
};
let instanceHealthStatus = []; // { consecutiveFailures: number, totalRequests: number, successfulRequests: number, isHealthy: boolean }[]
let connectionPools = {}; // { [instanceIndex: number]: http.Agent }

// --- Corrupted File Tracking ---
const corruptedFiles = new Map(); // Map<filePath, retryCount>

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
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function fileExists(filePath) {
  try {
    await fs.access(filePath, fs.constants.F_OK);
    return true;
  } catch (error) {
    // Check if error code indicates file not found
    if (error.code === 'ENOENT') {
        return false;
    }
    // Re-throw other unexpected errors
    console.warn(`Unexpected error checking file existence for ${filePath}: ${error.message}`);
    throw error;
  }
}

/**
 * Helper to check if a directory exists asynchronously.
 * @param {string} dirPath
 * @returns {Promise<boolean>}
 */
async function directoryExists(dirPath) {
    try {
        const stats = await fs.stat(dirPath);
        return stats.isDirectory();
    } catch (error) {
        if (error.code === 'ENOENT') {
            return false;
        }
        console.warn(`Unexpected error checking directory existence for ${dirPath}: ${error.message}`);
        throw error; // Re-throw other errors
    }
}

/**
 * Yields control to the event loop and potentially updates the UI.
 * Essential for preventing UI freezes during long operations.
 */
function yieldToUI() {
  return new Promise(resolve => {
    setImmediate(() => {
        // Force redraw if window is hidden/unfocused
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
            mainWindow.webContents.send('force-update');
        }
      setTimeout(resolve, 0); // setTimeout(0) allows other tasks in the queue to run
    });
  });
}

/**
 * Sends a log message to the renderer process, ensuring UI updates.
 * @param {string} message - The log message.
 * @param {string} [type=''] - Optional type ('success', 'error', 'warning', 'info').
 */
function sendLogToRenderer(message, type = '') {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // Ensure message is a string
  const logMessage = (typeof message === 'string') ? message : JSON.stringify(message);

  mainWindow.webContents.send('log', logMessage, type);

  logCounter++;
  // Force UI update for important messages or periodically
  // Trigger redraw logic in renderer only if unfocused
  if (type === 'error' || type === 'warning' || logCounter % 20 === 0) { // Check less frequently
    if (!mainWindow.isFocused()) {
        mainWindow.webContents.send('force-update');
    }
  }
}

/**
 * Checks if a TCP port is currently in use on localhost.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
async function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true); // Port is definitely in use
      } else {
        // Unexpected error, assume not in use but log it
        console.error(`Unexpected error checking port ${port}:`, err);
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close(() => resolve(false)); // Port was free
    });
    // Listen specifically on 127.0.0.1 to avoid potential OS differences with 'localhost' resolution
    server.listen(port, '127.0.0.1');
  });
}

// --- HTTP Agent & Axios Instance Management ---

/**
 * Creates a custom HTTP agent for connection pooling and management.
 * @param {number} instanceIndex - Index of the API instance.
 * @returns {http.Agent}
 */
const createHttpAgent = (instanceIndex) => {
  return new http.Agent({
    keepAlive: true,
    maxSockets: MAX_CONCURRENT_CONNECTIONS_PER_INSTANCE, // Max sockets per host (localhost:port)
    maxFreeSockets: Math.max(1, Math.floor(MAX_CONCURRENT_CONNECTIONS_PER_INSTANCE / 2)), // Keep some sockets free
    timeout: SOCKET_TIMEOUT_MS, // Inactivity timeout for the socket
    freeSocketTimeout: 30000, // How long a free socket waits before closing
    scheduling: 'lifo', // Last-in, first-out scheduling might be slightly better for locality
    name: `autotagger-agent-${instanceIndex}` // For debugging
  });
};

/**
 * Creates an Axios instance configured for a specific API instance.
 * @param {number} instanceIndex - Index of the API instance.
 * @returns {axios.AxiosInstance}
 */
function createAxiosInstance(instanceIndex) {
  if (!connectionPools[instanceIndex]) {
    sendLogToRenderer(`Creating new connection pool for instance #${instanceIndex + 1}`);
    connectionPools[instanceIndex] = createHttpAgent(instanceIndex);
  }

  return axios.create({
    httpAgent: connectionPools[instanceIndex],
    timeout: REQUEST_TIMEOUT_MS, // Overall request timeout
    maxRedirects: 3, // Limit redirects
    validateStatus: (status) => status >= 200 && status < 500, // Accept 2xx, 3xx, 4xx as potentially "successful" calls (API might return 400 for bad input)
    // Set higher limits for request/response body sizes
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
}

/**
 * Resets the connection pool for a specific instance.
 * @param {number} instanceIndex - Index of the API instance.
 */
function resetConnectionPool(instanceIndex) {
  if (connectionPools[instanceIndex]) {
    sendLogToRenderer(`Resetting connection pool for instance #${instanceIndex + 1}`, 'warning');
    try {
      connectionPools[instanceIndex].destroy(); // Gracefully destroy existing sockets
    } catch (e) {
      sendLogToRenderer(`Error destroying connection pool for instance #${instanceIndex + 1}: ${e.message}`, 'error');
    }
    delete connectionPools[instanceIndex]; // Remove the old pool
    // The pool will be recreated on the next call to createAxiosInstance
  }
}

// --- API & Docker Instance Health Checks ---

/**
 * Checks if the API endpoint on a specific port is responsive. Uses polling.
 * @param {number} port
 * @param {number} timeout - Timeout for each individual check attempt.
 * @returns {Promise<boolean>}
 */
async function checkApiRunning(port, timeout = 5000) {
    const url = `http://localhost:${port}`; // Check root endpoint
    try {
        // Use a fresh, simple axios instance for health checks
        const healthCheckAxios = axios.create({
            timeout: timeout,
            validateStatus: () => true, // Accept any status code
            // Important: Prevent reuse of potentially problematic pooled connections for health checks
            httpAgent: new http.Agent({ keepAlive: false }),
            httpsAgent: new https.Agent({ keepAlive: false }),
        });
        const response = await healthCheckAxios.get(url);
        // Consider any response < 500 as "running enough for health check"
        if (response.status < 500) {
            // console.log(`API check on port ${port}: Status ${response.status}`);
            return true;
        } else {
            console.warn(`API check on port ${port} returned status ${response.status}`);
            return false;
        }
    } catch (error) {
        // Network errors (ECONNREFUSED, timeout, ENOTFOUND, etc.) mean it's not running
        // console.error(`API check error on port ${port}: ${error.message}`);
        return false;
    }
}

/**
 * Waits for the API on the specified port to become ready, polling until timeout.
 * @param {number} port
 * @param {number} [totalTimeout=DOCKER_STARTUP_TIMEOUT_MS] - Max time to wait.
 * @param {number} [pollInterval=DOCKER_POLL_INTERVAL_MS] - How often to check.
 * @returns {Promise<boolean>} - True if ready within timeout, false otherwise.
 */
async function waitForApiReady(port, totalTimeout = DOCKER_STARTUP_TIMEOUT_MS, pollInterval = DOCKER_POLL_INTERVAL_MS) {
    const startTime = Date.now();
    sendLogToRenderer(`Waiting up to ${totalTimeout / 1000}s for API on port ${port} to respond...`);
    while (Date.now() - startTime < totalTimeout) {
        if (await checkApiRunning(port, pollInterval * 0.8)) { // Use slightly shorter timeout for individual check
            sendLogToRenderer(`API on port ${port} is ready ✓`, 'success');
            await yieldToUI();
            return true;
        }
        // Check for cancellation while waiting
        if (processingState.isCanceled) {
            sendLogToRenderer(`API wait canceled for port ${port}.`, 'warning');
            return false;
        }
        await yieldToUI(); // Yield between checks
        await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
    sendLogToRenderer(`API on port ${port} did not become ready within ${totalTimeout / 1000}s timeout ✗`, 'error');
    await yieldToUI();
    return false;
}


/**
 * Initializes or resets the health status tracking for all instances.
 * @param {number} instanceCount
 */
function initializeInstanceHealth(instanceCount) {
  instanceHealthStatus = Array.from({ length: instanceCount }, () => ({
    consecutiveFailures: 0,
    totalRequests: 0,
    successfulRequests: 0,
    isHealthy: true, // Assume healthy initially
  }));
}

/**
 * Updates the health status of a specific instance after a request attempt.
 * @param {number} instanceIndex
 * @param {boolean} success - Whether the request was successful (network-wise, not necessarily 200 OK).
 */
function updateInstanceHealth(instanceIndex, success) {
  if (!instanceHealthStatus[instanceIndex]) return;

  const health = instanceHealthStatus[instanceIndex];
  health.totalRequests++;

  if (success) {
    health.successfulRequests++;
    if (health.consecutiveFailures > 0) {
       // If it was unhealthy, log recovery immediately on first success
       if (!health.isHealthy) {
            sendLogToRenderer(`Instance #${instanceIndex + 1} appears to have recovered. Marking as healthy. ✓`, 'success');
            health.isHealthy = true; // Mark as healthy again
            resetConnectionPool(instanceIndex); // Reset pool on recovery
       }
       health.consecutiveFailures = 0; // Reset failure count
    }
  } else {
    health.consecutiveFailures++;
    // Mark instance as unhealthy if too many consecutive failures occur
    if (health.isHealthy && health.consecutiveFailures >= CONNECTION_RESET_THRESHOLD) {
      health.isHealthy = false;
      sendLogToRenderer(`Instance #${instanceIndex + 1} marked as UNHEALTHY after ${CONNECTION_RESET_THRESHOLD} consecutive failures ✗`, 'error');
      // Reset the connection pool immediately when marked unhealthy
      resetConnectionPool(instanceIndex);
    }
  }
}

/**
 * Checks if a specific instance is currently considered healthy.
 * @param {number} instanceIndex
 * @returns {boolean}
 */
function isInstanceHealthy(instanceIndex) {
  // Ensure the index is valid before accessing
  return instanceHealthStatus[instanceIndex]?.isHealthy ?? false;
}


/**
 * Periodically checks the health of running Docker instances and attempts recovery.
 */
async function checkAndRecoverInstances() {
  sendLogToRenderer('Performing health check and recovery on Docker instances...');
  await yieldToUI();

  const instancesToCheck = [
    // Check permanent instance if it's supposed to be running
    ...(instanceRegistry.isPermanentInstanceRunning ? [{ port: PERMANENT_INSTANCE_PORT, index: 0, containerId: instanceRegistry.permanentInstanceId }] : []),
    // Check additional instances
    ...instanceRegistry.additionalInstances.map((inst, i) => ({ port: inst.port, index: i + 1, containerId: inst.containerId }))
  ];

  for (const instanceInfo of instancesToCheck) {
     if (processingState.isCanceled) break; // Stop checking if canceled

    const { port, index, containerId } = instanceInfo;
    const wasHealthy = isInstanceHealthy(index); // Check health *before* the API call
    const isApiResponding = await checkApiRunning(port);
    await yieldToUI(); // Yield between checks

    if (!isApiResponding) {
      // API is not responding
      if (wasHealthy) { // Log transition only if it *was* healthy
         sendLogToRenderer(`Instance #${index + 1} (Port ${port}) became unresponsive. Attempting recovery...`, 'error');
         // Mark as unhealthy immediately
         if (instanceHealthStatus[index]) instanceHealthStatus[index].isHealthy = false;
         resetConnectionPool(index); // Reset pool for unresponsive instance
      } else {
         sendLogToRenderer(`Unhealthy Instance #${index + 1} (Port ${port}) remains unresponsive. Attempting recovery...`, 'warning');
      }

      try {
        // Attempt to stop the potentially zombie container first
        if (containerId) {
          await stopContainer(containerId, port, index);
          await yieldToUI();
        } else {
          sendLogToRenderer(`No container ID known for instance #${index+1} (Port ${port}). Cannot stop explicitly.`, 'warning');
        }

        // Check if port is free *now* before trying to start
        if (await isPortInUse(port)) {
            sendLogToRenderer(`Port ${port} still in use after stop attempt. Cannot restart Instance #${index + 1}.`, 'error');
            continue; // Skip to next instance
        }

        // Attempt to start a new container on the same port
        const newContainerId = await startContainer(port, index);
        await yieldToUI();

        if (newContainerId) {
           // Update registry
           if (index === 0) {
             instanceRegistry.permanentInstanceId = newContainerId;
             instanceRegistry.isPermanentInstanceRunning = true;
           } else if (instanceRegistry.additionalInstances[index-1]) {
             // Find the correct instance in the array by port, just in case order changed (though unlikely here)
             const regIndex = instanceRegistry.additionalInstances.findIndex(inst => inst.port === port);
             if (regIndex !== -1) {
                instanceRegistry.additionalInstances[regIndex].containerId = newContainerId;
             }
           }

           // Wait for the new container's API to be ready
           const recovered = await waitForApiReady(port);
           if (recovered && instanceHealthStatus[index]) {
             instanceHealthStatus[index].isHealthy = true;
             instanceHealthStatus[index].consecutiveFailures = 0;
             sendLogToRenderer(`Instance #${index + 1} (Port ${port}) recovered successfully ✓`, 'success');
             resetConnectionPool(index); // Reset pool for the newly started instance
           } else if (recovered) {
             sendLogToRenderer(`Instance #${index + 1} (Port ${port}) restarted but health status missing.`, 'warning');
           } else {
             sendLogToRenderer(`Instance #${index + 1} (Port ${port}) failed to recover (API not ready) ✗`, 'error');
             if (instanceHealthStatus[index]) instanceHealthStatus[index].isHealthy = false; // Ensure marked unhealthy
             // Attempt to stop the failed new container
             await stopContainer(newContainerId, port, index);
           }
        } else {
            sendLogToRenderer(`Failed to start replacement container for Instance #${index + 1} (Port ${port}) ✗`, 'error');
            if (instanceHealthStatus[index]) instanceHealthStatus[index].isHealthy = false; // Ensure marked unhealthy
        }
      } catch (error) {
        sendLogToRenderer(`Error during recovery for Instance #${index + 1} (Port ${port}): ${error.message}`, 'error');
        if (instanceHealthStatus[index]) instanceHealthStatus[index].isHealthy = false; // Ensure marked unhealthy
      }

    } else if (!wasHealthy) {
      // API is responding, but was marked unhealthy
      sendLogToRenderer(`Instance #${index + 1} (Port ${port}) is responding again. Marking as healthy. ✓`, 'success');
      if (instanceHealthStatus[index]) {
        instanceHealthStatus[index].isHealthy = true;
        instanceHealthStatus[index].consecutiveFailures = 0;
      }
      // Reset pool on recovery to clear potentially bad connections
      resetConnectionPool(index);
    }
    // Case: isApiResponding && wasHealthy -> Instance is fine, do nothing.

    await yieldToUI(); // Yield after processing each instance
  }

  sendLogToRenderer('Health check and recovery attempt completed.');
  await yieldToUI();
}


// --- Request Retry Logic ---

/**
 * Performs an async function with retry logic, exponential backoff, and circuit breaking based on instance health.
 * @param {Function} fn - The async function to execute, expected to return Axios response or throw error.
 * @param {number} instanceIndex - Index of the API instance being used.
 * @param {number} [maxRetries=MAX_FILE_RETRIES] - Maximum number of attempts (including the initial one).
 * @param {number} [initialDelay=1500] - Initial delay before the first retry in ms.
 * @returns {Promise<any>} - The result of the function if successful (usually Axios response).
 * @throws {Error} - Throws the last error if all attempts fail, if instance is unhealthy, or on cancellation.
 */
async function enhancedRetryRequest(fn, instanceIndex, maxRetries = MAX_FILE_RETRIES, initialDelay = 1500) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // --- Pre-Request Checks ---
    // 1. Cancellation Check
    if (processingState.isCanceled) {
        throw lastError || new Error('Processing canceled by user'); // Use lastError if available
    }
    // 2. Circuit Breaker: Instance Health
    if (!isInstanceHealthy(instanceIndex)) {
        const healthMsg = `Instance #${instanceIndex + 1} is marked unhealthy. Skipping request attempt ${attempt}.`;
        // If this is the first attempt, log it. Otherwise, it might be noisy.
        if (attempt === 1) sendLogToRenderer(healthMsg, 'warning');
        throw lastError || new Error(healthMsg);
    }
    // 3. Pause Check
    while (processingState.isPaused && !processingState.isCanceled) {
        await new Promise(resolve => setTimeout(resolve, 200));
        await yieldToUI();
    }
    // Re-check cancellation after pause
    if (processingState.isCanceled) {
        throw lastError || new Error('Processing canceled by user');
    }

    // --- Execute Request ---
    try {
      const result = await fn(); // Execute the actual request function

      // --- Handle Response ---
      // Check if the result looks like an Axios response with a status code
      if (result?.status) {
          if (result.status >= 200 && result.status < 300) {
              // Success (2xx)
              updateInstanceHealth(instanceIndex, true); // Mark instance health as success
              return result;
          } else if (result.status >= 400 && result.status < 500) {
              // Client Error (4xx) - Don't retry, don't count against instance health
              sendLogToRenderer(`Instance #${instanceIndex+1} received API error ${result.status} (Attempt ${attempt}/${maxRetries}). Won't retry client errors.`, 'warning');
              // Return the response for the caller (processSingleImageFile) to handle
              return result;
          } else {
              // Other non-success status (e.g., 3xx redirects handled by Axios, potentially 5xx if validateStatus allows)
              // Treat unexpected non-2xx/4xx as potential transient errors
              throw new Error(`API returned unexpected status ${result.status}`);
          }
      } else {
           // If 'fn' returned something unexpected (not an Axios response), treat as success for retry purposes.
           // The caller should validate the actual result content.
           updateInstanceHealth(instanceIndex, true);
           return result;
      }
    } catch (error) {
      // --- Handle Errors ---
      lastError = error; // Store the error

      // Don't retry on cancellation
      if (error.message === 'Processing canceled by user') {
        throw error;
      }

      // Don't retry client errors (4xx) that might throw if validateStatus rejects them
      if (error.response && error.response.status >= 400 && error.response.status < 500) {
         sendLogToRenderer(`Instance #${instanceIndex+1} received API error ${error.response.status} (Attempt ${attempt}/${maxRetries}). Won't retry client errors.`, 'warning');
         throw error; // Throw immediately
      }

      // Log the retry attempt for other errors (network, 5xx, timeouts, etc.)
      sendLogToRenderer(`Instance #${instanceIndex+1} request failed (Attempt ${attempt}/${maxRetries}): ${error.message}. Retrying...`, 'warning');
      updateInstanceHealth(instanceIndex, false); // Mark instance health as failed

      // If it's the last attempt, break the loop and throw later
      if (attempt >= maxRetries) {
        break;
      }

      // --- Exponential Backoff ---
      const backoff = initialDelay * Math.pow(1.8, attempt - 1);
      const jitter = backoff * (Math.random() * 0.4 + 0.8); // 80% to 120%
      const waitTime = Math.min(Math.max(500, jitter), 20000); // Ensure min 0.5s, max 20s wait

      // Wait, allowing UI updates and pause/cancel checks during the wait
      const waitEndTime = Date.now() + waitTime;
      while(Date.now() < waitEndTime) {
          if (processingState.isCanceled) throw new Error('Processing canceled by user during retry wait');
          if (processingState.isPaused) {
              await new Promise(resolve => setTimeout(resolve, 200));
          } else {
              // Wait in smaller chunks to remain responsive
              await new Promise(resolve => setTimeout(resolve, Math.min(200, waitEndTime - Date.now())));
          }
          await yieldToUI();
      }
    }
  }

  // All retries failed
  sendLogToRenderer(`Instance #${instanceIndex+1} request FAILED after ${maxRetries} attempts: ${lastError.message}`, 'error');
  // Ensure instance is marked unhealthy if all retries failed
  updateInstanceHealth(instanceIndex, false);
  throw lastError;
}

// --- Electron App Lifecycle & Window Management ---

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 650,
    webPreferences: {
      // --- Settings for NO preload.js ---
      nodeIntegration: true,    // Allow Node.js APIs in renderer
      contextIsolation: false, // Disable context isolation (less secure)
      // --- Common Settings ---
      backgroundThrottling: false, // Crucial for background processing
      // preload: path.join(__dirname, 'preload.js') // Remove or comment out this line
    },
  });

  mainWindow.loadFile('index.html');

  // Optional: Open DevTools automatically
  // mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => {
    mainWindow = null; // Dereference window object
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    // On macOS, re-create window if dock icon is clicked and no windows are open
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Quit app on all platforms except macOS
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async (event) => {
  // Ensure cleanup happens before quitting
  if (isProcessing) {
    sendLogToRenderer('Cancel requested due to app quit during processing...', 'warning');
    processingState.isCanceled = true; // Signal cancellation
    event.preventDefault(); // Prevent immediate quit
    // Allow some time for ongoing requests to finish or cancel gracefully
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Check again if processing stopped due to cancellation signal
  if (!isProcessing && (instanceRegistry.additionalInstances.length > 0 || instanceRegistry.permanentInstanceId)) {
      sendLogToRenderer('Shutting down Docker containers before quitting...');
      event.preventDefault(); // Prevent immediate quit until cleanup is done
      try {
          await shutdownAllContainers();
      } catch (error) {
          console.error("Error during pre-quit container shutdown:", error);
          sendLogToRenderer(`Error during pre-quit container shutdown: ${error.message}`, 'error');
      } finally {
          app.quit(); // Now allow the app to quit
      }
  } else if (isProcessing) {
      // Still processing after cancel signal, force shutdown after timeout
      sendLogToRenderer('Forcing quit after cancellation timeout...');
      try { await shutdownAllContainers(); } catch {} // Best effort
      app.quit();
  }
  // If no containers were running and not processing, let the app quit normally.
});


// Graceful shutdown handlers
const handleShutdown = async (signal) => {
    console.log(`Received ${signal}. Shutting down gracefully...`);
    sendLogToRenderer(`Received ${signal}. Shutting down...`, 'warning');
    if (isProcessing) {
        processingState.isCanceled = true;
        await new Promise(resolve => setTimeout(resolve, 1000)); // Give cancellation a moment
    }
    try {
        await shutdownAllContainers();
    } catch(error){
        console.error("Error shutting down containers:", error);
    } finally {
        process.exit(0);
    }
};

process.on('SIGINT', () => handleShutdown('SIGINT')); // Ctrl+C
process.on('SIGTERM', () => handleShutdown('SIGTERM')); // kill command

process.on('uncaughtException', async (error) => {
    console.error('UNCAUGHT EXCEPTION:', error);
    sendLogToRenderer(`FATAL ERROR: ${error.message}\n${error.stack}`, 'error');
    // Attempt emergency cleanup, but prioritize exiting
    try {
        if (isProcessing) processingState.isCanceled = true;
        await shutdownAllContainers(); // Best effort cleanup
    } catch (cleanupError) {
        console.error('Error during emergency cleanup:', cleanupError);
    } finally {
        // Use Electron's exit method if available, otherwise fallback
        if (app && !app.isReady()) {
             process.exit(1);
        } else if (app) {
            app.exit(1);
        } else {
            process.exit(1);
        }
    }
});

// --- Docker Management Functions ---

/** Checks if Docker is installed and runnable. */
async function checkDockerAvailability() {
    return new Promise((resolve) => {
        exec('docker --version', (error, stdout, stderr) => {
            if (error) {
                sendLogToRenderer('Docker command failed. Is Docker installed and running?', 'error');
                console.error(`Docker check error: ${error.message}`);
                resolve(false);
            } else {
                 // Also check if Docker daemon is running
                 exec('docker ps', (psError, psStdout, psStderr) => {
                     if (psError) {
                         sendLogToRenderer(`Docker command OK, but failed to connect to Docker daemon: ${psStderr || psError.message}. Is the Docker service running?`, 'error');
                         console.error(`Docker ps error: ${psStderr || psError.message}`);
                         resolve(false);
                     } else {
                         sendLogToRenderer(`Docker available: ${stdout.trim()} & Daemon responding.`, 'success');
                         resolve(true);
                     }
                 });
            }
        });
    });
}

/**
 * Starts a Docker container for the autotagger API.
 * @param {number} port - Host port to map to container's port 5000.
 * @param {number} instanceIndex - Index for logging.
 * @returns {Promise<string|null>} - The container ID if successful, null otherwise.
 */
async function startContainer(port, instanceIndex) {
    const imageName = 'ghcr.io/danbooru/autotagger';
    // Consider adding --cpus or --memory limits if needed
    const command = `docker run -d --rm -p ${port}:5000 ${imageName}`;
    sendLogToRenderer(`Starting Instance #${instanceIndex + 1} on port ${port}...`);
    sendLogToRenderer(`Executing: ${command}`);
    await yieldToUI();

    return new Promise((resolve) => {
        exec(command, { timeout: 30000 }, (error, stdout, stderr) => { // Add timeout to exec
            if (error) {
                const errorMsg = stderr || error.message;
                sendLogToRenderer(`Failed to start Instance #${instanceIndex + 1}: ${errorMsg}`, 'error');
                console.error(`Docker start error (Port ${port}): ${errorMsg}`);
                // Check for port conflict specifically
                if (errorMsg.includes('port is already allocated') || errorMsg.includes('bind: address already in use')) {
                    sendLogToRenderer(`Port ${port} is already in use. Cannot start instance.`, 'error');
                }
                resolve(null); // Indicate failure
            } else {
                const containerId = stdout.trim();
                if (!containerId) {
                     sendLogToRenderer(`Instance #${instanceIndex + 1} (Port ${port}) started but container ID was empty? Stderr: ${stderr}`, 'error');
                     resolve(null);
                } else {
                    sendLogToRenderer(`Instance #${instanceIndex + 1} (Port ${port}) started with Container ID: ${containerId.substring(0, 12)}...`);
                    resolve(containerId); // Return container ID on success
                }
            }
        });
    });
}

/**
 * Stops a Docker container gracefully.
 * @param {string} containerId
 * @param {number} port - Port used by the instance (for logging).
 * @param {number} instanceIndex - Index for logging.
 * @returns {Promise<boolean>} - True if stop command was issued successfully (doesn't guarantee stopped state).
 */
async function stopContainer(containerId, port, instanceIndex) {
    if (!containerId) return true; // Nothing to stop
    const command = `docker stop ${containerId}`;
    sendLogToRenderer(`Stopping Instance #${instanceIndex + 1} (Port ${port}, Container ${containerId.substring(0,12)})...`);
    await yieldToUI();

    return new Promise((resolve) => {
        exec(command, { timeout: 15000 }, (error, stdout, stderr) => { // Add timeout
            if (error) {
                // Log error but resolve true - container might already be stopped or gone
                const errorMsg = stderr || error.message;
                // Ignore "No such container" errors specifically
                if (!errorMsg.includes('No such container')) {
                   sendLogToRenderer(`Error stopping Instance #${instanceIndex + 1} (Container ${containerId.substring(0,12)}): ${errorMsg}`, 'warning');
                   console.warn(`Docker stop warning (Container ${containerId.substring(0,12)}): ${errorMsg}`);
                }
                resolve(true); // Still resolve true as the goal is absence of the container
            } else {
                sendLogToRenderer(`Instance #${instanceIndex + 1} (Port ${port}) stopped.`);
                resolve(true);
            }
        });
    });
}


/**
 * Stops only the additional Docker instances, leaving the permanent one.
 */
async function stopAdditionalContainers() {
  if (instanceRegistry.additionalInstances.length === 0) {
    return;
  }

  sendLogToRenderer(`Stopping ${instanceRegistry.additionalInstances.length} additional API instances...`);
  await yieldToUI();

  // Create a copy before iterating as stopContainer might modify registry indirectly via recovery
  const instancesToStop = [...instanceRegistry.additionalInstances];
  instanceRegistry.additionalInstances = []; // Clear immediately to prevent race conditions

  const stopPromises = instancesToStop.map((instance, i) =>
    stopContainer(instance.containerId, instance.port, i + 1) // Indices for additional are 1, 2, ...
  );

  await Promise.all(stopPromises);

  // Reset connection pools for additional instances (indices 1+)
  for (let i = 0; i < instancesToStop.length; i++) {
      resetConnectionPool(i + 1);
  }

  sendLogToRenderer('Additional instances stopped.');
  await yieldToUI();
}

/**
 * Stops all running Docker instances managed by this application.
 */
async function shutdownAllContainers() {
  sendLogToRenderer('Shutting down all managed Docker containers...');

  // Get current state before clearing
   const instancesToStop = [
      ...instanceRegistry.additionalInstances.map((inst, i) => ({ ...inst, index: i+1 })),
      ...(instanceRegistry.permanentInstanceId ? [{ containerId: instanceRegistry.permanentInstanceId, port: PERMANENT_INSTANCE_PORT, index: 0 }] : [])
  ];

  // Clear registries immediately
  instanceRegistry.additionalInstances = [];
  instanceRegistry.permanentInstanceId = null;
  instanceRegistry.isPermanentInstanceRunning = false;


  if (instancesToStop.length > 0) {
     sendLogToRenderer(`Attempting to stop ${instancesToStop.length} container(s)...`);
     const stopPromises = instancesToStop.map(inst => stopContainer(inst.containerId, inst.port, inst.index));
     try {
        await Promise.all(stopPromises);
        sendLogToRenderer('All managed containers stop command issued.');
     } catch (stopError) {
        sendLogToRenderer(`Error during bulk container stop: ${stopError.message}`, 'error');
     }
  } else {
      sendLogToRenderer('No managed containers were registered to stop.');
  }

  // Destroy all connection pools
  const poolKeys = Object.keys(connectionPools);
  if (poolKeys.length > 0) {
      poolKeys.forEach(key => {
          const index = parseInt(key, 10);
          resetConnectionPool(index);
      });
      sendLogToRenderer('All connection pools reset.');
  }
  connectionPools = {}; // Clear the pools object

  await yieldToUI();
}

// --- IPC Handlers ---

// Folder Selection (No changes needed)
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Folder Containing Images',
  });
  return !result.canceled ? result.filePaths[0] : null;
});

ipcMain.handle('select-folders', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'multiSelections'],
    title: 'Select Folder(s) Containing Images',
  });
  return !result.canceled ? result.filePaths : [];
});

// Analyze Folder (Uses Async FS)
ipcMain.handle('analyze-folder', async (event, inputFolder) => {
  sendLogToRenderer(`Analyzing folder: ${inputFolder}`);
  await yieldToUI();
  const results = {
      hasJsonFolder: false,
      jsonCount: 0,
      logCount: 0,
      missingCount: 0,
      imageCount: 0,
      error: null
  };

  try {
    const jsonFolder = path.join(inputFolder, 'Json');
    results.hasJsonFolder = await directoryExists(jsonFolder);
    sendLogToRenderer(`Checking for JSON folder at: ${jsonFolder} - Found: ${results.hasJsonFolder}`);

    if (results.hasJsonFolder) {
      const allFilesInJson = await fs.readdir(jsonFolder);
      const jsonFiles = allFilesInJson.filter(file =>
        file.toLowerCase().endsWith('.json') && file !== 'processed_log.json'
      );
      results.jsonCount = jsonFiles.length;
      sendLogToRenderer(`Found ${results.jsonCount} JSON files.`);
      await yieldToUI();

      const logFilePath = path.join(jsonFolder, 'processed_log.json');
      if (await fileExists(logFilePath)) {
        try {
          const logContent = await fs.readFile(logFilePath, 'utf8');
          const logData = JSON.parse(logContent);
           if (!Array.isArray(logData)) throw new Error("Log data is not an array");
          results.logCount = logData.length;
          sendLogToRenderer(`Found processing log with ${results.logCount} entries.`);

          let missingPaths = [];
          for (let i=0; i < logData.length; i++) {
            const entry = logData[i];
            // Check entry structure before accessing properties
            if (entry && entry.status === 'success' && typeof entry.imagePath === 'string') {
              const expectedJsonName = path.basename(entry.imagePath, path.extname(entry.imagePath)) + '.json';
              const expectedJsonPath = path.join(jsonFolder, expectedJsonName);
              if (!(await fileExists(expectedJsonPath))) {
                missingPaths.push(entry.imagePath);
              }
            } else if (entry && entry.status === 'success') {
                sendLogToRenderer(`Log entry has status 'success' but missing imagePath: ${JSON.stringify(entry)}`, 'warning');
            }
            if (i % 200 === 0) await yieldToUI(); // Yield less frequently during analysis
          }
          results.missingCount = missingPaths.length;
          if (results.missingCount > 0) {
            sendLogToRenderer(`Found ${results.missingCount} images logged as success but missing JSON files.`, 'warning');
          }
        } catch (logError) {
          console.error('Error parsing log file:', logError);
          sendLogToRenderer(`Error reading or parsing log file: ${logError.message}`, 'error');
          // Don't stop analysis, just note the log error
        }
      } else {
        sendLogToRenderer('No processing log found.');
      }
    }

    // Count image files in the input folder
    const imageExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
    const folderContents = await fs.readdir(inputFolder);
    let imageFilesCount = 0;
    for(let i=0; i < folderContents.length; i++) {
        const file = folderContents[i];
        const fullPath = path.join(inputFolder, file);
        try {
            const stats = await fs.stat(fullPath);
            if (stats.isFile() && imageExts.has(path.extname(file).toLowerCase())) {
                imageFilesCount++;
            }
        } catch (statError) {
            if (statError.code !== 'ENOENT') {
                console.warn(`Could not stat file ${fullPath}: ${statError.message}`);
            }
        }
         if (i % 200 === 0) await yieldToUI(); // Yield less frequently
    }
    results.imageCount = imageFilesCount;
    sendLogToRenderer(`Found ${results.imageCount} image files in the base folder.`);

  } catch (error) {
    console.error('Error analyzing folder:', error);
    sendLogToRenderer(`Error analyzing folder ${path.basename(inputFolder)}: ${error.message}`, 'error');
    results.error = error.message;
  }
  return results;
});

// API Connection Check (Uses checkApiRunning)
ipcMain.handle('check-api-connection', async (event, apiBaseUrl = `http://localhost:${PERMANENT_INSTANCE_PORT}`) => {
  try {
    // Extract port from the provided base URL (assuming format http://host:port)
    const urlObj = new URL(apiBaseUrl);
    const port = parseInt(urlObj.port, 10);
    if (isNaN(port)) {
        throw new Error(`Invalid API base URL format: ${apiBaseUrl}. Could not extract port.`);
    }

    const isRunning = await checkApiRunning(port);
    if (isRunning) {
        sendLogToRenderer(`API connection check to ${apiBaseUrl} successful.`, 'success');
        return { success: true };
    } else {
        sendLogToRenderer(`API connection check to ${apiBaseUrl} failed.`, 'error');
        return { success: false, error: `API not responding at ${apiBaseUrl}` };
    }
  } catch (error) {
    console.error('API connection check error:', error);
    sendLogToRenderer(`API connection check to ${apiBaseUrl} failed: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

// Pause/Resume/Cancel (No changes needed)
ipcMain.on('toggle-pause', () => {
  if (!isProcessing) return; // Only toggle if processing
  processingState.isPaused = !processingState.isPaused;
  sendLogToRenderer(`Processing ${processingState.isPaused ? 'PAUSED' : 'RESUMED'} by user.`, processingState.isPaused ? 'warning' : 'success');
  mainWindow.webContents.send('pause-state-changed', processingState.isPaused);
});

ipcMain.on('cancel-processing', () => {
  if (isProcessing && !processingState.isCanceled) { // Prevent multiple cancel signals
    processingState.isCanceled = true;
    sendLogToRenderer('Cancel request received. Finishing current operations and cleaning up...', 'warning');
    mainWindow.webContents.send('processing-canceled');
  }
});

// --- Core Image Processing Logic ---

/**
 * Processes a single image file using the specified API instance.
 * Handles retries, corruption checks, JSON saving, and logging.
 * @param {string} imagePath - Full path to the image file.
 * @param {string} jsonFolder - Path to the folder where JSON should be saved.
 * @param {string} apiEndpoint - Full URL for the API's /evaluate endpoint.
 * @param {number} instanceIndex - The index of the API instance being used.
 * @returns {Promise<{success: boolean, imagePath: string, timestamp: string, status: string, error?: string}>} - Result object.
 */
async function processSingleImageFile(imagePath, jsonFolder, apiEndpoint, instanceIndex) {
    const imageFile = path.basename(imagePath);
    const timestamp = new Date().toISOString();

    // 1. Check if file is already marked as corrupted
    if (isFileCorrupted(imagePath)) {
        // Don't log every time for potentially large numbers of corrupted files
        // sendLogToRenderer(`Skipping potentially corrupted file: ${imageFile} (failed ${MAX_FILE_RETRIES} times) ✗`, 'warning');
        return { success: false, imagePath, timestamp, status: 'skipped', error: `Previously failed ${MAX_FILE_RETRIES} attempts` };
    }

    // 2. Prepare request data
    const jsonFileName = path.basename(imageFile, path.extname(imageFile)) + '.json';
    const jsonFilePath = path.join(jsonFolder, jsonFileName);
    let fileStream = null; // Initialize stream variable

    try {
        // Check for cancellation before creating stream/form
        if (processingState.isCanceled) throw new Error('Processing canceled by user');

        // Use fs.createReadStream (sync part is minimal, stream itself is async)
        // Wrap stream creation in try/catch in case file disappeared
        try {
            fileStream = fsSync.createReadStream(imagePath);
        } catch (streamError) {
            throw new Error(`Failed to create read stream for ${imageFile}: ${streamError.message}`);
        }

        // Attach stream error handler AFTER creation
        fileStream.on('error', (streamError) => {
             sendLogToRenderer(`Error reading image file stream ${imageFile}: ${streamError.message}`, 'error');
             // Destroy stream if it exists and isn't already destroyed
             if (fileStream && !fileStream.destroyed) {
                 fileStream.destroy();
             }
             // Note: This error might not immediately stop the processSingleImageFile,
             // the API call might fail later. The retry logic should handle it.
        });

        const formData = new FormData();
        formData.append('file', fileStream, { filename: imageFile }); // Explicitly set filename
        formData.append('format', 'json'); // Assuming API expects this

        // 3. Make API call using enhanced retry logic
        const axiosInstance = createAxiosInstance(instanceIndex); // Get or create axios instance
        const response = await enhancedRetryRequest(
            () => axiosInstance.post(apiEndpoint, formData, { headers: formData.getHeaders() }),
            instanceIndex,
            MAX_FILE_RETRIES
        );

        // 4. Handle API Response
        // enhancedRetryRequest should only return successful (2xx) or client error (4xx) responses here
        if (response.status >= 200 && response.status < 300) {
            // Success (2xx)
            await fs.writeFile(jsonFilePath, JSON.stringify(response.data, null, 2));
            // Log less verbosely for success, maybe batch logs later
            // sendLogToRenderer(`Instance #${instanceIndex+1} processed ${imageFile} ✓`);
            return { success: true, imagePath, timestamp, status: 'success' };
        } else {
            // API returned a client error status (4xx) that wasn't retried
            const apiErrorMsg = `API returned client error ${response.status} for ${imageFile}`;
            sendLogToRenderer(`Instance #${instanceIndex+1}: ${apiErrorMsg} ✗`, 'error');
            trackFileRetry(imagePath); // Count 4xx as a failure *for the file*
            return { success: false, imagePath, timestamp, status: 'failed', error: apiErrorMsg };
        }

    } catch (error) {
        // 5. Handle Errors (from stream, retry logic, file write, etc.)
        const retryCount = trackFileRetry(imagePath); // Increment retry count on any failure path
        const isCorrupt = retryCount >= MAX_FILE_RETRIES;
        const status = processingState.isCanceled ? 'canceled' : (isCorrupt ? 'skipped' : 'failed');
        const errorMsg = error.message || 'Unknown processing error';

        if (status === 'canceled') {
            // Don't log every single cancellation
            // sendLogToRenderer(`Processing canceled for ${imageFile}`, 'warning');
        } else if (status === 'skipped') {
            sendLogToRenderer(`Instance #${instanceIndex+1}: File ${imageFile} marked as CORRUPTED after ${retryCount} attempts: ${errorMsg} ✗`, 'error');
        } else { // status === 'failed'
            sendLogToRenderer(`Instance #${instanceIndex+1}: Error processing ${imageFile} (Attempt ${retryCount}/${MAX_FILE_RETRIES}): ${errorMsg} ✗`, 'warning');
        }

        return { success: false, imagePath, timestamp, status: status, error: errorMsg };
    } finally {
        // 6. Ensure file stream is always destroyed
        if (fileStream && !fileStream.destroyed) {
            fileStream.destroy();
        }
    }
}

/**
 * Processes images using multiple API instances concurrently with a shared queue.
 * @param {string} folderPath - Path to the folder containing images.
 * @param {string[]} imageFiles - Array of image filenames to process.
 * @param {string} jsonFolder - Path to the JSON output folder.
 * @param {string[]} apiEndpoints - Array of API endpoint URLs.
 * @returns {Promise<{success: number, failed: number, skipped: number, processedLog: object[]}>}
 */
async function processWithMultipleInstances(folderPath, imageFiles, jsonFolder, apiEndpoints) {
  const imageQueue = [...imageFiles]; // Shared queue (make copy)
  const totalFiles = imageFiles.length;
  let processedCount = 0; // Files taken from queue
  const resultsLog = []; // Stores result objects {success, imagePath, status, ...}
  const instanceCount = apiEndpoints.length;

  // Stats per instance (for UI update)
  const instanceProgress = Array.from({ length: instanceCount }, () => ({ current: 0, file: '' }));
  const instanceTotalEst = Math.ceil(totalFiles / instanceCount); // Rough estimate

  // Update overall progress (called frequently)
  function updateOverallProgressUI() {
      mainWindow.webContents.send('progress-folder', {
          current: processedCount, // Use count of files taken from queue
          total: totalFiles,
          folder: folderPath,
          file: '' // File is shown per instance now
      });
  }

   // Update instance progress UI
   function updateInstanceProgressUI(instanceIndex) {
       mainWindow.webContents.send('progress-instance', {
           instance: instanceIndex,
           current: instanceProgress[instanceIndex].current,
           total: instanceTotalEst, // Use estimate
           folder: folderPath,
           file: instanceProgress[instanceIndex].file
       });
   }


  // Worker function for each API instance
  async function instanceWorker(instanceIndex, endpoint) {
    // sendLogToRenderer(`Instance #${instanceIndex + 1} starting worker for ${path.basename(folderPath)}...`);
    // await yieldToUI();

    while (true) {
      // Check for cancellation / pause / health *before* grabbing next item
      if (processingState.isCanceled) break;
      if (!isInstanceHealthy(instanceIndex)) {
          sendLogToRenderer(`Instance #${instanceIndex + 1} worker stopping due to unhealthy state.`, 'warning');
          break;
      }
      while (processingState.isPaused && !processingState.isCanceled) {
          await new Promise(resolve => setTimeout(resolve, 200));
          await yieldToUI();
      }
      if (processingState.isCanceled) break; // Check again after pause

      // Get next image from queue (atomic pop)
      const imageFile = imageQueue.shift();
      if (!imageFile) break; // Queue is empty, exit worker

      // Increment global count and update overall progress *immediately* after taking item
      processedCount++;
      updateOverallProgressUI();

      const imagePath = path.join(folderPath, imageFile);

      // Update UI for this specific instance *before* processing
      instanceProgress[instanceIndex].current++;
      instanceProgress[instanceIndex].file = imageFile;
      updateInstanceProgressUI(instanceIndex);
      // Short yield before blocking with API call
      await yieldToUI();


      // Process the single file
      const result = await processSingleImageFile(imagePath, jsonFolder, endpoint, instanceIndex);
      resultsLog.push(result); // Collect result centrally

      // Yield after processing to allow other workers/UI
      await yieldToUI();
    }

    // Worker finished (queue empty or stopped)
     instanceProgress[instanceIndex].file = ''; // Clear current file for this instance
     updateInstanceProgressUI(instanceIndex); // Final update for this instance
    // sendLogToRenderer(`Instance #${instanceIndex + 1} worker finished for ${path.basename(folderPath)}.`);
  }

  // Start all workers
  const workerPromises = apiEndpoints.map((endpoint, index) => {
      if (isInstanceHealthy(index)) {
          return instanceWorker(index, endpoint);
      } else {
          sendLogToRenderer(`Skipping worker for initially unhealthy Instance #${index + 1}.`, 'warning');
          return Promise.resolve(); // Resolve immediately if instance unhealthy at start
      }
  });

  // Wait for all workers to complete
  await Promise.all(workerPromises);

  // Final progress update to ensure it reaches 100% if all processed
  // Ensure processedCount reflects the actual number processed if cancelled early
  processedCount = resultsLog.length;
  updateOverallProgressUI();


  // Aggregate final results from the log
  const finalSuccess = resultsLog.filter(r => r.status === 'success').length;
  const finalFailed = resultsLog.filter(r => r.status === 'failed').length;
  const finalSkipped = resultsLog.filter(r => r.status === 'skipped').length;
  const finalCanceled = resultsLog.filter(r => r.status === 'canceled').length;

  if (finalCanceled > 0) {
      sendLogToRenderer(`Processing for ${path.basename(folderPath)} included ${finalCanceled} canceled operations.`, 'warning');
  }

  return {
    success: finalSuccess,
    failed: finalFailed,
    skipped: finalSkipped,
    processedLog: resultsLog // Return the detailed log
  };
}

// Simplified single-instance batch processor using processSingleImageFile
async function processBatch(folderPath, imageFiles, jsonFolder, apiEndpoint, startIndex, batchSize, instanceIndex = 0) {
    const batchLog = [];
    const endIndex = Math.min(startIndex + batchSize, imageFiles.length);
    const totalInFolder = imageFiles.length; // Total files in the folder for UI progress

    for (let i = startIndex; i < endIndex; i++) {
        const imageFile = imageFiles[i];
        const imagePath = path.join(folderPath, imageFile);

        // Check cancel/pause before processing each file
        if (processingState.isCanceled) break;
        while (processingState.isPaused && !processingState.isCanceled) {
            await new Promise(resolve => setTimeout(resolve, 200));
            await yieldToUI();
        }
        if (processingState.isCanceled) break; // Check again

        // Update UI progress showing current file
        mainWindow.webContents.send('progress-folder', {
            current: i, // Use index 'i' for current position in folder
            total: totalInFolder,
            folder: folderPath,
            file: imageFile
        });
        await yieldToUI(); // Yield before API call

        const result = await processSingleImageFile(imagePath, jsonFolder, apiEndpoint, instanceIndex);
        batchLog.push(result);

        // Yield periodically within the batch (e.g., every item or few items)
        await yieldToUI();
    }

    // Aggregate results for the processed part of the batch
    const success = batchLog.filter(r => r.status === 'success').length;
    const failed = batchLog.filter(r => r.status === 'failed').length;
    const skipped = batchLog.filter(r => r.status === 'skipped').length;

    return { success, failed, skipped, processedLog: batchLog };
}


// --- Folder Processing ---

/**
 * Saves the processing log for a folder, merging new entries.
 * @param {string} inputFolder
 * @param {object[]} newEntries - Array of log entries from the recent processing batch.
 * @returns {Promise<number>} - Total number of entries in the log file, or -1 on error.
 */
async function saveProcessingLog(inputFolder, newEntries) {
  if (!newEntries || newEntries.length === 0) return 0; // Nothing to save

  const jsonFolder = path.join(inputFolder, 'Json');
  const logFilePath = path.join(jsonFolder, 'processed_log.json');
  let logDataMap = new Map(); // Use Map for efficient merging

  try {
    // Ensure Json folder exists
    if (!(await directoryExists(jsonFolder))) {
        await fs.mkdir(jsonFolder, { recursive: true });
    }

    // Read existing log if it exists
    if (await fileExists(logFilePath)) {
      try {
          const logContent = await fs.readFile(logFilePath, 'utf8');
          const existingLog = JSON.parse(logContent);
          // Validate existing log is an array
          if (Array.isArray(existingLog)) {
              existingLog.forEach(item => {
                  // Ensure item has imagePath before adding to map
                  if (item && typeof item.imagePath === 'string') {
                      logDataMap.set(item.imagePath, item);
                  }
              });
          } else {
               sendLogToRenderer(`Existing log file ${logFilePath} is corrupted (not an array). Starting fresh log.`, 'warning');
          }
      } catch (readError) {
          sendLogToRenderer(`Error reading/parsing existing log ${logFilePath}: ${readError.message}. Starting fresh log.`, 'warning');
          logDataMap.clear(); // Reset map if read fails
      }
    }

    // Merge new entries, overwriting existing ones with the same imagePath
    newEntries.forEach(entry => {
       // Ensure entry has imagePath before adding to map
       if (entry && typeof entry.imagePath === 'string') {
            logDataMap.set(entry.imagePath, entry);
       }
    });

    // Convert map values back to array for saving
    const updatedLogData = Array.from(logDataMap.values());

    // Save updated log file
    await fs.writeFile(logFilePath, JSON.stringify(updatedLogData, null, 2));
    await yieldToUI(); // Yield after write

    return updatedLogData.length; // Return the new total count
  } catch (error) {
    console.error('Error saving processing log:', error);
    sendLogToRenderer(`Error saving processing log for ${path.basename(inputFolder)}: ${error.message}`, 'error');
    return -1;
  }
}


/**
 * Processes a single folder, optionally including subfolders recursively.
 * Uses multi-instance or single-instance processing based on apiEndpoints count.
 */
async function processFolder(folderPath, apiEndpoints, confidenceThreshold, processMode, includeSubfolders) {
  const folderName = path.basename(folderPath);
  sendLogToRenderer(`--- Starting folder: ${folderName} ---`);
  await yieldToUI();

  // Results object for this folder and its descendants
  const result = {
      folder: folderPath,
      total: 0,      // Total files *targeted* for processing in this folder + subfolders
      processed: 0,  // Files actually attempted (result received: success, fail, skip, cancel)
      success: 0,
      failed: 0,
      skipped: 0     // Specifically files skipped due to max retries (potential corruption)
  };

  try {
    // --- 1. Identify Files and Subfolders ---
    let imageFiles = []; // Store filenames only
    let subfolders = []; // Store full paths
    try {
        const dirents = await fs.readdir(folderPath, { withFileTypes: true });
        const imageExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
        for (let i=0; i < dirents.length; i++) {
            const dirent = dirents[i];
            if (dirent.isDirectory() && dirent.name !== 'Json') {
                subfolders.push(path.join(folderPath, dirent.name));
            } else if (dirent.isFile() && imageExts.has(path.extname(dirent.name).toLowerCase())) {
                imageFiles.push(dirent.name);
            }
            if (i % 100 === 0) await yieldToUI(); // Yield during listing
        }
        sendLogToRenderer(`Folder ${folderName}: Found ${imageFiles.length} images, ${subfolders.length} subfolders.`);
    } catch (readDirError) {
        sendLogToRenderer(`Error reading directory ${folderName}: ${readDirError.message}. Skipping folder.`, 'error');
        return result; // Return empty results if directory cannot be read
    }


    // --- 2. Ensure Json Folder Exists ---
    const jsonFolder = path.join(folderPath, 'Json');
    try {
        if (!(await directoryExists(jsonFolder))) {
            sendLogToRenderer(`Creating JSON folder: ${jsonFolder}`);
            await fs.mkdir(jsonFolder, { recursive: true });
        } else {
            // sendLogToRenderer(`Using existing JSON folder: ${jsonFolder}`);
        }
        await yieldToUI();
    } catch (mkdirError) {
         sendLogToRenderer(`Error creating JSON folder ${jsonFolder}: ${mkdirError.message}. Skipping folder.`, 'error');
         return result; // Cannot proceed without JSON folder
    }


    // --- 3. Determine Files to Process Based on Mode ---
    let filesToProcess = [];
    if (processMode === 'all') {
        filesToProcess = imageFiles;
        // sendLogToRenderer(`Mode 'all': Targeting all ${filesToProcess.length} images in ${folderName}.`);
    } else { // 'new' or 'missing'
        // sendLogToRenderer(`Mode '${processMode}': Checking existing JSON files in ${folderName}...`);
        let jsonCheckedCount = 0;
        const filesWithoutJson = [];
        for (const imgFile of imageFiles) {
            const baseName = path.basename(imgFile, path.extname(imgFile));
            const jsonPath = path.join(jsonFolder, `${baseName}.json`);
            if (!(await fileExists(jsonPath))) {
                filesWithoutJson.push(imgFile);
            }
            jsonCheckedCount++;
            if (jsonCheckedCount % 100 === 0) await yieldToUI(); // Yield during JSON check
        }
        filesToProcess = filesWithoutJson;
        sendLogToRenderer(`Mode '${processMode}': Targeting ${filesToProcess.length} images (out of ${imageFiles.length}) in ${folderName}.`);
    }
    await yieldToUI();

    result.total += filesToProcess.length; // Add count for this folder level

    // --- 4. Process Identified Files ---
    let folderProcessingLog = []; // Store log entries for *this* folder level only
    if (filesToProcess.length > 0 && !processingState.isCanceled) {
        sendLogToRenderer(`Processing ${filesToProcess.length} files in ${folderName} using ${apiEndpoints.length} instance(s)...`);
        let folderResult;

        if (apiEndpoints.length > 1) {
            // Use multi-instance processing
            folderResult = await processWithMultipleInstances(folderPath, filesToProcess, jsonFolder, apiEndpoints);
        } else {
            // Use single-instance processing (in batches)
            let currentLog = [];
            let processedInFolder = 0;
            const batchSize = MAX_CONCURRENT_CONNECTIONS_PER_INSTANCE * 3; // Larger batches for single instance

            while(processedInFolder < filesToProcess.length && !processingState.isCanceled) {
                const batchResult = await processBatch(
                    folderPath,
                    filesToProcess,
                    jsonFolder,
                    apiEndpoints[0],
                    processedInFolder,
                    batchSize,
                    0 // Instance index 0
                );

                currentLog = currentLog.concat(batchResult.processedLog);
                processedInFolder += batchResult.processedLog.length; // Count actual results returned

                 // Update final progress after batch completion
                mainWindow.webContents.send('progress-folder', {
                    current: processedInFolder,
                    total: filesToProcess.length,
                    folder: folderPath,
                    file: '' // Clear file after batch
                });
                await yieldToUI();
            }
            // Aggregate results from all batches for the single instance
             folderResult = {
                success: currentLog.filter(r => r.status === 'success').length,
                failed: currentLog.filter(r => r.status === 'failed').length,
                skipped: currentLog.filter(r => r.status === 'skipped').length,
                processedLog: currentLog
            };
        }

        // Store results for this folder level
        folderProcessingLog = folderResult.processedLog;
        result.processed += folderProcessingLog.length; // Count based on actual results
        result.success += folderResult.success;
        result.failed += folderResult.failed;
        result.skipped += folderResult.skipped;

        // Save log *for this folder level*
        if (folderProcessingLog.length > 0) {
            const totalLogged = await saveProcessingLog(folderPath, folderProcessingLog);
            if (totalLogged > 0) {
                 // sendLogToRenderer(`Updated log for ${folderName} (${totalLogged} total entries).`);
            } else if (totalLogged === -1) {
                 sendLogToRenderer(`Failed to save log for ${folderName}.`, 'error');
            }
        }
        sendLogToRenderer(`Folder ${folderName} processing finished. ` +
                          `Success: ${folderResult.success}, Failed: ${folderResult.failed}, Skipped: ${folderResult.skipped}.`);

    } else if (filesToProcess.length === 0) {
        sendLogToRenderer(`No files to process in ${folderName} based on selected mode.`);
    } else {
        sendLogToRenderer(`Skipping file processing in ${folderName} due to cancellation.`);
    }
    await yieldToUI();


    // --- 5. Process Subfolders Recursively ---
    if (includeSubfolders && subfolders.length > 0 && !processingState.isCanceled) {
      sendLogToRenderer(`Processing ${subfolders.length} subfolders within ${folderName}...`);
      await yieldToUI();

      for (const subfolder of subfolders) {
        if (processingState.isCanceled) break;

        // Recursively call processFolder for the subfolder
        const subfolderResult = await processFolder(
          subfolder,
          apiEndpoints,
          confidenceThreshold,
          processMode,
          includeSubfolders // Pass recursive flag down
        );

        // Aggregate results from subfolder into parent's result object
        result.total += subfolderResult.total;
        result.processed += subfolderResult.processed;
        result.success += subfolderResult.success;
        result.failed += subfolderResult.failed;
        result.skipped += subfolderResult.skipped;

        // Yield after each subfolder completes
        await yieldToUI();
        if (processingState.isCanceled) {
            sendLogToRenderer(`Subfolder processing stopped in ${folderName} due to cancellation.`);
            break;
        }
      }
       if (!processingState.isCanceled) {
           sendLogToRenderer(`Finished processing subfolders in ${folderName}.`);
       }
    } else if (includeSubfolders && subfolders.length > 0 && processingState.isCanceled) {
        sendLogToRenderer(`Skipping subfolder processing in ${folderName} due to cancellation.`);
    }

  } catch (error) {
    // Catch errors specific to operations within this folder (reading dir, mkdir)
    console.error(`Error processing folder ${folderPath}:`, error);
    sendLogToRenderer(`FATAL error processing folder ${folderName}: ${error.message}`, 'error');
  }

  sendLogToRenderer(`--- Completed folder: ${folderName} ---`);
  await yieldToUI();
  return result;
}


// --- Main Process Images Handler ---
ipcMain.handle('process-images', async (event, data) => {
  const {
    folders,
    apiEndpoint: defaultApiEndpoint, // Use this only as default base URL if needed
    confidenceThreshold,
    processMode,
    includeSubfolders,
    apiInstances // Number of instances requested (1 = permanent only, >1 = permanent + additional)
  } = data;

  // --- 1. Reset State & Check Docker ---
  if (isProcessing) {
      sendLogToRenderer('Processing is already in progress.', 'error');
      throw new Error('Processing is already in progress.');
  }
  isProcessing = true;
  processingState = { isPaused: false, isCanceled: false }; // Reset state for new run
  clearCorruptedFiles(); // Clear corruption tracking for new session
  logCounter = 0; // Reset log counter

  sendLogToRenderer(`=== Starting New Processing Job ===`);
  sendLogToRenderer(`Folders: ${folders.length}, Mode: ${processMode}, Subfolders: ${includeSubfolders}, Instances: ${apiInstances}`);
  await yieldToUI();

  // Check Docker availability first
  if (!(await checkDockerAvailability())) {
      isProcessing = false; // Reset processing flag
      throw new Error("Docker is not available or not running. Please install/start Docker and try again.");
  }

  let apiEndpoints = []; // Stores full URLs like http://localhost:5000/evaluate
  // Clear previous instance state
  instanceRegistry = { isPermanentInstanceRunning: false, permanentInstanceId: null, additionalInstances: [] };
  instanceHealthStatus = [];
  connectionPools = {};

  try {
    // --- 2. Start/Verify Docker Instances ---
    sendLogToRenderer('Setting up Docker instances...');

    // --- Permanent Instance ---
    let permanentReady = false;
    let permanentContainerId = null; // Track ID potentially found or started
    if (await checkApiRunning(PERMANENT_INSTANCE_PORT)) {
        sendLogToRenderer(`Permanent instance (Port ${PERMANENT_INSTANCE_PORT}) already running.`, 'success');
        // We don't necessarily know the container ID if it was already running
        permanentReady = true;
    } else {
        sendLogToRenderer(`Attempting to start permanent instance on port ${PERMANENT_INSTANCE_PORT}...`);
        if (await isPortInUse(PERMANENT_INSTANCE_PORT)) {
             sendLogToRenderer(`Port ${PERMANENT_INSTANCE_PORT} is already in use but API not responding. Cannot start permanent instance.`, 'error');
             // Decide whether to proceed without permanent instance or throw error
             // Option: Throw error
              throw new Error(`Port ${PERMANENT_INSTANCE_PORT} is blocked. Cannot start permanent instance.`);
             // Option: Try to proceed with only additional instances (if apiInstances > 1)
             // sendLogToRenderer(`Will proceed with additional instances only.`, 'warning');
        } else {
            permanentContainerId = await startContainer(PERMANENT_INSTANCE_PORT, 0);
            if (permanentContainerId) {
                permanentReady = await waitForApiReady(PERMANENT_INSTANCE_PORT);
                if (!permanentReady) {
                    sendLogToRenderer(`Permanent instance started but failed readiness check. Stopping...`, 'error');
                    await stopContainer(permanentContainerId, PERMANENT_INSTANCE_PORT, 0);
                    permanentContainerId = null; // Nullify ID as it failed
                }
            }
        }
    }
    // If permanent instance is ready (either pre-existing or started successfully)
    if (permanentReady) {
        instanceRegistry.isPermanentInstanceRunning = true;
        instanceRegistry.permanentInstanceId = permanentContainerId; // Store ID if we started it
        apiEndpoints.push(`http://localhost:${PERMANENT_INSTANCE_PORT}/evaluate`);
    } else if (apiInstances <= 1) {
        // If only 1 instance was requested and it failed, we cannot proceed.
         throw new Error(`Failed to start or confirm the required permanent Docker instance on port ${PERMANENT_INSTANCE_PORT}.`);
    } else {
        // If >1 instance requested, permanent failed, log warning and continue with additional
        sendLogToRenderer(`Permanent instance failed, proceeding with additional instances only.`, 'warning');
    }


    // --- Additional Instances ---
    if (apiInstances > 1) {
        sendLogToRenderer(`Setting up ${apiInstances - 1} additional instance(s)...`);
        let additionalInstancesStarted = 0;
        for (let i = 0; i < apiInstances - 1; i++) {
            const port = ADDITIONAL_INSTANCE_START_PORT + i;
            const instanceIndex = i + 1; // Additional instances have indices 1, 2, ...

            let instanceReady = false;
            let instanceContainerId = null;

            if (await checkApiRunning(port)) {
                 sendLogToRenderer(`Additional instance #${instanceIndex+1} (Port ${port}) already running.`, 'success');
                 instanceReady = true;
                 // Don't know the container ID
            } else if (await isPortInUse(port)) {
                 sendLogToRenderer(`Port ${port} is already in use but API not responding. Skipping additional instance #${instanceIndex + 1}.`, 'error');
                 continue; // Skip this port
            } else {
                instanceContainerId = await startContainer(port, instanceIndex);
                if (instanceContainerId) {
                     instanceReady = await waitForApiReady(port);
                     if (!instanceReady) {
                         sendLogToRenderer(`Additional instance #${instanceIndex+1} (Port ${port}) failed readiness check. Stopping...`, 'warning');
                         await stopContainer(instanceContainerId, port, instanceIndex);
                         instanceContainerId = null; // Nullify ID
                     }
                }
            }

            if (instanceReady) {
                apiEndpoints.push(`http://localhost:${port}/evaluate`);
                instanceRegistry.additionalInstances.push({ containerId: instanceContainerId, port });
                additionalInstancesStarted++;
            }
             await yieldToUI(); // Yield between starting instances
             if (processingState.isCanceled) break; // Allow cancellation during startup
        }
        sendLogToRenderer(`Successfully prepared ${additionalInstancesStarted} additional instance(s).`);
    }

    if (apiEndpoints.length === 0) {
        throw new Error("No API instances are ready. Processing cannot start.");
    }
    sendLogToRenderer(`=== Processing starting with ${apiEndpoints.length} active API instance(s) ===`);

    // --- 3. Initialize Health Tracking & Periodic Check ---
    initializeInstanceHealth(apiEndpoints.length);

    if (healthCheckInterval) clearInterval(healthCheckInterval); // Clear previous interval if any
    healthCheckInterval = setInterval(async () => {
        if (!isProcessing || processingState.isCanceled) { // Stop checking if processing finishes/cancels
             if (healthCheckInterval) clearInterval(healthCheckInterval);
             healthCheckInterval = null;
             return;
        }
        try {
             // Don't log start/end of health check to reduce noise
             // sendLogToRenderer('--- Running periodic health check ---', 'info');
             await checkAndRecoverInstances();
             // sendLogToRenderer('--- Periodic health check finished ---', 'info');
        } catch (hcError) {
             sendLogToRenderer(`Error during periodic health check: ${hcError.message}`, 'error');
        }
    }, 5 * 60 * 1000); // 5 minutes


    // --- 4. Process Folders ---
    let overallTotal = 0;
    let overallProcessed = 0;
    let overallSuccess = 0;
    let overallFailed = 0;
    let overallSkipped = 0;

    for (let i = 0; i < folders.length; i++) {
      if (processingState.isCanceled) {
        sendLogToRenderer(`Processing stopped after ${i} folders due to cancellation.`);
        break;
      }

      const folder = folders[i];
      mainWindow.webContents.send('progress-overall', {
        current: i + 1,
        total: folders.length,
        folder: folder
      });
      await yieldToUI();

      // Process this folder (and potentially subfolders)
      const folderResult = await processFolder(
        folder,
        apiEndpoints,
        confidenceThreshold,
        processMode,
        includeSubfolders
      );

      // Aggregate results
      overallTotal += folderResult.total;
      overallProcessed += folderResult.processed;
      overallSuccess += folderResult.success;
      overallFailed += folderResult.failed;
      overallSkipped += folderResult.skipped;
    }

    // --- 5. Final Summary ---
    sendLogToRenderer('=== Overall Processing Summary ===', 'success');
    sendLogToRenderer(`Folders processed: ${processingState.isCanceled ? 'Partial' : folders.length} / ${folders.length}`);
    sendLogToRenderer(`Target image files: ${overallTotal}`);
    sendLogToRenderer(`Attempted processing: ${overallProcessed}`);
    sendLogToRenderer(`Successful: ${overallSuccess}`, 'success');
    sendLogToRenderer(`Failed: ${overallFailed}`, overallFailed > 0 ? 'error' : 'info');
    sendLogToRenderer(`Skipped (potential corruption): ${overallSkipped}`, overallSkipped > 0 ? 'warning' : 'info');
    if (processingState.isCanceled) {
        sendLogToRenderer('Processing was CANCELED by the user.', 'warning');
    }

    return {
      folderCount: folders.length,
      total: overallTotal,
      processed: overallProcessed,
      success: overallSuccess,
      failed: overallFailed,
      skipped: overallSkipped,
      canceled: processingState.isCanceled,
      instancesUsed: apiEndpoints.length
    };

  } catch (error) {
    console.error('Error during image processing job:', error);
    sendLogToRenderer(`FATAL PROCESSING ERROR: ${error.message}`, 'error');
    // Ensure UI knows processing stopped abnormally
    mainWindow.webContents.send('processing-canceled'); // Use cancel signal to reset UI state maybe?
    throw error; // Re-throw error to be caught by the renderer caller
  } finally {
    // --- 6. Cleanup ---
    sendLogToRenderer('=== Processing job finished. Starting cleanup... ===');
    isProcessing = false; // Mark processing as finished *before* cleanup

    // Clear health check interval
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = null;
      // sendLogToRenderer('Stopped periodic health checks.');
    }

    // Wait for connections to cool down before stopping containers
    sendLogToRenderer(`Waiting ${CONNECTION_COOLDOWN_MS/1000}s for connection cooldown...`);
    await new Promise(resolve => setTimeout(resolve, CONNECTION_COOLDOWN_MS));

    // Stop ONLY additional containers, leave permanent one running
    await stopAdditionalContainers();

    // Reset connection pools (especially for permanent instance if it remains)
     Object.keys(connectionPools).forEach(key => resetConnectionPool(parseInt(key, 10)));
     // sendLogToRenderer('Connection pools reset.');

    sendLogToRenderer('=== Cleanup complete ===');
    await yieldToUI();
  }
});
