# 生成 Tauri 所需图标（PNG + ICO），避免依赖外部图标资源
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot "..\src-tauri\icons"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

function New-IconBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

    $bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 22, 24, 30))
    $g.FillRectangle($bg, 0, 0, $size, $size)

    $accent = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 122, 162, 247))
    $g.FillRectangle($accent, 0, [int]($size * 0.78), $size, [int]($size * 0.22))

    $fontSize = [single]($size * 0.52)
    try { $font = New-Object System.Drawing.Font("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel) }
    catch { $font = New-Object System.Drawing.Font("Arial", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel) }

    $fg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $rect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
    $g.DrawString("lc", $font, $fg, $rect, $sf)

    $g.Dispose()
    return $bmp
}

foreach ($s in 32, 128, 256, 512) {
    $bmp = New-IconBitmap $s
    $bmp.Save((Join-Path $outDir "${s}x${s}.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

# ICO：单条目，内嵌 256x256 PNG（Windows Vista+ 支持 PNG 载荷）
$pngBytes = [System.IO.File]::ReadAllBytes((Join-Path $outDir "256x256.png"))
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([UInt16]0)                  # reserved
$bw.Write([UInt16]1)                  # type: icon
$bw.Write([UInt16]1)                  # image count
$bw.Write([Byte]0)                    # width  0 => 256
$bw.Write([Byte]0)                    # height 0 => 256
$bw.Write([Byte]0)                    # palette
$bw.Write([Byte]0)                    # reserved
$bw.Write([UInt16]1)                  # color planes
$bw.Write([UInt16]32)                 # bits per pixel
$bw.Write([UInt32]$pngBytes.Length)   # size of image data
$bw.Write([UInt32]22)                 # offset (6 + 16)
$bw.Write($pngBytes)
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $outDir "icon.ico"), $ms.ToArray())
$bw.Dispose(); $ms.Dispose()

Get-ChildItem $outDir | Select-Object Name, Length | Format-Table -AutoSize
