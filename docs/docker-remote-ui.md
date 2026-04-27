# Linux 服务器 Docker 远程桌面部署

这个项目是 Electron 桌面应用，不是普通 Web 服务，所以完整界面部署需要通过 `Xvfb + Fluxbox + x11vnc + noVNC` 运行。

## 1. 启动

在项目根目录执行：

```bash
docker compose up -d --build
```

默认会暴露两个端口：

- `6080`：浏览器访问 noVNC
- `5900`：原生 VNC 客户端直连
- `5580`：应用反代服务默认端口

## 2. 访问界面

浏览器打开：

```text
http://你的服务器IP:6080/vnc.html?resize=scale&autoconnect=1
```

VNC 密码默认来自 `docker-compose.yml` 里的 `VNC_PASSWORD`。

如果页面看起来超出浏览器可视区域，优先使用上面的 `resize=scale` 访问参数，它会让 noVNC 自动缩放桌面内容。

如果你要给外部客户端使用反代：

1. 在应用的反代页面把监听地址改成 `0.0.0.0`
2. 保持端口为 `5580`，或者改成你自己的端口并同步修改映射
3. 外部客户端连接 `http://你的服务器IP:5580`

## 3. 持久化数据

容器把 `/root` 挂成了命名卷 `kiro-home`，以下数据会保留：

- 应用配置
- 账号缓存
- Chromium 用户数据
- Kiro 相关本地配置

## 4. 常用操作

查看日志：

```bash
docker compose logs -f
```

重启：

```bash
docker compose restart
```

停止：

```bash
docker compose down
```

更新镜像后重建：

```bash
docker compose up -d --build
```

## 5. 说明

- 容器模式下默认禁用了托盘、自动更新和全局快捷键，这些功能在服务器图形环境里通常不稳定。
- 应用内点击外部链接时，会在容器里的 Chromium 中打开。
- 如果社交登录的 `kiro://` 回调在你的服务器环境里表现不稳定，优先使用应用中已有的手动登录、导入凭证或 Builder ID / IAM SSO 方式。
