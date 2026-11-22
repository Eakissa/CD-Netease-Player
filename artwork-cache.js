const { dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");

const MAX_ARTWORK_LENGTH = 4 * 1024 * 1024;
const artworkData = /^data:image\/(?:jpeg|png|webp|avif|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

function artworkName(url) {
  if (typeof url !== "string" || url.length > 2048) return null;
  try {
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol) ||
        !parsed.hostname.endsWith(".music.126.net") || parsed.username || parsed.password || parsed.port) return null;
    return createHash("sha256").update(parsed.href).digest("hex") + ".art";
  } catch {
    return null;
  }
}

async function writeAtomic(file, contents) {
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(temp, contents, { flag: "wx" });
    await fs.rename(temp, file);
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
}

async function installArtworkCache(cacheBaseDir, getWindow) {
  const defaults = cacheBaseDir;
  const config = path.join(cacheBaseDir, "artwork-cache.json");
  let directory = defaults;
  try {
    const saved = JSON.parse(await fs.readFile(config, "utf8")).directory;
    if (typeof saved === "string" && path.isAbsolute(saved)) {
      if (!saved.toLowerCase().includes("appdata")) {
        directory = saved;
      }
    }
  } catch {
    // 默认使用当前程序目录下的 cache 文件夹
  }

  try {
    await fs.mkdir(directory, { recursive: true });
  } catch {}

  const rendererURL = pathToFileURL(path.join(__dirname, "index.html")).href;
  function on(name, handler) {
    ipcMain.handle("cd-cache:" + name, (event, ...args) => {
      if (event.sender !== getWindow()?.webContents || !event.senderFrame ||
          event.senderFrame.parent || event.senderFrame.url !== rendererURL) {
        throw new Error("Invalid settings request");
      }
      return handler(...args);
    });
  }

  async function setDirectory(next) {
    await fs.mkdir(next, { recursive: true });
    await fs.access(next, require("node:fs").constants.W_OK);
    await writeAtomic(config, JSON.stringify({ directory: next }));
    directory = next;
    return next;
  }

  on("get", () => directory);
  on("open", async () => {
    try {
      await fs.mkdir(directory, { recursive: true });
      await shell.openPath(directory);
    } catch {}
  });
  on("choose", async () => {
    const choice = await dialog.showOpenDialog(getWindow(), {
      title: "选择缓存文件夹",
      defaultPath: directory,
      properties: ["openDirectory", "createDirectory"],
    });
    return choice.canceled || !choice.filePaths[0] ? null :
      setDirectory(choice.filePaths[0]);
  });
  on("reset", () => setDirectory(defaults));
  on("read-artwork", async url => {
    const name = artworkName(url);
    if (!name) return null;
    const file = path.join(directory, name);
    try {
      if ((await fs.stat(file)).size > MAX_ARTWORK_LENGTH) return null;
      const data = await fs.readFile(file, "utf8");
      return data.length <= MAX_ARTWORK_LENGTH && artworkData.test(data) ? data : null;
    } catch {
      return null;
    }
  });
  on("write-artwork", async (url, data) => {
    const name = artworkName(url);
    if (!name || typeof data !== "string" || data.length > MAX_ARTWORK_LENGTH || !artworkData.test(data)) return;
    const target = directory;
    await fs.mkdir(target, { recursive: true });
    await writeAtomic(path.join(target, name), data);
  });
}

module.exports = { installArtworkCache };
