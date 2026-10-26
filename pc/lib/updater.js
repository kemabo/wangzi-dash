'use strict';
/**
 * 自动更新：Gitee 主源 / GitHub 备用源
 *
 * 流程：读远端 release 拿到最新版本号 → 比本地新就下载大屏 zip → 解压校验
 *      → 备份当前 exe → 生成外部替换脚本 → 主进程退出、脚本收尾并重新拉起。
 *
 * 两条硬约束：
 * 1) Windows 上进程无法覆盖自己，替换必须由「外部脚本 + 主进程先退出」完成，
 *    所以 install() 的最后一步是写完脚本后让主进程自己退出。
 * 2) 只替换 exe 与说明文档，绝不碰 config.json（门店账号密码）和 data/（快照缓存）。
 *
 * 脚本本身保持纯 ASCII（中文路径/文件名全部走 job.json），规避 VBScript/PowerShell
 * 读取脚本时的编码问题。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const UA = 'wangzi-dash-updater';
const TIMEOUT_API = 12000;      // 读版本信息的超时：卡住就切备用源
const UPDATE_DIR_NAME = 'update';

// 主源在前，备用源在后；前一个失败自动落到下一个
const SOURCES = [
  { id: 'gitee', label: 'Gitee（主源）', api: 'https://gitee.com/api/v5/repos/kemabo/wangzi-dash/releases/latest' },
  { id: 'github', label: 'GitHub（备用）', api: 'https://api.github.com/repos/kemabo/wangzi-dash/releases/latest' },
];

let ctx = null;   // init() 注入：dataDir / home / exeName / version / build / isSea
let state = null;
let busy = null;  // 正在进行中的任务，避免重复触发

// ---------------------------------------------------------------- 基础工具
function nowDay() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function pjoin(a, b) { return path.join(a, b); }

/** 1.1.5 → [1,1,5]；返回 a>b 为正数 */
function cmpVer(a, b) {
  const pa = String(a || '0').replace(/^v/i, '').split(/[.\-+_]/).map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0').replace(/^v/i, '').split(/[.\-+_]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
module.exports.cmpVer = cmpVer;

/** 带重定向与超时的 GET；json=true 时解析 JSON */
function fetchUrl(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const go = (u, hops) => {
      const mod = /^https:/i.test(u) ? https : http;
      const req = mod.get(u, {
        headers: { 'User-Agent': UA, 'Accept': opts.json ? 'application/json' : '*/*' },
        timeout: opts.timeout || TIMEOUT_API,
      }, (res) => {
        const code = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location && hops < 5) {
          res.resume();
          try { return go(new URL(res.headers.location, u).href, hops + 1); }
          catch (e) { return reject(new Error('重定向地址无效')); }
        }
        if (code !== 200) { res.resume(); return reject(new Error('HTTP ' + code)); }
        if (opts.stream) return resolve(res);   // 调用方自己消费流
        let b = '';
        res.setEncoding('utf8');
        res.on('data', d => {
          b += d;
          if (opts.maxBytes && b.length > opts.maxBytes) { req.destroy(); reject(new Error('响应过大')); }
        });
        res.on('end', () => {
          if (opts.json) {
            try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('返回不是 JSON')); }
          } else resolve(b);
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('连接超时')); });
      req.on('error', reject);
    };
    go(url, 0);
  });
}

/** 流式下载到文件，带进度回调；返回实际字节数 */
function downloadTo(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    let lastAt = Date.now();
    const go = (u, hops) => {
      const mod = /^https:/i.test(u) ? https : http;
      const req = mod.get(u, { headers: { 'User-Agent': UA }, timeout: 30000 }, (res) => {
        const code = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location && hops < 5) {
          res.resume();
          try { return go(new URL(res.headers.location, u).href, hops + 1); }
          catch (e) { return reject(new Error('重定向地址无效')); }
        }
        if (code !== 200) { res.resume(); return reject(new Error('HTTP ' + code)); }
        const total = Number(res.headers['content-length']) || 0;
        let got = 0;
        const ws = fs.createWriteStream(dest);
        const tick = setInterval(() => {
          // 60 秒一点数据都没有视为断线（公司网络常见半开连接）
          if (Date.now() - lastAt > 60000) { clearInterval(tick); try { req.destroy(); } catch (e) { } reject(new Error('下载超时')); }
        }, 5000);
        res.on('data', c => { got += c.length; lastAt = Date.now(); if (onProgress) onProgress(got, total); });
        res.on('error', (e) => { clearInterval(tick); reject(e); });
        ws.on('error', (e) => { clearInterval(tick); reject(e); });
        ws.on('finish', () => { clearInterval(tick); ws.close(() => resolve({ size: got, total })); });
        res.pipe(ws);
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('连接超时')); });
      req.on('error', reject);
    };
    go(url, 0);
  });
}

