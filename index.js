const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs').promises; // Use fs.promises for async operations
const fsSync = require('fs'); // Keep synchronous version for compatibility
const path = require('path');
const { exec } = require('child_process');
const http = require('http');
const https = require('https');
const os = require('os');
const dns = require('dns').promises;

let mainWindow;
let processingState = {
  isPaused: false,
  isCanceled: false
};

// Add global processing state
let isProcessing = false;
// Add health check interval
let healthCheckInterval = null;
// Add log counter for UI updates
let logCounter = 0;

// Configuration constants
const PERMANENT_INSTANCE_PORT = 5000;
const ADDITIONAL_INSTANCE_START_PORT = 5001;
const CONNECTION_COOLDOWN_MS = 10000;
const MAX_CONCURRENT_CONNECTIONS = 3; // Keeping this as is
const SOCKET_TIMEOUT_MS = 30000;
const CONNECTION_RESET_THRESHOLD = 3;
const MAX_FILE_RETRIES = 5; // Maximum attempts for a single file before skipping as corrupted

// Corrupted file tracking
const corruptedFiles = new Map(); // Map to track retry counts for individual files

function trackFileRetry(filePath) {
  const count = corruptedFiles.get(filePath) || 0;
  corruptedFiles.set(filePath, count + 1);
  return count + 1;
}

function isFileCorrupted(filePath) {
  return (corruptedFiles.get(filePath) || 0) >= MAX_FILE_RETRIES;
}

// Instance registry to track state
let instanceRegistry = {
  isPermanentInstanceRunning: false,
  permanentInstanceId: null,
  additionalInstances: []
};

// Track instance health
let instanceHealthStatus = [];

// Connection pools for each instance
let connectionPools = {};

// Improved helper function to yield to UI thread
function yieldToUI() {
  return new Promise(resolve => {
    // Force immediate UI update when window is out of focus
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isFocused()) {
        mainWindow.webContents.send('force-update');
      }
      
      // Use both setImmediate and setTimeout for more reliable yielding
      setImmediate(() => {
        setTimeout(resolve, 0);
      });
    } else {
      setTimeout(resolve, 0); // Fallback if window not available
    }
  });
}

// Improved log sending function to ensure UI updates
function sendLogToRenderer(message, type = '') {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  
  mainWindow.webContents.send('log', message, type);
  
  // For important messages or every 10th message, ensure UI is updated
  if (type === 'error' || type === 'warning' || logCounter++ % 10 === 0) {
    mainWindow.webContents.send('force-update');
  }
}

// Create a custom http agent with proper settings
const createHttpAgent = (instanceIndex) => {
  return new http.Agent({
    keepAlive: true,
    maxSockets: MAX_CONCURRENT_CONNECTIONS,
    maxFreeSockets: 2,
    timeout: SOCKET_TIMEOUT_MS,
    freeSocketTimeout: 30000, // Extended from 15000
    maxTotalSockets: MAX_CONCURRENT_CONNECTIONS * 2,
    scheduling: 'lifo',
    name: `instance-${instanceIndex}`
  });
};

// Create an axios instance with proper error handling
function createAxiosInstance(instanceIndex) {
  // Create or get the pool for this instance
  if (!connectionPools[instanceIndex]) {
    connectionPools[instanceIndex] = createHttpAgent(instanceIndex);
  }
  
  return axios.create({
    httpAgent: connectionPools[instanceIndex],
    timeout: 60000, // Extended timeout
    maxRedirects: 5,
    validateStatus: status => status < 500
  });
}

// Reset connection pool for an instance
function resetConnectionPool(instanceIndex) {
  if (connectionPools[instanceIndex]) {
    sendLogToRenderer(`Resetting connection pool for instance #${instanceIndex+1}`);
    
    // Destroy the old agent and create a new one
    connectionPools[instanceIndex].destroy();
    connectionPools[instanceIndex] = createHttpAgent(instanceIndex);
  }
}

// Check if a port is already in use
async function isPortInUse(port) {
  return new Promise((resolve) => {
    const tester = require('net').createServer()
      .once('error', () => resolve(true)) // Port is in use
      .once('listening', () => {
        tester.once('close', () => resolve(false)) // Port is free
              .close();
      })
      .listen(port);
  });
}

// Improved check if the API is running on a specific port
async function checkApiRunning(port = PERMANENT_INSTANCE_PORT) {
  try {
    console.log(`Checking if API is running on port ${port}...`);
    
    // Use a fresh axios instance with longer timeout for checks
    const axiosInstance = axios.create({
      timeout: 10000, // 10 second timeout
      validateStatus: () => true
    });
    
    // Try multiple times with increasing delays
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await axiosInstance.get(`http://localhost:${port}`);
        if (response.status < 500) {
          console.log(`API check response status: ${response.status}`);
          return true;
        }
      } catch (attemptError) {
        console.log(`Attempt ${attempt+1} failed, retrying...`);
        // Wait a bit more before next attempt
        await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
      }
    }
    
    return false;
  } catch (error) {
    console.error(`Error checking API on port ${port}:`, error.message);
    return false;
  }
}

