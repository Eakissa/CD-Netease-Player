// main.js - Electron 启动入口与主进程守护者 (Supervisor)
// 功能：单实例锁保护、热补丁生命周期守护（Boot Guard 自愈防崩）、分发加载核心业务模块

const { app, dialog } = require("electron");
const path = require("path");
const fs = require("fs");

global.__baseAppDir = __dirname;

// 1. 单实例锁检测 (防止重复开启)
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

// 2. 初始化补丁管理器与启动自愈保护
const { patchManager } = require("./patch-manager");
patchManager.init(global.__baseAppDir);

// 3. 动态调度核心业务模块
// 若激活的热补丁中包含 main-core.js，则安全尝试加载补丁版本；若异常则自动降级回退至内置基底
let coreLoaded = false;
if (patchManager.hasActivePatch) {
  const patchCorePath = path.join(patchManager.activePatchDir, "main-core.js");
  if (fs.existsSync(patchCorePath)) {
    try {
      require(patchCorePath);
      coreLoaded = true;
    } catch (err) {
      console.error("[Supervisor] 补丁 main-core.js 启动异常，自动隔离并回退至内置基底:", err);
      patchManager.quarantinePatch("main-core.js 启动抛错: " + err.message);
    }
  }
}

if (!coreLoaded) {
  require("./main-core.js");
}
