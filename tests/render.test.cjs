const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function renderer() {
  const calls = { vertices: [], shapes: 0, spheres: 0, materials: 0, color: null };
  const ctx = {
    Math, console, LINES: 'lines', WEBGL: 'webgl', HSB: 'hsb', ROUND: 'round',
    windowWidth: 1920, windowHeight: 1080, width: 1920, height: 1080,
    min: Math.min, random: a => a,
    createCapture: () => ({ width: 1280, height: 720, hide() {} }),
    ml5: { handPose: () => ({ ready: new Promise(() => {}) }) },
    createGraphics: () => ({ width: 3840, height: 2160, pixelDensity() {}, colorMode() {}, clear() {} }),
    select: () => ({}), localStorage: { getItem: () => null },
    drawingContext: { MAX_TEXTURE_SIZE: 1, getParameter: () => 8192 },
    beginShape() { calls.shapes++; }, endShape() {},
    stroke(...args) { calls.color = args; },
    vertex(x, y, z) { calls.vertices.push({ point: [x, y, z], color: calls.color }); },
    sphere() { calls.spheres++; },
    specularMaterial() { calls.materials++; }
  };
  for (const name of ['pixelDensity', 'createCanvas', 'colorMode', 'push', 'pop', 'ambientLight', 'pointLight', 'rotateX', 'rotateY', 'rotateZ', 'scale', 'noStroke', 'fill', 'shininess', 'translate', 'strokeWeight', 'noFill', 'strokeCap', 'strokeJoin']) ctx[name] = () => {};
  ctx.window = ctx;
  vm.createContext(ctx);
  const run = code => vm.runInContext(code, ctx);
  run(fs.readFileSync(path.join(__dirname, '..', 'sketch.js'), 'utf8'));
  run('setup()');
  return { ctx, calls, run };
}

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}

// Independent plane rotations describe the artwork before batching.
function referenceVertices(angle, scale, time, opacity) {
  function rotate(point, a, b, theta) {
    const result = point.slice();
    result[a] = point[a] * Math.cos(theta) - point[b] * Math.sin(theta);
    result[b] = point[a] * Math.sin(theta) + point[b] * Math.cos(theta);
    return result;
  }
  const points = Array.from({ length: 16 }, (_, i) => {
    let p = [1, 2, 4, 8].map(bit => (i & bit) ? 1 : -1);
    p = rotate(rotate(p, 2, 3, angle), 0, 1, angle * 0.5);
    return p.slice(0, 3).map(v => v / (2 - p[3]) * scale);
  });
  const vertices = [];
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 16; j++) {
      if (i === j || ![1, 2, 4, 8].includes(i ^ j)) continue;
      const a = points[i], b = points[j];
      const [dx, dy, dz] = b.map((v, k) => v - a[k]);
      let offset = [-dz, 0, dx];
      if (offset[0] ** 2 + offset[2] ** 2 < 0.001) offset = [dy, -dx, 0];
      const length = Math.hypot(...offset) || 1;
      offset = offset.map(v => v / length * 4);
      const color = [190 + (Math.sin(time * 1.2 + i * 0.5) + 1) * 50, 80 + (Math.cos(time * 1.8 + j) + 1) * 10, 100, opacity];
      for (const sign of [1, -1]) {
        for (const p of [a, b]) vertices.push({ point: p.map((v, k) => v + sign * offset[k]), color });
      }
    }
  }
  return vertices;
}

test('one wireframe batch preserves both color directions, parallel offsets and transparency', () => {
  const r = renderer();
  for (const [angle, scale, opacity] of [[0, 150, 100], [0.3, 400, 40], [Math.PI / 4, 200, 100], [Math.PI / 2, 50, 0], [Math.PI, 350, 65]]) {
    r.calls.vertices.length = 0;
    r.calls.shapes = r.calls.spheres = r.calls.materials = 0;
    r.ctx.testAngle = angle; r.ctx.testScale = scale; r.ctx.testOpacity = opacity;
    r.run('angle = testAngle; scaleFactor = testScale; animationTime = 2.5; drawTesseract(null, testOpacity)');
    const expected = referenceVertices(angle, scale, 2.5, opacity);
    assert.equal(r.calls.shapes, 1);
    assert.equal(r.calls.spheres, 16);
    assert.equal(r.calls.materials, opacity === 100 ? 1 : 0);
    assert.equal(r.calls.vertices.length, 256);
    r.calls.vertices.forEach((actual, i) => {
      actual.point.forEach((v, k) => close(v, expected[i].point[k]));
      actual.color.forEach((v, k) => close(v, expected[i].color[k]));
    });
  }
});

