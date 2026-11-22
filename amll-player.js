// amll-player.js — Apple Music Like Lyrics (AMLL) 播放器封装与集成
// 依赖：amll-bundle.js 中暴露的 window.AMLLCore

(function () {
  let player = null;
  let audioEl = null;
  let containerEl = null;
  let animId = null;
  let isSeeking = false;
  let rawLyricData = { yrc: "", lrc: "", tlyric: "", romalrc: "" };
  let currentLines = [];
  let showTranslation = true;
  let showRomaji = false;

  function init(container, audio) {
    if (!window.AMLLCore) {
      console.warn("[AMLL] AMLLCore 尚未加载");
      return;
    }
    containerEl = container || document.getElementById("amll-container");
    audioEl = audio || document.getElementById("ncm-audio");
    if (!containerEl) return;

    if (!player) {
      try {
        player = new window.AMLLCore.LyricPlayer();
        const el = player.getElement();
        el.style.width = "100%";
        el.style.height = "100%";
        containerEl.innerHTML = "";
        containerEl.appendChild(el);

        // 点击歌词行跳转播放进度
        player.addEventListener("click", (evt) => {
          if (typeof evt.lineIndex === "number" && currentLines && currentLines[evt.lineIndex] && audioEl) {
            const line = currentLines[evt.lineIndex];
            if (typeof line.startTime === "number") {
              const targetSec = line.startTime / 1000;
              audioEl.currentTime = Math.max(0, targetSec);
              seek(targetSec);
              if (audioEl.paused) {
                const playBtn = document.getElementById("ncm-play");
                playBtn?.click();
              }
            }
          }
        });
      } catch (err) {
        console.error("[AMLL] 初始化 LyricPlayer 失败:", err);
        return;
      }
    }

    // 动画帧驱动平滑滚动与逐字高亮
    let lastTs = performance.now();
    function tick(ts) {
      const delta = ts - lastTs;
      lastTs = ts;
      if (player && audioEl) {
        const timeMs = Math.round(audioEl.currentTime * 1000);
        player.setCurrentTime(timeMs, isSeeking);
        isSeeking = false;
        player.update(delta > 0 ? Math.min(delta, 100) : 16);
      }
      animId = requestAnimationFrame(tick);
    }
    cancelAnimationFrame(animId);
    animId = requestAnimationFrame(tick);

    console.log("[AMLL] Apple Music Like Lyrics 引擎就绪");
  }

  function applyLyrics() {
    if (!player || !window.AMLLCore) return;
    const { yrc, lrc, tlyric, romalrc } = rawLyricData;
    let lines = [];

    // 1. 优先使用逐字歌词 (YRC)
    if (yrc && typeof yrc === "string" && yrc.trim()) {
      try {
        lines = window.AMLLCore.parseYrc(yrc);
      } catch (e) {
        console.warn("[AMLL] parseYrc 失败，降级为标准 LRC", e);
      }
    }

    // 2. 降级为标准 LRC
    if ((!lines || !lines.length) && lrc && typeof lrc === "string" && lrc.trim()) {
      try {
        lines = window.AMLLCore.parseLrc(lrc);
      } catch (e) {
        console.warn("[AMLL] parseLrc 失败", e);
      }
    }

    if (!lines) lines = [];

    // 3. 合并翻译歌词
    if (showTranslation && tlyric && typeof tlyric === "string" && tlyric.trim() && lines.length) {
      try {
        const transLines = window.AMLLCore.parseLrc(tlyric);
        if (transLines && transLines.length) {
          lines.forEach(line => {
            const match = transLines.find(t => Math.abs(t.startTime - line.startTime) < 800);
            if (match) {
              line.translatedLyric = match.words.map(w => w.word).join("").trim();
            }
          });
        }
      } catch (e) {
        console.warn("[AMLL] 翻译歌词匹配失败", e);
      }
    }

    // 4. 合并罗马音
    if (showRomaji && romalrc && typeof romalrc === "string" && romalrc.trim() && lines.length) {
      try {
        const romaLines = window.AMLLCore.parseLrc(romalrc);
        if (romaLines && romaLines.length) {
          lines.forEach(line => {
            const match = romaLines.find(t => Math.abs(t.startTime - line.startTime) < 800);
            if (match) {
              line.romanLyric = match.words.map(w => w.word).join("").trim();
            }
          });
        }
      } catch (e) {
        console.warn("[AMLL] 罗马音匹配失败", e);
      }
    }

    currentLines = lines;
    player.setLyricLines(lines);
  }

  function setLyrics(data) {
    rawLyricData = data || { yrc: "", lrc: "", tlyric: "", romalrc: "" };
    applyLyrics();
  }

  function seek(timeSeconds) {
    isSeeking = true;
    if (player) {
      player.setCurrentTime(Math.round(timeSeconds * 1000), true);
    }
  }

  function reset() {
    rawLyricData = { yrc: "", lrc: "", tlyric: "", romalrc: "" };
    currentLines = [];
    if (player) {
      player.setLyricLines([]);
    }
  }

  function pause() {
    if (player) player.pause();
  }

  function resume() {
    if (player) player.resume();
  }

  function toggleTranslation(enable) {
    showTranslation = enable !== undefined ? enable : !showTranslation;
    applyLyrics();
    return showTranslation;
  }

  function toggleRomaji(enable) {
    showRomaji = enable !== undefined ? enable : !showRomaji;
    applyLyrics();
    return showRomaji;
  }

  window.AMLLPlayer = {
    init,
    setLyrics,
    seek,
    reset,
    pause,
    resume,
    toggleTranslation,
    toggleRomaji,
  };
})();
