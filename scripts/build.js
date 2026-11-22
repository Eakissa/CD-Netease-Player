const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const sourceDir = path.resolve('D:/0AGENT/stuff/CD-Netease-AV3A/source');
const distBase = path.resolve('D:/0AGENT/stuff/CD-Netease-AV3A/dist');
const stagingDir = path.join(distBase, 'staging_app');
const distAppDir = path.join(distBase, 'CD-Netease-Player-v1.0.2-win-x64');
const outputAsar = path.join(distAppDir, 'resources', 'app.asar');

console.log('1. Preparing staging directory...');
if (fs.existsSync(stagingDir)) {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
fs.mkdirSync(stagingDir, { recursive: true });

// Copy source files
const entries = fs.readdirSync(sourceDir);
const exclude = new Set(['.git', '.github', 'screenshots', 'dist', 'node_modules', 'node_modules.zip']);
const devDeps = new Set(['app-builder-bin', 'typescript', '7zip-bin', '@esbuild', 'esbuild', 'electron', 'electron-builder', '.package-lock.json', '.cache']);

for (const entry of entries) {
  if (exclude.has(entry)) continue;
  const src = path.join(sourceDir, entry);
  const dst = path.join(stagingDir, entry);
  fs.cpSync(src, dst, { recursive: true });
}

// Copy node_modules cleanly without build tools
console.log('2. Copying runtime node_modules...');
const srcModules = path.join(sourceDir, 'node_modules');
const dstModules = path.join(stagingDir, 'node_modules');
fs.mkdirSync(dstModules, { recursive: true });

for (const mod of fs.readdirSync(srcModules)) {
  if (devDeps.has(mod)) continue;
  fs.cpSync(path.join(srcModules, mod), path.join(dstModules, mod), { recursive: true });
}

console.log('3. Packing app.asar with asar...');
execSync(`npx asar pack "${stagingDir}" "${outputAsar}" --unpack "bin/**" --exclude-hidden`, { stdio: 'inherit' });

// Copy app.asar to dist/app.asar for standalone upload
const standaloneAsar = path.join(distBase, 'app.asar');
fs.copyFileSync(outputAsar, standaloneAsar);

const size = fs.statSync(outputAsar).size;
console.log('✅ Packed successfully!');
console.log('📦 app.asar size:', (size / (1024 * 1024)).toFixed(2), 'MB');
console.log('📍 Saved to:', outputAsar);
console.log('📍 Standalone copy:', standaloneAsar);

console.log('4. Cleaning up staging...');
fs.rmSync(stagingDir, { recursive: true, force: true });
console.log('Done!');
