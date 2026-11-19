$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class CodexWindowHost {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr data);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int dx,dy; public uint mouseData,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KeyboardInput { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MouseInput mouse; [FieldOffset(0)] public KeyboardInput key; }
  [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public InputUnion value; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc,IntPtr data);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int count);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd,out Rect bounds);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd,int command);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] static extern uint SendInput(uint count,Input[] values,int size);
  public static object[] Windows() {
    var result = new List<object>();
    EnumWindows((hwnd,data)=>{
      if(!IsWindowVisible(hwnd)) return true;
      var title = new StringBuilder(2048); GetWindowText(hwnd,title,title.Capacity);
      if(title.Length==0) return true;
      uint pid; GetWindowThreadProcessId(hwnd,out pid);
      string app; try { app=System.Diagnostics.Process.GetProcessById((int)pid).MainModule.FileName; } catch { app="process:"+pid; }
      result.Add(new {id=hwnd.ToInt64(),app,title=title.ToString()}); return true;
    },IntPtr.Zero);
    return result.ToArray();
  }
  static void Send(Input input) { if(SendInput(1,new[]{input},Marshal.SizeOf<Input>())!=1) throw new Exception("Windows rejected input injection"); }
  public static void Key(ushort vk,bool up) { Send(new Input{type=1,value=new InputUnion{key=new KeyboardInput{vk=vk,flags=up?2u:0u}}}); }
  public static void Text(string text) { foreach(char c in text) { Send(new Input{type=1,value=new InputUnion{key=new KeyboardInput{scan=c,flags=4}}}); Send(new Input{type=1,value=new InputUnion{key=new KeyboardInput{scan=c,flags=6}}}); } }
  public static void Mouse(int x,int y,uint flags,uint data=0) { if(!SetCursorPos(x,y)) throw new Exception("Unable to position pointer"); Send(new Input{type=0,value=new InputUnion{mouse=new MouseInput{flags=flags,mouseData=data}}}); }
}
'@