// ---------------------------------------------------------------- 状态存取
function stateFile() { return path.join(ctx.dataDir, 'update-state.json'); }
function updateDir() { return path.join(ctx.dataDir, UPDATE_DIR_NAME); }
function backupDir() { return path.join(updateDir(), 'backup'); }

function loadState() {
  const def = {
    enabled: true,            // 自动检查开关
    source: 'gitee',          // 上次成功用的源
    lastCheckAt: 0,
    lastCheckDay: '',         // 每天只自动查一次
    lastError: '',
    latest: null,             // 远端最新版本信息
    installing: null,         // {version, phase, percent}
    lastInstall: null,        // {from, to, at, ok, error}
    backup: null,             // {version, file, at}
    attempt: {},              // 同一版本当天尝试次数，失败不无限重试
  };
  try {
    const j = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return Object.assign(def, j || {});
  } catch (e) { return def; }
}
function saveState() {
  try { fs.mkdirSync(ctx.dataDir, { recursive: true }); } catch (e) { }
  try { fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2), 'utf8'); } catch (e) { }
}

function init(c) {
  ctx = {
    dataDir: c.dataDir,
    home: process.env.DASH_UPDATE_HOME || c.home || c.dataDir && path.dirname(c.dataDir) || '',
    exeName: process.env.DASH_UPDATE_EXE || c.exeName || '门店经营数据大屏.exe',
    version: c.version || '0.0.0',
    build: c.build || '',
    isSea: !!c.isSea,
  };
  state = loadState();
  return ctx;
}
module.exports.init = init;

function status() {
  return {
    enabled: !!state.enabled,
    source: state.source,
    current: { version: ctx.version, build: ctx.build },
    canSelfReplace: ctx.isSea || !!process.env.DASH_UPDATE_HOME,
    home: ctx.home,
    exeName: ctx.exeName,
    lastCheckAt: state.lastCheckAt,
    lastCheckDay: state.lastCheckDay,
    lastError: state.lastError,
    latest: state.latest,
    hasUpdate: !!(state.latest && cmpVer(state.latest.version, ctx.version) > 0),
    installing: state.installing,
    lastInstall: state.lastInstall,
    backup: state.backup,
    sources: SOURCES.map(s => ({ id: s.id, label: s.label })),
  };
}
module.exports.status = status;

// ---------------------------------------------------------------- 远端探测
function sourcesOf() {
  const override = process.env.DASH_UPDATE_API;
  // 测试/内网用：只给一个源，便于用假 release 服务验证整条链路
  if (override) return [{ id: 'custom', label: '自定义源', api: override }];
  const first = SOURCES.find(s => s.id === state.source);
  return first ? [first, ...SOURCES.filter(s => s.id !== first.id)] : SOURCES.slice();
}

/**
 * 挑出安装包 zip。Gitee 会自动往发行版里追加源码包（v1.1.6.zip / .tar.gz），
 * 拿它当安装包会解压出一堆源码、找不到主程序，所以必须认名字而不是「第一个 zip」。
 */
function pickZip(assets) {
  const zips = (assets || []).filter(a => /\.zip$/i.test(a.name || ''));
  if (!zips.length) return null;
  // 1) 认准发布包自己的名字
  const named = zips.find(a => /screen|大屏/i.test(a.name || ''));
  if (named) return named;
  // 2) 退而求其次：排除源码包（纯版本号命名 / 带 source）与安卓包
  return zips.find(a => !/apk|android|source|源码/i.test(a.name || '')
    && !/^v?\d+(\.\d+)*\.zip$/i.test(a.name || '')) || null;
}

