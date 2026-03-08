const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist');
fs.mkdirSync(distDir, { recursive: true });

// Copy xterm CSS
fs.copyFileSync(
  path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'),
  path.join(distDir, 'xterm.css')
);

// Bundle renderer JS
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'renderer', 'app.js')],
  bundle: true,
  outfile: path.join(distDir, 'renderer.js'),
  platform: 'browser',
  format: 'iife',
  minify: false,
  sourcemap: true,
});

console.log('Build complete');
