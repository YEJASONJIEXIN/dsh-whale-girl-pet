/**
 * ============================================================================
 * dsh-pet 宿主半侧（host half）—— 宠物插件的"后端"部分
 * ============================================================================
 *
 * 【这个文件是什么】
 *   本文件运行在 DSH 的 Node 服务端（不是浏览器）。它的唯一职责是：
 *   在 DSH 的 Web 服务器上注册一个 `/pet/` 前缀的 HTTP 路由，
 *   把插件包里的动画 WebM 文件流式返回给浏览器。
 *
 * 【为什么需要它】
 *   DSH 的 `/plugins/` 路由只服务"客户端 JS bundle"，不服务视频等静态资源。
 *   所以浏览器半侧（lib/client.js）要播放动画，必须有一个专门的路由来取文件。
 *   这正是 DSH 官方提供的扩展点：`ctx.webServer.register()`。
 *
 * 【路由结构】
 *   /pet/thumb/<动画名>.webm   → 读插件包内 assets/thumb/（360×360 播放变体）
 *   /pet/full/<动画名>.webm    → 读 $DSH_HOME/pet-assets/（原始 1200×1200，需先下载）
 *
 * 【安全性】
 *   路径做了"防穿越"校验（resolveAsset）：请求里的路径规范化后必须仍在
 *   assets 根目录内，否则返回 400。防止 /pet/../../etc/passwd 这类攻击。
 *
 * ============================================================================
 */
import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
// 官方 API：解析 DSH 主目录（$DSH_HOME，默认 ~/.dsh）——full 资源存放位置
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
// 本 fork：设置面板（DSH 设置 → 桌宠配置，持久化到 settings.yaml 用户层）
// 注意：不依赖 @deepseek-ai/dsh-settings 的 settingsNamespace 导出——
// 当前 DSH 的 dsh-settings（0.1.2-alpha.3）已不再导出该符号（只导出
// SettingsProvider / redactSecrets / SettingsConflictError），DSH 也不做
// 兼容 shim，所以这里直接用字面量命名空间字符串（'whale-pet' 本身满足
// /^[a-z][a-z0-9-]*$/ 校验，settingsNamespace() 当时也只是原样返回校验后的值）。
import Schema from '@deepseek-ai/schemastery';
// 本 fork：用量与计费（价格表 + 事件折叠 + 三桶费用）。抽成独立模块，便于单测。
import { computeTaskUsage, computeTodayUsage, taskSummaryLines } from './usage.js';
// 本 fork：costUsage 投影（浏览器半侧费用 pill 读取，与上面同一套计费内核）
import { createCostUsageProjection } from './cost-projection.js';
// 本 fork：分时段用量账本（气泡看板「分时段花费」的数据源）
import { createUsageLedger, DEFAULT_WINDOW_DAYS } from './usage-ledger.js';
// 本 fork：角色语音（Edge 神经网络 TTS）。零依赖、自带 WebSocket 实现，见 lib/edge-tts.js。
import { synthesize as edgeSynthesize, listVoices as edgeListVoices } from './edge-tts.js';

// 插件行 id（与 cordis.patch.yml 一致）
const name = 'pet';
/** 需要注入的服务：webServer（路由）、settings（配置命名空间）、sessionProjections（费用投影）、
 *  sessions + sessionPersistence（气泡看板的历史补扫：把已落盘会话补进分时段账本）。
 *  sessionPersistence 在 patch 树里若被移除，本插件仍能加载（可选取得），
 *  只是看板退化为「仅本次运行实时统计」。 */
const inject = ['webServer', 'settings', 'sessionProjections', 'sessions', 'sessionPersistence'];

/** settings namespace（settings.yaml 用户层 section 名）。 */
const NS = 'whale-pet';

// ============================================================================
// 本 fork 新增：角色音色表
// ----------------------------------------------------------------------------
// 说明清楚一点，免得误会：这些**不是**把某位声优的录音搬过来，而是用 Edge 的
// 神经网络语音（zh-CN / zh-HK / zh-TW 共 14 个真人感音色，带 Warm / Lively /
// Cute / Passion / Humorous 等性格标签）+ 音调语速，去贴近角色的说话感觉。
// 想要更像本人，就在设置面板里选「自定义」自己调音调/语速 —— 每一条预设都能改。
//   voice: Edge ShortName；pitch: 音调（Hz）；rate: 语速（%）
// ============================================================================
export const VOICE_CHARACTERS = [
  { id: 'hutao', name: '胡桃', note: '往生堂堂主：活泼俏皮、尾音上扬', voice: 'zh-CN-XiaoyiNeural', pitch: '+60Hz', rate: '+15%' },
  { id: 'paimon', name: '派蒙', note: '又高又冲的贪吃小人', voice: 'zh-CN-YunxiaNeural', pitch: '+85Hz', rate: '+24%' },
  { id: 'zhongli', name: '钟离', note: '岩王帝君：沉稳低音、不紧不慢', voice: 'zh-CN-YunjianNeural', pitch: '-35Hz', rate: '-10%' },
  { id: 'nahida', name: '纳西妲', note: '小小草神：温柔清亮', voice: 'zh-CN-XiaoxiaoNeural', pitch: '+45Hz', rate: '-4%' },
  { id: 'klee', name: '可莉', note: '奶声奶气的小爆破狂', voice: 'zh-CN-XiaoyiNeural', pitch: '+95Hz', rate: '+8%' },
  { id: 'furina', name: '芙宁娜', note: '水神：做作的戏剧腔', voice: 'zh-CN-XiaoxiaoNeural', pitch: '+25Hz', rate: '+6%', style: 'newscast-casual' },
  { id: 'raiden', name: '雷电将军', note: '冷硬威严、缓慢', voice: 'zh-CN-XiaoxiaoNeural', pitch: '-20Hz', rate: '-16%' },
  { id: 'ganyu', name: '甘雨', note: '柔柔的、有点困', voice: 'zh-CN-XiaoxiaoNeural', pitch: '+15Hz', rate: '-8%' },
  { id: 'xiao', name: '魈', note: '孤冷少年', voice: 'zh-CN-YunxiNeural', pitch: '-25Hz', rate: '-6%' },
  { id: 'qiqi', name: '七七', note: '没有起伏的小僵尸', voice: 'zh-CN-XiaoyiNeural', pitch: '+40Hz', rate: '-25%' },
  { id: 'dongbei', name: '东北大姨', note: '辽宁口音，自带幽默', voice: 'zh-CN-liaoning-XiaobeiNeural', pitch: '+15Hz', rate: '+10%' },
  { id: 'shaanxi', name: '陕西妹子', note: '陕西口音，明亮爽利', voice: 'zh-CN-shaanxi-XiaoniNeural', pitch: '+15Hz', rate: '+8%' },
  { id: 'hk', name: '港风女声', note: '粤语腔普通话', voice: 'zh-HK-HiuMaanNeural', pitch: '+10Hz', rate: '+4%' },
  { id: 'tw', name: '台湾软妹', note: '台湾腔，软软的', voice: 'zh-TW-HsiaoChenNeural', pitch: '+20Hz', rate: '+2%' },
  { id: 'boy', name: '清爽少年', voice: 'zh-CN-YunxiNeural', pitch: '+45Hz', rate: '+14%' },
  { id: 'news', name: '正经播报', voice: 'zh-CN-YunyangNeural', pitch: '+0Hz', rate: '+2%' },
];

