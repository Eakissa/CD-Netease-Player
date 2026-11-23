// main-core.js - Electron 核心业务与更新引擎
// 功能：内置启动 NeteaseCloudMusicApi、创建播放器窗口、全局快捷键、托盘、分级更新与热补丁

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, globalShortcut, dialog, shell, session } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, execSync } = require("child_process");
const http = require("http");
const https = require("https");
const { installArtworkCache } = require("./artwork-cache");
const { patchManager } = require("./patch-manager");

const baseAppDir = global.__baseAppDir || __dirname;
const currentAppVersion = require("./package.json").version || "1.0.3";

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
            // 当前活跃版本（如果已安装补丁则按补丁版本比较）
            const activeStatus = patchManager.getStatus(currentAppVersion);
            const currentEffectiveVersion = activeStatus.activeVersion || currentAppVersion;
            const hasUpdate = compareVersions(latestTag, currentEffectiveVersion) > 0;
            
            const rawAssets = (data.assets || []).map(a => ({
              name: a.name,
              size: a.size,
              downloadUrl: a.browser_download_url,
            }));

            // 智能分析更新层级：
            // 优先检测微补丁包 patch-v*.zip（极速增量，仅几十到几百 KB）
            const patchAsset = rawAssets.find(a => {
              const n = (a.name || "").toLowerCase();
              return n.startsWith("patch") && n.endsWith(".zip");
            });

            // 其次检测轻量核心 Asar 包 app-update.zip
            const asarAsset = rawAssets.find(a => {
              const n = (a.name || "").toLowerCase();
              return n === "app-update.zip" || (n.includes("update") && n.endsWith(".zip") && !n.includes("win-x64"));
            });

            // 再次检测全量包
            const fullAsset = rawAssets.find(a => {
              const n = (a.name || "").toLowerCase();
              return n.endsWith(".zip") && (n.includes("win-x64") || n.includes("win"));
            });

            let recommendedType = "full";
            let recommendedAsset = fullAsset;
            if (patchAsset) {
              recommendedType = "patch";
              recommendedAsset = patchAsset;
            } else if (asarAsset) {
              recommendedType = "asar";
              recommendedAsset = asarAsset;
            }

            resolve({
              success: true,
              hasUpdate,
              currentVersion: currentEffectiveVersion,
              baseVersion: currentAppVersion,
              isPatch: activeStatus.hasActivePatch,
              latestVersion: latestTag.replace(/^v/i, ""),
              tagName: latestTag,
              name: data.name || latestTag,
              body: data.body || "",
              htmlUrl: data.html_url || "https://github.com/Eakissa/CD-Netease-Player/releases",
              publishedAt: data.published_at,
              assets: rawAssets,
              updateType: recommendedType,
              recommendedAsset: recommendedAsset,
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
let pendingUpdateType = null; // 'patch' | 'asar'

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return "0 MB";
  if (bytes < 1024 * 1024) {
    return (bytes / 1024).toFixed(1) + " KB";
  }
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
          if (now - lastTime >= 250) {
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

const { registerAudioProtocol, installAudioProtocol } = require("./audio-stream");

// 计算当前程序根目录与内置缓存目录 (绿色便携定位)
const appDir = app.isPackaged ? path.dirname(process.resourcesPath) : path.resolve(baseAppDir, "..");
const appCacheDir = path.join(appDir, "cache");
try {
  fs.mkdirSync(appCacheDir, { recursive: true });
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
  const iconPath = path.join(baseAppDir, "tray-icon.png");
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
    let NcmModule;
    try {
      NcmModule = require("NeteaseCloudMusicApi");
    } catch (e1) {
      // 补丁运行在外部 AppData 目录时，回退定位内置 app.asar 的依赖
      const baseDir = global.__baseAppDir || __dirname;
      const directPath = path.join(baseDir, "node_modules", "NeteaseCloudMusicApi");
      NcmModule = require(directPath);
    }
    const { serveNcmApi } = NcmModule;
    await serveNcmApi({
      port: 3000,
      checkVersion: false,
    });
    console.log("[Main] NeteaseCloudMusicApi 已在内部启动，端口：3000");
  } catch (err) {
    console.error("[Main] 内置 API 启动失败：", err.message);
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
      backgroundThrottling: false,
      webSecurity: false,
      contextIsolation: true,
      preload: path.join(baseAppDir, "preload.js"),
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(baseAppDir, "index.html"));

  mainWindow.webContents.on("did-finish-load", () => {
    // 窗口稳定加载完成，重置启动自愈计数器
    patchManager.markBootHealthy();
  });

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
  // 设置 Chromium 协议拦截，实现无缝微补丁资产映射
  patchManager.setupProtocolInterception(session.defaultSession);

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

  ipcMain.handle("app:get-patch-status", () => {
    return patchManager.getStatus(currentAppVersion);
  });

  ipcMain.handle("app:revert-patch", () => {
    return patchManager.revertToFactory();
  });

  ipcMain.handle("app:open-external", async (_, url) => {
    if (url && (url.startsWith("http://") || url.startsWith("https://"))) {
      await shell.openExternal(url);
      return true;
    }
    return false;
  });

  ipcMain.handle("app:get-version", () => {
    const status = patchManager.getStatus(currentAppVersion);
    return status.activeVersion || currentAppVersion;
  });

  ipcMain.handle("app:start-inapp-update", async (_, options = {}) => {
    try {
      const { assets = [], useMirror = true, updateType } = options;
      if (!assets || assets.length === 0) {
        throw new Error("此版本发布中未包含可用的更新文件");
      }

      // 智能选取最合适的更新包：
      // 1. 优先找热补丁包 patch-v*.zip（仅几十 KB）
      let targetAsset = assets.find(a => {
        const n = (a.name || "").toLowerCase();
        return n.startsWith("patch") && n.endsWith(".zip");
      });

      let isPatch = false;
      if (targetAsset) {
        isPatch = true;
      } else {
        // 2. 其次找轻量核心更新包 app-update.zip
        targetAsset = assets.find(a => {
          const n = (a.name || "").toLowerCase();
          return n === "app-update.zip" || (n.includes("update") && n.endsWith(".zip") && !n.includes("win-x64"));
        });
      }

      let isZip = true;
      if (!targetAsset) {
        // 3. 再次找 standalone asar
        targetAsset = assets.find(a => (a.name || "").toLowerCase().endsWith(".asar"));
        if (!targetAsset) {
          // 4. 最后兜底找 Windows 全量 zip
          targetAsset = assets.find(a => {
            const n = (a.name || "").toLowerCase();
            return n.endsWith(".zip") && (n.includes("win-x64") || n.includes("win"));
          });
        }
        if (!targetAsset || !targetAsset.name.endsWith(".zip")) isZip = false;
      }

      if (!targetAsset || !targetAsset.downloadUrl) {
        throw new Error("未找到适配 Windows 的更新包");
      }

      pendingUpdateType = isPatch ? "patch" : "asar";

      const updateDir = path.join(app.getPath("userData"), isPatch ? "patches" : "update");
      if (!fs.existsSync(updateDir)) {
        fs.mkdirSync(updateDir, { recursive: true });
      }

      const stagingDir = isPatch ? patchManager.stagingPatchDir : updateDir;
      if (!fs.existsSync(stagingDir)) {
        fs.mkdirSync(stagingDir, { recursive: true });
      }

      const tempDownloadPath = path.join(updateDir, isPatch ? "temp_patch.zip" : (isZip ? "update.zip" : "download.asar.tmp"));
      const stagedAsarPath = path.join(updateDir, "new_app.asar");

      try {
        if (fs.existsSync(tempDownloadPath)) fs.unlinkSync(tempDownloadPath);
        if (!isPatch && fs.existsSync(stagedAsarPath)) fs.unlinkSync(stagedAsarPath);
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
        message: isPatch ? "正在连接下载极速微补丁..." : "正在连接下载节点...",
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

      // 解压与校验逻辑
      if (isPatch) {
        sendProgress({
          state: "extracting",
          percent: 99,
          message: "正在部署并校验微补丁...",
        });

        // 清空 staging 目录
        if (fs.existsSync(stagingDir)) {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }
        fs.mkdirSync(stagingDir, { recursive: true });

        // 解压微补丁
        let extracted = false;
        try {
          execSync(`tar -xf "${tempDownloadPath}" -C "${stagingDir}"`, { timeout: 15000 });
          extracted = true;
        } catch (tarErr) {
          const psCmd = `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${tempDownloadPath}' -DestinationPath '${stagingDir}' -Force"`;
          execSync(psCmd, { timeout: 30000 });
          extracted = true;
        }

        try { fs.unlinkSync(tempDownloadPath); } catch (e) {}

        if (!extracted) {
          throw new Error("微补丁解压失败");
        }

        // 应用补丁到 active 目录
        const result = patchManager.applyStagedPatch();

        sendProgress({
          state: "ready",
          percent: 100,
          isPatch: true,
          message: `✅ 微补丁 v${result.version} 已就绪！点击立即重启生效`,
        });

        return { success: true, isPatch: true, version: result.version };
      } else {
        // 核心 Asar 更新
        sendProgress({
          state: "extracting",
          percent: 99,
          message: "正在从核心更新包解压 app.asar...",
        });

        let extracted = false;
        try {
          execSync(`tar -xf "${tempDownloadPath}" -C "${updateDir}"`, { timeout: 30000 });
          const directAsar = path.join(updateDir, "app.asar");
          const nestedAsar = path.join(updateDir, "resources", "app.asar");
          if (fs.existsSync(directAsar)) {
            if (fs.existsSync(stagedAsarPath)) fs.unlinkSync(stagedAsarPath);
            fs.renameSync(directAsar, stagedAsarPath);
            extracted = true;
          } else if (fs.existsSync(nestedAsar)) {
            if (fs.existsSync(stagedAsarPath)) fs.unlinkSync(stagedAsarPath);
            fs.renameSync(nestedAsar, stagedAsarPath);
            extracted = true;
          }
        } catch (tarErr) {
          try {
            const psCmd = `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${tempDownloadPath}' -DestinationPath '${path.join(updateDir, 'extracted')}' -Force"`;
            execSync(psCmd, { timeout: 60000 });
            const psDirect = path.join(updateDir, "extracted", "app.asar");
            const psNested = path.join(updateDir, "extracted", "resources", "app.asar");
            if (fs.existsSync(psDirect)) {
              if (fs.existsSync(stagedAsarPath)) fs.unlinkSync(stagedAsarPath);
              fs.renameSync(psDirect, stagedAsarPath);
              extracted = true;
            } else if (fs.existsSync(psNested)) {
              if (fs.existsSync(stagedAsarPath)) fs.unlinkSync(stagedAsarPath);
              fs.renameSync(psNested, stagedAsarPath);
              extracted = true;
            }
          } catch (psErr) {}
        }

        try { fs.unlinkSync(tempDownloadPath); } catch (e) {}

        if (!extracted || !fs.existsSync(stagedAsarPath)) {
          throw new Error("更新包解压失败，未找到有效的核心文件");
        }

        const stats = fs.statSync(stagedAsarPath);
        if (stats.size < 1024 * 1024) {
          throw new Error("下载的核心更新文件损坏或大小异常");
        }

        sendProgress({
          state: "ready",
          percent: 100,
          isPatch: false,
          message: "核心更新准备就绪，点击立即重启即可替换！",
        });

        return { success: true, isPatch: false, stagedAsar: stagedAsarPath };
      }
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
      if (pendingUpdateType === "patch" || patchManager.hasActivePatch) {
        // 微补丁重启：无任何锁文件限制，直接原子重启
        isQuitting = true;
        app.relaunch();
        app.exit(0);
        return { success: true, isPatch: true };
      }

      // 核心 Asar 替换重启
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
