# 王子鞋服经营数据（安卓 App + 电脑大屏）

仓库内容：安卓 App 安装包、使用说明、前端与壳工程源码。
**仓库内不含任何门店账号密码**（config.json、data/、含密码目录均已排除）。

## 下载（最新版 大屏 v1.1.6 / App v1.6.1）

| 文件 | 说明 |
| --- | --- |
| [WangziDash-Screen-v1.1.6.zip](https://gitee.com/kemabo/wangzi-dash/releases/download/v1.1.6/WangziDash-Screen-v1.1.6.zip) | 电脑大屏 v1.1.6 压缩包（解压即用，已剔除 config.json） |
| [WangziDash-Android-v1.6.1.apk](https://gitee.com/kemabo/wangzi-dash/releases/download/v1.1.6/WangziDash-Android-v1.6.1.apk) | 安卓 App v1.6.1（versionCode 12），直接覆盖安装 |
| [安卓App-使用说明.txt](安卓App-使用说明.txt) | 安装与配置说明（门店配置导入、同步到手机） |

Release 页：[Gitee](https://gitee.com/kemabo/wangzi-dash/releases/v1.1.6) ｜ [GitHub](https://github.com/kemabo/wangzi-dash/releases/tag/v1.1.6)
（备用下载地址把域名换成 github.com 即可，两边内容一致。）

`version.json` 是给大屏**自动更新**识别版本用的，请勿删除。

## 电脑大屏 v1.1.6（2026-10-12d）

- **自动更新**：每天打开大屏自动检查一次新版本，发现即自动下载、备份、安装并重启一次
  （约半分钟，期间不用操作）；更新源默认 Gitee，取不到自动换 GitHub
- 安装前自动备份当前版本，出问题可在 **设置 → 更新** 一键回滚
- 更新只替换主程序与说明文档，绝不动 config.json（门店账号密码）和 data（数据缓存）
- 修复：打包版 exe 的命令行参数解析（此前 `--guard` 第一个参数会被忽略）
- v1.1.5：供应商排名改按**销售数量**从多到少排序；单店视角按本店数值重排
- v1.1.4：取消右列分块排版，季节表恢复完整高度；供应商排名嵌入「各大类销售数量与库存」表，
  **点大类行即展开**；数据跟随顶部时间档（实时 / 昨天 / 本周 / 本月 / 上月），切档秒出

## 安卓 App v1.6.1（versionCode 12）

- 新增「大类 × 供应商」榜：点大类展开该类的供应商排名（销售数量 / 销售额 / 库存数量 / 库存成本）
- 供应商取自商品档案，未维护供应商的商品归入「未填供应商」并排在最后
- 供应商数据随当前时间档走，本日缓存 30 分钟、本周 / 本年 6 小时

## 目录

```
android/www-src/        前端（index.html / app.js / core.js / app.css）
android/app-src-src/    安卓壳 Java 源码（DashBridge 网络桥）
android/app-src-res/    App 资源
android/AndroidManifest.xml
android/build-apk.sh     打包脚本（aapt2 → javac → d8 → zipalign → apksigner）
```

## 安全提醒

App 内的门店密码只保存在手机本地，导入配置文本时才需要填写。
分发大屏压缩包前确认里面没有 `config.json`（本项目发布包默认已剔除）。