/** 按 id 取角色音色；未知 id 退回第一个（胡桃）。 */
function voiceCharacterOf(id) {
  const key = String(id || '');
  return VOICE_CHARACTERS.find((item) => item.id === key) || VOICE_CHARACTERS[0];
}

/**
 * 拼一条播报载荷：
 *   script    —— 交给角色神经网络语音念的整句
 *   system    —— 退回浏览器内建语音时念的同一句
 *   character —— 用哪个角色音色（客户端合成时回传，保证和设置一致）
 * @param config - 当前设置（取 voiceCharacter）
 * @param text   - 要念的整句
 */
function speechPayload(config, text) {
  const character = String((config && config.voiceCharacter) || 'hutao');
  return { script: String(text || ''), system: String(text || ''), character };
}

/**
 * 任务播报的固定话术。这几句会在启动后预热合成好并按角色缓存，
 * 于是"任务完成"这种高频播报不用现场等合成。
 */
const ANNOUNCE_LINES = ['任务完成啦，收工！', '任务中断了，先停一下～', '任务失败了，回头看看日志吧'];

/**
 * 合成结果缓存。键 = 角色音色 + 音调 + 语速 + 文本；任务名每次都不同，
 * 所以命中率主要来自固定话术与重复任务。上限 40 条，逐出最早的一条。
 */
const speechCache = new Map();
const SPEECH_CACHE_MAX = 40;

/** 带缓存的合成（外层再做一次重试：这个服务偶尔会握手后不返回音频）。 */
async function synthesizeCached(options) {
  const key = [options.voice, options.pitch, options.rate, options.text].join('|');
  const hit = speechCache.get(key);
  if (hit) return hit;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const audio = await edgeSynthesize({
        text: options.text,
        voice: options.voice,
        pitch: options.pitch,
        rate: options.rate,
        timeoutMs: 20000,
      });
      if (!audio || audio.length === 0) throw new Error('没有拿到音频');
      if (speechCache.size >= SPEECH_CACHE_MAX) {
        const oldest = speechCache.keys().next();
        if (!oldest.done) speechCache.delete(oldest.value);
      }
      speechCache.set(key, audio);
      return audio;
    } catch (error) {
      lastError = error;
      // 令牌过期/服务端抖动：换个令牌再来一次
    }
  }
  throw lastError;
}


/** 桌宠可配置项（设置面板可改，重启不丢）。 */
export const Config = Schema.object({
  pomodoro: Schema.boolean().default(true),
  pomodoroMinutes: Schema.number().min(5).max(120).default(25),
  lateNight: Schema.boolean().default(true),
  chatter: Schema.boolean().default(true),
  longTaskMinutes: Schema.number().min(1).max(60).default(10),
  city: Schema.string().default(''),
  size: Schema.number().min(40).max(400).default(260),
  position: Schema.string().default('bottom-right'),
  // 本 fork 新增：漫游开关（关掉后宠物不乱跑，只在角落/当前位置待着，拖拽仍可用）
  roam: Schema.boolean().default(true),
  // 本 fork 新增：按钮组位置（☁️/💰/🍪 放在宠物左侧还是右侧；left / right）
  buttonSide: Schema.string().default('left'),
  // 本 fork 新增：气泡看板——分时段花费面板
  // dashboardHistory: 启动时补扫已落盘会话（含重启前的用量），关掉则只统计本次运行
  dashboardHistory: Schema.boolean().default(true),
  // dashboardWindowDays: 保留并展示的日趋势长度（今日 + 之前 N-1 天）
  dashboardWindowDays: Schema.number().min(1).max(30).default(7),
  // 本 fork 新增：任务播报语音（完成 / 中断 / 失败时念出来，并带上任务名）
  // voiceEnabled: 总开关；voiceCharacter: 角色音色 id（见 VOICE_CHARACTERS）
  // voicePitch / voiceRate: 自定义音调语速（voiceCharacter === 'custom' 时生效）
  // voiceEngine: 'edge'=角色神经网络语音（默认）| 'system'=浏览器内建语音
  voiceEnabled: Schema.boolean().default(true),
  voiceCharacter: Schema.string().default('hutao'),
  // 自定义覆盖：voicePitchVoice 为空则用角色预设的底层音色
  voicePitchVoice: Schema.string().default(''),
  voicePitch: Schema.string().default(''),
  voiceRate: Schema.string().default(''),
  voiceEngine: Schema.string().default('edge'),
});

/** 读取请求体（有上限）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 65536) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** 本包目录（src 和安装后都适用——import.meta.url 指向 lib/，上一级即包根） */
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 路由前缀：/pet/thumb/<name>.webm、/pet/full/<name>.webm */
const ROUTE_PREFIX = '/pet';