// Periodically check and recover unhealthy instances - NEW FUNCTION
async function checkAndRecoverInstances() {
  sendLogToRenderer('Performing health check on all Docker instances...');
  await yieldToUI(); // Allow UI update
  
  // Check the permanent instance first
  const permanentRunning = await checkApiRunning(PERMANENT_INSTANCE_PORT);
  if (!permanentRunning && instanceRegistry.isPermanentInstanceRunning) {
    sendLogToRenderer('Primary Docker instance appears to be down. Attempting to restart...', 'error');
    await yieldToUI(); // Allow UI update
    
    // Try to restart the permanent instance
    try {
      // Stop the existing container if it's registered
      if (instanceRegistry.permanentInstanceId) {
        try {
          await new Promise(resolve => {
            exec(`docker stop ${instanceRegistry.permanentInstanceId}`, () => resolve());
          });
          await yieldToUI(); // Allow UI update
        } catch (e) {
          // Ignore errors when stopping, container might already be gone
        }
      }
      
      // Start a new container
      const containerId = await new Promise((resolve, reject) => {
        exec(`docker run -d --rm -p ${PERMANENT_INSTANCE_PORT}:5000 ghcr.io/danbooru/autotagger`, (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout.trim());
        });
      });
      
      instanceRegistry.permanentInstanceId = containerId;
      instanceRegistry.isPermanentInstanceRunning = true;
      
      // Give it time to start
      await new Promise(resolve => setTimeout(resolve, 8000));
      await yieldToUI(); // Allow UI update
      
      // Check if it's up
      const isRunning = await checkApiRunning(PERMANENT_INSTANCE_PORT);
      if (isRunning) {
        sendLogToRenderer('Primary Docker instance restarted successfully ✓', 'success');
        await yieldToUI(); // Allow UI update
        
        // Update health status
        if (instanceHealthStatus[0]) {
          instanceHealthStatus[0].isHealthy = true;
          instanceHealthStatus[0].consecutiveFailures = 0;
        }
      } else {
        sendLogToRenderer('Failed to restart primary Docker instance', 'error');
        await yieldToUI(); // Allow UI update
      }
    } catch (error) {
      sendLogToRenderer(`Error restarting primary Docker instance: ${error.message}`, 'error');
      await yieldToUI(); // Allow UI update
    }
  } else if (permanentRunning && instanceHealthStatus[0] && !instanceHealthStatus[0].isHealthy) {
    // Primary instance is running but marked as unhealthy - restore it
    sendLogToRenderer('Primary Docker instance is running but marked unhealthy. Restoring...', 'success');
    await yieldToUI(); // Allow UI update
    instanceHealthStatus[0].isHealthy = true;
    instanceHealthStatus[0].consecutiveFailures = 0;
  }
  
  // Now check additional instances
  for (let i = 0; i < instanceRegistry.additionalInstances.length; i++) {
    // Allow UI to update periodically
    if (i % 2 === 0) await yieldToUI();
    
    const instance = instanceRegistry.additionalInstances[i];
    const instanceIndex = i + 1; // Permanent is 0, additional start at 1
    
    const isRunning = await checkApiRunning(instance.port);
    
    if (!isRunning) {
      sendLogToRenderer(`Additional instance #${instanceIndex+1} on port ${instance.port} appears to be down. Restarting...`, 'warning');
      await yieldToUI(); // Allow UI update
      
      try {
        // Try to stop it first
        try {
          await new Promise(resolve => {
            exec(`docker stop ${instance.containerId}`, () => resolve());
          });
          await yieldToUI(); // Allow UI update
        } catch (e) {
          // Ignore errors when stopping
        }
        
        // Start a new one
        const containerId = await new Promise((resolve, reject) => {
          exec(`docker run -d --rm -p ${instance.port}:5000 ghcr.io/danbooru/autotagger`, (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout.trim());
          });
        });
        
        // Update registry with new container ID
        instanceRegistry.additionalInstances[i].containerId = containerId;
        
        // Give it time to start
        await new Promise(resolve => setTimeout(resolve, 5000));
        await yieldToUI(); // Allow UI update
        
        // Check if it's up
        const newIsRunning = await checkApiRunning(instance.port);
        if (newIsRunning) {
          sendLogToRenderer(`Additional instance #${instanceIndex+1} restarted successfully ✓`, 'success');
          await yieldToUI(); // Allow UI update
          
          // Update health status
          if (instanceHealthStatus[instanceIndex]) {
            instanceHealthStatus[instanceIndex].isHealthy = true;
            instanceHealthStatus[instanceIndex].consecutiveFailures = 0;
          }
        } else {
          sendLogToRenderer(`Failed to restart additional instance #${instanceIndex+1}`, 'error');
          await yieldToUI(); // Allow UI update
        }
      } catch (error) {
        sendLogToRenderer(`Error restarting additional instance #${instanceIndex+1}: ${error.message}`, 'error');
        await yieldToUI(); // Allow UI update
      }
    } else if (instanceHealthStatus[instanceIndex] && !instanceHealthStatus[instanceIndex].isHealthy) {
      // Instance is running but marked as unhealthy - restore it
      sendLogToRenderer(`Additional instance #${instanceIndex+1} is running but marked unhealthy. Restoring...`, 'success');
      await yieldToUI(); // Allow UI update
      instanceHealthStatus[instanceIndex].isHealthy = true;
      instanceHealthStatus[instanceIndex].consecutiveFailures = 0;
    }
  }
  
  sendLogToRenderer('Health check and recovery completed');
  await yieldToUI(); // Allow UI update
}

// Enhanced retry with circuit breaker
async function enhancedRetryRequest(fn, instanceIndex, maxRetries = 3, initialDelay = 1000) {
  let consecutiveErrors = 0;
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      consecutiveErrors = 0; // Reset on success
      return result;
    } catch (error) {
      lastError = error;
      consecutiveErrors++;
      
      console.log(`Retry ${attempt}/${maxRetries}: ${error.message}`);
      
      // If we've seen many errors, reset the connection pool
      if (consecutiveErrors >= CONNECTION_RESET_THRESHOLD) {
        resetConnectionPool(instanceIndex);
        consecutiveErrors = 0;
      }
      
      // Allow UI to update
      await yieldToUI();
      
      // Don't wait on the last attempt
      if (attempt < maxRetries) {
        // Exponential backoff with jitter
        const backoff = initialDelay * Math.pow(1.5, attempt - 1) * (0.9 + Math.random() * 0.2);
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }
  }
  
  // All retries failed, throw the last error
  throw lastError;
}

// Wait for sockets to cool down before continuing
async function waitForSocketsCooldown(ms = CONNECTION_COOLDOWN_MS) {
  sendLogToRenderer(`Waiting ${ms/1000} seconds for connections to close...`);
  await yieldToUI(); // Allow UI update
  await new Promise(resolve => setTimeout(resolve, ms));
}

// Initialize health tracking for instances
function initializeInstanceHealth(instanceCount) {
  instanceHealthStatus = [];
  for (let i = 0; i < instanceCount; i++) {
    instanceHealthStatus.push({
      consecutiveFailures: 0,
      totalRequests: 0,
      successfulRequests: 0,
      isHealthy: true
    });
  }
}

// Update health status for an instance
function updateInstanceHealth(instanceIndex, success) {
  if (!instanceHealthStatus[instanceIndex]) return;
  
  instanceHealthStatus[instanceIndex].totalRequests++;
  
  if (success) {
    instanceHealthStatus[instanceIndex].successfulRequests++;
    instanceHealthStatus[instanceIndex].consecutiveFailures = 0;
  } else {
    instanceHealthStatus[instanceIndex].consecutiveFailures++;
    
    // Mark instance as unhealthy if too many consecutive failures
    if (instanceHealthStatus[instanceIndex].consecutiveFailures >= 5) {
      if (instanceHealthStatus[instanceIndex].isHealthy) {
        instanceHealthStatus[instanceIndex].isHealthy = false;
        sendLogToRenderer(`Instance #${instanceIndex+1} marked as unhealthy after 5 consecutive failures`, 'error');
      }
    }
  }
}

// Check if an instance is healthy
function isInstanceHealthy(instanceIndex) {
  return instanceHealthStatus[instanceIndex] && instanceHealthStatus[instanceIndex].isHealthy;
}

// Create the main application window with background throttling disabled
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 650,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false  // Prevent throttling when out of focus
    }
  });

  mainWindow.loadFile('index.html');
}

// REMOVED: No longer trying to start Docker at app launch
app.whenReady().then(() => {
  createWindow();
});

