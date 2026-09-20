/**
 * ============================================================================
 * lib/edge-tts.js —— Edge 神经网络语音合成（任务播报的"角色音色"引擎）
 * ============================================================================
 *
 * 【为什么需要它】
 *   浏览器内建的 Web Speech API 只能念系统装的那一两个中文音色，做不出
 *   "胡桃 / 派蒙 / 钟离"这类角色感。而 Google 的在线 TTS 在部分网络下不可达。
 *   微软 Edge 的"大声朗读"用的是 Azure 神经网络语音（zh-CN 有 8 个音色，
 *   带 Warm / Lively / Cute / Passion 等性格标签），公开可访问、无需 API Key，
 *   拿到的就是真实 MP3 —— 这才是能做出角色感的素材来源。
 *
 * 【它是怎么工作的】
 *   1) 语音列表：GET .../readaloud/voices/list?trustedclienttoken=...
 *   2) 语音合成：wss://speech.platform.bing.com/.../edge/v1 上的 WebSocket。
 *      连上后先发 speech.config（声明输出格式），再发 ssml；服务端回若干个
 *      "binary 帧"（每个 = 文本头 + \r\n\r\n + MP3 分片），最后回一个
 *      Path:turn.end 的文本帧表示结束。
 *
 * 【为什么自己手写 WebSocket 客户端】
 *   本包刻意保持零运行时依赖（见 package.json 的说明）。Node 内建的 WebSocket
 *   （undici）在握手时**无法自定义请求头**，而 Edge 服务端会校验 User-Agent /
 *   Origin，缺了就回 403。所以这里用 node:net + node:tls 自己完成：
 *   握手（含 Sec-WebSocket-Key 校验）→ 收帧 → 发帧 → 关连接。
 *
 * 【已知坑（都踩过）】
 *   · Chrome 版本号要"够新"：用 130 会被 403，143 才握手成功；UA 与
 *     Sec-MS-GEC-Version 必须一致。
 *   · 令牌 Sec-MS-GEC 是把"当前时间向下取整到 5 分钟"换算成 Windows FILETIME
 *     刻度后拼上 TrustedClientToken 做 SHA-256，所以它是会过期的；
 *     403/401 时重新生成再试一次即可。
 *   · 二进制帧里 "\r\n\r\n" 之后才是音频，前面的头里有 Path:audio。
 */

import { createHash, randomBytes } from 'node:crypto';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

/** Edge"大声朗读"的公开客户端令牌（所有非官方实现都用它）。 */
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
/**
 * 伪装的 Edge 版本。服务端会挑版本，太旧直接 403；
 * UA 与 Sec-MS-GEC-Version 必须用同一个数字。
 */
const CHROME_MAJOR = '143';
const SEC_MS_GEC_VERSION = '1-' + CHROME_MAJOR + '.0.0.0';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/' + CHROME_MAJOR + '.0.0.0 Safari/537.36 Edg/' + CHROME_MAJOR + '.0.0.0';
/** 声明的输出格式：24kHz 单声道 48kbps MP3（浏览器 <audio> 直接能播）。 */
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

const WS_HOST = 'speech.platform.bing.com';
const WS_PATH = '/consumer/speech/synthesize/readaloud/edge/v1';
const VOICES_URL = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list'
  + '?trustedclienttoken=' + TRUSTED_CLIENT_TOKEN;
/** FILETIME 纪元（1601-01-01）到 Unix 纪元的秒数。 */
const WIN_EPOCH_OFFSET_SEC = 11644473600n;
/** 音频帧头部里的路径标记（服务端写的是 "Path:audio"，没有前导斜杠）。 */
const AUDIO_PATH_MARKER = Buffer.from('Path:audio');

/**
 * 生成 Sec-MS-GEC 令牌：当前时间按 5 分钟取整 → Windows FILETIME 刻度 → SHA-256。
 * 令牌 5 分钟有效，所以调用前现算，不做缓存。
 */