/** 不同扩展名对应的 Content-Type 映射 */
const MIME = {
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

/**
 * 规范化并校验请求路径，确保它在 assets 根目录内（防路径穿越）。
 * @param root - assets 根目录（绝对路径）
 * @param rel  - 解码后的、路由前缀之后的路径片段
 * @returns 规范化后的绝对文件路径；非法（穿越）时返回 undefined
 */
function resolveAsset(root, rel) {
  if (rel.length === 0) return undefined;
  // join + normalize 得到规范化路径（处理 ..、./、多余分隔符）
  const candidate = normalize(join(root, rel));
  // 根目录带分隔符的前缀，用于判断候选路径是否真的在根目录内
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  // 候选路径必须等于根目录或以"根目录/"开头，否则是穿越（如 ../lib/index.js）
  if (candidate !== root && !candidate.startsWith(rootWithSep)) return undefined;
  return candidate;
}

/**
 * 宿主插件主体：注册 `/pet` 前缀路由。
 * @param ctx    - 插件上下文；ctx.webServer 是 Web 服务器服务
 * @param config - 本行的配置（来自 patch 树）
 */
function apply(ctx, config) {
  // 两个资源根：
  // - thumbRoot：插件包内 assets/thumb/（360×360 播放变体，随包发布，一定存在）
  // - fullRoot ：$DSH_HOME/pet-assets/（原始母版，需手动下载，可能不存在）
  const thumbRoot = join(PACKAGE_ROOT, 'assets', 'thumb');
  const fullRoot = config.fullRoot ?? join(resolveDshHome(), 'pet-assets');

  // 本 fork：注册设置命名空间（schema 默认 → patch base → settings.yaml 用户层）
  ctx.settings.register(NS, Config, { base: config });
  const resolveConfig = () => {
    const resolved = ctx.settings.get(NS);
    return resolved && typeof resolved === 'object' ? resolved : config;
  };

  // 本 fork：注册 costUsage 投影（输入框下方费用 pill 读取；与气泡/余额共用 lib/usage.js）
  ctx.sessionProjections.register(createCostUsageProjection());

  // ============================================================================
  // 本 fork 新增：分时段用量账本（气泡看板 /api/whale-pet/usage 的数据源）
  // ----------------------------------------------------------------------------
  // 实时：ctx.on('session/event') 增量折叠（O(1) 每条事件，不轮询、不写盘）
  // 历史：启动时用 ctx.sessionPersistence 逐会话读回已落盘事件补扫一遍，
  //       让"重启前的今天早上"也留在小时桶里。
  // 去重：两条路径共用"每会话已见 seq 集合 + occurrence key"，所以无论
  //       谁先谁后都不会重复计数（见 lib/usage-ledger.js 的 seen()）。
  // 失败：历史补扫只是锦上添花——列表/读取失败会记进 scan 统计并由前端
  //       提示，同时退化为"仅本次运行实时统计"，不影响桌宠其他功能。
  // ============================================================================
  const ledger = createUsageLedger({
    windowDays: Number(resolveConfig().dashboardWindowDays) || DEFAULT_WINDOW_DAYS,
  });
  ctx.on('session/event', (session, event) => { ledger.fold(session, event); });

  if (resolveConfig().dashboardHistory !== false) {
    const persistence = ctx.get('sessionPersistence');
    // 延后一拍：别和宿主启动的关键路径抢时间；失败也只是退化为实时统计
    const boot = setTimeout(() => {
      ledger.scanFrom(persistence).catch(() => {});
    }, 1500);
    if (typeof boot.unref === 'function') boot.unref();
    ctx.effect(() => () => { clearTimeout(boot); }, 'dsh-whale-pet: dashboard history scan');
  }

  // ctx.effect 包裹：插件卸载时自动注销路由（官方生命周期管理）
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',     // 前缀路由：匹配 /pet 以及 /pet/xxx
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      // 去掉 /pet/ 前缀并 URL 解码（中文文件名是编码后的）
      const rest = decodeURIComponent(url.pathname.slice(ROUTE_PREFIX.length + 1));
      // 第一段是 scope：thumb 或 full
      const [scope, ...nameParts] = rest.split('/');
      if (scope !== 'thumb' && scope !== 'full') {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('dsh-pet: expected /pet/{thumb|full}/<file>');
        return;
      }
      // 剩余部分是文件名（可能含空格/中文，原样保留）
      const fileName = nameParts.join('/');
      const root = scope === 'thumb' ? thumbRoot : fullRoot;
      // 防穿越校验
      const file = resolveAsset(root, fileName);
      if (file === undefined) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('dsh-pet: invalid path');
        return;
      }
      // 文件不存在：full 未下载 vs thumb 缺失给不同提示
      if (!existsSync(file)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(scope === 'full'
          ? `dsh-pet: original asset not downloaded yet — run the fetch-assets script to populate ${fullRoot}`
          : 'dsh-pet: asset not found');
        return;
      }
      // 按扩展名定 Content-Type，附 Content-Length（浏览器可显示进度）
      const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
      const contentType = MIME[ext] ?? 'application/octet-stream';
      const { size } = await stat(file);
      res.writeHead(200, {
        'content-type': contentType,
        'content-length': size,
        // 缓存 1 小时：动画是静态文件，重复播放直接命中缓存
        'cache-control': 'public, max-age=3600',
      });
      // 流式返回（大文件不占内存）
      const stream = createReadStream(file);
      stream.on('error', () => {
        res.destroy();
      });
      stream.pipe(res);
    },
  }), 'dsh-pet: /pet asset route');

  // ============================================================================
  // 本 fork 新增：任务状态镜像 —— 监听 Agent 任务事件，供浏览器轮询
  // ============================================================================
  const queue = [];
  const MAX = 60;
  let seq = 0;
  // 本 fork 新增：任务名（播报用）——优先取本轮人类提问，取不到退到最近一次工具活动
  let taskName = '';
  let lastActivityName = '';
  // 回合去重：一轮只报一次（中断在 turn/end 报过，idle 就不再报"完成"）。
  // 用回合号而不是时间冷却——连着跑两个任务时，时间冷却会把第二个也吞掉。
  let currentTurn = 0;
  let announcedTurn;
  // 工作态计时（agent/status 与长任务提醒共用；提到这里以避免 TDZ）
  let runningSince = 0;
  let longTaskReminded = false;

  /** 把一段文本压成适合念出来的短任务名（去换行/多余空白，超长截断加省略号）。 */
  const shortTaskName = (text, limit) => {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    if (!flat) return '';
    const max = limit || 24;
    return flat.length > max ? flat.slice(0, max) + '…' : flat;
  };

  /** 当前任务名：本轮人类提问 → 会话里记下的任务名 → 最近工具活动。 */
  const currentTaskName = () => taskName || shortTaskName(lastActivityName, 16);

  /**
   * 生成播报内容。kind: done(完成) / interrupted(中断) / failed(失败)。
   * 返回 { text, system }：
   *   text   —— 用角色神经网络语音念的整句（由 /api/whale-pet/say 合成）
   *   system —— 退回到浏览器内建语音时念的文本（同一句，作为兜底）
   * 带任务名时念「任务名」，没名字时退回通用台词。
   */
  const announce = (kind) => {
    const who = currentTaskName();
    const quoted = who ? '「' + who + '」' : '';
    let text;
    if (kind === 'interrupted') text = who ? quoted + '中断了，先停一下～' : '任务中断了，先停一下～';
    else if (kind === 'failed') text = who ? quoted + '失败了，回头看看日志吧' : '任务失败了，回头看看日志吧';
    else text = who ? quoted + '完成啦，收工！' : '任务完成啦，收工！';
    // 走统一的载荷格式，带上当前角色音色
    return speechPayload(resolveConfig(), text);
  };

  const push = (item) => {
    seq += 1;
    const entry = { id: 'wp-' + seq, at: Date.now(), type: item.type };
    if (item.mood !== undefined) entry.mood = item.mood;
    if (item.ok !== undefined) entry.ok = item.ok;
    if (item.name !== undefined) entry.name = item.name;
    if (item.title !== undefined) entry.title = item.title;
    if (item.message !== undefined) entry.message = item.message;
    if (item.task !== undefined) entry.task = item.task;
    // 本 fork 新增：播报内容（客户端用语音念出来；开关由 voiceEnabled 控制）
    if (item.speak !== undefined) entry.speak = item.speak;
    queue.push(entry);
    if (queue.length > MAX) queue.shift();
  };

  // 本 fork 新增：记住本轮人类提问作为任务名。
  // source === 'human' 才是真人输入；agent.inject() 的合成上下文（文件变更通知、
  // 技能内容、goal 续跑等）不当作任务名。
  ctx.on('session/event', (session, event) => {
    if (!event) return;
    // 回合结束原因：只有这里能可靠地区分"被取消"和"正常完成/失败"
    // （`agent/status` 只有 idle/running，没有取消事件）。
    if (event.type === 'turn/end') {
      const turn = Number(event.data && event.data.turn);
      if (Number.isFinite(turn)) currentTurn = turn;
      const reason = event.data && event.data.reason;
      if (reason && reason.kind === 'aborted') {
        const name = currentTaskName();
        // 记下"这一轮已经报过了"：随后的 agent/status idle 不再重复报"完成"
        if (Number.isFinite(turn)) announcedTurn = turn;
        push({
          type: 'done',
          ok: false,
          task: name,
          speak: announce('interrupted'),
          title: '任务被中断',
          message: name ? '「' + name + '」被中断了～' : '这一轮任务被中断了～',
        });
        taskName = '';
        lastActivityName = '';
      }
      return;
    }
    if (event.type === 'turn/start') {
      const turn = Number(event.data && event.data.turn);
      if (Number.isFinite(turn)) currentTurn = turn;
      return;
    }
    if (event.type !== 'user/message') return;
    const data = event.data;
    if (!data || (data.source !== undefined && data.source !== 'human')) return;
    const content = Array.isArray(data.content) ? data.content : [];
    const text = content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join(' ');
    const name = shortTaskName(text, 24);
    if (name) taskName = name;
  });

  // 1) 回合状态：running → 工作（敲键盘），idle → 待机 + 完成提醒（4 秒冷却）
  //    本 fork：任务结束时统计本次任务（自开工以来所有会话，含子代理）的
  //    token 消耗与花费，附在完成气泡里。
  ctx.on('agent/status', (payload) => {
    if (!payload) return;
    if (payload.status === 'running') {
      runningSince = Date.now();
      lastActivityName = '';
      longTaskReminded = false;
      push({ type: 'mood', mood: 'working' });
    } else if (payload.status === 'idle') {
      const taskSince = runningSince;
      const name = currentTaskName();
      const turn = currentTurn;
      runningSince = 0;
      push({ type: 'mood', mood: 'idle' });
      const now = Date.now();
      // 本 fork：一轮只报一次。中断（turn/end aborted）和出错（agent/error）都已经
      // 在各自的处理器里报过并记下了回合号，这里不能再补一句"任务完成"。
      // 用回合号判断而不是时间冷却：连着跑两个任务时，时间冷却会把第二个也吞掉。
      if (announcedTurn === turn) return;
      announcedTurn = turn;
      let message = '这一轮任务已经搞定啦～';
      if (taskSince > 0) {
        // 完成气泡排版：多行结构化信息（用时 / 消耗 / 花费 + 命中·未命中·输出三桶），客户端左对齐展示
        const durSec = Math.round((now - taskSince) / 1000);
        const durStr = durSec >= 60 ? Math.floor(durSec / 60) + '分' + (durSec % 60) + '秒' : durSec + '秒';
        message = taskSummaryLines(durStr, computeTaskUsage(ctx, taskSince)).join('\n');
      }
      push({ type: 'done', ok: true, task: name, speak: announce('done'), title: '任务完成啦！', message });
      // 这一轮的任务名用完即弃：否则下一个任务（比如没有人类提问、只有注入上下文的
      // 续跑）会顶着上一个任务的名字播报，听起来像报错了任务。
      taskName = '';
      lastActivityName = '';
    }
  });

  // 2) 后台任务完成
  const jobs = ctx.get('jobs');
  if (jobs !== undefined) {
    ctx.effect(() => jobs.onJobDone((snapshot) => {
      if (!snapshot) return;
      const label = shortTaskName(snapshot.label || snapshot.id || '后台任务', 24);
      if (snapshot.status === 'completed') {
        push({ type: 'done', ok: true, task: label, speak: speechPayload(resolveConfig(), '「' + label + '」完成啦，收工！'), title: '后台任务完成！', message: '「' + label + '」搞定啦～' });
      } else if (snapshot.status === 'killed') {
        push({ type: 'done', ok: false, task: label, speak: speechPayload(resolveConfig(), '「' + label + '」中断了，先停一下～'), title: '后台任务被取消', message: '「' + label + '」被取消了～' });
      } else {
        push({ type: 'done', ok: false, task: label, speak: speechPayload(resolveConfig(), '「' + label + '」失败了，回头看看日志吧'), title: '后台任务出错了', message: '「' + label + '」翻车了' + (snapshot.detail ? '：' + String(snapshot.detail) : '') });
      }
    }));
  }

  // 3) 子代理结束
  ctx.on('subagent/end', (info) => {
    if (!info) return;
    const who = shortTaskName(info.label || info.provider || '子代理', 24);
    if (info.stopReason === 'completed') {
      push({ type: 'done', ok: true, task: who, speak: speechPayload(resolveConfig(), '「' + who + '」完成啦，收工！'), title: '子任务完成！', message: '「' + who + '」的活儿干完啦～' });
    } else if (info.stopReason === 'aborted') {
      push({ type: 'done', ok: false, task: who, speak: speechPayload(resolveConfig(), '「' + who + '」中断了，先停一下～'), title: '子任务被中止', message: '「' + who + '」结束了（' + String(info.stopReason) + '）' });
    } else {
      push({ type: 'done', ok: false, task: who, speak: speechPayload(resolveConfig(), '「' + who + '」失败了，回头看看日志吧'), title: '子任务出错了', message: '「' + who + '」结束了（' + String(info.stopReason) + '）' });
    }
  });

  // 4) 工作流结束
  ctx.on('workflow/end', (info, result) => {
    if (!info) return;
    const wfName = shortTaskName((info.meta && info.meta.name) || String(info.id || '工作流'), 24);
    const ok = result && result.stopReason === 'completed';
    push({
      type: 'done',
      ok: !!ok,
      task: wfName,
      speak: speechPayload(resolveConfig(), ok ? '「' + wfName + '」完成啦，收工！' : '「' + wfName + '」中断了，先停一下～'),
      title: ok ? '流程任务完成！' : '流程任务结束',
      message: ok ? '「' + wfName + '」工作流跑完啦～' : '「' + wfName + '」结束了（' + String(result && result.stopReason) + '）',
    });
  });

  // 5) 工具活动：让打字气泡显示真实工作内容（同时记下名字，作任务名的兜底）
  ctx.on('tools/result', (exec) => {
    if (exec && typeof exec.name === 'string' && exec.name) {
      lastActivityName = String(exec.name);
      push({ type: 'activity', name: String(exec.name) });
    }
  });

  // 6) 会话出错：炸毛 + 红色气泡
  ctx.on('agent/error', (payload) => {
    if (!payload) return;
    const errMsg = payload.error && payload.error.message ? String(payload.error.message) : String(payload.error);
    const name = currentTaskName();
    // 记下回合号：随后的 idle 不再补报"任务完成"
    announcedTurn = currentTurn;
    push({
      type: 'done',
      ok: false,
      task: name,
      speak: announce('failed'),
      title: '出错了！',
      message: '第 ' + String(payload.turn || '?') + ' 轮翻车了：' + errMsg.slice(0, 120),
    });
    taskName = '';
    lastActivityName = '';
  });

  // 6b) 中断（用户点停止）：DSH 没有 agent/abort 事件，可靠信号是
  //     session/event 里的 turn/end { reason.kind: 'aborted' }，见上面的处理器。

  // 7) 目标状态：达成 → 庆祝；受阻 → 红色提醒
  ctx.on('goal/changed', (payload) => {
    if (!payload || !payload.change) return;
    const op = payload.change.operation;
    if (op === 'complete') {
      push({ type: 'done', ok: true, task: currentTaskName(), speak: speechPayload(resolveConfig(), '目标达成啦，撒花！'), title: '目标达成！', message: '大目标完成，撒花～' });
    } else if (op === 'block') {
      push({ type: 'done', ok: false, task: currentTaskName(), speak: speechPayload(resolveConfig(), '目标受阻了，去看看？'), title: '目标受阻', message: '目标卡住了…去看看？' });
    }
  });

  // 8) 长任务提醒：工作超过 N 分钟（可在设置面板调）→ 敲桌子吐槽一次
  const timer = ctx.get('timer');
  if (timer !== undefined) {
    ctx.effect(() => {
      const dispose = timer.interval(() => {
        const minutes = Number(resolveConfig().longTaskMinutes) || 10;
        if (runningSince > 0 && !longTaskReminded && Date.now() - runningSince >= minutes * 60000) {
          longTaskReminded = true;
          push({ type: 'done', ok: true, title: '还没完呢…', message: '都干了 ' + minutes + ' 分钟了，还没完呢' });
        }
      }, 30000);
      return dispose;
    });
  }

  // 轮询接口：GET /api/whale-pet/state → 取走排队中的状态/通知 + 当前设置
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/whale-pet/state',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed');
        return;
      }
      const items = queue.splice(0, queue.length);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ items, settings: resolveConfig() }));
    },
  }), 'dsh-whale-pet: /api/whale-pet/state route');

  // 本 fork 新增：余额查询路由（同源，GET /api/whale-balance）
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/whale-balance',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed');
        return;
      }
      const out = await queryBalance(ctx);
      // 本 fork 新增：同一响应附上"今日 token 消耗 + 今日花费"（本地统计，不依赖余额接口）
      const usage = computeTodayUsage(ctx);
      res.writeHead(out.ok ? 200 : 502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ...out, usage }));    },
  }), 'dsh-whale-pet: /api/whale-balance route');

  // 本 fork 新增：天气查询（GET /api/whale-pet/weather）
  // 主路径：宿主进程内直接 fetch wttr.in（不经 shell，不受会话沙箱/审批影响）；
  // 兜底：只有当 Node 侧**网络层失败**（拿不到数据）时，才退回 ctx.shell 跑 PowerShell（原实现）。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/whale-pet/weather',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed');
        return;
      }
      const city = String((resolveConfig().city) || '').replace(/[^\w\u4e00-\u9fa5 \-]/g, '').slice(0, 40);
      let data;
      try {
        data = await queryWeatherNative(city);
      } catch (error) {
        data = { ok: false, error: redact(String(error && error.message ? error.message : error)) };
      }
      if (data && data.ok) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
        return;
      }
      // Node 侧失败：老实现兜底（沙箱/审批若把它也挡住，就把两边原因一起报给用户）
      const nativeError = data && data.error ? String(data.error) : '未知错误';
      const fallback = await queryWeatherViaShell(ctx, city);
      const out = fallback && fallback.ok
        ? fallback
        : { ok: false, error: nativeError + '；PowerShell 兜底也失败：' + String((fallback && fallback.error) || '未知错误') };
      res.writeHead(out.ok ? 200 : 502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out));
    },
  }), 'dsh-whale-pet: /api/whale-pet/weather route');

  // 本 fork 新增：天气查询的 PowerShell 兜底（旧实现原样保留，仅当 Node 出网失败时使用）
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/whale-pet/weather-shell',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed');
        return;
      }
      const city = String((resolveConfig().city) || '').replace(/[^\w\u4e00-\u9fa5 \-]/g, '').slice(0, 40);
      const out = await queryWeatherViaShell(ctx, city);
      res.writeHead(out && out.ok ? 200 : 502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out));
    },
  }), 'dsh-whale-pet: /api/whale-pet/weather-shell fallback route');
  // 本 fork 新增：分时段用量看板（GET /api/whale-pet/usage，气泡看板读取）
  //   ?days=1..30  覆盖窗口长度（默认取设置里的 dashboardWindowDays）
  //   ?hours=1..24 覆盖小时轴长度
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/whale-pet/usage',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed');
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parse = (name, min, max) => {
        const raw = Number(url.searchParams.get(name));
        return Number.isFinite(raw) && raw >= min && raw <= max ? Math.floor(raw) : undefined;
      };
      const hours = parse('hours', 1, 24);
      const days = parse('days', 1, 30) ?? Number(resolveConfig().dashboardWindowDays) ?? DEFAULT_WINDOW_DAYS;
      let data;
      try {
        data = ledger.snapshot({ hours, days });
      } catch (error) {
        data = { ok: false, error: String(error && error.message ? error.message : error) };
      }
      res.writeHead(data.ok ? 200 : 500, {
        'content-type': 'application/json; charset=utf-8',
        // 实时数据：绝不缓存
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(data));
    },
  }), 'dsh-whale-pet: /api/whale-pet/usage route');

  // 本 fork 新增：设置读写 API（GET/POST /api/whale-pet/settings）
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/whale-pet/settings',
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ value: resolveConfig(), writable: ctx.settings.writable }));
          return;
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const parsed = JSON.parse(body);
          const ops = parsed && Array.isArray(parsed.ops) ? parsed.ops : [];
          await ctx.settings.mutate(NS, ops);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed');
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }));
      }
    },
  }), 'dsh-whale-pet: settings routes');

  // ==========================================================================
  // 本 fork 新增：角色语音（Edge 神经网络 TTS）
  //   GET  /api/whale-pet/voices   → 角色预设 + Edge 可用语音列表（设置面板用）
  //   POST /api/whale-pet/say      → 合成一段语音，返回 base64 MP3（浏览器播）
  //   GET  /api/whale-pet/say?text=..&character=..  → 同上，便于直接试听/排查
  // ==========================================================================
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/whale-pet/voices',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed');
        return;
      }
      let list = [];
      let error;
      try {
        list = await edgeListVoices();
      } catch (err) {
        error = String(err && err.message ? err.message : err);
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, characters: VOICE_CHARACTERS, voices: list, error }));
    },
  }), 'dsh-whale-pet: /api/whale-pet/voices route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/whale-pet/say',
    handler: async (req, res) => {
      const respond = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(payload));
      };
      try {
        let params;
        if (req.method === 'GET') {
          const url = new URL(req.url ?? '/', 'http://localhost');
          // 也接受短名 ?text=，兼容直接用浏览器试听/排查
          const short = (url.searchParams.get('text') || '').trim();
          params = {
            text: short,
            character: url.searchParams.get('character') || '',
            voice: url.searchParams.get('voice') || '',
            pitch: url.searchParams.get('pitch') || '',
            rate: url.searchParams.get('rate') || '',
          };
        } else if (req.method === 'POST') {
          params = JSON.parse(await readBody(req));
        } else {
          res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('method not allowed');
          return;
        }
        const text = String((params && params.text) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!text) { respond(400, { ok: false, error: '缺少 text' }); return; }

        const config = resolveConfig();
        const character = String((params && params.character) || config.voiceCharacter || 'hutao');
        const preset = voiceCharacterOf(character);
        // 优先级：请求里显式传的 > 设置里的「自定义」> 角色预设。
        // 于是"选一个预设"和"自己挑底层音色微调"两条路都走得通。
        const voice = String((params && params.voice) || config.voicePitchVoice || preset.voice);
        const pitch = String((params && params.pitch) || config.voicePitch || preset.pitch || '+0Hz');
        const rate = String((params && params.rate) || config.voiceRate || preset.rate || '+0%');

        const audio = await synthesizeCached({ text, voice, pitch, rate });
        respond(200, { ok: true, character, voice, pitch, rate, mime: 'audio/mpeg', audio: audio.toString('base64') });
      } catch (error) {
        respond(502, { ok: false, error: redact(String(error && error.message ? error.message : error)) });
      }
    },
  }), 'dsh-whale-pet: /api/whale-pet/say route');

  // 预热：任务播报的固定话术按当前角色先合成好，这样第一条播报就不用等合成。
  // 放在启动后几秒、且失败只记不报（网络不通时自然退回到浏览器内建语音）。
  let prewarmedFor = '';
  const prewarmVoice = () => {
    const config = resolveConfig();
    const character = String(config.voiceCharacter || 'hutao');
    if (config.voiceEnabled === false || config.voiceEngine === 'system') return;
    if (prewarmedFor === character) return;
    prewarmedFor = character;
    const preset = voiceCharacterOf(character);
    for (const line of ANNOUNCE_LINES) {
      synthesizeCached({ text: line, voice: preset.voice, pitch: preset.pitch, rate: preset.rate }).catch(() => {});
    }
  };
  const prewarmTimer = setTimeout(prewarmVoice, 3000);
  if (typeof prewarmTimer.unref === 'function') prewarmTimer.unref();
  ctx.effect(() => () => { clearTimeout(prewarmTimer); }, 'dsh-whale-pet: voice prewarm');
}

