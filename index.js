const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
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

// Configuration constants
const PERMANENT_INSTANCE_PORT = 5000;
const ADDITIONAL_INSTANCE_START_PORT = 5001;
const CONNECTION_COOLDOWN_MS = 10000;
const MAX_CONCURRENT_CONNECTIONS = 3;
const SOCKET_TIMEOUT_MS = 30000;
const CONNECTION_RESET_THRESHOLD = 3;

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

// Create a custom http agent with proper settings
const createHttpAgent = (instanceIndex) => {
  return new http.Agent({
    keepAlive: true,
    maxSockets: MAX_CONCURRENT_CONNECTIONS,
    maxFreeSockets: 2,
    timeout: SOCKET_TIMEOUT_MS,
    freeSocketTimeout: 15000,
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
    timeout: 45000,
    maxRedirects: 5,
    validateStatus: status => status < 500
  });
}

// Reset connection pool for an instance
function resetConnectionPool(instanceIndex) {
  if (connectionPools[instanceIndex]) {
    mainWindow.webContents.send('log', `Resetting connection pool for instance #${instanceIndex+1}`);
    
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
  mainWindow.webContents.send('log', 'Performing health check on all Docker instances...');
  
  // Check the permanent instance first
  const permanentRunning = await checkApiRunning(PERMANENT_INSTANCE_PORT);
  if (!permanentRunning && instanceRegistry.isPermanentInstanceRunning) {
    mainWindow.webContents.send('log', 'Primary Docker instance appears to be down. Attempting to restart...', 'error');
    
    // Try to restart the permanent instance
    try {
      // Stop the existing container if it's registered
      if (instanceRegistry.permanentInstanceId) {
        try {
          await new Promise(resolve => {
            exec(`docker stop ${instanceRegistry.permanentInstanceId}`, () => resolve());
          });
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
      
      // Check if it's up
      const isRunning = await checkApiRunning(PERMANENT_INSTANCE_PORT);
      if (isRunning) {
        mainWindow.webContents.send('log', 'Primary Docker instance restarted successfully ✓', 'success');
        
        // Update health status
        if (instanceHealthStatus[0]) {
          instanceHealthStatus[0].isHealthy = true;
          instanceHealthStatus[0].consecutiveFailures = 0;
        }
      } else {
        mainWindow.webContents.send('log', 'Failed to restart primary Docker instance', 'error');
      }
    } catch (error) {
      mainWindow.webContents.send('log', `Error restarting primary Docker instance: ${error.message}`, 'error');
    }
  } else if (permanentRunning && instanceHealthStatus[0] && !instanceHealthStatus[0].isHealthy) {
    // Primary instance is running but marked as unhealthy - restore it
    mainWindow.webContents.send('log', 'Primary Docker instance is running but marked unhealthy. Restoring...', 'success');
    instanceHealthStatus[0].isHealthy = true;
    instanceHealthStatus[0].consecutiveFailures = 0;
  }
  
  // Now check additional instances
  for (let i = 0; i < instanceRegistry.additionalInstances.length; i++) {
    const instance = instanceRegistry.additionalInstances[i];
    const instanceIndex = i + 1; // Permanent is 0, additional start at 1
    
    const isRunning = await checkApiRunning(instance.port);
    
    if (!isRunning) {
      mainWindow.webContents.send('log', `Additional instance #${instanceIndex+1} on port ${instance.port} appears to be down. Restarting...`, 'warning');
      
      try {
        // Try to stop it first
        try {
          await new Promise(resolve => {
            exec(`docker stop ${instance.containerId}`, () => resolve());
          });
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
        
        // Check if it's up
        const newIsRunning = await checkApiRunning(instance.port);
        if (newIsRunning) {
          mainWindow.webContents.send('log', `Additional instance #${instanceIndex+1} restarted successfully ✓`, 'success');
          
          // Update health status
          if (instanceHealthStatus[instanceIndex]) {
            instanceHealthStatus[instanceIndex].isHealthy = true;
            instanceHealthStatus[instanceIndex].consecutiveFailures = 0;
          }
        } else {
          mainWindow.webContents.send('log', `Failed to restart additional instance #${instanceIndex+1}`, 'error');
        }
      } catch (error) {
        mainWindow.webContents.send('log', `Error restarting additional instance #${instanceIndex+1}: ${error.message}`, 'error');
      }
    } else if (instanceHealthStatus[instanceIndex] && !instanceHealthStatus[instanceIndex].isHealthy) {
      // Instance is running but marked as unhealthy - restore it
      mainWindow.webContents.send('log', `Additional instance #${instanceIndex+1} is running but marked unhealthy. Restoring...`, 'success');
      instanceHealthStatus[instanceIndex].isHealthy = true;
      instanceHealthStatus[instanceIndex].consecutiveFailures = 0;
    }
  }
  
  mainWindow.webContents.send('log', 'Health check and recovery completed');
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
  mainWindow.webContents.send('log', `Waiting ${ms/1000} seconds for connections to close...`);
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
        mainWindow.webContents.send('log', `Instance #${instanceIndex+1} marked as unhealthy after 5 consecutive failures`, 'error');
      }
    }
  }
}

// Check if an instance is healthy
function isInstanceHealthy(instanceIndex) {
  return instanceHealthStatus[instanceIndex] && instanceHealthStatus[instanceIndex].isHealthy;
}

// Create the main application window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 650,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
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
    mainWindow.webContents.send('log', 'Permanent API instance already running ✓', 'success');
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
  
  mainWindow.webContents.send('log', `Stopping ${instanceRegistry.additionalInstances.length} additional API instances...`);
  
  const promises = instanceRegistry.additionalInstances.map(instance => {
    return new Promise(resolve => {
      exec(`docker stop ${instance.containerId}`, (error) => {
        if (error) {
          mainWindow.webContents.send('log', `Error stopping container on port ${instance.port}: ${error.message}`, 'error');
        } else {
          mainWindow.webContents.send('log', `Stopped API instance on port ${instance.port}`);
        }
        resolve();
      });
    });
  });
  
  await Promise.all(promises);
  instanceRegistry.additionalInstances = [];
  
  // Wait for ports to be released
  await new Promise(resolve => setTimeout(resolve, 3000));
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
            mainWindow.webContents.send('log', `Error stopping permanent container: ${error.message}`, 'error');
          } else {
            mainWindow.webContents.send('log', `Stopped permanent API instance`);
          }
          resolve();
        });
      });
      
      instanceRegistry.permanentInstanceId = null;
      instanceRegistry.isPermanentInstanceRunning = false;
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
    if (!fs.existsSync(jsonFolder)) {
      return {
        hasJsonFolder: false,
        jsonCount: 0,
        logCount: 0,
        missingCount: 0
      };
    }
    
    // Count JSON files
    const jsonFiles = fs.readdirSync(jsonFolder).filter(file => 
      file.toLowerCase().endsWith('.json') && file !== 'processed_log.json'
    );
    
    // Check for processing log
    const logFilePath = path.join(jsonFolder, 'processed_log.json');
    let logCount = 0;
    let missing = [];
    
    if (fs.existsSync(logFilePath)) {
      try {
        const logData = JSON.parse(fs.readFileSync(logFilePath, 'utf8'));
        logCount = logData.length;
        
        // Check for missing JSON files based on the log
        logData.forEach(entry => {
          if (entry.status === 'success') {
            const jsonFileName = path.basename(entry.imagePath, path.extname(entry.imagePath)) + '.json';
            const jsonFilePath = path.join(jsonFolder, jsonFileName);
            
            if (!fs.existsSync(jsonFilePath)) {
              missing.push(entry.imagePath);
            }
          }
        });
      } catch (logError) {
        console.error('Error parsing log file:', logError);
      }
    }
    
    // Get image files count in the input folder
    const imageFiles = fs.readdirSync(inputFolder).filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
    });
    
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
function saveProcessingLog(inputFolder, processed) {
  try {
    const jsonFolder = path.join(inputFolder, 'Json');
    const logFilePath = path.join(jsonFolder, 'processed_log.json');
    
    // Create or update log file
    let logData = [];
    if (fs.existsSync(logFilePath)) {
      logData = JSON.parse(fs.readFileSync(logFilePath, 'utf8'));
    }
    
    // Add new entries, replacing any duplicates
    processed.forEach(entry => {
      logData = logData.filter(item => item.imagePath !== entry.imagePath);
      logData.push(entry);
    });
    
    // Save log file
    fs.writeFileSync(logFilePath, JSON.stringify(logData, null, 2));
    
    return logData.length;
  } catch (error) {
    console.error('Error saving processing log:', error);
    return -1;
  }
}

