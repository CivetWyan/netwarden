# 小米路由器管理接口（网管用到的部分）

适用：小米路由器新版管理后台（LuCI + `xqsystem` / `xqnetwork` / `misystem` 命名空间）。在 **BE6500（RN02，ROM 1.0.64）** 上逐项实测。其他型号接口名大多相同，但行为和耗时可能不同，移植前请先只读验证。

实现见 `src/router.mjs`。下文的耗时是一台设备上的实测参考值，会因上级网络而不同。

## 1. 登录

1. `GET /cgi-bin/luci/web`，从登录页源码解析两个值：
   - `key: '<32位十六进制>'`：固件内置的公共 key；
   - `deviceId = '<MAC>'`：**路由器看到的请求方 MAC**，每台客户端不同，所以每次登录前都要实时解析，不能写死。
2. 计算：
   ```
   nonce    = "0_" + deviceId + "_" + 当前Unix秒 + "_" + 随机整数(0–9999)
   password = sha256( nonce + sha256(管理密码 + key) )      // 小写 hex；老固件(newEncryptMode=0)为 SHA1
   ```
3. `POST /cgi-bin/luci/api/xqsystem/login`，表单 `username=admin&password=...&logtype=2&nonce=...`，成功返回 `{"code":0,"token":"..."}`。

注意事项（实测）：

- nonce 的时间戳必须**严格递增**：同一秒内的第二次登录会失败，也不能重放已用过的 nonce。
- 密码错误返回 `{"code":401,"msg":"not auth"}`。连续失败多次会被锁定，所以客户端**登录失败一次就停止重试**，直到管理员修改密码配置。
- 同一客户端并发登录时，后拿到的 token 会让先拿到的失效。客户端对登录做了单飞（single-flight），并发请求共用一次登录。
- 重启路由器后旧 token 失效。

## 2. 调用约定

- 需登录接口：`/cgi-bin/luci/;stok=<token>/api/<命名空间>/<接口名>`。GET 用查询串，POST 用 `application/x-www-form-urlencoded`。
- token 失效：`{"code":401,"msg":"Invalid token"}`，重新登录后重试一次。
- 接口不存在：**HTTP 404 纯文本**（`No page is registered at ...`）。已注册的接口一被请求就会执行，**不要用试错方式探测写接口**。
- **返回 `code:0` 不代表配置已生效**，写入后必须用对应的读接口读回确认。
- 很多写操作用的是 GET（如 `xqsystem/reboot`、`xqnetwork/mac_clone`），不能以为 GET 都安全。
- 读接口会返回明文密码（PPPoE 账号、WiFi 密码），写日志前要脱敏（见 `src/store.mjs` 的 `redact`）。

## 3. 网管允许调用的接口（白名单）

客户端只能请求下表的接口，其他接口在代码里直接拒绝（`READ_APIS` / `WRITE_APIS`）。

### 只读

| 接口 | 用途 | 关键字段 |
|---|---|---|
| `xqnetwork/wan_info` | WAN 当前配置与状态 | `info.details`（已保存的配置，可直接用于恢复）、`info.mac`、`info.link`、`info.status`、`info.ipv4` |
| `xqnetwork/wan_link` | WAN 物理链路 | `link`：1=已连接，0=断开 |
| `xqnetwork/pppoe_status` | WAN 连接状态（静态/DHCP 也用它） | `status`：0 未连接、1 拨号/获取中、2 已连接、3 失败、4 已停止；`ip`、`gw`、`dns`、`wanSpeed` |
| `xqnetwork/wan_speed` | WAN 口速率**设置值** | `speed`：0=自动协商；不是实际协商速率 |
| `xqnetwork/lan_dhcp` | LAN DHCP 设置 | `ignore`、`start`、`limit` |
| `xqnetwork/macbind_info` | DHCP 静态绑定与设备 | `list`、`devicelist` |
| `misystem/status` | 整机状态与 WAN 流量 | `wan.upload` / `wan.download`（本次开机累计字节）、`wan.upspeed` / `wan.downspeed`（B/s） |
| `misystem/devicelist` | 终端列表 | |
| `xqnetwork/wifi_status` | 各频段运行状态 | |

### 写入

| 接口 | 用途 | 说明 |
|---|---|---|
| `xqnetwork/set_wan`（POST） | 设置上网方式 | 静态：`wanType=static&staticIp&staticMask&staticGateway&dns1[&dns2]`；DHCP：`wanType=dhcp&autoset=1`（或 `autoset=0&dns1...`）；PPPoE：`wanType=pppoe&pppoeName&pppoePwd&autoset&special[...]`。参数非法时返回 1530/1531 且配置不变。静态写入约 5 秒生效、不断 WiFi |
| `xqnetwork/set_wan_speed`（POST） | WAN 口协商速率 | **只用于把速率写回基线值（通常 0=自动）**。强制成上级不支持的速率会让链路长时间断开；写回 0 后约 30 秒重新协商恢复 |
| `xqnetwork/mac_clone`（GET `mac=`） | 修改 WAN 口 MAC | 与当前 MAC 相同时返回 1537。静态 WAN 下约 5 秒生效 |
| `xqsystem/reboot`（GET） | 重启 | 全网中断，约 80–120 秒恢复，旧 token 失效。只作为最后手段 |

### 刻意不提供

恢复出厂（`xqsystem/reset`）、刷机（`flash_rom` / `upgrade_rom`）、改 LAN 网段（`set_lan_ip`）、改管理密码（`set_name_password`）、Wi-Fi 5 兼容模式与 MLO（`set_wifi_ax` / `set_hostap_mlo`，实测会让**所有无线终端掉线**且部分长时间不回连）、改国家码、工作模式切换。这些操作不可逆或会造成大范围断网，不适合无人值守的修复工具。

## 4. 与修复相关的实测行为

- **WAN 配置基线**：`wan_info.info.details` 是已保存的配置，按 `wanType` 映射回 `set_wan` 参数即可恢复（`src/router.mjs` 的 `setWanParams`）。WAN 速率设置单独由 `wan_speed` / `set_wan_speed` 管理。
- **DNS 可能被拦截代答**：在测试网络里，发往任意地址 53 端口的查询（连不存在的 `192.0.2.53`）都会得到应答。代答来自路由器还是上级网络（园区、运营商）没有区分。这种环境下"指定某台 DNS 服务器查询"的结果不能证明那台服务器可用，所以分诊先向一个不可能存在的地址查询，判断是否被拦截；若被拦截，就丢弃依赖该前提的信号（`src/triage.mjs`）。
- **WAN 的 DNS 被改坏不一定断网**：测试中把 WAN DNS 改成无应答地址后，终端仍能解析新域名，最可能是上面的代答在起作用。所以 DNS 配置漂移不一定表现为断网，网管只在探针确认故障时才修复。
- **链路状态判断**：`pppoe_status.status` 在静态 IP 下链路断开时仍可能为 2，判断网线/链路要看 `wan_link`。
