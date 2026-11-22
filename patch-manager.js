// patch-manager.js - 高可靠热补丁与微更新管理器
// 功能：提供崩溃自愈保护（Boot Guard）、热补丁生命周期管理、文件虚拟覆盖拦截与一键回滚

const { app } = require("electron");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

class PatchManager {
  constructor() {
    this.baseAppDir = __dirname;
    this.userData = "";
    this.patchesDir = "";
    this.activePatchDir = "";
    this.stagingPatchDir = "";
    this.backupPatchDir = "";
    this.guardFilePath = "";
    
    this.hasActivePatch = false;
    this.activeManifest = null;
    this.guardState = { bootAttempts: 0, disabled: false, lastError: null };
  }

  init(baseDir) {
    this.baseAppDir = baseDir || __dirname;
    try {
      this.userData = app.getPath("userData");
    } catch (e) {
      this.userData = path.join(process.env.APPDATA || process.env.USERPROFILE || ".", "cd-netease-player");
    }

    this.patchesDir = path.join(this.userData, "patches");
    this.activePatchDir = path.join(this.patchesDir, "active");
    this.stagingPatchDir = path.join(this.patchesDir, "staging");
    this.backupPatchDir = path.join(this.patchesDir, "backup");
    this.guardFilePath = path.join(this.patchesDir, "patch_guard.json");

    this._ensureDirectories();
    this._loadGuardState();
    this._checkActivePatch();
  }

  _ensureDirectories() {
    try {
      if (!fs.existsSync(this.patchesDir)) fs.mkdirSync(this.patchesDir, { recursive: true });
    } catch (e) {}
  }

  _loadGuardState() {
    try {
      if (fs.existsSync(this.guardFilePath)) {
        const raw = fs.readFileSync(this.guardFilePath, "utf8");
        this.guardState = { ...this.guardState, ...JSON.parse(raw) };
      }
    } catch (e) {
      this.guardState = { bootAttempts: 0, disabled: false, lastError: null };
    }
  }

  _saveGuardState() {
    try {
      fs.writeFileSync(this.guardFilePath, JSON.stringify(this.guardState, null, 2), "utf8");
    } catch (e) {}
  }

  _checkActivePatch() {
    const manifestPath = path.join(this.activePatchDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      this.hasActivePatch = false;
      this.activeManifest = null;
      return;
    }

    // 崩溃自愈保护（Boot Guard）：连续 2 次启动未正常就绪则自动隔离故障补丁
    if (this.guardState.bootAttempts >= 2) {
      console.warn("[PatchManager] ⚠️ 检测到补丁可能导致启动异常 (bootAttempts >= 2)，已自动安全隔离并回滚至内置基底！");
      this.quarantinePatch("启动崩溃检测：补丁连续2次未能正常就绪");
      return;
    }

    try {
      this.activeManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      this.hasActivePatch = true;
      // 记录启动尝试
      this.guardState.bootAttempts = (this.guardState.bootAttempts || 0) + 1;
      this._saveGuardState();
      console.log(`[PatchManager] 🚀 已成功激活微补丁 v${this.activeManifest.version} (Boot attempt: ${this.guardState.bootAttempts})`);
    } catch (err) {
      console.error("[PatchManager] 解析补丁 manifest 失败，回退至内置基底:", err.message);
      this.quarantinePatch("解析 manifest 失败: " + err.message);
    }
  }

  // 当窗口加载完成并稳定运行后调用，重置崩溃计数器
  markBootHealthy() {
    if (this.guardState.bootAttempts > 0) {
      this.guardState.bootAttempts = 0;
      this.guardState.lastHealthyAt = Date.now();
      this._saveGuardState();
      console.log("[PatchManager] ✅ 补丁运行状态已确认为健康稳定。");
    }
  }

  // 隔离异常补丁
  quarantinePatch(reason = "未知异常") {
    try {
      const quarantineDir = path.join(this.patchesDir, `quarantine_${Date.now()}`);
      if (fs.existsSync(this.activePatchDir)) {
        fs.renameSync(this.activePatchDir, quarantineDir);
      }
    } catch (e) {
      try {
        fs.rmSync(this.activePatchDir, { recursive: true, force: true });
      } catch (err) {}
    }
    this.hasActivePatch = false;
    this.activeManifest = null;
    this.guardState.bootAttempts = 0;
    this.guardState.lastError = reason;
    this._saveGuardState();
  }

