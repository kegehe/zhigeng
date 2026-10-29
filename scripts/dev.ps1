#requires -Version 5.1
<#
  一键启动 / 停止知更开发环境。

  启动：先清掉占着 dev 端口的进程（vite 是 strictPort，被占用会直接失败），再 pnpm tauri dev
        端口默认读 vite.config.ts 里的 PORT，可用 -Port 覆盖
  停止：Ctrl+C 后自动结束残留进程并释放端口

  用法：
    scripts\dev.ps1                # 全量启动（Vite + Tauri 壳）
    scripts\dev.ps1 -FrontendOnly  # 只起前端（无 Tauri 运行时）
    scripts\dev.ps1 -Stop          # 只做清理
#>
[CmdletBinding()]
param(
  [int]$Port = 1425,
  [switch]$FrontendOnly,
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

function Get-PortOwners {
  param([int]$Port)
  @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique |
      Where-Object { $_ -and $_ -ne 0 })
}

# 递归结束进程树：比 taskkill 安静，也不会因为进程刚好已退出而抛 NativeCommandError
function Stop-ProcessTree {
  param([int]$ProcessId)
  if (-not $ProcessId) { return }
  $childIds = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty ProcessId)
  foreach ($childId in $childIds) { Stop-ProcessTree -ProcessId $childId }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

# 端口上残留的监听进程（上次没退干净的 vite/node）先清掉，再等端口真正释放
function Clear-Port {
  param([int]$Port, [switch]$BestEffort)
  foreach ($ownedPid in (Get-PortOwners -Port $Port)) {
    $proc = Get-Process -Id $ownedPid -ErrorAction SilentlyContinue
    # 取完连接快照到查名字之间它会退出（-Stop 正在收尾时最常见）。这时端口上那个
    # "持有者"已经不存在：既不有东西要杀，也不该报成"被 ? 占用"吓用户——下面那圈
    # 等待会自己确认端口空了
    if (-not $proc) { continue }
    $name = $proc.ProcessName
    # **只认本项目的 dev 进程**：只按端口一刀切，会杀掉别人的 dev server / Docker 端口映射 /
    # ssh 隧道。vite 配 strictPort 的本意就是"被占用时报错，而不是替用户决定杀谁"
    if (@('node', 'pnpm', 'cargo', 'zhigeng') -notcontains $name) {
      $msg = "端口 $Port 被 $name (PID $ownedPid) 占用，看名字不像本项目的 dev 进程"
      if ($BestEffort) { Write-Warning "$msg；没动它，请自己确认"; continue }
      throw "$msg。请先确认那个进程是什么，再决定要不要停它"
    }
    Write-Host "  端口 $Port 被 $name (PID $ownedPid) 占用，结束它"
    Stop-ProcessTree -ProcessId $ownedPid
  }
  for ($i = 0; $i -lt 40; $i++) {
    if ((Get-PortOwners -Port $Port).Count -eq 0) { return }
    Start-Sleep -Milliseconds 250
  }
  if ($BestEffort) {
    Write-Warning "端口 $Port 仍被占用（可能属于其他用户或需要管理员权限），请手动处理"
    return
  }
  throw "端口 $Port 仍被占用，请手动检查"
}

