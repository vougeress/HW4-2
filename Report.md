# HW4 Task Report

# Team:
Nikita Tsukanov
Ekaterina Petrova

Roles & contributions:
- Nikita Tsukanov - wired the Gaussian splat loader/viewer and custom render loop, implemented canvas recording/MediaRecorder plus ffmpeg post-processing, co-authored the Playwright capture/export flow and precomputed path packaging, and prototyped dynamic path planning with obstacle avoidance.
- Ekaterina Petrova - built the single-page UI and controls (scene loader, status HUD, hotkeys), integrated autopilot playback and real-time preview safeguards, refined capture UX and documentation, owned the YOLOv8 object detection/export pipeline, co-authored the Playwright capture/export flow and precomputed path packaging, and prototyped dynamic path planning with obstacle avoidance.

**Completed tasks:** 1, 2, 4, 7, 8, 9, 10


## 1. Render a video from inside the scene

- Scene data arrives as Gaussian Splat .ply files (the SuperSplat-packed format). We fetch the file in the browser, pass its ArrayBuffer to GaussianSplats3D.PlyParser, and parse it into a splatBuffer that contains positions, colors, opacities, and covariance matrices for every splat.
- The viewer (from the gaussian-splats-3d library) wires that buffer into WebGL via Three.js. The renderer keeps a SharedArrayBuffer-backed sorting worker that orders splats per frame so front-to-back blending works, then runs the fast Gaussian rasterizer shader to draw millions of splats in a single pass. Cross-origin isolation (COOP/COEP) is enforced to allow SharedArrayBuffer; the UI displays an error if the viewer is launched from file:// without those headers.
- Camera transforms come from either live input (WASD+QE, mouse orbit) or the autopilot path player: we update viewer.controls each frame, call viewer.updateView to refresh matrices, and render the splats from that viewpoint. Keyboard handling lives in `src/main.js` (`updateKeyboard`, `updateFlythrough`), and the application runs its own `requestAnimationFrame` loop so we can interleave custom control logic ahead of `viewer.update()`/`viewer.render()`.
- For video capture, we tap the already-rendered WebGL canvas by calling `canvas.captureStream(30)` and feeding that stream into `MediaRecorder`. The recorder buffers encoded chunks (H.264 MP4 when available, VP9/WebM fallback) and on stop, we join the chunks, create a Blob URL, and auto-download the file (`capture.mp4`/`capture.webm`) without re-rendering or server work. Keyboard shortcuts (`Shift+R`/`Shift+S`) delegate to the same `startRecording`/`stopRecording` helpers the UI buttons call, guaranteeing consistent capture parameters.

So, the pipeline is: .ply -> parsed splat buffer -> GPU splat renderer (with per-frame sort) -> camera-driven framebuffer -> MediaRecorder capture for videos.


## 2. Detect objects in the rendered video 
- After recording capture.mp4 (or final.mp4 from the Playwright scripts), we feed that file into detect-video.py.
- The script loads Ultralytics YOLOv8 (from `ultralytics import YOLO`), runs `model.predict(source=video, conf=..., save=True, name="_yolo_tmp")`, and lets YOLO generate an annotated video in `runs/detect/_yolo_tmp`. The helper `find_latest_output` scans that directory for the newest encoded video in case YOLO emits multiple formats.
- Once YOLO finishes, we grab the latest output, re-encode it with ffmpeg (libx264, specified FPS, optional slow-mo via `--slow/--reset-pts`) to produce detected.mp4. Re-encoding always normalizes to yuv420p pixel format for broad player compatibility and applies `setpts` so slow-motion exports keep correct timestamps.
- That file shows the original render with bounding boxes, class labels, and confidence overlays - i.e., object detection on the recorded scene. CLI arguments let us swap YOLO weights (e.g., `yolov8n.pt` vs `yolov8l.pt`) to trade accuracy for speed without touching the script.


## 4. Path planning

Path planning happens offline in plan-path.js:

