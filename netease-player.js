// netease-player.js — 网易云音乐 API 对接与播放控制
// 依赖：本地运行 NeteaseCloudMusicApi（默认 http://localhost:3000）
// 依赖：we-bridge.js 中暴露的 window.CDCaseBridge

const API_BASE = "http://localhost:3000";

// ===== 状态变量 =====
let cookie = localStorage.getItem("ncm_cookie") || "";
let qrTimer = null;
let qrGeneration = 0;
let sessionGeneration = 0;
let playlistGeneration = 0;
let tracks = [];
let currentIdx = -1;
let lyrics = [];
let queueTracks = [];
let queueOrder = [];
let queueName = "";

// ===== 工具函数 =====
function setPlayerStatus(text, isError = false) {
  const qualityLabel = $("ncm-quality-now");
  if (qualityLabel && text) {
    qualityLabel.textContent = text;
    qualityLabel.hidden = false;
    qualityLabel.style.color = isError ? "#fda4af" : "";
  }
}

const $ = (id) => document.getElementById(id);
const audio = $("ncm-audio");
const quality = $("ncm-quality");
const qualityNames = new Map(Array.from(quality.options, item => [item.value, item.textContent]));
const savedQuality = localStorage.getItem("ncm_default_quality");
quality.value = (savedQuality && qualityNames.has(savedQuality)) ? savedQuality : "highest";
quality.onchange = () => localStorage.setItem("ncm_default_quality", quality.value);

const playButton = $("ncm-play");
function setPlayingAppearance(playing) {
  const label = playing ? "暂停" : "播放";
  playButton.dataset.playing = String(playing);
  playButton.title = label;
  playButton.setAttribute("aria-label", label);

  const focusPlayBtn = $("amll-focus-play");
  if (focusPlayBtn) {
    focusPlayBtn.dataset.playing = String(playing);
    focusPlayBtn.title = `${label} (空格)`;
    focusPlayBtn.setAttribute("aria-label", label);
  }

  const song = queueTracks[currentIdx];
  if (song) {
    const artist = (song.ar || []).map(a => a.name).join(" / ");
    window.CDCaseApp?.updateTrackStatus({
      title: song.name,
      artist,
      playing: Boolean(playing),
    });
  } else {
    window.CDCaseApp?.updateTrackStatus({
      title: "CD Netease Player",
      artist: "",
      playing: Boolean(playing),
    });
  }
}
function updateSlider(input, value) {
  input.value = value;
  input.style.setProperty("--fill", (Number(input.value) / Number(input.max) * 100) + "%");
}

document.addEventListener("dragstart", event => event.preventDefault());
const fmt = (s) => {
  if (!s || isNaN(s)) return "00:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
};

/**
 * 通用 API 请求（POST，附带 cookie 和时间戳防缓存）
 */