test('projection objects are reused and capture uses the same geometry', () => {
  const r = renderer();
  const first = r.run('projected3D[0]');
  r.run('drawTesseract(null)');
  const live = r.calls.vertices.splice(0);
  let captureScale;
  const target = { ...r.ctx, scale: value => { captureScale = value; } };
  r.ctx.capture = target;
  r.run('captureScale = 0.5; drawTesseract(capture)');
  assert.strictEqual(r.run('projected3D[0]'), first);
  assert.equal(captureScale, 0.5);
  assert.deepEqual(r.calls.vertices, live);
});

test('hand glow maps each landmark once and preserves all five joined finger passes', () => {
  const r = renderer();
  let reads = 0;
  r.ctx.inputHand = { keypoints: Array.from({ length: 21 }, (_, i) => ({
    get x() { reads++; return 100 + i * 15; },
    get y() { reads++; return 200 + i * 10; }
  })) };
  r.run('drawNeonHand(inputHand, 80)');
  assert.equal(reads, 42);
  assert.equal(r.calls.shapes, 25);
  assert.equal(r.calls.vertices.length, 125);
  for (let pass = 0; pass < 5; pass++) {
    const indices = [0, 1, 2, 3, 4, 0, 5, 6, 7, 8, 0, 9, 10, 11, 12, 0, 13, 14, 15, 16, 0, 17, 18, 19, 20];
    indices.forEach((i, j) => {
      const vertex = r.calls.vertices[pass * 25 + j];
      close(vertex.point[0], (100 + i * 15) / 1280 * 1920 - 960);
      close(vertex.point[1], (200 + i * 10) / 720 * 1080 - 540);
      assert.equal(vertex.point[2], -50);
      close(vertex.color[3], [1, 2, 4, 10, 20][pass] * 0.8);
    });
  }
});

test('star points and warp streaks retain their brightness, positions and widths', () => {
  for (const speed of [0, 1.5]) {
    const r = renderer();
    const events = [];
    let weight, fills = 0, weightChanges = 0;
    r.ctx.abs = Math.abs;
    r.ctx.map = (v, a, b, x, y) => x + (v - a) / (b - a) * (y - x);
    r.ctx.random = (a, b) => (a + b) / 2;
    r.ctx.fill = () => { fills++; };
    r.ctx.strokeWeight = value => { weight = value; weightChanges++; };
    r.ctx.point = (...point) => events.push({ point, weight, color: r.calls.color });
    r.ctx.line = (...line) => events.push({ line, weight, color: r.calls.color });
    r.ctx.speed = speed;
    r.run('frameSeconds = 1 / 60; stars = [{x:1,y:2,z:-550,brightness:100},{x:10,y:5,z:-600,brightness:200}]; drawStars(75, speed)');
    assert.equal(events.length, 3);
    assert.equal(events[0].weight, 1); // Connection before the first star.
    assert.equal(fills, 0);
    assert.equal(weightChanges, 2);
    const offset = speed * 4;
    for (let i = 0; i < 2; i++) {
      const event = events[i + 1];
      assert.equal(event.weight, speed ? 2 : 3);
      close(event.color[0], [100, 200][i] / 255 * 100);
      assert.equal(event.color[1], 75);
      const origin = [i ? 10 : 1, i ? 5 : 2, (i ? -600 : -550) + offset];
      assert.deepEqual(speed ? event.line : event.point, speed ? [...origin, origin[0], origin[1], origin[2] - speed * 10] : origin);
    }
  }
});
