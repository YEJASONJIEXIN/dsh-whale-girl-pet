# 安装到另一台电脑

三种方式，按需要挑一种。

---

## 方式 A：用 tarball 装（推荐，最省事）

需要拷贝的文件只有一个：

```
dsh-whale-girl-pet-0.3.2-fork.1.tgz   （约 27 MB，含全部动画素材）
```

在另一台电脑上：

```sh
# 1) 先确认 DSH 能跑起来
dsh --profile web

# 2) 把这个包加进 web profile（<路径> 换成 tarball 实际位置）
dsh plugin --profile web add "D:\path\to\dsh-whale-girl-pet-0.3.2-fork.1.tgz"
```

`dsh plugin add` 会把包加进 `$DSH_HOME/profiles/web/package.json`，但**不会自动加进 `dsh.profile.bundles`**，所以要手动补一步：

打开 `%DSH_HOME%\profiles\web\package.json`（默认 `C:\Users\<你>\.dsh\profiles\web\package.json`，或 `$env:DSH_HOME` 指向的位置），确认这两处都有它：

```json
{
  "dependencies": {
    "dsh-whale-girl-pet": "file:dsh-whale-girl-pet-0.3.2-fork.1.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-whale-girl-pet"        // ← 必须有这一行，插件才会被挂载
      ]
    }
  }
}
```

然后**重启 `dsh web`** 并刷新浏览器页面。

> 如果这台机器之前装过官方版 `dsh-whale-girl-pet`，`bundles` 里已经有这个名字了，
> 只要依赖指向 tarball 即可，不用改 `bundles`。

---

## 方式 B：直接把目录拷过去

如果懒得折腾 tarball，也可以手工复制安装：

1. 在另一台电脑上确认已经有 web profile：
   `%DSH_HOME%\profiles\web\`
2. 新建目录 `%DSH_HOME%\profiles\web\node_modules\dsh-whale-girl-pet\`
3. 把本仓库里的 `lib/`、`cordis.patch.yml`、`package.json`，以及动画素材 `assets/`
   （从 tarball 或上游包里取）拷进去
4. 按上面方式 A 的第 3 步，把 `dsh-whale-girl-pet` 加进 `bundles`
5. 重启 `dsh web`

手工拷出来的目录不会被 pnpm 管理，`pnpm install` 时可能被清掉——要长期用建议走方式 A。

---

## 方式 C：从源码目录装

如果你把本仓库 `git clone` 到了另一台电脑：

```sh
git clone <你的仓库地址> dsh-whale-girl-pet-hutao
cd dsh-whale-girl-pet-hutao

# 仓库里不含动画素材（见 .gitignore 说明），先从 tarball 或上游取回 assets/
# 然后：
dsh plugin --profile web add "file:$(pwd)"
```

---

## 装完之后的检查清单

1. **重启**：`lib/` 下的任何改动都要重启 `dsh web` 才生效（宿主与浏览器半侧都是启动时载入内存的）。
2. **刷新页面**：客户端 bundle 同理，重启后要刷新浏览器。
3. 桌宠出现在右下角，鼠标移上去会浮出 ☁️ 💰 🍪 📊 四个按钮。
4. 打开 **设置 → 桌宠配置**，应该能看到：
   - 桌宠大小（滑块 + 预设）
   - 任务播报语音 / 播报引擎 / 16 个角色音色 / 自定义音调语速
5. 点「🔊 念一句」能听到声音；点角色名字会直接试听。

---

## 可能需要调的地方

### DSH 版本
本包按 **DSH 0.1.6-alpha.2** 的契约声明的 peer。如果你的 DSH 是别的 alpha 线，
`pnpm install` 会**提示未满足 peer**（只是警告，通常不影响运行）。
真要消除警告，就改 `package.json` 里的 `peerDependencies`，把 `^0.1.6-alpha.2`
换成对应的线（例如 `^0.1.7-alpha.1`）。

### 角色语音需要联网
播报的「角色音色」走的是微软 Edge 的在线神经网络语音。这台机器需要能访问：

```
speech.platform.bing.com:443
```

访问不了时会**自动退回浏览器内建语音**（机械音，但仍然会念），不会没声音。
另外浏览器/系统里最好装了中文语音包，否则兜底路径也可能是英文音色念中文。

### 想彻底不联网
设置 → 桌宠配置 → 播报引擎 → 选 **系统语音**，就完全走本地了。

---

## 常见问题

**Q：桌宠不见了 / 插件没加载？**
看 `dsh web` 的启动输出有没有报错。最常见的原因是 `bundles` 里没加
`dsh-whale-girl-pet`（只加进了 `dependencies` 是不够的）。

**Q：按钮点不动 / 看不到按钮？**
按钮是**鼠标移入桌宠才显示**的。把鼠标移到鲸鱼娘身上（或她附近的区域）就会浮出来。
触屏设备上按钮常显。

**Q：语音没声音？**
1. 设置里「任务播报语音」是否开着；
2. 浏览器要求页面先有过交互才允许出声 —— 点一下页面再试；
3. 系统音量 / 浏览器是否静音了该站点；
4. 点「🔊 念一句」单独试听，它同时会告诉你是角色语音还是系统语音在工作。

**Q：天气/余额还是拿不到？**
这两个功能现在走宿主进程直连（不再经过 shell），所以在任意沙箱策略下都该能用。
如果失败，用浏览器打开这两个地址看返回的 JSON 错误：
`/api/whale-pet/weather` 和 `/api/whale-balance`。
余额需要在 `%DSH_HOME%\.credentials.yaml` 里有 `DEEPSEEK_API_KEY`。