// Start permanent instance if needed - simplified to just check
async function ensurePermanentInstanceRunning() {
  // Just check if it's running - don't try to start it here
  const isPermanentRunning = await checkApiRunning(PERMANENT_INSTANCE_PORT);
  
  if (isPermanentRunning) {
    sendLogToRenderer('Permanent API instance already running ✓', 'success');
    await yieldToUI(); // Allow UI update
    instanceRegistry.isPermanentInstanceRunning = true;
    return true;
  }
  
  return false;
}

// Stop only additional containers, leave permanent one running
async function stopAdditionalContainers() {
  if (instanceRegistry.additionalInstances.length === 0) {
    return;
  }
  
  sendLogToRenderer(`Stopping ${instanceRegistry.additionalInstances.length} additional API instances...`);
  await yieldToUI(); // Allow UI update
  
  const promises = instanceRegistry.additionalInstances.map(instance => {
    return new Promise(resolve => {
      exec(`docker stop ${instance.containerId}`, (error) => {
        if (error) {
          sendLogToRenderer(`Error stopping container on port ${instance.port}: ${error.message}`, 'error');
        } else {
          sendLogToRenderer(`Stopped API instance on port ${instance.port}`);
        }
        resolve();
      });
    });
  });
  
  await Promise.all(promises);
  instanceRegistry.additionalInstances = [];
  
  // Wait for ports to be released
  await new Promise(resolve => setTimeout(resolve, 3000));
  await yieldToUI(); // Allow UI update
}

// Shutdown all containers (used on app exit)
async function shutdownAllContainers() {
  // First stop additional containers
  await stopAdditionalContainers();
  
  // Then stop permanent instance if it exists
  if (instanceRegistry.permanentInstanceId) {
    try {
      await new Promise((resolve, reject) => {
        exec(`docker stop ${instanceRegistry.permanentInstanceId}`, (error) => {
          if (error) {
            sendLogToRenderer(`Error stopping permanent container: ${error.message}`, 'error');
          } else {
            sendLogToRenderer(`Stopped permanent API instance`);
          }
          resolve();
        });
      });
      
      instanceRegistry.permanentInstanceId = null;
      instanceRegistry.isPermanentInstanceRunning = false;
      await yieldToUI(); // Allow UI update
    } catch (error) {
      console.error('Error stopping permanent container:', error);
    }
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Make sure to clean up Docker containers on app exit
app.on('before-quit', async (event) => {
  if (instanceRegistry.additionalInstances.length > 0 || instanceRegistry.permanentInstanceId) {
    event.preventDefault();
    await waitForSocketsCooldown();
    await shutdownAllContainers();
    app.quit();
  }
});

// Handle unexpected termination
process.on('SIGINT', async () => {
  try {
    await waitForSocketsCooldown();
    await shutdownAllContainers();
  } catch (error) {
    console.error('Error stopping containers:', error);
  }
  process.exit(0);
});

process.on('uncaughtException', async (error) => {
  console.error('Uncaught exception:', error);
  try {
    await waitForSocketsCooldown();
    await shutdownAllContainers();
  } catch (stopError) {
    console.error('Error stopping containers:', stopError);
  }
  process.exit(1);
});

// Handle folder selection for single folder
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Folder Containing Images'
  });
  
  if (!result.canceled) {
    return result.filePaths[0];
  }
  return null;
});

// Handle folder selection for multiple folders
ipcMain.handle('select-folders', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'multiSelections'],
    title: 'Select Folder(s) Containing Images'
  });
  
  if (!result.canceled) {
    return result.filePaths;
  }
  return [];
});

// Analyze folder for existing JSON files
ipcMain.handle('analyze-folder', async (event, inputFolder) => {
  try {
    // Check if Json folder exists
    const jsonFolder = path.join(inputFolder, 'Json');
    if (!fsSync.existsSync(jsonFolder)) { // Keep using sync for this check
      return {
        hasJsonFolder: false,
        jsonCount: 0,
        logCount: 0,
        missingCount: 0
      };
    }
    
    // Count JSON files
    const jsonFiles = (await fs.readdir(jsonFolder)).filter(file => 
      file.toLowerCase().endsWith('.json') && file !== 'processed_log.json'
    );
    await yieldToUI(); // Allow UI update
    
    // Check for processing log
    const logFilePath = path.join(jsonFolder, 'processed_log.json');
    let logCount = 0;
    let missing = [];
    
    if (fsSync.existsSync(logFilePath)) { // Keep using sync for this check
      try {
        const logContent = await fs.readFile(logFilePath, 'utf8');
        const logData = JSON.parse(logContent);
        logCount = logData.length;
        
        // Check for missing JSON files based on the log
        for (const entry of logData) {
          if (entry.status === 'success') {
            const jsonFileName = path.basename(entry.imagePath, path.extname(entry.imagePath)) + '.json';
            const jsonFilePath = path.join(jsonFolder, jsonFileName);
            
            if (!fsSync.existsSync(jsonFilePath)) { // Keep using sync for this check
              missing.push(entry.imagePath);
            }
          }
          
          // Yield to UI every 100 entries to prevent blocking
          if (missing.length % 100 === 0) await yieldToUI();
        }
      } catch (logError) {
        console.error('Error parsing log file:', logError);
      }
    }
    
    // Get image files count in the input folder
    const imageFiles = (await fs.readdir(inputFolder)).filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
    });
    await yieldToUI(); // Allow UI update
    
    return {
      hasJsonFolder: true,
      jsonCount: jsonFiles.length,
      logCount: logCount,
      missingCount: missing.length,
      imageCount: imageFiles.length
    };
  } catch (error) {
    console.error('Error analyzing folder:', error);
    return {
      hasJsonFolder: false,
      error: error.message
    };
  }
});

// Check API connection
ipcMain.handle('check-api-connection', async (event, apiEndpoint) => {
  try {
    const axiosInstance = createAxiosInstance(0); // Use instance 0 for checks
    await axiosInstance.get(apiEndpoint.replace('/evaluate', ''), {
      timeout: 5000 // 5 second timeout
    });
    return { success: true };
  } catch (error) {
    console.error('API connection error:', error.message);
    return { 
      success: false, 
      error: error.message 
    };
  }
});

// Save processing log
async function saveProcessingLog(inputFolder, processed) {
  try {
    const jsonFolder = path.join(inputFolder, 'Json');
    const logFilePath = path.join(jsonFolder, 'processed_log.json');
    
    // Create or update log file
    let logData = [];
    if (fsSync.existsSync(logFilePath)) { // Keep using sync for this check
      const logContent = await fs.readFile(logFilePath, 'utf8');
      logData = JSON.parse(logContent);
    }
    
    // Add new entries, replacing any duplicates
    processed.forEach(entry => {
      logData = logData.filter(item => item.imagePath !== entry.imagePath);
      logData.push(entry);
    });
    
    // Save log file
    await fs.writeFile(logFilePath, JSON.stringify(logData, null, 2));
    await yieldToUI(); // Allow UI update
    
    return logData.length;
  } catch (error) {
    console.error('Error saving processing log:', error);
    return -1;
  }
}

