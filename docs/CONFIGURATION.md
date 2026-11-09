# 配置与更新

以 `examples/config.example.json` 为结构。在 `.private/config.json` 中填写资料，权限保持 `0600`，父目录 `0700`。不要把真实值填回示例。

| 配置项 | 含义 |
|---|---|
| `demo` | 完成真实配置后改为 `false`；演示包无法安装 |
| `edition` | `basic` 或 `macos` |
| `main.port` | 主 Clash HTTP/SOCKS 端口，示例为 7897；需与 Verge 生效端口一致 |
| `providers` | 两个固定槽位 `bygcloud`、`nexitally`，可填其他机场；名称不授予账号访问权限 |
| `subscriptionUrl` | 自己的 HTTPS 订阅；空值则使用节点快照。完整链接是凭据 |
| `nodes` | 节点快照数组，仅节点字段，不复制机场的组、规则、TUN 或 DNS |
| `filters.us/hk/jp` | 节点名称正则；使用无开头锚点的地区匹配，以适配 provider 前缀 |
| `tokyo.transitNames` | 每个机场选一条日本节点的完整名称；不代表枚举了机场的全部日本节点 |
| `residential.us/tokyo` | SOCKS5 住宅的地址、端口、用户名、密码及固定预期 IPv4 |
| `tokyo.ports` | 五个互不重复的本机端口，默认 44127–44131，避免复用原有常见测试端口 |
| `directDomains` | 可选的精确域名直连；位于 Claude/Grok 保护规则之后 |
| `extraResidentialDomains` | 额外走美国住宅的域名后缀 |
| `features` | 浏览器、登录接管、工具、Codex 的安装开关 |
| `tools.sshBlocks` | 自己审核过的 SSH 别名及跳板。默认空；不自动读取任何 SSH／AWS 密钥 |

节点协议允许 ss、vmess、vless、trojan、anytls、socks5、http；最终是否支持取决于实际 Mihomo。拒绝携带其他代理链、物理接口覆盖及关闭 TLS 验证的节点。地区筛选依据名称，不是地理位置认证；东京最终出口还会经过双端点 IP／JP 核验。

主配置美国／香港池可按订阅每小时尝试更新，并保留起始快照。服务商若要求临时开放订阅下载，窗口外更新仍可能失败，工具不会绕过服务商限制。

**东京网关使用安装时选定的两条节点快照。** 主 Clash 的订阅刷新不会同时更新它的私有凭据。节点密码或地址变化时，修改私有输入，重新生成并按升级流程部署；不能只修改主 Clash 后宣称东京也更新了。

美国为第一个槽位优先、第二个备用；两家各自的节点池使用延迟检查。香港选延迟较低的池。东京初始尝试第一个槽位，当前链健康时保持；连续明显变慢且备用链完整核验成功并有足够改善才切换，有冷却期。两家日本中转最终仍共用同一住宅，不能解决住宅供应商本身的故障。

## 可选工具

`features.tools=true` 时，`sshBlocks` 采用以下结构（填写自己的内容）：

```json
[
  {"aliases":["jump"],"options":{"hostname":"jump.example.invalid","user":"operator","identityfile":"~/.ssh/id_ed25519"}},
  {"aliases":["server"],"options":{"hostname":"server.example.invalid","user":"operator","identityfile":"~/.ssh/id_ed25519","proxyjump":"jump"}}
]
```

第一跳经东京 HTTP CONNECT；后续由明确配置的跳板转发，最终服务器看到的可能是跳板 IP。主机公钥必须已经由使用者确认并在自己的 `known_hosts` 中，模板不自动接受新主机、不导入他人的云账号。AWS／SSH 凭据仍由自己的原生工具读取，仓库不复制它们。

`awsBinary`、`codexBinary` 填自己已安装的可执行文件绝对路径。工具 hook 合并原设置，冲突即停止，不覆盖已有代理。自动改写只覆盖已支持的 shell 命令位置；复杂间接调用明确使用生成的 `tools/bin/codex`。
