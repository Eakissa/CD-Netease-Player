// main.js — Electron 主进程
// 功能：内置启动 NeteaseCloudMusicApi，然后创建播放器窗口
// 双击 exe 即可使用，无需手动开 3000 端口

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, globalShortcut, dialog } = require("electron");
const path = require("path");
const http = require("http");
const { installArtworkCache } = require("./artwork-cache");

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
