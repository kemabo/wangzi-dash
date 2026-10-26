'use strict';
/**
 * 屏保 / 空闲全屏（Windows）
 *
 * 老做法为什么要改：以前是把 83MB 的 exe 复制成 System32\*.scr（要管理员），
 * 装完还得用户自己去「屏幕保护程序」下拉里手工选 —— 中文文件名在很多机器上
 * 根本不出现在列表里，而且代码永远返回成功，失败了也显示成功，排障无从下手。
 *
 * 新做法：
 *  1. 主链路直接写 HKCU\Control Panel\Desktop\SCRNSAVE.EXE，把屏保指向 exe 自身。
 *     屏保并不要求文件必须在 System32，任意路径都行 —— 不需要管理员，也不需要
 *     去下拉里选，点一下就是「真装上」。
 *  2. 所有操作同步等待 PowerShell 执行完、读回真实结果，成功就是成功，失败会
 *     把具体原因带回来。
 *  3. 尽力尝试立即生效（SystemParametersInfo）；权限受限时明确告诉用户需要注销一次。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let SEA = false;
try { SEA = require('node:sea').isSea(); } catch (e) { SEA = false; }

const REG_KEY = 'HKCU:\\Control Panel\\Desktop';
const SAVER_NAME = '门店经营数据大屏';

function q(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

/** 跑一段 PowerShell，结果写进临时文件再读回来（避免管道中文乱码） */
function psRun(lines, timeout) {
  const resFile = path.join(os.tmpdir(), `dash-saver-res-${process.pid}-${Date.now()}.txt`);
  const scriptFile = path.join(os.tmpdir(), `dash-saver-${process.pid}-${Date.now()}.ps1`);
  const script = [
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `$__res = ${q(resFile)}`,
    'trap {',
    '  $m = $_.Exception.Message',
    '  Set-Content -LiteralPath $__res -Value ("FAIL " + $m) -Encoding UTF8',
    '  exit 1',
    '}',
    ...lines,
  ].join('\r\n');
  try { fs.writeFileSync(scriptFile, '\uFEFF' + script, 'utf8'); } catch (e) {
    return { ok: false, error: '写不了临时脚本：' + e.message };
  }
  let code = -1, err = '';
  try {
    const r = spawnSync('powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile],
      { encoding: 'utf8', timeout: timeout || 120000, windowsHide: true });
    code = r.status;
    err = String(r.stderr || '').trim();
  } catch (e) {
    try { fs.unlinkSync(scriptFile); } catch (x) { }
    return { ok: false, error: 'PowerShell 执行失败：' + e.message };
  }
  let out = '';
  try { if (fs.existsSync(resFile)) out = fs.readFileSync(resFile, 'utf8').trim(); } catch (e) { }
  try { fs.unlinkSync(scriptFile); } catch (e) { }
  try { fs.unlinkSync(resFile); } catch (e) { }
  if (!out) return { ok: false, error: err ? cleanErr(err) : `PowerShell 退出码 ${code}，没有返回结果` };
  if (out.startsWith('FAIL ')) return { ok: false, error: cleanErr(out.slice(5)) };
  return { ok: true, text: out };
}

function cleanErr(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function parseKV(text) {
  const o = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return o;
}

function screensaverName() {
  return path.basename(process.execPath, path.extname(process.execPath)) + '.scr';
}
function system32Target() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', screensaverName());
}
function system32CopyExists() {
  try { return fs.existsSync(system32Target()); } catch (e) { return false; }
}

/** 读取当前这台机器的屏保设置 */
function state() {
  const collect = [
    `$p = Get-ItemProperty -Path ${q(REG_KEY)} -ErrorAction SilentlyContinue`,
    'if (-not $p) { Set-Content -LiteralPath $__res -Value "NOP=1" -Encoding UTF8; exit 0 }',
    '$o = @()',
    '$o += "SCRNSAVE=" + $p."SCRNSAVE.EXE"',
    '$o += "ACTIVE=" + $p.ScreenSaveActive',
    '$o += "TIMEOUT=" + $p.ScreenSaveTimeOut',
    '$o += "SECURE=" + $p.ScreenSaverIsSecure',
    'Set-Content -LiteralPath $__res -Value ($o -join "`n") -Encoding UTF8',
  ];
  const r = psRun(collect, 60000);
  const st = {
    ok: r.ok, error: r.error || '',
    sea: SEA, exe: process.execPath,
    target: system32Target(),
    systemCopy: system32CopyExists(),
    current: '', active: false, timeoutSec: 0, secure: false,
    isOurs: false, appliedImmediately: false,
  };
  if (r.ok) {
    const kv = parseKV(r.text);
    st.current = (kv.SCRNSAVE || '').replace(/\0/g, '');
    st.active = kv.ACTIVE === '1';
    st.timeoutSec = Number(kv.TIMEOUT || 0) || 0;
    st.secure = kv.SECURE === '1';
    const base = path.basename(String(st.current || '')).toLowerCase();
    st.isOurs = !!base && base === path.basename(process.execPath).toLowerCase();
  }
  return st;
}

/**
 * 启用屏保：把系统屏保指向本 exe（免管理员），并设定等待分钟数。
 * @param {number} minutes 空闲多少分钟后进入屏保
 */