// ============================================================================
// 本 fork 新增：DeepSeek 账户余额查询（GET /api/whale-balance）
// 复用本机 DEEPSEEK_API_KEY 凭据查询官方余额接口。
//
// 【为什么优先走 Node 内建 fetch，而不是 PowerShell】
//   早期实现把天气/余额都交给 ctx.shell 跑 PowerShell。那条路依赖会话的运行
//   策略：工作区沙箱（workspace-write / read-only）会拦下出网命令，审批策略
//   为「从不询问」时连审批都不会弹，命令直接失败——表现就是 ☁️ 天气、💰 余额、
//   今日用量一起「无法获取」。而宿主进程本身（Node）并不受文件沙箱限制，
//   内建 fetch 可以直接出网。所以这里改成：**Node fetch 优先，PowerShell 兜底**，
//   插件在任意沙箱/审批策略下都能拿到数据（Linux/macOS 上也不再有依赖）。
// ============================================================================

/** 错误信息脱敏：绝不把 sk- 开头的密钥带出去。 */
function redact(value) {
  return String(value).replace(/sk-[A-Za-z0-9]{6,}/gi, 'sk-***');
}

/** WMO 天气码 → 图标（与 PowerShell 分支保持同一套映射）。 */
function wmoIcon(code) {
  const c = Number(code);
  if (c === 0) return '☀️';
  if (c <= 2) return '⛅';
  if (c === 3) return '☁️';
  if (c === 45 || c === 48) return '🌫️';
  if (c >= 51 && c <= 57) return '🌦️';
  if (c >= 61 && c <= 67) return '🌧️';
  if (c >= 71 && c <= 77) return '❄️';
  if (c >= 80 && c <= 82) return '🌧️';
  if (c >= 85 && c <= 86) return '🌨️';
  if (c >= 95) return '⛈️';
  return '🌤';
}