export function secMsGec(nowMs) {
  const seconds = BigInt(Math.floor((nowMs === undefined ? Date.now() : nowMs) / 1000)) + WIN_EPOCH_OFFSET_SEC;
  let ticks = seconds - (seconds % 300n);
  ticks *= 10000000n;
  return createHash('sha256').update(String(ticks) + TRUSTED_CLIENT_TOKEN, 'ascii').digest('hex').toUpperCase();
}

/** XML 转义（文本会进 SSML）。 */
function xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 规范化音调/语速：只允许 "+10Hz" / "-5%" 这类安全写法，非法值退回 +0。 */
function safeProsody(value, unit) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  const match = /^([+-]?)(\d{1,4})(Hz|%|st)?$/.exec(raw);
  if (!match) return '+0' + unit;
  // 符号只补一次：'-60Hz' 保持负号，"60Hz" 补成 "+60Hz"。
  // 【踩过的坑】早先写成 (sign === '-' ? '' : '+') + match[1] + ...，对 "+60Hz"
  // 会拼出 "++60Hz"：服务端**不报错**，但一个音频帧都不回，前端表现为"合成超时"。
  const sign = match[1] === '-' ? '-' : '+';
  return sign + match[2] + (match[3] || unit);
}

/** 拼 SSML。 */
function buildSsml(text, voice, pitch, rate, volume) {
  return "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>"
    + "<voice name='" + xmlEscape(voice) + "'>"
    + "<prosody pitch='" + safeProsody(pitch, 'Hz') + "' rate='" + safeProsody(rate, '%') + "' volume='" + safeProsody(volume, '%') + "'>"
    + xmlEscape(text)
    + '</prosody></voice></speak>';
}

// ============================================================================
// 极简 WebSocket 客户端（只为这一个服务而生：文本帧 + 二进制帧 + 关闭）
// ============================================================================

/**
 * 连一个 WebSocket。成功时 resolve 一个连接对象：
 *   { send(text), onMessage(textOrBuffer, isBinary), onClose(cb), close() }
 * @param options - { host, path, headers, timeoutMs }
 */
