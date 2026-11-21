$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

$nativeSource = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class NearRemoteWin32
{
    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint MOUSEEVENTF_HWHEEL = 0x1000;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CURSORINFO
    {
        public int cbSize;
        public uint flags;
        public IntPtr hCursor;
        public POINT ptScreenPos;
    }

    public sealed class CursorState
    {
        public double x { get; set; }
        public double y { get; set; }
        public bool visible { get; set; }
        public bool leftDown { get; set; }
        public bool rightDown { get; set; }
        public string shape { get; set; }
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetCursorInfo(ref CURSORINFO cursorInfo);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int virtualKey);

    [DllImport("user32.dll", EntryPoint = "LoadCursorW")]
    private static extern IntPtr LoadCursor(IntPtr instance, IntPtr name);

    private static readonly KeyValuePair<IntPtr, string>[] systemCursors = new[] {
        new KeyValuePair<IntPtr, string>(LoadCursor(IntPtr.Zero, new IntPtr(32512)), "arrow"),
        new KeyValuePair<IntPtr, string>(LoadCursor(IntPtr.Zero, new IntPtr(32513)), "text"),
        new KeyValuePair<IntPtr, string>(LoadCursor(IntPtr.Zero, new IntPtr(32514)), "wait"),
        new KeyValuePair<IntPtr, string>(LoadCursor(IntPtr.Zero, new IntPtr(32650)), "wait"),
        new KeyValuePair<IntPtr, string>(LoadCursor(IntPtr.Zero, new IntPtr(32515)), "crosshair"),
        new KeyValuePair<IntPtr, string>(LoadCursor(IntPtr.Zero, new IntPtr(32649)), "hand"),
        new KeyValuePair<IntPtr, string>(LoadCursor(IntPtr.Zero, new IntPtr(32644)), "size-we"),
        new KeyValuePair<IntPtr, string>(LoadCursor(IntPtr.Zero, new IntPtr(32645)), "size-ns"),
        new KeyValuePair<IntPtr, string>(LoadCursor(IntPtr.Zero, new IntPtr(32642)), "size-nwse"),
        new KeyValuePair<IntPtr, string>(LoadCursor(IntPtr.Zero, new IntPtr(32643)), "size-nesw"),
        new KeyValuePair<IntPtr, string>(LoadCursor(IntPtr.Zero, new IntPtr(32646)), "move"),
        new KeyValuePair<IntPtr, string>(LoadCursor(IntPtr.Zero, new IntPtr(32648)), "not-allowed"),
    };

    private static bool leftDown;
    private static bool rightDown;
    private static Bitmap captureBitmap;
    private static Graphics captureGraphics;
    private static Bitmap previewBitmap;
    private static Graphics previewGraphics;
    private static MemoryStream jpegStream;
    private static ImageCodecInfo jpegEncoder;
    private static EncoderParameters jpegParameters;
    private static int jpegQuality = -1;

    public static int[] ScreenBounds()
    {
        int left = GetSystemMetrics(76);
        int top = GetSystemMetrics(77);
        int width = GetSystemMetrics(78);
        int height = GetSystemMetrics(79);
        if (width <= 0 || height <= 0) throw new InvalidOperationException("Could not read Windows desktop dimensions");
        return new[] { left, top, width, height };
    }

    public static CursorState ReadCursor()
    {
        CURSORINFO info = new CURSORINFO { cbSize = Marshal.SizeOf(typeof(CURSORINFO)) };
        if (!GetCursorInfo(ref info)) throw new InvalidOperationException("Could not read the desktop cursor");
        int[] bounds = ScreenBounds();
        string shape = "arrow";
        foreach (KeyValuePair<IntPtr, string> known in systemCursors)
        {
            if (known.Key != IntPtr.Zero && known.Key == info.hCursor) { shape = known.Value; break; }
        }
        return new CursorState {
            x = Math.Max(0, Math.Min(1, (double)(info.ptScreenPos.X - bounds[0]) / Math.Max(1, bounds[2] - 1))),
            y = Math.Max(0, Math.Min(1, (double)(info.ptScreenPos.Y - bounds[1]) / Math.Max(1, bounds[3] - 1))),
            visible = (info.flags & 1) != 0 && (info.flags & 2) == 0,
            leftDown = (GetAsyncKeyState(0x01) & 0x8000) != 0,
            rightDown = (GetAsyncKeyState(0x02) & 0x8000) != 0,
            shape = shape,
        };
    }

    private static void PrepareCapture(int width, int height)
    {
        if (captureBitmap != null && captureBitmap.Width == width && captureBitmap.Height == height) return;
        if (captureGraphics != null) captureGraphics.Dispose();
        if (captureBitmap != null) captureBitmap.Dispose();
        captureBitmap = new Bitmap(width, height, PixelFormat.Format32bppRgb);
        captureGraphics = Graphics.FromImage(captureBitmap);
        captureGraphics.CompositingMode = CompositingMode.SourceCopy;
    }

    private static void PreparePreview(int width, int height)
    {
        if (previewBitmap != null && previewBitmap.Width == width && previewBitmap.Height == height) return;
        if (previewGraphics != null) previewGraphics.Dispose();
        if (previewBitmap != null) previewBitmap.Dispose();
        previewBitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb);
        previewGraphics = Graphics.FromImage(previewBitmap);
        previewGraphics.CompositingMode = CompositingMode.SourceCopy;
        previewGraphics.CompositingQuality = CompositingQuality.HighSpeed;
        previewGraphics.SmoothingMode = SmoothingMode.None;
        previewGraphics.PixelOffsetMode = PixelOffsetMode.Half;
    }

    public static string CaptureJpeg(int maxWidth, int maxHeight, int quality)
    {
        if (maxWidth < 1280 || maxWidth > 3840 || maxHeight < 720 || maxHeight > 2160 || quality < 55 || quality > 95)
            throw new ArgumentOutOfRangeException("Invalid capture settings");
        int[] bounds = ScreenBounds();
        int left = bounds[0], top = bounds[1], width = bounds[2], height = bounds[3];
        double scale = Math.Min(1.0, Math.Min((double)maxWidth / width, (double)maxHeight / height));
        int outputWidth = Math.Max(1, (int)Math.Round(width * scale));
        int outputHeight = Math.Max(1, (int)Math.Round(height * scale));
        PrepareCapture(width, height);
        captureGraphics.CopyFromScreen(left, top, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
        Bitmap output = captureBitmap;
        if (outputWidth != width || outputHeight != height)
        {
            PreparePreview(outputWidth, outputHeight);
            // Bilinear is considerably faster than bicubic for live desktop
            // previews; higher quality modes keep a sharper downsample.
            previewGraphics.InterpolationMode = quality >= 90 ? InterpolationMode.HighQualityBilinear : InterpolationMode.Bilinear;
            previewGraphics.DrawImage(captureBitmap, new Rectangle(0, 0, outputWidth, outputHeight), 0, 0, width, height, GraphicsUnit.Pixel);
            output = previewBitmap;
        }
        if (jpegEncoder == null)
            jpegEncoder = Array.Find(ImageCodecInfo.GetImageEncoders(), item => item.MimeType == "image/jpeg");
        if (jpegParameters == null || jpegQuality != quality)
        {
            if (jpegParameters != null) jpegParameters.Dispose();
            jpegParameters = new EncoderParameters(1);
            jpegParameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
            jpegQuality = quality;
        }
        if (jpegStream == null) jpegStream = new MemoryStream(512 * 1024);
        jpegStream.SetLength(0);
        jpegStream.Position = 0;
        output.Save(jpegStream, jpegEncoder, jpegParameters);
        return Convert.ToBase64String(jpegStream.GetBuffer(), 0, checked((int)jpegStream.Length));
    }

    public static void DisposeCapture()
    {
        if (captureGraphics != null) captureGraphics.Dispose();
        if (captureBitmap != null) captureBitmap.Dispose();
        if (previewGraphics != null) previewGraphics.Dispose();
        if (previewBitmap != null) previewBitmap.Dispose();
        if (jpegParameters != null) jpegParameters.Dispose();
        if (jpegStream != null) jpegStream.Dispose();
        captureGraphics = null;
        captureBitmap = null;
        previewGraphics = null;
        previewBitmap = null;
        jpegParameters = null;
        jpegStream = null;
        jpegEncoder = null;
        jpegQuality = -1;
    }

    public static void Pointer(double x, double y)
    {
        int[] bounds = ScreenBounds();
        int px = bounds[0] + (int)Math.Round(Math.Max(0, Math.Min(1, x)) * Math.Max(0, bounds[2] - 1));
        int py = bounds[1] + (int)Math.Round(Math.Max(0, Math.Min(1, y)) * Math.Max(0, bounds[3] - 1));
        if (!SetCursorPos(px, py)) throw new InvalidOperationException("Could not move the pointer");
    }

    private static void Mouse(uint flags, uint data = 0)
    {
        INPUT input = new INPUT { type = INPUT_MOUSE };
        input.U.mi = new MOUSEINPUT { mouseData = data, dwFlags = flags, dwExtraInfo = IntPtr.Zero };
        if (SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1) throw new InvalidOperationException("Windows rejected mouse input");
    }

    public static void Button(string button, bool down)
    {
        if (button == "left")
        {
            if (down != leftDown) Mouse(down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP);
            leftDown = down;
        }
        else if (button == "right")
        {
            if (down != rightDown) Mouse(down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP);
            rightDown = down;
        }
        else throw new ArgumentException("Unknown mouse button");
    }

    public static void Click(string button, double x, double y)
    {
        Pointer(x, y);
        Button(button, true);
        Button(button, false);
    }

    public static void Scroll(double deltaX, double deltaY)
    {
        int delta = (int)Math.Max(-1200, Math.Min(1200, Math.Round(deltaY * 2)));
        if (delta != 0) Mouse(MOUSEEVENTF_WHEEL, unchecked((uint)delta));
        int horizontal = (int)Math.Max(-1200, Math.Min(1200, Math.Round(deltaX * 2)));
        if (horizontal != 0) Mouse(MOUSEEVENTF_HWHEEL, unchecked((uint)horizontal));
    }

    private static void Key(ushort key)
    {
        INPUT down = new INPUT { type = INPUT_KEYBOARD };
        down.U.ki = new KEYBDINPUT { wVk = key, dwExtraInfo = IntPtr.Zero };
        INPUT up = new INPUT { type = INPUT_KEYBOARD };
        up.U.ki = new KEYBDINPUT { wVk = key, dwFlags = KEYEVENTF_KEYUP, dwExtraInfo = IntPtr.Zero };
        if (SendInput(2, new[] { down, up }, Marshal.SizeOf(typeof(INPUT))) != 2) throw new InvalidOperationException("Windows rejected keyboard input");
    }

    public static void PressKey(string key)
    {
        ushort code;
        switch (key)
        {
            case "ENTER": code = 0x0D; break;
            case "TAB": code = 0x09; break;
            case "BACKSPACE": code = 0x08; break;
            case "ESC": code = 0x1B; break;
            case "SPACE": code = 0x20; break;
            case "UP": code = 0x26; break;
            case "DOWN": code = 0x28; break;
            case "LEFT": code = 0x25; break;
            case "RIGHT": code = 0x27; break;
            default: throw new ArgumentException("Unsupported key");
        }
        Key(code);
    }

    public static void TypeText(string text)
    {
        if (text == null || text.Length > 2000) throw new ArgumentException("Invalid text length");
        foreach (char character in text)
        {
            INPUT down = new INPUT { type = INPUT_KEYBOARD };
            down.U.ki = new KEYBDINPUT { wScan = character, dwFlags = KEYEVENTF_UNICODE, dwExtraInfo = IntPtr.Zero };
            INPUT up = new INPUT { type = INPUT_KEYBOARD };
            up.U.ki = new KEYBDINPUT { wScan = character, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, dwExtraInfo = IntPtr.Zero };
            if (SendInput(2, new[] { down, up }, Marshal.SizeOf(typeof(INPUT))) != 2) throw new InvalidOperationException("Windows rejected Unicode text input");
        }
    }

    public static void ReleaseButtons()
    {
        if (leftDown) { try { Mouse(MOUSEEVENTF_LEFTUP); } catch { } leftDown = false; }
        if (rightDown) { try { Mouse(MOUSEEVENTF_RIGHTUP); } catch { } rightDown = false; }
    }
}
'@

