# 安装并配置 pm2-logrotate：轮转 PM2 托管日志（crawler-combined-*.log / crawler-out-*.log / crawler-error-*.log）
# 解决 Windows 节点长期运行后 PM2 日志涨到几百 MB ~ 几 GB、无法打开的问题。
#
# 用法（PowerShell，建议在部署爬虫之后再执行）：
#   .\setup-pm2-logrotate.ps1                    # 默认：单文件 50MB 轮转，保留 7 份
#   .\setup-pm2-logrotate.ps1 -MaxSize 100M -Retain 14
#
# 注意：pm2 set 修改配置后必须重启 PM2 进程才会生效（本脚本末尾自动 pm2 restart all）。
# 已验证 pm2-logrotate 在 Windows 可用；若个别机器不生效，用 `pm2 list` 确认
# pm2-logrotate 进程 online，并用 `pm2 conf pm2-logrotate` 核对配置。

param(
    [string]$MaxSize = '50M',     # 单文件超过该大小即轮转
    [int]$Retain = 7,             # 保留的轮转文件份数（按天轮转时约等于保留天数）
    [string]$RotateInterval = '0 0 * * *',  # 每天 0 点强制轮转一次（cron 格式）
    [switch]$Compress             # 轮转后 gzip 压缩（默认关，省 CPU）
)

$ErrorActionPreference = 'Stop'

# 刷新 PATH，确保能找到 pm2（即使刚装完 Node/PM2）
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

Write-Host "==> Installing pm2-logrotate ..."
pm2 install pm2-logrotate
if ($LASTEXITCODE -ne 0) {
    Write-Error "pm2 install pm2-logrotate failed (exit $LASTEXITCODE)"
    exit 1
}

Write-Host "==> Configuring pm2-logrotate: max_size=$MaxSize retain=$Retain rotateInterval='$RotateInterval' compress=$($Compress.IsPresent)"
pm2 set pm2-logrotate:max_size $MaxSize
pm2 set pm2-logrotate:retain $Retain
pm2 set pm2-logrotate:rotateInterval $RotateInterval
pm2 set pm2-logrotate:compress $(if ($Compress.IsPresent) { 'true' } else { 'false' })
pm2 set pm2-logrotate:workerInterval 30

Write-Host "==> Restarting PM2 processes to apply config ..."
pm2 restart all

Write-Host ""
Write-Host "==> Done. Current pm2-logrotate config:"
pm2 conf pm2-logrotate
Write-Host ""
Write-Host "验证方法：pm2 list 中 pm2-logrotate 应为 online；日志超过 $MaxSize 或跨天后应出现 crawler-combined-*.log.YYYYMMDDhhmmss 形式的轮转文件。"
