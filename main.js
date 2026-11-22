// main.js — Electron 主进程
// 功能：内置启动 NeteaseCloudMusicApi，然后创建播放器窗口
// 双击 exe 即可使用，无需手动开 3000 端口

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, globalShortcut, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, execSync } = require("child_process");
const http = require("http");
const https = require("https");
const { installArtworkCache } = require("./artwork-cache");

const currentAppVersion = require("./package.json").version || "1.0.0";

function compareVersions(v1, v2) {
  const p1 = (v1 || "").replace(/^v/i, "").split(".").map(n => parseInt(n, 10) || 0);
  const p2 = (v2 || "").replace(/^v/i, "").split(".").map(n => parseInt(n, 10) || 0);
  const len = Math.max(p1.length, p2.length);
  for (let i = 0; i < len; i++) {
    const num1 = p1[i] || 0;
    const num2 = p2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

function checkGitHubRelease() {
  return new Promise((resolve) => {
    const options = {
      hostname: "api.github.com",
      path: "/repos/Eakissa/CD-Netease-Player/releases/latest",
      method: "GET",
      headers: {
        "User-Agent": "CD-Netease-Player-Desktop",
        "Accept": "application/vnd.github.v3+json",
      },
      timeout: 8000,
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode === 200) {
          try {
            const data = JSON.parse(body);
            const latestTag = data.tag_name || "";
            const hasUpdate = compareVersions(latestTag, currentAppVersion) > 0;
            resolve({
              success: true,
              hasUpdate,
              currentVersion: currentAppVersion,
              latestVersion: latestTag.replace(/^v/i, ""),
              tagName: latestTag,
              name: data.name || latestTag,
              body: data.body || "",
              htmlUrl: data.html_url || "https://github.com/Eakissa/CD-Netease-Player/releases",
              publishedAt: data.published_at,
              assets: (data.assets || []).map(a => ({
                name: a.name,
                size: a.size,
                downloadUrl: a.browser_download_url,
              })),
            });
          } catch (err) {
            resolve({ success: false, currentVersion: currentAppVersion, message: "解析版本信息失败" });
          }
        } else if (res.statusCode === 404) {
          resolve({
            success: true,
            hasUpdate: false,
            currentVersion: currentAppVersion,
            latestVersion: currentAppVersion,
            message: "当前已是最新版本 (暂未发布新 Release)",
          });
        } else {
          resolve({ success: false, currentVersion: currentAppVersion, message: `GitHub 返回 HTTP ${res.statusCode}` });
        }
      });
    });
    req.on("error", (err) => {
      resolve({ success: false, currentVersion: currentAppVersion, message: "网络连接失败: " + err.message });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ success: false, currentVersion: currentAppVersion, message: "检查更新请求超时" });
    });
    req.end();
  });
}

let currentUpdateDownload = null;

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return "0 MB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return "0 KB/s";
  if (bytesPerSec >= 1024 * 1024) {
    return (bytesPerSec / (1024 * 1024)).toFixed(1) + " MB/s";
  }
  return Math.round(bytesPerSec / 1024) + " KB/s";
}

