const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

let mainWindow;
let processingState = {
  isPaused: false,
  isCanceled: false
};

// Track running Docker containers
let dockerContainers = [];
const basePort = 5000;

// Create the main application window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 700,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Make sure to clean up Docker containers on app exit
app.on('before-quit', async (event) => {
  if (dockerContainers.length > 0) {
    event.preventDefault();
    await stopAllDockerContainers();
    app.quit();
  }
});

// Start multiple Docker containers
async function startDockerContainers(count) {
  // First stop any existing containers
  await stopAllDockerContainers();
  
  const containers = [];
  const endpoints = [];
  
  mainWindow.webContents.send('log', `Starting ${count} API instances...`);
  
  // Start Docker containers
  for (let i = 0; i < count; i++) {
    const port = basePort + i;
    try {
      // Run Docker container in detached mode
      const containerId = await new Promise((resolve, reject) => {
        exec(`docker run -d --rm -p ${port}:5000 ghcr.io/danbooru/autotagger`, (error, stdout, stderr) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(stdout.trim());
        });
      });
      
      containers.push(containerId);
      endpoints.push(`http://localhost:${port}/evaluate`);
      mainWindow.webContents.send('log', `Started API instance #${i+1} on port ${port}`);
      
      // Wait a second between starts to avoid Docker issues
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      mainWindow.webContents.send('log', `Failed to start API instance on port ${port}: ${error.message}`, 'error');
    }
  }
  
  dockerContainers = containers;
  
  if (containers.length === 0) {
    throw new Error("Failed to start any API instances");
  }
  
  return {
    containers,
    endpoints
  };
}

