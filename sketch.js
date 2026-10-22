// A Tesseract in P5.js (4D to 3D Projection) - OPTIMIZED

let angle = 0;
let points = [];
const projected3D = Array.from({ length: 16 }, () => ({ x: 0, y: 0, z: 0 }));
const tesseractEdges = [];
const edgeHues = new Float64Array(16);
const edgeSaturations = new Float64Array(16);
const handFingers = [
  [0, 1, 2, 3, 4],
  [0, 5, 6, 7, 8],
  [0, 9, 10, 11, 12],
  [0, 13, 14, 15, 16],
  [0, 17, 18, 19, 20]
];
let video;
let handPose;
let hands = [];
let modelStatus = "Loading Model...";
// Snapshot States
const SNAPSHOT_IDLE = 0;
const SNAPSHOT_ENTERING = 1; // Fade out background
const SNAPSHOT_ACTIVE = 2;   // Recording
const SNAPSHOT_EXITING = 3;  // Fade out trails, fade in background

let stars = [];

let showDebug = false;
let snapshotState = SNAPSHOT_IDLE;
let snapshotStart = 0;
let transitionStart = 0;
let snapshotCooldown = 0; // Cooldown to prevent spamming snapshots
let fistHoldStart = null;
let activeFistHand = null; // Track which hand is holding the fist
let snapshotCounter = 1; // Persistent snapshot counter

let handPresenceLevel = 0; // 0-100, smooth fade based on hand tracking

let sceneOpacity = 100; // 0-100 (HSB Alpha)
let artLayer; // Off-screen buffer for clean snapshots

// UI Cache Variables (Optimization)
let uiHud, uiStatus, uiRec;
let prevStatus = "";

// Configuration
const distance = 2; // Distance of the "4D camera"
let scaleFactor = 150; // Size on screen
let prevScaleFactor = 150; // For warp calculation
const snapshotMultiplier = 2; // Capture 2x the screen size (for out-of-bounds trails)
const maxCaptureDimension = 3840;
let captureScale = 1;
let pendingResize = false;
let frameSeconds = 0;
let animationTime = 0;

// Interaction State (for smooth transitions)
let camRotX = 0;
let camRotY = 0;
let camRotZ = 0;

function setup() {
  pixelDensity(1);
  createCanvas(windowWidth, windowHeight, WEBGL);
  colorMode(HSB, 360, 100, 100, 100);
  scaleFactor = min(width, height) / 4;

  // Setup video and handPose
  // Request HD resolution (1280x720) or best available
  video = createCapture({
    audio: false,
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 }
    }
  });
  video.hide(); // Hide the default element so it doesn't show up at the bottom
  handPose = ml5.handPose({
    flipped: true,
    runtime: 'tfjs',
    modelType: 'full',
    detectorModelUrl: 'models/hand-detector/model.json',
    landmarkModelUrl: 'models/hand-landmarks/model.json'
  });
  handPose.ready.then(modelLoaded).catch(error => {
    modelStatus = 'Model failed to load. Reload to retry.';
    showDebug = true;
    console.error(error);
  });

  // Initialize off-screen buffer (Expanded Canvas)
  const captureSize = getCaptureSize(width, height);
  artLayer = createGraphics(captureSize.width, captureSize.height, WEBGL);
  artLayer.pixelDensity(1);
  captureScale = artLayer.width / (width * snapshotMultiplier);
  artLayer.colorMode(HSB, 360, 100, 100, 100);
  artLayer.clear();

  // --- OPTIMIZATION: Cache DOM Elements once ---
  uiHud = select('#hud');
  uiStatus = select('#model-status');
  uiRec = select('#recording-indicator');

  // Generate the 16 vertices of a hypercube
  for (let i = 0; i < 16; i++) {
    let x = (i & 1) ? 1 : -1;
    let y = (i & 2) ? 1 : -1;
    let z = (i & 4) ? 1 : -1;
    let w = (i & 8) ? 1 : -1;
    points.push({ x, y, z, w });
    for (let j = 0; j < 16; j++) {
      const diff = i ^ j;
      if (diff !== 0 && (diff & (diff - 1)) === 0) tesseractEdges.push([i, j]);
    }
  }

  // Generate Stars
  for (let i = 0; i < 200; i++) {
    stars.push({
      x: random(-width, width),
      y: random(-height, height),
      z: random(-1000, -500),
      brightness: random(100, 255)
    });
  }

  // Initialize Snapshot Counter from LocalStorage
  try {
    const storedCounter = Number(localStorage.getItem('timescape_snapshot_counter'));
    if (Number.isSafeInteger(storedCounter) && storedCounter > 0 && storedCounter <= Number.MAX_SAFE_INTEGER - 1001) {
      snapshotCounter = storedCounter;
    }
  } catch (error) {
    console.warn('Snapshot numbering will last for this session only.', error);
  }
}

