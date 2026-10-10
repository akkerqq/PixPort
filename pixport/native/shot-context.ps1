# Opens Explorer, opens the context menu and takes a screenshot of the
# primary screen so the menu can be inspected visually.
# ASCII-only: PS 5.1 reads .ps1 without BOM as ANSI, Cyrillic breaks parsing.
param([string]$Folder = "C:\Users\pasha\Desktop\drag-test",
      [string]$Out    = "C:\Users\pasha\AppData\Local\Temp\opencode\ctxmenu.png")

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class K2 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
  public static void RightClick() {
    const uint RIGHTDOWN=0x0008, RIGHTUP=0x0010;   // not LEFTDOWN/LEFTUP (0x2/0x4)
    mouse_event(RIGHTDOWN,0,0,0,IntPtr.Zero);
    System.Threading.Thread.Sleep(60);
    mouse_event(RIGHTUP,0,0,0,IntPtr.Zero);
  }
  public static void Escape() {
    keybd_event(0x1B,0,0,IntPtr.Zero);
    System.Threading.Thread.Sleep(40);
    keybd_event(0x1B,0,2,IntPtr.Zero);
  }
}
'@

if (-not (Test-Path $Folder)) { New-Item -ItemType Directory -Force -Path $Folder | Out-Null }

# clean slate: close any leftover menu
Start-Process explorer.exe -ArgumentList $Folder
Start-Sleep -Seconds 3

$explorer = Get-Process explorer | Where-Object { $_.MainWindowHandle -ne 0 } |
            Sort-Object StartTime -Descending | Select-Object -First 1
if (-not $explorer) { "no explorer window"; exit 1 }
[void][K2]::SetForegroundWindow($explorer.MainWindowHandle)
Start-Sleep -Milliseconds 1000

# Right-click in the middle of the Explorer content area.
$rect = New-Object System.Drawing.Rectangle
[System.Windows.Forms.Screen]::PrimaryScreen.Bounds | Out-Null
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class R {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
'@
$r = New-Object R+RECT
[void][R]::GetWindowRect($explorer.MainWindowHandle, [ref]$r)
$cx = [int](($r.L + $r.R) / 2)
$cy = [int](($r.T + $r.B) / 2)
"window rect: L=$($r.L) T=$($r.T) R=$($r.R) B=$($r.B)  click at $cx,$cy"

[void][K2]::SetCursorPos($cx, $cy)
Start-Sleep -Milliseconds 300
[K2]::RightClick()
Start-Sleep -Seconds 2   # menu needs time to render

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

"screenshot: $Out ($((Get-Item $Out).Length) bytes)"
exit 0