function wsConnect(options) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const socket = tlsConnect({ host: options.host, port: 443, servername: options.host });
    let handshakeDone = false;
    let buffer = Buffer.alloc(0);
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* 忽略 */ }
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const timer = setTimeout(() => fail(new Error('Edge TTS 连接超时')), options.timeoutMs || 20000);

    const onMessage = [];
    const onClose = [];
    let closed = false;
    let closing = false;

    /**
     * 结束连接。注意：服务端在 turn.end 之后会**自己**收连接，我们这边一 end
     * 就可能撞上对方的 FIN/RST，TLS 层随即抛 ECONNRESET。那属于正常收尾，
     * 不该冒给调用方（否则合成明明成功了却被判成失败）——所以要：
     * 先摘掉所有监听器，再 destroy。
     */
    const shutdown = () => {
      if (closing) return;
      closing = true;
      try { socket.removeAllListeners('data'); } catch { /* 忽略 */ }
      try { socket.removeAllListeners('error'); } catch { /* 忽略 */ }
      try { socket.removeAllListeners('close'); } catch { /* 忽略 */ }
      try { socket.destroy(); } catch { /* 忽略 */ }
    };

    socket.on('error', (error) => {
      if (closing) return;
      if (!handshakeDone) { fail(error); return; }
      for (const fn of onClose) { try { fn(error); } catch { /* 忽略 */ } }
    });
    socket.on('close', () => {
      closed = true;
      clearTimeout(timer);
      if (closing) return;
      if (!handshakeDone) { fail(new Error('Edge TTS 连接被关闭')); return; }
      for (const fn of onClose) { try { fn(null); } catch { /* 忽略 */ } }
    });

    /** 收数据：先做握手校验，之后按帧解析。 */
    const handleData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshakeDone) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString('utf8');
        buffer = buffer.subarray(end + 4);
        const status = /^HTTP\/1\.1 (\d{3})/.exec(head);
        if (!status) { fail(new Error('Edge TTS 握手响应异常')); return; }
        if (status[1] !== '101') {
          fail(new Error('Edge TTS 握手失败：HTTP ' + status[1]));
          return;
        }
        handshakeDone = true;
        clearTimeout(timer);
        resolve({
          send(text) {
            if (closed) return;
            const payload = Buffer.from(text, 'utf8');
            const mask = randomBytes(4);
            const header = payload.length < 126
              ? Buffer.from([0x81, 0x80 | payload.length])
              : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
            const masked = Buffer.allocUnsafe(payload.length);
            for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
            try { socket.write(Buffer.concat([header, mask, masked])); } catch { /* 忽略 */ }
          },
          onMessage(fn) { onMessage.push(fn); },
          onClose(fn) { onClose.push(fn); },
          close: shutdown,
        });
      }
      parseFrames();
    };

    /** 解析服务端帧（服务端发的是不掩码的帧）。 */
    function parseFrames() {
      for (;;) {
        if (buffer.length < 2) return;
        const b0 = buffer[0];
        const b1 = buffer[1];
        const opcode = b0 & 0x0f;
        let length = b1 & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          const big = buffer.readBigUInt64BE(2);
          if (big > BigInt(Number.MAX_SAFE_INTEGER)) { fail(new Error('Edge TTS 帧过大')); return; }
          length = Number(big);
          offset = 10;
        }
        if (buffer.length < offset + length) return;
        const payload = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        if (opcode === 0x1 || opcode === 0x2) {
          for (const fn of onMessage) { try { fn(payload, opcode === 0x2); } catch { /* 忽略 */ } }
        } else if (opcode === 0x8) {
          // 服务端的关闭帧：正常收尾
          shutdown();
          return;
        }
      }
    }

    socket.on('data', handleData);
    socket.on('connect', () => {
      const lines = [
        'GET ' + options.path + ' HTTP/1.1',
        'Host: ' + options.host,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: ' + key,
        'Sec-WebSocket-Version: 13',
      ];
      for (const [name, value] of Object.entries(options.headers || {})) lines.push(name + ': ' + value);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    });
  });
}

// ============================================================================
// 对外接口
// ============================================================================

/**
 * 合成一段中文语音，返回 MP3 Buffer。
 * @param options - { text, voice, pitch, rate, volume, timeoutMs }
 * @returns Promise<Buffer>
 */
