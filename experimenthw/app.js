// experimenthw — a minimal Dot Pad app for isolating why the display gets
// "confused and sluggish" under rapid cursoring. No map, no pan/zoom: a
// single cursor ring on a fixed 60x40 tactile grid, moved by the arrow keys
// or the Dot Pad's own cursor dots. Everything else on the page is a set of
// switchable strategies for how a cursor move gets turned into a BLE write,
// plus a live stats readout, so those strategies can be A/B tested against
// real hardware.
//
// Built on dotpad-toolkit (../../dotpad-toolkit/) rather than duplicating
// DotTMAP's own copies of this logic — see that repo's README for the
// module index and the encoding/dimension gotchas already documented there.
import { DotPadSDK, DotPadScanner, DisplayMode, DataCodes } from '../../dotpad-toolkit/vendor/web-sdk-3.0.1/DotPadSDK-3.0.1.js';
import { connectDotPad, disconnectDotPad, watchDotPad } from '../../dotpad-toolkit/device/connection.js';
import { sendTextToDevice, truncateMessage } from '../../dotpad-toolkit/device/messageDisplay.js';
import { sendGraphicToDevice, graphicsDimensions } from '../../dotpad-toolkit/device/graphicsDisplay.js';
import { packPixelsToHex } from '../../dotpad-toolkit/graphics/packPixelsToHex.js';
import { drawCursorRing, drawLinePixels } from '../../dotpad-toolkit/graphics/rasterizer.js';
import { CURSOR_DOT, labelToByte6 } from '../../dotpad-toolkit/device/keys.js';

const sdk = new DotPadSDK();
const scanner = new DotPadScanner();
let currentDevice = null;

// § Browser check — same detection DotTMAP uses (Web Bluetooth/Dot Pad
// connectivity is Chromium-only).
function isChrome() {
  const ua = navigator.userAgent;
  return /Chrome\//.test(ua) && !/Edg\//.test(ua) && !/OPR\//.test(ua);
}
if (!isChrome()) {
  document.getElementById('browser-warning').hidden = false;
}

// No pan/zoom: the app's coordinate space is always 1:1 with the physical
// display. 60x40 is the standard grid (numberCellColumns=30,
// numberCellRows=10); read the real values from the device on connect
// rather than hardcoding, per dotpad-toolkit's own guidance, but nothing
// here needs to handle a different-sized display gracefully beyond that.
let displayW = 60;
let displayH = 40;
let cursorX = Math.floor(displayW / 2);
let cursorY = Math.floor(displayH / 2);
// Position as of the last frame actually written to the device -- distinct
// from cursorX/Y (the latest desired position) whenever sends are being
// coalesced. The partial-rows strategy needs both: it has to know what's
// really on the display right now, not just where the cursor logically is.
let prevCursorX = cursorX;
let prevCursorY = cursorY;

// ---- DOM ----
const btnConnect = document.getElementById('btn-connect');
const btnDisconnect = document.getElementById('btn-disconnect');
const messageEl = document.getElementById('message');
const statPosition = document.getElementById('stat-position');
const statKeydowns = document.getElementById('stat-keydowns');
const statSends = document.getElementById('stat-sends');
const statCoalesced = document.getElementById('stat-coalesced');
const statPayloadSize = document.getElementById('stat-payload-size');
const statGap = document.getElementById('stat-gap');
const btnResetStats = document.getElementById('btn-reset-stats');
const inputInterval = document.getElementById('input-interval');
const chkCoalesce = document.getElementById('chk-coalesce');
const inputAccelTiming = document.getElementById('input-accel-timing-threshold');
const inputAccelCount = document.getElementById('input-accel-count-threshold');
const inputAccelFactor = document.getElementById('input-accel-factor');
const inputAccelTimeout = document.getElementById('input-accel-timeout');

function currentPayloadStrategy() {
  return document.querySelector('input[name="payload-strategy"]:checked').value;
}

// § Message display — mirrors to the Dot Pad's message line, single source
// of truth for anything announced, same pattern as DotTMAP's setMessage
// (clear-then-reflow so a screen reader treats each update as a fresh
// assertive announcement rather than coalescing successive ones).
function setMessage(text) {
  messageEl.textContent = '';
  void messageEl.offsetHeight;
  messageEl.textContent = text;
  if (currentDevice) {
    const numCells = currentDevice.numberBrailleCellColumns;
    sendTextToDevice(sdk, DisplayMode, currentDevice, truncateMessage(text, numCells));
  }
}

