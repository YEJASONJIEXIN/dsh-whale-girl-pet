/**
 * 校验 tarball：解开 gzip + tar，列出条目并检查关键文件是否齐全、大小是否合理。
 * 用法：node scripts/verify-pack.mjs <tarball>
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const file = process.argv[2];
if (!file) { console.error('用法: node verify-pack.mjs <tarball>'); process.exit(2); }

const tar = gunzipSync(readFileSync(file));
const entries = [];
let offset = 0;
let pendingName = null;
while (offset + 512 <= tar.length) {
  const header = tar.subarray(offset, offset + 512);
  if (header.every((b) => b === 0)) break; // 结束标记
  const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
  const sizeText = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
  const typeflag = header.subarray(156, 157).toString('utf8');
  const size = parseInt(sizeText, 8) || 0;
  offset += 512;
  const body = tar.subarray(offset, offset + size);
  offset += size + ((512 - (size % 512)) % 512);
  if (typeflag === 'L') { pendingName = body.toString('utf8').replace(/\0.*$/, ''); continue; }
  const name = pendingName || rawName;
  pendingName = null;
  entries.push({ name, size });
}

console.log(`条目数: ${entries.length}`);
const total = entries.reduce((sum, e) => sum + e.size, 0);
console.log(`解包后总大小: ${(total / 1024 / 1024).toFixed(2)} MB`);

const required = [
  'package/package.json',
  'package/lib/index.js',
  'package/lib/client.js',
  'package/lib/edge-tts.js',
  'package/lib/usage.js',
  'package/lib/usage-ledger.js',
  'package/lib/cost-projection.js',
  'package/cordis.patch.yml',
  'package/LICENSE',
  'package/NOTICE.md',
  'package/README.md',
];
let ok = true;
console.log('\n关键文件:');
for (const item of required) {
  const hit = entries.find((e) => e.name === item);
  if (hit) console.log(`  ✓ ${item}  (${hit.size} B)`);
  else { console.log(`  ✗ ${item}  缺失`); ok = false; }
}

const thumbs = entries.filter((e) => e.name.startsWith('package/assets/thumb/'));
console.log(`\n动画素材: assets/thumb ${thumbs.length} 个（合计 ${(thumbs.reduce((s, e) => s + e.size, 0) / 1024 / 1024).toFixed(1)} MB）`);
if (thumbs.length === 0) { console.log('  ✗ 没有动画文件！'); ok = false; }

// package.json 必须能被解析、且 cliemt 入口声明还在
const pkgEntry = entries.find((e) => e.name === 'package/package.json');
if (pkgEntry) {
  const start = tar.indexOf(Buffer.from('package/package.json'));
  // 重新定位该条目正文
  let off = 0, found = null;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0;
    off += 512;
    if (rawName === 'package/package.json') { found = tar.subarray(off, off + size).toString('utf8'); break; }
    off += size + ((512 - (size % 512)) % 512);
  }
  if (found) {
    const json = JSON.parse(found);
    console.log(`\npackage.json: ${json.name}@${json.version}`);
    console.log(`  dsh.bundle.patch = ${json.dsh?.bundle?.patch}`);
    console.log(`  dsh.client.inject = ${(json.dsh?.client?.inject || []).join(', ')}`);
    if (json.dsh?.bundle?.patch !== './cordis.patch.yml') { console.log('  ✗ bundle patch 声明不对'); ok = false; }
  }
}

console.log(`\n${ok ? '校验通过 ✅' : '校验失败 ❌'}`);
process.exit(ok ? 0 : 1);