async function api(route, body = {}, { signal } = {}) {
  const payload = { ...body };
  if (cookie) payload.cookie = cookie;
  const timeout = AbortSignal.timeout(signal ? 8500 : 14000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  let data;
  try {
    response = await fetch(`${API_BASE}${route}?timestamp=${Date.now()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: requestSignal,
    });
    data = await response.json().catch(error => {
      if (requestSignal.aborted) throw error;
      return null;
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(error.name === "TimeoutError" ? "本地 API 请求超时" : "本地 API 连接失败");
  }
  if (!response.ok || !data) {
    const message = String(data?.msg || data?.message || "");
    const network = message.match(/\b(EACCES|EPERM|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b/)?.[1];
    const upstreamCode = Number(data?.code || response.status);
    const error = new Error(
      (response.ok ? "接口响应格式异常" : "HTTP " + response.status) +
      (upstreamCode !== response.status ? " / 网易云 " + upstreamCode : "") +
      (network ? " / " + network : "")
    );
    error.upstreamCode = upstreamCode;
    throw error;
  }
  return data;
}

// ===== 1. 扫码登录 =====
async function openQrLogin() {
  const generation = ++qrGeneration;
  clearInterval(qrTimer);
  $("ncm-qr-modal").classList.remove("hidden");
  $("ncm-qr-status").textContent = "正在生成二维码...";
  $("ncm-qr-img").src = "";

  try {
    const { data: { unikey } } = await api("/login/qr/key");
    const { data: { qrimg } } = await api("/login/qr/create", { key: unikey, qrimg: true });
    if (generation !== qrGeneration) return;

    $("ncm-qr-img").src = qrimg;
    $("ncm-qr-status").textContent = "请打开网易云音乐 APP 扫码";

    qrTimer = setInterval(async () => {
      try {
        const res = await api("/login/qr/check", { key: unikey });
        if (generation !== qrGeneration) return;
        if (res.code === 800) {
          $("ncm-qr-status").textContent = "二维码已过期，请点击刷新";
          clearInterval(qrTimer);
        } else if (res.code === 802) {
          $("ncm-qr-status").textContent = "✅ 已扫码，请在手机上确认登录";
        } else if (res.code === 803) {
          clearInterval(qrTimer);
          qrGeneration++;
          cookie = res.cookie;
          localStorage.setItem("ncm_cookie", cookie);
          $("ncm-qr-modal").classList.add("hidden");
          initSession();
        }
      } catch {
        // 轮询失败忽略，等下次
      }
    }, 2000);
  } catch {
    if (generation !== qrGeneration) return;
    $("ncm-qr-status").textContent = "❌ 连接本地 API (3000端口) 失败，请先启动服务";
  }
}

// ===== 全局 Toast 提示窗 =====
let playerToastTimer = null;
function showPlayerToast(msg) {
  const toast = $("ncm-player-toast");
  const text = $("ncm-player-toast-text");
  if (!toast || !text) return;
  text.textContent = msg;
  toast.hidden = false;
  toast.style.opacity = "1";
  toast.style.transform = "translateX(-50%) translateY(0)";
  clearTimeout(playerToastTimer);
  playerToastTimer = setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(-50%) translateY(6px)";
    setTimeout(() => { toast.hidden = true; }, 260);
  }, 2200);
}

// ===== 歌单与专辑状态与高速缓存 =====
let userPlaylists = [];
const playlistTracksCache = new Map();
let userAlbums = [];
const albumTracksCache = new Map();
let currentActiveDrawerTab = "playlists"; // "playlists" | "albums"

// ===== 自定义毛玻璃右键上下文菜单 =====
let contextMenuTargetSong = null;
const contextMenu = $("ncm-context-menu");
const ctxPlayBtn = $("ncm-ctx-play");
const ctxPlayNextBtn = $("ncm-ctx-play-next");

function hideContextMenu() {
  if (contextMenu) {
    contextMenu.hidden = true;
    contextMenu.style.display = "none";
  }
  contextMenuTargetSong = null;
}
hideContextMenu();

function showContextMenu(e, song) {
  if (!contextMenu || !song) return;
  e.preventDefault();
  e.stopPropagation();
  contextMenuTargetSong = song;
  contextMenu.hidden = false;
  contextMenu.style.display = "flex";

  const menuWidth = 215;
  const menuHeight = 90;
  const x = Math.min(e.clientX, window.innerWidth - menuWidth - 10);
  const y = Math.min(e.clientY, window.innerHeight - menuHeight - 10);
  contextMenu.style.left = `${Math.max(10, x)}px`;
  contextMenu.style.top = `${Math.max(10, y)}px`;
}

if (ctxPlayBtn) {
  ctxPlayBtn.onclick = () => {
    if (!contextMenuTargetSong) return;
    const song = contextMenuTargetSong;
    hideContextMenu();
    // 播放（增加到当前播放列表）
    const existingIdx = queueTracks.findIndex(s => s.id === song.id);
    if (existingIdx >= 0) {
      playTrack(existingIdx);
    } else {
      const insertIdx = currentIdx >= 0 ? currentIdx + 1 : 0;
      queueTracks.splice(insertIdx, 0, song);
      rebuildQueueOrder(insertIdx);
      playTrack(insertIdx);
    }
    showPlayerToast(`已加入播放列表并播放: ${song.name}`);
  };
}

if (ctxPlayNextBtn) {
  ctxPlayNextBtn.onclick = () => {
    if (!contextMenuTargetSong) return;
    const song = contextMenuTargetSong;
    hideContextMenu();
    // 下一首播放
    const insertIdx = currentIdx >= 0 ? currentIdx + 1 : 0;
    queueTracks.splice(insertIdx, 0, song);
    rebuildQueueOrder(currentIdx);
    renderQueue();
    showPlayerToast(`已添加至下一首播放: ${song.name}`);
  };
}

document.addEventListener("click", (e) => {
  if (!contextMenu?.hidden && !e.target.closest("#ncm-context-menu")) {
    hideContextMenu();
  }
});
document.addEventListener("contextmenu", (e) => {
  if (!e.target.closest(".ncm-track, .ncm-accordion-item, .ncm-album-card, #ncm-context-menu")) {
    hideContextMenu();
  }
});
window.addEventListener("blur", hideContextMenu);
window.addEventListener("resize", hideContextMenu);

// 通用曲目行 DOM 构造函数
function createTrackRow(song, position, onPlayClick) {
  const row = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ncm-track";
  button.dataset.songId = song.id;

  const number = document.createElement("span");
  number.className = "ncm-track-number";
  number.textContent = position + 1;

  const info = document.createElement("span");
  const title = document.createElement("span");
  title.className = "ncm-track-title";
  title.textContent = song.name;
  const artist = document.createElement("span");
  artist.className = "ncm-track-artist";
  artist.textContent = (song.ar || []).map(item => item.name).join(" / ");
  button.title = artist.textContent ? `${song.name} - ${artist.textContent}` : song.name;
  info.append(title, artist);
  button.append(number, info);

  button.onclick = (e) => {
    e.stopPropagation();
    onPlayClick(song);
  };

  button.oncontextmenu = (e) => {
    showContextMenu(e, song);
  };

  row.append(button);
  return row;
}

// 获取歌单曲目（带内存缓存与自动分页拉取）
async function fetchPlaylistTracks(plId, expectedCount = 0) {
  if (playlistTracksCache.has(plId)) {
    return playlistTracksCache.get(plId);
  }
  const loaded = [];
  const limit = 500;
  for (let offset = 0; ; offset += limit) {
    const result = await api("/playlist/track/all", { id: plId, limit, offset });
    const songs = result.songs || [];
    loaded.push(...songs);
    if (expectedCount ? offset + limit >= expectedCount : songs.length < limit) break;
  }
  playlistTracksCache.set(plId, loaded);
  return loaded;
}

// ===== 2. 初始化会话（读取用户信息与歌单列表） =====
async function initSession() {
  if (!cookie) return;
  const generation = ++sessionGeneration;
  try {
    const res = await api("/login/status");
    if (generation !== sessionGeneration) return;
    const profile = res.data?.profile;
    if (!profile) {
      // cookie 已过期
      $("ncm-user").textContent = "登录已过期";
      $("ncm-btn-login").textContent = "重新登录";
      return;
    }

    $("ncm-user").textContent = profile.nickname;
    $("ncm-btn-login").textContent = "切换账号";

    const plRes = await api("/user/playlist", { uid: profile.userId, limit: 100 });
    if (generation !== sessionGeneration) return;
    userPlaylists = plRes.playlist || [];

    const select = $("ncm-playlist-select");
    if (select) {
      select.innerHTML = "";
      userPlaylists.forEach((pl) => {
        const opt = document.createElement("option");
        opt.value = pl.id;
        opt.dataset.trackCount = pl.trackCount;
        opt.textContent = `${pl.name} (${pl.trackCount})`;
        select.appendChild(opt);
      });
    }

    renderPlaylistAccordion();

    if (userPlaylists.length) {
      await loadPlaylist(userPlaylists[0].id);
    }

    // 后台轻量预热前几个歌单，使即时搜索快速响应
    setTimeout(async () => {
      for (const pl of userPlaylists.slice(0, 5)) {
        if (!playlistTracksCache.has(pl.id)) {
          try {
            await fetchPlaylistTracks(pl.id, Math.min(pl.trackCount, 200));
          } catch (e) {}
        }
      }
    }, 2500);
  } catch (err) {
    if (generation !== sessionGeneration) return;
    console.error("[NCM] 初始化会话失败", err);
    $("ncm-user").textContent = "加载失败";
  }
}

// ===== 3. 加载当前歌单曲目 =====
async function loadPlaylist(id) {
  const generation = ++playlistGeneration;
  $("ncm-track-list").innerHTML = '<li style="opacity:0.5">加载中...</li>';
  try {
    const pl = userPlaylists.find(p => String(p.id) === String(id));
    const expected = pl ? pl.trackCount : 0;
    const loaded = await fetchPlaylistTracks(id, expected);
    if (generation !== playlistGeneration) return;
    tracks = loaded;
    renderTracks();
  } catch {
    if (generation !== playlistGeneration) return;
    $("ncm-track-list").innerHTML = '<li style="opacity:0.5;color:#fda4af">加载歌单失败</li>';
  }
}

// ===== 3.1 渲染歌单折叠手风琴列表 =====
function renderPlaylistAccordion() {
  const container = $("ncm-playlist-accordion");
  if (!container) return;
  if (!userPlaylists.length) {
    container.innerHTML = '<div class="ncm-drawer-loading">暂无歌单</div>';
    return;
  }
  container.innerHTML = "";

  userPlaylists.forEach((pl) => {
    const item = document.createElement("div");
    item.className = "ncm-accordion-item";
    item.dataset.playlistId = pl.id;

    const header = document.createElement("div");
    header.className = "ncm-accordion-header";

    const cover = document.createElement("img");
    cover.className = "ncm-pl-cover";
    cover.src = pl.coverImgUrl ? `${pl.coverImgUrl}?param=100y100` : "";
    cover.loading = "lazy";
    cover.alt = pl.name;

    const info = document.createElement("div");
    info.className = "ncm-pl-info";
    const nameEl = document.createElement("span");
    nameEl.className = "ncm-pl-name";
    nameEl.textContent = pl.name;
    nameEl.title = pl.name;
    const countEl = document.createElement("span");
    countEl.className = "ncm-pl-count";
    countEl.textContent = `${pl.trackCount} 首`;
    info.append(nameEl, countEl);

    // 快速开始播放按钮（将歌单加入播放列表并立即开始从头播放）
    const quickPlayBtn = document.createElement("button");
    quickPlayBtn.type = "button";
    quickPlayBtn.className = "ncm-pl-quick-play";
    quickPlayBtn.title = `播放歌单: ${pl.name}`;
    quickPlayBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
    quickPlayBtn.onclick = async (e) => {
      e.stopPropagation();
      try {
        quickPlayBtn.style.opacity = "0.5";
        const songs = await fetchPlaylistTracks(pl.id, pl.trackCount);
        quickPlayBtn.style.opacity = "";
        if (!songs.length) {
          showPlayerToast("歌单内暂无曲目");
          return;
        }
        tracks = songs;
        queueTracks = songs;
        queueName = pl.name;
        rebuildQueueOrder(0);
        playTrack(0);
        showPlayerToast(`已开始播放歌单: ${pl.name} (${songs.length} 首)`);
      } catch (err) {
        quickPlayBtn.style.opacity = "";
        console.error("[NCM] 快速播放歌单失败", err);
        showPlayerToast("获取歌单曲目失败");
      }
    };

    const chevron = document.createElement("span");
    chevron.className = "ncm-pl-chevron";
    chevron.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>';

    header.append(cover, info, quickPlayBtn, chevron);

    const body = document.createElement("div");
    body.className = "ncm-accordion-body";
    body.hidden = true;

    // 点击 Header 切换展开/折叠
    header.onclick = async () => {
      const isOpen = item.classList.contains("open");
      if (isOpen) {
        item.classList.remove("open");
        body.hidden = true;
      } else {
        item.classList.add("open");
        body.hidden = false;
        if (!body.dataset.loaded) {
          body.innerHTML = '<div class="ncm-drawer-loading">正在加载曲目...</div>';
          try {
            const songs = await fetchPlaylistTracks(pl.id, pl.trackCount);
            body.dataset.loaded = "true";
            body.innerHTML = "";
            const ul = document.createElement("ul");
            ul.className = "ncm-track-list";
            songs.forEach((song, sIdx) => {
              const row = createTrackRow(song, sIdx, () => {
                tracks = songs;
                queueTracks = songs;
                queueName = pl.name;
                rebuildQueueOrder(sIdx);
                playTrack(sIdx);
              });
              ul.appendChild(row);
            });
            body.appendChild(ul);
          } catch (err) {
            body.innerHTML = '<div class="ncm-drawer-loading" style="color:#fda4af">加载曲目失败</div>';
          }
        }
      }
    };

    item.append(header, body);
    container.appendChild(item);
  });
}

// ===== 3.2 收藏专辑 CD Case 陈列与浏览 =====
async function loadCollectedAlbums() {
  const grid = $("ncm-albums-grid");
  if (!grid) return;
  if (userAlbums.length) {
    renderAlbumsGrid();
    return;
  }
  grid.innerHTML = '<div class="ncm-drawer-loading">正在获取收藏专辑...</div>';
  try {
    const res = await api("/album/sublist", { limit: 100 });
    userAlbums = res.data || [];
    renderAlbumsGrid();
  } catch (err) {
    console.error("[NCM] 获取收藏专辑失败", err);
    grid.innerHTML = '<div class="ncm-drawer-loading" style="color:#fda4af">获取收藏专辑失败</div>';
  }
}

function createMiniCDCase(album, { showQuickPlay = true } = {}) {
  const caseWrap = document.createElement("div");
  caseWrap.className = "ncm-mini-cd-case";

  const caseBox = document.createElement("div");
  caseBox.className = "mini-case-box";

  const spine = document.createElement("div");
  spine.className = "mini-case-spine";

  const cover = document.createElement("img");
  cover.className = "mini-case-cover";
  cover.src = album.picUrl ? `${album.picUrl}?param=300y300` : "";
  cover.loading = "lazy";
  cover.alt = album.name;

  const sheen = document.createElement("div");
  sheen.className = "mini-case-sheen";

  caseBox.append(spine, cover, sheen);

  const disc = document.createElement("div");
  disc.className = "mini-case-disc";

  caseWrap.append(disc, caseBox);

  if (showQuickPlay) {
    const quickPlay = document.createElement("button");
    quickPlay.type = "button";
    quickPlay.className = "mini-album-quick-play";
    quickPlay.title = `播放专辑: ${album.name}`;
    quickPlay.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
    quickPlay.onclick = async (e) => {
      e.stopPropagation();
      try {
        quickPlay.style.opacity = "0.5";
        let songs = albumTracksCache.get(album.id);
        if (!songs) {
          const res = await api("/album", { id: album.id });
          songs = res.songs || [];
          albumTracksCache.set(album.id, songs);
        }
        quickPlay.style.opacity = "";
        if (!songs.length) {
          showPlayerToast("专辑内暂无可用曲目");
          return;
        }
        tracks = songs;
        queueTracks = songs;
        queueName = album.name;
        rebuildQueueOrder(0);
        playTrack(0);
        showPlayerToast(`已开始播放专辑: ${album.name} (${songs.length} 首)`);
      } catch (err) {
        quickPlay.style.opacity = "";
        console.error("[NCM] 播放专辑失败", err);
        showPlayerToast("获取专辑内容失败");
      }
    };
    caseWrap.appendChild(quickPlay);
  }

  return caseWrap;
}

const albumDetailView = $("ncm-album-detail-view");
const albumDetailBackBtn = $("ncm-album-detail-back");
const albumDetailCdWrap = $("ncm-album-detail-cd-wrap");
const albumDetailTitle = $("ncm-album-detail-title");
const albumDetailArtist = $("ncm-album-detail-artist");
const albumDetailMeta = $("ncm-album-detail-meta");
const albumDetailPlayAll = $("ncm-album-detail-play-all");
const albumDetailAddAll = $("ncm-album-detail-add-all");
const albumDetailTrackList = $("ncm-album-detail-track-list");

let currentActiveAlbum = null;

function closeAlbumDetail() {
  if (albumDetailView) albumDetailView.hidden = true;
  if (albumsView) albumsView.hidden = false;
  currentActiveAlbum = null;
}

if (albumDetailBackBtn) {
  albumDetailBackBtn.onclick = closeAlbumDetail;
}

async function openAlbumDetail(album) {
  if (!album || !albumDetailView) return;
  currentActiveAlbum = album;

  if (albumsView) albumsView.hidden = true;
  if (playlistsView) playlistsView.hidden = true;
  if (searchView) searchView.hidden = true;
  albumDetailView.hidden = false;

  const artistName = (album.artists || []).map(a => a.name).join(" / ") || album.artist?.name || "";
  if (albumDetailTitle) {
    albumDetailTitle.textContent = album.name;
    albumDetailTitle.title = album.name;
  }
  if (albumDetailArtist) {
    albumDetailArtist.textContent = artistName;
    albumDetailArtist.title = artistName;
  }
  if (albumDetailMeta) {
    albumDetailMeta.textContent = `共 ${album.size || 0} 首曲目`;
  }

  if (albumDetailCdWrap) {
    albumDetailCdWrap.innerHTML = "";
    albumDetailCdWrap.appendChild(createMiniCDCase(album, { showQuickPlay: false }));
  }

  if (albumDetailTrackList) {
    albumDetailTrackList.innerHTML = '<div class="ncm-drawer-loading">正在加载专辑曲目...</div>';
  }

  try {
    let songs = albumTracksCache.get(album.id);
    if (!songs) {
      const res = await api("/album", { id: album.id });
      songs = res.songs || [];
      albumTracksCache.set(album.id, songs);
    }

    if (currentActiveAlbum?.id !== album.id) return;

    if (albumDetailMeta) {
      albumDetailMeta.textContent = `共 ${songs.length} 首曲目`;
    }

    if (albumDetailPlayAll) {
      albumDetailPlayAll.onclick = () => {
        if (!songs.length) {
          showPlayerToast("专辑内暂无可用曲目");
          return;
        }
        tracks = songs;
        queueTracks = songs;
        queueName = album.name;
        rebuildQueueOrder(0);
        playTrack(0);
        showPlayerToast(`已开始播放专辑: ${album.name}`);
      };
    }

    if (albumDetailAddAll) {
      albumDetailAddAll.onclick = () => {
        if (!songs.length) return;
        const insertIdx = currentIdx >= 0 ? currentIdx + 1 : 0;
        queueTracks.splice(insertIdx, 0, ...songs);
        rebuildQueueOrder(currentIdx);
        renderQueue();
        showPlayerToast(`已将 ${songs.length} 首曲目加入播放列表`);
      };
    }

    if (albumDetailTrackList) {
      albumDetailTrackList.innerHTML = "";
      if (!songs.length) {
        albumDetailTrackList.innerHTML = '<div class="ncm-drawer-loading">专辑内暂无可用曲目</div>';
        return;
      }
      songs.forEach((song, sIdx) => {
        const row = createTrackRow(song, sIdx, () => {
          tracks = songs;
          queueTracks = songs;
          queueName = album.name;
          rebuildQueueOrder(sIdx);
          playTrack(sIdx);
        });
        albumDetailTrackList.appendChild(row);
      });
    }
  } catch (err) {
    console.error("[NCM] 加载专辑曲目失败", err);
    if (albumDetailTrackList) {
      albumDetailTrackList.innerHTML = '<div class="ncm-drawer-loading" style="color:#fda4af">加载专辑曲目失败</div>';
    }
  }
}

function renderAlbumsGrid() {
  const grid = $("ncm-albums-grid");
  if (!grid) return;
  if (!userAlbums.length) {
    grid.innerHTML = '<div class="ncm-drawer-loading">暂无收藏专辑</div>';
    return;
  }
  grid.innerHTML = "";

  userAlbums.forEach((album) => {
    const card = document.createElement("div");
    card.className = "ncm-album-card";
    card.dataset.albumId = album.id;

    const caseWrap = createMiniCDCase(album, { showQuickPlay: true });

    const info = document.createElement("div");
    info.className = "ncm-album-info";

    const titleEl = document.createElement("span");
    titleEl.className = "ncm-album-title";
    titleEl.textContent = album.name;
    titleEl.title = album.name;

    const artistEl = document.createElement("span");
    artistEl.className = "ncm-album-artist";
    const artistName = (album.artists || []).map(a => a.name).join(" / ") || album.artist?.name || "";
    artistEl.textContent = artistName;
    artistEl.title = artistName;

    const metaEl = document.createElement("span");
    metaEl.className = "ncm-album-meta";
    metaEl.textContent = `${album.size || 0} 首`;

    info.append(titleEl, artistEl, metaEl);
    card.append(caseWrap, info);

    // 点击卡片直接进入美观流畅的专辑曲目详情视图
    card.onclick = () => {
      openAlbumDetail(album);
    };

    grid.appendChild(card);
  });
}

// ===== 3.3 歌单内曲目即时搜索功能 =====
const searchInput = $("ncm-drawer-search");
const searchClearBtn = $("ncm-drawer-search-clear");
const searchView = $("ncm-search-view");
const playlistsView = $("ncm-playlists-view");
const albumsView = $("ncm-albums-view");
const searchSummary = $("ncm-search-summary");
const searchTrackList = $("ncm-search-track-list");

function performDrawerSearch(keyword) {
  const query = (keyword || "").trim().toLowerCase();
  if (!query) {
    if (searchClearBtn) searchClearBtn.hidden = true;
    if (searchView) searchView.hidden = true;
    if (albumDetailView) albumDetailView.hidden = true;
    if (currentActiveDrawerTab === "playlists") {
      if (playlistsView) playlistsView.hidden = false;
      if (albumsView) albumsView.hidden = true;
    } else {
      if (playlistsView) playlistsView.hidden = true;
      if (albumsView) albumsView.hidden = false;
    }
    return;
  }

  if (searchClearBtn) searchClearBtn.hidden = false;
  if (playlistsView) playlistsView.hidden = true;
  if (albumsView) albumsView.hidden = true;
  if (albumDetailView) albumDetailView.hidden = true;
  if (searchView) searchView.hidden = false;

  // 汇集当前已加载的所有曲目（歌单缓存、专辑缓存、当前列表、播放队列）进行全文即时匹配
  const seenIds = new Set();
  const pool = [];
  function addSongs(list) {
    if (!list || !Array.isArray(list)) return;
    for (const song of list) {
      if (song && song.id && !seenIds.has(song.id)) {
        seenIds.add(song.id);
        pool.push(song);
      }
    }
  }
  addSongs(tracks);
  addSongs(queueTracks);
  for (const songs of playlistTracksCache.values()) addSongs(songs);
  for (const songs of albumTracksCache.values()) addSongs(songs);

  const matched = pool.filter(song => {
    const titleMatch = (song.name || "").toLowerCase().includes(query);
    const artistMatch = (song.ar || []).some(a => (a.name || "").toLowerCase().includes(query));
    const albumMatch = (song.al?.name || "").toLowerCase().includes(query);
    return titleMatch || artistMatch || albumMatch;
  });

  if (searchSummary) {
    searchSummary.textContent = `搜索 “${keyword}”：找到 ${matched.length} 首匹配曲目`;
  }
  if (!searchTrackList) return;
  searchTrackList.innerHTML = "";

  if (!matched.length) {
    searchTrackList.innerHTML = '<li class="ncm-drawer-loading">未在已加载列表中找到曲目（展开歌单或专辑可加载更多曲目）</li>';
    return;
  }

  matched.forEach((song, mIdx) => {
    const row = createTrackRow(song, mIdx, (targetSong) => {
      // 搜索模式下点击播放会将单曲加入到当前播放列表并立即播放
      const existingIdx = queueTracks.findIndex(s => s.id === targetSong.id);
      if (existingIdx >= 0) {
        playTrack(existingIdx);
      } else {
        const nextIdx = currentIdx >= 0 ? currentIdx + 1 : 0;
        queueTracks.splice(nextIdx, 0, targetSong);
        rebuildQueueOrder(nextIdx);
        playTrack(nextIdx);
      }
      showPlayerToast(`已加入播放列表并播放: ${targetSong.name}`);
    });
    searchTrackList.appendChild(row);
  });
}

if (searchInput) {
  searchInput.addEventListener("input", (e) => {
    performDrawerSearch(e.target.value);
  });
}
if (searchClearBtn) {
  searchClearBtn.onclick = () => {
    if (searchInput) searchInput.value = "";
    performDrawerSearch("");
    searchInput?.focus();
  };
}

// ===== 3.4 抽屉顶部标签切换（我的歌单 / 收藏专辑） =====
const tabPlaylists = $("ncm-tab-playlists");
const tabAlbums = $("ncm-tab-albums");

if (tabPlaylists) {
  tabPlaylists.onclick = () => {
    currentActiveDrawerTab = "playlists";
    closeAlbumDetail();
    tabPlaylists.classList.add("active");
    tabPlaylists.setAttribute("aria-selected", "true");
    tabAlbums?.classList.remove("active");
    tabAlbums?.setAttribute("aria-selected", "false");
    if (searchInput && searchInput.value.trim()) {
      performDrawerSearch(searchInput.value);
    } else {
      if (playlistsView) playlistsView.hidden = false;
      if (albumsView) albumsView.hidden = true;
      if (searchView) searchView.hidden = true;
    }
  };
}

if (tabAlbums) {
  tabAlbums.onclick = () => {
    currentActiveDrawerTab = "albums";
    closeAlbumDetail();
    tabAlbums.classList.add("active");
    tabAlbums.setAttribute("aria-selected", "true");
    tabPlaylists?.classList.remove("active");
    tabPlaylists?.setAttribute("aria-selected", "false");
    if (searchInput && searchInput.value.trim()) {
      performDrawerSearch(searchInput.value);
    } else {
      if (playlistsView) playlistsView.hidden = true;
      if (albumsView) albumsView.hidden = false;
      if (searchView) searchView.hidden = true;
    }
    loadCollectedAlbums();
  };
}

const trackList = $("ncm-track-list");
const queueList = $("ncm-queue-list");
const queueDialog = $("ncm-queue");
const orderControl = $("ncm-order");
const savedOrder = localStorage.getItem("ncm_order");
const orderModes = ["sequential", "loop", "repeat", "shuffle"];
orderControl.value = orderModes.includes(savedOrder) ? savedOrder : "loop";
let activeQueueButton;
let activeTrackButton;

function replaceTrackRows(list, songs, indices) {
  const rows = document.createDocumentFragment();
  indices.forEach((index, position) => {
    const song = songs[index];
    const row = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ncm-track";
    button.dataset.index = index;

    const number = document.createElement("span");
    number.className = "ncm-track-number";
    number.textContent = position + 1;

    const info = document.createElement("span");
    const title = document.createElement("span");
    title.className = "ncm-track-title";
    title.textContent = song.name;
    const artist = document.createElement("span");
    artist.className = "ncm-track-artist";
    artist.textContent = (song.ar || []).map(item => item.name).join(" / ");
    button.title = artist.textContent ? `${song.name} - ${artist.textContent}` : song.name;
    info.append(title, artist);
    button.append(number, info);
    row.append(button);
    rows.append(row);
  });
  list.replaceChildren(rows);
}

function renderTracks() {
  replaceTrackRows(trackList, tracks, tracks.map((_, index) => index));
  updateActiveTrack();
}

function renderQueue() {
  replaceTrackRows(queueList, queueTracks, queueOrder);
  $("ncm-queue-empty").hidden = queueTracks.length > 0;
  $("ncm-queue-summary").textContent = queueTracks.length ? `${queueName} · ${queueTracks.length} 首` : "";
  updateActiveTrack();
}

function updateActiveTrack() {
  activeTrackButton?.removeAttribute("aria-current");
  activeQueueButton?.removeAttribute("aria-current");
  activeTrackButton = tracks === queueTracks ? trackList.children[currentIdx]?.firstElementChild : null;
  activeQueueButton = queueList.children[queueOrder.indexOf(currentIdx)]?.firstElementChild;
  activeTrackButton?.setAttribute("aria-current", "true");
  activeQueueButton?.setAttribute("aria-current", "true");
  if (!$("ncm-drawer").inert) activeTrackButton?.scrollIntoView({ block: "nearest" });
  if (queueDialog.open) activeQueueButton?.scrollIntoView({ block: "nearest" });
}

function rebuildQueueOrder(startIndex) {
  queueOrder = queueTracks.map((_, index) => index);
  if (orderControl.value === "shuffle" && queueOrder.length) {
    queueOrder = queueOrder.filter(index => index !== startIndex);
    for (let position = queueOrder.length - 1; position > 0; position--) {
      const other = Math.floor(Math.random() * (position + 1));
      [queueOrder[position], queueOrder[other]] = [queueOrder[other], queueOrder[position]];
    }
    if (startIndex >= 0) queueOrder.unshift(startIndex);
  }
  renderQueue();
}

trackList.addEventListener("click", event => {
  const button = event.target.closest("button[data-index]");
  if (!button) return;
  const index = Number(button.dataset.index);
  if (tracks !== queueTracks) {
    queueTracks = tracks;
    queueName = $("ncm-playlist-select").selectedOptions[0]?.textContent.replace(/ ?\(\d+\)$/, "") || "";
    currentIdx = -1;
    rebuildQueueOrder(index);
  }
  playTrack(index);
});

queueList.addEventListener("click", event => {
  const button = event.target.closest("button[data-index]");
  if (button) playTrack(Number(button.dataset.index));
});

queueList.addEventListener("contextmenu", event => {
  const button = event.target.closest("button[data-index]");
  if (!button) return;
  const song = queueTracks[Number(button.dataset.index)];
  if (song) showContextMenu(event, song);
});

orderControl.onchange = () => {
  localStorage.setItem("ncm_order", orderControl.value);
  rebuildQueueOrder(currentIdx);
};
$("ncm-queue-open").onclick = (e) => {
  e.stopPropagation();
  if (queueDialog.open) {
    queueDialog.close();
  } else {
    queueDialog.showModal();
    activeQueueButton?.scrollIntoView({ block: "nearest" });
  }
};
if ($("ncm-queue-close")) {
  $("ncm-queue-close").onclick = () => queueDialog.close();
}
queueDialog.addEventListener("close", () => $("ncm-queue-open")?.focus());

// 点击任意其他地方自动关闭播放列表
queueDialog.addEventListener("pointerdown", (e) => {
  const rect = queueDialog.getBoundingClientRect();
  const isInDialog = (
    rect.top <= e.clientY && e.clientY <= rect.top + rect.height &&
    rect.left <= e.clientX && e.clientX <= rect.left + rect.width
  );
  if (!isInDialog) {
    queueDialog.close();
  }
});

window.addEventListener("pointerdown", (e) => {
  if (!queueDialog?.open) return;
  if (e.target.closest("#ncm-queue") || e.target.closest("#ncm-queue-open")) {
    return;
  }
  queueDialog.close();
}, true);

function setControlsHidden(hidden, focus = false) {
  $("ncm-controls").hidden = hidden;
  $("ncm-show-controls").hidden = !hidden;
  document.body.classList.toggle("ncm-controls-hidden", hidden);
  if (focus) $(hidden ? "ncm-show-controls" : "ncm-hide-controls").focus();
}
$("ncm-hide-controls").onclick = () => {
  localStorage.setItem("ncm_controls_hidden", "true");
  setControlsHidden(true, true);
};
$("ncm-show-controls").onclick = () => {
  localStorage.removeItem("ncm_controls_hidden");
  setControlsHidden(false, true);
};
setControlsHidden(localStorage.getItem("ncm_controls_hidden") === "true");

// ===== 4. 播放指定曲目（核心流程） =====
const playbackError = (id, category, detail) =>
  new Error(`${category}（曲目 ${id}）${detail ? "：" + detail : ""}`);

const availableLevels = ["jymaster", "sky", "vivid", "jyeffect", "hires", "lossless", "exhigh", "higher", "standard"];
const unavailableCodes = [301, 401, 403, 404, 451, -200, -110];

function formatAudioQualityLabel(level, format, bitrate, stereoAAC) {
  if (stereoAAC && level === "sky") return "沉浸全景声 · AAC";
  const fmt = (format || "").toUpperCase();
  switch (level) {
    case "jymaster":
      return "超清母带" + (fmt ? ` · ${fmt}` : "");
    case "sky":
      return "沉浸全景声";
    case "vivid":
      return "臻品全景声";
    case "jyeffect":
      return "高清环绕声";
    case "hires":
      return "Hi-Res" + (bitrate ? ` · ${Math.round(bitrate / 1000)}K` : "");
    case "lossless":
      return fmt === "FLAC" ? "无损 FLAC" : (fmt ? `无损 · ${fmt}` : "无损音质");
    case "exhigh":
      return "极高 320K";
    case "higher":
      return "较高 192K";
    case "standard":
      return "标准 128K";
    default:
      if (bitrate >= 500000) return (fmt ? `${fmt} ` : "无损 ") + Math.round(bitrate / 1000) + "K";
      if (bitrate >= 300000) return "极高 320K";
      if (bitrate >= 180000) return "较高 192K";
      if (bitrate > 0) return "标准 " + Math.round(bitrate / 1000) + "K";
      return qualityNames.get(level) || level || "";
  }
}

async function requestAudio(id, signal, level) {
  const route = level ? "/song/url/v1" : "/song/url";
  const stereoAAC = level === "sky-aac";
  const query = stereoAAC ? { id, level: "sky", immerseType: "aac2" } :
    level ? { id, level } : { id, br: 999000, crypto: "weapi" };
  try {
    const response = await api(route, { ...query, timeout: 5500 }, { signal });
    const row = Array.isArray(response?.data) &&
      response.data.find(item => String(item?.id) === String(id));
    const code = Number(row?.code ?? response?.code);
    if (unavailableCodes.includes(code)) return { unavailable: true, code };
    if (!row?.url) return { diagnostic: "未返回可用音源" };

    const parsed = new URL(row.url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      return { diagnostic: "接口返回了无效的音频地址" };
    }
    const bitrate = Number(row.br) || 0;
    return {
      url: parsed.href,
      preview: Boolean(row.freeTrialInfo),
      quality: row.level,
      format: row.type,
      bitrate,
      label: formatAudioQualityLabel(row.level, row.type, bitrate, stereoAAC),
    };
  } catch (error) {
    if (signal.aborted) throw error;
    if ([301, 401, 403, 451].includes(error.upstreamCode)) {
      return { unavailable: true, code: error.upstreamCode };
    }
    return { diagnostic: error.message };
  }
}

function sourceRank(source) {
  const index = availableLevels.indexOf(source.quality);
  return index < 0 ? Infinity : index;
}

async function resolveAudio(id, signal, preferred, skipped, requests) {
  function lookup(level) {
    if (!requests.has(level)) requests.set(level, requestAudio(id, signal, level));
    return requests.get(level);
  }

  if (preferred !== "highest") {
    const requested = await lookup(preferred);
    if (requested.url || requested.unavailable) return requested;
    // 首选音质不可用时，按音质阶梯向下一级级优雅尝试
    const prefIdx = availableLevels.indexOf(preferred);
    const fallbacks = prefIdx >= 0 ? availableLevels.slice(prefIdx + 1) : availableLevels;
    for (const lvl of fallbacks) {
      const cand = await lookup(lvl);
      if (cand.url) return cand;
    }
    const legacy = await lookup();
    if (legacy.url || legacy.unavailable) return legacy;
    throw playbackError(id, "取音源失败", requested.diagnostic + "；" + legacy.diagnostic);
  }

  let best, preview, denied, diagnostic;
  for (let offset = 0; offset < availableLevels.length; offset += 2) {
    const levels = availableLevels.slice(offset, offset + 2);
    if (levels.includes("sky")) levels.push("sky-aac");
    const candidates = await Promise.all(levels.map(lookup));
    const sessionFailure = candidates.find(item => [301, 401, 451].includes(item.code));
    if (sessionFailure) return sessionFailure;
    for (const candidate of candidates) {
      if (candidate.unavailable) denied = candidate;
      else if (!candidate.url) diagnostic ??= candidate.diagnostic;
      else if (skipped.has(candidate.url)) continue;
      else if (candidate.preview) {
        if (!preview || sourceRank(candidate) < sourceRank(preview)) preview = candidate;
      } else if (!best || sourceRank(candidate) < sourceRank(best) ||
          (sourceRank(candidate) === sourceRank(best) && candidate.bitrate > best.bitrate)) {
        best = candidate;
      }
    }
    if (best && sourceRank(best) <= offset + 1) return best;
  }
  if (best) return best;
  if (!denied || skipped.size) {
    const legacy = await lookup();
    if (legacy.url && !skipped.has(legacy.url)) {
      if (!legacy.preview) return legacy;
      preview ??= legacy;
    }
    if (legacy.unavailable && !preview) return legacy;
    diagnostic ??= legacy.diagnostic;
  }
  if (preview) return preview;
  if (denied) return denied;
  throw playbackError(id, "取音源失败", diagnostic);
}

function startMedia(url, signal, timeout = 10000) {
  const wait = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
  return new Promise((resolve, reject) => {
    function cleanup() {
      audio.removeEventListener("error", mediaFailed);
      wait.removeEventListener("abort", interrupted);
    }
    function mediaFailed() {
      if (!audio.error) return;
      cleanup();
      reject(new Error("MediaError " + audio.error.code));
    }
    function interrupted() {
      cleanup();
      reject(wait.reason);
    }

    if (wait.aborted) return interrupted();
    wait.addEventListener("abort", interrupted, { once: true });
    audio.addEventListener("error", mediaFailed);
    audio.src = url;
    audio.play().then(() => {
      cleanup();
      resolve();
    }, error => {
      cleanup();
      reject(audio.error ? new Error("MediaError " + audio.error.code) : error);
    });
  });
}

const desktopAudio = window.CDCaseAudio;
let streamToken = null;
function clearMedia() {
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  if (streamToken) desktopAudio?.close(streamToken).catch(() => {});
  streamToken = null;
}

async function playDesktopStream(source, signal) {
  const stream = await desktopAudio?.open(source.url, source.format).catch(() => null);
  if (!stream) return false;
  if (signal.aborted) {
    desktopAudio.close(stream.token).catch(() => {});
    throw signal.reason;
  }
  streamToken = stream.token;
  try {
    await startMedia(stream.url, signal, 22000);
    return true;
  } catch (error) {
    if (signal.aborted || error.name === "NotAllowedError") throw error;
    const reason = await desktopAudio.error(stream.token).catch(() => "");
    signal.throwIfAborted();
    if (reason) throw new Error(reason);
    if (error.message === "MediaError 4" || error.name === "NotSupportedError") {
      const codec = await desktopAudio.codec(stream.token).catch(() => "");
      signal.throwIfAborted();
      if (codec === "AV3A" || codec === "AV3V") {
        setPlayerStatus("正在准备 " + codec + " 全景声音轨…");
        const result = await desktopAudio.decode(stream.token);
        signal.throwIfAborted();
        if (!result.url) throw new Error(result.error || (codec + " 解码失败"));
        await startMedia(result.url, signal, 10000);
        source.label = (source.label || codec) + " · 立体声";
        return true;
      }
      throw new Error("播放器无法解码或识别该音轨");
    }
    throw new Error(error.name === "TimeoutError" ? "流式播放启动超时" :
      error.message.startsWith("MediaError ") ? "流式播放 " + error.message : "流式播放 " + error.name);
  }
}

async function playMediaSource(source, signal) {
  const streamFirst = ["vivid", "sky", "jyeffect"].includes(source.quality);
  if (streamFirst && await playDesktopStream(source, signal)) return;
  try {
    await startMedia(source.url, signal);
  } catch (directError) {
    if (signal.aborted || streamFirst || directError.name === "NotAllowedError") throw directError;
    const retryable = ["MediaError 2", "MediaError 3", "MediaError 4"].includes(directError.message) ||
      ["NotSupportedError", "TimeoutError"].includes(directError.name);
    if (!retryable) throw directError;
    clearMedia();
    if (!(await playDesktopStream(source, signal))) throw directError;
  }
}

async function startBestAudio(id, preferred, signal, onAttempt) {
  const skipped = new Set();
  const requests = new Map();
  const failures = [];
  const exhausted = () => playbackError(id, "可用音源均未能播放", failures.join("；"));
  for (;;) {
    let source;
    try {
      source = await resolveAudio(id, signal, preferred, skipped, requests);
    } catch (error) {
      throw failures.length && !signal.aborted ? exhausted() : error;
    }
    if (source.unavailable) {
      if (failures.length && ![301, 401, 451].includes(source.code)) throw exhausted();
      return source;
    }
    signal.throwIfAborted();
    onAttempt(skipped.size > 0);
    try {
      await playMediaSource(source, signal);
      return { ...source, failures };
    } catch (error) {
      if (signal.aborted) throw error;
      if (error.name === "NotAllowedError") return { ...source, needsClick: true, failures };
      const detail = error.name === "TimeoutError" ? "加载超时" :
        error.name === "Error" ? error.message : error.name;
      failures.push([source.label, detail].filter(Boolean).join(" "));
      clearMedia();
      if (preferred !== "highest") {
        throw playbackError(id, "已取得音源，音频播放失败", detail);
      }
      skipped.add(source.url);
    }
  }
}

async function requestFullLyrics(songId, signal) {
  try {
    const res = await api("/lyric/new", { id: songId, timeout: 6000 }, { signal });
    if (res && (res.yrc?.lyric || res.lrc?.lyric)) {
      return {
        yrc: res.yrc?.lyric || "",
        lrc: res.lrc?.lyric || "",
        tlyric: res.ytlrc?.lyric || res.tlyric?.lyric || "",
        romalrc: res.yromalrc?.lyric || res.romalrc?.lyric || "",
      };
    }
  } catch (e) {
    if (signal?.aborted) throw e;
  }
  try {
    const res = await api("/lyric", { id: songId, timeout: 6000 }, { signal });
    return {
      yrc: res.yrc?.lyric || "",
      lrc: res.lrc?.lyric || "",
      tlyric: res.tlyric?.lyric || "",
      romalrc: res.romalrc?.lyric || "",
    };
  } catch (e) {
    return { yrc: "", lrc: "", tlyric: "", romalrc: "" };
  }
}

function updateFocusCover(song) {
  const coverImg = $("amll-focus-cover-img");
  const titleEl = $("amll-focus-title");
  const artistEl = $("amll-focus-artist");
  const albumEl = $("amll-focus-album");
  const bgArt = $("amll-focus-bg-art");
  const badgeEl = $("amll-focus-badge");
  if (!song) {
    if (coverImg) coverImg.src = "";
    if (titleEl) titleEl.textContent = "";
    if (artistEl) artistEl.textContent = "";
    if (albumEl) albumEl.textContent = "";
    if (bgArt) bgArt.style.backgroundImage = "";
    if (badgeEl) { badgeEl.textContent = ""; badgeEl.hidden = true; }
    return;
  }
  const artist = (song.ar || []).map(a => a.name).join(" / ");
  const albumTitle = song.al?.name || song.name || "";
  const coverUrl = song.al?.picUrl ? `${song.al.picUrl}?param=800y800` : "";
  if (coverImg) coverImg.src = coverUrl;
  if (titleEl) titleEl.textContent = song.name || "未知曲目";
  if (artistEl) artistEl.textContent = artist || "未知歌手";
  if (albumEl) albumEl.textContent = albumTitle || "";
  if (bgArt) bgArt.style.backgroundImage = coverUrl ? `url("${coverUrl}")` : "";
}

let playbackLookup;
let sourceReady = false;
let pendingPlayback = null;
async function playTrack(idx) {
  if (idx < 0 || idx >= queueTracks.length) return;
  playbackLookup?.abort();
  const controller = new AbortController();
  playbackLookup = controller;
  const { signal } = controller;
  currentIdx = idx;
  updateActiveTrack();

  sourceReady = false;
  pendingPlayback = null;
  clearMedia();
  lyrics = [];
  window.AMLLPlayer?.reset();
  updateFocusCover(null);
  $("ncm-time-cur").textContent = $("ncm-time-tot").textContent = "00:00";
  const fc = $("amll-focus-time-cur"), ft = $("amll-focus-time-tot"), fp = $("amll-focus-progress");
  if (fc) fc.textContent = "00:00";
  if (ft) ft.textContent = "00:00";
  if (fp) updateSlider(fp, 0);
  $("ncm-time-tot").title = "";
  updateSlider($("ncm-progress"), 0);
  $("ncm-quality-now").hidden = true;
  setPlayingAppearance(false);
  setPlayerStatus("正在获取音源…");
  const bridge = window.CDCaseBridge;
  bridge.setPlaybackState(false);
  // Resume the frequency analyser in the click handler, before waiting on the network.
  try { bridge.bindAudio(audio); } catch (error) { console.warn("[NCM] 频谱初始化失败", error.name); }

  const song = queueTracks[idx];
  const artist = (song.ar || []).map(a => a.name).join(" / ");
  const albumTitle = song.al?.name || song.name;
  const coverUrl = song.al?.picUrl ? `${song.al.picUrl}?param=800y800` : "";
  updateFocusCover(song);
  bridge.updateTrack({ title: song.name, artist, albumTitle, coverUrl });
  if (coverUrl) extractAndApplyDualAccents(coverUrl);

  const preferred = quality.value;
  const lyricsRequest = requestFullLyrics(song.id, signal);
  try {
    const source = await startBestAudio(song.id, preferred, signal, retrying => {
      setPlayerStatus(retrying ? "正在尝试下一档可用音质…" : "正在加载音频…");
    });
    if (signal.aborted) return;
    if (source.unavailable) {
      const explanation = [301, 401].includes(source.code)
        ? "网易云要求重新验证当前会话"
        : "网易云未授予该曲目的播放权限或曲目不可用";
      setPlayerStatus(playbackError(song.id, explanation, "状态 " + source.code).message, true);
      return;
    }
    sourceReady = true;
    const confirmStarted = async () => {
      $("ncm-time-tot").title = source.preview ? "网易云试听" : "";
      const qualityLabel = $("ncm-quality-now");
      qualityLabel.textContent = source.label;
      qualityLabel.hidden = !source.label;
      qualityLabel.style.color = "";
      const focusBadge = $("amll-focus-badge");
      if (focusBadge) {
        focusBadge.textContent = source.label || "";
        focusBadge.hidden = !source.label;
      }
      qualityLabel.title = source.failures?.length ?
        "未能启动的音源：" + source.failures.join("；") :
        preferred === "highest" && source.quality !== availableLevels[0] ?
          "网易云未返回更高档的可用完整音源" : "";
      setPlayingAppearance(true);
      bridge.setPlaybackState(true);
      window.AMLLPlayer?.resume();
      const result = await lyricsRequest;
      if (!signal.aborted && !audio.error) {
        window.AMLLPlayer?.setLyrics(result);
      }
    };
    if (source.needsClick) {
      pendingPlayback = confirmStarted;
      setPlayerStatus("已取得音源，点一下播放键继续");
    } else {
      await confirmStarted();
    }
  } catch (error) {
    if (!signal.aborted) setPlayerStatus(error.message, true);
  }
}

function stepQueue(direction) {
  if (!queueOrder.length) return false;
  const position = queueOrder.indexOf(currentIdx);
  let next = position === -1 && direction < 0 ? queueOrder.length - 1 : position + direction;
  if (next < 0 || next >= queueOrder.length) {
    if (orderControl.value === "sequential") return false;
    next = (next + queueOrder.length) % queueOrder.length;
  }
  playTrack(queueOrder[next]);
  return true;
}

function playNextTrack() {
  stepQueue(1);
}
function playPrevTrack() {
  if (!queueTracks.length) return;
  if (audio.currentTime > 3) audio.currentTime = 0;
  else stepQueue(-1);
}

// ===== 5. 歌词解析（由 AMLL 引擎统一接管） =====


// ===== 6. 播放器控件事件 =====

// 播放/暂停
function resumeAudio() {
  const request = playbackLookup;
  window.CDCaseBridge?.bindAudio(audio);
  audio.play().then(() => {
    if (request !== playbackLookup || request?.signal.aborted || audio.paused) return;
    if (pendingPlayback) {
      const confirm = pendingPlayback;
      pendingPlayback = null;
      return confirm();
    }
    setPlayingAppearance(true);
    window.CDCaseBridge?.setPlaybackState(true);
    window.AMLLPlayer?.resume();
  }).catch(console.error);
}

function togglePlayPause() {
  if (!sourceReady || !audio.src) {
    if (queueTracks.length) {
      playTrack(currentIdx >= 0 ? currentIdx : 0);
    }
    return;
  }
  if (audio.paused || audio.ended) {
    resumeAudio();
  } else {
    audio.pause();
    window.AMLLPlayer?.pause();
    setPlayingAppearance(false);
    window.CDCaseBridge?.setPlaybackState(false);
  }
}

// 统一监听底层 HTML5 Audio 事件作为状态单一事实来源，确保快捷键、系统托盘、GUI 按钮 100% 同步
audio.addEventListener("play", () => {
  setPlayingAppearance(true);
  window.CDCaseBridge?.setPlaybackState(true);
  window.AMLLPlayer?.resume();
});
audio.addEventListener("pause", () => {
  setPlayingAppearance(false);
  window.CDCaseBridge?.setPlaybackState(false);
  window.AMLLPlayer?.pause();
});

playButton.onclick = togglePlayPause;

// 上一首 / 下一首
$("ncm-prev").onclick = playPrevTrack;
$("ncm-next").onclick = playNextTrack;

// 进度条拖动
$("ncm-progress").oninput = (e) => {
  updateSlider(e.target, e.target.value);
  if (audio.duration) {
    audio.currentTime = (e.target.value / 100) * audio.duration;
    window.AMLLPlayer?.seek(audio.currentTime);
    const fp = $("amll-focus-progress");
    if (fp) updateSlider(fp, e.target.value);
  }
};

// 聚焦模式进度条拖动联动
const focusProgress = $("amll-focus-progress");
if (focusProgress) {
  focusProgress.oninput = (e) => {
    updateSlider(e.target, e.target.value);
    if (audio.duration) {
      audio.currentTime = (e.target.value / 100) * audio.duration;
      window.AMLLPlayer?.seek(audio.currentTime);
      updateSlider($("ncm-progress"), e.target.value);
    }
  };
}

// ===== 音量控制与记忆持久化 =====
let volumeToastTimer = null;
function showVolumeToast(percent) {
  const toast = $("ncm-volume-toast");
  const text = $("ncm-volume-toast-text");
  if (!toast || !text) return;
  text.textContent = `音量 ${percent}%`;
  toast.hidden = false;
  clearTimeout(volumeToastTimer);
  volumeToastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 1200);
}

function setPlayerVolume(val, showToast = false) {
  const clamped = Math.max(0, Math.min(1, Math.round(val * 100) / 100));
  audio.volume = clamped;
  const volSlider = $("ncm-volume");
  if (volSlider) {
    volSlider.value = clamped;
    updateSlider(volSlider, clamped);
  }
  try {
    localStorage.setItem("ncm_volume", String(clamped));
  } catch (err) {}
  if (showToast) {
    showVolumeToast(Math.round(clamped * 100));
  }
}

const savedVolStr = localStorage.getItem("ncm_volume");
const initVol = (savedVolStr !== null && !isNaN(Number(savedVolStr)))
  ? Math.max(0, Math.min(1, Number(savedVolStr)))
  : 0.7;
setPlayerVolume(initVol, false);

$("ncm-volume").oninput = (e) => {
  setPlayerVolume(Number(e.target.value), false);
};

// 播放时间更新
audio.ontimeupdate = () => {
  const curFmt = fmt(audio.currentTime);
  const totFmt = fmt(audio.duration);
  $("ncm-time-cur").textContent = curFmt;
  $("ncm-time-tot").textContent = totFmt;
  const fc = $("amll-focus-time-cur"), ft = $("amll-focus-time-tot"), fp = $("amll-focus-progress");
  if (fc) fc.textContent = curFmt;
  if (ft) ft.textContent = totFmt;
  if (audio.duration) {
    const pct = (audio.currentTime / audio.duration) * 100;
    updateSlider($("ncm-progress"), pct);
    if (fp) updateSlider(fp, pct);
  }
};

// 播放完毕自动下一首
audio.onended = () => {
  if (orderControl.value === "repeat" && sourceReady) {
    audio.currentTime = 0;
    resumeAudio();
  } else if (!stepQueue(1)) {
    setPlayingAppearance(false);
    window.CDCaseBridge.setPlaybackState(false);
  }
};

// 音频加载错误（如 URL 失效）
audio.onerror = () => {
  if (!sourceReady || !audio.error || !queueTracks[currentIdx]) return;
  setPlayingAppearance(false);
  window.CDCaseBridge.setPlaybackState(false);
  setPlayerStatus(playbackError(queueTracks[currentIdx].id,
    "已取得音源，音频加载失败", "媒体错误 " + audio.error.code).message, true);
};

// ===== 7. 登录 / 歌单抽屉 UI 事件 =====
$("ncm-btn-login").onclick = openQrLogin;
$("ncm-qr-refresh").onclick = openQrLogin;
$("ncm-qr-close").onclick = () => {
  qrGeneration++;
  clearInterval(qrTimer);
  $("ncm-qr-modal").classList.add("hidden");
};

const drawer = $("ncm-drawer");
const drawerToggle = $("ncm-btn-drawer");
const drawerClose = $("ncm-drawer-close");
const drawerBackdrop = $("ncm-drawer-backdrop");

function setDrawerOpen(open) {
  drawer.classList.toggle("closed", !open);
  drawer.inert = !open;
  drawerBackdrop.hidden = !open;
  document.body.classList.toggle("ncm-drawer-open", open);
  drawerToggle.setAttribute("aria-expanded", String(open));
  if (open) {
    drawerClose.focus({ preventScroll: true });
    activeTrackButton?.scrollIntoView({ block: "nearest" });
  } else {
    drawerToggle.focus({ preventScroll: true });
  }
}

drawerToggle.onclick = () => setDrawerOpen(drawer.inert);
drawerClose.onclick = drawerBackdrop.onclick = () => setDrawerOpen(false);

$("ncm-playlist-select").onchange = (e) => {
  if (e.target.value) loadPlaylist(e.target.value);
};

const settings = $("ncm-settings");
const settingsStatus = $("ncm-settings-status");
const cacheControls = [$("ncm-cache-choose"), $("ncm-cache-reset"), $("ncm-cache-open")].filter(Boolean);
const desktop = window.CDCaseSettings;

function refreshAccountSetting() {
  $("ncm-settings-account").textContent = $("ncm-user").textContent;
  $("ncm-logout").disabled = !cookie;
}

async function updateCacheDirectory(operation) {
  for (const button of cacheControls) button.disabled = true;
  try {
    const directory = await operation();
    if (directory) $("ncm-cache-path").textContent = directory;
  } catch {
    settingsStatus.textContent = "无法使用该缓存位置，请检查文件夹权限。";
  } finally {
    for (const button of cacheControls) button.disabled = !desktop;
  }
}

async function updateDecoder(operation) {
  const buttons = [$("ncm-decoder-choose"), $("ncm-decoder-clear")];
  for (const button of buttons) button.disabled = true;
  try {
    const executable = await operation();
    if (executable !== null) $("ncm-decoder-status").textContent = executable || "未配置";
  } catch {
    settingsStatus.textContent = "无法读取或保存 AV3A 解码器设置。";
  } finally {
    for (const button of buttons) button.disabled = !desktopAudio;
  }
}

$("ncm-decoder-choose").onclick = () => updateDecoder(desktopAudio.chooseDecoder);
$("ncm-decoder-clear").onclick = () => updateDecoder(desktopAudio.clearDecoder);

$("ncm-btn-settings").onclick = () => {
  if (!drawer.inert) setDrawerOpen(false);
  refreshAccountSetting();
  settingsStatus.textContent = "";
  if (closeActionSelect) {
    const curAction = localStorage.getItem("ncm_close_action") || "ask";
    closeActionSelect.value = ["ask", "minimize", "quit"].includes(curAction) ? curAction : "ask";
  }
  if (window.CDCaseApp?.getVersion) {
    window.CDCaseApp.getVersion().then(ver => {
      const el = $("ncm-version-display");
      if (el && ver) el.textContent = `当前版本：v${ver}`;
    }).catch(() => {});
  }
  settings.showModal();
  if (desktopAudio) updateDecoder(desktopAudio.decoder);
  else {
    $("ncm-decoder-choose").disabled = true;
    $("ncm-decoder-clear").disabled = true;
  }
  if (desktop) updateCacheDirectory(desktop.getCacheDirectory);
  else {
    $("ncm-cache-path").textContent = "桌面版可设置缓存位置";
    for (const button of cacheControls) button.disabled = true;
  }
};
$("ncm-settings-close").onclick = () => settings.close();
settings.addEventListener("close", () => $("ncm-btn-settings").focus());

const btnCacheOpen = $("ncm-cache-open");
if (btnCacheOpen) {
  btnCacheOpen.onclick = () => desktop?.openCacheDirectory?.();
}
cacheControls[0].onclick = () => updateCacheDirectory(desktop.chooseCacheDirectory);
cacheControls[1].onclick = () => updateCacheDirectory(desktop.resetCacheDirectory);

// ===== 软件版本与在线更新检测模块 =====
let latestReleaseInfo = null;

async function checkAppUpdates(silent = false) {
  const versionDisplay = $("ncm-version-display");
  const updateStatus = $("ncm-update-status");
  const checkBtn = $("ncm-check-update-btn");
  const openReleaseBtn = $("ncm-open-release-btn");
  const updateDot = $("ncm-update-dot");
  const appBridge = window.CDCaseApp;

  if (!appBridge?.checkUpdate) {
    if (updateStatus) updateStatus.textContent = "当前环境不支持在线检查更新。";
    return;
  }

  if (checkBtn) checkBtn.disabled = true;
  if (!silent && updateStatus) {
    updateStatus.className = "update-subtext";
    updateStatus.textContent = "正在连接 GitHub 检测最新版本…";
  }

  try {
    const result = await appBridge.checkUpdate();
    if (!result) throw new Error("未获取到检查结果");

    if (versionDisplay && result.currentVersion) {
      versionDisplay.textContent = `当前版本：v${result.currentVersion}`;
    }

    if (result.success) {
      if (result.hasUpdate) {
        latestReleaseInfo = result;
        if (updateStatus) {
          updateStatus.className = "update-subtext has-update";
          updateStatus.textContent = `发现新版本：${result.tagName}（${result.name}）`;
        }
        if (openReleaseBtn) openReleaseBtn.hidden = false;
        if (updateDot) updateDot.hidden = false;

        // 如果不是静默模式，或者用户本次会话尚未忽略过此新版本，则弹出提示对话框
        const ignored = sessionStorage.getItem("ncm_update_ignored_tag");
        if (!silent || ignored !== result.tagName) {
          showUpdateModal(result);
        }
      } else {
        if (updateStatus) {
          updateStatus.className = "update-subtext";
          updateStatus.textContent = `当前已是最新版本 (v${result.currentVersion})，无需更新。`;
        }
        if (openReleaseBtn) openReleaseBtn.hidden = true;
        if (updateDot) updateDot.hidden = true;
      }
    } else {
      if (!silent && updateStatus) {
        updateStatus.className = "update-subtext error";
        updateStatus.textContent = `检测更新失败：${result.message || "网络异常"}`;
      }
    }
  } catch (err) {
    if (!silent && updateStatus) {
      updateStatus.className = "update-subtext error";
      updateStatus.textContent = `检查更新发生异常：${err.message || err}`;
    }
  } finally {
    if (checkBtn) checkBtn.disabled = false;
  }
}

function showUpdateModal(release) {
  const modal = $("ncm-update-modal");
  if (!modal) return;
  const newTagEl = $("ncm-update-new-tag");
  const curTagEl = $("ncm-update-cur-tag");
  const relNameEl = $("ncm-update-release-name");
  const notesEl = $("ncm-update-notes");

  if (newTagEl) newTagEl.textContent = release.tagName || `v${release.latestVersion}`;
  if (curTagEl) curTagEl.textContent = `当前版本: v${release.currentVersion}`;
  if (relNameEl) relNameEl.textContent = release.name || release.tagName;

  let notesText = release.body || "暂无详细更新说明。";
  if (release.assets && release.assets.length > 0) {
    const assetList = release.assets
      .map(a => `• ${a.name} (${(a.size / (1024 * 1024)).toFixed(1)} MB)`)
      .join("\n");
    notesText += `\n\n【提供下载的安装文件】：\n${assetList}`;
  }
  if (notesEl) notesEl.textContent = notesText;

  if (!modal.open) modal.showModal();
}

function initAppUpdater() {
  const checkBtn = $("ncm-check-update-btn");
  const openReleaseBtn = $("ncm-open-release-btn");
  const modal = $("ncm-update-modal");
  const modalClose = $("ncm-update-modal-close");
  const modalIgnore = $("ncm-update-ignore-btn");
  const modalConfirm = $("ncm-update-confirm-btn");
  const appBridge = window.CDCaseApp;

  // 初始化当前版本号显示
  if (appBridge?.getVersion) {
    appBridge.getVersion().then(ver => {
      const versionDisplay = $("ncm-version-display");
      if (versionDisplay && ver) {
        versionDisplay.textContent = `当前版本：v${ver}`;
      }
    }).catch(() => {});
  }

  if (checkBtn) {
    checkBtn.onclick = () => checkAppUpdates(false);
  }

  const openReleasePage = () => {
    const url = latestReleaseInfo?.htmlUrl || "https://github.com/Eakissa/CD-Netease-Player/releases";
    if (appBridge?.openExternal) {
      appBridge.openExternal(url);
    } else {
      window.open(url, "_blank");
    }
    modal?.close();
  };

  if (openReleaseBtn) openReleaseBtn.onclick = openReleasePage;
  if (modalConfirm) modalConfirm.onclick = openReleasePage;

  if (modalClose) modalClose.onclick = () => modal?.close();
  if (modalIgnore) {
    modalIgnore.onclick = () => {
      if (latestReleaseInfo?.tagName) {
        sessionStorage.setItem("ncm_update_ignored_tag", latestReleaseInfo.tagName);
      }
      modal?.close();
    };
  }

  // 启动 3.5 秒后在后台静默检查一次是否有新发布
  setTimeout(() => {
    checkAppUpdates(true);
  }, 3500);
}

initAppUpdater();

$("ncm-logout").onclick = async () => {
  if (!cookie) return;
  const logout = api("/logout").then(result => result.code === 200, () => false);
  const generation = ++sessionGeneration;
  playlistGeneration++;
  qrGeneration++;
  clearInterval(qrTimer);
  playbackLookup?.abort();
  sourceReady = false;
  pendingPlayback = null;
  cookie = "";
  localStorage.removeItem("ncm_cookie");
  clearMedia();
  tracks = [];
  queueTracks = [];
  queueName = "";
  lyrics = [];
  currentIdx = -1;
  rebuildQueueOrder(-1);
  renderTracks();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "请先扫码登录…";
  $("ncm-playlist-select").replaceChildren(placeholder);
  $("ncm-user").textContent = "未登录";
  $("ncm-btn-login").textContent = "扫码登录";
  $("ncm-time-cur").textContent = $("ncm-time-tot").textContent = "00:00";
  $("ncm-time-tot").title = "";
  window.AMLLPlayer?.reset();
  updateFocusCover(null);
  $("ncm-quality-now").hidden = true;
  updateSlider($("ncm-progress"), 0);
  setPlayingAppearance(false);
  window.CDCaseBridge.reset();
  refreshAccountSetting();
  settingsStatus.textContent = "已退出本程序。";
  if (!(await logout) && generation === sessionGeneration) {
    settingsStatus.textContent = "已清除本程序的登录状态，网易云接口未确认登出。";
  }
};

// ===== 8. 键盘快捷键 =====
document.addEventListener("keydown", (e) => {
  if ($("ncm-settings").open || queueDialog.open) return;
  if (e.key === "Escape") {
    if (!contextMenu?.hidden) {
      hideContextMenu();
      return;
    }
    if (albumDetailView && !albumDetailView.hidden) {
      e.preventDefault();
      closeAlbumDetail();
      return;
    }
    if (document.body.classList.contains("lyrics-focus-mode")) {
      e.preventDefault();
      setFocusMode(false);
      return;
    }
    if (!drawer.inert && $("ncm-qr-modal").classList.contains("hidden")) {
      e.preventDefault();
      setDrawerOpen(false);
      return;
    }
  }
  // 排除输入框、下拉框或弹出层激活状态，但允许在普通按钮获得焦点时按空格播放/暂停
  if (e.target.closest?.("input, select, textarea, [contenteditable]") || !$("ncm-qr-modal").classList.contains("hidden")) return;
  switch (e.code) {
    case "Space":
      e.preventDefault();
      togglePlayPause();
      break;
    case "ArrowRight":
      e.preventDefault();
      playNextTrack();
      break;
    case "ArrowLeft":
      e.preventDefault();
      playPrevTrack();
      break;
    case "ArrowUp":
      e.preventDefault();
      setPlayerVolume(audio.volume + 0.05, true);
      break;
    case "ArrowDown":
      e.preventDefault();
      setPlayerVolume(audio.volume - 0.05, true);
      break;
  }
});

// ===== 9. 启动时自动恢复登录 =====
if (cookie) {
  initSession().catch(() => {
    $("ncm-user").textContent = "会话已过期，请重新登录";
  });
}

// ===== 10. Apple Music Like Lyrics (AMLL) 交互绑定 =====
const transToggleBtn = $("amll-trans-toggle");
const romaToggleBtn = $("amll-roma-toggle");
const focusToggleBtn = $("amll-focus-toggle");
const focusView = $("amll-focus-view");
const focusCover = document.querySelector(".amll-focus-artwork-wrap");
const focusInfo = document.querySelector(".amll-focus-info");
const amllContainer = $("amll-container");

function setFocusMode(enable) {
  const isFocus = enable !== undefined ? enable : !document.body.classList.contains("lyrics-focus-mode");
  document.body.classList.toggle("lyrics-focus-mode", isFocus);
  focusToggleBtn?.classList.toggle("active", isFocus);
  const leftStrip = $("ncm-left-glass-strip");
  if (leftStrip) {
    leftStrip.title = isFocus ? "向左推退出聚焦模式 (点击亦可退出)" : "向右拉进入聚焦模式 (点击亦可切换)";
  }
  return isFocus;
}

if (focusToggleBtn) {
  focusToggleBtn.onclick = (e) => {
    e.stopPropagation();
    setFocusMode();
  };
}

let hasMovedHorizontally = false;

// 点击大专辑封面不再退出聚焦模式（保持原样高清展示）
if (focusCover) {
  focusCover.onclick = (e) => {
    e.stopPropagation();
  };
}

// 点击曲目信息（标题、歌手、专辑等）时阻止冒泡，避免误退出聚焦模式
if (focusInfo) {
  focusInfo.onclick = (e) => {
    e.stopPropagation();
  };
}

// 聚焦模式封面下方控制按键绑定
const focusPrevBtn = $("amll-focus-prev");
const focusPlayBtn = $("amll-focus-play");
const focusNextBtn = $("amll-focus-next");

if (focusPrevBtn) {
  focusPrevBtn.onclick = (e) => {
    e.stopPropagation();
    playPrevTrack();
  };
}
if (focusNextBtn) {
  focusNextBtn.onclick = (e) => {
    e.stopPropagation();
    playNextTrack();
  };
}
if (focusPlayBtn) {
  focusPlayBtn.onclick = (e) => {
    e.stopPropagation();
    togglePlayPause();
  };
}

// 按 Esc 键退出聚焦模式
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("lyrics-focus-mode")) {
    setFocusMode(false);
  }
});

// ===== 11. 后台最小化与系统托盘操作联动 =====
const minimizeBtn = $("ncm-btn-minimize");
if (minimizeBtn) {
  minimizeBtn.onclick = () => {
    window.CDCaseApp?.minimizeToTray();
  };
}

// ===== 11.1 关闭主窗口确认与动作设置 (退出程序或最小化到托盘) =====
let closeAction = localStorage.getItem("ncm_close_action") || "ask";
window.CDCaseApp?.setCloseAction(closeAction);

const closeActionSelect = $("ncm-setting-close-action");
if (closeActionSelect) {
  closeActionSelect.value = ["ask", "minimize", "quit"].includes(closeAction) ? closeAction : "ask";
  closeActionSelect.onchange = () => {
    closeAction = closeActionSelect.value;
    localStorage.setItem("ncm_close_action", closeAction);
    window.CDCaseApp?.setCloseAction(closeAction);
  };
}

const closeDialog = $("ncm-close-modal");
const closeDialogClose = $("ncm-close-modal-close");
const closeCancelBtn = $("ncm-close-modal-cancel");
const closeConfirmBtn = $("ncm-close-modal-confirm");
const closeDefaultCheckbox = $("ncm-close-modal-default");

function showCloseConfirmModal() {
  if (!closeDialog) return;
  if (closeDefaultCheckbox) closeDefaultCheckbox.checked = false;
  const radioMinimize = document.querySelector('input[name="close-action-choice"][value="minimize"]');
  if (radioMinimize) radioMinimize.checked = true;

  if (typeof closeDialog.showModal === "function") {
    closeDialog.showModal();
  } else {
    closeDialog.setAttribute("open", "");
  }
}

function hideCloseConfirmModal() {
  if (!closeDialog) return;
  if (typeof closeDialog.close === "function") {
    closeDialog.close();
  } else {
    closeDialog.removeAttribute("open");
  }
}

closeDialogClose?.addEventListener("click", hideCloseConfirmModal);
closeCancelBtn?.addEventListener("click", hideCloseConfirmModal);

closeConfirmBtn?.addEventListener("click", () => {
  const selectedChoice = document.querySelector('input[name="close-action-choice"]:checked')?.value || "minimize";
  const isSetDefault = Boolean(closeDefaultCheckbox?.checked);

  if (isSetDefault) {
    closeAction = selectedChoice;
    localStorage.setItem("ncm_close_action", closeAction);
    if (closeActionSelect) closeActionSelect.value = closeAction;
    window.CDCaseApp?.setCloseAction(closeAction);
  }

  hideCloseConfirmModal();

  if (selectedChoice === "minimize") {
    window.CDCaseApp?.minimizeToTray();
  } else if (selectedChoice === "quit") {
    window.CDCaseApp?.quitApp();
  }
});

// ===== 12. 专辑双特征色智能提取与背景色模式联动 =====
const dualAccentsCache = new Map();

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
    h *= 360;
  }
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  h = (h % 360 + 360) % 360;
  let c = (1 - Math.abs(2 * l - 1)) * s;
  let x = c * (1 - Math.abs((h / 60) % 2 - 1));
  let m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function applyDualAccentColors(rgb1, rgb2) {
  const root = document.documentElement;
  const c1 = `rgb(${rgb1[0]}, ${rgb1[1]}, ${rgb1[2]})`;
  const c1Dark = `rgb(${Math.round(rgb1[0] * 0.65)}, ${Math.round(rgb1[1] * 0.65)}, ${Math.round(rgb1[2] * 0.65)})`;
  const c2 = `rgb(${rgb2[0]}, ${rgb2[1]}, ${rgb2[2]})`;
  const c2Dark = `rgb(${Math.round(rgb2[0] * 0.60)}, ${Math.round(rgb2[1] * 0.60)}, ${Math.round(rgb2[2] * 0.60)})`;

  root.style.setProperty("--bg-accent-1", c1);
  root.style.setProperty("--bg-accent-1-dark", c1Dark);
  root.style.setProperty("--bg-accent-2", c2);
  root.style.setProperty("--bg-accent-2-dark", c2Dark);
}

function extractAndApplyDualAccents(coverUrl) {
  if (!coverUrl) return;
  if (dualAccentsCache.has(coverUrl)) {
    const [c1, c2] = dualAccentsCache.get(coverUrl);
    applyDualAccentColors(c1, c2);
    return;
  }

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = coverUrl;
  img.onload = () => {
    try {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      const size = 64;
      canvas.width = size;
      canvas.height = size;
      ctx.drawImage(img, 0, 0, size, size);
      const imgData = ctx.getImageData(0, 0, size, size).data;

      const colorList = [];
      for (let i = 0; i < imgData.length; i += 4) {
        const r = imgData[i];
        const g = imgData[i + 1];
        const b = imgData[i + 2];
        const a = imgData[i + 3];
        if (a < 128) continue;
        const [h, s, l] = rgbToHsl(r, g, b);
        // 过滤近黑和近白高光
        if (l < 0.12 || l > 0.90) continue;
        colorList.push({ r, g, b, h, s, l });
      }

      if (!colorList.length) {
        const def1 = [190, 55, 85], def2 = [45, 70, 120];
        dualAccentsCache.set(coverUrl, [def1, def2]);
        applyDualAccentColors(def1, def2);
        return;
      }

      // 将颜色按色相分 12 桶 (每桶 30°)
      const buckets = Array.from({ length: 12 }, () => []);
      for (const c of colorList) {
        const bucketIdx = Math.floor(c.h / 30) % 12;
        buckets[bucketIdx].push(c);
      }

      const scoredBuckets = buckets.map((bucket, idx) => {
        if (!bucket.length) return null;
        let sumR = 0, sumG = 0, sumB = 0, sumS = 0;
        for (const c of bucket) {
          sumR += c.r; sumG += c.g; sumB += c.b; sumS += c.s;
        }
        const count = bucket.length;
        const avgS = sumS / count;
        const score = count * (0.35 + avgS * 0.65);
        return {
          idx,
          r: Math.round(sumR / count),
          g: Math.round(sumG / count),
          b: Math.round(sumB / count),
          h: (idx * 30 + 15),
          score,
        };
      }).filter(Boolean).sort((a, b) => b.score - a.score);

      const color1 = scoredBuckets[0] || { r: 180, g: 60, b: 90, h: 330 };
      let color2 = null;

      // 寻找第二特征色：要求环形色相差 >= 45° 且 RGB 欧氏距离 >= 65，确保绝不选用相同或相近颜色
      for (let i = 1; i < scoredBuckets.length; i++) {
        const candidate = scoredBuckets[i];
        const hueDiff = Math.abs(candidate.h - color1.h);
        const circularHueDiff = Math.min(hueDiff, 360 - hueDiff);
        const rgbDist = Math.hypot(candidate.r - color1.r, candidate.g - color1.g, candidate.b - color1.b);
        if (circularHueDiff >= 45 && rgbDist >= 65) {
          color2 = candidate;
          break;
        }
      }

      // 封面为纯单色时：基于首选特征色智能生成对立互补或三分对立高辨识色相 (+85°)
      if (!color2) {
        const [h1, s1, l1] = rgbToHsl(color1.r, color1.g, color1.b);
        const h2 = (h1 + 85) % 360;
        const [r2, g2, b2] = hslToRgb(h2, Math.max(0.48, s1), Math.max(0.38, Math.min(0.62, l1)));
        color2 = { r: r2, g: g2, b: b2, h: h2 };
      }

      const res1 = [color1.r, color1.g, color1.b];
      const res2 = [color2.r, color2.g, color2.b];
      dualAccentsCache.set(coverUrl, [res1, res2]);
      applyDualAccentColors(res1, res2);
    } catch (e) {
      console.warn("[NCM] 提取双特征色失败:", e);
    }
  };
}

let bgColorMode = localStorage.getItem("ncm_bg_color_mode") || "default";
function applyBgColorMode(mode) {
  bgColorMode = mode;
  localStorage.setItem("ncm_bg_color_mode", mode);
  document.body.classList.toggle("bg-dual-accent", mode === "dual-accent");
}
applyBgColorMode(bgColorMode);

const bgModeSelect = $("ncm-setting-bg-mode");
if (bgModeSelect) {
  bgModeSelect.value = bgColorMode;
  bgModeSelect.onchange = () => {
    applyBgColorMode(bgModeSelect.value);
    showPlayerToast(bgModeSelect.value === "dual-accent" ? "已启用双特征色背景" : "已切换为经典两分背景");
  };
}

// ===== 13. 3D CD 盒丰富交互增强 (滚轮自旋 / 双击甩动 / 中键回正) =====
function initCDCaseInteractions() {
  const isExcluded = (target) => {
    return target.closest?.(
      ".desktop-titlebar, #ncm-controls, #ncm-topbar, #ncm-topbar-show, " +
      "#ncm-drawer, #ncm-drawer-backdrop, #ncm-qr-modal, #ncm-settings, " +
      "#ncm-show-controls, #ncm-queue, #amll-focus-view, " +
      "#ncm-right-glass-strip, #ncm-left-edge-strip, #ncm-left-glass-strip"
    );
  };

  // 1. 鼠标滚轮旋转：在画面中上下滚动滚轮，直接顺滑 360 度旋转 CD 盒（带阻尼角动量）
  window.addEventListener("wheel", (e) => {
    if (document.body.classList.contains("lyrics-focus-mode")) return;
    if (isExcluded(e.target)) return;
    const c = window.__case;
    if (!c) return;
    if (c.settle) {
      c.userYaw = c.lastYaw ?? 0;
      c.settle = null;
    }
    const delta = Math.sign(e.deltaY);
    c.userVel = (c.userVel || 0) + delta * 3.5;
  }, { passive: true });

  // 2. 双击花式 360° 甩光旋转：双击 CD 盒赋予强劲冲量疾速自旋
  window.addEventListener("dblclick", (e) => {
    if (document.body.classList.contains("lyrics-focus-mode")) return;
    if (isExcluded(e.target)) return;
    const c = window.__case;
    if (!c) return;
    if (c.settle) {
      c.userYaw = c.lastYaw ?? 0;
      c.settle = null;
    }
    const dir = (c.userVel >= 0) ? 1 : -1;
    c.userVel = dir * 22;
    c.userPitchVel = (Math.random() - 0.5) * 5;
  });

  // 3. 鼠标中键一键优雅回正：点击鼠标滚轮中键，CD 盒平滑滑行回正至初始正面
  window.addEventListener("mousedown", (e) => {
    if (e.button === 1) { // 滚轮中键
      if (document.body.classList.contains("lyrics-focus-mode")) return;
      if (isExcluded(e.target)) return;
      const c = window.__case;
      if (!c) return;
      e.preventDefault();
      if (typeof c.glideToFront === "function") {
        c.glideToFront();
      } else {
        c.userYaw = 0;
        c.userPitch = 0;
        c.userVel = 0;
        c.userPitchVel = 0;
      }
      showPlayerToast("CD 盒已平滑回正");
    }
  });
}
initCDCaseInteractions();

window.CDCaseApp?.onCloseRequested(() => {
  showCloseConfirmModal();
});

function handleRemoteControl(action) {
  if (action === "toggle-play") {
    togglePlayPause();
  } else if (action === "prev-track") {
    playPrevTrack();
  } else if (action === "next-track") {
    playNextTrack();
  } else if (action === "volume-up") {
    setPlayerVolume(audio.volume + 0.05, true);
  } else if (action === "volume-down") {
    setPlayerVolume(audio.volume - 0.05, true);
  }
}

window.CDCaseApp?.onTrayAction(handleRemoteControl);
window.CDCaseApp?.onShortcutAction(handleRemoteControl);

// 初始化快捷键设置联动
const optCtrl = $("ncm-opt-global-ctrl");
const optSuper = $("ncm-opt-global-super");

function initShortcutsSettings() {
  const savedCtrl = localStorage.getItem("ncm_shortcut_ctrl") !== "false";
  const savedSuper = localStorage.getItem("ncm_shortcut_super") !== "false";

  if (optCtrl) optCtrl.checked = savedCtrl;
  if (optSuper) optSuper.checked = savedSuper;

  function syncShortcuts() {
    const config = {
      enableCtrl: optCtrl ? optCtrl.checked : true,
      enableSuper: optSuper ? optSuper.checked : true,
    };
    localStorage.setItem("ncm_shortcut_ctrl", String(config.enableCtrl));
    localStorage.setItem("ncm_shortcut_super", String(config.enableSuper));
    window.CDCaseApp?.setShortcutsConfig(config);
  }

  if (optCtrl) optCtrl.onchange = syncShortcuts;
  if (optSuper) optSuper.onchange = syncShortcuts;

  syncShortcuts();
}
initShortcutsSettings();

if (transToggleBtn) {
  transToggleBtn.onclick = () => {
    const active = window.AMLLPlayer?.toggleTranslation();
    transToggleBtn.classList.toggle("active", active);
  };
}
if (romaToggleBtn) {
  romaToggleBtn.onclick = () => {
    const active = window.AMLLPlayer?.toggleRomaji();
    romaToggleBtn.classList.toggle("active", active);
  };
}

// 初始化 AMLL 歌词播放器
if (window.AMLLPlayer) {
  window.AMLLPlayer.init($("amll-container"), audio);
}

// ===== 11. 顶部菜单栏折叠/展开 =====
const topbarHideBtn = $("ncm-topbar-hide");
const topbarShowBtn = $("ncm-topbar-show");

function setTopbarHidden(hidden) {
  document.body.classList.toggle("ncm-topbar-hidden", hidden);
  if (topbarShowBtn) topbarShowBtn.hidden = !hidden;
  if (hidden) {
    localStorage.setItem("ncm_topbar_hidden", "true");
  } else {
    localStorage.removeItem("ncm_topbar_hidden");
  }
}

if (topbarHideBtn) {
  topbarHideBtn.onclick = (e) => {
    e.stopPropagation();
    setTopbarHidden(true);
  };
}
if (topbarShowBtn) {
  topbarShowBtn.onclick = (e) => {
    e.stopPropagation();
    setTopbarHidden(false);
  };
}

if (localStorage.getItem("ncm_topbar_hidden") === "true") {
  setTopbarHidden(true);
}

// ===== 13. 左右两侧手势滑动交互 (右侧向左拉出歌单 / 左侧向右切换 CD 与聚焦模式) =====
(function initSwipeGestures() {
  const drawer = $("ncm-drawer");
  const drawerBackdrop = $("ncm-drawer-backdrop");
  const glassStrip = $("ncm-right-glass-strip");
  const leftGlassStrip = $("ncm-left-glass-strip") || $("ncm-left-edge-strip");

  let isDraggingDrawer = false;
  let isSwipingLeftMode = false;
  let startX = 0;
  let startY = 0;
  let startTime = 0;
  let drawerWidth = 520;

  // 状态辅助函数：拖拽时添加 .interacting 类保持高亮可见
  function setStripInteracting(strip, interacting) {
    if (strip) {
      strip.classList.toggle("interacting", interacting);
      strip.classList.remove("strip-idle");
    }
  }

  // 鼠标无互动超时自动隐藏：在拖拉栏上悬停超过 2.5 秒无移动时平滑淡出隐藏，再次移动立刻唤醒
  function setupStripIdleWatch(strip) {
    if (!strip) return;
    let idleTimer = null;
    const resetIdle = () => {
      strip.classList.remove("strip-idle");
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!isDraggingDrawer && !isSwipingLeftMode) {
          strip.classList.add("strip-idle");
        }
      }, 2500);
    };
    strip.addEventListener("mouseenter", resetIdle);
    strip.addEventListener("mousemove", resetIdle);
    strip.addEventListener("mouseleave", () => {
      clearTimeout(idleTimer);
      strip.classList.remove("strip-idle");
    });
  }

  setupStripIdleWatch(glassStrip);
  setupStripIdleWatch(leftGlassStrip);

  // 点击右侧磨砂玻璃条直接开关歌单
  if (glassStrip) {
    glassStrip.addEventListener("click", (e) => {
      if (!hasMovedHorizontally) {
        e.stopPropagation();
        setDrawerOpen(drawer.inert);
      }
    });
  }

  // 点击左侧模式滑块直接切换模式（CD 模式进入聚焦，聚焦模式点击退出聚焦）
  if (leftGlassStrip) {
    leftGlassStrip.addEventListener("click", (e) => {
      if (!hasMovedHorizontally) {
        e.stopPropagation();
        const isFocus = document.body.classList.contains("lyrics-focus-mode");
        setFocusMode(!isFocus);
      }
    });
  }

  window.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    // 忽略顶部操作栏、底部播放栏、扫码弹窗及设置弹窗内部的点击
    if (e.target.closest?.(".desktop-titlebar, #ncm-bar, #ncm-settings, #ncm-qr-modal, dialog:not(#ncm-drawer)")) {
      return;
    }

    startX = e.clientX;
    startY = e.clientY;
    startTime = Date.now();
    hasMovedHorizontally = false;
    drawerWidth = drawer.offsetWidth || Math.min(520, window.innerWidth * 0.90);

    const isDrawerOpen = !drawer.inert;
    const isInsideDrawer = Boolean(e.target.closest?.("#ncm-drawer"));
    const isFocus = document.body.classList.contains("lyrics-focus-mode");
    // 歌单抽屉感应区：仅限右侧磨砂玻璃条或右边缘 50px 区域，杜绝半屏或歌词区误触
    const isRightZone = Boolean(e.target.closest?.("#ncm-right-glass-strip")) ||
                       (e.clientX >= window.innerWidth - 50);
    // 模式滑块感应区：CD 模式下位于最左侧，聚焦模式下位于封面右侧
    const isLeftZone = Boolean(e.target.closest?.("#ncm-left-glass-strip, #ncm-left-edge-strip")) ||
                       (!isFocus && e.clientX <= 50);

    if (isDrawerOpen) {
      // 歌单抽屉已打开：在抽屉内部或遮罩层上支持向右滑动收起
      if (isInsideDrawer || e.target === drawerBackdrop) {
        isDraggingDrawer = true;
        setStripInteracting(glassStrip, true);
      }
    } else {
      // 歌单抽屉未打开：在右侧磨砂玻璃条区域支持向左滑动拉出
      if (isRightZone && !isInsideDrawer) {
        isDraggingDrawer = true;
        setStripInteracting(glassStrip, true);
      } else if (isLeftZone) {
        // 模式滑块：从左向右拉进入聚焦，或从右向左推退出聚焦
        isSwipingLeftMode = true;
        setStripInteracting(leftGlassStrip, true);
      }
    }
  }, { passive: true });

  window.addEventListener("mousemove", (e) => {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);

    if (absX > 10 && absX > absY * 1.2) {
      hasMovedHorizontally = true;
    }

    // 1. 歌单抽屉实时跟手拖拽
    if (isDraggingDrawer && hasMovedHorizontally) {
      const isDrawerOpen = !drawer.inert;
      let currentX = 0;
      if (isDrawerOpen) {
        // 已打开状态：仅允许向右推收起 (dx >= 0)
        currentX = Math.max(0, dx);
      } else {
        // 已收起状态：从右向左拉出 (dx <= 0)
        currentX = Math.max(0, Math.min(drawerWidth, drawerWidth + dx));
      }

      drawer.style.transform = `translateX(${currentX}px)`;
      drawer.style.transition = "none";
      drawer.style.visibility = "visible";
      drawer.classList.remove("closed");
      drawerBackdrop.hidden = false;
      const progress = 1 - currentX / drawerWidth;
      drawerBackdrop.style.opacity = String(Math.max(0, Math.min(1, progress)));
      drawerBackdrop.style.transition = "none";
    }

    // 2. 模式滑块实时拉动/推回跟手反馈
    if (isSwipingLeftMode && hasMovedHorizontally) {
      const isFocus = document.body.classList.contains("lyrics-focus-mode");
      if (!isFocus) {
        // CD 模式：向右拉出聚焦视图
        const pullDist = Math.max(0, dx);
        const stretch = Math.min(pullDist * 0.45, 80);
        if (leftGlassStrip) {
          leftGlassStrip.style.transform = `translateX(${stretch}px)`;
          leftGlassStrip.style.transition = "none";
        }
      } else {
        // 聚焦模式：从封面右侧向左推回收起
        const pushDist = Math.min(0, dx);
        const stretch = Math.max(pushDist * 0.45, -80);
        if (leftGlassStrip) {
          leftGlassStrip.style.transform = `translateX(${stretch}px)`;
          leftGlassStrip.style.transition = "none";
        }
        const fv = $("amll-focus-view");
        if (fv) {
          fv.style.transform = `translateX(${Math.max(pushDist * 0.25, -40)}px)`;
          fv.style.transition = "none";
        }
      }
    }
  }, { passive: true });

  window.addEventListener("mouseup", (e) => {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    const dt = Date.now() - startTime;

    // 1. 结算歌单抽屉拖拽
    if (isDraggingDrawer) {
      isDraggingDrawer = false;
      setStripInteracting(glassStrip, false);
      drawer.style.transform = "";
      drawer.style.transition = "";
      drawer.style.visibility = "";
      drawerBackdrop.style.opacity = "";
      drawerBackdrop.style.transition = "";

      if (hasMovedHorizontally) {
        const isDrawerOpen = !drawer.inert;
        if (isDrawerOpen) {
          // 向右推超过 60px 或快速右滑则收起
          if (dx > 60 || (dx > 25 && dt < 300)) {
            setDrawerOpen(false);
          } else {
            setDrawerOpen(true);
          }
        } else {
          // 向左拉超过 60px 或快速左滑则拉出
          if (dx < -60 || (dx < -25 && dt < 300)) {
            setDrawerOpen(true);
          } else {
            setDrawerOpen(false);
          }
        }
      }
    }

    // 2. 结算模式滑块交互（从左拉到右进入聚焦，从右推回左退出聚焦）
    if (isSwipingLeftMode) {
      isSwipingLeftMode = false;
      setStripInteracting(leftGlassStrip, false);
      if (leftGlassStrip) {
        leftGlassStrip.style.transform = "";
        leftGlassStrip.style.transition = "";
      }
      const fv = $("amll-focus-view");
      if (fv) {
        fv.style.transform = "";
        fv.style.transition = "";
      }
      if (hasMovedHorizontally) {
        const isFocus = document.body.classList.contains("lyrics-focus-mode");
        if (!isFocus) {
          // CD 模式下向右拉动超过 45px 或快速右滑 -> 进入聚焦模式
          if (dx > 45 || (dx > 20 && dt < 300)) {
            setFocusMode(true);
          }
        } else {
          // 聚焦模式下向左推回超过 45px 或快速左滑 -> 退出聚焦模式
          if (dx < -45 || (dx < -20 && dt < 300)) {
            setFocusMode(false);
          }
        }
      }
    }

    // 短暂延迟重置 hasMovedHorizontally，以便 click 事件能识别出这是拖拽而非点击
    setTimeout(() => {
      hasMovedHorizontally = false;
    }, 60);
  });
})();

console.log("[NCM Player] 网易云播放器初始化完成 (含 AMLL 歌词引擎与 AV3A/AV3V 解码器)");
console.log("[NCM Player] 快捷键：空格=播放暂停 | Shift+← →=切曲 | ← →=快退快进5s | ↑↓=音量");
