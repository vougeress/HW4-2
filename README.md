# HW4 Gaussian Splat Viewer

Simple viewer for Gaussian Splats scenes featuring:
- Playback of pre-baked routes (`*.path.json`), key `F`;
- Canvas recording without UI (MP4 if MediaRecorder supports H.264, otherwise WebM) via UI buttons or `Shift+R` / `Shift+S`;
- Offline object detection on recorded video via YOLOv8 (`detect-video.py`).

## Install
```bash
npm install
# for offline detection (Python):
pip install ultralytics
```

## Run
```bash
npm run preview -- --host --port 4173
# then open http://localhost:4173 in a browser
```

### Browser controls
- `Load scene` picks a PLY (e.g., `ConferenceHall.ply`, `outdoor-drone.ply`).
- Autopath: press `F` to play the `.path.json` with the same name.
- Camera: `W/A/S/D`, `Q/E` up/down, mouse orbit.
- Recording: `Start recording` / `Stop & download` (or `Shift+R` / `Shift+S`). UI is excluded from the video.

### Ready-made paths
- `public/ConferenceHall.path.json`
- `public/outdoor-drone.path.json` (loaded points for outdoor-drone).

## Offline detection on video
First record a video in the browser (`capture.mp4`/`final.mp4`). Then:
```bash
python3 detect-video.py final.mp4 --out detected.mp4 --model yolov8n.pt --conf 0.25 --fps 25 --slow 1.5 --reset-pts
```
- `--slow >1` slows playback.
- `--fps` sets target FPS.
- `--reset-pts` forces correct timing if the source plays too fast.

Requires ffmpeg available in PATH.

## Convert PLY → splat
```bash
npm run convert -- input-data/<file>.ply public/<file>.ply -w
```

## Notes
- Built with Vite; sources live in `src/`, scene data in `public/`.
- If MediaRecorder does not support H.264, recording will be WebM.