function downloadFileWithProgress(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    let aborted = false;
    let req = null;
    let fileStream = null;

    currentUpdateDownload = {
      abort: () => {
        aborted = true;
        try { if (req) req.destroy(); } catch (e) {}
        try {
          if (fileStream) fileStream.close();
          if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        } catch (e) {}
        currentUpdateDownload = null;
        reject(new Error("用户已取消下载"));
      }
    };

    function startRequest(targetUrl, redirectCount = 0) {
      if (aborted) return;
      if (redirectCount > 10) {
        currentUpdateDownload = null;
        return reject(new Error("下载地址重定向次数过多"));
      }

      const client = targetUrl.startsWith("https:") ? https : http;
      let parsedUrl;
      try {
        parsedUrl = new URL(targetUrl);
      } catch (err) {
        currentUpdateDownload = null;
        return reject(new Error("无效的下载地址: " + targetUrl));
      }

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (targetUrl.startsWith("https:") ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: "GET",
        headers: {
          "User-Agent": "CD-Netease-Player-Desktop-Updater",
          "Accept": "*/*",
        },
        timeout: 30000,
      };

      req = client.request(options, (res) => {
        if (aborted) return;

        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          let nextUrl = res.headers.location;
          if (!nextUrl.startsWith("http://") && !nextUrl.startsWith("https://")) {
            nextUrl = new URL(nextUrl, targetUrl).href;
          }
          res.resume();
          return startRequest(nextUrl, redirectCount + 1);
        }

        if (res.statusCode !== 200) {
          res.resume();
          currentUpdateDownload = null;
          return reject(new Error(`下载服务器响应异常 (HTTP ${res.statusCode})`));
        }

        const totalBytes = parseInt(res.headers["content-length"] || "0", 10);
        let downloadedBytes = 0;
        let lastTime = Date.now();
        let lastDownloaded = 0;
        let speed = 0;

        fileStream = fs.createWriteStream(destPath);

        res.on("data", (chunk) => {
          if (aborted) return;
          downloadedBytes += chunk.length;

          const now = Date.now();
          if (now - lastTime >= 350) {
            speed = (downloadedBytes - lastDownloaded) / ((now - lastTime) / 1000);
            lastTime = now;
            lastDownloaded = downloadedBytes;

            const percent = totalBytes > 0 ? Math.min(99, Math.round((downloadedBytes / totalBytes) * 100)) : 0;
            onProgress({
              state: "downloading",
              percent,
              downloaded: downloadedBytes,
              total: totalBytes,
              speed,
              speedFormatted: formatSpeed(speed),
              downloadedFormatted: formatBytes(downloadedBytes),
              totalFormatted: formatBytes(totalBytes),
            });
          }
        });

        res.pipe(fileStream);

        fileStream.on("finish", () => {
          fileStream.close(() => {
            currentUpdateDownload = null;
            if (aborted) return;
            onProgress({
              state: "verifying",
              percent: 100,
              downloaded: downloadedBytes,
              total: downloadedBytes,
              speed: 0,
              speedFormatted: "0 KB/s",
              downloadedFormatted: formatBytes(downloadedBytes),
              totalFormatted: formatBytes(downloadedBytes),
            });
            resolve(destPath);
          });
        });

        fileStream.on("error", (err) => {
          currentUpdateDownload = null;
          try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (e) {}
          reject(err);
        });
      });

      req.on("error", (err) => {
        currentUpdateDownload = null;
        if (!aborted) reject(err);
      });

      req.on("timeout", () => {
        req.destroy();
        currentUpdateDownload = null;
        if (!aborted) reject(new Error("下载连接超时，请尝试开启国内加速镜像重试"));
      });

      req.end();
    }

    startRequest(url, 0);
  });
}

// ===== 单实例锁检测 (防止重复开启) =====
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  try {
    dialog.showMessageBoxSync({
      type: "info",
      title: "提示",
      message: "CD Netease Player 已经在运行中",
      detail: "程序已在后台或任务栏托盘中运行，无需重复启动。",
      buttons: ["确定"],
      noLink: true,
    });
  } catch (err) {}
  app.quit();
  process.exit(0);
}

const { registerAudioProtocol, installAudioProtocol } = require("./audio-stream");

// 计算当前程序根目录与内置缓存目录 (绿色便携定位)
const appDir = app.isPackaged ? path.dirname(process.resourcesPath) : path.resolve(__dirname, "..");
const appCacheDir = path.join(appDir, "cache");
try {
  require("fs").mkdirSync(appCacheDir, { recursive: true });
} catch (err) {}

// 启用硬件加速和GPU光栅化，消除高刷及渲染卡顿
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
// 将 Chromium 网络与音频请求缓存定向至程序文件夹内的 cache/web
app.commandLine.appendSwitch("disk-cache-dir", path.join(appCacheDir, "web"));

registerAudioProtocol();
let mainWindow = null;
let tray = null;
let isQuitting = false;
let currentTrackStatus = { title: "CD Netease Player", artist: "", playing: false };

let shortcutSettings = {
  enableCtrl: true,
  enableSuper: true,
};

let closeAction = "ask"; // 'ask' | 'minimize' | 'quit'

function registerGlobalHotkeys() {
  try {
    globalShortcut.unregisterAll();
  } catch (err) {}

  // 1. 全局快捷键 (Ctrl + 键)
  if (shortcutSettings.enableCtrl) {
    const ctrlMap = [
      { key: "CommandOrControl+Space", action: "toggle-play" },
      { key: "CommandOrControl+Left", action: "prev-track" },
      { key: "CommandOrControl+Right", action: "next-track" },
      { key: "CommandOrControl+Up", action: "volume-up" },
      { key: "CommandOrControl+Down", action: "volume-down" },
    ];
    for (const item of ctrlMap) {
      try {
        globalShortcut.register(item.key, () => {
          mainWindow?.webContents.send("app:shortcut-action", item.action);
        });
      } catch (e) {
        console.warn(`[Main] Failed to register ${item.key}:`, e.message);
      }
    }
  }

  // 2. 超级全局快捷键 (Ctrl + Alt + 键)
  if (shortcutSettings.enableSuper) {
    const superMap = [
      { key: "CommandOrControl+Alt+Space", action: "toggle-play" },
      { key: "CommandOrControl+Alt+Left", action: "prev-track" },
      { key: "CommandOrControl+Alt+Right", action: "next-track" },
      { key: "CommandOrControl+Alt+Up", action: "volume-up" },
      { key: "CommandOrControl+Alt+Down", action: "volume-down" },
    ];
    for (const item of superMap) {
      try {
        globalShortcut.register(item.key, () => {
          mainWindow?.webContents.send("app:shortcut-action", item.action);
        });
      } catch (e) {
        console.warn(`[Main] Failed to register ${item.key}:`, e.message);
      }
    }
  }
}

