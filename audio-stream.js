const { app, protocol, ipcMain, net, dialog } = require("electron");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const files = require("node:fs/promises");
const { decodeAudio, removeDirectory, serveWav } = require("./av3a-decoder");

const mimeTypes = new Map([
  ["flac", "audio/flac"], ["mp3", "audio/mpeg"], ["m4a", "audio/mp4"],
  ["mp4", "audio/mp4"], ["aac", "audio/aac"], ["ogg", "audio/ogg"], ["wav", "audio/wav"],
]);

function cdnURL(value) {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port ||
        !/\.(music\.126\.net|music\.163\.com)$/.test(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

function detectType(bytes) {
  const text = (a, b) => Buffer.from(bytes.subarray(a, b)).toString("ascii");
  if (text(0, 4) === "fLaC") return "audio/flac";
  if (text(0, 3) === "ID3" ||
      (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 6) !== 0)) return "audio/mpeg";
  if (text(4, 8) === "ftyp") return "audio/mp4";
  if (text(0, 4) === "OggS") return "audio/ogg";
  if (text(0, 4) === "RIFF" && text(8, 12) === "WAVE") return "audio/wav";
  return "";
}

function inspectAudioEntry(bytes, stream) {
  if (stream.codec) return;
  // The MP4 media handler may fetch a tail range to read the sample table.
  // Keep a short overlap for sample entries split across network chunks.
  const data = Buffer.concat([stream.overlap, Buffer.from(bytes)]);
  let position = 4;
  while (position + 12 <= data.length) {
    const tag = data.subarray(position, position + 4).toString("ascii").toLowerCase();
    if (tag === "av3a" || tag === "av3v") {
      const boxSize = data.readUInt32BE(position - 4);
      if (boxSize >= 36 && data.subarray(position + 4, position + 10).every(byte => byte === 0) &&
          data.readUInt16BE(position + 10) > 0) {
        stream.codec = tag === "av3v" ? "AV3V" : "AV3A";
        break;
      }
    }
    position++;
  }
  stream.overlap = Buffer.from(data.subarray(-15));
}

function registerAudioProtocol() {
  protocol.registerSchemesAsPrivileged([{ scheme: "cd-audio", privileges: {
    standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
  } }]);
}

async function requestCDN(initialURL, method, headers, signal) {
  let url = initialURL;
  for (let redirects = 0; redirects <= 4; redirects++) {
    const response = await net.fetch(url.href, { method, headers, signal,
      credentials: "omit", redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel().catch(() => {});
    const target = response.headers.get("location");
    url = target && cdnURL(new URL(target, url).href);
    if (!url || redirects === 4) throw new Error("CDN 跳转不可用");
  }
}

async function installAudioProtocol(getWindow) {
  const streams = new Map();
  const settingsPath = path.join(app.getPath("userData"), "av3a-decoder.json");
  let decoderPath;
  try {
    const saved = JSON.parse(await files.readFile(settingsPath, "utf8")).executable;
    if (typeof saved === "string" && path.isAbsolute(saved) && path.extname(saved).toLowerCase() === ".exe") decoderPath = saved;
  } catch {
    // Decoder selection is optional.
  }
  function release(token) {
    const stream = streams.get(token);
    streams.delete(token);
    stream?.abort.abort();
    if (stream?.decoded) return removeDirectory(stream.decoded.directory);
  }
  app.on("before-quit", event => {
    if (!streams.size) return;
    event.preventDefault();
    const active = [...streams.entries()];
    Promise.allSettled(active.map(async ([token, stream]) => {
      await release(token);
      await stream.decoding?.catch(() => {});
    })).then(() => app.quit());
  });
  const rendererURL = pathToFileURL(path.join(__dirname, "index.html")).href;
  const fromRenderer = event => event.sender === getWindow()?.webContents &&
    event.senderFrame?.url === rendererURL && !event.senderFrame.parent;
  ipcMain.handle("cd-audio:open", (event, value, format) => {
    if (!fromRenderer(event)) return null;
    const url = cdnURL(value);
    if (!url) return null;
    if (streams.size >= 8) void release(streams.keys().next().value);
    const token = randomUUID();
    const type = mimeTypes.get(typeof format === "string" ? format.toLowerCase() : "") ||
      mimeTypes.get(path.extname(url.pathname).slice(1).toLowerCase());
    streams.set(token, { url, type, error: "", codec: "", abort: new AbortController() });
    return { token, url: "cd-audio://stream/" + token };
  });
  ipcMain.handle("cd-audio:close", (event, token) => {
    if (fromRenderer(event)) void release(token);
  });
  ipcMain.handle("cd-audio:error", (event, token) =>
    fromRenderer(event) ? streams.get(token)?.error || "" : "");

  ipcMain.handle("cd-audio:codec", (event, token) =>
    fromRenderer(event) ? streams.get(token)?.codec || "" : "");

  function findBundledDecoder() {
    const candidates = [
      path.join(process.resourcesPath || "", "app.asar.unpacked", "bin", "molan-av3a.exe"),
      path.join(process.resourcesPath || "", "bin", "molan-av3a.exe"),
      path.join(process.resourcesPath || "", "molan-av3a.exe"),
      path.join(path.dirname(app.getPath("exe")), "bin", "molan-av3a.exe"),
      path.join(path.dirname(app.getPath("exe")), "molan-av3a.exe"),
      !__dirname.includes(".asar") ? path.join(__dirname, "bin", "molan-av3a.exe") : "",
      !__dirname.includes(".asar") ? path.join(__dirname, "molan-av3a.exe") : "",
      __dirname.includes(".asar") ? path.join(__dirname.replace(/app\.asar.*$/, "app.asar.unpacked"), "bin", "molan-av3a.exe") : "",
    ].filter(Boolean);

    for (const c of candidates) {
      try {
        if (!c.includes(".asar\\") && !c.includes(".asar/") && require("node:fs").existsSync(c)) {
          return c;
        }
      } catch {}
    }
    return "";
  }

  function getEffectiveDecoder() {
    if (decoderPath) {
      try {
        if (require("node:fs").existsSync(decoderPath)) return decoderPath;
      } catch {}
    }
    return findBundledDecoder();
  }

  ipcMain.handle("cd-av3a:get", event => {
    if (!fromRenderer(event)) return "";
    const active = getEffectiveDecoder();
    if (active === decoderPath) return decoderPath;
    return active ? `${active} (内置 MOLAN-AV3A)` : "";
  });
  ipcMain.handle("cd-av3a:choose", async event => {
    if (!fromRenderer(event)) return null;
    const result = await dialog.showOpenDialog(getWindow(), {
      title: "选择兼容 MOLAN-AV3A 命令行格式的解码器",
      properties: ["openFile"], filters: [{ name: "Windows 可执行文件", extensions: ["exe"] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const executable = result.filePaths[0];
    if (path.extname(executable).toLowerCase() !== ".exe" || !(await files.stat(executable)).isFile()) {
      throw new Error("请选择解码器 EXE 文件");
    }
    await files.writeFile(settingsPath, JSON.stringify({ executable }), "utf8");
    decoderPath = executable;
    return decoderPath;
  });
  ipcMain.handle("cd-av3a:clear", async event => {
    if (!fromRenderer(event)) return null;
    await files.rm(settingsPath, { force: true });
    decoderPath = undefined;
    const bundled = findBundledDecoder();
    return bundled ? `${bundled} (内置 MOLAN-AV3A)` : "";
  });
  ipcMain.handle("cd-av3a:decode", async (event, token) => {
    const stream = fromRenderer(event) && streams.get(token);
    const isAv3 = stream?.codec === "AV3A" || stream?.codec === "AV3V";
    if (!isAv3) return { error: "音轨未经识别为 AV3A/AV3V" };
    const effective = getEffectiveDecoder();
    if (!effective) return { error: `已识别 ${stream.codec}，但未找到解码器` };
    const signal = stream.abort.signal;
    try {
      stream.decoding ??= decodeAudio(download => requestCDN(stream.url, "GET",
        new Headers({ "Accept-Encoding": "identity" }), download), effective, signal);
      const decoded = await stream.decoding;
      if (signal.aborted) {
        await removeDirectory(decoded.directory);
        return { error: `${stream.codec} 解码已取消` };
      }
      stream.decoded = decoded;
      return { url: "cd-audio://decoded/" + token };
    } catch (error) {
      const safeDetail = /^(AV3A |AV3V |找不到)/.test(error.message);
      return { error: signal.aborted ? `${stream.codec} 解码已取消` :
        safeDetail ? error.message : `无法解码 ${stream.codec} 音源: ${error.message}` };
    }
  });

  protocol.handle("cd-audio", async request => {
    const address = new URL(request.url);
    const stream = streams.get(address.pathname.slice(1));
    if (!stream || !["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 404 });
    if (address.hostname === "decoded" && stream.decoded) {
      try { return await serveWav(stream.decoded.file, request); }
      catch { return new Response(null, { status: 404 }); }
    }
    if (address.hostname !== "stream") return new Response(null, { status: 404 });
    const range = request.headers.get("Range");
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) return new Response(null, { status: 416 });

    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal, stream.abort.signal]);
    const timer = setTimeout(() => controller.abort(), 17000);
    let reader;
    const headers = new Headers({ "Accept-Encoding": "identity" });
    if (range) headers.set("Range", range);
    try {
      const response = await requestCDN(stream.url, request.method, headers, signal);

      const resultHeaders = new Headers({ "Access-Control-Allow-Origin": "*" });
      for (const key of ["content-length", "content-range", "accept-ranges"]) {
        const value = response.headers.get(key);
        if (value) resultHeaders.set(key, value);
      }
      if (!response.ok) {
        stream.error = "CDN HTTP " + response.status;
        await response.body?.cancel().catch(() => {});
        resultHeaders.delete("content-length");
        return new Response(null, { status: response.status, headers: resultHeaders });
      }
      const reported = response.headers.get("content-type")?.split(";")[0];
      if (!response.body) {
        resultHeaders.set("content-type", stream.type || reported || "application/octet-stream");
        return new Response(null, { status: response.status, headers: resultHeaders });
      }

      reader = response.body.getReader();
      const buffers = [];
      // Keep overlaps local to this response so unrelated seek ranges never join.
      const inspector = { codec: stream.codec, overlap: Buffer.alloc(0) };
      const inspect = chunk => {
        if (stream.codec) return;
        inspectAudioEntry(chunk, inspector);
        if (inspector.codec) stream.codec = inspector.codec;
      };
      if (!response.headers.get("content-range") || /^bytes 0-/i.test(response.headers.get("content-range"))) {
        const prefix = new Uint8Array(12);
        let length = 0;
        while (length < prefix.length) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffers.push(chunk.value);
          inspect(chunk.value);
          const bytes = chunk.value.subarray(0, prefix.length - length);
          prefix.set(bytes, length);
          length += bytes.length;
        }
        stream.type = detectType(prefix.subarray(0, length)) || stream.type;
        const first = Buffer.from(prefix.subarray(0, length)).toString("ascii").trimStart();
        if (!length || /^(<|\{|\[)/.test(first) || /^(text\/|application\/json)/i.test(reported || "") && !detectType(prefix)) {
          throw new Error("CDN 未返回音频数据");
        }
      }
      resultHeaders.set("content-type", stream.type || reported || "application/octet-stream");
      const body = new ReadableStream({
        async pull(target) {
          try {
            if (buffers.length) return target.enqueue(buffers.shift());
            const chunk = await reader.read();
            if (chunk.done) target.close();
            else {
              inspect(chunk.value);
              target.enqueue(chunk.value);
            }
          } catch (error) {
            stream.error = "CDN 音频传输中断";
            target.error(error);
          }
        },
        cancel() { return reader.cancel(); },
      });
      return new Response(body, { status: response.status, headers: resultHeaders });
    } catch (error) {
      stream.error = controller.signal.aborted ? "CDN 首包超时" :
        /^(CDN 跳转不可用|CDN 未返回音频数据)$/.test(error.message) ? error.message : "CDN 连接失败";
      if (reader) await reader.cancel().catch(() => {});
      return new Response(null, { status: 502, headers: { "Access-Control-Allow-Origin": "*" } });
    } finally {
      clearTimeout(timer);
    }
  });
}

module.exports = { registerAudioProtocol, installAudioProtocol };
