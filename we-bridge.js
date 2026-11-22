// we-bridge.js — Wallpaper Engine API 桥接层
// 必须在 bundle.js 之前加载！
// 模拟 WE 的媒体/频谱监听 API，把网易云的音频数据喂给 3D CD 盒
(function () {
  const listeners = {
    audio: null,
    mediaStatus: null,
    mediaProperties: null,
    mediaThumbnail: null,
    mediaPlayback: null,
  };

  // 暴露 Wallpaper Engine 标准的播放状态常量
  window.wallpaperMediaIntegration = {
    PLAYBACK_STOPPED: 0,
    PLAYBACK_PLAYING: 1,
    PLAYBACK_PAUSED: 2,
  };

  // 注册各类监听（bundle.js 会调用这些来注册自己的处理函数）
  window.wallpaperRegisterAudioListener = (cb) => { listeners.audio = cb; };
  window.wallpaperRegisterMediaStatusListener = (cb) => { listeners.mediaStatus = cb; };
  window.wallpaperRegisterMediaPropertiesListener = (cb) => { listeners.mediaProperties = cb; };
  window.wallpaperRegisterMediaThumbnailListener = (cb) => { listeners.mediaThumbnail = cb; };
  window.wallpaperRegisterMediaPlaybackListener = (cb) => { listeners.mediaPlayback = cb; };
  window.wallpaperRegisterMediaTimelineListener = () => {}; // 不需要实现

  // ===== Web Audio API 实时频谱分析 -> 喂给原插件的 #eq 频谱 =====
  let audioCtx = null;
  let analyser = null;
  let dataArray = null;
  let boundAudioEl = null;
  const weAudioArray = new Array(128).fill(0);

  function bindAudioToSpectrum(audioEl) {
    // 同一个元素只绑定一次
    if (boundAudioEl === audioEl) return;
    boundAudioEl = audioEl;

    // 如果有旧的 AudioContext，关闭它
    if (audioCtx) {
      audioCtx.close();
      audioCtx = null;
      analyser = null;
      dataArray = null;
    }

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaElementSource(audioEl);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256; // 128 个频点
    analyser.smoothingTimeConstant = 0.75;
    src.connect(analyser);
    analyser.connect(audioCtx.destination);
    dataArray = new Uint8Array(analyser.frequencyBinCount);

    function tick() {
      requestAnimationFrame(tick);
      if (!listeners.audio) return;
      if (audioEl.paused) {
        // 暂停时频谱逐渐衰减
        for (let i = 0; i < 128; i++) weAudioArray[i] *= 0.85;
      } else {
        analyser.getByteFrequencyData(dataArray);
        // WE 格式：0-63 左声道，64-127 右声道，范围 0.0 ~ 1.0+
        for (let i = 0; i < 64; i++) {
          const val = (dataArray[i * 2] / 255) * 1.15;
          weAudioArray[i] = val;
          weAudioArray[64 + i] = val;
        }
      }
      listeners.audio(weAudioArray);
    }
    tick();
  }

  let artworkRequest = 0;

  // ===== 对外暴露给 netease-player.js 的驱动接口 =====
  window.CDCaseBridge = {
    /**
     * 绑定 <audio> 元素到频谱分析器
     * @param {HTMLAudioElement} audioEl
     */
    bindAudio(audioEl) {
      bindAudioToSpectrum(audioEl);
      if (audioCtx && audioCtx.state === "suspended") {
        audioCtx.resume();
      }
    },

    /**
     * 推送曲目元数据和封面，触发 CD 盒换碟动画与封面取色
     * @param {{ title: string, artist: string, albumTitle: string, coverUrl: string }} info
     */
    async updateTrack({ title, artist, albumTitle, coverUrl }) {
      const request = ++artworkRequest;
      // 1. 通知媒体状态已启用
      listeners.mediaStatus?.({ enabled: true });

      // 2. 推送曲目属性（触发左侧文字更新和 CD 标签渲染）
      listeners.mediaProperties?.({
        title: title || "Unknown",
        artist: artist || "Unknown",
        albumTitle: albumTitle || title || "",
        albumArtist: artist || "",
        contentType: "music",
      });

      // 3. 推送封面（转为 DataURL 防止跨域 canvas 污染）
      if (coverUrl) {
        try {
          const cache = window.CDCaseSettings;
          const cached = await cache?.readArtwork(coverUrl).catch(() => null);
          if (request !== artworkRequest) return;
          if (cached) {
            listeners.mediaThumbnail?.({ thumbnail: cached });
            return;
          }
          const res = await fetch(coverUrl);
          if (!res.ok) throw new Error("fetch failed");
          const blob = await res.blob();
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          cache?.writeArtwork(coverUrl, dataUrl).catch(() => {});
          if (request === artworkRequest) listeners.mediaThumbnail?.({ thumbnail: dataUrl });
        } catch (e) {
          console.warn("[CDCaseBridge] 封面转 DataURL 失败，直接传 URL", e);
          if (request === artworkRequest) listeners.mediaThumbnail?.({ thumbnail: coverUrl });
        }
      }
    },

    reset() {
      artworkRequest++;
      listeners.mediaPlayback?.({ state: window.wallpaperMediaIntegration.PLAYBACK_STOPPED });
    },

    /**
     * 通知播放状态（触发 CD 盒开盒/合盖动画）
     * @param {boolean} isPlaying
     */
    setPlaybackState(isPlaying) {
      listeners.mediaPlayback?.({
        state: isPlaying
          ? window.wallpaperMediaIntegration.PLAYBACK_PLAYING
          : window.wallpaperMediaIntegration.PLAYBACK_PAUSED,
      });
    },
  };

  console.log("[CDCaseBridge] Wallpaper Engine 桥接层已初始化");
})();
