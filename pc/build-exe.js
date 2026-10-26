'use strict';
// 打包单文件 exe：esbuild 打包服务端 → Node SEA blob → postject 注入 node.exe
// 运行：NODE_PATH=<workspace>/node_modules node build-exe.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist', 'sea');
// 宿主 Node：默认用正在跑的这个；找不到就在 versions 目录下挑一个最新的 22.x
function pickNode() {
  if (process.env.SEA_NODE_EXE && fs.existsSync(process.env.SEA_NODE_EXE)) return process.env.SEA_NODE_EXE;
  const cur = process.execPath;
  if (cur && fs.existsSync(cur)) return cur;
  const verDir = path.join(path.dirname(path.dirname(cur)), 'versions');
  const list = fs.readdirSync(verDir).filter(x => /^22\./.test(x)).sort();
  if (!list.length) throw new Error('找不到可用的 Node 22 宿主：' + verDir);
  return path.join(verDir, list[list.length - 1], 'node.exe');
}
const NODE_EXE = pickNode();

function rel(p) { return path.join(ROOT, p); }
function log(...a) { console.log('[build]', ...a); }

async function main() {
  fs.mkdirSync(DIST, { recursive: true });

  // 1. esbuild 打包 server.js（零第三方依赖，全部内联）
  const esbuild = require('esbuild');
  await esbuild.build({
    entryPoints: [rel('server.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: path.join(DIST, 'server.cjs'),
    logLevel: 'info',
  });
  log('esbuild 完成');

  // 2. 生成 SEA 配置与 blob
  const seaConfig = {
    main: path.join(DIST, 'server.cjs').replace(/\\/g, '/'),
    output: path.join(DIST, 'sea-prep.blob').replace(/\\/g, '/'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets: {
      'public/index.html': rel('public/index.html').replace(/\\/g, '/'),
      'public/app.js': rel('public/app.js').replace(/\\/g, '/'),
      'public/style.css': rel('public/style.css').replace(/\\/g, '/'),
      'public/m/index.html': rel('public/m/index.html').replace(/\\/g, '/'),
      'public/m/app.js': rel('public/m/app.js').replace(/\\/g, '/'),
      'public/m/app.css': rel('public/m/app.css').replace(/\\/g, '/'),
      'public/m/core.js': rel('public/m/core.js').replace(/\\/g, '/'),
      'public/m/presets.js': rel('public/m/presets.js').replace(/\\/g, '/'),
      'public/m/sample-data.js': rel('public/m/sample-data.js').replace(/\\/g, '/'),
    },
  };
  fs.writeFileSync(path.join(DIST, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
  execFileSync(NODE_EXE, ['--experimental-sea-config', path.join(DIST, 'sea-config.json')], { stdio: 'inherit' });
  log('SEA blob 完成');

  // 3. 复制 node.exe 作为宿主
  const exePath = path.join(DIST, 'dashboard.exe');
  fs.copyFileSync(NODE_EXE, exePath);
  log('宿主 exe 就绪', (fs.statSync(exePath).size / 1048576).toFixed(1) + 'MB');

  // 4. postject 注入 blob
  const postject = require('postject');
  const blob = fs.readFileSync(path.join(DIST, 'sea-prep.blob'));
  await postject.inject(exePath, 'NODE_SEA_BLOB', blob, {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    machoSegmentName: 'NODE_SEA',
  });
  log('postject 注入完成');

  // 5. 输出成品（中文名）
  const finalPath = path.join(DIST, '王子鞋服经营数据大屏.exe');
  fs.copyFileSync(exePath, finalPath);
  log('成品：', finalPath, (fs.statSync(finalPath).size / 1048576).toFixed(1) + 'MB');
}

main().catch(e => { console.error('[build] 失败：', e); process.exit(1); });
