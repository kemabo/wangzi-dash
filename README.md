# 王子鞋服经营数据大屏（PC 端源码）

一套面向多门店零售经营的**本地数据大屏**：实时汇总各门店销售额、毛利、客流、大类/小类销售与库存、季节与供应商分析，支持按日/周/月/年多档位查看，可打包为 Windows 单文件 exe 分发。

> 本仓库为**脱敏开源版**：不含任何门店账号、密码、登录令牌，也不含第三方平台的 appKey 与真实域名。

---

## 一、目录结构

```
pc/
  server.js              大屏本地服务端（启动入口）
  config.example.js      配置模板（复制为 config.js / config.json 后填自己的门店）
  build-exe.js           打包为 Windows 单文件 exe
  package.json
  lib/                   取数、聚合、导出等核心逻辑
    aggregate.js         数据聚合与指标计算
    collector.js         取数编排（带节流队列与限流熔断）
    fetchpolicy.js       限速策略（按租户隔离队列 + 令牌桶）
    session.js           登录与接口封装
    mobile-erp.js        移动端直连通道（大屏不可达时的兜底取数）
    season.js / seasondetail.js   季节销售与库存
    storeview.js         门店视图
    updater.js           自动更新
    xlsx.js              表格导出
  public/                前端页面
    index.html / style.css / app.js
    m/                   移动端页面
    logo.png / favicon.png
```

## 二、快速开始

```bash
cd pc
npm install          # 依赖较少，也可直接用系统 node 运行
cp config.example.js config.js      # 或复制为 config.json
# 编辑 config.js，填入自己的门店（见下）
node server.js
```

浏览器打开启动日志里提示的地址（默认 `http://127.0.0.1:8777`）即可看到大屏。

### 配置自己的门店

编辑 `config.js` 里的 `DEFAULT_ACCOUNTS`：

```js
const DEFAULT_ACCOUNTS = [
  { tenantCode: '你的商户ID', userAccount: '9999', password: '你的密码', alias: '门店显示名' },
];
```

也支持放在 exe 同目录的 `config.json`（优先级更高），这样升级程序不会覆盖配置。

> **仓库里的 `config.example.js` 账号数组是空的**，就是为了避免把真实账号提交上来。`config.js` / `config.json` 已在 `.gitignore` 中排除，请放心在本地填写。

## 三、对接的数据源

大屏通过 HTTP 对接一套**零售云平台**（门店 ERP/收银系统云端）取数。仓库中相关地址与凭据均已占位化：

| 占位符 | 含义 |
|---|---|
| `https://erp.example.com` | 登录与接口域名，请替换为你自己的服务地址 |
| `YOUR_APPKEY` | 接口调用凭据，请替换为你自己的 appKey |
| `YOUR_MOBILE_APPID` / `YOUR_MOBILE_APPKEY` | 移动端通道凭据 |
| `10000001` ~ `10000004` | 示例商户ID（原真实商户ID已移除） |

因此在**填入自己的地址与凭据之前，程序无法直接连通取数**——这是有意为之：第三方平台的凭据不应出现在公开仓库里。

## 四、取数安全（重要）

门店收银系统与大屏共用同一套账号体系，取数过猛会影响前台收银。因此代码内置了多层保护：

- **限速**：每个请求过令牌桶闸门，默认 12 次/分钟，按租户隔离队列
- **熔断**：命中平台「操作过于频繁」类响应时进入保护期，按 30s → 60s → 2min → 5min 指数退避，期间不再发请求
- **兜底**：取数失败回退到本地缓存，宁可显示稍旧的数据，也不让大屏空白
- **串行**：重任务（商品档案、库存分页）串行拉取，避免瞬间打出大量请求

## 五、打包分发

```bash
cd pc
node build-exe.js      # 产出单文件 exe（内嵌前端与 node 运行时）
```

产出的 exe 可拷贝到任意 Windows 电脑直接双击运行，无需安装 Node。

## 六、说明

- 本仓库只含 **PC 大屏源码**，不含安卓 App 与任何安装包
- 不含任何门店账号、密码、会话令牌；所有敏感项均已占位化或由 `.gitignore` 排除
- 界面截图、发布包、构建产物等大文件不入库

如发现仓库中仍有敏感信息残留，请提交 issue 或直接联系作者处理。
