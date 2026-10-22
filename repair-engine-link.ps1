<#
.SYNOPSIS
    重建 Strata 默认组件目录里的 engine 目录联结，并维护 control 版本容器的联结。

.DESCRIPTION
    新版 Strata 控制端把引擎装在 %LOCALAPPDATA%\Strata\components\engine\<版本>-<平台>-<后端>\，
    把自己装成 %LOCALAPPDATA%\Strata\components\control\<版本>\，两个位置都用 active.json 指明当前版本。

    本脚本做两件事，都可以重复运行（幂等）：
      1. engine：把 components\engine 链接到本脚本所在目录的 engine 子目录，
         让运行配置里的 "component:strata-engine" 不需要任何环境变量就能解析到引擎。
      2. control：把 components\control 链接到本脚本所在目录的 control 子目录。
         control 目录是版本容器：里面是 0.1.47\ 这样的版本目录和 active.json。
         新版控制端因此会把新版本装进本目录（不是装进 %LOCALAPPDATA%），
         升级时由它自己新增版本目录并切换 active.json。

    另外把本目录登记为控制器的安装根：在 %APPDATA%\Strata\settings.json 里
    写 data_dir = "<Strata 目录的上一级>\Strata-data"，并把本目录并入 installs，
    这样 strata models / launch / setup 不做额外参数也能找到配置与模型目录。

.PARAMETER Target
    引擎包根目录（其下是 <版本>-<平台>-<后端> 子目录），默认 <脚本目录>\engine。

.PARAMETER LinkPath
    引擎要创建的联结路径，默认 %LOCALAPPDATA%\Strata\components\engine。

.PARAMETER Force
    联结已存在但指向别处时，删掉旧联结并按目标重建（只删链接，不删目标内容）。

.EXAMPLE
    .\repair-engine-link.ps1

.EXAMPLE
    .\repair-engine-link.ps1 -Target 'D:\Strata\engine' -Force
#>
[CmdletBinding()]
param(
    [string]$Target,
    [string]$LinkPath,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
# 默认值放在这里算：Windows PowerShell 5.1 在 param 默认值里拿不到 $PSScriptRoot
if (-not $Target)   { $Target   = Join-Path $PSScriptRoot 'engine' }
if (-not $LinkPath) { $LinkPath = Join-Path $env:LOCALAPPDATA 'Strata\components\engine' }

function Fail([string]$Message) {
    Write-Host "[失败] $Message" -ForegroundColor Red
    exit 1
}

function Done([string]$Message) {
    Write-Host "[成功] $Message" -ForegroundColor Green
}

function TargetOf($item) {
    $t = @($item.Target) | Where-Object { $_ } | Select-Object -First 1
    if ($t) { return [IO.Path]::GetFullPath($t) }
    return $null
}

# 联结维护：目标已正确就跳过；指向别处需 -Force；真实目录一律拒绝（不删用户数据）。
function Set-Junction([string]$Path, [string]$Destination, [switch]$Replace) {
    $existing = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($existing) {
        $isLink = [bool]($existing.Attributes -band [IO.FileAttributes]::ReparsePoint)
        if ($isLink) {
            $current = TargetOf $existing
            if ($current -and $current -eq $Destination) {
                Done "联结已指向目标，无需操作：$Path -> $Destination"
                return $false
            }
            if (-not $Replace) {
                Fail "联结已存在但指向别处：$Path -> $current 。加 -Force 重建，或先手动检查。"
            }
            $null = cmd /c rmdir "$Path"
            if ($LASTEXITCODE -ne 0) { Fail "删除旧联结失败：$Path" }
            Write-Host "已删除旧联结：$Path -> $current"
        }
        elseif ($existing.PSIsContainer) {
            Fail "该路径是真实目录而不是联结：$Path 。脚本不会替换它，请手动确认后处理。"
        }
        else {
            Fail "该路径是文件而不是目录：$Path"
        }
    }
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    New-Item -ItemType Junction -Path $Path -Target $Destination | Out-Null
    $check = Get-Item -LiteralPath $Path -Force
    if (-not [bool]($check.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        Fail "创建后校验失败：$Path 不是联结"
    }
    Done "已建立联结：$Path -> $Destination"
    return $true
}

# 1. 目标必须是存在的引擎包根目录（含 engine-component.json 的版本子目录）
if (-not (Test-Path -LiteralPath $Target -PathType Container)) {
    Fail "目标目录不存在：$Target"
}
$Target = (Get-Item -LiteralPath $Target).FullName
$package = Get-ChildItem -LiteralPath $Target -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'engine-component.json') } |
    Sort-Object Name -Descending |
    Select-Object -First 1
if (-not $package) {
    Fail "目标目录里没有引擎包（找不到 engine-component.json）：$Target"
}
Write-Host "引擎包：$($package.FullName)"

# 2. engine 联结，并穿过它校验引擎包可读
$null = Set-Junction -Path $LinkPath -Destination $Target -Replace:$Force
$through = Join-Path $LinkPath (Join-Path $package.Name 'engine-component.json')
if (-not (Test-Path -LiteralPath $through)) {
    Fail "联结可用，但穿过它读不到引擎包：$through 。请检查目标路径：$Target"
}
Done "engine 联结可用：$LinkPath -> $Target"

