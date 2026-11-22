const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const sourceDir = path.resolve(__dirname, '..');
const distBase = path.resolve(sourceDir, '../dist');
const version = require(path.join(sourceDir, 'package.json')).version || '1.0.3';
const stagingDir = path.join(distBase, 'staging_app');
const distAppDir = path.join(distBase, `CD-Netease-Player-v${version}-win-x64`);
const templateDir = path.join(distBase, 'CD-Netease-Player-v1.0.0-win-x64');

console.log(`🚀 Building CD Netease Player v${version}...`);

// Ensure dist target directory exists with runtime binaries
if (!fs.existsSync(distAppDir)) {
  console.log(`Creating ${distAppDir} from template...`);
  fs.cpSync(templateDir, distAppDir, { recursive: true });
}

const outputAsar = path.join(distAppDir, 'resources', 'app.asar');

console.log('1. Preparing staging directory...');
if (fs.existsSync(stagingDir)) {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
fs.mkdirSync(stagingDir, { recursive: true });

// Copy source files
const entries = fs.readdirSync(sourceDir);
const exclude = new Set(['.git', '.github', 'screenshots', 'dist', 'node_modules', 'node_modules.zip', 'scripts']);
const devDeps = new Set([
  'app-builder-bin', 'typescript', '7zip-bin', '@esbuild', 'esbuild',
  'electron', 'electron-builder', '.package-lock.json', '.cache',
  '@electron', '@electron-internal', 'postject', 'app-builder-lib',
  '@types', 'node-gyp', '@pixi', 'builder-util', 'builder-util-runtime',
  'dmg-builder', 'temp-file', 'lazy-val'
]);

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
console.log('✅ app.asar built successfully!');
console.log('📦 app.asar size:', (size / (1024 * 1024)).toFixed(2), 'MB');
console.log('📍 Saved to:', outputAsar);
console.log('📍 Standalone quick update file:', standaloneAsar);

console.log('4. Cleaning up staging...');
fs.rmSync(stagingDir, { recursive: true, force: true });

// 5. Create release zip package
const zipPath = path.join(distBase, `CD-Netease-Player-v${version}-win-x64.zip`);
const sevenZipPath = path.join(sourceDir, 'node_modules/7zip-bin/win/x64/7za.exe');

if (fs.existsSync(sevenZipPath)) {
  console.log('5. Creating portable release zip package...');
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  execSync(`"${sevenZipPath}" a -tzip -mx=7 "${zipPath}" "${distAppDir}/*"`, { stdio: 'inherit' });
  const zipSize = fs.statSync(zipPath).size;
  console.log('📦 Zip package size:', (zipSize / (1024 * 1024)).toFixed(2), 'MB');
  console.log('📍 Zip saved to:', zipPath);

  // 6. Create lightweight in-app update package (app-update.zip)
  const updateZipPath = path.join(distBase, 'app-update.zip');
  console.log('6. Creating ultra-lightweight in-app update package (app-update.zip)...');
  if (fs.existsSync(updateZipPath)) fs.unlinkSync(updateZipPath);
  execSync(`"${sevenZipPath}" a -tzip -mx=9 "${updateZipPath}" "${standaloneAsar}"`, { stdio: 'inherit' });
  const updateZipSize = fs.statSync(updateZipPath).size;
  console.log('⚡ app-update.zip size:', (updateZipSize / (1024 * 1024)).toFixed(2), 'MB');
  console.log('📍 Update zip saved to:', updateZipPath);
}

console.log(`\n🎉 Build complete for v${version}!`);