function enable(minutes) {
  if (!SEA) return { ok: false, error: '只有打包出来的 exe 才能设为系统屏保（当前是开发模式）' };
  const min = Math.max(1, Math.min(600, Number(minutes) || 10));
  const sec = Math.round(min * 60);
  const exe = process.execPath;
  const lines = [
    `$exe = ${q(exe)}`,
    `$k = ${q(REG_KEY)}`,
    '$sec = ' + sec,
    'if (-not (Test-Path -LiteralPath $exe)) { throw "找不到程序本体：$exe" }',
    'Set-ItemProperty -Path $k -Name "SCRNSAVE.EXE" -Value $exe -Type String -Force',
    'Set-ItemProperty -Path $k -Name "ScreenSaveActive" -Value "1" -Type String -Force',
    'Set-ItemProperty -Path $k -Name "ScreenSaveTimeOut" -Value ([string]$sec) -Type String -Force',
    'Set-ItemProperty -Path $k -Name "ScreenSaverIsSecure" -Value "0" -Type String -Force',
    // 尽力让设置立刻生效；权限受限（不允许动态编译）就跳过，只是需要注销一次
    '$immediate = "0"',
    'try {',
    '  $sig = \'[DllImport("user32.dll")] public static extern bool SystemParametersInfo(int a, int b, string c, int d);\'',
    '  Add-Type -MemberDefinition $sig -Name DashWinApi -Namespace DashSaver -ErrorAction Stop',
    '  [void][DashSaver.DashWinApi]::SystemParametersInfo(17, 1, $exe, 0)',
    '  [void][DashSaver.DashWinApi]::SystemParametersInfo(18, $sec, $null, 0)',
    '  $immediate = "1"',
    '} catch { }',
    'Set-Content -LiteralPath $__res -Value ("IMMEDIATE=" + $immediate) -Encoding UTF8',
  ];
  const r = psRun(lines, 120000);
  if (!r.ok) return { ok: false, error: r.error };
  const kv = parseKV(r.text);
  return Object.assign({ ok: true, minutes: min, timeoutSec: sec, target: exe }, kv);
}

/** 停用系统屏保（不再自动全屏），不动其它设置 */
function disable() {
  const lines = [
    `$k = ${q(REG_KEY)}`,
    'Set-ItemProperty -Path $k -Name "ScreenSaveActive" -Value "0" -Type String -Force',
    'Set-ItemProperty -Path $k -Name "SCRNSAVE.EXE" -Value "" -Type String -Force',
    '$immediate = "0"',
    'try {',
    '  $sig = \'[DllImport("user32.dll")] public static extern bool SystemParametersInfo(int a, int b, string c, int d);\'',
    '  Add-Type -MemberDefinition $sig -Name DashWinApi -Namespace DashSaver -ErrorAction Stop',
    '  [void][DashSaver.DashWinApi]::SystemParametersInfo(17, 0, $null, 0)',
    '  $immediate = "1"',
    '} catch { }',
    'Set-Content -LiteralPath $__res -Value ("IMMEDIATE=" + $immediate) -Encoding UTF8',
  ];
  const r = psRun(lines, 120000);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true };
}

/** 只改等待时间（屏保已启用时） */
function setMinutes(minutes) {
  const min = Math.max(1, Math.min(600, Number(minutes) || 10));
  const sec = Math.round(min * 60);
  const r = psRun([
    `$k = ${q(REG_KEY)}`,
    'Set-ItemProperty -Path $k -Name "ScreenSaveTimeOut" -Value ' + q(String(sec)) + ' -Type String -Force',
    'try {',
    '  $sig = \'[DllImport("user32.dll")] public static extern bool SystemParametersInfo(int a, int b, string c, int d);\'',
    '  Add-Type -MemberDefinition $sig -Name DashWinApi -Namespace DashSaver -ErrorAction Stop',
    '  [void][DashSaver.DashWinApi]::SystemParametersInfo(18, ' + sec + ', $null, 0)',
    '} catch { }',
    'Set-Content -LiteralPath $__res -Value "OK=1" -Encoding UTF8',
  ], 120000);
  return r.ok ? { ok: true, minutes: min } : { ok: false, error: r.error };
}

/** 打开 Windows 的「屏幕保护程序设置」窗口 */
function openSettings() {
  const r = psRun([
    "foreach ($c in @('desk.cpl,,1','desk.cpl,,@ScreenSaver')) {",
    '  try { Start-Process rundll32.exe -ArgumentList "shell32.dll,Control_RunDLL $c" -ErrorAction Stop; break } catch { }',
    '}',
    'Set-Content -LiteralPath $__res -Value "OK=1" -Encoding UTF8',
  ], 30000);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/** 清理旧做法留在 System32 的副本（需要管理员，失败不影响主链路） */
function removeSystemCopy() {
  const target = system32Target();
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const script = [
    '$ErrorActionPreference = "Stop"',
    `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
    `$scr = ${q(target)}`,
    'Remove-Item -LiteralPath $scr -Force -ErrorAction SilentlyContinue',
    'Remove-Item -LiteralPath ($scr + ".origin") -Force -ErrorAction SilentlyContinue',
    'Set-Content -LiteralPath $__res -Value "OK=1" -Encoding UTF8',
  ];
  if (!SEA) return { ok: false, error: '开发模式没有 System32 副本' };
  return psRun(script, 120000);
}

module.exports = {
  SAVER_NAME, state, enable, disable, setMinutes, openSettings,
  removeSystemCopy, screensaverName, system32Target,
  setSea(v) { SEA = !!v; },
};
