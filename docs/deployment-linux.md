# 远程 Linux 部署

本包包含 Python 后端、前端源码和已构建网页（`frontend/dist`）。服务器只需 Python 3.10+（建议 3.12），不需要 Node.js、桌面、Tk 或服务器 GPU。三维场景由本地浏览器 WebGL 渲染，数据读取和二维导出在服务器运行。

## 1. 上传与安装

将压缩包上传到服务器，例如在本地终端运行（替换包名、用户名和主机名）：

```bash
scp SeisCanvas-linux-*.tar.gz user@server:~/
ssh user@server
```

在服务器解压并安装：

```bash
tar -xzf SeisCanvas-linux-YYYYMMDD-HHMMSS.tar.gz
cd SeisCanvas-linux-YYYYMMDD-HHMMSS
bash deploy/install-linux.sh
bash deploy/start-linux.sh
```

安装脚本需要访问 Python 软件源；本包不含离线依赖。若缺少 venv，Debian/Ubuntu 可安装对应 Python 版本的 `python3-venv` 软件包，或使用已有的 Python 环境。指定解释器可用 `PYTHON_BIN=python3.12 bash deploy/install-linux.sh`。不同 Linux 架构与旧系统的依赖安装情况需在目标服务器确认。

## 2. 在本地建立端口转发

保持服务器程序运行，在本地另开终端：

```bash
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8000:127.0.0.1:8000 user@server
```

浏览器打开 http://127.0.0.1:8000 。只需转发这一个端口，无需转发 5173。VS Code Remote SSH 中也可以直接转发服务器 8000 端口。

如果本地 8000 已被占用，把转发命令中第一个 8000 改成 18000，再打开 http://127.0.0.1:18000 。如果服务器 8000 被占用，先用 `SEISCANVAS_PORT=8001 bash deploy/start-linux.sh` 启动，再将转发目标改为 8001。

## 3. 导入数据与保存

- 启动脚本启用远程模式。点击“导入 SEG-Y”后填写服务器上的绝对路径，例如 `/data/survey.segy`。
- 导入层位时每行填写一个服务器 `.txt` / `.dat` 文件路径，之后按原流程设置数据列、分组和层位对应。
- 路径支持空格，无需引号；不支持通配符。文件必须可由运行服务的 Linux 用户读取。
- 本地电脑的文件先通过 scp、SFTP 等传到服务器。网页中的路径指服务器文件系统；SSH 端口转发不会映射本地文件。
- 已有项目缺失文件时，“重新关联”也可填写新的服务器路径。
- 项目默认保存在 `~/.local/share/seiscanvas`（设置 `XDG_DATA_HOME` 时使用其下的 `seiscanvas`）。也可指定固定位置：`SEISCANVAS_STATE_DIR=/data/seiscanvas-state bash deploy/start-linux.sh`。
- 备份时同时保留项目状态目录和原始数据。项目保存的是源文件路径，不会复制 SEG-Y 和层位文件。
- 本包不含当前电脑的原始数据、已保存项目和导出图件。

## 4. 持续运行与使用边界

可在服务器的 tmux 会话里运行启动脚本，离开会话后程序继续运行；或使用：

```bash
nohup bash deploy/start-linux.sh >seiscanvas.log 2>&1 &
echo $! >seiscanvas.pid
# 停止本次后台进程
kill "$(cat seiscanvas.pid)"
```

服务仅监听服务器 `127.0.0.1`，按单用户设计，没有账号认证，应通过 SSH 隧道访问。一个实例只有一个活动项目，不要启用多个 Uvicorn worker。三维交互受本地浏览器显卡、远程连接带宽和数据规模影响。

停止后再次启动只需执行 `bash deploy/start-linux.sh`。更新安装目录时继续使用同一个状态目录和源数据路径即可。

## 验证范围

打包时在当前 macOS 环境执行前端检查、构建、后端测试和压缩包解压启动检查，并测试无桌面模式的文件导入。尚未登录目标 Linux 服务器实测；包内不包含 macOS 虚拟环境或本机二进制依赖，Python 依赖在目标 Linux 上安装。