try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json -AsHashtable
  $operation = $request.method
  $inputData = $request.params
  $windows = @([CodexWindowHost]::Windows())
  $result = $null
  switch ($operation) {
    'list_windows' { $result = @($windows) }
    'list_apps' { $result = @($windows | Group-Object app | ForEach-Object { @{ id=$_.Name; displayName=[IO.Path]::GetFileNameWithoutExtension($_.Name); isRunning=$true; windows=@($_.Group) } }) }
    'get_window' {
      $result = $windows | Where-Object { $_.id -eq $inputData.id -and (!$inputData.app -or $_.app -eq $inputData.app) } | Select-Object -First 1
      if (!$result) { throw 'Target window is closed or no longer matches its process' }
    }
    'launch_app' {
      if (![IO.Path]::IsPathFullyQualified($inputData.app) -or [IO.Path]::GetExtension($inputData.app) -ne '.exe') { throw 'launch_app requires an explicit executable path' }
      Start-Process -FilePath $inputData.app -WindowStyle Hidden
    }
    default {
      $target = $windows | Where-Object { $_.id -eq $inputData.window.id -and $_.app -eq $inputData.window.app } | Select-Object -First 1
      if (!$target) { throw 'Target window is closed; select a window again' }
      $handle = [IntPtr][long]$target.id
      $bounds = [CodexWindowHost+Rect]::new()
      if (![CodexWindowHost]::GetWindowRect($handle,[ref]$bounds)) { throw 'Unable to read window bounds' }
      if ($operation -eq 'accessibility' -or $inputData.ContainsKey('element_index')) {
        # PowerShell 7 ships matching .NET UIAutomation assemblies. Mixing
        # Framework 4 client/types with its .NET runtime fails at FromHandle.
        $wpf = $PSHOME
        Add-Type -Path (Join-Path $wpf 'UIAutomationTypes.dll')
        Add-Type -Path (Join-Path $wpf 'UIAutomationClient.dll')
        $rootElement = [Windows.Automation.AutomationElement]::FromHandle($handle)
        $elements = $rootElement.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
        if ($operation -eq 'accessibility') {
          $lines = [Collections.Generic.List[string]]::new()
          for ($index=0; $index -lt [Math]::Min($elements.Count,2000); $index++) {
            $element = $elements[$index].Current
            if (!$element.IsOffscreen) { $lines.Add("[$index] $($element.ControlType.ProgrammaticName) $($element.Name)") }
          }
          $focused = [Windows.Automation.AutomationElement]::FocusedElement
          $result = @{ tree=$lines -join "`n"; focused_element=$focused.Current.Name; document_text=$null; selected_text=$null; selected_elements=@() }
          break
        }
        $selected = $elements[[int]$inputData.element_index]
      }
      [void][CodexWindowHost]::ShowWindow($handle,9)
      if (![CodexWindowHost]::SetForegroundWindow($handle)) { throw 'Windows did not activate the target window' }
      switch ($operation) {
        'activate_window' {}
        'type_text' { [CodexWindowHost]::Text($inputData.text) }
        'set_value' { $selected.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($inputData.value) }
        'perform_secondary_action' {
          if ($inputData.action -eq 'expand') { $selected.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern).Expand() }
          elseif ($inputData.action -eq 'collapse') { $selected.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern).Collapse() }
          else { throw "Unsupported accessibility action: $($inputData.action)" }
        }
        'click' {
          if ($selected) { $point=$selected.GetClickablePoint(); $x=[int]$point.X; $y=[int]$point.Y }
          else { $x=$bounds.Left+[int]$inputData.x; $y=$bounds.Top+[int]$inputData.y }
          $down=2; $up=4
          if ($inputData.mouse_button -in @('right','r')) { $down=8; $up=16 }
          if ($inputData.mouse_button -in @('middle','m')) { $down=32; $up=64 }
          $count=if($inputData.click_count){[int]$inputData.click_count}else{1}
          for($clickIndex=0;$clickIndex -lt $count;$clickIndex++){ [CodexWindowHost]::Mouse($x,$y,$down); [CodexWindowHost]::Mouse($x,$y,$up) }
        }
        'scroll' {
          $x=$bounds.Left+[int]$inputData.x; $y=$bounds.Top+[int]$inputData.y
          if ($inputData.scrollY) { [CodexWindowHost]::Mouse($x,$y,2048,[uint32]([int64](-[int]$inputData.scrollY) -band 0xffffffffL)) }
          if ($inputData.scrollX) { [CodexWindowHost]::Mouse($x,$y,4096,[uint32]([int64]([int]$inputData.scrollX) -band 0xffffffffL)) }
        }
        'drag' {
          [CodexWindowHost]::Mouse($bounds.Left+[int]$inputData.from_x,$bounds.Top+[int]$inputData.from_y,2)
          try { [CodexWindowHost]::Mouse($bounds.Left+[int]$inputData.to_x,$bounds.Top+[int]$inputData.to_y,1) }
          finally { [CodexWindowHost]::Mouse($bounds.Left+[int]$inputData.to_x,$bounds.Top+[int]$inputData.to_y,4) }
        }
        'press_key' {
          $aliases=@{control=17;ctrl=17;control_l=17;control_r=17;shift=16;shift_l=16;shift_r=16;alt=18;alt_l=18;alt_r=18;return=13;enter=13;tab=9;escape=27;backspace=8;delete=46;space=32;left=37;up=38;right=39;down=40;home=36;end=35;pageup=33;pagedown=34;period=190;comma=188;slash=191;greater=190;less=188}
          $keys=@($inputData.key.Split('+') | ForEach-Object {
            $name=$_.Trim().ToLowerInvariant()
            if($aliases.ContainsKey($name)){$aliases[$name]}
            elseif($name -match '^[a-z0-9]$'){[int][char]$name.ToUpperInvariant()}
            elseif($name -match '^f([1-9]|1[0-2])$'){111+[int]$Matches[1]}
            else{throw "Unsupported key: $name"}
          })
          try { foreach($key in $keys){[CodexWindowHost]::Key([ushort]$key,$false)} }
          finally { [array]::Reverse($keys); foreach($key in $keys){[CodexWindowHost]::Key([ushort]$key,$true)} }
        }
        default { throw "Unknown Windows host method: $operation" }
      }
    }
  }
  @{result=$result} | ConvertTo-Json -Depth 20 -Compress
} catch {
  @{error=$_.Exception.Message} | ConvertTo-Json -Compress
}