function draw() {
  // Cap elapsed motion after a suspended tab; capture timers still use real time.
  frameSeconds = Math.min(Math.max(deltaTime, 0), 100) / 1000;
  animationTime += frameSeconds;
  if (hands.length > 0 || handPresenceLevel > 0.5) angle += 1.2 * frameSeconds;

  // --- STATE MACHINE UPDATE ---
  if (snapshotState === SNAPSHOT_ENTERING) {
    let elapsed = millis() - transitionStart;
    let duration = 1000;
    sceneOpacity = map(elapsed, 0, duration, 100, 0, true);

    if (elapsed >= duration) {
      snapshotState = SNAPSHOT_ACTIVE;
      snapshotStart = millis();
      artLayer.clear();
    }
  } else if (snapshotState === SNAPSHOT_EXITING) {
    let elapsed = millis() - transitionStart;
    let duration = 2000;
    sceneOpacity = map(elapsed, 0, duration, 0, 100, true);

    if (elapsed >= duration) {
      snapshotState = SNAPSHOT_IDLE;
      artLayer.clear();
      if (pendingResize) resizeScene();
    }
  } else if (snapshotState === SNAPSHOT_ACTIVE) {
    sceneOpacity = 0;
    let elapsed = millis() - snapshotStart;
    if (elapsed > 10000) {
      let filename = 'timescape_' + (1000 + snapshotCounter) + '.png';
      // Leave ACTIVE before saving so a failure cannot retry every frame.
      snapshotState = SNAPSHOT_EXITING;
      transitionStart = millis();
      try {
        Promise.resolve(artLayer.save(filename)).catch(snapshotSaveFailed);
      } catch (error) {
        snapshotSaveFailed(error);
      }
      snapshotCounter = snapshotCounter < Number.MAX_SAFE_INTEGER - 1001 ? snapshotCounter + 1 : 1;
      try {
        localStorage.setItem('timescape_snapshot_counter', String(snapshotCounter));
      } catch (error) {
        console.warn('Could not remember the snapshot number.', error);
      }
    }
  } else {
    sceneOpacity = 100;
  }

  // --- RENDERING ---

  // 1. Background / Clearing
  if (snapshotState === SNAPSHOT_ACTIVE || snapshotState === SNAPSHOT_ENTERING) {
    background(0);
  } else {
    push();
    translate(0, 0, 0);
    noStroke();
    fill(0, 0, 0, 100 * smoothing(0.1));
    resetMatrix();
    camera(0, 0, (height / 2.0) / tan(PI * 30.0 / 180.0), 0, 0, 0, 0, 1, 0);
    plane(width * 2, height * 2);
    pop();
  }

  drawingContext.clear(drawingContext.DEPTH_BUFFER_BIT);

  // 2. Draw Snapshot Art Layer
  if (snapshotState === SNAPSHOT_ACTIVE) {
    if (hands.length > 0) {
      drawTesseract(artLayer);
    }
    push();
    resetMatrix();
    // Draw the expanded artLayer centered on the screen
    // We offset by negative half width/height of the LAYER, not the screen
    image(artLayer, -width * snapshotMultiplier / 2, -height * snapshotMultiplier / 2, width * snapshotMultiplier, height * snapshotMultiplier);
    pop();
  } else if (snapshotState === SNAPSHOT_EXITING) {
    let artAlpha = map(sceneOpacity, 0, 100, 100, 0);
    push();
    resetMatrix();
    tint(255, artAlpha);
    image(artLayer, -width * snapshotMultiplier / 2, -height * snapshotMultiplier / 2, width * snapshotMultiplier, height * snapshotMultiplier);
    pop();
  }

  // 3. Draw Background Elements (Stars)
  let zoomSpeed = frameSeconds > 0 ? (scaleFactor - prevScaleFactor) / (frameSeconds * 60) : 0;
  prevScaleFactor = scaleFactor;

  if (sceneOpacity > 0) {
    drawStars(sceneOpacity, zoomSpeed);
  }

  // 4. Interaction & Hands
  updateInteraction();

  // Smooth Hand Presence Level
  // If hands detected, fade in fast. If lost, fade out slow.
  let targetPresence = (hands.length > 0) ? 100 : 0;
  if (targetPresence > handPresenceLevel) {
    handPresenceLevel = lerp(handPresenceLevel, targetPresence, smoothing(0.2));
  } else {
    handPresenceLevel -= 120 * frameSeconds;
  }
  handPresenceLevel = constrain(handPresenceLevel, 0, 100);

  // Combined Opacity for Draw
  // sceneOpacity handles Snapshot transitions. handPresenceLevel handles tracking loss.
  let finalOpacity = (sceneOpacity / 100) * (handPresenceLevel / 100) * 100;

  if (finalOpacity > 0.5) {
    if (hands.length > 0) {
      drawHands(finalOpacity);
      // Draw Progress Circle only if actively holding fist and hands are tracked
      if (fistHoldStart !== null && activeFistHand) {
        drawFistProgress(activeFistHand);
      }
    }
  }

  // 5. Draw Tesseract (Live View)
  if (snapshotState !== SNAPSHOT_ACTIVE) {
    if (finalOpacity > 0.5) {
      drawingContext.clear(drawingContext.DEPTH_BUFFER_BIT);
      drawTesseract(null, finalOpacity);
    }
  }

  // Only allow Orbit Control if completely idle and fully faded out
  // This prevents the camera from snapping back to mouse control while fading out
  if (snapshotState === SNAPSHOT_IDLE && hands.length === 0 && handPresenceLevel <= 0.5) {
    orbitControl();
  }

  // --- HTML UI UPDATE (Optimized) ---
  updateHtmlUi();
}

