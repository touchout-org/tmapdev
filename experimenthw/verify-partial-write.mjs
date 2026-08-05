// Verifies experimenthw's sendPartialRows() addressing against the ACTUAL
// vendored SDK algorithm (transcribed verbatim from the two relevant
// minified functions, not my own re-derivation of what they "should" do),
// by simulating per-line device buffers and confirming a partial write
// produces exactly the same final buffer state as a full-frame write would.
import { packPixelsToHex } from '../../dotpad-toolkit/graphics/packPixelsToHex.js';
import { drawCursorRing, drawLinePixels } from '../../dotpad-toolkit/graphics/rasterizer.js';

const numCols = 30, numRows = 10;
const displayW = numCols * 2, displayH = numRows * 4;

// ---- Transcribed verbatim from DotPadSDK-3.0.1.js (re-verified against
// 3.0.1's source when the vendored SDK was bumped from 3.0.0 -- this
// specific algorithm is byte-for-byte unchanged between the two versions)
// ----
// DotDevice.prototype.displayGraphicData(e,t=1,s=0,i=GraphicMode), renamed
// params: hex=e, startLine=t, startCellIndex=s.
function deviceDisplayGraphicData(lineBuffers, hex, startLine, startCellIndex) {
  const a = numCols; // this.#K
  const r = startCellIndex, o = startCellIndex + hex.length / 2;
  for (let i = startLine; i <= numRows; i++) {
    const h = i - 1;
    if (h < 0) continue;
    const c = h * a, l = c + a;
    const d = Math.max(c, r), u = Math.min(l, o);
    if (d >= u || l < r) continue;
    const f = 2 * (d - r), D = 2 * (u - d), m = hex.substring(f, f + D);
    const C = startLine === i ? startCellIndex : 0;
    setDotPadLineCommand(lineBuffers, i, C, m);
  }
}

// DotPadEngine.setDotPadLineCommand(e,t,s,i) — e=lineIndex, s=localCellOffset,
// i=hexForThatLine. Transcribed minus the "n"/mode-flag and compareString
// diffing (compareString finds the changed sub-range for the actual BLE
// packet; irrelevant to whether the final logical buffer ends up correct).
function setDotPadLineCommand(lineBuffers, lineIndex, localCellOffset, hexForLine) {
  const existing = lineBuffers[lineIndex];
  const merged = existing.substring(0, 2 * localCellOffset) + hexForLine
    + existing.substring(2 * localCellOffset + hexForLine.length);
  lineBuffers[lineIndex] = merged;
}

// Matches app.js's drawReferenceGrid -- included here so this proof covers
// the real case (static background content the cursor moves over), not
// just a blank field, since a blank field would trivially pass even if the
// addressing math were wrong about which rows are actually unchanged.
function drawReferenceGrid(pixels) {
  const cols = 6, rows = 4;
  for (let c = 0; c <= cols; c++) {
    const x = Math.min(displayW - 1, Math.round((c / cols) * (displayW - 1)));
    drawLinePixels(pixels, displayW, displayH, x, 0, x, displayH - 1);
  }
  for (let r = 0; r <= rows; r++) {
    const y = Math.min(displayH - 1, Math.round((r / rows) * (displayH - 1)));
    drawLinePixels(pixels, displayW, displayH, 0, y, displayW - 1, y);
  }
}

function buildPixels(cx, cy) {
  const pixels = new Uint8Array(displayW * displayH);
  drawReferenceGrid(pixels);
  drawCursorRing(pixels, displayW, displayH, cx, cy);
  return pixels;
}

function fullFrameLineBuffers(hexFull) {
  const buffers = {};
  for (let i = 1; i <= numRows; i++) {
    buffers[i] = hexFull.substring((i - 1) * displayW, i * displayW);
  }
  return buffers;
}

// ---- experimenthw's own sendPartialRows math ----
function partialWriteParams(prevCursorX, prevCursorY, cursorX, cursorY, hexFull) {
  const ringRowSpan = (cy) => [Math.max(0, cy - 1), Math.min(displayH - 1, cy + 2)];
  const [oldTop, oldBottom] = ringRowSpan(prevCursorY);
  const [newTop, newBottom] = ringRowSpan(cursorY);
  const minRow = Math.min(oldTop, newTop);
  const maxRow = Math.max(oldBottom, newBottom);
  const minBand = Math.floor(minRow / 4);
  const maxBand = Math.floor(maxRow / 4);
  const charsPerBand = displayW;
  const hexSlice = hexFull.substring(minBand * charsPerBand, (maxBand + 1) * charsPerBand);
  const startCellIndex = minBand * numCols;
  return { hexSlice, startCellIndex };
}

let failures = 0;
function check(label, actual, expected) {
  const pass = actual === expected;
  if (!pass) {
    failures++;
    console.log(`FAIL ${label}`);
    console.log('  actual:  ', actual);
    console.log('  expected:', expected);
  } else {
    console.log(`ok   ${label}`);
  }
}

const testMoves = [
  { from: [30, 20], to: [31, 20], label: 'single step right (same band)' },
  { from: [30, 20], to: [30, 21], label: 'single step down (same band)' },
  { from: [30, 3], to: [30, 4], label: 'step crossing a band boundary' },
  { from: [30, 0], to: [30, 39], label: 'large jump top to bottom' },
  { from: [0, 20], to: [59, 20], label: 'large jump left to right' },
  { from: [5, 5], to: [5, 5], label: 'no movement (degenerate)' },
];

for (const { from, to, label } of testMoves) {
  const pixelsOld = buildPixels(from[0], from[1]);
  const pixelsNew = buildPixels(to[0], to[1]);
  const hexOld = packPixelsToHex(pixelsOld, displayW, displayH, numRows);
  const hexNew = packPixelsToHex(pixelsNew, displayW, displayH, numRows);

  // Simulate: device starts showing the OLD frame (full write), then
  // receives ONLY the partial write for the move to the NEW position.
  const simulated = fullFrameLineBuffers(hexOld);
  const { hexSlice, startCellIndex } = partialWriteParams(from[0], from[1], to[0], to[1], hexNew);
  deviceDisplayGraphicData(simulated, hexSlice, 1, startCellIndex);

  const expected = fullFrameLineBuffers(hexNew);
  const simulatedFlat = Object.values(simulated).join('');
  const expectedFlat = Object.values(expected).join('');
  check(`${label}: partial write == full frame`, simulatedFlat, expectedFlat);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