function updateTrayMenu() {
  if (!tray) return;
  const statusText = currentTrackStatus.artist
    ? `${currentTrackStatus.title} - ${currentTrackStatus.artist}`
    : currentTrackStatus.title;
  const playLabel = currentTrackStatus.playing ? "暂停" : "播放";

  const contextMenu = Menu.buildFromTemplate([
    {
      label: statusText.length > 28 ? statusText.slice(0, 25) + "..." : statusText,
      enabled: false,
    },
    { type: "separator" },
    {
      label: mainWindow && mainWindow.isVisible() ? "最小化到后台" : "显示主界面",
      click: () => {
        if (!mainWindow) return;
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: playLabel,
      click: () => mainWindow?.webContents.send("app:tray-action", "toggle-play"),
    },
    {
      label: "上一首",
      click: () => mainWindow?.webContents.send("app:tray-action", "prev-track"),
    },
    {
      label: "下一首",
      click: () => mainWindow?.webContents.send("app:tray-action", "next-track"),
    },
    { type: "separator" },
    {
      label: "退出 CD Netease Player",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.setToolTip(currentTrackStatus.playing ? `正在播放: ${statusText}` : "CD Netease Player (后台运行中)");
}

function createTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, "tray-icon.png");
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);

  tray.on("click", () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
        mainWindow.focus();
      } else {
        mainWindow.focus();
      }
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
    updateTrayMenu();
  });

  tray.on("double-click", () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.restore();
      mainWindow.focus();
    }
    updateTrayMenu();
  });

  updateTrayMenu();
}

