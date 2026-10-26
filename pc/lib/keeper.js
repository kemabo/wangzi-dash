'use strict';
/**
 * 运行保障：让大屏「随时能拿到数据」，而不是靠右下角托盘图标肉眼确认。
 *
 * 三件事（一个开关统一管）：
 *   1) 开机自动启动 —— 往当前用户的「启动」文件夹放一个快捷方式
 *   2) Windows 计划任务 —— 登录时启动一次 + 每 5 分钟检查一次
 *      （已在运行就跳过：MultipleInstancesPolicy=IgnoreNew），
 *      程序被关掉/崩溃后最多 5 分钟自己回来
 *   3) 可选：右下角托盘图标（默认关，之前在部分机器上起不来）
 *
 * 计划任务走 PowerShell 的 ScheduledTasks 模块，不用 schtasks.exe 的 XML，
 * 少一层 XML schema 顺序问题；结果写回一个 JSON 文件给 Node 读，便于排查。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TASK_NAME = '王子鞋服经营数据大屏';
const LNK_NAME = '王子鞋服经营数据大屏.lnk';

function cfgFile(dataDir) { return path.join(dataDir, 'keeper.json'); }

function readCfg(dataDir) {
  try {
    const o = JSON.parse(fs.readFileSync(cfgFile(dataDir), 'utf8'));
    return (o && typeof o === 'object') ? o : {};
  } catch (e) { return {}; }
}
function writeCfg(dataDir, patch) {
  const next = Object.assign(readCfg(dataDir), patch || {});
  try { fs.writeFileSync(cfgFile(dataDir), JSON.stringify(next, null, 2), 'utf8'); } catch (e) { }
  return next;
}

function psBin() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const full = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try { return fs.existsSync(full) ? full : 'powershell'; } catch (e) { return 'powershell'; }
}

/**
 * 守护用的静默启动器：计划任务每 5 分钟要试一次，直接跑 exe 会闪一下黑窗口，
 * 用 wscript 包一层（窗口样式 0 = 完全隐藏）就没人能察觉。
 */