// Check for missing JSON files
async function checkMissingJsonFiles(inputFolder) {
  try {
    const jsonFolder = path.join(inputFolder, 'Json');
    const logFilePath = path.join(jsonFolder, 'processed_log.json');
    
    if (!fsSync.existsSync(logFilePath)) { // Keep using sync for this check
      return { processed: [], missing: [] };
    }
    
    const logContent = await fs.readFile(logFilePath, 'utf8');
    const logData = JSON.parse(logContent);
    
    const missing = [];
    for (const entry of logData) {
      if (entry.status === 'success') {
        const jsonFileName = path.basename(entry.imagePath, path.extname(entry.imagePath)) + '.json';
        const jsonFilePath = path.join(jsonFolder, jsonFileName);
        
        if (!fsSync.existsSync(jsonFilePath)) { // Keep using sync for this check
          missing.push(entry.imagePath);
        }
      }
      
      // Yield to UI every 100 entries to prevent blocking
      if (logData.indexOf(entry) % 100 === 0) await yieldToUI();
    }
    
    return {
      processed: logData.map(entry => entry.imagePath),
      missing
    };
  } catch (error) {
    console.error('Error checking missing JSON files:', error);
    return { processed: [], missing: [] };
  }
}

// Handle pause/resume toggle
ipcMain.on('toggle-pause', () => {
  processingState.isPaused = !processingState.isPaused;
  mainWindow.webContents.send('pause-state-changed', processingState.isPaused);
});

// Handle cancel request
ipcMain.on('cancel-processing', () => {
  processingState.isCanceled = true;
  mainWindow.webContents.send('processing-canceled');
});

