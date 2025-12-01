"""
YOLOv8 video detection (offline).

Usage:
  python3 detect-video.py input.mp4 --out detected.mp4 --model yolov8n.pt --conf 0.25 --fps 25 --slow 1.5

Notes:
  - Requires: pip install ultralytics ffmpeg
  - --fps sets target framerate for the final file
  - --slow >1 slows down playback by that factor (setpts=PTS*slow), use --reset-pts to force retime even if slow=1
"""

import argparse
import subprocess
from pathlib import Path
from typing import Optional

try:
  from ultralytics import YOLO
except ImportError:
  raise SystemExit("Ultralytics not installed. Run: pip install ultralytics")


def find_latest_output(runs_dir: Path) -> Optional[Path]:
  if not runs_dir.exists():
    return None
  candidates = sorted(
    [f for f in runs_dir.glob("**/*") if f.is_file() and f.suffix in {".mp4", ".avi", ".mov", ".mkv", ".webm"}],
    key=lambda p: p.stat().st_mtime,
    reverse=True,
  )
  return candidates[0] if candidates else None


def reencode(src: Path, dst: Path, fps: int, slow: float, reset_pts: bool):
  if slow <= 0:
    slow = 1.0
  setpts = f"setpts={slow}*PTS" if reset_pts or slow != 1.0 else "setpts=PTS"
  cmd = [
    "ffmpeg",
    "-y",
    "-i",
    str(src),
    "-vf",
    setpts,
    "-r",
    str(fps),
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    str(dst),
  ]
  subprocess.run(cmd, check=True)


def main():
  parser = argparse.ArgumentParser(description="Run YOLOv8 detection on a video file")
  parser.add_argument("input", help="Path to input video (mp4/webm/etc)")
  parser.add_argument("--out", default="detected.mp4", help="Output video path")
  parser.add_argument("--model", default="yolov8n.pt", help="YOLOv8 model path/name")
  parser.add_argument("--conf", type=float, default=0.25, help="Confidence threshold")
  parser.add_argument("--fps", type=int, default=25, help="Target FPS for output")
  parser.add_argument("--slow", type=float, default=1.0, help="Slowdown factor (>1 slows playback)")
  parser.add_argument("--reset-pts", action="store_true", help="Force re-time with setpts even if slow=1 (fix fast playback)")
  args = parser.parse_args()

  inp = Path(args.input)
  if not inp.exists():
    raise SystemExit(f"Input not found: {inp}")

  model = YOLO(args.model)
  # Ultralytics handles video writing internally.
  model.predict(source=str(inp), conf=args.conf, save=True, save_txt=False, name="_yolo_tmp")

  runs_dir = Path("runs/detect/_yolo_tmp")
  latest = find_latest_output(runs_dir)
  if not latest:
    raise SystemExit("Detection finished, but no output video found.")

  tmp_out = latest
  final_out = Path(args.out)
  try:
    reencode(tmp_out, final_out, fps=args.fps, slow=args.slow, reset_pts=args.reset_pts)
    print(f"Saved: {final_out} (fps={args.fps}, slow={args.slow}x)")
  except subprocess.CalledProcessError as e:
    raise SystemExit(f"ffmpeg failed: {e}")


if __name__ == "__main__":
  main()