/** 从 release 里挑出版本号 / 更新说明 / zip 下载地址 */
function parseRelease(rel, src) {
  const assets = (rel && (rel.assets || rel.attach_files)) || [];
  const zip = pickZip(assets);
  const vj = assets.find(a => /^version\.json$/i.test(a.name || ''));
  let version = '', build = '', changelog = String(rel.body || rel.name || '').trim();
  if (vj) {
    version = vj.version || ''; build = vj.build || '';
    if (Array.isArray(vj.changelog)) changelog = vj.changelog.slice(0, 6).join('\n');
  }
  if (!version) {
    // 没上传 version.json 时从 tag / zip 文件名兜底解析，保证不会「查不到更新」
    const m = String((zip && zip.name) || rel.tag_name || '').match(/v?(\d+\.\d+(?:\.\d+)?)/);
    version = m ? m[1] : String(rel.tag_name || '').replace(/^v/i, '');
  }
  return {
    version, build, changelog,
    zipName: zip ? zip.name : '',
    zipUrl: zip ? (zip.browser_download_url || zip.url || '') : '',
    zipSize: Number(zip && (zip.size || zip.download_count && 0)) || 0,
    tag: rel.tag_name || '',
    source: src.id,
    sourceLabel: src.label,
  };
}

/** 依次尝试各源，取第一个成功的 */
async function checkNow(opts = {}) {
  const errs = [];
  for (const src of sourcesOf()) {
    try {
      const rel = await fetchUrl(src.api, { json: true, timeout: TIMEOUT_API, maxBytes: 400000 });
      const info = parseRelease(rel, src);
      if (!info.version) throw new Error('远端没给出版本号');
      // version.json 是附件时再拉一次，拿到准确的 build 与中文更新说明
      const assets = (rel.assets || rel.attach_files) || [];
      const vj = assets.find(a => /^version\.json$/i.test(a.name || ''));
      if (vj && (vj.browser_download_url || vj.url)) {
        try {
          const v = await fetchUrl(vj.browser_download_url || vj.url, { json: true, timeout: TIMEOUT_API, maxBytes: 200000 });
          if (v && v.version) {
            info.version = v.version;
            info.build = v.build || '';
            if (Array.isArray(v.changelog) && v.changelog.length) info.changelog = v.changelog.slice(0, 6).join('\n');
          }
        } catch (e) { /* 拿不到就用手上的 */ }
      }
      const has = cmpVer(info.version, ctx.version) > 0;
      state.lastCheckAt = Date.now();
      state.lastCheckDay = nowDay();
      state.lastError = '';
      state.source = src.id;
      state.latest = info;
      saveState();
      return { ok: true, hasUpdate: has, latest: info, current: ctx.version, source: src.id };
    } catch (e) {
      errs.push(`${src.label}：${e.message || e}`);
    }
  }
  state.lastCheckAt = Date.now();
  state.lastError = errs.join('；');
  saveState();
  return { ok: false, error: state.lastError, current: ctx.version };
}
module.exports.checkNow = checkNow;

