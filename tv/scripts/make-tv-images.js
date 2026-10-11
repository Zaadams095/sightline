// Makes the Apple TV icon and Top Shelf images (exact sizes required by tvOS) from the app's
// logo on the dark background. Re-run after changing the logo:
//   NODE_PATH=../app/node_modules node scripts/make-tv-images.js
const path = require('path');
const Jimp = require('jimp-compact');

const LOGO = path.join(__dirname, '../../app/assets/images/splash-icon.png');
const OUT = path.join(__dirname, '../assets/tv');
const BG = 0x0b0d12ff;

const images = {
  'icon-1280x768.png': [1280, 768, 0.62],
  'icon-400x240.png': [400, 240, 0.62],
  'icon-800x480.png': [800, 480, 0.62],
  'topshelf-1920x720.png': [1920, 720, 0.5],
  'topshelf-3840x1440.png': [3840, 1440, 0.5],
  'topshelf-wide-2320x720.png': [2320, 720, 0.5],
  'topshelf-wide-4640x1440.png': [4640, 1440, 0.5],
};

(async () => {
  const logo = await Jimp.read(LOGO);
  for (const [name, [w, h, frac]] of Object.entries(images)) {
    // Match the logo artwork's own backdrop so it doesn't sit in a visible box.
    const canvas = new Jimp(w, h, logo.getPixelColor(2, 2) || BG);
    const size = Math.round(h * frac);
    const mark = logo.clone().contain(size, size);
    canvas.composite(mark, Math.round((w - size) / 2), Math.round((h - size) / 2));
    await canvas.writeAsync(path.join(OUT, name));
    console.log('wrote', name);
  }
})();
