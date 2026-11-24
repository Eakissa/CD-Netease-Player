const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const sourceDir = path.resolve(__dirname, '..');
const distBase = path.resolve(sourceDir, '../dist');
const version = require(path.join(sourceDir, 'package.json')).version || '1.0.3';
const stagingDir = path.join(distBase, 'staging_app');
const distAppDir = path.join(distBase, `CD-Netease-Player-v${version}-win-x64`);
const availableTemplates = fs.existsSync(distBase)
  ? fs.readdirSync(distBase)
      .filter(f => f.startsWith('CD-Netease-Player-v') && f.endsWith('-win-x64'))
      .map(f => path.join(distBase, f))
      .filter(d => fs.existsSync(d))
  : [];
const templateDir = availableTemplates[availableTemplates.length - 1];

console.log(`🚀 Building CD Netease Player v${version}...`);

// Ensure dist target directory exists with runtime binaries
if (!fs.existsSync(distAppDir)) {
  console.log(`Creating ${distAppDir} from template...`);
  fs.cpSync(templateDir, distAppDir, { recursive: true });
}

const outputAsar = path.join(distAppDir, 'resources', 'app.asar');

console.log('1. Preparing staging directory for app.asar...');
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

// 5. Create release zip package and update packages
const zipPath = path.join(distBase, `CD-Netease-Player-v${version}-win-x64.zip`);
const sevenZipPath = path.join(sourceDir, 'node_modules/7zip-bin/win/x64/7za.exe');
const isMini = process.argv.includes('--mini') || /[a-zA-Z]/.test(version);

if (fs.existsSync(sevenZipPath)) {
  if (!isMini) {
    console.log('5. Creating portable release zip package...');
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    execSync(`"${sevenZipPath}" a -tzip -mx=7 "${zipPath}" "${distAppDir}/*"`, { stdio: 'inherit' });
    const zipSize = fs.statSync(zipPath).size;
    console.log('📦 Zip package size:', (zipSize / (1024 * 1024)).toFixed(2), 'MB');
    console.log('📍 Zip saved to:', zipPath);
  } else {
    console.log('⚡ Mini update mode active: Skipping large full release zip (~130MB), focusing on update artifacts!');
  }

  // 6. Create lightweight in-app update package (app-update.zip - Tier 2 Core)
  const updateZipPath = path.join(distBase, 'app-update.zip');
  console.log('6. Creating lightweight core update package (app-update.zip)...');
  if (fs.existsSync(updateZipPath)) fs.unlinkSync(updateZipPath);
  execSync(`"${sevenZipPath}" a -tzip -mx=9 "${updateZipPath}" "${standaloneAsar}"`, { stdio: 'inherit' });
  const updateZipSize = fs.statSync(updateZipPath).size;
  console.log('⚡ app-update.zip size:', (updateZipSize / (1024 * 1024)).toFixed(2), 'MB');
  console.log('📍 Update zip saved to:', updateZipPath);

  // 7. Create ultra-lightweight micro-patch package (patch-v${version}.zip - Tier 1 Hot-Patch)
  console.log(`7. Creating ultra-lightweight micro-patch package (patch-v${version}.zip)...`);
  const patchStagingDir = path.join(distBase, 'temp_micro_patch');
  if (fs.existsSync(patchStagingDir)) fs.rmSync(patchStagingDir, { recursive: true, force: true });
  fs.mkdirSync(patchStagingDir, { recursive: true });

  const patchFiles = [
    'main.js',
    'main-core.js',
    'patch-manager.js',
    'preload.js',
    'index.html',
    'netease-player.js',
    'netease-ui.css',
    'style.css',
    'amll-player.js',
    'audio-stream.js',
    'av3a-decoder.js',
    'artwork-cache.js',
    'we-bridge.js',
    'package.json'
  ];

  for (const f of patchFiles) {
    const srcF = path.join(sourceDir, f);
    if (fs.existsSync(srcF)) {
      fs.copyFileSync(srcF, path.join(patchStagingDir, f));
    }
  }

  const manifest = {
    name: 'cd-netease-player-patch',
    version: version,
    minBaseVersion: '1.1.0',
    files: patchFiles,
    builtAt: Date.now()
  };
  fs.writeFileSync(path.join(patchStagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const patchZipPath = path.join(distBase, `patch-v${version}.zip`);
  if (fs.existsSync(patchZipPath)) fs.unlinkSync(patchZipPath);
  execSync(`"${sevenZipPath}" a -tzip -mx=9 "${patchZipPath}" "${patchStagingDir}/*"`, { stdio: 'inherit' });
  fs.rmSync(patchStagingDir, { recursive: true, force: true });

  const patchZipSize = fs.statSync(patchZipPath).size;
  console.log('✨ Micro-patch package size:', (patchZipSize / 1024).toFixed(2), 'KB (', (patchZipSize / (1024 * 1024)).toFixed(3), 'MB )');
  console.log('📍 Micro-patch saved to:', patchZipPath);
}

console.log(`\n🎉 Build complete for v${version}!`);