// Check for missing JSON files
function checkMissingJsonFiles(inputFolder) {
  try {
    const jsonFolder = path.join(inputFolder, 'Json');
    const logFilePath = path.join(jsonFolder, 'processed_log.json');
    
    if (!fs.existsSync(logFilePath)) {
      return { processed: [], missing: [] };
    }
    
    const logData = JSON.parse(fs.readFileSync(logFilePath, 'utf8'));
    
    const missing = [];
    logData.forEach(entry => {
      if (entry.status === 'success') {
        const jsonFileName = path.basename(entry.imagePath, path.extname(entry.imagePath)) + '.json';
        const jsonFilePath = path.join(jsonFolder, jsonFileName);
        
        if (!fs.existsSync(jsonFilePath)) {
          missing.push(entry.imagePath);
        }
      }
    });
    
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
  let processedLog = [];
  
  // Failed images to retry
  let failedImages = [];
  
  // Update overall progress
  function updateOverallProgress() {
    mainWindow.webContents.send('progress-folder', {
      current: processedCount,
      total: imageFiles.length,
      folder: folderPath,
      file: ''
    });
  }
  
  // Create a function for each instance to process images from the queue
  async function instanceWorker(endpoint, instanceIndex) {
    mainWindow.webContents.send('log', `Instance #${instanceIndex+1} started on ${endpoint}`);
    
    let instanceProcessed = 0;
    let instanceSuccess = 0;
    let instanceFailed = 0;
    let instanceLog = [];
    let consecutiveErrors = 0;
    
    // Create axios instance with proper connection management
    const axiosInstance = createAxiosInstance(instanceIndex);
    
    // Keep processing until the queue is empty or processing is canceled
    while (imageQueue.length > 0 && !processingState.isCanceled) {
      // Check if instance is still healthy
      if (!isInstanceHealthy(instanceIndex)) {
        mainWindow.webContents.send('log', `Instance #${instanceIndex+1} is no longer healthy. Stopping this worker.`, 'error');
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
      
      // Process this batch of images
      const batchPromises = batchFiles.map(async (imageFile) => {
        try {
          const imagePath = path.join(folderPath, imageFile);
          const jsonFileName = path.basename(imageFile, path.extname(imageFile)) + '.json';
          const jsonFilePath = path.join(jsonFolder, jsonFileName);
          
          // Create form data
          const formData = new FormData();
          formData.append('file', fs.createReadStream(imagePath));
          formData.append('format', 'json');
          
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
          fs.writeFileSync(jsonFilePath, JSON.stringify(response.data, null, 2));
          
          mainWindow.webContents.send('log', `Instance #${instanceIndex+1} processed ${imageFile} ✓`);
          instanceSuccess++;
          consecutiveErrors = 0; // Reset error counter on success
          updateInstanceHealth(instanceIndex, true);
          
          return {
            success: true,
            imagePath,
            timestamp: new Date().toISOString(),
            status: 'success'
          };
        } catch (error) {
          mainWindow.webContents.send('log', `Instance #${instanceIndex+1} error processing ${imageFile}: ${error.message} ✗`);
          instanceFailed++;
          consecutiveErrors++;
          updateInstanceHealth(instanceIndex, false);
          
          // If too many consecutive errors, reset connection
          if (consecutiveErrors >= CONNECTION_RESET_THRESHOLD) {
            mainWindow.webContents.send('log', `Too many consecutive errors for Instance #${instanceIndex+1}. Resetting connection...`, 'warning');
            resetConnectionPool(instanceIndex);
            consecutiveErrors = 0;
            
            // Add failed image back to the queue for another attempt
            failedImages.push(imageFile);
          }
          
          return {
            success: false,
            imagePath: path.join(folderPath, imageFile),
            timestamp: new Date().toISOString(),
            status: 'failed',
            error: error.message
          };
        }
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
      
      // Update overall counters
      processedCount += batchFiles.length;
      success += batchResults.filter(r => r.success).length;
      failed += batchResults.filter(r => !r.success).length;
      
      // Update overall progress
      updateOverallProgress();
      
      // Small delay between batches to prevent overwhelming the API
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    mainWindow.webContents.send('log', `Instance #${instanceIndex+1} finished. Processed: ${instanceProcessed}, Success: ${instanceSuccess}, Failed: ${instanceFailed}`);
    
    return {
      instanceProcessed,
      instanceSuccess,
      instanceFailed,
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
      mainWindow.webContents.send('log', `Skipping unhealthy instance #${index+1}`);
      return Promise.resolve({
        instanceProcessed: 0,
        instanceSuccess: 0,
        instanceFailed: 0,
        instanceLog: []
      });
    }
  });
  
  // Wait for all instances to finish
  const instanceResults = await Promise.all(instancePromises);
  
  // Process any remaining failed images
  if (failedImages.length > 0 && !processingState.isCanceled) {
    mainWindow.webContents.send('log', `Retrying ${failedImages.length} failed images...`, 'warning');
    
    // Add failed images back to the queue
    imageQueue.push(...failedImages);
    
    // If we have any healthy instances, process the remaining images
    if (apiEndpoints.length > 0) {
      const retryResults = await processWithMultipleInstances(
        folderPath,
        failedImages,
        jsonFolder,
        apiEndpoints
      );
      
      // Update counters with retry results
      success += retryResults.success;
      failed = retryResults.failed;
      processedLog = processedLog.concat(retryResults.processedLog);
    }
  }
  
  // Combine all logs
  instanceResults.forEach(result => {
    processedLog = processedLog.concat(result.instanceLog);
  });
  
  return {
    success,
    failed,
    processedLog
  };
}

// Process a batch of images with a single API
async function processBatch(folderPath, imageFiles, jsonFolder, apiEndpoint, startIndex, batchSize, instanceIndex = 0) {
  const batchPromises = [];
  const batchResults = {
    success: 0,
    failed: 0,
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
    
    const processPromise = (async () => {
      try {
        const imagePath = path.join(folderPath, imageFile);
        const jsonFileName = path.basename(imageFile, path.extname(imageFile)) + '.json';
        const jsonFilePath = path.join(jsonFolder, jsonFileName);
        
        // Create form data
        const formData = new FormData();
        formData.append('file', fs.createReadStream(imagePath));
        formData.append('format', 'json');
        
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
        fs.writeFileSync(jsonFilePath, JSON.stringify(response.data, null, 2));
        
        mainWindow.webContents.send('log', `Processed ${imageFile} in ${path.basename(folderPath)} ✓`);
        batchResults.success++;
        
        return {
          success: true,
          imagePath,
          timestamp: new Date().toISOString(),
          status: 'success'
        };
      } catch (error) {
        mainWindow.webContents.send('log', `Error processing ${imageFile}: ${error.message} ✗`);
        batchResults.failed++;
        
        return {
          success: false,
          imagePath: path.join(folderPath, imageFile),
          timestamp: new Date().toISOString(),
          status: 'failed',
          error: error.message
        };
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
    // Get all files in this folder
    const allFiles = fs.readdirSync(folderPath);
    
    // Separate images and subfolders
    const imageFiles = [];
    const subfolders = [];
    
    for (const file of allFiles) {
      const fullPath = path.join(folderPath, file);
      
      // Skip if path doesn't exist (could have been deleted)
      if (!fs.existsSync(fullPath)) continue;
      
      const stats = fs.statSync(fullPath);
      
      if (stats.isDirectory() && file !== 'Json') {
        subfolders.push(fullPath);
      } else if (stats.isFile()) {
        const ext = path.extname(file).toLowerCase();
        if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
          imageFiles.push(file);
        }
      }
    }
    
    // Add debug logging for subfolder detection
    mainWindow.webContents.send('log', `Found ${subfolders.length} subfolders in ${path.basename(folderPath)}`);
    if (subfolders.length > 0) {
      let subfoldersStr = subfolders.map(sf => path.basename(sf)).join(', ');
      if (subfoldersStr.length > 100) subfoldersStr = subfoldersStr.substring(0, 100) + '...';
      mainWindow.webContents.send('log', `Subfolders: ${subfoldersStr}`);
    }
    
    // Create Json folder for this folder
    const jsonFolder = path.join(folderPath, 'Json');
    if (!fs.existsSync(jsonFolder)) {
      fs.mkdirSync(jsonFolder);
    }
    
    // Determine which files to process based on mode
    let filesToProcess = [];
    
    if (processMode === 'all') {
      filesToProcess = imageFiles;
      mainWindow.webContents.send('log', `Processing all ${filesToProcess.length} images in ${path.basename(folderPath)}`);
      
    } else if (processMode === 'new') {
      // For "new" images: Check if they have JSON files, if not, they're new
      const newFiles = [];
      let existingJsonCount = 0;
      
      imageFiles.forEach(file => {
        const baseName = path.basename(file, path.extname(file));
        const jsonPath = path.join(jsonFolder, `${baseName}.json`);
        
        if (fs.existsSync(jsonPath)) {
          existingJsonCount++;
        } else {
          newFiles.push(file);
        }
      });
      
      filesToProcess = newFiles;
      mainWindow.webContents.send('log', `Found ${existingJsonCount} existing JSON files. Processing ${filesToProcess.length} new images in ${path.basename(folderPath)}`);
      
    } else if (processMode === 'missing') {
      // For "missing" files: Same logic as "new" but different messaging
      const missingFiles = [];
      let jsonCount = 0;
      
      imageFiles.forEach(file => {
        const baseName = path.basename(file, path.extname(file));
        const jsonPath = path.join(jsonFolder, `${baseName}.json`);
        
        if (fs.existsSync(jsonPath)) {
          jsonCount++;
        } else {
          missingFiles.push(file);
        }
      });
      
      filesToProcess = missingFiles;
      mainWindow.webContents.send('log', `Found ${jsonCount} existing JSON files. Processing ${filesToProcess.length} missing JSON files in ${path.basename(folderPath)}`);
    }
    
    // Initialize result object
    const result = {
      folder: folderPath,
      total: 0,
      processed: 0,
      success: 0,
      failed: 0
    };

    // Only process files if there are any to process
    if (filesToProcess.length > 0) {
      mainWindow.webContents.send('log', `Processing ${filesToProcess.length} files in ${path.basename(folderPath)}`);
      
      let processedCount = 0;
      let success = 0;
      let failed = 0;
      let processedLog = [];
      
      // Choose processing method based on number of API endpoints
      if (apiEndpoints.length > 1) {
        // Process with multiple instances using shared queue
        mainWindow.webContents.send('log', `Using ${apiEndpoints.length} API instances with shared queue for ${path.basename(folderPath)}`);
        
        const multiResults = await processWithMultipleInstances(
          folderPath,
          filesToProcess,
          jsonFolder,
          apiEndpoints
        );
        
        processedCount = multiResults.processedLog.length;
        success = multiResults.success;
        failed = multiResults.failed;
        processedLog = multiResults.processedLog;
        
        // Update overall progress
        mainWindow.webContents.send('progress-folder', {
          current: processedCount,
          total: filesToProcess.length,
          folder: folderPath,
          file: ''
        });
      } else {
        // Process with single instance in batches
        mainWindow.webContents.send('log', `Using single API instance for ${path.basename(folderPath)}`);
        
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
          processedLog = processedLog.concat(batchResults.processedLog);
          processedCount += Math.min(MAX_CONCURRENT_CONNECTIONS, filesToProcess.length - processedCount);
          
          // Update overall progress after the batch
          mainWindow.webContents.send('progress-folder', {
            current: processedCount,
            total: filesToProcess.length,
            folder: folderPath,
            file: ''
          });
        }
      }
      
      // Save processing log
      if (processedLog.length > 0) {
        const totalLogged = saveProcessingLog(folderPath, processedLog);
        mainWindow.webContents.send('log', `Updated log for ${path.basename(folderPath)} with ${totalLogged} entries`);
      }
      
      // Update result with current folder's results
      result.total = filesToProcess.length;
      result.processed = processedCount;
      result.success = success;
      result.failed = failed;
    } else {
      mainWindow.webContents.send('log', `No files to process in ${path.basename(folderPath)}`);
    }
    
    // Process subfolders if requested - IMPROVED SECTION
    if (includeSubfolders && subfolders.length > 0 && !processingState.isCanceled) {
      mainWindow.webContents.send('log', `Processing ${subfolders.length} subfolders in ${path.basename(folderPath)} (includeSubfolders=${includeSubfolders})...`);
      
      for (const subfolder of subfolders) {
        if (processingState.isCanceled) break;
        
        mainWindow.webContents.send('log', `--- Starting subfolder: ${path.basename(subfolder)} ---`);
        
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
        
        mainWindow.webContents.send('log', `--- Completed subfolder: ${path.basename(subfolder)}, Found: ${subfolderResult.total}, Processed: ${subfolderResult.processed} ---`);
      }
      
      mainWindow.webContents.send('log', `Completed all ${subfolders.length} subfolders in ${path.basename(folderPath)}`);
    }
    
    return result;
  } catch (error) {
    mainWindow.webContents.send('log', `Error processing folder ${folderPath}: ${error.message}`);
    return { folder: folderPath, total: 0, processed: 0, success: 0, failed: 0 };
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
  
  // Set global processing flag
  isProcessing = true;
  
  let apiEndpoints = [];
  
  try {
    // Always start Docker containers when "Process Images" is clicked
    mainWindow.webContents.send('log', 'Starting Docker containers...');
    
    // First, check if primary instance is already running
    const isPrimaryRunning = await checkApiRunning(PERMANENT_INSTANCE_PORT);
    
    if (!isPrimaryRunning) {
      // Start primary Docker instance
      mainWindow.webContents.send('log', 'Starting primary Docker instance...');
      let primaryStarted = false;
      let primaryRetries = 0;
      
      while (!primaryStarted && primaryRetries < 3) {
        try {
          const containerId = await new Promise((resolve, reject) => {
            const cmd = `docker run -d --rm -p ${PERMANENT_INSTANCE_PORT}:5000 ghcr.io/danbooru/autotagger`;
            mainWindow.webContents.send('log', `Running command: ${cmd}`);
            
            exec(cmd, (error, stdout, stderr) => {
              if (error) {
                mainWindow.webContents.send('log', `Docker error: ${error.message}`, 'error');
                reject(error);
                return;
              }
              resolve(stdout.trim());
            });
          });
          
          instanceRegistry.permanentInstanceId = containerId;
          instanceRegistry.isPermanentInstanceRunning = true;
          
          // Give Docker time to fully initialize (increased wait time)
          mainWindow.webContents.send('log', 'Waiting for Docker container to initialize (this may take a moment)...');
          await new Promise(resolve => setTimeout(resolve, 10000));
          
          // Verify it's actually running
          const isRunning = await checkApiRunning(PERMANENT_INSTANCE_PORT);
          if (isRunning) {
            mainWindow.webContents.send('log', 'Primary Docker instance is running and responding ✓', 'success');
            primaryStarted = true;
          } else {
            throw new Error("Container started but API is not responding");
          }
        } catch (error) {
          mainWindow.webContents.send('log', `Attempt ${primaryRetries+1}/3 failed: ${error.message}`, 'error');
          primaryRetries++;
          
          if (primaryRetries < 3) {
            mainWindow.webContents.send('log', 'Retrying Docker startup...');
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        }
      }
      
      if (!primaryStarted) {
        throw new Error("Failed to start primary Docker instance after multiple attempts");
      }
    } else {
      mainWindow.webContents.send('log', 'Primary Docker instance is already running ✓', 'success');
      instanceRegistry.isPermanentInstanceRunning = true;
    }
    
    // Add primary instance to endpoints
    apiEndpoints.push(`http://localhost:${PERMANENT_INSTANCE_PORT}/evaluate`);
    
    // Only start additional instances if requested
    if (apiInstances > 1) {
      mainWindow.webContents.send('log', `Starting ${apiInstances-1} additional Docker instances...`);
      
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
          mainWindow.webContents.send('log', `Started additional Docker instance #${i+2} on port ${port}`);
          
          // Wait between starts
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          // Check if it's running
          const isRunning = await checkApiRunning(port);
          if (isRunning) {
            apiEndpoints.push(`http://localhost:${port}/evaluate`);
            mainWindow.webContents.send('log', `Instance #${i+2} is responding ✓`);
          } else {
            mainWindow.webContents.send('log', `Warning: Instance #${i+2} started but isn't responding yet`, 'warning');
          }
        } catch (error) {
          mainWindow.webContents.send('log', `Failed to start instance #${i+2}: ${error.message}`, 'error');
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

    // Set up health check every 5 minutes
    healthCheckInterval = setInterval(async () => {
      if (isProcessing) {  // Only check while actively processing
        try {
          mainWindow.webContents.send('log', '--- Starting periodic health check of Docker instances ---');
          await checkAndRecoverInstances();
          mainWindow.webContents.send('log', '--- Health check completed ---');
        } catch (error) {
          mainWindow.webContents.send('log', `Error during health check: ${error.message}`, 'error');
        }
      } else {
        // If not processing, clear the interval
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
    }, 5 * 60 * 1000); // 5 minutes
    
    mainWindow.webContents.send('log', `All Docker instances ready. Processing ${folders.length} folders with ${apiEndpoints.length} instance(s)...`);
    
    // Process images with the running Docker instances
    let totalImages = 0;
    let totalProcessed = 0;
    let totalSuccess = 0;
    let totalFailed = 0;
    
    for (let i = 0; i < folders.length; i++) {
      // Check if canceled
      if (processingState.isCanceled) {
        mainWindow.webContents.send('log', `Processing canceled after ${i} folders`);
        break;
      }
      
      const folder = folders[i];
      
      // Update overall progress
      mainWindow.webContents.send('progress-overall', {
        current: i + 1,
        total: folders.length,
        folder: folder
      });
      
      mainWindow.webContents.send('log', `--- Processing folder ${i+1}/${folders.length}: ${folder} ---`);
      
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
    }
    
    return {
      folderCount: folders.length,
      total: totalImages,
      processed: totalProcessed,
      success: totalSuccess,
      failed: totalFailed,
      canceled: processingState.isCanceled,
      instancesUsed: apiEndpoints.length
    };
  } catch (error) {
    mainWindow.webContents.send('log', `Error: ${error.message}`, 'error');
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

