"""Native file chooser for the local desktop hosting SeisCanvas."""
import subprocess
import sys
from threading import Lock

_picker_lock = Lock()


def choose_segy(kind="SEG-Y"):
    if not _picker_lock.acquire(blocking=False):
        raise ValueError("文件选择窗口已打开，请先完成选择或取消。")
    try:
        if sys.platform == 'darwin':
            command = ['osascript', '-e', '''try
set selectedFile to choose file with prompt "选择 SEG-Y 文件"
return POSIX path of selectedFile
on error number -128
return ""
end try''']
        elif sys.platform == 'win32':
            command = ['powershell.exe', '-NoProfile', '-STA', '-Command', '''
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'SeisCanvas - Open SEG-Y'
$dialog.Filter = 'SEG-Y (*.sgy;*.segy)|*.sgy;*.segy|All files (*.*)|*.*'
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.FileName) }
$dialog.Dispose()
''']
        else:
            # A separate process keeps Tk on its main thread, outside FastAPI workers.
            command = [sys.executable, '-c', '''
import tkinter as tk
from tkinter import filedialog
root = tk.Tk()
root.withdraw()
try:
    print(filedialog.askopenfilename(title="SeisCanvas - Open SEG-Y", filetypes=[("SEG-Y", "*.sgy *.segy"), ("All files", "*")]))
finally:
    root.destroy()
''']
        if kind == "Horizon":
            command = [part.replace("SEG-Y (*.sgy;*.segy)|*.sgy;*.segy", "Horizon (*.txt;*.dat)|*.txt;*.dat").replace("*.sgy *.segy", "*.txt *.dat").replace("SEG-Y", "Horizon") for part in command]
        result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', timeout=300)
        if result.returncode:
            raise ValueError("无法打开系统文件选择器。请检查桌面环境；Linux 需要安装 python3-tk。")
        return result.stdout.strip() or None
    except subprocess.TimeoutExpired:
        raise ValueError("文件选择超时，请重新点击导入 SEG-Y。")
    except OSError:
        raise ValueError("系统文件选择器不可用，请检查系统桌面环境。")
    finally:
        _picker_lock.release()
