# 部署（Linux 后台服务）

下面以 Ubuntu + 用户级 systemd 为例，假设项目放在 `~/netwarden`。

## 1. 准备

- Node.js 22 或更高（实测 24）。后台服务只用 Node 内置模块，不需要 `npm install`。
- 一个 OpenAI 兼容的本地模型接口。推荐 Ollama 加载 **Qwen3.5-9B（GGUF，Q4_K_M）**，约占 6 GB 显存。也可以用 LM Studio、vLLM 等。
- 可选：一个在线模型接口（DeepSeek 或其他 OpenAI 兼容服务），用于故障恢复后的复盘。

用 Ollama 注册模型的示例（GGUF 文件自行下载并校验）：

```sh
cat > Modelfile <<'EOF'
FROM ./Qwen3.5-9B-Q4_K_M.gguf
EOF
OLLAMA_HOST=127.0.0.1:18080 ollama create netwarden-qwen -f Modelfile
```

## 2. 配置

运行数据目录由 `NETWORK_REPAIR_HOME` 指定（下面用 `~/netwarden/runtime-service`）。

```sh
mkdir -p ~/netwarden/runtime-service && chmod 700 ~/netwarden/runtime-service
cp deploy/config.example.json ~/netwarden/runtime-service/config.json
cp deploy/model.env.example deploy/model.env && chmod 600 deploy/model.env
```

- 编辑 `config.json`：`model.baseUrl` / `model.name` 指向你的本地模型；启用路由器管理时把 `router.enabled` 设为 `true`，并在 `router.host` 填路由器管理地址（形如 `http://路由器IP`）。
- 在 `deploy/model.env` 里填路由器管理密码 `NETWORK_ROUTER_PASSWORD`，以及在线模型的 `NETWORK_ONLINE_API_KEY`（可选）。密钥只放在这个文件或运行目录的密钥文件里（权限 600），不要写进 `config.json`。
- 自动修复默认关闭（只诊断）。确认无误后把 `repair.enabled` 设为 `true`。

先单次探测检查配置是否可用：

```sh
NETWORK_REPAIR_HOME=~/netwarden/runtime-service node src/daemon.mjs --once
```

## 3. 安装服务

```sh
mkdir -p ~/.config/systemd/user
cp deploy/systemd/netwarden-agent.service ~/.config/systemd/user/
# 可选：由本项目托管一个专用 Ollama 实例并常驻显存
cp deploy/systemd/netwarden-model.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now netwarden-model netwarden-agent
loginctl enable-linger "$USER"      # 退出登录后继续运行
```

查看状态与日志：

```sh
systemctl --user status netwarden-agent
journalctl --user -u netwarden-agent -f
```

注意：`netwarden-model.service` **不要**加 `After=default.target`。它本身由 `default.target` 拉起，再加这一行会形成启动顺序环，systemd 会在开机时直接丢弃网管服务。

## 4. 网页

服务启动后，局域网内用浏览器打开 `http://<服务器IP>:8088`。访问密码在首次启动时随机生成，保存在运行目录的 `web-access.json`（权限 600），用下面的命令查看：

```sh
cat ~/netwarden/runtime-service/web-access.json
```

网页监听 `0.0.0.0` 以跟随 DHCP 地址变化，但只接受本机回环和默认出口网段的访问，并校验 Host / Origin，防止跨站请求。

## 5. 本机网络动作的权限

路由器动作走 HTTP API，不需要本机权限。本机动作（DHCP 续租、重连 WiFi、清 DNS 缓存）需要系统授权：

- Linux：服务以普通用户运行时，NetworkManager 的 `network-control` 通常需要 polkit 授权。可为该用户添加 polkit 规则，或接受这些动作在日志里记为"权限不足"。
- 网管不会尝试绕过权限，也不需要以 root 运行。

## 6. 旧版系统级服务

`deploy/network-repair-master.service` 是以 root 运行的系统级服务模板（可用 `npm run service:generate` 按当前路径生成）。新部署建议用上面的用户级服务。
