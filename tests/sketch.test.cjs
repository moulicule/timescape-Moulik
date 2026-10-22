const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'sketch.js'), 'utf8');

function sketch({ stored = null, storageFails = false, saveFails = false } = {}) {
  const calls = { saves: [], resizes: [], artResizes: [], clears: 0, storage: [] };
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, Math, Promise,
    now: 0, deltaTime: 1000 / 60, width: 1920, height: 1080,
    windowWidth: 1920, windowHeight: 1080, WEBGL: 'webgl', HSB: 'hsb', PI: Math.PI,
    min: Math.min, tan: Math.tan, atan2: Math.atan2,
    lerp: (a, b, t) => a + (b - a) * t,
    constrain: (v, a, b) => Math.max(a, Math.min(b, v)),
    dist: (x, y, a, b) => Math.hypot(x - a, y - b),
    map(v, a, b, x, y, clamp = false) {
      let t = (v - a) / (b - a);
      if (clamp) t = Math.max(0, Math.min(1, t));
      return x + t * (y - x);
    },
    millis: () => ctx.now,
    drawingContext: { DEPTH_BUFFER_BIT: 1, MAX_TEXTURE_SIZE: 2, clear() {}, getParameter: () => 8192 },
    localStorage: {
      getItem() { if (storageFails) throw new Error('Storage denied'); return stored; },
      setItem(key, value) { if (storageFails) throw new Error('Storage denied'); calls.storage.push([key, value]); }
    },
    resizeCanvas(w, h) { calls.resizes.push([w, h]); ctx.width = w; ctx.height = h; }
  };
  for (const fn of ['push', 'pop', 'background', 'translate', 'noStroke', 'fill', 'resetMatrix', 'camera', 'plane', 'image', 'tint', 'orbitControl']) ctx[fn] = () => {};
  ctx.art = {
    width: 3840, height: 2160,
    clear() { calls.clears++; },
    save(name) { calls.saves.push(name); if (saveFails) throw new Error('Save failed'); },
    resizeCanvas(w, h) { calls.artResizes.push([w, h]); this.width = w; this.height = h; }
  };
  vm.createContext(ctx);
  const run = code => vm.runInContext(code, ctx);
  run(source);
  // Keep the real state machine and interaction logic; replace only rendering.
  run('video = {width:1280,height:720}; artLayer = art; drawStars = () => {}; drawHands = () => {}; drawFistProgress = () => {}; drawTesseract = () => {}; updateHtmlUi = () => {}; frameSeconds = 1 / 60;');
  return { ctx, calls, run };
}

function hand(x, y = 100, handedness, fist = false) {
  const keypoints = Array.from({ length: 21 }, () => ({ x, y }));
  keypoints[0] = { x, y: y + 100 };
  for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) {
    keypoints[pip] = { x, y: y + 50 };
    keypoints[tip] = { x, y: fist ? y + 80 : y };
  }
  return { keypoints, handedness };
}

function detect(s, results) {
  s.ctx.results = results;
  s.run('gotHands(results); updateInteraction();');
}

test('a fist must be held continuously, including after tracking loss between draw frames', () => {
  const s = sketch();
  s.ctx.now = 100;
  detect(s, [hand(100, 100, 'Left', true)]);
  assert.equal(s.run('fistHoldStart'), 100);
  s.ctx.results = [];
  s.run('gotHands(results)');
  s.ctx.now = 5000;
  detect(s, [hand(100, 100, 'Left', true)]);
  assert.equal(s.run('snapshotState'), 0);
  s.ctx.now = 7999;
  s.run('updateInteraction()');
  assert.equal(s.run('snapshotState'), 0);
  s.ctx.now = 8000;
  s.run('updateInteraction()');
  assert.equal(s.run('snapshotState'), 1);
});

test('releasing the fist and receiving no hands reset the hold', () => {
  const s = sketch();
  s.ctx.now = 100;
  detect(s, [hand(100, 100, 'Left', true)]);
  detect(s, [hand(100)]);
  assert.equal(s.run('fistHoldStart'), null);
  s.run('fistHoldStart = 100; hands = []; updateInteraction()');
  assert.equal(s.run('fistHoldStart'), null);
  assert.equal(s.run('activeFistHand'), null);
});

