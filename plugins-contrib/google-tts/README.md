# Google TTS 插件（ffplay 播放版）

Google Translate TTS，免费免 key。与官方/常见 TTS 插件的区别：**不依赖 WebKit WebAudio 播放**。

## 为什么

WebKitGTK 的 WebAudio 输出在部分机器上有平台级故障（AudioContext 正常、GStreamer 正常写
pulse 环形缓冲，但管道立即 cork，听不到声音；MiniBrowser 可复现）。pot 前端的 useVoice hook
还在页面加载时就创建 AudioContext 且从不 resume（自动播放策略下永远 suspended）。

本插件：抓取 MP3 后通过 `utils.run` 调系统 `ffplay` 播放，完全绕开 WebKit 音频栈。

## 安装

```bash
mkdir -p ~/.config/com.pot-app.desktop/plugins/tts/plugin.com.pot-app.google_tts
cp main.js info.json icon.svg ~/.config/com.pot-app.desktop/plugins/tts/plugin.com.pot-app.google_tts/
```

然后在 pot 设置里把 TTS 服务列表设为 `plugin.com.pot-app.google_tts@<任意后缀>`，或直接改
`~/.config/com.pot-app.desktop/config.json` 的 `tts_service_list`，重启 pot。

## 依赖与限制

- 需要系统安装 `ffplay`（ffmpeg）和 `base64`（coreutils）
- Google TTS 单条 ~200 字符上限，长文会失败
- 语言覆盖：en / zh_cn / zh_tw / ja / ko / fr / de / es / ru / it / pt / vi / th（见 info.json）