function writeLauncher(dataDir, exe, wd) {
  const vbs = path.join(dataDir, 'guard.vbs');
  const body = [
    'On Error Resume Next',
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${String(wd).replace(/"/g, '')}"`,
    `sh.Run """${String(exe).replace(/"/g, '')}"" --guard", 0, False`,
    '',
  ].join('\r\n');
  try { fs.writeFileSync(vbs, body, 'utf8'); return vbs; } catch (e) { return ''; }
}

function buildScript() {
  const esc = (s) => String(s == null ? '' : s).replace(/'/g, "''");
  return `param(
  [string]$mode = 'status',
  [string]$exe  = '',
  [string]$wd   = '',
  [string]$out  = '',
  [string]$vbs  = ''
)
$ErrorActionPreference = 'Stop'
$taskName = '${esc(TASK_NAME)}'
$lnkName  = '${esc(LNK_NAME)}'
$res = [ordered]@{ task = $false; startup = $false; state = ''; error = ''; ps = $true }

function Write-Out($o) {
  if (-not $out) { return }
  try { [System.IO.File]::WriteAllText($out, ($o | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false)) } catch { }
}

try {
  Import-Module ScheduledTasks -ErrorAction Stop
} catch {
  $res.ps = $false
  $res.error = '无法加载计划任务模块：' + $_.Exception.Message
}

try {
  $startupDir = [Environment]::GetFolderPath('Startup')
  $lnk = Join-Path $startupDir $lnkName

  if ($mode -eq 'on') {
    if ($exe -and (Test-Path $exe)) {
      # 1) 开机自启：启动文件夹里放一个最小化运行的快捷方式
      try {
        $s = (New-Object -COM WScript.Shell).CreateShortcut($lnk)
        $s.TargetPath = $exe
        $s.WorkingDirectory = $wd
        $s.WindowStyle = 7
        $s.Description = '王子鞋服经营数据大屏（后台运行）'
        $s.Save()
      } catch { }
      $res.startup = Test-Path $lnk

      # 2) 计划任务：登录触发一次 + 之后每 5 分钟补一次（已在跑就不再起新实例）
      if ($res.ps) {
        $t1 = New-ScheduledTaskTrigger -AtLogOn
        $t2 = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) \`
          -RepetitionInterval (New-TimeSpan -Minutes 5) \`
          -RepetitionDuration (New-TimeSpan -Days 3650)
        # 有静默启动器就用它（不闪黑窗口），没有就直接跑 exe
        if ($vbs -and (Test-Path $vbs)) {
          $act = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"') -WorkingDirectory $wd
        } else {
          $act = New-ScheduledTaskAction -Execute $exe -Argument '--guard' -WorkingDirectory $wd
        }
        $set = New-ScheduledTaskSettingsSet \`
          -MultipleInstances IgnoreNew \`
          -AllowStartIfOnBatteries \`
          -DontStopIfGoingOnBatteries \`
          -StartWhenAvailable \`
          -ExecutionTimeLimit ([System.TimeSpan]::Zero) \`
          -RestartCount 3 \`
          -RestartInterval (New-TimeSpan -Minutes 1)
        Register-ScheduledTask -TaskName $taskName -Trigger @($t1, $t2) -Action $act -Settings $set -Force -ErrorAction Stop | Out-Null
        $res.task = $true
      }
    } else {
      $res.error = '找不到程序文件：' + $exe
    }
  }

  if ($mode -eq 'off') {
    try { Remove-Item -LiteralPath $lnk -Force -ErrorAction SilentlyContinue } catch { }
    $res.startup = $false
    if ($res.ps) {
      try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop } catch { }
    }
    $res.task = $false
  }

  if ($mode -eq 'status') {
    $res.startup = Test-Path $lnk
    if ($res.ps) {
      try {
        $t = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
        $res.task = $true
        $res.state = [string]$t.State
      } catch { $res.task = $false }
    }
  }
} catch {
  $res.error = $_.Exception.Message
}

Write-Out $res
`;
}

/**
 * @param {'status'|'on'|'off'} mode
 * @param {{dataDir:string, exe:string, wd:string}} opt
 */
function run(mode, opt) {
  const dataDir = opt.dataDir;
  try { if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true }); } catch (e) { }
  const ps1 = path.join(dataDir, 'keeper.ps1');
  const outFile = path.join(dataDir, 'keeper.result.json');
  try { fs.unlinkSync(outFile); } catch (e) { }
  try {
    // 必须带 BOM：PowerShell 5.1 读无 BOM 的 UTF-8 会按 GBK 解码，中文全乱导致脚本解析失败
    fs.writeFileSync(ps1, '\uFEFF' + buildScript(), 'utf8');
  } catch (e) { return { task: false, startup: false, error: '无法写入脚本：' + e.message }; }

  const vbs = (mode === 'on') ? writeLauncher(dataDir, opt.exe || '', opt.wd || '') : '';
  const args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ps1,
    '-mode', mode, '-exe', String(opt.exe || ''), '-wd', String(opt.wd || ''), '-out', outFile,
    '-vbs', vbs];
  let err = '';
  try {
    execFileSync(psBin(), args, { windowsHide: true, timeout: 40000 });
  } catch (e) { err = String(e.message || e); }

  let r = null;
  try { r = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (e) { }
  if (!r) r = { task: false, startup: false, state: '', error: err || '未返回结果' };
  if (err && !r.error) r.error = err;
  return r;
}

/** 本机 exe / 工作目录 */
function appPaths(seaExeDir, rootDir, isSea) {
  const exe = isSea ? process.execPath : path.join(rootDir, '王子鞋服经营数据大屏.exe');
  return { exe, wd: path.dirname(exe) };
}

/**
 * 打开/关闭「开机自启 + 计划任务守护」
 * @param {boolean} on
 */
function setKeeper(on, opt) {
  const r = run(on ? 'on' : 'off', opt);
  writeCfg(opt.dataDir, { on: !!on, lastError: r.error || '' });
  return {
    ok: !!on ? (!!r.task || !!r.startup) : true,
    on: !!on,
    task: !!r.task,
    startup: !!r.startup,
    state: r.state || '',
    error: r.error || '',
  };
}

function keeperStatus(opt) {
  const r = run('status', opt);
  const cfg = readCfg(opt.dataDir);
  return {
    on: !!(r.task || r.startup),
    task: !!r.task,
    startup: !!r.startup,
    state: r.state || '',
    error: r.error || '',
    configured: Object.prototype.hasOwnProperty.call(cfg, 'on'),
  };
}

module.exports = { setKeeper, keeperStatus, readCfg, writeCfg, TASK_NAME, LNK_NAME, appPaths };