- We load the converted public/ConferenceHall.ply, parse it with GaussianSplats3D.PlyParser, and sample positions (every SAMPLE_STEP=200 splats) after applying the same flip-Z orientation the viewer uses. Sampling reduces memory pressure from about 10M splats to about 50k points while preserving obstacle outlines.
- Those samples populate a 2D occupancy grid over XZ with `VOXEL=0.6` m bins: each splat marks its voxel (plus dilation cells) as blocked so walls/columns create obstacles. Start/end points are converted into grid cells with `grid.quantize`.
- Before searching, `clearCorridor` carves a loose tunnel along the straight line between start/end to reduce deadlocks inside narrow passages. We also unblock the start/end cells explicitly so the solver always has somewhere to stand.
- An A* search over the 4-neighborhood grid finds a collision-free sequence of cells up to `MAX_NODES=80000` expansions. We then map cells back to world coordinates (preserving the start height) and invert the orientation so the viewer can consume them, producing smooth camera motion even though the search happened in grid space.
- Finally, the path is serialized as [[x,y,z], ...] into public/ConferenceHall.path.json, which the viewer replays when you press F. The same planner can output alternative `.path.json` files by running `node plan-path.js sx sy sz ex ey ez`.

The voxel-grid A* in plan-path.js currently exists as an offline prototype: on the target device it is too heavy to run end-to-end, so we ship precomputed public/ConferenceHall.path.json instead. At runtime, src/main.js simply loads this precomputed path and plays it back when you press F.

## 6. Rendered video that covers most of the scene 
- We recorded a "panorama sweep" flight by replaying the full-length `public/ConferenceHall.path.json` autopilot inside the viewer and capturing it with `record-from-path.js`. That Playwright script launches Chromium at 1280x720, hides UI overlays via an injected stylesheet, waits for `window.__PRE_READY` before pressing `F`, and records a continuous 30 s canvas stream before exporting `final.mp4` with ffmpeg (`libx264 -crf 20 -pix_fmt yuv420p`).  
- The waypoint file was authored to snake through every corridor and balcony, so the resulting video visits all major areas in a single pass. Because the capture taps the WebGL canvas (Playwright `recordVideo` mirrors the same pixels), every splat rendered during that traversal is preserved frame-for-frame, and the exported MP4 is ready for the YOLO detection pipeline without additional transcoding.  

## 7. Obstacle avoidance

Obstacle avoidance is only partially implemented. Offline, plan-path.js marks occupied voxels in the grid and widens a corridor around the straight line between start and end, so the planned route would steer around walls and other obstacles. However, this system is also only a prototype and does not run end-to-end on the target device, so obstacle-aware paths are not actually generated in the shipped build. During interactive flight or manual control there is no online obstacle avoidance at all - the camera simply follows user input with no real-time collision checking.


## 8. Interactive demo 

The browser UI ships as a single-page control panel. Users land on a hero header with status HUD, pick a scene from a curated dropdown, or paste a custom `.ply`/URL into the adjacent input. Below that, helper text spells out camera mappings (mouse orbit + `W/A/S/D` + `Q/E` + `Shift` boost) and recording hotkeys.  
- Buttons wire into `src/main.js`: `Load scene` triggers `loadScene()` to fetch/parse splats, `Start/Stop recording` toggle `MediaRecorder`, and the viewer surface listens for hotkeys (`F` to replay precomputed paths, `1/2` to mark custom waypoints, `P` to log poses). Status messages (success/errors) stream into the top-right badge so testers know when fetch, sorting, or flight playback is ready. Shared state flags (`window.__FLYING`, `__CAM_READY`) let automation scripts interrogate the UI, and every control event funnels through a central `setStatus` helper so a single CSS class governs success/error coloring.


## 9. Real-time preview 
- Rendering runs under a custom `requestAnimationFrame` loop that computes per-frame `delta`, applies keyboard forces (`updateKeyboard`) and autopilot movement (`updateFlythrough`), waits for the SharedArrayBuffer sorter to finish, then calls `viewer.update()` + `viewer.render()` (`src/main.js:220-247`). Because we bypass the library's internal tick, every user gesture immediately updates the Gaussian splat camera/controls, and the loop can guard against missing buffers (no `splatMesh`/`sortWorker`) before issuing draw calls.
- Keyboard motion applies acceleration in camera space (`W/A/S/D` along forward/right, `Q/E` vertical) and lerps the controls target toward the direction of travel so the headset never drifts. Autopilot mode caches the initial pose, smoothly interpolates between waypoints at `flythrough.speed` meters per second, and restores the user pose once playback finishes, allowing seamless handoff between scripted and manual control.

## 10. Artistic/professional/high-quality videos
The viewer uses the basic Gaussian Splat renderer. There is a post-processing pipeline in record-and-export.js (camera-path stabilization, minterpolate to 60 fps, H.264 encoding) that produces a smoother and cleaner final clip, but no dedicated artistic grading, cinematic look, or realism-enhancing pass has been implemented.