function updateHtmlUi() {
  // 1. Toggle HUD visibility (Only update class if changed)
  if (showDebug && uiHud.hasClass('hidden')) {
    uiHud.removeClass('hidden');
  } else if (!showDebug && !uiHud.hasClass('hidden')) {
    uiHud.addClass('hidden');
  }

  // 2. Update Status Text (Only if text changed)
  if (modelStatus !== prevStatus) {
    uiStatus.html(modelStatus);
    prevStatus = modelStatus;
  }

  // 3. Update Recording Indicator
  if (snapshotState === SNAPSHOT_ACTIVE) {
    if (uiRec.hasClass('hidden')) uiRec.removeClass('hidden');
  } else {
    if (!uiRec.hasClass('hidden')) uiRec.addClass('hidden');
  }
}

function drawStars(opacity, zoomSpeed) {
  push();
  const warping = abs(zoomSpeed) > 0.5;
  const streakLen = zoomSpeed * 10;

  // --- OPTIMIZATION: Limited Neighbor Check ---
  strokeWeight(1);

  // Use squared distance threshold to avoid sqrt() (150 * 150 = 22500)
  const distThresholdSq = 22500;

  for (let i = 0; i < stars.length; i++) {
    let s1 = stars[i];

    // Update Z based on Warp
    s1.z += zoomSpeed * 4 * frameSeconds * 60;
    if (s1.z > 0) s1.z = -1000;
    if (s1.z < -1000) s1.z = 0;

    // OPTIMIZATION: Only check next 5 stars, not ALL stars
    let checkLimit = min(i + 6, stars.length);

    for (let j = i + 1; j < checkLimit; j++) {
      let s2 = stars[j];

      // Manual distance squared calculation
      let dSq = (s1.x - s2.x) ** 2 + (s1.y - s2.y) ** 2 + (s1.z - s2.z) ** 2;

      if (dSq < distThresholdSq) {
        let d = Math.sqrt(dSq); // Only calc sqrt if we draw
        let flicker = random(0.5, 1);
        let lineAlpha = map(d, 0, 150, 50, 0) * (opacity / 100) * flicker;
        stroke(200, 50, 100, lineAlpha);
        line(s1.x, s1.y, s1.z, s2.x, s2.y, s2.z);
      }
    }

    // Draw Stars
    let b = s1.brightness + random(-20, 20);
    let finalB = map(b, 0, 255, 0, 100);
    // Preserve the first connection's width, then reuse the star stroke width.
    if (i === 0) strokeWeight(warping ? 2 : 3);

    // Hyperspace Warp vs Static Point
    if (warping) {
      // Keep line for warp effect
      stroke(finalB, opacity);
      line(s1.x, s1.y, s1.z, s1.x, s1.y, s1.z - streakLen);
    } else {
      // OPTIMIZATION: Use point() instead of sphere()
      stroke(finalB, opacity);
      point(s1.x, s1.y, s1.z);
    }
  }
  pop();
}