/** WMO 天气码 → 中文描述（与 PowerShell 分支保持同一套映射）。 */
function wmoDesc(code) {
  const c = Number(code);
  if (c === 0) return '晴';
  if (c === 1) return '大致晴朗';
  if (c === 2) return '局部多云';
  if (c === 3) return '阴';
  if (c === 45 || c === 48) return '雾';
  if (c >= 51 && c <= 57) return '毛毛雨';
  if (c === 61 || c === 66 || c === 67) return '小雨';
  if (c === 63) return '中雨';
  if (c === 65) return '大雨';
  if (c >= 71 && c <= 77) return '雪';
  if (c === 80) return '阵雨';
  if (c === 81 || c === 82) return '强阵雨';
  if (c >= 85 && c <= 86) return '阵雪';
  if (c >= 95) return '雷雨';
  return '多云';
}

/** 带超时的 fetch（宿主侧没有 AbortSignal.timeout 的旧运行时也能用）。 */
async function fetchJson(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...(init || {}), signal: controller.signal });
    if (!response.ok) throw new Error('HTTP ' + String(response.status));
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 取 API Key：先问凭据服务，再退回读 $DSH_HOME/.credentials.yaml 的 refs 段。
 * 后者是兜底——某些部署没有把 credentials 服务注入到插件上下文里。
 */
