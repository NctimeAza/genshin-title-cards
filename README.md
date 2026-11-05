# 原神剧情身份牌工作台

本地重放、改字预览与逐帧导出 30 套《原神》角色剧情身份牌动画，无需安装游戏本体或额外素材包。

## 下载与运行

仓库内已包含完整的透明特效帧、贴图、字体与原音效，建议使用浅克隆减少下载体积：

```bash
git clone --depth 1 https://github.com/NctimeAza/genshin-title-cards.git
cd genshin-title-cards
```

需要安装 Python 3（仅使用标准库，无需安装第三方包）：

- Windows：双击运行 `启动.cmd`，或在目录内执行 `python server.py`
- macOS / Linux：执行 `python3 server.py`

启动后保持终端窗口打开，在浏览器访问 `http://127.0.0.1:8765`（如需更换端口可执行 `python server.py --port 8766`）。

网页实时预览、修改文字、试听原音效、导出当前帧 PNG（透明 / 绿幕 / 黑底）无需额外工具。若需导出 H.264 MP4 或带透明通道的 ProRes 4444 MOV 视频，请安装 `ffmpeg` 并加入系统 `PATH`，或将可执行文件放入项目 `tools/ffmpeg.exe`（macOS / Linux 为 `tools/ffmpeg`），也可通过环境变量 `FFMPEG` 指定路径。导出的视频保存在 `exports/` 目录。

## 注意事项

- 推荐使用现代 Chromium 内核浏览器（Edge 或 Chrome），以保证 Canvas 混合、字体度量与逐帧编码一致。
- 含复杂三维网格、粒子系统或 Spine 骨骼的模板采用按原始参数离线重放的 30 fps 无字透明序列帧叠加实时文字；选择 60 fps 导出时会复用 30 fps 特效帧，并按 60 fps 逐帧采样文字与曲线。
- 项目内的游戏字体、贴图与原音效版权均归米哈游（miHoYo / HoYoverse）所有，本项目仅供动画技术研究与非商业二创交流，严禁用于任何商业用途。

## 资产与组件来源

全部 30 张角色身份牌的游戏内根预制体、UI 组件结构、动画控制器与片段、Wwise 原音效事件及剧情定位说明，详见 [来源.md](来源.md)。