function smoothing(amount) {
  return 1 - Math.pow(1 - amount, frameSeconds * 60);
}

function snapshotSaveFailed(error) {
  modelStatus = 'Snapshot save failed. Check browser downloads.';
  showDebug = true;
  console.error(error);
}

function lerpAngle(current, target, amount) {
  const difference = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + difference * amount;
}

function startSnapshot() {
  if (snapshotState !== SNAPSHOT_IDLE) return;
  snapshotState = SNAPSHOT_ENTERING;
  transitionStart = millis();
  snapshotCooldown = millis() + 16000; // 1s entry, 10s capture, 2s exit, 3s buffer.
  fistHoldStart = null;
  activeFistHand = null;
}

function updateInteraction() {
  let targetRotX = 0;
  let targetRotY = 0;
  let targetRotZ = 0;

  if (hands.length > 0) {
    let sumX = 0;
    let sumY = 0;
    for (let hand of hands) {
      let indexTip = hand.keypoints[8];
      sumX += indexTip.x;
      sumY += indexTip.y;
    }
    let centerX = sumX / hands.length;
    let centerY = sumY / hands.length;

    targetRotY = map(centerX, 0, video.width, -PI, PI);
    targetRotX = map(centerY, 0, video.height, -PI, PI);

    if (hands.length >= 2) {
      let h1 = hands[0].keypoints[8];
      let h2 = hands[1].keypoints[8];
      let d = dist(h1.x, h1.y, h2.x, h2.y);
      scaleFactor = lerp(scaleFactor, d, smoothing(0.1));
      let angleBetween = atan2(h2.y - h1.y, h2.x - h1.x);
      targetRotZ = angleBetween;
    }

    camRotX = lerpAngle(camRotX, targetRotX, smoothing(0.1));
    camRotY = lerpAngle(camRotY, targetRotY, smoothing(0.1));
    camRotZ = lerpAngle(camRotZ, targetRotZ, smoothing(0.1));

    // 3. GESTURE DETECTION (Snapshot Trigger)
    // Check if cooldown has passed
    if (snapshotState === SNAPSHOT_IDLE && millis() > snapshotCooldown) {
      activeFistHand = hands.find(detectFist) || null;

      if (activeFistHand) {
        if (fistHoldStart === null) {
          fistHoldStart = millis();
        }
        if (millis() - fistHoldStart >= 3000) {
          startSnapshot();
        }
      } else {
        fistHoldStart = null;
        activeFistHand = null;
      }
    } else {
      fistHoldStart = null;
      activeFistHand = null;
    }
  } else {
    fistHoldStart = null;
    activeFistHand = null;
  }
}

// Helper: Detect if hand is making a fist
function detectFist(hand) {
  let fingersConfimed = 0;

  // Check index (8), middle (12), ring (16), pinky (20)
  // Compare Tip to Palm distance vs PIP to Palm distance
  // Index: Tip 8, PIP 6. Palm is 0.
  // Middle: Tip 12, PIP 10
  // Ring: Tip 16, PIP 14
  // Pinky: Tip 20, PIP 18

  let palm = hand.keypoints[0];

  // Indices of Tips and PIPs
  const fingerIndices = [
    { tip: 8, pip: 6 },
    { tip: 12, pip: 10 },
    { tip: 16, pip: 14 },
    { tip: 20, pip: 18 }
  ];

  for (let f of fingerIndices) {
    let t = hand.keypoints[f.tip];
    let p = hand.keypoints[f.pip];

    let dTip = dist(t.x, t.y, palm.x, palm.y);
    let dPip = dist(p.x, p.y, palm.x, palm.y);

    // If Tip is closer to palm than PIP, finger is likely curled
    if (dTip < dPip) {
      fingersConfimed++;
    }
  }

  // If 3 or more fingers are curled, it's a fist
  return fingersConfimed >= 3;
}

function drawHands(opacity) {
  for (let hand of hands) {
    drawNeonHand(hand, opacity);
  }
}