// Process with multiple instances using a shared queue approach
async function processWithMultipleInstances(folderPath, imageFiles, jsonFolder, apiEndpoints) {
  // Create a shared queue of all images to process
  const imageQueue = [...imageFiles]; // Make a copy of the imageFiles array to use as our queue
  
  // Create an array to track results
  let processedCount = 0;
  let success = 0;
  let failed = 0;
  let skipped = 0;
  let processedLog = [];
  
  // Failed images to retry
  let failedImages = [];
  
  // Update overall progress
  async function updateOverallProgress() {
    mainWindow.webContents.send('progress-folder', {
      current: processedCount,
      total: imageFiles.length,
      folder: folderPath,
      file: ''
    });
    await yieldToUI(); // Allow UI update
  }
  
  // Create a function for each instance to process images from the queue
  async function instanceWorker(endpoint, instanceIndex) {
    sendLogToRenderer(`Instance #${instanceIndex+1} started on ${endpoint}`);
    await yieldToUI(); // Allow UI update
    
    let instanceProcessed = 0;
    let instanceSuccess = 0;
    let instanceFailed = 0;
    let instanceSkipped = 0;
    let instanceLog = [];
    let consecutiveErrors = 0;
    
    // Create axios instance with proper connection management
    const axiosInstance = createAxiosInstance(instanceIndex);
    
    // Keep processing until the queue is empty or processing is canceled
    while (imageQueue.length > 0 && !processingState.isCanceled) {
      // Check if instance is still healthy
      if (!isInstanceHealthy(instanceIndex)) {
        sendLogToRenderer(`Instance #${instanceIndex+1} is no longer healthy. Stopping this worker.`, 'error');
        await yieldToUI(); // Allow UI update
        break;
      }
      
      // Handle pause state
      if (processingState.isPaused) {
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }
      
      // Take a batch of images from the front of the queue
      const batchSize = Math.min(MAX_CONCURRENT_CONNECTIONS, imageQueue.length);
      const batchFiles = [];
      
      for (let i = 0; i < batchSize; i++) {
        if (imageQueue.length > 0) {
          batchFiles.push(imageQueue.shift()); // Remove from front of queue
        }
      }
      
      if (batchFiles.length === 0) break; // Safeguard
      
      // Update instance progress
      mainWindow.webContents.send('progress-instance', {
        instance: instanceIndex,
        current: instanceProcessed,
        total: instanceProcessed + batchFiles.length + (imageQueue.length / apiEndpoints.length),
        folder: folderPath
      });
      await yieldToUI(); // Allow UI update
      
      // Process this batch of images
      const batchPromises = batchFiles.map(async (imageFile, index) => {
        const imagePath = path.join(folderPath, imageFile);

        // Check if this file has been identified as corrupted
        if (isFileCorrupted(imagePath)) {
          sendLogToRenderer(`Skipping potentially corrupted file: ${imageFile} (failed ${MAX_FILE_RETRIES} times) ✗`, 'error');
          instanceSkipped++;
          
          return {
            success: false,
            imagePath,
            timestamp: new Date().toISOString(),
            status: 'skipped',
            error: `File potentially corrupted - failed ${MAX_FILE_RETRIES} attempts`
          };
        }
        
        try {
          const jsonFileName = path.basename(imageFile, path.extname(imageFile)) + '.json';
          const jsonFilePath = path.join(jsonFolder, jsonFileName);
          
          // Create form data and filestream
          const formData = new FormData();
          const fileStream = fsSync.createReadStream(imagePath); // Keep using sync for this operation
          formData.append('file', fileStream);
          formData.append('format', 'json');
          
          try {
            // Use enhanced retry with circuit breaker
            const response = await enhancedRetryRequest(async () => {
              return await axiosInstance.post(endpoint, formData, {
                headers: {
                  ...formData.getHeaders(),
                },
                maxBodyLength: Infinity,
                maxContentLength: Infinity
              });
            }, instanceIndex, 3, 2000);
            
            // Check for error status codes
            if (response.status >= 400) {
              throw new Error(`API returned error status: ${response.status}`);
            }
            
            // Save JSON
            await fs.writeFile(jsonFilePath, JSON.stringify(response.data, null, 2));
            
            sendLogToRenderer(`Instance #${instanceIndex+1} processed ${imageFile} ✓`);
            instanceSuccess++;
            consecutiveErrors = 0; // Reset error counter on success
            updateInstanceHealth(instanceIndex, true);
            
            return {
              success: true,
              imagePath,
              timestamp: new Date().toISOString(),
              status: 'success'
            };
          } finally {
            // Always clean up file stream
            fileStream.destroy();
          }
        } catch (error) {
          // Increment the retry counter for this file
          const retryCount = trackFileRetry(imagePath);
          
          if (retryCount >= MAX_FILE_RETRIES) {
            sendLogToRenderer(`Image ${imageFile} might be corrupted, skipping after ${retryCount} attempts ✗`, 'error');
            instanceSkipped++;
          } else {
            sendLogToRenderer(`Instance #${instanceIndex+1} error processing ${imageFile}: ${error.message} ✗ (attempt ${retryCount}/${MAX_FILE_RETRIES})`);
            instanceFailed++;
            consecutiveErrors++;
            updateInstanceHealth(instanceIndex, false);
            
            // If too many consecutive errors, reset connection
            if (consecutiveErrors >= CONNECTION_RESET_THRESHOLD) {
              sendLogToRenderer(`Too many consecutive errors for Instance #${instanceIndex+1}. Resetting connection...`, 'warning');
              resetConnectionPool(instanceIndex);
              consecutiveErrors = 0;
              
              // Only add to failedImages if not potentially corrupted
              if (retryCount < MAX_FILE_RETRIES) {
                failedImages.push(imageFile);
              }
            }
          }
          
          return {
            success: false,
            imagePath,
            timestamp: new Date().toISOString(),
            status: retryCount >= MAX_FILE_RETRIES ? 'skipped' : 'failed',
            error: retryCount >= MAX_FILE_RETRIES ? 
              `File potentially corrupted - failed ${retryCount} attempts` : 
              error.message
          };
        }
        
        // Yield to UI every few items to prevent UI freezing
        if (index % 3 === 0) await yieldToUI();
      });
      
      // Wait for this batch to complete
      const batchResults = await Promise.all(batchPromises);
      instanceLog = instanceLog.concat(batchResults);
      instanceProcessed += batchFiles.length;
      
      // Update instance progress again after batch completion
      mainWindow.webContents.send('progress-instance', {
        instance: instanceIndex,
        current: instanceProcessed,
        total: instanceProcessed + (imageQueue.length / apiEndpoints.length),
        folder: folderPath
      });
      await yieldToUI(); // Allow UI update
      
      // Update overall counters
      processedCount += batchFiles.length;
      success += batchResults.filter(r => r.success).length;
      failed += batchResults.filter(r => !r.success && r.status === 'failed').length;
      skipped += batchResults.filter(r => r.status === 'skipped').length;
      
      // Update overall progress
      await updateOverallProgress();
      
      // Small delay between batches to prevent overwhelming the API and allow UI updates
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    
    sendLogToRenderer(`Instance #${instanceIndex+1} finished. Processed: ${instanceProcessed}, Success: ${instanceSuccess}, Failed: ${instanceFailed}, Skipped: ${instanceSkipped}`);
    await yieldToUI(); // Allow UI update
    
    return {
      instanceProcessed,
      instanceSuccess,
      instanceFailed,
      instanceSkipped,
      instanceLog
    };
  }
  
  // Start all instance workers
  const instancePromises = apiEndpoints.map((endpoint, index) => {
    // Check if instance is healthy
    if (isInstanceHealthy(index)) {
      return instanceWorker(endpoint, index);
    } else {
      // Skip unhealthy instances
      sendLogToRenderer(`Skipping unhealthy instance #${index+1}`);
      return Promise.resolve({
        instanceProcessed: 0,
        instanceSuccess: 0,
        instanceFailed: 0,
        instanceSkipped: 0,
        instanceLog: []
      });
    }
  });
  
  // Wait for all instances to finish
  const instanceResults = await Promise.all(instancePromises);
  
  // Process any remaining failed images (that aren't marked as corrupted)
  if (failedImages.length > 0 && !processingState.isCanceled) {
    sendLogToRenderer(`Retrying ${failedImages.length} failed images...`, 'warning');
    await yieldToUI(); // Allow UI update
    
    // Filter out any images that have become marked as corrupted
    const nonCorruptedFailedImages = failedImages.filter(imageFile => {
      const imagePath = path.join(folderPath, imageFile);
      return !isFileCorrupted(imagePath);
    });
    
    if (nonCorruptedFailedImages.length < failedImages.length) {
      sendLogToRenderer(`Skipping ${failedImages.length - nonCorruptedFailedImages.length} corrupted images from retry queue`, 'warning');
      await yieldToUI();
    }
    
    // If we still have non-corrupted failed images and healthy instances
    if (nonCorruptedFailedImages.length > 0 && apiEndpoints.length > 0) {
      // Add failed images back to the queue
      const retryResults = await processWithMultipleInstances(
        folderPath,
        nonCorruptedFailedImages,
        jsonFolder,
        apiEndpoints
      );
      
      // Update counters with retry results
      success += retryResults.success;
      failed = retryResults.failed;
      skipped += retryResults.skipped || 0;
      processedLog = processedLog.concat(retryResults.processedLog);
    }
  }
  
  // Combine all logs
  instanceResults.forEach(result => {
    processedLog = processedLog.concat(result.instanceLog);
  });
  
  // Log the number of potentially corrupted files skipped
  const corruptedCount = processedLog.filter(entry => entry.status === 'skipped').length;
  if (corruptedCount > 0) {
    sendLogToRenderer(`Skipped ${corruptedCount} potentially corrupted files after multiple failed attempts`, 'warning');
    await yieldToUI();
  }
  
  return {
    success,
    failed,
    skipped: corruptedCount,
    processedLog
  };
}

// Process a batch of images with a single API
async function processBatch(folderPath, imageFiles, jsonFolder, apiEndpoint, startIndex, batchSize, instanceIndex = 0) {
  const batchPromises = [];
  const batchResults = {
    success: 0,
    failed: 0,
    skipped: 0,
    processedLog: []
  };
  
  // Create axios instance with proper connection management
  const axiosInstance = createAxiosInstance(instanceIndex);
  
  const endIndex = Math.min(startIndex + batchSize, imageFiles.length);
  
  for (let i = startIndex; i < endIndex; i++) {
    const imageFile = imageFiles[i];
    
    // Skip if canceled
    if (processingState.isCanceled) break;
    
    // Wait if paused
    while (processingState.isPaused) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (processingState.isCanceled) break;
    }
    if (processingState.isCanceled) break;
    
    // Yield to UI every 3 iterations
    if ((i - startIndex) % 3 === 0) await yieldToUI();
    
    const processPromise = (async () => {
      const imagePath = path.join(folderPath, imageFile);
      
      // Check if this file has been identified as corrupted
      if (isFileCorrupted(imagePath)) {
        sendLogToRenderer(`Skipping potentially corrupted file: ${imageFile} (failed ${MAX_FILE_RETRIES} times) ✗`, 'error');
        batchResults.skipped++;
        
        return {
          success: false,
          imagePath,
          timestamp: new Date().toISOString(),
          status: 'skipped',
          error: `File potentially corrupted - failed ${MAX_FILE_RETRIES} attempts`
        };
      }
      
      try {
        const jsonFileName = path.basename(imageFile, path.extname(imageFile)) + '.json';
        const jsonFilePath = path.join(jsonFolder, jsonFileName);
        
        // Create form data and file stream
        const formData = new FormData();
        const fileStream = fsSync.createReadStream(imagePath); // Keep using sync for this operation
        formData.append('file', fileStream);
        formData.append('format', 'json');
        
        try {
          // Use enhanced retry with circuit breaker
          const response = await enhancedRetryRequest(async () => {
            return await axiosInstance.post(apiEndpoint, formData, {
              headers: {
                ...formData.getHeaders(),
              },
              maxBodyLength: Infinity,
              maxContentLength: Infinity
            });
          }, instanceIndex, 3, 2000);
          
          // Check for error status codes
          if (response.status >= 400) {
            throw new Error(`API returned error status: ${response.status}`);
          }
          
          // Save JSON
          await fs.writeFile(jsonFilePath, JSON.stringify(response.data, null, 2));
          
          sendLogToRenderer(`Processed ${imageFile} in ${path.basename(folderPath)} ✓`);
          batchResults.success++;
          
          return {
            success: true,
            imagePath,
            timestamp: new Date().toISOString(),
            status: 'success'
          };
        } finally {
          // Always clean up file stream
          fileStream.destroy();
        }
      } catch (error) {
        // Increment the retry counter for this file
        const retryCount = trackFileRetry(imagePath);
        
        if (retryCount >= MAX_FILE_RETRIES) {
          sendLogToRenderer(`Image ${imageFile} might be corrupted, skipping after ${retryCount} attempts ✗`, 'error');
          batchResults.skipped++;
          
          return {
            success: false,
            imagePath,
            timestamp: new Date().toISOString(),
            status: 'skipped',
            error: `File potentially corrupted - failed ${retryCount} attempts`
          };
        } else {
          sendLogToRenderer(`Error processing ${imageFile}: ${error.message} ✗ (attempt ${retryCount}/${MAX_FILE_RETRIES})`);
          batchResults.failed++;
          
          return {
            success: false,
            imagePath,
            timestamp: new Date().toISOString(),
            status: 'failed',
            error: error.message
          };
        }
      }
    })();
    
    batchPromises.push(processPromise);
  }
  
  const results = await Promise.all(batchPromises);
  batchResults.processedLog = results;
  
  return batchResults;
}