// ---- Stats ----
let stats = { keydowns: 0, sends: 0, coalesced: 0, lastPayloadChars: null, lastGap: null };
function renderStats() {
  statPosition.textContent = `row ${cursorY}, col ${cursorX}`;
  statKeydowns.textContent = stats.keydowns;
  statSends.textContent = stats.sends;
  statCoalesced.textContent = stats.coalesced;
  statPayloadSize.textContent = stats.lastPayloadChars === null ? '—' : stats.lastPayloadChars;
  statGap.textContent = stats.lastGap === null ? '—' : stats.lastGap.toFixed(1);
}
btnResetStats.addEventListener('click', () => {
  stats = { keydowns: 0, sends: 0, coalesced: 0, lastPayloadChars: null, lastGap: null };
  renderStats();
});

// ---- Building a frame ----
// Same reference grid DotTMAP draws on initial connect, before a real map
// is loaded (see rasterizeTestGrid/sendTestGridToDevice in tmap/app.js) --
// added here purely so the display has realistic static content for the
// cursor to move over, rather than a blank field, while testing send
// strategies. Being static, it never changes between frames -- only the
// cursor ring's own row-span does, so it doesn't affect the partial-rows
// strategy's change-detection below (see sendPartialRows).
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

function buildPixels() {
  const pixels = new Uint8Array(displayW * displayH);
  if (!accelActive) drawReferenceGrid(pixels);
  drawCursorRing(pixels, displayW, displayH, cursorX, cursorY);
  return pixels;
}

function fullFrameHexChars() {
  return currentDevice.numberCellColumns * currentDevice.numberCellRows * 2;
}

// Strategy: single full-frame write, skipping the redundant zero-clear pass
// that dotpad-toolkit's own sendGraphicToDevice always does first.
function sendSingleFrame(pixels) {
  const numRows = currentDevice.numberCellRows;
  const hex = packPixelsToHex(pixels, displayW, displayH, numRows);
  sdk.displayGraphicData(hex, currentDevice, DisplayMode.GraphicMode);
  return hex.length;
}

// Strategy: only rewrite the cell-ROWS the cursor ring actually touched
// (its old position through its new one), not the whole 60x40 frame.
//
// This calls the connected DotDevice's own displayGraphicData(hex,
// startLine, startCellIndex, mode) directly, bypassing
// DotPadSDK.displayGraphicData()'s public wrapper -- that wrapper always
// forwards to the device with startLine=1/startCellIndex=0, i.e. it can
// only ever do a full-frame write (see DotPadSDK-3.0.1.js). The device's
// own method does support a sub-range: startLine is a 1-indexed cell-row,
// and startCellIndex/hex-length together address a flat, row-major CELL
// range (2 hex chars per cell -- NOT the dot/nibble addressing
// packPixelsToHex itself uses internally). This was worked out by reading
// the vendored SDK source directly; it isn't documented anywhere and isn't
// exercised by dotpad-toolkit's own graphicsDisplay.js, so treat it as an
// unsupported technique that needs re-checking against any future SDK
// version, not an assumed-stable API.
//
// Only restricts by row band, not column -- still sends full display-width
// rows, just fewer of them. A simpler, safer partial update than a full 2D
// bounding box, and already a large reduction for typical single-step
// cursor moves.
function sendPartialRows(pixels) {
  const numCols = currentDevice.numberCellColumns;
  const numRows = currentDevice.numberCellRows;
  const hexFull = packPixelsToHex(pixels, displayW, displayH, numRows);

  const ringRowSpan = (cy) => [Math.max(0, cy - 1), Math.min(displayH - 1, cy + 2)];
  const [oldTop, oldBottom] = ringRowSpan(prevCursorY);
  const [newTop, newBottom] = ringRowSpan(cursorY);
  const minRow = Math.min(oldTop, newTop);
  const maxRow = Math.max(oldBottom, newBottom);
  const minBand = Math.floor(minRow / 4);
  const maxBand = Math.floor(maxRow / 4);

  const charsPerBand = displayW; // packPixelsToHex: 1 hex char per nibble, displayW nibbles/band
  const hexSlice = hexFull.substring(minBand * charsPerBand, (maxBand + 1) * charsPerBand);
  const startCellIndex = minBand * numCols; // flat row-major cell offset, 2 hex chars/cell

  currentDevice.displayGraphicData(hexSlice, 1, startCellIndex, DisplayMode.GraphicMode);
  return hexSlice.length;
}