function drawFistProgress(hand) {
  let wrist = hand.keypoints[0];
  let middleMCP = hand.keypoints[9];

  // Center of palm
  let cx = (wrist.x + middleMCP.x) / 2;
  let cy = (wrist.y + middleMCP.y) / 2;

  // Map to screen coords
  let wx = map(cx, 0, video.width, -width / 2, width / 2);
  let wy = map(cy, 0, video.height, -height / 2, height / 2);

  let progress = map(millis() - fistHoldStart, 0, 3000, 0, 1, true);

  push();
  translate(wx, wy, -50); // At palm depth

  // Draw Constellation Ring
  let radius = 120;
  let starCount = 12;
  let angleStep = TWO_PI / starCount;

  // Rotate the whole ring slowly

  strokeWeight(2);

  // Draw Stars
  for (let i = 0; i < starCount; i++) {
    let a = i * angleStep;
    let sx = cos(a) * radius;
    let sy = sin(a) * radius;

    stroke(0, 0, 100); // White
    fill(0, 0, 100);   // White

    // Pulse effect
    let sSize = 4 + sin(animationTime * 12 + i) * 2;
    circle(sx, sy, sSize);
  }

  // Draw Connecting Lines (Progress Bar) - Polygonal
  if (progress > 0) {
    stroke(200, 80, 100); // Blue
    strokeWeight(2);      // Thinner
    noFill();

    beginShape();

    // We want straight lines between stars.
    // Progress goes from 0 to 1.
    // Total segments = starCount.

    let totalSegments = starCount;
    let currentStep = progress * totalSegments;
    let fullSegments = Math.floor(currentStep);
    let partialStep = currentStep - fullSegments;

    // Draw full segments (Star to Star)
    for (let i = 0; i <= fullSegments; i++) {
      // If we are at the very end (progress=1), cap index
      let idx = min(i, starCount);
      let a = idx * angleStep;
      vertex(cos(a) * radius, sin(a) * radius);
    }

    // Draw partial segment (from last star to interpolated point on line to next star)
    if (progress < 1.0) {
      let startIdx = fullSegments;
      let endIdx = (fullSegments + 1); // Wrapping handled by logic if needed, but here a circle usually implies loop or end. 
      // Current logic is 0..TWO_PI. 

      let a1 = startIdx * angleStep;
      let a2 = endIdx * angleStep;

      let x1 = cos(a1) * radius;
      let y1 = sin(a1) * radius;
      let x2 = cos(a2) * radius;
      let y2 = sin(a2) * radius;

      let tipX = lerp(x1, x2, partialStep);
      let tipY = lerp(y1, y2, partialStep);

      vertex(tipX, tipY);
    }

    endShape();
  }

  pop();
}

function drawTesseract(pg, opacity = 100) {
  let ctx = pg ? pg : window;

  ctx.push();
  // --- METALLIC LIGHTING ---
  // Soft ambient light to ensure visibility
  ctx.ambientLight(60);
  // Bright white point light from the "front-right"
  ctx.pointLight(0, 0, 100, 200, -200, 500);
  // Blueish rim light from "back-left"
  ctx.pointLight(200, 30, 80, -200, 200, -200);

  ctx.rotateX(camRotX);
  ctx.rotateY(camRotY);
  ctx.rotateZ(camRotZ);
  if (pg) ctx.scale(captureScale);

  const sinZW = Math.sin(angle);
  const cosZW = Math.cos(angle);
  const sinXY = Math.sin(angle * 0.5);
  const cosXY = Math.cos(angle * 0.5);

  ctx.noStroke();
  if (opacity < 100) {
    ctx.fill(200, 10, 80, opacity);
  } else {
    ctx.specularMaterial(200, 10, 80);
    ctx.shininess(50);
  }

  for (let i = 0; i < points.length; i++) {
    const v = points[i];
    const rotatedZ = v.z * cosZW - v.w * sinZW;
    const rotatedW = v.z * sinZW + v.w * cosZW;
    const projectionScale = scaleFactor / (distance - rotatedW);
    const p = projected3D[i];
    p.x = (v.x * cosXY - v.y * sinXY) * projectionScale;
    p.y = (v.x * sinXY + v.y * cosXY) * projectionScale;
    p.z = rotatedZ * projectionScale;
    edgeHues[i] = 240 + 50 * Math.sin(animationTime * 1.2 + i * 0.5);
    edgeSaturations[i] = 90 + 10 * Math.cos(animationTime * 1.8 + i);

    ctx.push();
    ctx.translate(p.x, p.y, p.z);
    ctx.sphere(6);
    ctx.pop();
  }

  ctx.strokeWeight(1);
  ctx.noFill();
  ctx.beginShape(LINES);
  // Keep both color directions and their order: they also affect translucent trails.
  for (const [i, j] of tesseractEdges) {
    const a = projected3D[i];
    const b = projected3D[j];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    let ox = -dz, oy = 0, oz = dx;
    if (ox * ox + oz * oz < 0.001) {
      ox = dy; oy = -dx; oz = 0;
    }
    const offsetScale = 4 / (Math.hypot(ox, oy, oz) || 1);
    ox *= offsetScale; oy *= offsetScale; oz *= offsetScale;
    ctx.stroke(edgeHues[i], edgeSaturations[j], 100, opacity);
    ctx.vertex(a.x + ox, a.y + oy, a.z + oz);
    ctx.vertex(b.x + ox, b.y + oy, b.z + oz);
    ctx.vertex(a.x - ox, a.y - oy, a.z - oz);
    ctx.vertex(b.x - ox, b.y - oy, b.z - oz);
  }
  ctx.endShape();
  ctx.pop();
}

