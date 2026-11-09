# 0.1.0 验证记录

日期：2026-11-09。验证在独立模板目录进行；输入仅为虚构代理节点、无效密码和文档专用出口 IP。没有导入模板配置、安装系统服务、运行实际的安装／升级／卸载，或发起账号登录。

| 检查 | 结果／范围 |
|---|---|
| Node 回归 | 129 项通过；Node 22.23.2 |
| 东京故障行为 | 默认锁定、旧连接关闭、备用核验、错误出口锁定、暂时故障恢复、人工锁持久化、TUN 等待恢复、超时与迟到结果、延迟恶化及冷却 |
| 分流与模板 | 两个层级、美国主备、同一东京住宅、进程规则优先、独立用户参数、私有输入限制、不可部署演示包、修改文件拒绝、完整规则绑定 |
| 可选模块 | 浏览器代理参数、登录 URL／过期拒绝、SSH 路线覆盖拒绝、Codex 子环境与命令解析；无真实登录 |
| 原生编译 | 控制 helper、菜单栏、浏览器入口、浏览器策略读取、登录入口均在隔离目录编译 |
| 原生状态灯 | 26 项内置自检通过；没有打开真实状态窗口 |
| macOS 文件 | launchd／App plist 语法、sudoers 语法、生成后的 JS 语法通过 |
| Mihomo | 基础配置、增强配置、独立东京内核配置，3 类 `-t` 检查通过；增强版 111 条候选规则另由全部出口为 REJECT 的隔离内核解析，无第二个 TUN |
| 可搬移运行时 | 明确拒绝依赖 Homebrew / rpath 私有动态库的 Node；独立 Node 复制后可以执行 |
| 隐私 | 公开文件扫描通过；保留第三方许可证；公开包按严格文件清单导出，排除私有输入、配置、二进制与浏览器资料 |
| 既有环境 | 开始／结束比较的 319 个可读取现用配置及组件文件摘要一致；另有 1 个初始不可读文件未计入。未执行原服务控制或网络重载 |

保留的未验收项：

- 另一台干净 Mac 上的管理员安装、升级失败回滚与卸载生命周期。
- 使用收件人真实订阅／住宅的出口、断网、TUN 恢复、睡眠／重启验证。
- 当前真实 Claude / Grok / Codex、浏览器扩展、登录回调及工具连接的端到端验收。
- ASWebAuthenticationSession 原生认证窗口；不继承“系统浏览器跳转可用”作为它的通过证据。
- GitHub 远端 CI、跨 macOS / CPU 架构兼容、其他客户端的导入行为。

这些项目需要目标环境，不通过修改当前正在使用的网络来制造“验收完成”。具体步骤见 `ACCEPTANCE.md`。

可复核命令：

```sh
npm run check
npm test
npm run audit:public
# 明确提供本机独立 Node、Mihomo 和现有 GeoIP/GeoSite 数据后，构建虚构包：
node scripts/toolkit.mjs prepare --config examples/config.example.json --out .private/native-demo \
  --demo --node "$NODE_BINARY" --mihomo "$MIHOMO_BINARY"
node scripts/verify-native.mjs .private/native-demo "$CLASH_DATA_DIRECTORY"
```

示例默认不含登录／工具组件；要重复全组件编译，复制示例到私有文件、将四个 feature 开关均设为 true，仍保留 `demo: true`。上述核验结果不等于现在任何一条生产线路的健康证明。
