# Pot on niri / Wayland — 完整修复与排障指南

> 适用环境：niri（Smithay）合成器、Ubuntu 26.04、Pot 3.0.7（官方停更）。
> 本文是踩坑全记录 + 可复刻配方。所有结论都经过像素级验证（grim 截图差分），不是"看起来好了"。

## 症状与根因对照表

| 症状 | 根因 |
|---|---|
| 启动即闪退 / "开个 Electron 应用（如 Hermes）后就坏了" | AppImage 捆绑的旧版 libatspi 在 AT-SPI 总线活动时 `pthread_mutex_lock(NULL)` 段错误。Electron 应用启动会激活 `org.a11y.Bus` |
| 窗口存在但全透明/全黑、不渲染 | AppImage 捆绑 webkit2gtk-4.0，在 niri 上不可靠；且 AppImage 钩子**强制 `GDK_BACKEND=x11`**，"设环境变量切 Wayland"的尝试全部无效 |
| 直接运行 Wayland 原生崩溃 | 捆绑旧 glib 读宿主 gsettings：`antialiasing` 等键在 Ubuntu 26.04 已挪到 `xsettings.deprecated` schema → `GLib-GIO-ERROR` SIGTRAP |
| 失焦不自动关窗 | Wayland 下失焦伴随伪 `tauri://move` 事件，把 100ms 关闭计时器取消（官方 `patches/hyprland.patch` 就是为这个，但 release 构建没应用它） |
| 播放按钮无声 | ①唯一内置 TTS 是 lingva，服务已死；②WebKitGTK WebAudio 音频管道在本机 cork（MiniBrowser 复现，平台级问题） |
| ecdict 报 405 | 内置实现调用 `pot-app.com/api/dict`，官方中转已关停 |

## 方案一（推荐）：本 fork 的源码构建

本 fork 已修复：失焦关窗、移除死服务 ecdict、useVoice 补 `resume()`。
直接按官方文档构建即可，产物链接系统 webkit2gtk-4.1，在 niri 上原生渲染正常。

### 本机（Ubuntu 26.04）构建 webkit2gtk-4.1 直装 deb — 已验证的完整配方

```bash
sudo apt install -y libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf libxdo-dev libssl-dev
rustup toolchain install 1.80.1 --profile minimal   # wry 0.24 在新版 rustc 下编译不过（glob 同名 trait 方法解析变更）
rustup override set 1.80.1                          # 在仓库目录内执行

# pkg-config 名字 shim（老 crate 找 webkit2gtk-4.0/javascriptcoregtk-4.0/libsoup-2.4）
mkdir -p /tmp/pot-pc
printf 'Name: s\nVersion: 2.52.6\nRequires: gtk+-3.0 libsoup-3.0 javascriptcoregtk-4.1\nLibs: -l:libwebkit2gtk-4.1.so.0\n' > /tmp/pot-pc/webkit2gtk-4.0.pc
printf 'Name: s\nVersion: 2.52.6\nLibs: -l:libjavascriptcoregtk-4.1.so.0\n' > /tmp/pot-pc/javascriptcoregtk-4.0.pc
printf 'Name: s\nVersion: 2.74.0\nLibs: \n' > /tmp/pot-pc/libsoup-2.4.pc
# 链接器 shim：sys crate 按包名生成 -lwebkit2gtk-4.0，给 ld 一个同名录符号链接
mkdir -p /tmp/pot-link
ln -sf /usr/lib/x86_64-linux-gnu/libwebkit2gtk-4.1.so.0      /tmp/pot-link/libwebkit2gtk-4.0.so
ln -sf /usr/lib/x86_64-linux-gnu/libjavascriptcoregtk-4.1.so.0 /tmp/pot-link/libjavascriptcoregtk-4.0.so

pnpm install
export PKG_CONFIG_PATH=/tmp/pot-pc LIBRARY_PATH=/tmp/pot-link
pnpm tauri build -b deb
```

产物二进制 `NEEDED` 直接是 `libwebkit2gtk-4.1.so.0` / `libsoup-3.0.so.0`，完全 standalone。
tauri 打 deb 时会硬编码依赖 `libwebkit2gtk-4.0-37`，打包后用 `dpkg-deb -R` 改 control 里的
Depends 为 `libwebkit2gtk-4.1-0` 再 `-b` 重打即可（本 fork release 里的
`pot_*_webkit41.deb` 就是这样来的）。

## 方案二：官方 AppImage 的运行时移植（不重编译）

官方 AppImage 捆绑 webkit2gtk-4.0（永不渲染）。把它解包、借系统 4.1 顶替：

```bash
# 1. 解包 AppImage
mkdir /tmp/pot-sq && cd /tmp/pot-sq && /path/to/pot --appimage-extract

# 2. 干净布局：二进制 + 3 个 shim 库（RUNPATH $ORIGIN/../lib）
mkdir -p ~/.local/lib/pot-rt/{bin,lib}
cp squashfs-root/usr/bin/pot ~/.local/lib/pot-rt/bin/
cd ~/.local/lib/pot-rt/lib
ln -s /usr/lib/x86_64-linux-gnu/libwebkit2gtk-4.1.so.0       libwebkit2gtk-4.0.so.37
ln -s /usr/lib/x86_64-linux-gnu/libjavascriptcoregtk-4.1.so.0 libjavascriptcoregtk-4.0.so.18
# soup2 桩：二进制经 webkit2gtk-rs 静态引入 2 个 soup2 符号，运行时从不调用；
# 但真实 soup2 与 4.1 的 soup3 同进程即 abort，故必须桩掉
cat > soup_stub.c <<'EOF'
typedef unsigned long GType;
GType soup_message_headers_get_type(void) { return 0; }
void soup_message_headers_append(void *h, const char *n, const char *v) { (void)h;(void)n;(void)v; }
EOF
gcc -shared -fPIC -o libsoup-2.4.so.1 soup_stub.c -Wl,-soname,libsoup-2.4.so.1

# 3. 启动器 ~/.local/bin/pot-wayland
#!/bin/bash
exec flock -n /tmp/pot-wayland.lock \
  env LD_LIBRARY_PATH="$HOME/.local/lib/pot-rt/lib" GDK_BACKEND=wayland NO_AT_BRIDGE=1 \
      "$HOME/.local/lib/pot-rt/bin/pot" "$@"
```

