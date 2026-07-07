# install-promtail.ps1
# 用 NSSM 把 Promtail 装成 Windows 服务，从 PM2 抓日志推到 Loki

[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$LokiUrl,
  [string]$NodeCode = $env:CRAWLER_NODE_CODE,
  [string]$PromtailVersion = "2.9.8",
  [string]$InstallDir = "C:\promtail",
  [string]$LogDir = "D:\crawler\logs",
  [string]$JobName = "pm2"
)

if (-not $NodeCode) {
  $NodeCode = "crawler-pm2-$env:COMPUTERNAME".ToLower()
  Write-Host "[promtail] CRAWLER_NODE_CODE 未设置，使用 hostname 派生：$NodeCode"
}

# 检查 NSSM
$nssm = Get-Command nssm -ErrorAction SilentlyContinue
if (-not $nssm) {
  Write-Host "[promtail] NSSM 未安装，尝试通过 choco 安装..."
  $choco = Get-Command choco -ErrorAction SilentlyContinue
  if (-not $choco) { throw "需要 NSSM 或 choco，先安装 NSSM: https://nssm.cc/download" }
  choco install -y nssm
  $nssm = Get-Command nssm
}

# 下载 Promtail
if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir | Out-Null }
$zip = "$InstallDir\promtail.zip"
$exe = "$InstallDir\promtail-windows-amd64.exe"
if (-not (Test-Path $exe)) {
  $url = "https://github.com/grafana/loki/releases/download/v$PromtailVersion/promtail-windows-amd64.zip"
  Write-Host "[promtail] 下载 $url"
  Invoke-WebRequest -Uri $url -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $InstallDir -Force
  Remove-Item $zip
}

# 写配置文件
$configPath = "$InstallDir\promtail.yml"
@"
server:
  http_listen_port: 9080

positions:
  filename: $InstallDir\positions.yaml

clients:
  - url: $LokiUrl
    batchwait: 1s
    batchsize: 1048576

scrape_configs:
  - job_name: $JobName
    static_configs:
      - targets: [localhost]
        labels:
          app: crawler
          job: $JobName
          nodeCode: $NodeCode
          __path__: $LogDir\crawler-*.log
    pipeline_stages:
      - match:
          selector: '{app="crawler"}'
          stages:
            - regex:
                expression: '"sku":"(?P<sku>[^"]+)"'
            - regex:
                expression: '"status":"(?P<status>[^"]+)"'
            - regex:
                expression: '"error":"(?P<error>[^"]+)"'
            - regex:
                expression: '"component":"(?P<component>[^"]+)"'
            - regex:
                expression: '"durationMs":(?P<durationMs>\d+)'
            - regex:
                expression: '"channelId":(?P<channelId>\d+)'
"@ | Out-File -Encoding UTF8 -FilePath $configPath

# 注册服务（如果已存在先停）
$svcName = "Promtail"
nssm stop $svcName 2>$null | Out-Null
nssm remove $svcName confirm 2>$null | Out-Null
nssm install $svcName $exe "-config.file=$configPath"
nssm set $svcName AppDirectory $InstallDir
nssm set $svcName Start SERVICE_AUTO_START
nssm set $svcName AppStdout $InstallDir\promtail.log
nssm set $svcName AppStderr $InstallDir\promtail-error.log
nssm set $svcName AppRotateFiles 1
nssm set $svcName AppRotateBytes 10485760

# 防火墙（仅 Tailscale IP 段入站）
New-NetFirewallRule -DisplayName "Promtail HTTP listen" -Direction Inbound -LocalPort 9080 -Protocol TCP -Action Allow -RemoteAddress 100.64.0.0/10 -ErrorAction SilentlyContinue | Out-Null

nssm start $svcName
Write-Host "[promtail] 服务已启动，nodeCode=$NodeCode LokiUrl=$LokiUrl"
Write-Host "[promtail] LogDir 监控：$LogDir\crawler-*.log"