// ---------------------------------------------------------------- 解 压
/** 用系统 PowerShell 解压（项目零第三方依赖，不引入 unzip 库） */
function unzip(zipPath, dest) {
  return new Promise((resolve, reject) => {
    try { fs.mkdirSync(dest, { recursive: true }); } catch (e) { }
    const ps = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`,
    ];
    const p = spawn('powershell.exe', ps, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => err += d.toString());
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(true) : reject(new Error('解压失败：' + (err || code).toString().slice(0, 200)))));
  });
}

// ---------------------------------------------------------------- 安 装
const APPLY_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$here = $PSScriptRoot',
  '$log = Join-Path $here "apply.log"',
  'function W($m) { try { Add-Content -LiteralPath $log -Value ((Get-Date -Format "HH:mm:ss") + " " + $m) -Encoding UTF8 } catch {} }',
  'try {',
  '  $job = (Get-Content -LiteralPath (Join-Path $here "job.json") -Raw -Encoding UTF8) | ConvertFrom-Json',
  '  W ("start action=" + $job.action + " ver=" + $job.ver)',
  '  $exe = Join-Path $job.home $job.exeName',
  '  $short = [System.IO.Path]::GetFileNameWithoutExtension($job.exeName)',
  '  # 1) 等主进程退出：最多等 30 秒',
  '  for ($i = 0; $i -lt 60; $i++) {',
  '    $p = @(Get-Process -Name $short -ErrorAction SilentlyContinue)',
  '    if ($p.Count -eq 0) { break }',
  '    Start-Sleep -Milliseconds 500',
  '  }',
  '  Start-Sleep -Milliseconds 800',
  '  # 2) 万一守护进程抢先拉起了旧版，再清一次，否则文件被占用复制不了',
  '  Get-Process -Name $short -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue',
  '  Start-Sleep -Milliseconds 600',
  '  # 3) 覆盖主程序与说明文档（docs 列表由主程序生成，绝不含 config.json / data）',
  '  $src = Join-Path $job.src $job.exeName',
  '  if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $exe -Force; W "exe replaced" } else { W "MISSING exe" }',
  '  if ($job.docs) { foreach ($f in $job.docs) {',
  '    $s2 = Join-Path $job.src $f',
  '    if (Test-Path -LiteralPath $s2) { try { Copy-Item -LiteralPath $s2 -Destination (Join-Path $job.home $f) -Force } catch { W ("doc fail " + $f) } }',
  '  } }',
  '  # 4) 重新拉起',
  '  $psi = New-Object System.Diagnostics.ProcessStartInfo',
  '  $psi.FileName = $exe',
  '  $psi.WorkingDirectory = $job.home',
  '  $psi.UseShellExecute = $true',
  '  [System.Diagnostics.Process]::Start($psi) | Out-Null',
  '  W "restarted"',
  '} catch { W ("FAILED: " + $_.Exception.Message) }',
  '',
].join('\r\n');

/** 备份当前 exe，保留最近 3 份 */
function backupCurrent() {
  const src = path.join(ctx.home, ctx.exeName);
  if (!fs.existsSync(src)) return null;
  const dir = backupDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return null; }
  const tag = `${ctx.version}${ctx.build ? '-' + ctx.build : ''}`;
  const dst = path.join(dir, `v${tag}.exe`);
  try {
    fs.copyFileSync(src, dst);
    // 只留最近 3 份，避免磁盘被历史版本吃满（每份约 84MB）
    const olds = fs.readdirSync(dir).filter(f => /\.exe$/i.test(f))
      .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t).slice(3);
    for (const o of olds) { try { fs.unlinkSync(path.join(dir, o.f)); } catch (e) { } }
    return { version: ctx.version, build: ctx.build, file: dst, at: Date.now() };
  } catch (e) { return null; }
}

const DOCS = ['version.json', '使用说明.md', '快速开始.txt', '维护与升级手册.md',
  '安卓App-使用说明.txt', '环境检测.bat', '停止大屏.bat'];

/**
 * 完整安装动作：下载 → 解压 → 校验 → 备份 → 写替换脚本。
 * 返回 {ok:true, needExit:true} 时调用方必须让主进程退出，脚本才好替换文件。
 */
async function install(opts = {}) {
  if (busy) return { ok: false, error: '已有更新任务在进行中' };
  busy = 'install';
  const setPhase = (phase, percent) => {
    state.installing = { phase, percent: percent || 0, version: (state.latest || {}).version || '' };
    saveState();
    if (opts.onProgress) opts.onProgress(state.installing);
  };
  try {
    let latest = state.latest;
    if (!latest || opts.recheck !== false) {
      setPhase('检查更新', 2);
      const r = await checkNow();
      if (!r.ok) throw new Error('检查更新失败：' + r.error);
      latest = r.latest;
      if (!r.hasUpdate) {
        state.installing = null; saveState();
        return { ok: true, upToDate: true, version: ctx.version };
      }
    }
    if (cmpVer(latest.version, ctx.version) <= 0) {
      state.installing = null; saveState();
      return { ok: true, upToDate: true, version: ctx.version };
    }
    // 同一版本失败过就别反复重试，避免网络不好时每次启动都折腾一遍
    const key = latest.version + '|' + nowDay();
    state.attempt = state.attempt || {};
    if ((state.attempt[key] || 0) >= 3 && !opts.force) {
      state.installing = null; saveState();
      return { ok: false, error: `v${latest.version} 今天已尝试 3 次仍失败，明天再试；可在设置里手动重试` };
    }
    state.attempt[key] = (state.attempt[key] || 0) + 1;

    if (!latest.zipUrl) throw new Error('远端没有压缩包附件');

    const dir = updateDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { }
    const zipPath = path.join(dir, `v${latest.version}.zip`);
    setPhase('下载更新包', 5);
    try {
      await downloadTo(latest.zipUrl, zipPath, (got, total) => {
        const pct = total ? Math.min(60, 5 + Math.floor(got / total * 55)) : Math.min(50, 5 + Math.floor(got / 1024 / 1024 * 1.5));
        setPhase('下载更新包', pct);
      });
    } catch (e) {
      try { fs.unlinkSync(zipPath); } catch (x) { }
      throw new Error('下载失败：' + e.message);
    }
    // 校验：zip 头 + 体积，防止下到 HTML 错误页还当安装包用
    const st = (() => { try { return fs.statSync(zipPath); } catch (e) { return null; } })();
    if (!st || st.size < 1024 * 1024) throw new Error('下载到的文件不正常（' + (st ? st.size : 0) + ' 字节）');
    const head = Buffer.alloc(2);
    const fd = fs.openSync(zipPath, 'r'); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
    if (head[0] !== 0x50 || head[1] !== 0x4b) throw new Error('下载到的不是压缩包');

    setPhase('解压', 62);
    const work = path.join(dir, 'v' + latest.version);
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { }
    await unzip(zipPath, work);

    setPhase('校验', 75);
    const srcExe = path.join(work, ctx.exeName);
    if (!fs.existsSync(srcExe)) throw new Error('压缩包里没有主程序，已中止（不会动你现在的程序）');
    const exeSize = fs.statSync(srcExe).size;
    if (exeSize < 20 * 1024 * 1024) throw new Error('压缩包里的主程序不完整，已中止');

    setPhase('备份当前版本', 82);
    const bak = backupCurrent();
    if (bak) state.backup = bak;

    setPhase('准备安装', 90);
    const job = {
      action: 'install',
      ver: latest.version,
      from: ctx.version,
      home: ctx.home,
      exeName: ctx.exeName,
      src: work,
      docs: DOCS,
      at: Date.now(),
    };
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job, null, 2), 'utf8');
    const script = path.join(dir, 'apply.ps1');
    fs.writeFileSync(script, '\uFEFF' + APPLY_SCRIPT, 'utf8');   // BOM：让 PowerShell 稳当解析

    state.installing = { phase: '等待重启', percent: 95, version: latest.version };
    state.lastInstall = { from: ctx.version, to: latest.version, at: Date.now(), ok: null };
    saveState();
    return { ok: true, needExit: true, version: latest.version, script, job, backup: bak };
  } catch (e) {
    state.installing = null;
    state.lastError = String(e.message || e);
    if (state.lastInstall && state.lastInstall.ok === null) state.lastInstall = { ...state.lastInstall, ok: false, error: state.lastError };
    saveState();
    return { ok: false, error: state.lastError };
  } finally {
    busy = null;
  }
}
module.exports.install = install;

/**
 * 交棒给「安装器」：主进程随后立刻退出，由它完成文件替换与重新拉起。
 *
 * 首选方式：启动刚解压出来的新 exe（--apply-update 模式），它把自己搬到安装目录。
 * 这样不依赖 PowerShell，也不受执行策略 / 脚本编码影响；而且新 exe 与安装目录里的
 * 旧 exe 是不同路径，Windows 的文件占用不冲突。
 * 只有拿不到新 exe 时（例如开发模式）才退回 PowerShell 脚本。
 */
function launchApplier() {
  const dir = updateDir();
  const jobPath = path.join(dir, 'job.json');
  if (!fs.existsSync(jobPath)) return { ok: false, error: '没有待执行的安装任务' };
  let job = null;
  try { job = JSON.parse(fs.readFileSync(jobPath, 'utf8')); } catch (e) { return { ok: false, error: '安装任务读取失败' }; }
  const srcExe = path.join(job.src, job.exeName);
  if (fs.existsSync(srcExe)) {
    try {
      const child = spawn(srcExe, ['--apply-update'], {
        detached: true, stdio: 'ignore', windowsHide: true,
        cwd: path.dirname(srcExe),
        env: Object.assign({}, process.env, {
          DASH_HOME_LOCK: job.home,          // 别让它把主目录登记成临时目录
          DASH_UPDATE_JOB: jobPath,
          DASH_HIDDEN: '1',
        }),
      });
      child.unref();
      return { ok: true, mode: 'self', pid: child.pid };
    } catch (e) { /* 落到脚本方式 */ }
  }
  const script = path.join(dir, 'apply.ps1');
  if (!fs.existsSync(script)) {
    fs.writeFileSync(script, '\uFEFF' + APPLY_SCRIPT, 'utf8');
  }
  try {
    const child = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script],
      { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return { ok: true, mode: 'powershell', pid: child.pid };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
module.exports.launchApplier = launchApplier;

/**
 * 启动后自检：上一次安装到底成了没有。
 * 新版本起来了 → 版本对得上，标记成功；版本没变 → 说明没装成，记下失败别反复重试。
 */
function noteApplied() {
  const li = state.lastInstall;
  if (!li || li.ok !== null) return null;
  if (li.to && String(li.to) === String(ctx.version)) {
    li.ok = true;
    li.at = Date.now();
    state.installing = null;
    saveState();
    return { ok: true, version: li.to };
  }
  li.ok = false;
  li.error = '安装后版本号没变（v' + ctx.version + '），可能没换成';
  state.installing = null;
  saveState();
  return { ok: false, error: li.error };
}
module.exports.noteApplied = noteApplied;

// ---------------------------------------------------------------- 回 滚
function rollback() {
  const bak = state.backup;
  if (!bak || !bak.file || !fs.existsSync(bak.file)) return { ok: false, error: '没有可用的上一版备份' };
  const dir = updateDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { }
  // 备份文件单独放一个目录，复用同一个替换脚本
  const srcDir = path.join(dir, 'rollback');
  try { fs.mkdirSync(srcDir, { recursive: true }); } catch (e) { }
  try {
    fs.copyFileSync(bak.file, path.join(srcDir, ctx.exeName));
  } catch (e) { return { ok: false, error: '准备回滚文件失败：' + e.message }; }
  const job = {
    action: 'rollback', ver: bak.version, from: ctx.version,
    home: ctx.home, exeName: ctx.exeName, src: srcDir, docs: [], at: Date.now(),
  };
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job, null, 2), 'utf8');
  const script = path.join(dir, 'apply.ps1');
  fs.writeFileSync(script, '\uFEFF' + APPLY_SCRIPT, 'utf8');
  state.lastInstall = { from: ctx.version, to: bak.version, at: Date.now(), ok: null, rollback: true };
  saveState();
  return { ok: true, needExit: true, target: bak.version };
}
module.exports.rollback = rollback;

// ---------------------------------------------------------------- 自动检查
function setEnabled(on) {
  state.enabled = !!on;
  saveState();
  return state.enabled;
}
module.exports.setEnabled = setEnabled;

/**
 * 启动时调用：每天只自动查一次；查到就按全自动流程装（下载完退出让脚本接管）。
 * onAutoInstall 回调由 server 决定何时安全退出。
 */
async function autoCheckIfNeeded(opts = {}) {
  if (!state.enabled) return { skipped: 'disabled' };
  if (state.lastCheckDay === nowDay() && !opts.force) return { skipped: 'today-done' };
  const r = await checkNow();
  if (!r.ok || !r.hasUpdate) return r;
  if (opts.autoInstall === false) return r;
  return { ...r, install: await install({ onProgress: opts.onProgress }) };
}
module.exports.autoCheckIfNeeded = autoCheckIfNeeded;

module.exports.getState = () => state;
module.exports.SOURCES = SOURCES;
module.exports.DOCS = DOCS;
