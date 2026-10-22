# Timescape

A p5.js exhibition installation: webcam hand tracking rotates a projected tesseract. Two hands control zoom and twist; holding a fist for three seconds records ten seconds of trails and downloads a PNG.

## Run locally, including offline

From this folder:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Open <http://127.0.0.1:8000> in a browser with WebGL and webcam support. Allow camera access. Use localhost or HTTPS; opening `index.html` directly as a file is unsupported. No build step or internet connection is needed: the libraries, fonts, and model weights are included.

Press **D** to show the operator display and model status. Press **S** to start a capture manually. Captures download through the browser; configure the download folder and allow repeated downloads on the exhibition computer. The artwork excludes the webcam feed and interface.

The snapshot number is remembered when browser storage is available. Otherwise numbering lasts only for the current page session; reloading may reuse filenames, so retain the browser's normal duplicate-file protection.

## Capture and animation

Canvas pixel density is fixed at 1. Capture covers twice the viewport dimensions, capped at a 3840-pixel longest edge and the graphics hardware's texture limit, preserving aspect ratio. At 16:9 the maximum capture is 3840×2160, around 32 MiB for its color buffer. Larger screens use the same capture budget; change `maxCaptureDimension` in `sketch.js` only after testing the target hardware.

Window and fullscreen resizes wait until capture and its exit fade have finished, preserving accumulated artwork. The scene keeps its previous dimensions during that transition. Animation and smoothing use elapsed time; motion after a suspended tab is capped to a 100 ms step. Capture timers use actual elapsed time.

Two hands keep their previous order using Left/Right labels; ambiguous labels fall back to matching the nearest previous wrists. Very fast crossings with ambiguous labels can still confuse identity and should be checked with the installation's lighting and camera position.

## Checks

With Node.js 18 or newer:

```sh
node --test tests/sketch.test.cjs
```

These checks cover continuous gesture holds, hand ordering, angle wrapping, storage and save failures, capture transitions, deferred resizing, frame-rate independence, and local asset completeness. Rendering calls are stubbed; they do not replace a webcam test.

Before an exhibition, launch with a fresh browser cache and internet disconnected, check one- and two-hand gestures, interrupt a fist hold, resize during capture, and save several images. Run a sustained session at the final projector resolution to check temperature, frame rate, and browser download permissions.

## Bundled assets

- p5.js **1.11.11**: `vendor/p5-1.11.11.min.js`, from the npm distribution via jsDelivr. License: `vendor/p5-LICENSE.txt`.
- ml5.js **1.4.0**: `vendor/ml5-1.4.0.min.js`, from the npm distribution via unpkg. License: `vendor/ml5-LICENSE.md`. The distributed bundle retains its embedded dependency notices.
- MediaPipe Hands TensorFlow.js **full detector v1** and **full landmark v1**: `models/hand-detector/` and `models/hand-landmarks/`, from the official TensorFlow Hub endpoints. License: `models/LICENSE`.
- Rajdhani **v17**, weights 400, 600, and 700: local font files from Google Fonts. License: `vendor/rajdhani-LICENSE.txt`.

Exact source URLs and SHA-256 hashes are recorded in `assets.json`. Keep the complete `vendor/` and `models/` folders with the page when copying or hosting it.
