# Generates the PNG app icons with GDI+ (Windows PowerShell). Run: powershell -File tools/make-icons.ps1
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'icons'

function RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function Make([int]$size, [string]$name, [bool]$rounded, [float]$scale) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.Clear([System.Drawing.Color]::Transparent)
  $k = $size / 512.0
  $rect = New-Object System.Drawing.RectangleF 0, 0, $size, $size
  $c1 = [System.Drawing.ColorTranslator]::FromHtml('#3E6BE0')
  $c2 = [System.Drawing.ColorTranslator]::FromHtml('#1D3A8A')
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $c1, $c2, 45
  if ($rounded) { $g.FillPath($bg, (RoundRect 0 0 $size $size (112 * $k))) } else { $g.FillRectangle($bg, $rect) }

  # scale artwork around the center (maskable icons need a safe zone)
  $g.TranslateTransform($size / 2, $size / 2)
  $g.ScaleTransform($scale, $scale)
  $g.TranslateTransform(-$size / 2, -$size / 2)

  $orange = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#FFB27A'))
  $textc = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#FF6B1A'))
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $navy = New-Object System.Drawing.SolidBrush $c2

  $state = $g.Save()
  $g.TranslateTransform(240 * $k, 268 * $k); $g.RotateTransform(-10); $g.TranslateTransform(-240 * $k, -268 * $k)
  $g.FillPath($orange, (RoundRect (120 * $k) (128 * $k) (240 * $k) (280 * $k) (36 * $k)))
  $g.Restore($state)

  $state = $g.Save()
  $g.TranslateTransform(280 * $k, 252 * $k); $g.RotateTransform(7); $g.TranslateTransform(-280 * $k, -252 * $k)
  # soft shadow
  $shadow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(50, 0, 0, 30))
  $g.FillPath($shadow, (RoundRect (166 * $k) (124 * $k) (240 * $k) (280 * $k) (36 * $k)))
  $g.FillPath($white, (RoundRect (160 * $k) (112 * $k) (240 * $k) (280 * $k) (36 * $k)))
  $font = New-Object System.Drawing.Font 'Segoe UI Black', ([float](190 * $k)), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
  $g.DrawString('w', $font, $textc, (New-Object System.Drawing.RectangleF (160 * $k), (112 * $k), (240 * $k), (280 * $k)), $sf)
  $g.Restore($state)

  $g.Dispose()
  $bmp.Save((Join-Path $out $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "wrote $name"
}

Make 192 'icon-192.png' $true 1.0
Make 512 'icon-512.png' $true 1.0
Make 512 'icon-maskable-512.png' $false 0.78
Make 180 'apple-touch-icon.png' $false 0.92
Make 32 'favicon-32.png' $true 1.0