  // 恢复出厂设置（清除补丁并重启）
  revertToFactory() {
    try {
      if (fs.existsSync(this.activePatchDir)) {
        fs.rmSync(this.activePatchDir, { recursive: true, force: true });
      }
      this.hasActivePatch = false;
      this.activeManifest = null;
      this.guardState.bootAttempts = 0;
      this.guardState.lastError = "用户手动恢复内置基底版本";
      this._saveGuardState();
      
      app.relaunch();
      app.exit(0);
      return { success: true };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }

  // 设置 Chromium 协议拦截，实现对内置 app.asar 的无缝文件覆盖
  setupProtocolInterception(sessionInstance) {
    if (!sessionInstance || !sessionInstance.protocol) return;

    try {
      sessionInstance.protocol.interceptFileProtocol("file", (request, callback) => {
        let urlStr = request.url || "";
        let parsedUrl;
        try {
          parsedUrl = new URL(urlStr);
        } catch (e) {
          return callback({ path: decodeURI(urlStr.replace(/^file:\/\/\/?/, "")) });
        }

        let filePath = decodeURIComponent(parsedUrl.pathname);
        if (process.platform === "win32" && filePath.startsWith("/")) {
          filePath = filePath.slice(1);
        }
        filePath = path.normalize(filePath);

        // 如果存在激活的微补丁，检测请求是否属于基底应用程序目录中的文件
        if (this.hasActivePatch) {
          const rel = path.relative(this.baseAppDir, filePath);
          // 确保是该目录内的相对路径且没有向上越界
          if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
            const patchedPath = path.join(this.activePatchDir, rel);
            if (fs.existsSync(patchedPath)) {
              try {
                if (fs.statSync(patchedPath).isFile()) {
                  return callback({ path: patchedPath });
                }
              } catch (statErr) {}
            }
          }
        }

        callback({ path: filePath });
      });
      console.log("[PatchManager] 🔗 协议拦截层已就绪 (File Overlay Engine Active)");
    } catch (err) {
      console.error("[PatchManager] 设置协议拦截失败:", err);
    }
  }

  // 获取当前补丁信息与系统状态
  getStatus(baseVersion = "1.0.0") {
    return {
      hasActivePatch: this.hasActivePatch,
      activeVersion: this.hasActivePatch && this.activeManifest ? this.activeManifest.version : baseVersion,
      baseVersion: baseVersion,
      patchTime: this.activeManifest ? this.activeManifest.builtAt || this.activeManifest.timestamp : null,
      patchedFiles: this.activeManifest ? (this.activeManifest.files || []) : [],
      isQuarantined: !this.hasActivePatch && !!this.guardState.lastError,
      lastError: this.guardState.lastError,
    };
  }

  // 部署并激活已解压在 staging 目录中的新补丁
  applyStagedPatch() {
    const manifestPath = path.join(this.stagingPatchDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error("补丁包完整性校验失败：未找到 manifest.json 描述文件");
    }

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (e) {
      throw new Error("补丁描述文件格式错误: " + e.message);
    }

    if (!manifest.version) {
      throw new Error("补丁描述文件中缺少有效版本号");
    }

    // 备份当前补丁（若有）
    try {
      if (fs.existsSync(this.backupPatchDir)) {
        fs.rmSync(this.backupPatchDir, { recursive: true, force: true });
      }
      if (fs.existsSync(this.activePatchDir)) {
        fs.renameSync(this.activePatchDir, this.backupPatchDir);
      }
    } catch (e) {
      console.warn("[PatchManager] 备份当前补丁时出现警告:", e.message);
    }

    // 将 staging 部署为 active
    try {
      if (fs.existsSync(this.activePatchDir)) {
        fs.rmSync(this.activePatchDir, { recursive: true, force: true });
      }
      fs.renameSync(this.stagingPatchDir, this.activePatchDir);
    } catch (deployErr) {
      // 若重命名失败，尝试复制
      fs.mkdirSync(this.activePatchDir, { recursive: true });
      fs.cpSync(this.stagingPatchDir, this.activePatchDir, { recursive: true });
      fs.rmSync(this.stagingPatchDir, { recursive: true, force: true });
    }

    this.hasActivePatch = true;
    this.activeManifest = manifest;
    this.guardState.bootAttempts = 0;
    this.guardState.lastError = null;
    this.guardState.activeVersion = manifest.version;
    this.guardState.lastAppliedAt = Date.now();
    this._saveGuardState();

    return {
      success: true,
      version: manifest.version,
    };
  }
}

const patchManager = new PatchManager();

module.exports = {
  patchManager,
  PatchManager,
};