// Process a single folder and its subfolders if requested
async function processFolder(folderPath, apiEndpoints, confidenceThreshold, processMode, includeSubfolders) {
  try {
    // Reset corrupted files tracking when starting a new folder
    corruptedFiles.clear();
    
    // Get all files in this folder
    const allFiles = await fs.readdir(folderPath);
    await yieldToUI(); // Allow UI update
    
    // Separate images and subfolders
    const imageFiles = [];
    const subfolders = [];
    
    for (const file of allFiles) {
      const fullPath = path.join(folderPath, file);
      
      // Skip if path doesn't exist (could have been deleted)
      if (!fsSync.existsSync(fullPath)) continue; // Keep using sync for this check
      
      const stats = await fs.stat(fullPath);
      
      if (stats.isDirectory() && file !== 'Json') {
        subfolders.push(fullPath);
      } else if (stats.isFile()) {
        const ext = path.extname(file).toLowerCase();
        if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
          imageFiles.push(file);
        }
      }
      
      // Yield to UI every 50 files to prevent freezing
      if ((allFiles.indexOf(file) + 1) % 50 === 0) await yieldToUI();
    }
    
    // Add debug logging for subfolder detection
    sendLogToRenderer(`Found ${subfolders.length} subfolders in ${path.basename(folderPath)}`);
    await yieldToUI(); // Allow UI update
    
    if (subfolders.length > 0) {
      let subfoldersStr = subfolders.map(sf => path.basename(sf)).join(', ');
      if (subfoldersStr.length > 100) subfoldersStr = subfoldersStr.substring(0, 100) + '...';
      sendLogToRenderer(`Subfolders: ${subfoldersStr}`);
      await yieldToUI(); // Allow UI update
    }
    
    // Create Json folder for this folder
    const jsonFolder = path.join(folderPath, 'Json');
    if (!fsSync.existsSync(jsonFolder)) { // Keep using sync for this check
      await fs.mkdir(jsonFolder, { recursive: true });
    }
    
    // Determine which files to process based on mode
    let filesToProcess = [];
    
    if (processMode === 'all') {
      filesToProcess = imageFiles;
      sendLogToRenderer(`Processing all ${filesToProcess.length} images in ${path.basename(folderPath)}`);
      await yieldToUI(); // Allow UI update
      
    } else if (processMode === 'new') {
      // For "new" images: Check if they have JSON files, if not, they're new
      const newFiles = [];
      let existingJsonCount = 0;
      
      for (const file of imageFiles) {
        const baseName = path.basename(file, path.extname(file));
        const jsonPath = path.join(jsonFolder, `${baseName}.json`);
        
        if (fsSync.existsSync(jsonPath)) { // Keep using sync for this check
          existingJsonCount++;
        } else {
          newFiles.push(file);
        }
        
        // Yield to UI every 50 files to prevent freezing
        if (imageFiles.indexOf(file) % 50 === 0) await yieldToUI();
      }
      
      filesToProcess = newFiles;
      sendLogToRenderer(`Found ${existingJsonCount} existing JSON files. Processing ${filesToProcess.length} new images in ${path.basename(folderPath)}`);
      await yieldToUI(); // Allow UI update
      
    } else if (processMode === 'missing') {
      // For "missing" files: Same logic as "new" but different messaging
      const missingFiles = [];
      let jsonCount = 0;
      
      for (const file of imageFiles) {
        const baseName = path.basename(file, path.extname(file));
        const jsonPath = path.join(jsonFolder, `${baseName}.json`);
        
        if (fsSync.existsSync(jsonPath)) { // Keep using sync for this check
          jsonCount++;
        } else {
          missingFiles.push(file);
        }
        
        // Yield to UI every 50 files to prevent freezing
        if (imageFiles.indexOf(file) % 50 === 0) await yieldToUI();
      }
      
      filesToProcess = missingFiles;
      sendLogToRenderer(`Found ${jsonCount} existing JSON files. Processing ${filesToProcess.length} missing JSON files in ${path.basename(folderPath)}`);
      await yieldToUI(); // Allow UI update
    }
    
    // Initialize result object
    const result = {
      folder: folderPath,
      total: 0,
      processed: 0,
      success: 0,
      failed: 0,
      skipped: 0
    };

    // Only process files if there are any to process
    if (filesToProcess.length > 0) {
      sendLogToRenderer(`Processing ${filesToProcess.length} files in ${path.basename(folderPath)}`);
      await yieldToUI(); // Allow UI update
      
      let processedCount = 0;
      let success = 0;
      let failed = 0;
      let skipped = 0;
      let processedLog = [];
      
      // Choose processing method based on number of API endpoints
      if (apiEndpoints.length > 1) {
        // Process with multiple instances using shared queue
        sendLogToRenderer(`Using ${apiEndpoints.length} API instances with shared queue for ${path.basename(folderPath)}`);
        await yieldToUI(); // Allow UI update
        
        const multiResults = await processWithMultipleInstances(
          folderPath,
          filesToProcess,
          jsonFolder,
          apiEndpoints
        );
        
        processedCount = multiResults.processedLog.length;
        success = multiResults.success;
        failed = multiResults.failed;
        skipped = multiResults.skipped || 0;
        processedLog = multiResults.processedLog;
        
        // Update overall progress
        mainWindow.webContents.send('progress-folder', {
          current: processedCount,
          total: filesToProcess.length,
          folder: folderPath,
          file: ''
        });
        await yieldToUI(); // Allow UI update
      } else {
        // Process with single instance in batches
        sendLogToRenderer(`Using single API instance for ${path.basename(folderPath)}`);
        await yieldToUI(); // Allow UI update
        
        // Process in batches until all images are processed
        while (processedCount < filesToProcess.length && !processingState.isCanceled) {
          // Skip if paused
          if (processingState.isPaused) {
            await new Promise(resolve => setTimeout(resolve, 100));
            continue;
          }
          
          // Update progress at the start of a new batch
          mainWindow.webContents.send('progress-folder', {
            current: processedCount,
            total: filesToProcess.length,
            folder: folderPath,
            file: processedCount < filesToProcess.length ? filesToProcess[processedCount] : ''
          });
          await yieldToUI(); // Allow UI update
          
          // Process a batch of images concurrently
          const batchResults = await processBatch(
            folderPath, 
            filesToProcess, 
            jsonFolder, 
            apiEndpoints[0], // Use the first (and only) endpoint
            processedCount, 
            MAX_CONCURRENT_CONNECTIONS,
            0 // Use instance index 0 for the permanent instance
          );
          
          // Update counters
          success += batchResults.success;
          failed += batchResults.failed;
          skipped += batchResults.skipped;
          processedLog = processedLog.concat(batchResults.processedLog);
          processedCount += Math.min(MAX_CONCURRENT_CONNECTIONS, filesToProcess.length - processedCount);
          
          // Update overall progress after the batch
          mainWindow.webContents.send('progress-folder', {
            current: processedCount,
            total: filesToProcess.length,
            folder: folderPath,
            file: ''
          });
          await yieldToUI(); // Allow UI update
        }
      }
      
      // Save processing log
      if (processedLog.length > 0) {
        const totalLogged = await saveProcessingLog(folderPath, processedLog);
        sendLogToRenderer(`Updated log for ${path.basename(folderPath)} with ${totalLogged} entries`);
        await yieldToUI(); // Allow UI update
      }
      
      // Update result with current folder's results
      result.total = filesToProcess.length;
      result.processed = processedCount;
      result.success = success;
      result.failed = failed;
      result.skipped = skipped;
      
      // Log summary including skipped files
      if (skipped > 0) {
        sendLogToRenderer(`Summary for ${path.basename(folderPath)}: Success: ${success}, Failed: ${failed}, Skipped as corrupted: ${skipped}`);
        await yieldToUI();
      }
    } else {
      sendLogToRenderer(`No files to process in ${path.basename(folderPath)}`);
      await yieldToUI(); // Allow UI update
    }
    
    // Process subfolders if requested - IMPROVED SECTION
    if (includeSubfolders && subfolders.length > 0 && !processingState.isCanceled) {
      sendLogToRenderer(`Processing ${subfolders.length} subfolders in ${path.basename(folderPath)} (includeSubfolders=${includeSubfolders})...`);
      await yieldToUI(); // Allow UI update
      
      for (const subfolder of subfolders) {
        if (processingState.isCanceled) break;
        
        sendLogToRenderer(`--- Starting subfolder: ${path.basename(subfolder)} ---`);
        await yieldToUI(); // Allow UI update
        
        const subfolderResult = await processFolder(
          subfolder, 
          apiEndpoints, 
          confidenceThreshold, 
          processMode, 
          includeSubfolders  // Keep recursive subfolder processing
        );
        
        // Add subfolder results to totals
        result.total += subfolderResult.total;
        result.processed += subfolderResult.processed;
        result.success += subfolderResult.success;
        result.failed += subfolderResult.failed;
        result.skipped += subfolderResult.skipped || 0;
        
        sendLogToRenderer(`--- Completed subfolder: ${path.basename(subfolder)}, Found: ${subfolderResult.total}, Processed: ${subfolderResult.processed}, Skipped: ${subfolderResult.skipped || 0} ---`);
        await yieldToUI(); // Allow UI update
      }
      
      sendLogToRenderer(`Completed all ${subfolders.length} subfolders in ${path.basename(folderPath)}`);
      await yieldToUI(); // Allow UI update
    }
    
    return result;
  } catch (error) {
    sendLogToRenderer(`Error processing folder ${folderPath}: ${error.message}`);
    await yieldToUI(); // Allow UI update
    return { folder: folderPath, total: 0, processed: 0, success: 0, failed: 0, skipped: 0 };
  }
}

