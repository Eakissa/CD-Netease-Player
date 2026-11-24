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

        // 提取歌词目标跳转时间（单位：秒）
        const extractTargetSec = (evt) => {
          // 1. 从 AMLL 原生 Sx 事件 line 属性 (Ax 渲染器) 提取
          if (evt && evt.line) {
            const l = typeof evt.line.getLine === "function" ? evt.line.getLine() : (evt.line.lyricLine || evt.line);
            if (l && typeof l.startTime === "number" && l.startTime >= 0) {
              return l.startTime / 1000;
            }
          }
          // 2. 从 lineIndex 提取
          if (evt && typeof evt.lineIndex === "number" && evt.lineIndex >= 0) {
            if (player && player.processedLines && player.processedLines[evt.lineIndex]) {
              const pl = player.processedLines[evt.lineIndex];
              if (typeof pl.startTime === "number") return pl.startTime / 1000;
            }
            if (currentLines && currentLines[evt.lineIndex]) {
              const cl = currentLines[evt.lineIndex];
              if (typeof cl.startTime === "number") return cl.startTime / 1000;
            }
          }
          // 3. 从 DOM 元素查找最近的 .FmKaba_lyricLineWrapper
          const target = (evt && evt.target) ? evt.target : null;
          if (target && target.closest) {
            const wrapper = target.closest(".FmKaba_lyricLineWrapper");
            if (wrapper && player) {
              if (player.lyricGroupElementMap && player.lyricGroupElementMap.has(wrapper)) {
                const grp = player.lyricGroupElementMap.get(wrapper);
                if (grp) {
                  const grpLine = typeof grp.mainLine?.getLine === "function" ? grp.mainLine.getLine() : (grp.mainLine?.lyricLine || grp.mainLine);
                  if (grpLine && typeof grpLine.startTime === "number") {
                    return grpLine.startTime / 1000;
                  }
                  if (typeof grp.startTime === "number") {
                    return grp.startTime / 1000;
                  }
                }
              }
              if (player.currentLyricGroups && Array.isArray(player.currentLyricGroups)) {
                const found = player.currentLyricGroups.find(g => g.element === wrapper);
                if (found) {
                  const fLine = typeof found.mainLine?.getLine === "function" ? found.mainLine.getLine() : (found.mainLine?.lyricLine || found.mainLine);
                  if (fLine && typeof fLine.startTime === "number") {
                    return fLine.startTime / 1000;
                  }
                }
              }
              // 文本匹配兜底
              const txt = wrapper.innerText?.trim();
              if (txt && currentLines && currentLines.length) {
                const matched = currentLines.find(l => {
                  const lText = l.words ? l.words.map(w => w.word).join("").trim() : (l.text || "");
                  return lText && (txt.includes(lText) || lText.includes(txt));
                });
                if (matched && typeof matched.startTime === "number") {
                  return matched.startTime / 1000;
                }
              }
            }
          }
          return null;
        };

        // 执行跳转与进度同步
        const executeSeekToSec = (targetSec) => {
          if (targetSec === null || typeof targetSec !== "number" || isNaN(targetSec) || targetSec < 0) return;
          if (!audioEl) audioEl = document.getElementById("ncm-audio");
          if (!audioEl) return;

          console.log(`[AMLL] 精准跳转至歌词时间点: ${targetSec.toFixed(2)}s`);
          audioEl.currentTime = targetSec;
          seek(targetSec);

          if (audioEl.paused) {
            const playPromise = audioEl.play();
            if (playPromise !== undefined) {
              playPromise.catch(() => {
                const playBtn = document.getElementById("ncm-play");
                playBtn?.click();
              });
            }
          }

          // 同步更新悬浮底栏与聚焦视图进度与时间
          const curEl = document.getElementById("ncm-time-cur");
          const focusCurEl = document.getElementById("amll-focus-time-cur");
          const m = Math.floor(targetSec / 60);
          const s = Math.floor(targetSec % 60);
          const timeStr = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
          if (curEl) curEl.textContent = timeStr;
          if (focusCurEl) focusCurEl.textContent = timeStr;

          if (audioEl.duration && !isNaN(audioEl.duration) && audioEl.duration > 0) {
            const pct = Math.min(100, Math.max(0, (targetSec / audioEl.duration) * 100));
            const prog = document.getElementById("ncm-progress");
            const fprog = document.getElementById("amll-focus-progress");
            if (prog) {
              prog.value = pct;
              prog.style.setProperty("--progress-pct", pct + "%");
            }
            if (fprog) {
              fprog.value = pct;
              fprog.style.setProperty("--progress-pct", pct + "%");
            }
          }
        };

        player.addEventListener("line-click", (evt) => {
          const sec = extractTargetSec(evt);
          if (sec !== null) executeSeekToSec(sec);
        });
        player.addEventListener("click", (evt) => {
          const sec = extractTargetSec(evt);
          if (sec !== null) executeSeekToSec(sec);
        });
        containerEl.addEventListener("click", (evt) => {
          // 仅在聚焦模式下响应歌词点击跳转
          if (!document.body.classList.contains("lyrics-focus-mode")) return;
          const wrapper = evt.target.closest?.(".FmKaba_lyricLineWrapper, .FmKaba_lyricLine");
          if (wrapper) {
            const sec = extractTargetSec(evt);
            if (sec !== null) {
              executeSeekToSec(sec);
              evt.stopPropagation();
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