# 只认 target\debug 下的壳进程：target\release 里那份可能是用户正在跑的发布件，不能碰
function Clear-DevShell {
  # 用 foreach 而不是 ForEach-Object：取 .Path 可能抛 Access denied，return 会连剩下的一起跳过
  # **只认壳**：zhigeng 是现在的名字，note-app 是改名前的壳；note.exe 是 CLI，不许碰
  $壳名 = @('zhigeng', 'note-app')
  foreach ($shell in @(foreach ($n in $壳名) { Get-Process -Name $n -ErrorAction SilentlyContinue })) {
    $path = $null
    try { $path = $shell.Path } catch { $path = $null }
    if ($path -and $path.StartsWith("$Root\target\debug\", [System.StringComparison]::OrdinalIgnoreCase)) {
      Write-Host "  结束残留的开发壳进程 (PID $($shell.Id))"
      Stop-ProcessTree -ProcessId $shell.Id
    }
  }
}

# 启动时把 dev 命令行进程的 PID 记下来：stop.bat 是另一个进程，拿不到句柄，
# 而只杀端口的话（比如首次编译期间）pnpm -> cargo 这条链会留着继续编译
$PidFile = Join-Path $Root '.scratch\dev-cli.pid'

function Save-DevCliPid {
  param([System.Diagnostics.Process]$Process)
  $dir = Split-Path -Parent $PidFile
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  try { $startTicks = $Process.StartTime.Ticks } catch { return }  # 进程已经退出时 StartTime 会抛
  Set-Content -Path $PidFile -Value ("{0}|{1}" -f $Process.Id, $startTicks) -Encoding ASCII
}

# 按 PID 杀树前先核对启动时间：PID 会被回收，只认 PID 可能误杀别人的进程
# -OnlyPid 用于「自己的收尾」：文件已被新实例接管时（双开 start.bat）不能去杀新实例
function Clear-DevCli {
  param([int]$OnlyPid = 0)
  if (-not (Test-Path $PidFile)) { return $true }
  $raw = Get-Content $PidFile -ErrorAction SilentlyContinue
  if (-not $raw) { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue; return $true }
  $parts = ([string]$raw).Split('|')
  $cliPid = 0
  [int64]$ticks = 0
  if ($parts.Count -lt 2 -or -not [int]::TryParse($parts[0], [ref]$cliPid) -or
      -not [int64]::TryParse($parts[1], [ref]$ticks)) {
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    return $true
  }
  if ($OnlyPid -and $cliPid -ne $OnlyPid) { return $false }  # 属于更新的实例，交给它自己收尾
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  $proc = Get-Process -Id $cliPid -ErrorAction SilentlyContinue
  if (-not $proc) { return $true }
  try { if ($proc.StartTime.Ticks -ne $ticks) { return $true } } catch { return $true }
  Write-Host "  结束 dev 命令行进程树 (PID $cliPid)"
  Stop-ProcessTree -ProcessId $cliPid
  return $true
}

# 退出前的统一收尾：命令行进程树 -> 壳进程 -> 端口
function Invoke-Cleanup {
  param([int]$Port, [switch]$BestEffort, [int]$OwnerPid = 0)
  # **所有权只判一次**：pid 文件已经被更新的实例接管时，连壳与端口都不许碰——否则先退出的
  # 那一份会把新实例的 vite 与壳一起杀掉（双开时表现为"新窗口白屏，而它自己毫无察觉"）
  $mine = Clear-DevCli -OnlyPid $OwnerPid
  if ($OwnerPid -and -not $mine) {
    Write-Host "==> 这个 dev 会话已被新实例接管：不动它的壳与端口" -ForegroundColor Yellow
    return
  }
  Clear-DevShell
  Clear-Port -Port $Port -BestEffort:$BestEffort
  if ((Get-PortOwners -Port $Port).Count -eq 0) {
    Write-Host "==> 开发环境已结束，端口 $Port 已释放" -ForegroundColor Green
  } else {
    Write-Host "==> 开发环境已结束，但端口 $Port 仍被占用（需手动处理）" -ForegroundColor Yellow
  }
}

# 端口以 vite.config.ts 的 PORT 为准（strictPort + tauri.conf 的 devUrl 都指向它），
# 免得改了 vite 端口这里还在杀旧端口；显式传 -Port 时以参数为准
if (-not $PSBoundParameters.ContainsKey('Port')) {
  $viteConfig = Join-Path $Root 'vite.config.ts'
  if (Test-Path $viteConfig) {
    $detected = (Select-String -Path $viteConfig -Pattern 'const\s+PORT\s*=\s*(\d+)' -ErrorAction SilentlyContinue |
        Select-Object -First 1)
    if ($detected) {
      $Port = [int]$detected.Matches[0].Groups[1].Value
    } else {
      Write-Warning "没能从 vite.config.ts 解析出 PORT，按 $Port 处理；真端口不同的话这一趟会清错端口"
    }
  }
}

# 端口还写在 tauri.conf.json 的 devUrl 里：两处不一致时壳会连不上前端（白屏），早报错好过白屏
$tauriConf = Join-Path $Root 'src-tauri\tauri.conf.json'
if (Test-Path $tauriConf) {
  # 注意 json 里键名本身带引号：`"devUrl"`——漏掉那对引号，这条检查会静默不命中（写完先跑一次）
  $devUrl = Select-String -Path $tauriConf -Pattern '"devUrl"\s*:\s*"[^"]*:(\d+)' | Select-Object -First 1
  if ($devUrl) {
    $confPort = [int]$devUrl.Matches[0].Groups[1].Value
    if ($confPort -ne $Port) {
      throw "vite 端口 $Port 与 tauri.conf.json 的 devUrl 端口 $confPort 不一致——壳会连不上前端"
    }
  }
}

Write-Host "==> 项目根目录 $Root" -ForegroundColor Cyan
Write-Host "==> 清理端口 $Port" -ForegroundColor Cyan

# -Stop 只做清理，不需要 pnpm
if ($Stop) {
  Invoke-Cleanup -Port $Port -BestEffort
  # 退出码要能当判据用：端口没释放就说没成功，别让调用方（编辑器任务 / 脚本）以为停干净了
  if ((Get-PortOwners -Port $Port).Count -ne 0) { exit 1 }
  return
}

# 本机没有 pnpm.cmd 时 ProcessStartInfo 跑不了 pnpm.ps1，早报错比晚报错省事
$pnpm = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue).Source
if (-not $pnpm) { throw ' 找不到 pnpm.cmd，请先安装 pnpm（npm i -g pnpm）' }

Clear-DevCli
Clear-DevShell
Clear-Port -Port $Port

Set-Location $Root
if (-not (Test-Path 'node_modules')) {
  Write-Host "==> 首次运行，先装依赖" -ForegroundColor Cyan
  & pnpm install
  if ($LASTEXITCODE -ne 0) { throw "pnpm install 失败（退出码 $LASTEXITCODE）" }
}

$pnpmArgs = if ($FrontendOnly) { @('run', 'dev') } else { @('run', 'tauri', 'dev') }
Write-Host "==> pnpm $($pnpmArgs -join ' ')（Ctrl+C 结束）" -ForegroundColor Cyan

# 用 ProcessStartInfo 而不是 Start-Process -PassThru：后者在这台机器的 PS 5.1 上 ExitCode 恒为 $null
$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = if ($env:ComSpec) { $env:ComSpec } else { 'cmd.exe' }
$startInfo.Arguments = '/c ""' + $pnpm + '" ' + ($pnpmArgs -join ' ') + '"'
$startInfo.UseShellExecute = $false
$startInfo.WorkingDirectory = $Root

$exitCode = 0
$child = [System.Diagnostics.Process]::Start($startInfo)
Save-DevCliPid -Process $child
try {
  $child.WaitForExit()
  $exitCode = $child.ExitCode
} finally {
  # 进程树交给 Clear-DevCli 按 PID + 启动时间处理，不在这里重复杀
  Invoke-Cleanup -Port $Port -BestEffort -OwnerPid $child.Id
}

# 被 Ctrl+C / 外部结束的进程会给出 0xC000013A 之类的负数，当作正常退出，别让 start.bat 误报失败
if ($null -eq $exitCode -or $exitCode -lt 0) { $exitCode = 0 }
exit $exitCode