export async function synthesize(options) {
  const text = String(options.text || '').slice(0, 500);
  if (!text) throw new Error('没有要合成的文本');
  const voice = String(options.voice || 'zh-CN-XiaoyiNeural');
  const ssml = buildSsml(text, voice, options.pitch, options.rate, options.volume);

  const connectOnce = async () => {
    const path = WS_PATH + '?TrustedClientToken=' + TRUSTED_CLIENT_TOKEN
      + '&Sec-MS-GEC=' + secMsGec()
      + '&Sec-MS-GEC-Version=' + encodeURIComponent(SEC_MS_GEC_VERSION);
    const ws = await wsConnect({
      host: WS_HOST,
      path,
      timeoutMs: options.timeoutMs || 20000,
      headers: {
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        // Origin 用一个 Edge 扩展的 id：服务端校验它，缺失就 403
        'Origin': 'chrome-extension://hjblomcfhgighnkjblhnefmjkmhpgiib',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': USER_AGENT,
      },
    });

    const chunks = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { try { ws.close(); } catch { /* 忽略 */ } reject(new Error('Edge TTS 合成超时')); }, options.timeoutMs || 20000);
      let finished = false;
      const finish = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try { ws.close(); } catch { /* 忽略 */ }
        // 一次音频分片都没收到 → 这不是成功，报出来让上层退回到系统语音
        if (!error && chunks.length === 0) reject(new Error('Edge TTS 没有返回音频'));
        else if (error) reject(error);
        else resolve();
      };
      ws.onMessage((raw, isBinary) => {
        if (!isBinary) {
          if (raw.toString('utf8').indexOf('Path:turn.end') >= 0) finish(null);
          return;
        }
        // 音频帧的布局（逐字节实测）：
        //   [2 字节大端前缀] + 文本头 + 这段的 MP3 分片
        // 文本头形如：
        //   X-RequestId:..\r\nContent-Type:audio/mpeg\r\nX-StreamId:..\r\nPath:audio\r\n
        // 【关键】这里**没有**空行分隔：`Path:audio\r\n` 之后紧接着就是 MP3 的
        // 0xFF 0xF3 帧头（如果去等 \r\n\r\n 会永远等不到，每帧都被丢掉，
        // 最终报"没有返回音频"）。
        // 另外开头那 2 字节**不是**可靠的头长度（实测首帧 0x0080、末帧 0x0067，
        // 都对不上真实头长），所以一律按 `Path:audio` 标记定位。
        const marker = raw.indexOf(AUDIO_PATH_MARKER);
        if (marker < 0) return; // 不是音频帧（或头部不完整）：丢掉
        let start = marker + AUDIO_PATH_MARKER.length;
        // 吃掉标记后面可能存在的行结束符（\r\n 或 \n）
        if (raw[start] === 0x0d && raw[start + 1] === 0x0a) start += 2;
        else if (raw[start] === 0x0a) start += 1;
        if (start >= raw.length) return;
        chunks.push(raw.subarray(start));
      });
      // 服务端有时直接发关闭帧收尾：当成正常结束（turn.end 可能已经/还没到）
      ws.onClose((error) => finish(error && error.code !== 'ECONNRESET' && error.code !== 'EPIPE' ? error : null));
      // speech.config：声明输出格式；随后才是 SSML
      ws.send('X-Timestamp:' + Date.now() + '\r\n'
        + 'Content-Type:application/json; charset=utf-8\r\n'
        + 'Path:speech.config\r\n\r\n'
        + JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
                outputFormat: OUTPUT_FORMAT,
              },
            },
          },
        }));
      ws.send('X-RequestId:' + randomBytes(16).toString('hex') + '\r\n'
        + 'Content-Type:application/ssml+xml\r\n'
        + 'X-Timestamp:' + new Date().toISOString() + '\r\n'
        + 'Path:ssml\r\n\r\n'
        + ssml);
    });
    return Buffer.concat(chunks);
  };

  // 令牌 5 分钟过期；握手失败时重算一次令牌再试（不重试合成本身的错误）
  try {
    return await connectOnce();
  } catch (error) {
    const message = String((error && error.message) || error);
    if (/握手失败：HTTP (401|403)/.test(message)) return await connectOnce();
    throw error;
  }
}

/** 语音列表缓存（1 小时），避免每次打开设置面板都打一次接口。 */
let voicesCache = { at: 0, list: null };

/**
 * 拉取 Edge 的语音列表（只保留中文，附性格标签）。
 * @returns Promise<Array<{ shortName, gender, locale, personalities, friendlyName }>>
 */
export async function listVoices(options) {
  const ttlMs = (options && options.ttlMs) || 3600000;
  if (voicesCache.list && Date.now() - voicesCache.at < ttlMs) return voicesCache.list;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(VOICES_URL, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('HTTP ' + String(response.status));
    const all = await response.json();
    const list = (Array.isArray(all) ? all : [])
      .filter((item) => item && typeof item.ShortName === 'string' && /^zh/i.test(String(item.Locale || '')))
      .map((item) => ({
        shortName: item.ShortName,
        gender: item.Gender || '',
        locale: item.Locale || '',
        personalities: (item.VoiceTag && Array.isArray(item.VoiceTag.VoicePersonalities)) ? item.VoiceTag.VoicePersonalities : [],
        friendlyName: item.FriendlyName || item.ShortName,
      }));
    voicesCache = { at: Date.now(), list };
    return list;
  } finally {
    clearTimeout(timer);
  }
}
