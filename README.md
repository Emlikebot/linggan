# 灵感

刷 X、小红书、微信、Telegram 时随手截的屏，丢进来就只留下文字。像备忘录一样一条一条存，三端同步，24 小时后自动起标题、存进 Google Drive。

一套代码，三个平台（和「此刻」「SUC」同一套做法）：
- **iPhone**：PWA（网页应用），Safari 打开 GitHub Pages 网址 → 分享 → 添加到主屏幕
- **Windows**：Edge / Chrome 打开同一网址 → 地址栏右侧「安装」
- **安卓**：Capacitor 打包的 APK，GitHub Actions 自动编译，下载地址（始终最新）：
  https://github.com/Emlikebot/linggan/releases/latest/download/linggan.apk

服务器是你 Google 账号下的 **Apps Script 网页应用**（`google-drive/Code.gs`），免费、不用自建服务器。OpenRouter API Key 只存在服务器上，不会出现在 App 代码里。

## 功能
- **添加截屏**：右下角按钮，一次最多选 **10 张**（选多了自动取前 10 张），同时识别 3 张
  - Windows：也可以把截屏**拖进窗口**，或者 **Ctrl+V 粘贴**
  - 安卓：相册里选中截屏 → **分享 → 灵感**，打开就开始识别（APK 和 Chrome 安装的 PWA 都支持）
  - iPhone：可以设一个「快捷指令」，相册里 **分享 → 存到灵感**，后台识别（App「设置 → 看步骤」里有详细步骤）
- **只提取文字**：服务器调 OpenRouter 的看图模型（默认 `~google/gemini-flash-latest`），只要正文，忽略状态栏、按钮、点赞数、广告；保留作者昵称、发布时间、聊天里谁说的话。同时判断来源（X / 小红书 / 微信 / Telegram / 微博 / 抖音 / 知乎 / 其他）
  - 发送前在手机上压缩成 JPEG；**长截屏**自动切成几段一起识别（重叠部分只保留一次）
  - 没有文字的截屏直接跳过
- **图片不留档**：截屏只在识别时经过服务器内存，识别完就丢；手机上排队的截屏识别成功后立刻删除。任何地方都不保存截屏
- **像备忘录**：按「今天 / 昨天 / 过去 7 天 / 过去 30 天 / 按月」分组；每张截屏单独一条；点开直接改文字和标题，自动保存；搜索（高亮）；按来源筛选；电脑上左右两栏
- **合并 / 删除**：点「选择」勾几条 → 「合并」按提取时间从早到晚拼成一条（记作 N 张截屏）；「删除」同时把 Drive 里的文件移到回收站
- **24 小时后**：服务器每小时整理一次，满 24 小时的内容让 AI 起一个 6–18 字的标题（自己写过标题的不改），然后存成 Markdown 上传到 Google Drive。之后再改或合并，Drive 里的文件会在一小时内跟着更新
- **离线**：没网时截屏先排队，联网自动识别；识别失败会自动重试，也可以手动「重试 / 放弃」；关掉 App 再开队列也还在
- **账号**：注册需要**一次性邀请码**（管理员在 App 里生成）；登录同一账号的 iPhone、安卓、Windows 自动同步；每个账号的内容互相看不到

## 部署（管理员做一次）
1. **GitHub**：新建仓库 `Emlikebot/linggan`，把这个文件夹推上去
   - 仓库 Settings → Pages → Source 选 `main` 分支根目录 → 得到网址 `https://emlikebot.github.io/linggan/`
   - 推送后 Actions 会自动编译安卓 APK 并发布到 Releases
2. **服务器**：打开 https://script.google.com → 新建项目 → 粘贴 `google-drive/Code.gs` 全部内容
   - 把顶部 `SETUP_CODE` 改成你自己的一串字 → 保存
   - 「部署」→「新建部署」→ 网页应用，执行身份「我」，访问权限「任何人」→ 部署并授权（提示未验证就点「高级 → 转至…」）
   - 复制 `…/exec` 结尾的网址
