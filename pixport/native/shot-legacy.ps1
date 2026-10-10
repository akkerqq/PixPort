# Opens first-level menu, clicks the LAST item ("show more options") via UIA,
# then screenshots the classic menu so we can verify our legacy verb is back.
# ASCII-only by design: PS 5.1 reads .ps1 without BOM as ANSI.
# The classic verb name contains Cyrillic, so we select by POSITION (last item).
param([string]$Folder = "C:\Users\pasha\Desktop\drag-test",
      [string]$Out    = "C:\Users\pasha\AppData\Local\Temp\opencode\ctx-legacy.png")

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class K6 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  public static void RightClick(){
    mouse_event(0x0008,0,0,0,IntPtr.Zero);
    System.Threading.Thread.Sleep(60);
    mouse_event(0x0010,0,0,0,IntPtr.Zero);
  }
}
'@

function Snap([string]$p) {
  Start-Sleep -Milliseconds 1200
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
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
[void][K6]::SetForegroundWindow($ex.MainWindowHandle)
Start-Sleep -Milliseconds 900

$r = New-Object K6+RECT
[void][K6]::GetWindowRect($ex.MainWindowHandle, [ref]$r)
[void][K6]::SetCursorPos([int](($r.L+$r.R)/2), [int](($r.T+$r.B)/2))
Start-Sleep -Milliseconds 300
[K6]::RightClick()
Start-Sleep -Milliseconds 1500

# Walk the ENTIRE UIA tree looking for menu items (menu may live in any process).
$root = [System.Windows.Automation.AutomationElement]::RootElement
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
          [System.Windows.Automation.ControlType]::MenuItem)))

$items = @()
foreach ($e in $all) {
  try { $items += [PSCustomObject]@{ Name=$e.Current.Name; El=$e } } catch {}
}
"menu items found: $($items.Count)"
$items | ForEach-Object { "   - $($_.Name)" }

if ($items.Count -eq 0) { "no menu items; giving up"; exit 1 }

# Last item of the first-level menu is "show more options"
$last = $items[-1]
"invoking last: $($last.Name)"
try {
  $pat = $last.El.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  [void]$pat.Invoke()
  "invoked OK"
} catch {
  "invoke failed: $($_.Exception.Message)"
}
Start-Sleep -Milliseconds 900

Snap $Out

# now enumerate menu items of the classic menu
$all2 = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
          [System.Windows.Automation.ControlType]::MenuItem)))
"`n=== classic menu items ($($all2.Count)) ==="
foreach ($e in $all2) { try { "   - " + $e.Current.Name } catch {} }

exit 0