// ===== 检测 3000 端口是否已被占用 =====
function isPortInUse() {
  return new Promise((resolve) => {
    const req = http.get("http://localhost:3000", () => {
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

// ===== 内置启动 NeteaseCloudMusicApi =====
async function startApiServer() {
  const inUse = await isPortInUse();
  if (inUse) {
    console.log("[Main] 检测到 3000 端口已有服务，跳过内置启动");
    return;
  }

  try {
    // NeteaseCloudMusicApi 支持程序化调用
    const { serveNcmApi } = require("NeteaseCloudMusicApi");
    await serveNcmApi({
      port: 3000,
      checkVersion: false,   // 关闭版本检查，加速启动
    });
    console.log("[Main] NeteaseCloudMusicApi 已在内部启动，端口：3000");
  } catch (err) {
    console.error("[Main] 内置 API 启动失败：", err.message);
    // 失败不影响窗口打开，用户可以手动在外部启动
  }
}

// ===== 创建主窗口 =====
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "rgba(0, 0, 0, 0)",
      symbolColor: "#ffffff",
      height: 36,
    },
    backgroundColor: "#111318",
    webPreferences: {
      // 允许最小化或转入后台时音频无间断平滑播放，避免 Chromium 节流停顿
      backgroundThrottling: false,
      // 关闭同源策略：允许直接加载网易云音频与封面（Electron 专有能力）
      webSecurity: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  // 点击右上角关闭时的处理：根据设置最小化、退出或弹出提问弹窗
  mainWindow.on("close", (event) => {
    if (isQuitting) return;

    if (closeAction === "minimize") {
      event.preventDefault();
      mainWindow.hide();
      updateTrayMenu();
      return;
    }

    if (closeAction === "quit") {
      isQuitting = true;
      app.quit();
      return;
    }

    // 默认 ask：提示用户选择并支持设为默认
    event.preventDefault();
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send("app:request-close-confirm");
  });

  mainWindow.on("minimize", () => updateTrayMenu());
  mainWindow.on("restore", () => updateTrayMenu());
  mainWindow.on("show", () => updateTrayMenu());
  mainWindow.on("hide", () => updateTrayMenu());

  mainWindow.on("closed", () => { mainWindow = null; });
}

// ===== Electron 生命周期 =====
app.whenReady().then(async () => {
  await installAudioProtocol(() => mainWindow);
  await installArtworkCache(appCacheDir, () => mainWindow);
  await startApiServer();
  createWindow();
  createTray();
  registerGlobalHotkeys();

  // 当收到第二实例启动通知时，唤醒并聚焦已有主窗口
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  ipcMain.on("app:minimize-to-tray", () => {
    if (mainWindow) {
      mainWindow.hide();
      updateTrayMenu();
    }
  });

  ipcMain.on("app:quit-app", () => {
    isQuitting = true;
    app.quit();
  });

  ipcMain.on("app:set-close-action", (_, action) => {
    if (["ask", "minimize", "quit"].includes(action)) {
      closeAction = action;
    }
  });

  ipcMain.on("app:set-shortcuts-config", (_, config) => {
    if (config) {
      shortcutSettings = { ...shortcutSettings, ...config };
      registerGlobalHotkeys();
    }
  });

  ipcMain.on("app:update-track", (_, status) => {
    if (status) {
      currentTrackStatus = { ...currentTrackStatus, ...status };
      updateTrayMenu();
    }
  });

  ipcMain.handle("app:check-update", async () => {
    return await checkGitHubRelease();
  });

  ipcMain.handle("app:open-external", async (_, url) => {
    if (url && (url.startsWith("http://") || url.startsWith("https://"))) {
      await shell.openExternal(url);
      return true;
    }
    return false;
  });

  ipcMain.handle("app:get-version", () => {
    return currentAppVersion;
  });

  ipcMain.handle("app:start-inapp-update", async (_, options = {}) => {
    try {
      const { assets = [], useMirror = true } = options;
      if (!assets || assets.length === 0) {
        throw new Error("此版本发布中未包含可用的更新文件");
      }

      // 智能选取最合适的更新包：
      // 1. 优先找 app.asar (约 76MB，速度最快且无需解压)
      // 2. 其次找 Windows 相关的 zip 全量包 (约 130MB，下载后自动提取 resources/app.asar)
      let targetAsset = assets.find(a => {
        const n = (a.name || "").toLowerCase();
        return n === "app.asar" || n.endsWith(".asar");
      });

      let isZip = false;
      if (!targetAsset) {
        targetAsset = assets.find(a => {
          const n = (a.name || "").toLowerCase();
          return n.endsWith(".zip") && (n.includes("win") || n.includes("netease"));
        });
        if (targetAsset) isZip = true;
      }

      if (!targetAsset) {
        targetAsset = assets.find(a => (a.name || "").toLowerCase().endsWith(".zip"));
        if (targetAsset) isZip = true;
      }

      if (!targetAsset || !targetAsset.downloadUrl) {
        throw new Error("未找到适配 Windows 的更新包");
      }

      const updateDir = path.join(app.getPath("userData"), "update");
      if (!fs.existsSync(updateDir)) {
        fs.mkdirSync(updateDir, { recursive: true });
      }

      const stagedAsarPath = path.join(updateDir, "new_app.asar");
      const tempDownloadPath = path.join(updateDir, isZip ? "update.zip" : "download.asar.tmp");

      try {
        if (fs.existsSync(stagedAsarPath)) fs.unlinkSync(stagedAsarPath);
        if (fs.existsSync(tempDownloadPath)) fs.unlinkSync(tempDownloadPath);
      } catch (e) {}

      let downloadUrl = targetAsset.downloadUrl;
      if (useMirror) {
        downloadUrl = `https://ghproxy.net/${targetAsset.downloadUrl}`;
      }

      const sendProgress = (p) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("app:update-progress", p);
        }
      };

      sendProgress({
        state: "connecting",
        percent: 0,
        assetName: targetAsset.name,
        totalFormatted: formatBytes(targetAsset.size),
        message: "正在连接下载节点...",
      });

      try {
        await downloadFileWithProgress(downloadUrl, tempDownloadPath, sendProgress);
      } catch (downloadErr) {
        if (useMirror) {
          sendProgress({
            state: "connecting",
            percent: 0,
            assetName: targetAsset.name,
            totalFormatted: formatBytes(targetAsset.size),
            message: "加速节点连接超时，尝试切换为直连下载...",
          });
          await downloadFileWithProgress(targetAsset.downloadUrl, tempDownloadPath, sendProgress);
        } else {
          throw downloadErr;
        }
      }

      if (isZip) {
        sendProgress({
          state: "extracting",
          percent: 99,
          message: "正在从更新包解压核心文件...",
        });

        let extracted = false;
        try {
          execSync(`tar -xf "${tempDownloadPath}" -C "${updateDir}" resources/app.asar`, { timeout: 30000 });
          const extractedAsar = path.join(updateDir, "resources", "app.asar");
          if (fs.existsSync(extractedAsar)) {
            if (fs.existsSync(stagedAsarPath)) fs.unlinkSync(stagedAsarPath);
            fs.renameSync(extractedAsar, stagedAsarPath);
            extracted = true;
          }
        } catch (tarErr) {
          try {
            const psCmd = `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${tempDownloadPath}' -DestinationPath '${path.join(updateDir, 'extracted')}' -Force"`;
            execSync(psCmd, { timeout: 60000 });
            const psAsar = path.join(updateDir, "extracted", "resources", "app.asar");
            if (fs.existsSync(psAsar)) {
              if (fs.existsSync(stagedAsarPath)) fs.unlinkSync(stagedAsarPath);
              fs.renameSync(psAsar, stagedAsarPath);
              extracted = true;
            }
          } catch (psErr) {}
        }

        try { fs.unlinkSync(tempDownloadPath); } catch (e) {}

        if (!extracted || !fs.existsSync(stagedAsarPath)) {
          throw new Error("更新包解压失败，未找到有效的核心文件");
        }
      } else {
        fs.renameSync(tempDownloadPath, stagedAsarPath);
      }

      const stats = fs.statSync(stagedAsarPath);
      if (stats.size < 1024 * 1024) {
        throw new Error("下载的核心更新文件损坏或大小异常");
      }

      sendProgress({
        state: "ready",
        percent: 100,
        message: "更新准备就绪，点击立即重启即可生效！",
      });

      return { success: true, stagedAsar: stagedAsarPath };
    } catch (err) {
      return { success: false, message: err.message || "更新下载失败" };
    }
  });

  ipcMain.handle("app:cancel-inapp-update", async () => {
    if (currentUpdateDownload) {
      currentUpdateDownload.abort();
      currentUpdateDownload = null;
    }
    return { success: true };
  });

  ipcMain.handle("app:apply-update-and-restart", async () => {
    try {
      const updateDir = path.join(app.getPath("userData"), "update");
      const stagedAsarPath = path.join(updateDir, "new_app.asar");

      if (!fs.existsSync(stagedAsarPath)) {
        throw new Error("未找到已就绪的更新文件，请先下载更新");
      }

      if (!app.isPackaged) {
        dialog.showMessageBoxSync(mainWindow, {
          type: "info",
          title: "开发环境提示",
          message: "当前运行在源码开发环境中 (非打包 exe 客户端)",
          detail: `更新核心文件已成功下载至：\n${stagedAsarPath}\n\n在独立运行的打包客户端中，此操作会自动替换 resources/app.asar 并秒级重启。`,
          buttons: ["知道了"],
        });
        return { success: true, isDev: true };
      }

      const targetAsarPath = path.join(process.resourcesPath, "app.asar");
      const exePath = process.execPath;
      const batPath = path.join(updateDir, "updater.bat");

      const batContent = `@echo off
chcp 65001 >nul
title CD Netease Player 正在自动更新...

set OLD_PID=%1
set TARGET_ASAR=%~2
set NEW_ASAR=%~3
set EXE_PATH=%~4

:wait_process
timeout /t 1 /nobreak >nul
tasklist /fi "PID eq %OLD_PID%" 2>nul | findstr /i "%OLD_PID%" >nul
if "%ERRORLEVEL%"=="0" goto wait_process

timeout /t 1 /nobreak >nul

set RETRY=0
:copy_loop
copy /y "%NEW_ASAR%" "%TARGET_ASAR%" >nul 2>&1
if "%ERRORLEVEL%"=="0" goto copy_ok

set /a RETRY+=1
if %RETRY% GEQ 10 goto copy_fail
timeout /t 1 /nobreak >nul
goto copy_loop

:copy_ok
del /f /q "%NEW_ASAR%" >nul 2>&1
start "" "%EXE_PATH%"
(goto) 2>nul & del "%~f0"
exit /b 0

:copy_fail
echo 自动替换更新文件失败，稍后将重新启动旧版本...
timeout /t 2 /nobreak >nul
start "" "%EXE_PATH%"
(goto) 2>nul & del "%~f0"
exit /b 1
`;

      fs.writeFileSync(batPath, batContent, "utf8");

      const child = spawn("cmd.exe", ["/c", batPath, process.pid.toString(), targetAsarPath, stagedAsarPath, exePath], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      isQuitting = true;
      app.exit(0);

      return { success: true };
    } catch (err) {
      return { success: false, message: err.message || "应用更新失败" };
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  try {
    globalShortcut.unregisterAll();
  } catch (err) {}
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && isQuitting) app.quit();
});
