"""本地角色身份牌预览与视频导出服务。"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import threading
import time
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
EXPORTS = ROOT / "exports"
LOCK = threading.Lock()
JOB = None


def find_ffmpeg():
    """按环境变量、项目 tools 目录、系统 PATH、imageio_ffmpeg 顺序查找 FFmpeg。"""
    env = os.environ.get("FFMPEG")
    if env:
        candidate = Path(env)
        if candidate.is_file():
            return candidate
        resolved = shutil.which(env)
        if resolved:
            return Path(resolved)
    for rel in ("tools/ffmpeg.exe", "tools/ffmpeg"):
        local = ROOT / rel
        if local.is_file():
            return local
    found = shutil.which("ffmpeg")
    if found:
        return Path(found)
    try:
        import imageio_ffmpeg
        exe = Path(imageio_ffmpeg.get_ffmpeg_exe())
        if exe.is_file():
            return exe
    except Exception:
        pass
    return None


def audio_arguments(scene, request, duration):
    """根据场景音轨配置构建 FFmpeg 滤镜与音频编码参数。"""
    tracks = scene.get("audio", []) if request.get("includeAudio", True) else []
    request["audioTracks"] = tracks
    if not tracks:
        return [], ["-an"]
    volume = float(request.get("volume", 1))
    if not 0 <= volume <= 1:
        raise ValueError("音效音量应为 0—100%")
    inputs, filters, labels = [], [], []
    for index, track in enumerate(tracks, 1):
        path = (WEB / track["src"].lstrip("/")).resolve()
        if not path.is_relative_to(WEB.resolve()) or not path.is_file():
            raise ValueError("未找到模板原音效：" + track["src"])
        inputs += ["-i", str(path)]
        start = float(track.get("sourceStart", 0))
        offset = float(track.get("offset", track.get("start", 0)))
        length = track.get("duration")
        if length is not None and offset + float(length) > duration + 0.034:
            raise ValueError("模板时长会截断音效尾音，请先延长场景时间")
        trim = f"atrim=start={start}"
        if length is not None:
            trim += f":duration={float(length)}"
        fade = float(track.get("fadeOut", 0))
        if fade > 0 and length is not None and float(length) > 0.02:
            d_fade = min(fade, float(length))
            trim += f",afade=t=out:st={round(float(length) - d_fade, 4)}:d={round(d_fade, 4)}"
        label = f"a{index}"
        filters.append(f"[{index}:a]{trim},asetpts=PTS-STARTPTS,"
                       f"adelay={round(offset * 1000)}:all=1,volume={volume * float(track.get('gain', 1))}[{label}]")
        labels.append(f"[{label}]")
    filters.append("".join(labels) + f"amix=inputs={len(labels)}:normalize=0,apad,atrim=duration={duration}[audio]")
    codec = ["-c:a", "pcm_s16le"] if request["format"] == "prores" else ["-c:a", "aac", "-b:a", "192k"]
    return inputs, ["-filter_complex_threads", "1", "-filter_complex", ";".join(filters),
                    "-map", "0:v:0", "-map", "[audio]", "-ar", "48000"] + codec


def close_job(remove=False):
    """终止并清理当前导出进程与临时文件。"""
    global JOB
    if JOB:
        if JOB["process"].poll() is None:
            JOB["process"].kill()
            JOB["process"].wait()
        JOB["log"].close()
        if remove:
            JOB["output"].unlink(missing_ok=True)
        JOB = None


class Handler(SimpleHTTPRequestHandler):
    """处理静态资源访问与逐帧视频导出 API。"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def end_headers(self):
        path = urlparse(self.path).path
        if path == "/" or Path(path).suffix in (".html", ".js", ".json"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def reply(self, code, value):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        route = urlparse(self.path)
        if route.path == "/api/health":
            return self.reply(200, {"ok": True, "ffmpeg": find_ffmpeg() is not None})
        if route.path == "/api/export/file":
            name = parse_qs(route.query).get("name", [""])[0]
            path = EXPORTS / name
            if not name or Path(name).name != name or path.suffix not in (".mp4", ".mov") or not path.is_file():
                return self.reply(404, {"error": "导出文件不存在"})
            self.send_response(200)
            self.send_header("Content-Type", "video/quicktime" if path.suffix == ".mov" else "video/mp4")
            self.send_header("Content-Length", str(path.stat().st_size))
            self.send_header("Content-Disposition", f'attachment; filename="{name}"')
            self.end_headers()
            with path.open("rb") as source:
                shutil.copyfileobj(source, self.wfile)
            return
        super().do_GET()

    def do_POST(self):
        port = self.server.server_port
        if self.headers.get("Origin") not in (f"http://127.0.0.1:{port}", f"http://localhost:{port}"):
            return self.reply(403, {"error": "只接受本地页面的同源请求"})
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= 16 * 1024 * 1024:
            return self.reply(413, {"error": "请求大小不正确"})
        body = self.rfile.read(length)
        route = urlparse(self.path)
        try:
            with LOCK:
                result = self.handle_export(route, body)
            self.reply(200, result)
        except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
            self.reply(400, {"error": str(error)})

    def handle_export(self, route, body):
        global JOB
        if route.path == "/api/export/start":
            if JOB and (JOB["process"].poll() is not None or time.monotonic() - JOB["last_active"] > 60):
                close_job(remove=True)
            if JOB:
                raise ValueError("已有导出任务正在运行")
            request = json.loads(body)
            scenes = json.loads((WEB / "scenes.json").read_text(encoding="utf-8"))["scenes"]
            scene = next((item for item in scenes if item["id"] == request["sceneId"]), None)
            if not scene or not scene.get("available"):
                raise ValueError("该模板的原始素材尚未就绪，不能导出")
            fps = int(request["fps"])
            if fps not in (30, 60):
                raise ValueError("帧率只能选择 30 或 60")
            export_format = request.get("format", "mp4")
            if export_format not in ("mp4", "prores"):
                raise ValueError("导出格式只能选择 MP4 或透明 MOV")
            request["format"] = export_format
            if export_format == "prores":
                request["background"] = "transparent"
            elif request.get("background") not in ("green", "black"):
                raise ValueError("MP4 背景只能选择绿幕或纯黑")
            frames = round(float(scene["duration"]) * fps)
            if frames <= 0 or frames > 36000:
                raise ValueError("动画时长不正确")
            ffmpeg = find_ffmpeg()
            if not ffmpeg:
                raise ValueError("未找到 FFmpeg，请先安装 FFmpeg 并加入系统 PATH（或放入项目 tools/ 目录）后再导出视频")
            audio_inputs, audio_output = audio_arguments(scene, request, frames / fps)
            EXPORTS.mkdir(exist_ok=True)
            task_id = uuid.uuid4().hex
            stem = f"{scene['id']}_{request.get('background', 'green')}_{task_id[:8]}"
            extension = ".mov" if export_format == "prores" else ".mp4"
            output = EXPORTS / f"{stem}.partial{extension}"
            log_path = EXPORTS / f"{stem}.ffmpeg.log"
            log = log_path.open("wb")
            command = [str(ffmpeg), "-hide_banner", "-loglevel", "error", "-y",
                       "-f", "image2pipe", "-vcodec", "png", "-framerate", str(fps), "-i", "pipe:0"]
            command += audio_inputs + audio_output + ["-filter_threads", "1"]
            if export_format == "prores":
                command += ["-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le"]
            else:
                command += ["-vf", "scale=1920:1080:flags=lanczos,format=yuv420p",
                            "-c:v", "libx264", "-preset", "fast", "-crf", "16"]
            command += ["-frames:v", str(frames), "-t", str(frames / fps), "-movflags", "+faststart", str(output)]
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=log)
            JOB = {"id": task_id, "process": process, "log": log, "log_path": log_path, "last_active": time.monotonic(),
                   "output": output, "frames": frames, "received": 0, "request": request}
            return {"taskId": task_id, "frames": frames, "fps": fps, "width": 1920, "height": 1080}

        query = parse_qs(route.query)
        if not JOB or query.get("id", [None])[0] != JOB["id"]:
            raise ValueError("导出任务不存在或编号不匹配")
        if route.path == "/api/export/frame":
            index = int(query.get("index", ["-1"])[0])
            digest = hashlib.sha256(body).digest()
            # 遇到网络波动重试时忽略重复到达的同一帧，防止多写。
            if index == JOB["received"] - 1 and digest == JOB.get("last_frame_digest"):
                JOB["last_active"] = time.monotonic()
                return {"received": JOB["received"]}
            if index != JOB["received"] or index >= JOB["frames"]:
                raise ValueError("帧序号不连续或超出计划帧数")
            if not body.startswith(b"\x89PNG\r\n\x1a\n"):
                raise ValueError("帧数据必须为 PNG")
            if int.from_bytes(body[16:20], "big") != 1920 or int.from_bytes(body[20:24], "big") != 1080:
                raise ValueError("帧尺寸必须为 1920 × 1080")
            try:
                JOB["process"].stdin.write(body)
                JOB["process"].stdin.flush()
            except BrokenPipeError:
                detail = JOB["log_path"].read_text(encoding="utf-8", errors="replace")[-2000:]
                close_job(remove=True)
                raise ValueError("FFmpeg 编码失败：" + detail)
            JOB["received"] += 1
            JOB["last_frame_digest"] = digest
            JOB["last_active"] = time.monotonic()
            return {"received": JOB["received"]}
        if route.path == "/api/export/finish":
            if JOB["received"] != JOB["frames"]:
                raise ValueError(f"帧数不完整：收到 {JOB['received']}，应为 {JOB['frames']}")
            JOB["process"].stdin.close()
            result = JOB["process"].wait(timeout=120)
            JOB["log"].close()
            if result != 0:
                detail = JOB["log_path"].read_text(encoding="utf-8", errors="replace")[-2000:]
                close_job(remove=True)
                raise ValueError("FFmpeg 编码失败：" + detail)
            output = JOB["output"].with_name(JOB["output"].name.replace(".partial", ""))
            JOB["output"].rename(output)
            export_format = JOB["request"]["format"]
            metadata = {**JOB["request"], "frames": JOB["frames"], "file": output.name,
                        "render_method": "逐帧PNG → FFmpeg " + ("ProRes 4444" if export_format == "prores" else "libx264"),
                        "extension": output.suffix, "alpha": export_format == "prores", "resolution": [1920, 1080]}
            output.with_suffix(".json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
            close_job()
            return {"file": output.name, "format": export_format, "path": str(output),
                    "url": "/api/export/file?name=" + output.name}
        if route.path == "/api/export/abort":
            close_job(remove=True)
            return {"aborted": True}
        raise ValueError("未知导出操作")

    def log_message(self, fmt, *args):
        if not self.path.startswith("/api/export/frame"):
            super().log_message(fmt, *args)


class LocalServer(ThreadingHTTPServer):
    allow_reuse_address = False


def main():
    parser = argparse.ArgumentParser(description="原神剧情身份牌本地工作台")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = LocalServer(("127.0.0.1", args.port), Handler)
    print(f"原神剧情身份牌工作台：http://127.0.0.1:{args.port}", flush=True)
    print("保持此窗口打开；按 Ctrl+C 停止。", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        close_job(remove=True)
        server.server_close()


if __name__ == "__main__":
    main()
