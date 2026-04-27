# Web 反代版

这个版本会把原来的桌面端界面构建成浏览器可访问的 Web 面板，并保留仪表板、账户管理、批量导入、反代配置、模型信息、日志和设置等主要功能。

主要能力：

- 浏览器远程访问完整 Web 面板
- 支持 CSV / TXT / JSON 导入账号
- 支持 OpenAI / Claude 兼容反代
- Web 数据默认持久化到 SQLite
- 同时保留 JSON 镜像与备份，降低大批量账号丢失风险

默认端口：

- Web 管理面板：`3080`
- 反代服务：`5580`

## 本地启动

```bash
npm install --ignore-scripts
npm run build:web-app
node out/web-proxy/web-proxy/server.js
```

常用环境变量：

- `KIRO_WEB_HOST`：Web 面板监听地址，默认 `0.0.0.0`
- `KIRO_WEB_PORT`：Web 面板端口，默认 `3080`
- `KIRO_PROXY_HOST`：反代监听地址，默认 `0.0.0.0`
- `KIRO_PROXY_PORT`：反代端口，默认 `5580`
- `KIRO_WEB_ADMIN_TOKEN`：Web 管理面板口令
- `KIRO_PROXY_API_KEY`：反代接口默认 API Key，可为空
- `KIRO_USER_DATA_PATH`：数据目录，默认 `~/.kiro-account-manager-web`

## Docker 部署

项目根目录已经提供 Web 版专用文件：

- [Dockerfile.web-proxy](/C:/Users/Administrator/Downloads/Kiro-account-manager-1.5.0/Kiro-account-manager-1.5.0/Kiro-account-manager/Dockerfile.web-proxy)
- [docker-compose.web-proxy.yml](/C:/Users/Administrator/Downloads/Kiro-account-manager-1.5.0/Kiro-account-manager-1.5.0/Kiro-account-manager/docker-compose.web-proxy.yml)

Linux 服务器执行：

```bash
docker compose -f docker-compose.web-proxy.yml up -d --build
```

启动后访问：

- 管理面板：`http://服务器IP:3080`
- 反代接口：`http://服务器IP:5580`

## 数据持久化

Compose 默认把容器内 `/data` 挂到宿主机 `./data/web-proxy`。

这个目录会保存：

- `kiro-state.sqlite`：主数据库
- `renderer-state.json`：界面状态镜像
- `web-proxy-state.json`：反代状态镜像
- `renderer-state-backups/`：自动备份目录

建议你把整个 `data/web-proxy` 目录纳入服务器备份。

## 首次部署建议

1. 把 `docker-compose.web-proxy.yml` 里的 `KIRO_WEB_ADMIN_TOKEN` 改成你自己的口令。
2. 如果希望局域网和外网都能访问，保持 `KIRO_WEB_HOST=0.0.0.0` 和 `KIRO_PROXY_HOST=0.0.0.0`。
3. 放通服务器防火墙和安全组端口：`3080`、`5580`。
4. 先打开 Web 面板导入账号，再到反代页面启动反代服务。
5. 如果你希望客户端调用时必须带 Key，再设置 `KIRO_PROXY_API_KEY`。

## 验证是否启动成功

先验证 Web 面板：

```bash
curl http://127.0.0.1:3080/api/meta
```

如果设置了 `KIRO_WEB_ADMIN_TOKEN`，再验证后端管理接口：

```bash
curl -X POST http://127.0.0.1:3080/api/renderer/call \
  -H 'Content-Type: application/json' \
  -H 'X-Admin-Token: 你的管理口令' \
  -d '{"method":"proxyGetStatus","params":{}}'
```

反代服务启动后再验证：

```bash
curl http://127.0.0.1:5580/health
curl http://127.0.0.1:5580/v1/models
```

如果你配置了 `KIRO_PROXY_API_KEY`，调用 `v1/models`、`v1/chat/completions` 等接口时记得带上 `Authorization: Bearer 你的Key`。

## 常用命令

查看日志：

```bash
docker compose -f docker-compose.web-proxy.yml logs -f
```

重启：

```bash
docker compose -f docker-compose.web-proxy.yml restart
```

停止：

```bash
docker compose -f docker-compose.web-proxy.yml down
```

更新后重建：

```bash
docker compose -f docker-compose.web-proxy.yml up -d --build
```

## CSV 示例

支持中文或英文表头，例如：

```csv
邮箱,昵称,登录方式,RefreshToken,ClientId,ClientSecret,Region
user1@example.com,user1,BuilderId,rt_xxx,cid_xxx,secret_xxx,us-east-1
user2@example.com,user2,Google,rt_yyy,,,us-east-1
```

```csv
email,nickname,provider,RefreshToken,ClientId,ClientSecret,Region
user1@example.com,user1,BuilderId,rt_xxx,cid_xxx,secret_xxx,us-east-1
```

说明：

- `BuilderId` / `Enterprise` 会按 IdC 刷新
- `Google` / `Github` 会按 social 刷新
- 导入后可以先在账户页校验，再到反代页启用反代
