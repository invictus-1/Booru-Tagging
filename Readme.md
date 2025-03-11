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

1. Start the Booru API: with docker run --rm -p 5000:5000 ghcr.io/danbooru/autotagger
2. Select the folder you want to start tagging. A separate JSON folder will be made with all the tags so you don't have to worry about it messing with things
3. Open up Eagle Plugin and select your json folder and it will automatically start inputting those tags. Keep in mind you have to have those images in your Eagle library. So if your tagging
images from your "Anime" folder make sure your Eagle library already has the images from that folder imported.
4. The plugin will find the matching JSON files and apply tags to your images

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
