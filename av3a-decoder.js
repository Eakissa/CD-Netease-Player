const fs = require("node:fs");
const files = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");

const execute = promisify(execFile);
const MAX_INPUT = 128 * 1024 * 1024;
const MAX_WAV = 512 * 1024 * 1024;

function removeDirectory(directory) {
  return files.rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}

async function decodeAudio(fetchAudio, executable, signal) {
  const directory = await files.mkdtemp(path.join(os.tmpdir(), "cd-av3a-"));
  const input = path.join(directory, "track.m4a");
  const decoded = path.join(directory, "decoded.wav");
  try {
    const download = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
    const response = await fetchAudio(download);
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new Error("AV3A 源文件 HTTP " + response.status);
    }
    async function* limit(source) {
      let size = 0;
      for await (const chunk of source) {
        size += chunk.length;
        if (size > MAX_INPUT) throw new Error("AV3A 源文件超出 128 MiB");
        yield chunk;
      }
    }
    await pipeline(Readable.fromWeb(response.body), limit, fs.createWriteStream(input), { signal: download });
    try {
      await execute(executable, ["decode", input, decoded], {
        windowsHide: true, timeout: 45000, maxBuffer: 256 * 1024, signal, cwd: path.dirname(executable),
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error.code === "ENOENT") throw new Error("找不到解码器执行文件: " + executable);
      throw new Error(error.killed ? "AV3A 解码超时" : "AV3A 解码器未能处理这条音源");
    }
    const output = path.join(directory, "stereo.wav");
    await stereoWav(decoded, output, signal);
    await Promise.all([files.unlink(input), files.unlink(decoded)]);
    return { file: output, directory };
  } catch (error) {
    await removeDirectory(directory);
    throw error;
  }
}

function channelWeights(channels, mask) {
  if (channels === 1) return [[1, 1]];
  const speakers = Array.from({ length: 18 }, (_, bit) => 1 << bit).filter(bit => mask & bit);
  if (speakers.length !== channels) {
    // Conventional order for unmasked beds, then the four height channels.
    speakers.splice(0, speakers.length, ...[1, 2, 4, 8, 16, 32, 512, 1024, 4096, 16384, 32768, 131072].slice(0, channels));
  }
  const weights = speakers.map(bit => {
    if (bit === 1) return [1, 0];
    if (bit === 2) return [0, 1];
    if ([16, 64, 512, 4096, 32768].includes(bit)) return [.707, 0];
    if ([32, 128, 1024, 16384, 131072].includes(bit)) return [0, .707];
    return bit === 8 ? [.25, .25] : [.5, .5];
  });
  const gain = Math.max(1, ...[0, 1].map(side => weights.reduce((sum, pair) => sum + pair[side], 0)));
  return weights.map(([left, right]) => [left / gain, right / gain]);
}

async function stereoWav(input, output, signal) {
  const inFile = await files.open(input, "r");
  try {
    const { size } = await inFile.stat();
    if (size < 44 || size > MAX_WAV) throw new Error("AV3A 解码输出大小异常");
    const header = Buffer.alloc(Math.min(size, 65536));
    await inFile.read(header, 0, header.length, 0);
    if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") {
      throw new Error("AV3A 解码器输出了无效的 WAV");
    }
    let format, data;
    for (let offset = 12; offset + 8 <= header.length; ) {
      const name = header.toString("ascii", offset, offset + 4);
      const length = header.readUInt32LE(offset + 4);
      const start = offset + 8;
      if (name === "fmt " && length >= 16 && start + length <= header.length) format = header.subarray(start, start + length);
      if (name === "data") { data = { start, length }; break; }
      offset = start + length + (length % 2);
    }
    const tag = format?.readUInt16LE(0);
    const channels = format?.readUInt16LE(2);
    const rate = format?.readUInt32LE(4);
    const extensiblePCM = tag === 65534 && format.length >= 40 &&
      format.subarray(24, 40).equals(Buffer.from("0100000000001000800000aa00389b71", "hex"));
    if (!data || data.start + data.length > size || !data.length || (tag !== 1 && !extensiblePCM) ||
        channels < 1 || channels > 12 || rate < 8000 || rate > 192000 ||
        format.readUInt16LE(14) !== 16 || format.readUInt16LE(12) !== channels * 2 ||
        data.length % (channels * 2) !== 0) {
      throw new Error("AV3A 解码输出不是受支持的 16 位 PCM WAV");
    }

    const mask = extensiblePCM ? format.readUInt32LE(20) : 0;
    const weights = channelWeights(channels, mask);
    const outputSize = (data.length / (channels * 2)) * 4;
    const wav = Buffer.alloc(44);
    for (const [offset, value] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]]) wav.write(value, offset);
    wav.writeUInt32LE(outputSize + 36, 4);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(2, 22);
    wav.writeUInt32LE(rate, 24);
    wav.writeUInt32LE(rate * 4, 28);
    wav.writeUInt16LE(4, 32);
    wav.writeUInt16LE(16, 34);
    wav.writeUInt32LE(outputSize, 40);

    async function* mix() {
      yield wav;
      const frameSize = channels * 2;
      const raw = Buffer.alloc(4096 * frameSize);
      for (let position = 0; position < data.length; ) {
        signal.throwIfAborted();
        const length = Math.min(raw.length, data.length - position);
        const { bytesRead } = await inFile.read(raw, 0, length, data.start + position);
        if (bytesRead !== length) throw new Error("AV3A 解码输出提前结束");
        const stereo = Buffer.alloc((length / frameSize) * 4);
        for (let frame = 0; frame < length / frameSize; frame++) {
          let left = 0, right = 0;
          weights.forEach(([a, b], channel) => {
            const sample = raw.readInt16LE(frame * frameSize + channel * 2);
            left += sample * a;
            right += sample * b;
          });
          stereo.writeInt16LE(Math.round(left), frame * 4);
          stereo.writeInt16LE(Math.round(right), frame * 4 + 2);
        }
        yield stereo;
        position += length;
      }
    }
    await pipeline(Readable.from(mix()), fs.createWriteStream(output), { signal });
  } finally {
    await inFile.close();
  }
}

async function serveWav(file, request) {
  const { size } = await files.stat(file);
  let start = 0, end = size - 1;
  const range = request.headers.get("Range");
  const headers = new Headers({
    "Content-Type": "audio/wav", "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*",
  });
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      if (match[1]) {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      } else if (match[2]) start = Math.max(0, size - Number(match[2]));
      else start = size;
    } else start = size;
    if (start >= size || end < start) {
      headers.set("Content-Range", "bytes */" + size);
      return new Response(null, { status: 416, headers });
    }
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  headers.set("Content-Length", String(end - start + 1));
  const body = request.method === "HEAD" ? null :
    Readable.toWeb(fs.createReadStream(file, { start, end, signal: request.signal }));
  return new Response(body, { status: range ? 206 : 200, headers });
}

module.exports = { decodeAudio, removeDirectory, serveWav, stereoWav };