test('a fist held starting at time zero still takes three seconds', () => {
  const s = sketch();
  s.run('snapshotCooldown = -1');
  detect(s, [hand(100, 100, 'Left', true)]);
  s.ctx.now = 2999;
  s.run('updateInteraction()');
  assert.equal(s.run('snapshotState'), 0);
  s.ctx.now = 3000;
  s.run('updateInteraction()');
  assert.equal(s.run('snapshotState'), 1);
});

test('two-hand rotation is unchanged by detection ordering, with or without labels', () => {
  for (const labelled of [false, true]) {
    const s = sketch();
    const a = hand(100, 100, labelled ? 'Left' : undefined);
    const b = hand(300, 100, labelled ? 'Right' : undefined);
    detect(s, [a, b]);
    detect(s, [b, a]);
    assert.equal(s.run('camRotZ'), 0);
    assert.equal(s.run('hands[0].keypoints[0].x'), 100);
  }
});

test('hand labels preserve identity when hands cross', () => {
  const s = sketch();
  detect(s, [hand(100, 100, 'Left'), hand(300, 100, 'Right')]);
  detect(s, [hand(100, 100, 'Right'), hand(300, 100, 'Left')]);
  assert.equal(s.run('hands[0].handedness'), 'Left');
  assert.equal(s.run('hands[0].keypoints[0].x'), 300);
});

test('rotation stays stable when ambiguous hand labels return', () => {
  const s = sketch();
  detect(s, [hand(100), hand(300)]);
  detect(s, [hand(300, 100, 'Left'), hand(100, 100, 'Right')]);
  assert.equal(s.run('camRotZ'), 0);
  detect(s, [hand(100, 100, 'Right'), hand(300, 100, 'Left')]);
  assert.equal(s.run('camRotZ'), 0);
});

test('rotation crosses the -pi/pi boundary by the shortest route', () => {
  const s = sketch();
  const angle = s.run('lerpAngle(Math.PI - 0.01, -Math.PI + 0.01, 0.5)');
  assert.ok(Math.abs(angle - Math.PI) < 1e-12);
});

test('storage read failures and malformed counters do not break setup', () => {
  for (const options of [{ storageFails: true }, { stored: 'garbage' }, { stored: '-3' }, { stored: '1.5' }, { stored: '12oops' }, { stored: '9007199254740991' }, { stored: '42' }]) {
    const s = sketch(options);
    s.ctx.pixelDensity = s.ctx.colorMode = () => {};
    s.ctx.createCanvas = () => {};
    s.ctx.createCapture = () => ({ hide() {} });
    s.ctx.ml5 = { handPose: () => ({ ready: new Promise(() => {}) }) };
    s.ctx.createGraphics = () => ({ ...s.ctx.art, pixelDensity() {}, colorMode() {} });
    s.ctx.select = () => ({});
    s.ctx.random = a => a;
    assert.doesNotThrow(() => s.run('setup()'));
    assert.equal(s.run('snapshotCounter'), options.stored === '42' ? 42 : 1);
  }
});

test('capture saves once and exits even when storage or saving throws', async () => {
  for (const options of [{}, { storageFails: true }, { saveFails: true }]) {
    const s = sketch(options);
    s.run('snapshotState = SNAPSHOT_ACTIVE; snapshotStart = 0');
    s.ctx.now = 10001;
    s.run('draw(); draw()');
    await Promise.resolve();
    assert.deepEqual(s.calls.saves, ['timescape_1001.png']);
    assert.equal(s.run('snapshotState'), 3);
    assert.equal(s.run('snapshotCounter'), 2);
    s.ctx.now = 12001;
    s.run('draw()');
    assert.equal(s.run('snapshotState'), 0);
  }
});

test('asynchronous save rejection reports failure without repeated downloads', async () => {
  const s = sketch();
  s.ctx.art.save = name => { s.calls.saves.push(name); return Promise.reject(new Error('Save failed')); };
  s.ctx.now = 10001;
  s.run('snapshotState = SNAPSHOT_ACTIVE; snapshotStart = 0; draw(); draw()');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.calls.saves.length, 1);
  assert.match(s.run('modelStatus'), /save failed/);
});

