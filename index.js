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
    height: 600,
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

// Handle folder selection
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

// Process images
ipcMain.handle('process-images', async (event, data) => {
  const { inputFolder, apiEndpoint, confidenceThreshold } = data;
  
  // Reset processing state
  processingState = {
    isPaused: false,
    isCanceled: false
  };
  
  try {
    // Create Json folder if it doesn't exist
    const jsonFolder = path.join(inputFolder, 'Json');
    if (!fs.existsSync(jsonFolder)) {
      fs.mkdirSync(jsonFolder);
    }
    
    // Get all image files
    const files = fs.readdirSync(inputFolder);
    const imageFiles = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
    });
    
    mainWindow.webContents.send('log', `Found ${imageFiles.length} images to process`);
    
    let processed = 0;
    let success = 0;
    let failed = 0;
    
    // Process each image
    for (const imageFile of imageFiles) {
      // Check if processing was canceled
      if (processingState.isCanceled) {
        mainWindow.webContents.send('log', `Processing canceled by user after ${processed} images`);
        return {
          total: imageFiles.length,
          processed,
          success,
          failed,
          canceled: true,
          jsonFolder
        };
      }
      
      // Handle pause state
      while (processingState.isPaused) {
        // Wait for 100ms before checking again
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Check for cancel during pause
        if (processingState.isCanceled) {
          mainWindow.webContents.send('log', `Processing canceled while paused after ${processed} images`);
          return {
            total: imageFiles.length,
            processed,
            success,
            failed,
            canceled: true,
            jsonFolder
          };
        }
      }
      
      try {
        const imagePath = path.join(inputFolder, imageFile);
        const jsonFileName = path.basename(imageFile, path.extname(imageFile)) + '.json';
        const jsonFilePath = path.join(jsonFolder, jsonFileName);
        
        mainWindow.webContents.send('progress', {
          current: processed + 1,
          total: imageFiles.length,
          file: imageFile
        });
        
        // Create form data with the image
        const formData = new FormData();
        formData.append('file', fs.createReadStream(imagePath));
        formData.append('format', 'json');
        
        // Send the request
        const response = await axios.post(apiEndpoint, formData, {
          headers: {
            ...formData.getHeaders(),
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          timeout: 30000 // 30 second timeout for large images
        });
        
        // Save response to JSON file
        fs.writeFileSync(jsonFilePath, JSON.stringify(response.data, null, 2));
        
        mainWindow.webContents.send('log', `Processed ${imageFile} ✓`);
        success++;
      } catch (error) {
        mainWindow.webContents.send('log', `Error processing ${imageFile}: ${error.message} ✗`);
        failed++;
      }
      
      processed++;
    }
    
    return {
      total: imageFiles.length,
      processed,
      success,
      failed,
      canceled: false,
      jsonFolder
    };
  } catch (error) {
    mainWindow.webContents.send('log', `Error: ${error.message}`);
    throw error;
  }
});
