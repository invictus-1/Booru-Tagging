const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

let mainWindow;
let processingState = {
  isPaused: false,
  isCanceled: false
};

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

// Process a single folder and its subfolders if requested
async function processFolder(folderPath, apiEndpoint, confidenceThreshold, processMode, includeSubfolders) {
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
    
    // Process images in this folder
    let processedCount = 0;
    let success = 0;
    let failed = 0;
    let processedLog = [];
    
    for (const imageFile of filesToProcess) {
      // Check if canceled
      if (processingState.isCanceled) {
        mainWindow.webContents.send('log', `Processing canceled after ${processedCount} images in ${path.basename(folderPath)}`);
        break;
      }
      
      // Handle pause
      while (processingState.isPaused) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (processingState.isCanceled) break;
      }
      
      try {
        const imagePath = path.join(folderPath, imageFile);
        const jsonFileName = path.basename(imageFile, path.extname(imageFile)) + '.json';
        const jsonFilePath = path.join(jsonFolder, jsonFileName);
        
        mainWindow.webContents.send('progress-folder', {
          current: processedCount + 1,
          total: filesToProcess.length,
          file: imageFile,
          folder: folderPath
        });
        
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
        success++;
        
        // Add to log
        processedLog.push({
          imagePath,
          timestamp: new Date().toISOString(),
          status: 'success'
        });
      } catch (error) {
        mainWindow.webContents.send('log', `Error processing ${imageFile}: ${error.message} ✗`);
        failed++;
        
        processedLog.push({
          imagePath: path.join(folderPath, imageFile),
          timestamp: new Date().toISOString(),
          status: 'failed',
          error: error.message
        });
      }
      
      processedCount++;
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
          apiEndpoint, 
          confidenceThreshold, 
          processMode, 
          includeSubfolders
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
  const { folders, apiEndpoint, confidenceThreshold, processMode, includeSubfolders } = data;
  
  // Reset processing state
  processingState = {
    isPaused: false,
    isCanceled: false
  };
  
  try {
    mainWindow.webContents.send('log', `Starting to process ${folders.length} folders...`);
    
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
        apiEndpoint,
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
      canceled: processingState.isCanceled
    };
  } catch (error) {
    mainWindow.webContents.send('log', `Error: ${error.message}`);
    throw error;
  }
});
