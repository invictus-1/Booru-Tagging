# Booru Autotagger for Eagle

This project provides a complete package for automatically tagging images in [Eagle](https://eagle.cool/) using Booru tags. The way it works is these two parts:

1. **Booru Image Processor**: A standalone application that processes images through the Booru API and saves tag data as JSON files
2. **Eagle Plugin**: A plugin for Eagle that reads these JSON files and applies the tags to your images. Keep in mind the Json files will be named after the image itself. So for example
if the image is named earth.png the json is named earth.json. That way with the Eagle plugin it will just find the correct json for the correct image using the json file names. You can download the
Eagle Plugin from the repo. It would be on Eagle's community plugins but they still haven't reviewed it.

If you have a massive stash of images I highly recommend using my eagletagger.py and iamgerenamer.py I have attached to the main repo. KEEP IN MIND IMAGER RENAMER WILL RENAME ALL IMAGES TO A 10 DIGIT NUMBER for example 1001371780.jpg. IT CANNOT BE REVERSED. So make sure the folders where you have the images stored don't contain stuff you don't want renamed. The purpose of this is to ensure 100% of all images get tagged and added to eagle. Obviously if the image is corrupted it cannot work/get tagged. Outside of that I made this as many images can have dupes, weird characters in the title etc and it would either not get tagged in eagle and or just go stupid. The image renamer will ensure that no 2 images have the exact same name so no dupes or errors can occur. The Eagletagger.py file is used to add all the tags to eagle at an extremely fast rate. I'm talking thousands per second. The initial processing takes a bit depending on your pc but after that it adds extremely fast. 

To run these files just type python eagletagger.py into cmd and it will work that's it. Make sure you're in the directory of the file as well.

Lastly I recommend just using process all files for eagletagger as it guarantees everything gets tagged but it just takes a little longer. The other options work but sometimes they can miss a file.

## Requirements

- Running instance of [Danbooru Autotagger API](https://github.com/danbooru/autotagger) (at http://localhost:5000) For it to work properly.
- [Eagle](https://eagle.cool/) application (version 2.0 or later)

## Part 1: Booru Image Processor

### Installation

#### Option 1: Using the executable (Windows)
1. Download the Booru Processor.exe from the release
2. Run the executable

#### Option 2: Running from source
1. Ensure you have [Node.js](https://nodejs.org/) installed (v14+)
2. Clone/download this repository
3. Open a terminal in the `booru-processor` directory
4. Install dependencies: `npm install`
5. Start the application: `npm start`

### Usage

1. **Start the Application**: The application will automatically start a permanent Docker API instance on first run. This instance will remain running in the background to ensure reliable operation.

2. **Configure the Processor**:
   - Enter the API endpoint (default: http://localhost:5000/evaluate)
   - Set your confidence threshold (0.0-1.0)
   - Click "Browse…" to select one or multiple folders containing your images
   - Choose whether to include subfolders for processing

3. **Processing Options**:
   - **API Instances**: Select up to 10 concurrent API instances for faster processing (requires more system memory)
   - **Processing Mode**:
     - Process all images
     - Process only new images (skip previously processed)
     - Reprocess only images with missing JSON files
   - The application will automatically analyze selected folders and recommend the appropriate mode

4. **Process Your Images**:
   - Click "Process Images" to start
   - A "Json" subfolder will be created in each of your selected directories
   - Each image will be processed and its tags saved as a JSON file

5. **Control Processing**:
   - Use the "Pause" button to temporarily halt processing
   - Use "Resume" to continue after pausing
   - Use "Cancel" to abort the process entirely
   - View real-time progress for each API instance

6. **Advanced Features**:
   - **Auto-Recovery**: The application automatically retries failed requests
   - **Connection Management**: Sophisticated connection handling prevents socket hangups
   - **Resource Optimization**: The permanent API instance stays running while additional instances are started only when needed
   - **Error Handling**: Intelligent error handling with automatic connection pool reset

### JSON Format

The Booru API returns tag data in this format:

```json
[
{
 "filename": "image.jpg",
 "tags": {
   "1girl": 0.9995526671409607,
   "hatsune_miku": 0.9995216131210327,
   "vocaloid": 0.9981155395507812
 }
}
]