3. **App**：打开网址 → 登录页「⚙︎ 服务器设置」填入上面的网址 → 用 `SETUP_CODE` 当邀请码注册，第一个账号就是管理员
   - 把网址填进 `index.html` 里的 `DEFAULT_SERVER` 再推送，朋友打开就不用自己填服务器
4. **OpenRouter**：App「设置 → 管理员 → 服务器配置」填 Key → 保存（会自动创建每小时整理一次的定时任务，时区自动用你手机的）→ 点「测试 Key」。可以用同一个 Key，也可以在 https://openrouter.ai/keys 单独建一个
5. 在「管理员 → 邀请码」里给朋友生成邀请码，点「复制」把安装说明一起发过去

以后改了 `Code.gs`：Apps Script「部署 → 管理部署 → 铅笔 → 版本选新版本 → 部署」，网址不变。

## 数据在哪
- Google Drive「灵感云端」文件夹，每个账号一个子文件夹：
  - `notes.json` 全部内容（App 同步用）
  - `笔记/YYYY-MM/MM-dd HH.mm 标题.md` 满 24 小时的每条内容（在 App 里删除，这里的文件会移到 Drive 回收站）
- 账号、密码（加盐哈希）、邀请码、OpenRouter Key、配置存在 Apps Script 的「脚本属性」里
- 手机 / 电脑本机：IndexedDB 里缓存内容，和还没识别完的截屏（识别完就删）

## 费用
每张截屏一次看图请求，每条内容再一次很短的起标题请求，都用便宜的 Gemini Flash。实际花费在 OpenRouter 后台看，App「管理员 → 测试 Key」也会显示已用和剩余额度。

## 安卓版构建
推送到 main 后，`.github/workflows/android.yml` 会：`npm ci` → `scripts/build-www.mjs`（把网页和 Capacitor 脚本打包进 `www/`）→ `npx cap add android` → 覆盖 `android-res/` 里的图标和启动图 → `scripts/patch-android.py`（给 `AndroidManifest.xml` 加上接收图片分享的 intent-filter，换上 `android-native/` 里的 `MainActivity` 和 `ShareInPlugin`）→ `gradlew assembleRelease` → 用 `android-signing/linggan.jks` 签名 → 发布到 Releases。
- 版本号 = Actions 运行编号，App 内「设置」会提示新版本，覆盖安装即可
- 签名密钥放在仓库里是为了免配置；如需更安全，可在仓库 Secrets 里设置 `ANDROID_KEYSTORE_B64` 和 `ANDROID_KEYSTORE_PASS`（会优先使用）。换密钥后需要卸载重装
- 图标：`icons/icon-source.png` 是原图（`scripts/draw_icon_source.py` 画的），换图标时替换它再运行 `python3 make_icons.py`

## 测试
`test/` 里有一套端到端测试：用 Node 模拟 Apps Script 运行 `Code.gs`（OpenRouter 也是模拟的），再用 Chrome 跑完整流程——注册、一次选 12 张只取 10 张、长截屏切段、无文字跳过、图片不留档、三端同步、编辑、合并、删除、24 小时后起标题和上传 Drive、改动后更新 Drive、拖拽 / 粘贴、安卓分享、离线排队、失败重试、快捷指令接口、邀请码。
```bash
npm ci && npm i --no-save playwright && npx playwright install chromium
node test/e2e.mjs        # 需要改 e2e.mjs 里 Chrome 的 executablePath
```
截图会存在 `test/out/`。

## 文件
- `index.html` 应用全部界面与逻辑
- `manifest.webmanifest`（含安卓分享入口 `share_target`）、`sw.js` PWA 配置、离线缓存、接收分享（改了文件后把 `sw.js` 里的 `CACHE` 版本号 +1）
- `google-drive/Code.gs` 服务器
- `icons/`、`make_icons.py`、`scripts/draw_icon_source.py` 图标
- `capacitor.config.json`、`package.json`、`scripts/build-www.mjs`、`scripts/patch-android.py`、`android-native/`、`android-res/`、`android-signing/`、`.github/workflows/` 安卓打包
- `test/` 测试

## 本地预览
```bash
python3 -m http.server 8000
```