// COMPLETELY REWRITTEN: Process multiple folders with Docker startup on button click
// Now with health checks for long-running processes
ipcMain.handle('process-images', async (event, data) => {
  const { 
    folders, 
    apiEndpoint, 
    confidenceThreshold, 
    processMode, 
    includeSubfolders,
    apiInstances
  } = data;
  
  // Reset processing state
  processingState = {
    isPaused: false,
    isCanceled: false
  };
  
  // Reset corrupted files tracking for new processing session
  corruptedFiles.clear();
  
  // Set global processing flag
  isProcessing = true;
  
  let apiEndpoints = [];
  
  try {
    // Always start Docker containers when "Process Images" is clicked
    sendLogToRenderer('Starting Docker containers...');
    await yieldToUI(); // Allow UI update
    
    // First, check if primary instance is already running
    const isPrimaryRunning = await checkApiRunning(PERMANENT_INSTANCE_PORT);
    
    if (!isPrimaryRunning) {
      // Start primary Docker instance
      sendLogToRenderer('Starting primary Docker instance...');
      await yieldToUI(); // Allow UI update
      
      let primaryStarted = false;
      let primaryRetries = 0;
      
      while (!primaryStarted && primaryRetries < 3) {
        try {
          const containerId = await new Promise((resolve, reject) => {
            const cmd = `docker run -d --rm -p ${PERMANENT_INSTANCE_PORT}:5000 ghcr.io/danbooru/autotagger`;
            sendLogToRenderer(`Running command: ${cmd}`);
            
            // Use proper promise with yieldToUI inside callback
            exec(cmd, (error, stdout, stderr) => {
              if (error) {
                sendLogToRenderer(`Docker error: ${error.message}`, 'error');
                // Use promise chain for yielding in non-async context
                yieldToUI().then(() => reject(error));
                return;
              }
              resolve(stdout.trim());
            });
          });
          
          instanceRegistry.permanentInstanceId = containerId;
          instanceRegistry.isPermanentInstanceRunning = true;
          
          // Give Docker time to fully initialize (increased wait time)
          sendLogToRenderer('Waiting for Docker container to initialize (this may take a moment)...');
          await yieldToUI(); // Allow UI update
          
          // Break up the waiting period to allow UI updates
          for (let i = 0; i < 10; i++) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            await yieldToUI(); // Allow UI update every second
          }
          
          // Verify it's actually running
          const isRunning = await checkApiRunning(PERMANENT_INSTANCE_PORT);
          if (isRunning) {
            sendLogToRenderer('Primary Docker instance is running and responding ✓', 'success');
            await yieldToUI(); // Allow UI update
            primaryStarted = true;
          } else {
            throw new Error("Container started but API is not responding");
          }
        } catch (error) {
          sendLogToRenderer(`Attempt ${primaryRetries+1}/3 failed: ${error.message}`, 'error');
          await yieldToUI(); // Allow UI update
          primaryRetries++;
          
          if (primaryRetries < 3) {
            sendLogToRenderer('Retrying Docker startup...');
            await yieldToUI(); // Allow UI update
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        }
      }
      
      if (!primaryStarted) {
        throw new Error("Failed to start primary Docker instance after multiple attempts");
      }
    } else {
      sendLogToRenderer('Primary Docker instance is already running ✓', 'success');
      await yieldToUI(); // Allow UI update
      instanceRegistry.isPermanentInstanceRunning = true;
    }
    
    // Add primary instance to endpoints
    apiEndpoints.push(`http://localhost:${PERMANENT_INSTANCE_PORT}/evaluate`);
    
    // Only start additional instances if requested
    if (apiInstances > 1) {
      sendLogToRenderer(`Starting ${apiInstances-1} additional Docker instances...`);
      await yieldToUI(); // Allow UI update
      
      // Stop any existing additional instances first
      await stopAdditionalContainers();
      
      for (let i = 0; i < apiInstances - 1; i++) {
        const port = ADDITIONAL_INSTANCE_START_PORT + i;
        
        try {
          // Run Docker container
          const containerId = await new Promise((resolve, reject) => {
            exec(`docker run -d --rm -p ${port}:5000 ghcr.io/danbooru/autotagger`, (error, stdout, stderr) => {
              if (error) {
                reject(error);
                return;
              }
              resolve(stdout.trim());
            });
          });
          
          instanceRegistry.additionalInstances.push({ containerId, port });
          sendLogToRenderer(`Started additional Docker instance #${i+2} on port ${port}`);
          await yieldToUI(); // Allow UI update
          
          // Wait between starts
          await new Promise(resolve => setTimeout(resolve, 3000));
          await yieldToUI(); // Allow UI update
          
          // Check if it's running
          const isRunning = await checkApiRunning(port);
          if (isRunning) {
            apiEndpoints.push(`http://localhost:${port}/evaluate`);
            sendLogToRenderer(`Instance #${i+2} is responding ✓`);
            await yieldToUI(); // Allow UI update
          } else {
            sendLogToRenderer(`Warning: Instance #${i+2} started but isn't responding yet`, 'warning');
            await yieldToUI(); // Allow UI update
          }
        } catch (error) {
          sendLogToRenderer(`Failed to start instance #${i+2}: ${error.message}`, 'error');
          await yieldToUI(); // Allow UI update
        }
      }
    }
    
    if (apiEndpoints.length === 0) {
      throw new Error("No Docker instances are running. Please make sure Docker is installed and running.");
    }
    
    // Initialize health tracking
    initializeInstanceHealth(apiEndpoints.length);
    
    // Setup periodic health check for long-running processes - NEW CODE
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
    }

    // Set up health check every 5 minutes - using IIFE to handle async in setInterval
    healthCheckInterval = setInterval(() => {
      if (isProcessing) {  // Only check while actively processing
        (async () => {
          try {
            sendLogToRenderer('--- Starting periodic health check of Docker instances ---');
            await checkAndRecoverInstances();
            sendLogToRenderer('--- Health check completed ---');
          } catch (error) {
            sendLogToRenderer(`Error during health check: ${error.message}`, 'error');
          }
        })().catch(err => console.error('Health check error:', err));
      } else {
        // If not processing, clear the interval
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
    }, 5 * 60 * 1000); // 5 minutes
    
    sendLogToRenderer(`All Docker instances ready. Processing ${folders.length} folders with ${apiEndpoints.length} instance(s)...`);
    await yieldToUI(); // Allow UI update
    
    // Process images with the running Docker instances
    let totalImages = 0;
    let totalProcessed = 0;
    let totalSuccess = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    
    for (let i = 0; i < folders.length; i++) {
      // Check if canceled
      if (processingState.isCanceled) {
        sendLogToRenderer(`Processing canceled after ${i} folders`);
        await yieldToUI(); // Allow UI update
        break;
      }
      
      const folder = folders[i];
      
      // Update overall progress
      mainWindow.webContents.send('progress-overall', {
        current: i + 1,
        total: folders.length,
        folder: folder
      });
      await yieldToUI(); // Allow UI update
      
      sendLogToRenderer(`--- Processing folder ${i+1}/${folders.length}: ${folder} ---`);
      await yieldToUI(); // Allow UI update
      
      // Process this folder and its subfolders
      const result = await processFolder(
        folder,
        apiEndpoints,
        confidenceThreshold,
        processMode,
        includeSubfolders
      );
      
      // Add to totals
      totalImages += result.total;
      totalProcessed += result.processed;
      totalSuccess += result.success;
      totalFailed += result.failed;
      totalSkipped += result.skipped || 0;
    }
    
    // Log final stats including skipped files
    if (totalSkipped > 0) {
      sendLogToRenderer(`Overall processing completed with ${totalSuccess} successes, ${totalFailed} failures, and ${totalSkipped} files skipped as potentially corrupted.`, 'warning');
      await yieldToUI();
    }
    
    return {
      folderCount: folders.length,
      total: totalImages,
      processed: totalProcessed,
      success: totalSuccess,
      failed: totalFailed,
      skipped: totalSkipped || 0,
      canceled: processingState.isCanceled,
      instancesUsed: apiEndpoints.length
    };
  } catch (error) {
    sendLogToRenderer(`Error: ${error.message}`, 'error');
    await yieldToUI(); // Allow UI update
    throw error;
  } finally {
    // Reset global processing flag
    isProcessing = false;
    
    // Clear health check interval
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = null;
    }
    
    // Wait for connections to cool down
    await waitForSocketsCooldown(CONNECTION_COOLDOWN_MS);
    
    // Stop additional containers, but keep permanent one running
    await stopAdditionalContainers();
    
    // Reset connection pools
    for (const key in connectionPools) {
      resetConnectionPool(parseInt(key));
    }
  }
});