# 3. control 联结：components\control -> 本目录\control（版本容器）
$controlRoot = Join-Path $PSScriptRoot 'control'
$controlLink = Join-Path $env:LOCALAPPDATA 'Strata\components\control'
$activeFile  = Join-Path $controlRoot 'active.json'
if (-not (Test-Path -LiteralPath $controlRoot -PathType Container)) {
    Write-Host "提示：本目录没有 control 子目录，跳过控制端联结维护。"
}
elseif (-not (Test-Path -LiteralPath $activeFile)) {
    Write-Host "提示：control 还不是版本容器（缺 active.json），跳过控制端联结维护。"
}
else {
    $null = Set-Junction -Path $controlLink -Destination $controlRoot -Replace:$Force
    if (-not (Test-Path -LiteralPath (Join-Path $controlLink 'active.json'))) {
        Fail "控制端联结可用，但穿过它读不到 active.json：$controlLink"
    }
    Done "控制端联结可用：$controlLink -> $controlRoot"
}

# 4. 找出运行中的控制端版本：读 active.json 的 folder
$running = $null
if (Test-Path -LiteralPath $activeFile) {
    try {
        $active = Get-Content -LiteralPath $activeFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($active.PSObject.Properties.Name -contains 'folder' -and $active.folder) {
            $running = [string]$active.folder
        }
    }
    catch { $running = $null }
}
$versionDir = if ($running) { Join-Path $controlRoot $running } else { $controlRoot }

# 5. 用控制器做一次只读复核（不启动模型）
$py  = Join-Path $versionDir 'python\python.exe'
$cli = Join-Path $versionDir 'strata.py'
if ((Test-Path -LiteralPath $py) -and (Test-Path -LiteralPath $cli)) {
    Write-Host ""
    Write-Host "正在用控制器复核（只读，不启动模型）……"
    $output = & $py $cli components engine --output json 2>&1 | Out-String
    $code = $LASTEXITCODE
    if ($code -eq 0 -and $output -match '"ok":\s*true') {
        Done "控制器已能解析引擎（strata components engine 返回 ok:true）"
    }
    else {
        Write-Host "[警告] 控制器复核未通过（exit=$code）：" -ForegroundColor Yellow
        Write-Host $output
        exit 1
    }
}
else {
    Write-Host "提示：未找到可运行的控制端（$versionDir），跳过控制器复核。"
}

# 6. 登记数据目录：让控制器（models / launch / setup）认得本目录与模型目录
$strataRoot   = $PSScriptRoot
$dataDir      = Join-Path (Split-Path -Parent $strataRoot) 'Strata-data'
$settingsFile = Join-Path $env:APPDATA 'Strata\settings.json'

$settings = [ordered]@{}
$current  = $null
if (Test-Path -LiteralPath $settingsFile) {
    try {
        $raw = Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8
        if ($raw -and $raw.Trim()) { $current = $raw | ConvertFrom-Json }
    }
    catch { Fail "现有 settings.json 无法解析，未做改动：$settingsFile`n$($_.Exception.Message)" }
    if ($current) {
        foreach ($prop in $current.PSObject.Properties) { $settings[$prop.Name] = $prop.Value }
    }
}

$installs = @()
if ($settings.Contains('installs')) {
    $installs = @($settings['installs'] | Where-Object { $_ -is [string] -and $_ })
}
if ($installs -notcontains $strataRoot) { $installs += $strataRoot }

$dataOk = $false
if ($current) {
    $curData = if ($current.PSObject.Properties.Name -contains 'data_dir') { [string]$current.data_dir } else { '' }
    $curInst = @()
    if ($current.PSObject.Properties.Name -contains 'installs') {
        $curInst = @($current.installs | Where-Object { $_ -is [string] })
    }
    if ($curData -eq $dataDir -and ($curInst -contains $strataRoot)) { $dataOk = $true }
}

if ($dataOk) {
    Done "数据目录已登记，无需改动：$settingsFile"
}
else {
    $parent = Split-Path -Parent $settingsFile
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    if (Test-Path -LiteralPath $settingsFile) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        Copy-Item -LiteralPath $settingsFile -Destination "$settingsFile.bak-$stamp" -Force
        Write-Host "已备份原设置：$settingsFile.bak-$stamp"
    }
    $settings['data_dir'] = $dataDir
    $settings['installs'] = $installs
    $json = $settings | ConvertTo-Json -Depth 10
    $utf8 = New-Object System.Text.UTF8Encoding($false)     # 无 BOM，避免别的工具读出不干净的 JSON
    [IO.File]::WriteAllText($settingsFile, $json, $utf8)
    $back = (Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8) | ConvertFrom-Json
    if ([string]$back.data_dir -ne $dataDir) { Fail "写入后校验失败：data_dir 不是 $dataDir" }
    Done "已登记数据目录：data_dir = $dataDir"
    Write-Host "       installs = $($installs -join ' ; ')"
}
