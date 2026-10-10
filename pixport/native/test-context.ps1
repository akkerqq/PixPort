# Checks which level of the Win11 context menu the PixPort item landed on.
# Opens Explorer, invokes the menu (Shift+F10) and enumerates FIRST-level
# items via UI Automation. ASCII-only on purpose: PS 5.1 reads .ps1 without
# BOM as ANSI, and Cyrillic would break the parser.
param([string]$Folder = "C:\Users\pasha\Desktop\drag-test")

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class K {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, IntPtr e);
  public static void PressShiftF10() {
    const byte VK_SHIFT=0x10, VK_F10=0x79, KEYEVENTF_KEYUP=2;
    keybd_event(VK_SHIFT,0,0,IntPtr.Zero);
    keybd_event(VK_F10,0,0,IntPtr.Zero);
    keybd_event(VK_F10,0,KEYEVENTF_KEYUP,IntPtr.Zero);
    keybd_event(VK_SHIFT,0,KEYEVENTF_KEYUP,IntPtr.Zero);
  }
}
'@

if (-not (Test-Path $Folder)) { New-Item -ItemType Directory -Force -Path $Folder | Out-Null }

Start-Process explorer.exe -ArgumentList $Folder
Start-Sleep -Seconds 3

$explorer = Get-Process explorer | Where-Object { $_.MainWindowHandle -ne 0 } |
            Sort-Object StartTime -Descending | Select-Object -First 1
if (-not $explorer) { "no explorer window"; exit 1 }
[void][K]::SetForegroundWindow($explorer.MainWindowHandle)
Start-Sleep -Milliseconds 800

[K]::PressShiftF10()
Start-Sleep -Seconds 2

$root = [System.Windows.Automation.AutomationElement]::RootElement

function Collect-Items($el, $depth) {
  $out = @()
  if ($depth -gt 4) { return $out }
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $child = $walker.GetFirstChild($el)
  while ($child) {
    $ct = $child.Current.ControlType
    if ($ct -eq [System.Windows.Automation.ControlType]::MenuItem -or
        $ct -eq [System.Windows.Automation.ControlType]::Button -or
        $ct -eq [System.Windows.Automation.ControlType]::ListItem) {
      $out += [PSCustomObject]@{
        Depth = $depth
        Name  = $child.Current.Name
        Class = $child.Current.ClassName
      }
      $out += Collect-Items $child ($depth + 1)
    }
    $child = $walker.GetNextSibling($child)
  }
  return $out
}

# The Win11 modern menu lives in its own window (ShellExperienceHost /
# StartMenuExperienceHost / XAML islands), so search every top-level window.
$items = @()
$hits = @()
Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {
  $p = $_
  try {
    $cond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $p.Id)
    $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
    if ($win) {
      $found = Collect-Items $win 0
      if ($found.Count -gt 0) {
        $hits += "  process: $($p.ProcessName) pid=$($p.Id) items=$($found.Count)"
        $items += $found
      }
    }
  } catch { }
}

"=== windows with menu-like items ==="
$hits | ForEach-Object { $_ }

if ($items.Count -eq 0) {
  "NOTHING: no menu elements found in any top-level window"
  exit 1
}

"=== items ==="
$items | ForEach-Object { ("  " * $_.Depth) + "- " + $_.Name + "  [" + $_.Class + "]" }

$pix = $items | Where-Object { $_.Name -match 'PixPort' }
if ($pix) {
  ""
  ">>> PixPort FOUND at depth: " + (($pix | ForEach-Object { $_.Depth }) -join ', ')
  exit 0
} else {
  ""
  ">>> PixPort NOT found in enumerated items"
  exit 1
}