// ---- Send pacing: trailing-edge throttle + coalescing ----
//
// The vendored SDK has its own write-acknowledgment handshake --
// DataCodes.ResponseDisplayLineAck / ResponseDisplayLineComplete, tracked
// internally per display-line via requestReady/receiveAck flags -- but it's
// consumed entirely inside the SDK's own dispatch (see its DataCode switch)
// and never reaches setCallBack()'s public callback. So this app has no way
// to directly observe "did the device actually finish the last write";
// there's no true ack to gate on from app code. The mitigation below
// approximates it with a configurable minimum inter-send interval instead,
// meant to be tuned empirically against real hardware -- which is the
// actual point of exposing it as a live control rather than a constant.
let pendingSend = false;
let lastSendAt = 0;
let sendTimer = null;

function scheduleSend() {
  renderStats();
  if (!currentDevice) return;

  const coalesce = chkCoalesce.checked;
  const intervalMs = Number(inputInterval.value) || 0;

  if (!coalesce) {
    doSend();
    return;
  }

  const now = performance.now();
  const elapsed = now - lastSendAt;
  if (elapsed >= intervalMs && !sendTimer) {
    doSend();
    return;
  }

  // A send happened too recently (or one's already scheduled) -- collapse
  // this move into whichever send eventually fires, rather than queuing
  // every intermediate position.
  if (pendingSend) stats.coalesced++;
  pendingSend = true;
  if (!sendTimer) {
    const wait = Math.max(0, intervalMs - elapsed);
    sendTimer = setTimeout(() => {
      sendTimer = null;
      if (pendingSend) {
        pendingSend = false;
        doSend();
      }
    }, wait);
  }
}

function doSend() {
  if (!currentDevice) return;
  const now = performance.now();
  if (lastSendAt) stats.lastGap = now - lastSendAt;
  lastSendAt = now;
  stats.sends++;

  const pixels = buildPixels();
  const strategy = currentPayloadStrategy();
  if (strategy === 'clear-redraw') {
    sendGraphicToDevice(sdk, DisplayMode, currentDevice, pixels);
    stats.lastPayloadChars = 2 * fullFrameHexChars(); // zero pass + real pass
  } else if (strategy === 'single-frame') {
    stats.lastPayloadChars = sendSingleFrame(pixels);
  } else {
    stats.lastPayloadChars = sendPartialRows(pixels);
  }

  prevCursorX = cursorX;
  prevCursorY = cursorY;
  renderStats();
}

// ---- Cursor movement -- shared by keyboard and Dot Pad dots. Distance is
// normally 1 display pixel per press; see § Cursor acceleration below for
// how that distance can grow. ----
function moveCursor(dx, dy) {
  const newX = Math.min(displayW - 1, Math.max(0, cursorX + dx));
  const newY = Math.min(displayH - 1, Math.max(0, cursorY + dy));
  if (newX === cursorX && newY === cursorY) return;
  cursorX = newX;
  cursorY = newY;
  scheduleSend();
}

const FORM_CONTROL_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);
function isFormControlFocused() {
  const focused = document.activeElement;
  return !!focused && FORM_CONTROL_TAGS.has(focused.tagName);
}

// § Cursor acceleration (experimental) — direction never resets or cancels
// anything; only timing does. A ramp-up press slower than
// accelConfig.timingThresholdMs since the last one starts a brand-new
// streak from scratch (count=1, not accelerated) regardless of which
// direction either press was. Once accelActive, movement is
// accelConfig.factor pixels/press and the reference grid is hidden (see
// buildPixels above); switching direction mid-acceleration keeps moving at
// the accelerated distance in the new direction rather than interrupting
// it -- the only thing that cancels acceleration is accelConfig.timeoutMs
// of silence (the watchdog below), which also restores the grid.
const DIR_DELTAS = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

const accelConfig = { timingThresholdMs: 200, countThreshold: 3, factor: 5, timeoutMs: 500 };
function applyAccelConfigFromInputs() {
  const timing = Number(inputAccelTiming.value);
  const count = Number(inputAccelCount.value);
  const factor = Number(inputAccelFactor.value);
  const timeout = Number(inputAccelTimeout.value);
  if (Number.isFinite(timing) && timing > 0) accelConfig.timingThresholdMs = timing;
  if (Number.isInteger(count) && count > 0) accelConfig.countThreshold = count;
  if (Number.isFinite(factor) && factor > 0) accelConfig.factor = factor;
  if (Number.isFinite(timeout) && timeout > 0) accelConfig.timeoutMs = timeout;
  // Reflect back the actually-applied values so a rejected/invalid entry
  // never silently sits in a field looking applied when it wasn't.
  inputAccelTiming.value = accelConfig.timingThresholdMs;
  inputAccelCount.value = accelConfig.countThreshold;
  inputAccelFactor.value = accelConfig.factor;
  inputAccelTimeout.value = accelConfig.timeoutMs;
}
for (const input of [inputAccelTiming, inputAccelCount, inputAccelFactor, inputAccelTimeout]) {
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    applyAccelConfigFromInputs();
  });
}