async function resolveApiKey(ctx) {
  const credentials = ctx.get('credentials');
  if (credentials !== undefined) {
    const candidates = ['DEEPSEEK_API_KEY', 'deepseek', 'DEEPSEEK_KEY'];
    for (let i = 0; i < candidates.length; i++) {
      try {
        const resolved = await credentials.resolve(candidates[i]);
        if (resolved && typeof resolved.value === 'string' && resolved.value) return resolved.value;
      } catch {
        // try next candidate
      }
    }
  }
  if (typeof process.env.DEEPSEEK_API_KEY === 'string' && process.env.DEEPSEEK_API_KEY) {
    return process.env.DEEPSEEK_API_KEY;
  }
  // 文件兜底：只认 refs: 段下的 DEEPSEEK_API_KEY（不做通用 YAML 解析）
  try {
    const file = join(resolveDshHome(), '.credentials.yaml');
    if (existsSync(file)) {
      const text = await readFile(file, 'utf8');
      const lines = text.split(/\r?\n/);
      let inRefs = false;
      for (const line of lines) {
        if (/^\S/.test(line)) { inRefs = /^refs\s*:/.test(line.trim()); continue; }
        if (!inRefs) continue;
        const match = /^\s+(?:"?)([A-Za-z0-9_.\-]+)(?:"?)\s*:\s*(.+?)\s*$/.exec(line);
        if (!match || !/deepseek/i.test(match[1])) continue;
        const value = match[2].replace(/^["']|["']$/g, '');
        if (value) return value;
      }
    }
  } catch {
    // 读不到就走"没有 Key"的分支
  }
  return '';
}

/**
 * 天气的 PowerShell 兜底实现（Node 出网失败时才走这里）。
 * 完整保留旧脚本：wttr.in j1 三日 JSON + bigdatacloud 中文反查 + 本地 WMO 码表。
 * 注意：这条路要过 ctx.shell，会受会话沙箱与审批策略限制。
 */
async function queryWeatherViaShell(ctx, city) {
  const shell = ctx.get('shell');
  if (shell === undefined) return { ok: false, error: 'shell 服务不可用' };
  // 天气策略（统一走 wttr.in j1 三日 JSON，主打明日预报）：
  // - 设置了城市：直接显示用户配置的城市名（保证中文）；
  // - 自动定位：bigdatacloud 反查简体中文地名（zh-Hans）；
  // - 明日天气取 weather[1]：最高/最低温 + 午后（12/15 点）天气码，描述由本地 WMO 码表映射为中文。
  // [Console]::OutputEncoding 强制 UTF-8：Windows PowerShell 5.1 重定向输出默认 GBK，中文会乱码。
  const command = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n'
    + '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12\n'
    + '$ErrorActionPreference = \'Stop\'\n'
    + 'function WmoIcon([int]$code) {\n'
    + '  if ($code -eq 0) { return \'☀️\' }\n'
    + '  elseif ($code -le 2) { return \'⛅\' }\n'
    + '  elseif ($code -eq 3) { return \'☁️\' }\n'
    + '  elseif ($code -eq 45 -or $code -eq 48) { return \'🌫️\' }\n'
    + '  elseif ($code -ge 51 -and $code -le 57) { return \'🌦️\' }\n'
    + '  elseif ($code -ge 61 -and $code -le 67) { return \'🌧️\' }\n'
    + '  elseif ($code -ge 71 -and $code -le 77) { return \'❄️\' }\n'
    + '  elseif ($code -ge 80 -and $code -le 82) { return \'🌧️\' }\n'
    + '  elseif ($code -ge 85 -and $code -le 86) { return \'🌨️\' }\n'
    + '  elseif ($code -ge 95) { return \'⛈️\' }\n'
    + '  return \'🌤\'\n'
    + '}\n'
    + 'function WmoDesc([int]$code) {\n'
    + '  if ($code -eq 0) { return \'晴\' }\n'
    + '  elseif ($code -eq 1) { return \'大致晴朗\' }\n'
    + '  elseif ($code -eq 2) { return \'局部多云\' }\n'
    + '  elseif ($code -eq 3) { return \'阴\' }\n'
    + '  elseif ($code -eq 45 -or $code -eq 48) { return \'雾\' }\n'
    + '  elseif ($code -ge 51 -and $code -le 57) { return \'毛毛雨\' }\n'
    + '  elseif ($code -eq 61 -or $code -eq 66 -or $code -eq 67) { return \'小雨\' }\n'
    + '  elseif ($code -eq 63) { return \'中雨\' }\n'
    + '  elseif ($code -eq 65) { return \'大雨\' }\n'
    + '  elseif ($code -ge 71 -and $code -le 77) { return \'雪\' }\n'
    + '  elseif ($code -eq 80) { return \'阵雨\' }\n'
    + '  elseif ($code -eq 81 -or $code -eq 82) { return \'强阵雨\' }\n'
    + '  elseif ($code -ge 85 -and $code -le 86) { return \'阵雪\' }\n'
    + '  elseif ($code -ge 95) { return \'雷雨\' }\n'
    + '  return \'多云\'\n'
    + '}\n'
    + 'try {\n'
    + '  $base = \'https://wttr.in/\'\n'
    + '  if ($env:WB_CITY) { $base = $base + [uri]::EscapeDataString($env:WB_CITY) }\n'
    + '  $w = Invoke-RestMethod -Uri ($base + \'?format=j1&lang=zh\') -Headers @{ \'User-Agent\' = \'curl/8\' } -TimeoutSec 15 -UseBasicParsing\n'
    + '  if (-not $w -or -not $w.current_condition -or $w.current_condition.Count -lt 1) {\n'
    + '    [pscustomobject]@{ ok = $false; error = \'wttr.in 响应格式未知\' } | ConvertTo-Json -Compress\n'
    + '    exit 0\n'
    + '  }\n'
    + '  $c = $w.current_condition[0]\n'
    + '  $a = $w.nearest_area[0]\n'
    + '  if ($env:WB_CITY) {\n'
    + '    $cityName = $env:WB_CITY\n'
    + '  } else {\n'
    + '    $g = Invoke-RestMethod -Uri (\'https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=\' + $a.latitude + \'&longitude=\' + $a.longitude + \'&localityLanguage=zh-Hans\') -Headers @{ \'User-Agent\' = \'dsh-whale-pet\' } -TimeoutSec 15 -UseBasicParsing\n'
    + '    if ($g.city) { $cityName = [string]$g.city } elseif ($g.locality) { $cityName = [string]$g.locality } else { $cityName = [string]$g.principalSubdivision }\n'
    + '  }\n'
    + '  if (-not $w.weather -or $w.weather.Count -lt 2) {\n'
    + '    [pscustomobject]@{ ok = $false; error = \'没有拿到明日预报数据\' } | ConvertTo-Json -Compress\n'
    + '    exit 0\n'
    + '  }\n'
    + '  $tmr = $w.weather[1]\n'
    + '  $hi = [int]$tmr.maxtempC; $lo = [int]$tmr.mintempC\n'
    + '  $code = 0\n'
    + '  foreach ($h in $tmr.hourly) {\n'
    + '    if ($h.time -eq \'1200\' -or $h.time -eq \'1500\') { $code = [int]$h.weatherCode; break }\n'
    + '  }\n'
    + '  if ($code -eq 0) {\n'
    + '    $dayH = $tmr.hourly | Where-Object { $_.time -in \'600\',\'900\',\'1200\',\'1500\',\'1800\' } | Select-Object -First 1\n'
    + '    if ($dayH) { $code = [int]$dayH.weatherCode }\n'
    + '  }\n'
    + '  $desc = (WmoDesc $code)\n'
    + '  [pscustomobject]@{ ok = $true; city = $cityName; icon = (WmoIcon ([int]$c.weatherCode)); temp = ([string]$c.temp_C + \'°C\'); tomorrowIcon = (WmoIcon $code); tomorrowLow = $lo; tomorrowHigh = $hi; tomorrowDesc = $desc } | ConvertTo-Json -Compress\n'
    + '} catch {\n'
    + '  [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress\n'
    + '}\n';
  let result;
  try {
    // 同样不传 sandboxPolicy：跟随 shell 自身默认策略（见 queryBalance 的说明）
    const reqSpec = { command, timeoutMs: 25000, stdoutMaxBytes: 65536, env: { WB_CITY: city } };
    result = await shell.run(shell.resolve(reqSpec));
  } catch (error) {
    return { ok: false, error: redact('shell 执行失败：' + String(error && error.message ? error.message : error)) };
  }
  const text = result && result.stdout ? String(result.stdout.text || '') : '';
  if (result && result.exitCode !== 0) {
    const errText = result.stderr ? String(result.stderr.text || '') : '';
    return { ok: false, error: redact('执行失败（退出码 ' + String(result.exitCode) + '）' + (errText ? '：' + errText.slice(0, 200) : '')) };
  }
  let data;
  try { data = JSON.parse(text); } catch { data = { ok: false, error: '天气响应解析失败' }; }
  return data;
}

/** 查天气，返回 { ok, city, icon, temp, tomorrowIcon, tomorrowLow, tomorrowHigh, tomorrowDesc }。 */
async function queryWeatherNative(city) {
  const base = city ? 'https://wttr.in/' + encodeURIComponent(city) : 'https://wttr.in/';
  let w;
  try {
    w = await fetchJson(base + '?format=j1&lang=zh', { headers: { 'User-Agent': 'curl/8' } }, 15000);
  } catch (error) {
    return { ok: false, error: redact('天气查询失败：' + String(error && error.message ? error.message : error)) };
  }
  const current = w && Array.isArray(w.current_condition) ? w.current_condition[0] : undefined;
  const days = w && Array.isArray(w.weather) ? w.weather : [];
  if (!current) return { ok: false, error: 'wttr.in 响应格式未知' };
  if (days.length < 2) return { ok: false, error: '没有拿到明日预报数据' };

  const area = w && Array.isArray(w.nearest_area) ? w.nearest_area[0] : undefined;
  // 设置了城市就直接用用户填的中文名；否则反查简体中文地名（反查失败不影响天气本身）
  let cityName = city;
  if (!cityName && area) {
    try {
      const geo = await fetchJson(
        'https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=' + String(area.latitude)
          + '&longitude=' + String(area.longitude) + '&localityLanguage=zh-Hans',
        { headers: { 'User-Agent': 'dsh-whale-pet' } },
        15000,
      );
      cityName = String((geo && (geo.city || geo.locality || geo.principalSubdivision)) || '');
    } catch {
      cityName = '';
    }
  }
  if (!cityName) cityName = String((area && (area.areaName && area.areaName[0] && area.areaName[0].value)) || '当地');

  const tomorrow = days[1];
  const hourly = Array.isArray(tomorrow.hourly) ? tomorrow.hourly : [];
  // 明日天气码取午后 12:00 / 15:00；都没有就退到当天第一个可用时段
  let code;
  for (const hour of hourly) {
    if (hour.time === '1200' || hour.time === '1500') { code = Number(hour.weatherCode); break; }
  }
  if (code === undefined && hourly.length > 0) code = Number(hourly[0].weatherCode);
  if (code === undefined) code = Number(current.weatherCode);
  if (!Number.isFinite(code)) code = 0;

  return {
    ok: true,
    city: cityName,
    icon: wmoIcon(current.weatherCode),
    temp: String(current.temp_C) + '°C',
    tomorrowIcon: wmoIcon(code),
    tomorrowLow: Number(tomorrow.mintempC),
    tomorrowHigh: Number(tomorrow.maxtempC),
    tomorrowDesc: wmoDesc(code),
  };
}

/** Node 内建 fetch 版余额查询（不经 shell，不受会话沙箱影响）。 */
async function queryBalanceNative(ctx) {
  const apiKey = await resolveApiKey(ctx);
  if (!apiKey) return { ok: false, error: '没有找到 DeepSeek API Key（DEEPSEEK_API_KEY 未配置）' };
  let data;
  try {
    data = await fetchJson('https://api.deepseek.com/user/balance', {
      headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' },
    }, 15000);
  } catch (error) {
    return { ok: false, error: redact('余额查询失败：' + String(error && error.message ? error.message : error)) };
  }
  const infos = data && Array.isArray(data.balance_infos) ? data.balance_infos : [];
  if (infos.length === 0) return { ok: false, error: '账户余额不可用或响应格式未知' };
  const info = infos[0] || {};
  return {
    ok: true,
    currency: String(info.currency || 'CNY'),
    total: String(info.total_balance ?? '0'),
    granted: String(info.granted_balance ?? '0'),
    topped: String(info.topped_up_balance ?? '0'),
  };
}

/**
 * 解析本会话沙箱策略。**保留但已不再用于出网调用**：天气/余额现在走宿主侧
 * Node fetch，兜底的 shell 调用也不再覆盖 sandboxPolicy（覆盖会把会话收窄成
 * 只读、反而拦掉出网命令）。留作后续需要按会话策略做降级的参考。
 */
function resolvePolicy(ctx) {
  const sp = ctx.get('sandboxPolicy');
  if (sp === undefined) return undefined;
  try {
    const agents = ctx.get('agents');
    let session;
    if (agents !== undefined) {
      try {
        const roots = agents.roots();
        if (Array.isArray(roots) && roots.length > 0 && roots[0] && roots[0].session) {
          session = roots[0].session;
        }
      } catch {
        session = undefined;
      }
    }
    if (session !== undefined) return sp.resolve({ session });
  } catch {
    // fall through to explicit mode
  }
  return sp.resolve({ mode: 'danger-full-access' });
}

/**
 * 查询余额，返回可 JSON 化的 { ok, currency, total, granted, topped } 或 { ok:false, error }。
 * 路径：Node 内建 fetch（首选）→ 失败且拿得到 API Key 时退回 ctx.shell 跑 PowerShell。
 * 两条路都要 API Key；拿不到 Key 就直接返回可读错误，不白跑一次 shell。
 */
async function queryBalance(ctx) {
  const apiKey = await resolveApiKey(ctx);
  if (!apiKey) return { ok: false, error: '没有找到 DeepSeek API Key（DEEPSEEK_API_KEY 未配置）' };

  // 首选：宿主进程内直接请求（不受会话沙箱/审批策略影响）
  const native = await queryBalanceNative(ctx);
  if (native.ok || native.error !== undefined && native.error.indexOf('余额查询失败：') !== 0) return native;

  // 兜底：老实现（PowerShell）。只有 Node 出网失败时才走到这里。
  const shell = ctx.get('shell');
  if (shell === undefined) return native;

  const safe = String(apiKey).replace(/[^A-Za-z0-9._\-]/g, '');
  if (!safe) return { ok: false, error: 'API Key 格式异常' };

  const command = '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12\n'
    + '$ErrorActionPreference = \'Stop\'\n'
    + 'try {\n'
    + '  $r = Invoke-RestMethod -Uri \'https://api.deepseek.com/user/balance\' -Headers @{ Authorization = (\'Bearer \' + $env:DSH_BAL_KEY); Accept = \'application/json\' } -TimeoutSec 15 -UseBasicParsing\n'
    + '  if ($r -and $r.balance_infos -and $r.balance_infos.Count -gt 0) {\n'
    + '    $b = $r.balance_infos[0]\n'
    + '    [pscustomobject]@{ ok = $true; currency = [string]$b.currency; total = [string]$b.total_balance; granted = [string]$b.granted_balance; topped = [string]$b.topped_up_balance } | ConvertTo-Json -Compress\n'
    + '  } else {\n'
    + '    [pscustomobject]@{ ok = $false; error = \'账户余额不可用或响应格式未知\' } | ConvertTo-Json -Compress\n'
    + '  }\n'
    + '} catch {\n'
    + '  $msg = $_.Exception.Message\n'
    + '  if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $msg = $msg + \' | \' + $_.ErrorDetails.Message }\n'
    + '  [pscustomobject]@{ ok = $false; error = ($msg + \' (PS \' + $PSVersionTable.PSEdition + \' \' + $PSVersionTable.PSVersion + \')\') } | ConvertTo-Json -Compress\n'
    + '}\n';

  let result;
  try {
    // 显式**不**传 sandboxPolicy：让 shell 用它自己的默认（跟随会话当前策略），
    // 免得把会话收窄成只读反而把出网命令拦下来。兜底本来就只在 Node 出网失败时才会走到。
    const req = { command, timeoutMs: 25000, stdoutMaxBytes: 65536, env: { DSH_BAL_KEY: safe } };
    result = await shell.run(shell.resolve(req));
  } catch (error) {
    // shell 走不通（沙箱拦截 / 无审批人 / 进程无法启动）时，保留 Node 侧的真实原因
    return native;
  }

  const text = result && result.stdout ? String(result.stdout.text || '') : '';
  if (result && result.exitCode !== 0) {
    const errText = result.stderr ? String(result.stderr.text || '') : '';
    return { ok: false, error: redact('执行失败（退出码 ' + String(result.exitCode) + '）' + (errText ? '：' + errText.slice(0, 300) : '')) };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: redact('余额响应解析失败：' + (text ? text.slice(0, 200) : '空响应')) };
  }
  if (data && data.ok === true) {
    return {
      ok: true,
      currency: String(data.currency || 'CNY'),
      total: String(data.total || '0'),
      granted: String(data.granted || '0'),
      topped: String(data.topped || '0'),
    };
  }
  return { ok: false, error: redact(data && data.error ? String(data.error) : '账户余额不可用或响应格式未知') };
}

// 本 fork 的用量与计费实现在 lib/usage.js（纯逻辑、可单测）：
//   computeTodayUsage / computeTaskUsage / taskSummaryLines / rateAt / foldTodayUsage

// 导出插件三件套（Cordis Loader 需要）
export { apply, inject, name };
