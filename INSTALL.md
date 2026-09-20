# 安装到另一台电脑

仓库地址：**https://github.com/YEJASONJIEXIN/dsh-whale-girl-pet**

---

## 一条命令装完（推荐）

```sh
dsh plugin --profile web add github:YEJASONJIEXIN/dsh-whale-girl-pet
```

然后**重启 `dsh web`**，刷新浏览器页面。

就这样。这条官方指令会一次做完三件事：

1. 把包拉下来装进 web profile 的 `node_modules`；
2. 拿到**代码 + 全部 54 个动画素材**（50 个播放动画 + 4 张预览，约 26 MB）；
3. **自动把 `dsh-whale-girl-pet` 登记进 `dsh.profile.bundles`** ——
   这是 `dsh plugin` 内置的行为：它会检查依赖里哪些包声明了 `dsh.bundle.patch`，
   把这些自动加进 bundle 层栈（见 `@deepseek-ai/dsh/lib/plugin-*.js` 的 `reconcilePlugins`）。
   **不需要手动改任何配置文件。**

> 已实测：全新 `DSH_HOME` 跑这一条命令 → 50 个 `.webm` 就位、`bundles` 自动变成
> `[dsh-base, dsh-web-app, dsh-whale-girl-pet]`。

### 装过官方版的话

如果这台机器上已经有官方 `dsh-whale-girl-pet`，上面的命令会把依赖替换成你的仓库版本，
`bundles` 里那一条本来就在，不会重复。

### 网络受限时（本机就是这种情况）

`github:` 走的是 `git clone`，而很多网络下 `github.com:443` 是被拦的。若报
`Connection was reset` / `Could not connect to server`，让 git 走 SSH over 443：

```
# ~/.ssh/config
Host github.com
  HostName ssh.github.com
  Port 443
  User git
  IdentityFile ~/.ssh/id_ed25519
```

Windows 上还有一个坑：**git 自带的 ssh**（`D:\Program Files\Git\usr\bin\ssh.exe`）
可能读不到你的 `~/.ssh/config`（它把 `~` 解析到别处），表现是"配了还连 22 端口"。
让 git 改用系统 OpenSSH 即可：

```sh
git config --global core.sshCommand '"C:/Windows/System32/OpenSSH/ssh.exe"'
```

也可以改用 SSH 形式的地址绕过这个问题：

```sh
dsh plugin --profile web add "git+ssh://git@github.com/YEJASONJIEXIN/dsh-whale-girl-pet.git"
```

---

## 备用方式一：离线 tarball

如果目标机器根本连不上 GitHub，用打好的包：

```
dsh-whale-girl-pet-0.3.2-fork.1.tgz   （约 27 MB，含全部素材）
```

```sh
dsh plugin --profile web add "D:\path\to\dsh-whale-girl-pet-0.3.2-fork.1.tgz"
```

同样会自动登记 bundle，然后重启 `dsh web`。
（tarball 不在仓库里，需要从打包目录拷过去；内容与仓库版一致。）

---

## 备用方式二：克隆后本地安装

```sh
git clone git@github.com:YEJASONJIEXIN/dsh-whale-girl-pet.git
cd dsh-whale-girl-pet

dsh plugin --profile web add .
```

`dsh plugin` 会把相对路径按**你当前所在目录**解析（不会误解析到 profile 目录里），
所以 `add .` 就装的是这个 checkout。`assets/` 已经在仓库里，不用另外补。

---

## 检查清单

1. **重启 `dsh web`** —— `lib/` 下的任何改动都要重启才生效（宿主与浏览器半侧都是启动时载入内存的）。
2. **刷新浏览器页面** —— 客户端 bundle 同理。
3. 桌宠出现在右下角；鼠标移上去会浮出 ☁️ 💰 🍪 📊 四个按钮，并有**拖拽缩放手柄**在右下角。
4. 打开 **设置 → 桌宠配置**，应能看到：
   桌宠大小（滑块 + 预设）· 任务播报语音 · 播报引擎 · 16 个角色音色 · 自定义音调语速。
5. 点「🔊 念一句」有声音；点角色名字会直接试听。
6. 随便让 Agent 做点事，跑完后应该听到「「任务名」完成啦，收工！」。

---

## 可能需要调的地方

### DSH 版本
本包按 **DSH 0.1.6-alpha.2** 的契约声明 peer。如果你的 DSH 在别的 alpha 线上，
`pnpm install` 会提示**未满足 peer**——这只是警告，通常不影响运行。
想消除就改 `package.json` 的 `peerDependencies`，把 `^0.1.6-alpha.2` 换成对应线
（例如 `^0.1.7-alpha.1`）。

### 角色语音需要联网
「角色音色」用的是微软 Edge 的在线神经网络语音，这台机器需要能访问：

```
speech.platform.bing.com:443
```

访问不了时会**自动退回浏览器内建语音**（机械音，但依然会念），不会变成没声音。
建议系统里装一个中文语音包，否则兜底路径可能用英文音色念中文。

### 想完全不联网
设置 → 桌宠配置 → 播报引擎 → 选 **系统语音**，就全走本地了。

---

## 常见问题

**Q：桌宠不见了 / 插件没加载？**
先看 `dsh web` 启动输出有没有报错。如果用的是手工拷目录的方式，
确认 `dsh.profile.bundles` 里有 `dsh-whale-girl-pet`（用官方 `dsh plugin add` 会自动加）。

**Q：装好了但有桌宠没动画 / 一直空白？**
说明 `assets/` 没到位。检查
`<DSH_HOME>/profiles/web/node_modules/dsh-whale-girl-pet/assets/thumb/` 里
是否有 50 个 `.webm`。用官方指令从仓库装的话一定有；手工拷目录容易漏这一层。

**Q：看不到按钮？**
按钮是**鼠标移入桌宠才显示**的。移到鲸鱼娘身上就会浮出来；触屏设备常显。

**Q：语音没声音？**
按顺序排查：① 设置里「任务播报语音」是否开着；② 浏览器要求页面先有过交互才允许出声——
先点一下页面；③ 站点是否被静音；④ 点「🔊 念一句」单独试听，它会走同一条链路。

**Q：天气 / 余额拿不到？**
这两个功能走宿主进程直连（不经过 shell），任意沙箱策略下都该能用。
失败时在浏览器打开 `/api/whale-pet/weather` 和 `/api/whale-balance` 看返回的 JSON 错误。
余额需要在 `%DSH_HOME%\.credentials.yaml` 里有 `DEEPSEEK_API_KEY`。
