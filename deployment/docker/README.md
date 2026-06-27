# hs-sku-crawler Docker 部署说明

本文档说明如何在 Windows 服务器（Docker Linux 容器模式）上使用 Docker 部署 hs-sku-crawler。

## 环境要求

- Windows Server 2019 或更高版本，启用 Docker Linux 容器
- Docker Engine 与 Docker Compose 已安装
- PowerShell 5.1 或更高版本，以管理员身份运行
- 镜像仓库访问凭据已配置（docker login）

## 首次部署

1. 在目标机上创建目录 `C:\hs-sku-crawler`。
2. 将 `.env` 配置文件放置到 `C:\hs-sku-crawler\.env`。
3. 以管理员身份运行 PowerShell，执行：

```powershell
.\deployment\docker\deploy.ps1 -ImageTag "abc1234" -Registry "registry.example.com" -ImageName "hs-sku-crawler"
```

## 更新

```powershell
.\deployment\docker\update.ps1 -ImageTag "def5678"
```

## 回滚

```powershell
# 回滚到上一版本
.\deployment\docker\rollback.ps1

# 回滚到指定镜像 tag
.\deployment\docker\rollback.ps1 -TargetImage "registry.example.com/hs-sku-crawler:abc1234"
```

## 构建并推送镜像

在本地或 CI 中执行：

```powershell
.\deployment\docker\build-push.ps1 -Registry "registry.example.com" -ImageName "hs-sku-crawler"
```

## 日志位置

- 应用日志：`C:\hs-sku-crawler\logs`
- 容器标准输出：`docker logs hs-sku-crawler`

## 注意事项

1. 所有 PowerShell 脚本均需以管理员身份运行。
2. `.env` 文件需预先放置，部署脚本不生成、不覆盖。
3. 更新时必须显式指定 `-ImageTag`（Git commit 短 SHA）。
