/**
 * 打包脚本：把插件目录打成标准 npm tarball（package/ 前缀），
 * 与 `npm pack` 产物结构一致，可以直接 `dsh plugin add <file>.tgz` 安装。
 *
 * 为什么不直接调 npm pack：本机 PowerShell 执行策略禁用了 npm.ps1，
 * 而通过管道捕获 npm 输出又会被沙箱拦掉。所以用 Node 自己写 tar + gzip，
 * 顺带保证产物可复现（每个文件用固定 mtime、排序后写入）。
 *
 * 用法：node scripts/pack.mjs <插件目录> [输出目录]
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep, posix } from 'node:path';
import { gzipSync } from 'node:zlib';

const sourceDir = process.argv[2];
const outDir = process.argv[3] || sourceDir;
if (!sourceDir) {
  console.error('用法: node pack.mjs <插件目录> [输出目录]');
  process.exit(2);
}

/** 打进包里的顶层项（与 package.json 的 files 字段一致）。 */
const INCLUDE = ['lib', 'assets/thumb', 'assets/preview', 'cordis.patch.yml', 'README.md', 'README.en.md', 'LICENSE', 'NOTICE.md', 'package.json'];
/** 固定 mtime：让同一份源码每次打出的 tarball 完全一致。 */
const FIXED_MTIME = Math.floor(new Date('2026-09-20T00:00:00Z').getTime() / 1000);

/** 把 0-255 的字节写进 512 字节的 tar 头字段。 */
function field(value, length) {
  const buf = Buffer.alloc(length, 0);
  buf.write(String(value), 0, Math.min(String(value).length, length - 1), 'utf8');
  return buf;
}

/** 八进制数值字段（tar 规范：用 NUL 或空格结尾）。 */
function octal(value, length) {
  const text = Number(value).toString(8).padStart(length - 1, '0');
  return field(text, length);
}

function tarHeader(name, size, mode) {
  // 长路径：tar 的 name 字段只有 100 字节，超出就用 GNU longname 扩展
  const header = Buffer.alloc(512, 0);
  field(name, 100).copy(header, 0);
  octal(mode, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);          // uid
  octal(0, 8).copy(header, 116);          // gid
  octal(size, 12).copy(header, 124);
  octal(FIXED_MTIME, 12).copy(header, 136);
  header.write('        ', 148, 8, 'utf8'); // 校验和先填空格
  header.write('0', 156, 1, 'utf8');        // typeflag: 普通文件
  header.write('ustar', 257, 5, 'utf8');    // magic
  header.write('00', 263, 2, 'utf8');       // version
  // 计算校验和（头内所有字节按无符号求和）
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
  return header;
}

/** 递归收集要打包的文件（相对路径用 / 分隔，保持 tar 规范）。 */
function collect(dir, base, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    const rel = relative(base, absolute).split(sep).join(posix.sep);
    if (entry.isDirectory()) collect(absolute, base, out);
    else if (entry.isFile()) out.push({ rel, absolute });
  }
  return out;
}

const files = [];
for (const item of INCLUDE) {
  const absolute = join(sourceDir, item.split('/').join(sep));
  let stat;
  try { stat = statSync(absolute); } catch { continue; } // 缺失项跳过（README.en.md 之类可能没有）
  if (stat.isDirectory()) collect(absolute, sourceDir, files);
  else files.push({ rel: item, absolute });
}
files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

const chunks = [];
for (const file of files) {
  const body = readFileSync(file.absolute);
  const name = 'package/' + file.rel;
  if (Buffer.byteLength(name) > 100) {
    // GNU longname：先写一个 typeflag='L' 的头，内容就是真实路径
    const nameBuf = Buffer.from(name + '\0', 'utf8');
    const longHeader = tarHeader('././@LongLink', nameBuf.length, 0o644);
    longHeader.write('L', 156, 1, 'utf8');
    let sum = 0;
    for (const byte of longHeader) sum += byte;
    longHeader.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
    chunks.push(longHeader, nameBuf, Buffer.alloc((512 - (nameBuf.length % 512)) % 512, 0));
    chunks.push(tarHeader(name.slice(0, 99), body.length, 0o644));
  } else {
    chunks.push(tarHeader(name, body.length, 0o644));
  }
  chunks.push(body, Buffer.alloc((512 - (body.length % 512)) % 512, 0));
}
chunks.push(Buffer.alloc(1024, 0)); // tar 结束标记：两个 512 字节的全零块

const tar = Buffer.concat(chunks);
const gz = gzipSync(tar, { level: 9 });

const pkg = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8'));
const fileName = `${pkg.name}-${pkg.version}.tgz`;
const outPath = join(outDir, fileName);
writeFileSync(outPath, gz);

console.log(`文件数: ${files.length}`);
console.log(`tar: ${(tar.length / 1024 / 1024).toFixed(2)} MB -> gzip: ${(gz.length / 1024 / 1024).toFixed(2)} MB`);
console.log(`输出: ${outPath}`);