test('keyboard capture resets a partial fist hold and applies the same cooldown', () => {
  const s = sketch();
  s.ctx.now = 500;
  s.run("fistHoldStart = 100; key = 'S'; keyPressed()");
  assert.equal(s.run('snapshotState'), 1);
  assert.equal(s.run('fistHoldStart'), null);
  assert.equal(s.run('snapshotCooldown'), 16500);
  s.ctx.now = 1000;
  s.run('keyPressed()');
  assert.equal(s.run('transitionStart'), 500);
});

test('resize waits through entry, recording and exit, then uses the latest dimensions', () => {
  const s = sketch();
  s.run('startSnapshot()');
  s.ctx.windowWidth = 1600;
  s.ctx.windowHeight = 900;
  s.run('windowResized()');
  s.ctx.now = 1000;
  s.run('draw(); windowResized()');
  s.ctx.windowWidth = 2560;
  s.ctx.windowHeight = 1440;
  s.ctx.now = 11001;
  s.run('draw(); windowResized()');
  assert.deepEqual(s.calls.artResizes, []);
  assert.deepEqual(s.calls.resizes, []);
  s.ctx.now = 13001;
  s.run('draw()');
  assert.deepEqual(s.calls.resizes, [[2560, 1440]]);
  assert.deepEqual(s.calls.artResizes, [[3840, 2160]]);
  assert.equal(s.run('pendingResize'), false);
  assert.equal(s.run('captureScale'), 0.75);
});

test('capture dimensions preserve aspect ratio and respect hardware and memory limits', () => {
  const s = sketch();
  for (const [w, h] of [[1920, 1080], [3840, 2160], [1080, 1920], [7680, 4320]]) {
    const size = s.run(`getCaptureSize(${w}, ${h})`);
    assert.ok(size.width <= 3840 && size.height <= 3840);
    assert.ok(Math.abs(size.width / size.height - w / h) < 0.001);
  }
  s.ctx.drawingContext.getParameter = () => 2048;
  assert.equal(s.run('getCaptureSize(1920, 1080).width'), 2048);
});

test('15 and 60 fps produce the same rotation, smoothing and fade duration', () => {
  const simulations = [15, 60].map(fps => {
    const s = sketch();
    s.ctx.deltaTime = 1000 / fps;
    s.ctx.results = [hand(300, 200, 'Left'), hand(500, 200, 'Right')];
    s.run('gotHands(results)');
    for (let i = 0; i < fps; i++) { s.ctx.now = (i + 1) * 1000 / fps; s.run('draw()'); }
    const result = ['angle', 'animationTime', 'camRotX', 'camRotY', 'camRotZ', 'scaleFactor', 'handPresenceLevel'].map(name => s.run(name));
    s.run('gotHands([])');
    for (let i = 0; i < fps; i++) s.run('draw()');
    assert.equal(s.run('handPresenceLevel'), 0);
    return result;
  });
  simulations[0].forEach((v, i) => assert.ok(Math.abs(v - simulations[1][i]) < 1e-9));
});

test('offline assets are local, present, and include complete model weights', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  assert.doesNotMatch(html + css, /https?:\/\//);
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) assert.ok(fs.existsSync(path.join(root, match[1])), match[1]);
  for (const match of css.matchAll(/url\('([^']+)'\)/g)) assert.ok(fs.existsSync(path.join(root, match[1])), match[1]);
  const assets = JSON.parse(fs.readFileSync(path.join(root, 'assets.json'), 'utf8')).assets;
  for (const asset of assets) {
    const data = fs.readFileSync(path.join(root, asset.path));
    assert.equal(data.length, asset.bytes, asset.path);
    assert.equal(createHash('sha256').update(data).digest('hex'), asset.sha256, asset.path);
  }
  for (const model of ['hand-detector', 'hand-landmarks']) {
    const dir = path.join(root, 'models', model);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8'));
    for (const group of manifest.weightsManifest) {
      const actual = group.paths.reduce((size, file) => size + fs.statSync(path.join(dir, file)).size, 0);
      const expected = group.weights.reduce((size, weight) => {
        const dtype = weight.quantization?.dtype || weight.dtype;
        const bytes = { float32: 4, float16: 2, int32: 4, bool: 1, uint8: 1, uint16: 2 }[dtype];
        assert.ok(bytes, dtype);
        return size + weight.shape.reduce((a, b) => a * b, 1) * bytes;
      }, 0);
      assert.equal(actual, expected, model);
    }
  }
});