// Stop all running Docker containers
async function stopAllDockerContainers() {
  const promises = dockerContainers.map(containerId => {
    return new Promise(resolve => {
      exec(`docker stop ${containerId}`, (error) => {
        if (error) {
          mainWindow.webContents.send('log', `Error stopping container ${containerId.substring(0, 8)}: ${error.message}`, 'error');
        } else {
          mainWindow.webContents.send('log', `Stopped API instance ${containerId.substring(0, 8)}`);
        }
        resolve();
      });
    });
  });
  
  await Promise.all(promises);
  dockerContainers = [];
}

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
    await axios.get(apiEndpoint.replace('/evaluate', ''), {
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

// Distribute images among instances
function distributeImages(imageFiles, instanceCount) {
  const distributions = [];
  
  // Create bucket for each instance
  for (let i = 0; i < instanceCount; i++) {
    distributions.push([]);
  }
  
  // Distribute images evenly
  imageFiles.forEach((file, index) => {
    const instanceIndex = index % instanceCount;
    distributions[instanceIndex].push(file);
  });
  
  return distributions;
}

// Process with multiple instances
async function processWithMultipleInstances(folderPath, imageFiles, jsonFolder, apiEndpoints, concurrency) {
  // Distribute images among instances
  const distributions = distributeImages(imageFiles, apiEndpoints.length);
  
  // Process each distribution with its assigned endpoint
  const instancePromises = distributions.map((instanceFiles, index) => {
    if (instanceFiles.length === 0) return { success: 0, failed: 0, processedLog: [] };
    
    return new Promise(async (resolve) => {
      const endpoint = apiEndpoints[index];
      mainWindow.webContents.send('log', `Instance #${index+1} processing ${instanceFiles.length} images from ${path.basename(folderPath)}`);
      
      let processedCount = 0;
      let success = 0;
      let failed = 0;
      let processedLog = [];
      
      // Process batches until all assigned images are done
      while (processedCount < instanceFiles.length && !processingState.isCanceled) {
        if (processingState.isPaused) {
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }
        
        // Update progress for this instance
        mainWindow.webContents.send('progress-instance', {
          instance: index,
          current: processedCount,
          total: instanceFiles.length,
          folder: folderPath
        });
        
        // Process batch for this instance
        const batchSize = Math.min(concurrency, instanceFiles.length - processedCount);
        const batchFiles = instanceFiles.slice(processedCount, processedCount + batchSize);
        
        const batchPromises = batchFiles.map(async (imageFile) => {
          try {
            const imagePath = path.join(folderPath, imageFile);
            const jsonFileName = path.basename(imageFile, path.extname(imageFile)) + '.json';
            const jsonFilePath = path.join(jsonFolder, jsonFileName);
            
            // Create form data
            const formData = new FormData();
            formData.append('file', fs.createReadStream(imagePath));
            formData.append('format', 'json');
            
            // Send request
            const response = await axios.post(endpoint, formData, {
              headers: {
                ...formData.getHeaders(),
              },
              maxBodyLength: Infinity,
              maxContentLength: Infinity,
              timeout: 30000
            });
            
            // Save JSON
            fs.writeFileSync(jsonFilePath, JSON.stringify(response.data, null, 2));
            
            mainWindow.webContents.send('log', `Instance #${index+1} processed ${imageFile} ✓`);
            success++;
            
            return {
              success: true,
              imagePath,
              timestamp: new Date().toISOString(),
              status: 'success'
            };
          } catch (error) {
            mainWindow.webContents.send('log', `Instance #${index+1} error processing ${imageFile}: ${error.message} ✗`);
            failed++;
            
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
        processedLog = processedLog.concat(batchResults);
        processedCount += batchSize;
        
        // Update overall progress for this instance
        mainWindow.webContents.send('progress-instance', {
          instance: index,
          current: processedCount,
          total: instanceFiles.length,
          folder: folderPath
        });
      }
      
      resolve({
        success,
        failed,
        processedLog
      });
    });
  });
  
  // Wait for all instances to finish
  const results = await Promise.all(instancePromises);
  
  // Combine results
  const combinedResults = {
    success: 0,
    failed: 0,
    processedLog: []
  };
  
  results.forEach(result => {
    combinedResults.success += result.success;
    combinedResults.failed += result.failed;
    combinedResults.processedLog = combinedResults.processedLog.concat(result.processedLog);
  });
  
  return combinedResults;
}

// Process a batch of images with a single API
async function processBatch(folderPath, imageFiles, jsonFolder, apiEndpoint, startIndex, batchSize) {
  const batchPromises = [];
  const batchResults = {
    success: 0,
    failed: 0,
    processedLog: []
  };
  
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
        
        // Send request
        const response = await axios.post(apiEndpoint, formData, {
          headers: {
            ...formData.getHeaders(),
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          timeout: 30000
        });
        
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
async function processFolder(folderPath, apiEndpoints, confidenceThreshold, processMode, includeSubfolders, concurrency) {
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
      const { processed } = checkMissingJsonFiles(folderPath);
      filesToProcess = imageFiles.filter(file => {
        const fullPath = path.join(folderPath, file);
        return !processed.includes(fullPath);
      });
      mainWindow.webContents.send('log', `Processing ${filesToProcess.length} new images in ${path.basename(folderPath)}`);
    } else if (processMode === 'missing') {
      const missingFiles = [];
      imageFiles.forEach(file => {
        const baseName = path.basename(file, path.extname(file));
        const jsonPath = path.join(jsonFolder, `${baseName}.json`);
        if (!fs.existsSync(jsonPath)) {
          missingFiles.push(file);
        }
      });
      filesToProcess = missingFiles;
      mainWindow.webContents.send('log', `Processing ${filesToProcess.length} missing files in ${path.basename(folderPath)}`);
    }
    
    // Skip if no files to process
    if (filesToProcess.length === 0) {
      mainWindow.webContents.send('log', `No files to process in ${path.basename(folderPath)}`);
      return {
        folder: folderPath,
        total: 0,
        processed: 0,
        success: 0,
        failed: 0
      };
    }
    
    let processedCount = 0;
    let success = 0;
    let failed = 0;
    let processedLog = [];
    
    // Choose processing method based on number of API endpoints
    if (apiEndpoints.length > 1) {
      // Process with multiple instances
      mainWindow.webContents.send('log', `Using ${apiEndpoints.length} API instances for ${path.basename(folderPath)}`);
      
      const multiResults = await processWithMultipleInstances(
        folderPath,
        filesToProcess,
        jsonFolder,
        apiEndpoints,
        concurrency
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
          concurrency
        );
        
        // Update counters
        success += batchResults.success;
        failed += batchResults.failed;
        processedLog = processedLog.concat(batchResults.processedLog);
        processedCount += Math.min(concurrency, filesToProcess.length - processedCount);
        
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
    
    const result = {
      folder: folderPath,
      total: filesToProcess.length,
      processed: processedCount,
      success,
      failed
    };
    
    // Process subfolders if requested
    if (includeSubfolders && subfolders.length > 0 && !processingState.isCanceled) {
      mainWindow.webContents.send('log', `Processing ${subfolders.length} subfolders in ${path.basename(folderPath)}`);
      
      for (const subfolder of subfolders) {
        if (processingState.isCanceled) break;
        
        const subfolderResult = await processFolder(
          subfolder, 
          apiEndpoints, 
          confidenceThreshold, 
          processMode, 
          includeSubfolders,
          concurrency
        );
        
        // Add subfolder results to totals
        result.total += subfolderResult.total;
        result.processed += subfolderResult.processed;
        result.success += subfolderResult.success;
        result.failed += subfolderResult.failed;
      }
    }
    
    return result;
  } catch (error) {
    mainWindow.webContents.send('log', `Error processing folder ${folderPath}: ${error.message}`);
    return { folder: folderPath, total: 0, processed: 0, success: 0, failed: 0 };
  }
}

// Process multiple folders
ipcMain.handle('process-images', async (event, data) => {
  const { 
    folders, 
    apiEndpoint, 
    confidenceThreshold, 
    processMode, 
    includeSubfolders,
    concurrency,
    apiInstances
  } = data;
  
  // Reset processing state
  processingState = {
    isPaused: false,
    isCanceled: false
  };
  
  let apiEndpoints = [apiEndpoint];
  let containersStarted = false;
  
  try {
    // Start multiple API instances if requested
    if (apiInstances > 1) {
      try {
        const result = await startDockerContainers(apiInstances);
        apiEndpoints = result.endpoints;
        containersStarted = true;
        mainWindow.webContents.send('log', `Successfully started ${apiEndpoints.length} API instances`);
      } catch (dockerError) {
        mainWindow.webContents.send('log', `Failed to start additional API instances: ${dockerError.message}. Using original endpoint.`, 'error');
      }
    }
    
    mainWindow.webContents.send('log', `Starting to process ${folders.length} folders with ${apiEndpoints.length} API instance(s)...`);
    
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
        includeSubfolders,
        concurrency
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
    mainWindow.webContents.send('log', `Error: ${error.message}`);
    throw error;
  } finally {
    // Stop Docker containers if we started them
    if (containersStarted) {
      mainWindow.webContents.send('log', `Stopping API instances...`);
      await stopAllDockerContainers();
    }
  }
});
