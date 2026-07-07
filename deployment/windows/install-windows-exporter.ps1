# install-windows-exporter.ps1
# 安装 Prometheus windows_exporter 并开 9182 给 Tailscale IP 段

[CmdletBinding()]
param(
  [string]$Version = "0.27.0",
  [string]$InstallDir = "C:\windows_exporter"
)

$msi = "$env:TEMP\windows_exporter.msi"
$url = "https://github.com/prometheus-community/windows_exporter/releases/download/v$Version/windows_exporter-$Version-amd64.msi"

if (Get-Service windows_exporter -ErrorAction SilentlyContinue) {
  Write-Host "[windows_exporter] 已安装，跳过"
  return
}

Write-Host "[windows_exporter] 下载 $url"
Invoke-WebRequest -Uri $url -OutFile $msi

Write-Host "[windows_exporter] 安装（监听 9182，启用 defaults 收集器集）"
msiexec /i $msi /quiet ENABLED_COLLECTORS="cpu,cs,logical_disk,memory,net,os,process,system,textfile" LISTEN_PORT="9182"

Remove-Item $msi

# 防火墙：仅 Tailscale IP 段
New-NetFirewallRule -DisplayName "windows_exporter" -Direction Inbound -LocalPort 9182 -Protocol TCP -Action Allow -RemoteAddress 100.64.0.0/10 -ErrorAction SilentlyContinue | Out-Null

$timeout = 30
$elapsed = 0
$svc = $null
while ($elapsed -lt $timeout) {
  $svc = Get-Service windows_exporter -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -eq 'Running') { break }
  Start-Sleep -Seconds 2
  $elapsed += 2
}

if (-not $svc -or $svc.Status -ne 'Running') {
  throw "windows_exporter 服务未在 30s 内达到 Running 状态（当前状态：$($svc.Status)）"
}
Write-Host "[windows_exporter] 已启动: $($svc.Status)"
