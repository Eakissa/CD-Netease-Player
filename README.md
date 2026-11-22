# 💿 CD Netease Player

<p align="center">
  <img src="tray-icon.png" width="96" alt="CD Netease Player Logo" />
</p>

<p align="center">
  <strong>沉浸式 3D 拟物 CD 盒 × 网易云音乐桌面播放器</strong><br>
  整合 Apple Music Like Lyrics (AMLL) 逐字灵动流光歌词与 MOLAN-AV3A 全景声解码引擎
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-GPL--3.0-blue.svg" alt="License: GPL-3.0"></a>
  <img src="https://img.shields.io/badge/Electron-32-47848F.svg" alt="Electron">
  <img src="https://img.shields.io/badge/AMLL-Dynamic%20Lyrics-pink.svg" alt="AMLL">
  <img src="https://img.shields.io/badge/Platform-Windows-0078D6.svg" alt="Platform">
</p>

---

## ✨ 核心特性

- 💿 **3D 拟物亚克力 CD 盒交互**：
  - 高精度 3D 亚克力外壳、光盘内托与碟片材质渲染。
  - 切歌时伴随开盖退碟与光盘换装动画，音质优先换碟。
  - 支持**自由拖拽旋转、滚轮自旋（带角动量阻尼）、双击极速甩转、鼠标滚轮中键平滑回正**等丰富物理交互。
- 🎵 **网易云音乐生态无缝对接**：
  - 二维码扫码登录，读取个人云端歌单与收藏专辑。
  - 收藏专辑以**双列 3D CD Case** 形式唯美陈列，支持点击进入专辑详情浏览全部曲目、单曲点播与整专播放。
  - 全局右键快捷菜单：单曲即刻播放、加入播放队列、设置为下一首播放。
- 🎤 **Apple Music Like Lyrics (AMLL) 灵动歌词**：
  - 接入 `@applemusic-like-lyrics` 渲染引擎，完美呈现网易云新版 YRC 逐字逐音节流光跳动。
  - 支持歌词中文翻译一键对照（「译」）与罗马音注音音标切换（「音」）。
  - 单击任意歌词行即刻跳转进度。
- 🎧 **内置 MOLAN-AV3A 全景声解码引擎**：
  - 针对网易云沉浸全景声音轨（AV3A / AV3V），内置原生解码器与智能下混算法，呈现出色的空间环绕声体验。
- 🎨 **双特征色自适应流动背景与极简聚焦模式**：
  - 自动提取专辑封面两组辨识度极高的高对比互补色，实时渲染全屏对角流动渐变。
  - **聚焦模式**：向右拉动左侧滑块（或点击顶部聚焦按钮）即可收起 3D 盒进入极简歌词大屏海报流，按 `Esc` 随时回退。
- 🎛️ **现代毛玻璃交互 UI**：
  - 全面统一的半透明磨砂亚克力玻璃质感控制条、抽屉与播放列表选单。
  - 播放列表选单打开后点击画面任意位置自动收起，支持无缝沉浸。
  - 记录音量记忆、支持系统托盘后台运行与全局自定义热键控制。

---

## 🚀 快速上手

### 运行环境
- Node.js (推荐 Node.js 18+)
- Windows 10 / 11

### 1. 克隆仓库与安装依赖

```bash
git clone https://github.com/Eakissa/CD-Netease-Player.git
cd CD-Netease-Player
npm install
```

### 2. 启动播放器

```bash
npm start
```

### 3. 构建打包（生成绿色免安装 Portable 版）

```bash
npm run build
```
打包产物将自动输出至 `dist/` 目录。

---

## ⌨️ 常用快捷键

| 按键 | 功能 |
| :--- | :--- |
| `空格 (Space)` | 播放 / 暂停 |
| `Shift + →` | 下一首 |
| `Shift + ←` | 上一首（前 3 秒重播，3 秒后切上一曲） |
| `→` | 快进 5 秒 |
| `←` | 快退 5 秒 |
| `↑` / `↓` | 调节音量（伴随悬浮 HUD 提示） |
| `Esc` | 退出聚焦模式 / 返回全部专辑 / 收起抽屉或选单 |

---

## 📜 开源协议与致谢声明 (Credits & License)

本项目采用 **[GNU General Public License v3.0 (GPL-3.0)](LICENSE)** 协议开源。

### 核心依赖与第三方资产致谢
1. **[applemusic-like-lyrics](https://github.com/Steve-xmh/applemusic-like-lyrics)**
   - 优秀的 Apple Music 风格动态歌词渲染框架，采用 **GPL-3.0** 协议，本项目歌词渲染严格遵循其开源协议。
2. **[NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi)**
   - 网易云音乐 Node.js API 引擎，采用 **MIT** 协议。
3. **[MOLAN-AV3A](https://github.com/baiji6/MOLAN-AV3A)**
   - AVS3 Audio (Audio Vivid) 解码引擎及社区算法实现。
4. **[Spinning CD Case — Music Visualizer](https://steamcommunity.com/sharedfiles/filedetails/?id=3828403978)** (Steam Workshop ID: `3828403978`)
   - 核心 3D WebGL 亚克力 CD 包装盒模型、着色器与动态视觉渲染移植自 Steam Wallpaper Engine 创意工坊作者 **[sbeuwu](https://ko-fi.com/sbeuwu)** 的优秀独立作品，在此向原作者致以崇高敬意。
5. **全套字体资产 (`fonts/`)**
   - 均采用 **SIL Open Font License 1.1 (OFL)** 协议开源（附带官方许可证文件）。

### ⚠️ 免责声明 (Disclaimer)
- 本项目为个人针对前端 3D 渲染、Web Audio 空间音频与灵动歌词交互整合的**技术研究与非商业开源交流项目**。
- 本软件不提供任何商业收费服务，不破解或篡改任何音频接口付费逻辑。用户登录与会员权益均依托于用户自身的网易云账号及官方服务。
- 若相关资产作者或版权方对开源引用存在异议，请提交 Issue 或联系我们，我们将第一时间积极配合调整。
