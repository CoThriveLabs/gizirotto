Add-Type -AssemblyName System.Drawing

$appRoot = Split-Path -Parent $PSScriptRoot
$publicDir = Join-Path $appRoot 'public'
$srcAppDir = Join-Path $appRoot 'src\app'
# favicon の元画像は public/gizirottokun.png を正本とする。
$src = "$publicDir\gizirottokun.png"

function Resize-Png {
    param([System.Drawing.Image]$img, [int]$size, [string]$outPath)
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.DrawImage($img, 0, 0, $size, $size)
    $g.Dispose()
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

$src_img = [System.Drawing.Image]::FromFile($src)

# 1. public/icon.png は Next.js 15 App Router の src/app/icon.png と衝突するため生成しない
#    （`A conflicting public file and page file was found for path /icon.png` 対策）
# Resize-Png -img $src_img -size 180 -outPath (Join-Path $publicDir 'icon.png')

# 2. src/app/icon.png (Next.js App Router auto-metadata, recommended 32x32 minimum, 512 ok)
Resize-Png -img $src_img -size 512 -outPath (Join-Path $srcAppDir 'icon.png')

# 3. src/app/apple-icon.png (Next.js auto-metadata for apple touch icon, 180x180)
Resize-Png -img $src_img -size 180 -outPath (Join-Path $srcAppDir 'apple-icon.png')

# 4. public/favicon.ico (multi-size 16/32/48)
$sizes = @(16, 32, 48)
$pngBytesList = @()
foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.DrawImage($src_img, 0, 0, $s, $s)
    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBytesList += ,($ms.ToArray())
    $ms.Dispose()
    $bmp.Dispose()
}

# Build ICO file (ICONDIR + ICONDIRENTRY[] + image data)
$icoPath = Join-Path $publicDir 'favicon.ico'
$fs = [System.IO.File]::Open($icoPath, [System.IO.FileMode]::Create)
$bw = New-Object System.IO.BinaryWriter($fs)

# ICONDIR (6 bytes)
$bw.Write([uint16]0)            # reserved
$bw.Write([uint16]1)            # type: 1 = icon
$bw.Write([uint16]$sizes.Count) # count

# Compute offsets
$headerSize = 6 + (16 * $sizes.Count)
$offset = $headerSize

# ICONDIRENTRY (16 bytes each)
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]
    $bytes = $pngBytesList[$i]
    $w = if ($s -ge 256) { 0 } else { $s }
    $h = if ($s -ge 256) { 0 } else { $s }
    $bw.Write([byte]$w)             # width
    $bw.Write([byte]$h)             # height
    $bw.Write([byte]0)              # color palette
    $bw.Write([byte]0)              # reserved
    $bw.Write([uint16]1)            # color planes
    $bw.Write([uint16]32)           # bits per pixel
    $bw.Write([uint32]$bytes.Length)# size of image data
    $bw.Write([uint32]$offset)      # offset to image data
    $offset += $bytes.Length
}

# Image data
foreach ($bytes in $pngBytesList) {
    $bw.Write($bytes)
}

$bw.Close()
$fs.Close()
$src_img.Dispose()

Write-Output "Generated:"
Write-Output "  $publicDir\favicon.ico"
Write-Output "  $srcAppDir\icon.png"
Write-Output "  $srcAppDir\apple-icon.png"
