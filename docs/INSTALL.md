# 在新的 Mac 安装

本指南针对新的安装目标。整理／查看模板时不需要执行任何安装命令。

## 1. 准备输入

安装 Clash Verge、兼容的 Mihomo、Node 22+ 和 Xcode Command Line Tools。构建使用 `xcrun`、系统 Ruby 和系统工具；不代为下载或安装依赖。

后台包需要**可搬移的 Node**：只依赖 `/usr/lib`、`/System/Library`。某些 Homebrew Node 依赖自身动态库，复制后不能运行，构建器会拒绝。使用 Node 官方独立发行版或相应的 nvm 安装，并用 `--node` 显式指定路径。不要通过删除检查来接受缺库的包。

```sh
node scripts/toolkit.mjs init --out .private/config.json
# 填自己的订阅、节点和住宅；将 demo 改为 false。
node scripts/toolkit.mjs render --config .private/config.json --out .private/render-1
```

保存目前 Clash 的配置备份。将 `.private/render-1/main.private.yaml` 作为**新条目**导入 Clash，保留原条目供回退。选择 Rule 模式、开启 TUN，保证端口与配置一致。模板不代替 Verge 的系统服务安装与授权。

macOS 增强版此时的东京入口尚未安装，Claude 暂不能使用。日常与美国分流由主 Clash 执行。基础版到此仍需自行核实出口，没有后续独立网关能力。

## 2. 生成绑定到本机的安装包

以下变量由使用者填写，不包含代理密码：

```sh
NODE_BINARY="/path/to/standalone/node"
MIHOMO_BINARY="/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo"
node scripts/toolkit.mjs prepare --config .private/config.json --out .private/package-1 \
  --node "$NODE_BINARY" --mihomo "$MIHOMO_BINARY" --bind-live
node scripts/toolkit.mjs verify-package --package .private/package-1
node scripts/toolkit.mjs install-system --package .private/package-1
node scripts/toolkit.mjs install-user --package .private/package-1
```

`prepare` 只生成文件和编译，不安装。`--bind-live` 读取当前 Clash 的配置及规则；先用独立、全部出口为 REJECT 的内核解析候选，再比对完整有序规则。使用现有本地 GeoIP 数据，不下载，不启动第二个 TUN。当前条目与候选不符会拒绝绑定；不要复制别人的规则摘要。

演示、未编译、未绑定或被改动的包都不能进入正式安装。每次使用新的输出目录。

## 3. 安装系统和用户组件

审阅上一阶段计划后，在本机执行：

```sh
sudo "$NODE_BINARY" scripts/toolkit.mjs install-system --package .private/package-1 --apply
node scripts/toolkit.mjs install-user --package .private/package-1 --apply
node scripts/toolkit.mjs doctor
```

系统安装创建专用隐藏服务身份 `_cttokyo`（选择空闲 UID/GID）、`ClashTokyoTemplate` 系统目录、自己的 LaunchDaemon 和精确授权文件。网关以服务身份运行，不以 root 运行。授权只允许固定程序的 `status`、`arm`、`lock`，不开放任意命令。

用户安装创建自己的预检 LaunchAgent 和菜单栏 App。预检与状态灯会启动；Claude、Chrome、登录模式不会自动打开。不修改主 Clash 文件、系统代理或其他工具的配置。

第一次绿色状态须同时满足主 Clash 规则／TUN 与基线匹配、网关 READY、住宅核验记录有效。应用级真实连接仍需按 [验收清单](ACCEPTANCE.md) 检查。

## 4. 可选组件

- 浏览器：从 `~/Applications/Clash Tokyo 浏览器.app` 打开独立实例，在此实例的扩展页加载 `~/.config/clash-tokyo-template/browser/extension`。不在日常 Chrome 里加载。完成页面出口和扩展检查后再登录。
- 登录模式：默认关闭；开启 `features.login` 才构建。只在需要重新登录时使用，完成后点“结束并恢复浏览器”；过期后也需要结束。系统可能要求确认默认浏览器。原生认证窗口仍未验收。
- 工具：先确认关闭 Claude，再执行 `node scripts/toolkit.mjs install-tools --package .private/package-1 --apply`。会备份并合并自己的 settings；不复制登录态或密钥。只要已安装的工具源未变，后续日常启动不需要重复合并。

## 升级

保留旧包和私有输入；停止相关工作并关闭模板 App、东京 Chrome、Claude。修改配置后生成新条目；若规则变化，需要在 Clash 选中该新条目，再绑定新包。

```sh
node scripts/toolkit.mjs prepare --config .private/config.json --out .private/package-2 \
  --node "$NODE_BINARY" --mihomo "$MIHOMO_BINARY" --bind-live --upgrade
sudo "$NODE_BINARY" scripts/toolkit.mjs install-system --package .private/package-2 --upgrade --apply
node scripts/toolkit.mjs upgrade-user --package .private/package-2 --apply
```

只支持同一受管理身份、同一可选模块组合的升级。系统升级保留旧版备份，失败尝试恢复原版；用户升级保留 Chrome 资料和 Claude settings。新系统版本停在锁定状态，完成检查后请求重新核验：

```sh
sudo -n -k -u _cttokyo -- '/Library/Application Support/ClashTokyoTemplate/bin/tokyo-gateway-control' arm
```

这不会跳过出口核验。`UPGRADE_ROLLBACK_NEEDS_REVIEW_GATE_CLOSED` 等异常须检查回执和残留目录；不要连续覆盖安装。

## 卸载／回退

先结束登录模式、关闭模板应用，在 Clash 选择原有有效条目。退出 Claude 后：

```sh
node scripts/toolkit.mjs uninstall-user
node scripts/toolkit.mjs uninstall-system
# 审阅计划后
node scripts/toolkit.mjs uninstall-user --apply
sudo "$NODE_BINARY" scripts/toolkit.mjs uninstall-system --apply
```

只处理本模板的服务与文件。原配置／代码被其他程序修改时拒绝自动删除。私人浏览器数据、凭据及原包归档保留；服务身份保留但不运行，不自动删除账户。重新安装时不得强行复用未核实的残留身份。全新安装、升级与卸载的管理员实测仍须在目标 Mac 验收。
