# Opens the CLASSIC (legacy) context menu via Shift+F10 and screenshots it,
# so we can see whether the classic verb is present after restoring `command`.
# ASCII-only: PS 5.1 reads .ps1 without BOM as ANSI, Cyrillic breaks parsing.
param([string]$Folder = "C:\Users\pasha\Desktop\drag-test",
      [string]$Out    = "C:\Users\pasha\AppData\Local\Temp\opencode\ctx-f10.png")

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class K5 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, IntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  public static void Key(byte vk, bool up){
    keybd_event(vk,0, up?2u:0u, IntPtr.Zero);
    System.Threading.Thread.Sleep(30);
  }
  public static void RightClick(){
    mouse_event(0x0008,0,0,0,IntPtr.Zero);
    System.Threading.Thread.Sleep(60);
    mouse_event(0x0010,0,0,0,IntPtr.Zero);
  }
}
'@

if (-not (Test-Path $Folder)) { New-Item -ItemType Directory -Force -Path $Folder | Out-Null }
Start-Process explorer.exe -ArgumentList $Folder
Start-Sleep -Seconds 3

$ex = Get-Process explorer | Where-Object { $_.MainWindowHandle -ne 0 } |
      Sort-Object StartTime -Descending | Select-Object -First 1
if (-not $ex) { "no explorer"; exit 1 }
[void][K5]::SetForegroundWindow($ex.MainWindowHandle)
Start-Sleep -Milliseconds 900

$r = New-Object K5+RECT
[void][K5]::GetWindowRect($ex.MainWindowHandle, [ref]$r)
$cx = [int](($r.L + $r.R) / 2)
$cy = [int](($r.T + $r.B) / 2)
[void][K5]::SetCursorPos($cx, $cy)
Start-Sleep -Milliseconds 300
[K5]::RightClick()
Start-Sleep -Milliseconds 900

# Shift+F10 = open the legacy/classic menu directly
[K5]::Key(0x10, $false)     # Shift down
[K5]::Key(0x79, $false)     # F10 down
[K5]::Key(0x79, $true)      # F10 up
Start-Sleep -Milliseconds 500
[K5]::Key(0x10, $true)      # Shift up
Start-Sleep -Milliseconds 1400

$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"shot: $Out"

# close the menu
[K5]::Key(0x1B, $false); [K5]::Key(0x1B, $true)
exit 0