let accelCount = 0;
let accelActive = false;
let lastPressAt = -Infinity;
let accelWatchdog = null;

function cancelAcceleration() {
  if (accelWatchdog !== null) { clearTimeout(accelWatchdog); accelWatchdog = null; }
  accelActive = false;
  accelCount = 0;
}

function armAccelWatchdog() {
  if (accelWatchdog !== null) clearTimeout(accelWatchdog);
  accelWatchdog = setTimeout(() => {
    accelWatchdog = null;
    cancelAcceleration();
    scheduleSend(); // no further press is coming -- redraw now so the grid reappears
  }, accelConfig.timeoutMs);
}

// Returns the pixel distance this press should move by (1 normally,
// accelConfig.factor once accelerated). Direction doesn't factor into this
// at all -- see the § Cursor acceleration comment above.
function onCursorKeyPress() {
  const now = performance.now();

  if (accelActive) {
    lastPressAt = now;
    armAccelWatchdog();
    return accelConfig.factor;
  }

  const freshStart = (now - lastPressAt) >= accelConfig.timingThresholdMs;
  accelCount = freshStart ? 1 : accelCount + 1;
  lastPressAt = now;

  if (accelCount >= accelConfig.countThreshold) {
    accelActive = true;
    armAccelWatchdog();
    return accelConfig.factor;
  }
  return 1;
}

function handleDirectionPress(dir) {
  const distance = onCursorKeyPress();
  const [dx, dy] = DIR_DELTAS[dir];
  moveCursor(dx * distance, dy * distance);
}

const KEY_TO_DIR = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

document.addEventListener('keydown', (event) => {
  const dir = KEY_TO_DIR[event.key];
  if (!dir || isFormControlFocused()) return;
  event.preventDefault();
  stats.keydowns++;
  handleDirectionPress(dir);
});

// ---- Dot Pad connection ----
watchDotPad(sdk, DataCodes, {
  onConnected: (device) => {
    currentDevice = device;
    const dims = graphicsDimensions(device);
    displayW = dims.displayW;
    displayH = dims.displayH;
    cursorX = Math.min(cursorX, displayW - 1);
    cursorY = Math.min(cursorY, displayH - 1);
    prevCursorX = cursorX;
    prevCursorY = cursorY;
    btnConnect.hidden = true;
    btnConnect.disabled = false;
    btnDisconnect.hidden = false;
    setMessage('Connected');
    doSend();
  },
  onDisconnected: () => {
    currentDevice = null;
    btnConnect.hidden = false;
    btnConnect.disabled = false;
    btnDisconnect.hidden = true;
    setMessage('Disconnected');
  },
  onConnectFailed: () => {
    setMessage('Connect failed');
    btnConnect.disabled = false;
  },
  onKey: (device, keyCode, msg) => {
    const byte6 = labelToByte6(msg || keyCode);
    stats.keydowns++;
    if (byte6 === CURSOR_DOT.LEFT) handleDirectionPress('left');
    else if (byte6 === CURSOR_DOT.RIGHT) handleDirectionPress('right');
    else if (byte6 === CURSOR_DOT.UP) handleDirectionPress('up');
    else if (byte6 === CURSOR_DOT.DOWN) handleDirectionPress('down');
  }
});

btnConnect.addEventListener('click', async () => {
  btnConnect.disabled = true;
  setMessage('Scanning…');
  try {
    const device = await connectDotPad(sdk, scanner);
    if (!device) {
      setMessage('No device selected');
      btnConnect.disabled = false;
    }
    // Otherwise onConnected (above, via watchDotPad) takes over once the
    // SDK reports DataCodes.Connected.
  } catch (err) {
    setMessage('Connect error');
    btnConnect.disabled = false;
  }
});

btnDisconnect.addEventListener('click', () => {
  disconnectDotPad(sdk, currentDevice);
});

renderStats();