function keyPressed() {
  if (key === 'd' || key === 'D') {
    showDebug = !showDebug;
  }
  if (key === 's' || key === 'S') {
    startSnapshot();
  }
}

function modelLoaded() {
  modelStatus = "Model Ready!";
  console.log("Model Loaded!");
  handPose.detectStart(video, gotHands);
}

function windowResized() {
  if (snapshotState !== SNAPSHOT_IDLE) {
    pendingResize = true;
    return;
  }
  resizeScene();
}

function getCaptureSize(viewWidth, viewHeight) {
  const limit = Math.min(maxCaptureDimension, drawingContext.getParameter(drawingContext.MAX_TEXTURE_SIZE));
  const ratio = Math.min(snapshotMultiplier, limit / Math.max(viewWidth, viewHeight));
  return { width: Math.max(1, Math.round(viewWidth * ratio)), height: Math.max(1, Math.round(viewHeight * ratio)) };
}

function resizeScene() {
  pendingResize = false;
  resizeCanvas(windowWidth, windowHeight);
  const captureSize = getCaptureSize(width, height);
  artLayer.resizeCanvas(captureSize.width, captureSize.height);
  captureScale = artLayer.width / (width * snapshotMultiplier);
  scaleFactor = min(width, height) / 4;
  prevScaleFactor = scaleFactor;
}

function gotHands(results) {
  const ordered = results.slice();
  if (ordered.length === 2) {
    if (hands.length === 2) {
      const distinctLabels = pair => pair[0].handedness && pair[1].handedness && pair[0].handedness !== pair[1].handedness;
      if (distinctLabels(ordered) && distinctLabels(hands) && ordered.some(hand => hand.handedness === hands[0].handedness)) {
        if (ordered[0].handedness !== hands[0].handedness) ordered.reverse();
      } else {
        // Match wrists when labels are ambiguous, preserving order as labels return.
        const distanceSq = (a, b) => (a.keypoints[0].x - b.keypoints[0].x) ** 2 + (a.keypoints[0].y - b.keypoints[0].y) ** 2;
        const same = distanceSq(ordered[0], hands[0]) + distanceSq(ordered[1], hands[1]);
        const swapped = distanceSq(ordered[0], hands[1]) + distanceSq(ordered[1], hands[0]);
        if (swapped < same) ordered.reverse();
      }
    } else {
      ordered.sort((a, b) => a.keypoints[0].x - b.keypoints[0].x);
    }
  }
  hands = ordered;
  if (hands.length === 0) {
    fistHoldStart = null;
    activeFistHand = null;
  }
}

function drawNeonHand(hand, opacity = 100) {
  const screenPoints = hand.keypoints.map(kp => ({
    x: kp.x / video.width * width - width / 2,
    y: kp.y / video.height * height - height / 2
  }));

  push();
  noFill();
  strokeCap(ROUND);
  strokeJoin(ROUND);

  let alphaScale = opacity / 100.0;

  strokeWeight(60);
  stroke(190, 100, 100, 1 * alphaScale);
  drawSkeleton(screenPoints);

  strokeWeight(40);
  stroke(190, 100, 100, 2 * alphaScale);
  drawSkeleton(screenPoints);

  strokeWeight(25);
  stroke(190, 100, 100, 4 * alphaScale);
  drawSkeleton(screenPoints);

  strokeWeight(14);
  stroke(190, 80, 100, 10 * alphaScale);
  drawSkeleton(screenPoints);

  strokeWeight(7);
  stroke(190, 0, 100, 20 * alphaScale);
  drawSkeleton(screenPoints);

  pop();
}



function drawSkeleton(screenPoints) {
  for (const finger of handFingers) {
    beginShape();
    for (const i of finger) {
      const kp = screenPoints[i];
      vertex(kp.x, kp.y, -50);
    }
    endShape();
  }
}
