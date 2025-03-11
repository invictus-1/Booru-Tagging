# Booru Autotagger for Eagle

This project provides a complete package for automatically tagging images in [Eagle](https://eagle.cool/) using Booru tags. The way it works is these two parts:

1. **Booru Image Processor**: A standalone application that processes images through the Booru API and saves tag data as JSON files
2. **Eagle Plugin**: A plugin for Eagle that reads these JSON files and applies the tags to your images. Keep in mind the Json files will be named after the image itself. So for example
if the image is named earth.png the json is named earth.json. That way with the Eagle plugin it will just find the correct json for the correct image using the json file names.

## Requirements

- Running instance of [Danbooru Autotagger API](https://github.com/danbooru/autotagger) (at http://localhost:5000) For it to work properly. After installing the docker just use this command "docker run --rm -p 5000:5000 ghcr.io/danbooru/autotagger" in cmd or whatever you use.
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

1. Start the Booru API: with "docker run --rm -p 5000:5000 ghcr.io/danbooru/autotagger" You need to do this first before enabling multiple instances. Once you activate the first instance then you can start the rest to enable multiple image processing.

2. Configure the Processor:
Enter the API endpoint (default: http://localhost:5000/evaluate)
Set your confidence threshold (0.0-1.0)
Click “Browse…” to select the folder containing your images

3. Process Your Images:
Click “Process Images” to start
A “Json” subfolder will be created in your selected directory
Each image will be processed and its tags saved as a JSON file

4. Control Processing:
Use the “Pause” button to temporarily halt processing
Use “Resume” to continue after pausing
Use “Cancel” to abort the process entirely

## JSON Format

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