`NO_AT_BRIDGE=1` 防 AT-SPI 段错误；`flock` 防双实例（双实例时第二个收不到 HTTP 请求，表现为"时好时坏"）。

⚠️ 二进制补丁说明：官方构建的失焦关窗 bug 是在**前端 bundle**（嵌在二进制里）。本 fork 的构建不需要补丁；
若坚持用官方 AppImage 解包版，可用等长替换打补丁：`tauri://move` → `tauri://m0ve`（2 处），副作用是 `pre_state` 窗口位置记忆失效。

## niri 配置（config.kdl）

```kdl
spawn-sh-at-startup "pot-wayland"

// 划词翻译：直接读 PRIMARY 选择 POST 给 pot（最可靠路径）
Ctrl+Alt+A { spawn-sh "wl-paste --primary --no-newline | curl -s -X POST --data-binary @- 'http://127.0.0.1:60828/translate' >/dev/null"; }
// 截图翻译：grim+slurp 截图到 pot 缓存路径，再调 OCR
Ctrl+Alt+S { spawn-sh "grim -g \"$(slurp)\" ~/.cache/com.pot-app.desktop/pot_screenshot_cut.png && curl -s 'http://127.0.0.1:60828/ocr_translate?screenshot=false' >/dev/null"; }

window-rule {
    // 注意大小写：Wayland 原生 app_id 是小写 "pot"，X11/AppImage 是 "Pot"
    match app-id="^(?i)pot$"
    open-floating true
    default-column-width { fixed 600; }
    default-window-height { fixed 800; }
    border { off; }
    focus-ring { off; }
}
```

## 插件

- **ecdict 离线词典**：装官方插件 [pot-app-translate-plugin-ecdict](https://github.com/pot-app/pot-app-translate-plugin-ecdict)（release 的 .potext 自带 812MB stardict.db）。
  手动安装法：`.potext` 是 zip，解压到 `~/.config/com.pot-app.desktop/plugins/translate/plugin.com.pot-app.ecdict/`，
  再把 `translate_service_list` 里的 `ecdict` 换成 `plugin.com.pot-app.ecdict@<随机后缀>`，重启 pot。
- **Google TTS（ffplay 播放）**：见 `plugins-contrib/google-tts/`。Google Translate TTS 免费免 key；
  因 WebKitGTK WebAudio 音频管道故障（见下「已知限制」），插件不返回音频给前端，而是直接调系统 `ffplay` 播放
  （利用插件 `utils.run` 可执行任意命令的特性）。单条限 ~200 字符。

## 排障方法论（这次趟出来的）

1. **先分症状再动手**：进程活着吗？端口通吗？（`pgrep -x pot` / `curl 127.0.0.1:60828/__health`）窗口在 niri 里存在吗？（`niri msg windows`）渲染了吗？（grim 差分）一层层剥。
2. **grim 差分验证渲染**：`grim before.png` → 触发 → `grim after.png` → 转 RGB 后 `ImageChops.difference`。
   - `getbbox()` 在 RGBA 差分图上会因 alpha 通道全零误判"无差异"——**先转 RGB**。
   - 全屏差分会被背景动态（视频、流式 UI）污染——**裁剪窗口矩形区域**再判（坐标 = (输出逻辑坐标+窗口相对位置)×scale）。
   - 触发和截图必须在**同一条命令**里：中间隔一次 Hermes 审批点击，焦点切换就会让失焦关窗的窗口消失。
3. **`GET /` 会建翻译窗口**（server.rs 把 `/` 路由到 handle_translate）！健康检查用 `/__health` 之类的未知路径，否则幽灵空窗口会抢走下一次触发的"新建窗口"路径。
4. **双实例陷阱**：第一个实例独占 :60828，之后启动的收不到任何请求。AppImage 的外层+内层是两个 pid 但是一个实例；用 `ss -tlnp | grep 60828` 认端口归属。
5. **别信启动环境变量**：AppImage 钩子会覆盖 `GDK_BACKEND`——以 `/proc/<pid>/environ` 为准。
6. **pactl 输出是本地化的**：中文系统里没有 "Sink Input" 字样，采样音频流要 grep `application.name`。

## 已知限制

- **WebKitGTK WebAudio 平台级故障**（本机，PipeWire 1.6 + 蓝牙输出）：AudioContext 状态正常、GStreamer 正常向
  pulse 环形缓冲写数据，但管道几乎立即 cork，且 pactl 里不出现音频流。MiniBrowser 同样复现。
  绕过方案 = 上面 Google TTS 插件的 ffplay 路线。根因待查（欢迎 issue 补充线索）。
- 词典类（ecdict/cambridge）结果是结构化对象，目标区域底部按钮（含播放）被上游代码硬编码禁用
  （`isDisabled={typeof result !== 'string' || result === ''}`）——需改前端才能解。
- Google TTS 单条 ~200 字符上限，长段落会失败。