Add-Type -TypeDefinition $nativeSource -ReferencedAssemblies 'System.Drawing'
Add-Type -AssemblyName 'System.Windows.Forms'

try {
:requests while ($null -ne ($line = [Console]::ReadLine())) {
  $id = -1
  try {
    $request = $line | ConvertFrom-Json
    $id = [int]$request.id
    $data = $null
    switch ($request.action) {
      'dimensions' {
        $bounds = [NearRemoteWin32]::ScreenBounds()
        $displays = @()
        $displayIndex = 0
        foreach ($display in [System.Windows.Forms.Screen]::AllScreens) {
          $displays += @{ index = $displayIndex; x = $display.Bounds.X - $bounds[0]; y = $display.Bounds.Y - $bounds[1]; width = $display.Bounds.Width; height = $display.Bounds.Height; primary = $display.Primary }
          $displayIndex++
        }
        $data = @{ width = $bounds[2]; height = $bounds[3]; displays = $displays }
      }
      'cursor' { $data = [NearRemoteWin32]::ReadCursor() }
      'screen' {
        $maxWidth = 1920
        $maxHeight = 1080
        $quality = 88
        if ($null -ne $request.maxWidth) { $maxWidth = [int]$request.maxWidth }
        if ($null -ne $request.maxHeight) { $maxHeight = [int]$request.maxHeight }
        if ($null -ne $request.quality) { $quality = [int]$request.quality }
        $frame = [NearRemoteWin32]::CaptureJpeg($maxWidth, $maxHeight, $quality)
        # Base64 contains no JSON escaping characters. Avoid the per-frame
        # PowerShell JSON serializer and write this large string directly.
        [Console]::WriteLine('{"id":' + $id.ToString([System.Globalization.CultureInfo]::InvariantCulture) + ',"ok":true,"data":"' + $frame + '"}')
        continue requests
      }
      'pointer' { [NearRemoteWin32]::Pointer([double]$request.x, [double]$request.y); $data = $true }
      'button' { [NearRemoteWin32]::Button([string]$request.button, [bool]$request.down); $data = $true }
      'click' { [NearRemoteWin32]::Click([string]$request.button, [double]$request.x, [double]$request.y); $data = $true }
      'scroll' { [NearRemoteWin32]::Scroll([double]$request.deltaX, [double]$request.deltaY); $data = $true }
      'text' { [NearRemoteWin32]::TypeText([string]$request.text); $data = $true }
      'key' { [NearRemoteWin32]::PressKey([string]$request.key); $data = $true }
      default { throw 'Unsupported Windows control operation' }
    }
    @{ id = $id; ok = $true; data = $data } | ConvertTo-Json -Compress -Depth 5
  } catch {
    @{ id = $id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress -Depth 5
  }
}
} finally {
  [NearRemoteWin32]::ReleaseButtons()
  [NearRemoteWin32]::DisposeCapture()
}
