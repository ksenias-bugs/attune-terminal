// Generate .icns from SVG using Electron's native rendering
// Run with: npx electron scripts/generate-icon.js

const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const sizes = [16, 32, 64, 128, 256, 512, 1024];
const iconsetDir = path.join(__dirname, '..', 'assets', 'icon.iconset');

app.whenReady().then(async () => {
  // Create iconset directory
  if (!fs.existsSync(iconsetDir)) {
    fs.mkdirSync(iconsetDir, { recursive: true });
  }

  const svgPath = path.join(__dirname, '..', 'assets', 'icon.svg');
  const svgContent = fs.readFileSync(svgPath, 'utf8');
  const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from(svgContent).toString('base64')}`;

  // Create a hidden window to render the SVG
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    webPreferences: { offscreen: true },
  });

  await win.loadURL(`data:text/html,<html><body style="margin:0;padding:0;"><img id="img" src="${svgDataUrl}" width="1024" height="1024"></body></html>`);

  // Wait for image to render
  await new Promise(r => setTimeout(r, 500));

  const image = await win.webContents.capturePage();

  // Generate all sizes
  for (const size of sizes) {
    const resized = image.resize({ width: size, height: size, quality: 'best' });
    const pngData = resized.toPNG();

    // Standard resolution
    if (size <= 512) {
      fs.writeFileSync(path.join(iconsetDir, `icon_${size}x${size}.png`), pngData);
    }

    // @2x versions (retina)
    const halfSize = size / 2;
    if (halfSize >= 16 && Number.isInteger(halfSize)) {
      fs.writeFileSync(path.join(iconsetDir, `icon_${halfSize}x${halfSize}@2x.png`), pngData);
    }
  }

  // Use iconutil to create .icns
  const icnsPath = path.join(__dirname, '..', 'assets', 'icon.icns');
  try {
    execSync(`iconutil -c icns "${iconsetDir}" -o "${icnsPath}"`);
    console.log(`Created ${icnsPath}`);
  } catch (e) {
    console.error('iconutil failed:', e.message);
  }

  win.close();
  app.quit();
});
