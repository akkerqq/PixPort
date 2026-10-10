# Two screenshots: (1) first-level Win11 context menu, (2) classic menu
# opened with Shift+right-click. ASCII-only, PS 5.1 reads .ps1 w/o BOM as ANSI.
param([string]$Folder = "C:\Users\pasha\Desktop\drag-test",
      [string]$Dir    = "C:\Users\pasha\AppData\Local\Temp\opencode")

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class K3 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  public static void Click(uint down, uint up) {
    mouse_event(down,0,0,0,IntPtr.Zero);
    System.Threading.Thread.Sleep(60);
    mouse_event(up,0,0,0,IntPtr.Zero);
  }
  public static void Down(uint f){ mouse_event(f,0,0,0,IntPtr.Zero); }
  public static void Up(uint f){ mouse_event(f,0,0,0,IntPtr.Zero); }
  public static void Key(byte vk, bool up){
    keybd_event(vk,0, up?2u:0u, IntPtr.Zero);
    System.Threading.Thread.Sleep(30);
  }
}
'@

function Snap([string]$name) {
  Start-Sleep -Milliseconds 1400
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $p = Join-Path $Dir $name
  $bmp.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  "shot: $p"
}

if (-not (Test-Path $Folder)) { New-Item -ItemType Directory -Force -Path $Folder | Out-Null }
Start-Process explorer.exe -ArgumentList $Folder
Start-Sleep -Seconds 3

$ex = Get-Process explorer | Where-Object { $_.MainWindowHandle -ne 0 } |
      Sort-Object StartTime -Descending | Select-Object -First 1
if (-not $ex) { "no explorer"; exit 1 }
[void][K3]::SetForegroundWindow($ex.MainWindowHandle)
Start-Sleep -Milliseconds 900

$r = New-Object K3+RECT
[void][K3]::GetWindowRect($ex.MainWindowHandle, [ref]$r)
$cx = [int](($r.L + $r.R) / 2)
$cy = [int](($r.T + $r.B) / 2)
"click at $cx,$cy"
[void][K3]::SetCursorPos($cx, $cy)
Start-Sleep -Milliseconds 300

# --- 1. plain right-click = Win11 first-level menu
[K3]::Click(0x0008, 0x0010)
Snap "ctx-level1.png"

# close it
[K3]::Key(0x1B, $false); [K3]::Key(0x1B, $true)
Start-Sleep -Milliseconds 500

# --- 2. Shift+right-click = classic "show more options" menu
[K3]::Key(0x10, $false)
[K3]::Click(0x0008, 0x0010)
Start-Sleep -Milliseconds 400
[K3]::Key(0x10, $true)
Snap "ctx-classic.png"

# close
[K3]::Key(0x1B, $false); [K3]::Key(0x1B, $true)
exit 0
