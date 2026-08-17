// experimenthw — a minimal Dot Pad app for experimenting with SDK 3.0.1's
// newer features: haptic feedback parameters, and real key-down/key-up
// events for hold-to-repeat cursor movement. Also plays an optional audible
// click (plain Web Audio, no hardware involved) on every pixel of cursor
// movement -- see § Cursor click sound. No pan/zoom: a single cursor ring on
// a fixed 60x40 tactile grid.
//
// The previous round of experiments here was about *how to write to the
// display* under rapid cursoring without it getting confused/sluggish. That
// work is done and solidified: this page now always writes a single
// full-frame graphic (no redundant clear pass) coalesced at a fixed
// interval, matching exactly what DotTMAP itself does in production for
// cursor moves (see tmap/app.js's sendGraphicToDevice/scheduleCursorGraphicSend
// and CURSOR_SEND_INTERVAL_MS) -- see § Send pacing below. There's no live
// strategy toggle anymore; if that ever needs revisiting, the earlier
// three-way comparison (clear-redraw / single-frame / partial-rows) is in
// git history.
//
// Built on dotpad-toolkit (../../dotpad-toolkit/) rather than duplicating
// DotTMAP's own copies of this logic — see that repo's README for the
// module index and the encoding/dimension gotchas already documented there,
// including the two new "hard-won lessons" this round of work added: the
// onKey vs onKeyDown/onKeyUp distinction (and their non-corresponding key
// names), and the haptics protocol's actual parameter set.
import { DotPadSDK, DotPadScanner, DisplayMode, DataCodes } from '../../dotpad-toolkit/vendor/web-sdk-3.0.1/DotPadSDK-3.0.1.js';
import { connectDotPad, disconnectDotPad, watchDotPad } from '../../dotpad-toolkit/device/connection.js';
import { sendTextToDevice, truncateMessage } from '../../dotpad-toolkit/device/messageDisplay.js';
import { graphicsDimensions } from '../../dotpad-toolkit/device/graphicsDisplay.js';
import { packPixelsToHex } from '../../dotpad-toolkit/graphics/packPixelsToHex.js';
import { drawCursorRing, drawLinePixels } from '../../dotpad-toolkit/graphics/rasterizer.js';
import { dotPadKeyToDot } from '../../dotpad-toolkit/device/keys.js';

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
const selectRepeatInterval = document.getElementById('select-repeat-interval');
const chkClickEnabled = document.getElementById('chk-click-enabled');
const inputClickVolume = document.getElementById('input-click-volume');
const inputHapticOn = document.getElementById('input-haptic-on');
const inputHapticOff = document.getElementById('input-haptic-off');
const inputHapticRepeat = document.getElementById('input-haptic-repeat');
const btnTestHaptic = document.getElementById('btn-test-haptic');

// § Cursor click sound — plain Web Audio, entirely independent of the Dot
// Pad connection (works with or without hardware). A 500Hz sine tone under
// a trapezoidal gain envelope: 4ms linear ramp up, 12ms flat, 4ms linear
// ramp down (20ms total) -- a "square window with linear ramps" per spec,
// as opposed to e.g. a Hann window's curved taper the whole way through.
const CLICK_FREQUENCY_HZ = 500;
const CLICK_DURATION_S = 0.020;
const CLICK_RAMP_S = 0.004;
const CLICK_PEAK_GAIN = 0.3; // ceiling at 100% volume -- headroom against clipping, this is UI feedback, not an alarm

let audioCtx = null;
function getAudioContext() {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return null; // no Web Audio support -- clicks just silently don't happen
  if (!audioCtx) audioCtx = new AudioContextCtor();
  return audioCtx;
}

// Browsers require a user gesture before audio can play. Call this from any
// genuine user-initiated event handler (e.g. a button click) as early as
// possible, so playCursorClick() below -- which may end up firing from a
// timer-driven repeat tick, not a fresh gesture -- always has an
// already-running context to schedule into.
function warmUpAudioContext() {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') ctx.resume();
}

function playCursorClick() {
  if (!chkClickEnabled.checked) return;
  const volume = Number(inputClickVolume.value) / 100;
  if (!(volume > 0)) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(CLICK_FREQUENCY_HZ, ctx.currentTime);
  osc.connect(gain);
  gain.connect(ctx.destination);

  const peak = CLICK_PEAK_GAIN * volume;
  const t0 = ctx.currentTime;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(peak, t0 + CLICK_RAMP_S);
  gain.gain.setValueAtTime(peak, t0 + CLICK_DURATION_S - CLICK_RAMP_S);
  gain.gain.linearRampToValueAtTime(0, t0 + CLICK_DURATION_S);

  osc.start(t0);
  osc.stop(t0 + CLICK_DURATION_S);
  osc.addEventListener('ended', () => { osc.disconnect(); gain.disconnect(); });
}

// § Message display — mirrors to the Dot Pad's message line, single source
// of truth for anything announced, same pattern as DotTMAP's setMessage
// (clear-then-reflow so a screen reader treats each update as a fresh
// assertive announcement rather than coalescing successive ones).
//
// deviceDelayMs (default 0) is forwarded to sendTextToDevice's own delay --
// see dotpad-toolkit/README.md's "Message-line and graphics writes contend
// over BLE" section. The on-screen text (and screen-reader announcement)
// still updates immediately regardless; only the device-bound write waits.
function setMessage(text, deviceDelayMs = 0) {
  messageEl.textContent = '';
  void messageEl.offsetHeight;
  messageEl.textContent = text;
  if (currentDevice) {
    const numCells = currentDevice.numberBrailleCellColumns;
    sendTextToDevice(sdk, DisplayMode, currentDevice, truncateMessage(text, numCells), deviceDelayMs);
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
// cursor to move over, rather than a blank field.
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
  drawReferenceGrid(pixels);
  drawCursorRing(pixels, displayW, displayH, cursorX, cursorY);
  return pixels;
}

// ---- Send pacing: solidified best practice, ported verbatim from tmap's
// scheduleCursorGraphicSend/createCoalescer (tmap/app.js) ----
//
// A single full-frame write per send, clear pass skipped (a full frame
// already fully describes the desired state -- see tmap's own comment on
// this), trailing-edge-throttled so a burst of rapid moves collapses into
// one deferred send using whatever position is current when it actually
// fires, rather than one send per keystroke. This is no longer a live
// experiment: it's the same fixed interval tmap ships with, tuned against
// real hardware in the previous round of work here.
const CURSOR_SEND_INTERVAL_MS = 80;

// How long to defer the "Connected" message-line write after connecting, so
// it doesn't contend with (and hold up) the initial grid's graphics write --
// see dotpad-toolkit/README.md's "Message-line and graphics writes contend
// over BLE" section. Same value tmap settled on.
const CONNECT_MESSAGE_DELAY_MS = 1000;

function createCoalescer(intervalMs, flush) {
  let lastSentAt = -Infinity;
  let timer = null;
  let pending;
  return function schedule(payload) {
    pending = payload;
    const now = performance.now();
    const elapsed = now - lastSentAt;
    if (elapsed >= intervalMs && timer === null) {
      lastSentAt = now;
      flush(payload);
      return;
    }
    if (timer !== null) {
      stats.coalesced++;
      return;
    }
    const wait = Math.max(0, intervalMs - elapsed);
    timer = setTimeout(() => {
      timer = null;
      lastSentAt = performance.now();
      flush(pending);
    }, wait);
  };
}

let lastSendAt = null;
function doSend() {
  if (!currentDevice) return;
  const now = performance.now();
  if (lastSendAt !== null) stats.lastGap = now - lastSendAt;
  lastSendAt = now;
  stats.sends++;

  const pixels = buildPixels();
  const numRows = currentDevice.numberCellRows;
  const hex = packPixelsToHex(pixels, displayW, displayH, numRows);
  sdk.displayGraphicData(hex, currentDevice, DisplayMode.GraphicMode);
  stats.lastPayloadChars = hex.length;

  renderStats();
}

const scheduleSend = createCoalescer(CURSOR_SEND_INTERVAL_MS, doSend);

// ---- Cursor movement -- shared by keyboard and Dot Pad dots. Always one
// display pixel per repeat tick; see § Cursor repeat below for how holding
// a direction turns into a stream of these. ----
function moveCursor(dx, dy) {
  const newX = Math.min(displayW - 1, Math.max(0, cursorX + dx));
  const newY = Math.min(displayH - 1, Math.max(0, cursorY + dy));
  if (newX === cursorX && newY === cursorY) return;
  cursorX = newX;
  cursorY = newY;
  playCursorClick();
  renderStats();
  scheduleSend();
}

const FORM_CONTROL_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);
function isFormControlFocused() {
  const focused = document.activeElement;
  return !!focused && FORM_CONTROL_TAGS.has(focused.tagName);
}

// § Cursor repeat — replaces the old software-timed "N fast presses in a
// row" acceleration hack with real key-down/key-up. A direction moves once
// immediately on key-down, waits REPEAT_INITIAL_DELAY_MS, then moves again
// every currentRepeatIntervalMs() until that direction's key-up arrives.
// Unlike the old model there's no ambiguity about "is this still held" --
// key-up is authoritative and stops the repeat immediately.
//
// The interval used for a given hold is whatever's selected when that
// hold's repeat phase actually starts (i.e. after the initial delay) --
// changing the dropdown mid-hold doesn't retroactively change an
// already-running repeat. That's a deliberate simplification, not an
// oversight: re-polling the dropdown on every tick would be a bigger
// behavior change than this experiment needs.
const REPEAT_INITIAL_DELAY_MS = 200;
function currentRepeatIntervalMs() {
  return Number(selectRepeatInterval.value) || 100;
}

const DIR_DELTAS = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

// Exported for verify-repeat.mjs, which transcribes this exact shape against
// a fake clock the same way verify-accel.mjs did for the old accelerator --
// see that file's own comment for why a fake clock beats trusting live
// keyboard timing for this kind of state machine.
export function createRepeatController({ initialDelayMs, getIntervalMs, onTick, setTimer = setTimeout, clearTimer = clearTimeout, setInt = setInterval, clearInt = clearInterval }) {
  const held = new Map(); // dir -> { phase: 'delay'|'repeating', timerId }

  function keyDown(dir) {
    if (held.has(dir)) return; // ignore a duplicate/stray down while already held
    onTick(dir); // move once immediately
    const timerId = setTimer(() => {
      onTick(dir); // first repeat lands exactly at initialDelayMs, not initialDelayMs+interval
      const intervalId = setInt(() => onTick(dir), getIntervalMs());
      held.set(dir, { phase: 'repeating', timerId: intervalId });
    }, initialDelayMs);
    held.set(dir, { phase: 'delay', timerId });
  }

  function keyUp(dir) {
    const entry = held.get(dir);
    if (!entry) return;
    if (entry.phase === 'delay') clearTimer(entry.timerId);
    else clearInt(entry.timerId);
    held.delete(dir);
  }

  function stopAll() {
    for (const dir of [...held.keys()]) keyUp(dir);
  }

  return { keyDown, keyUp, stopAll, isHeld: (dir) => held.has(dir) };
}

const repeat = createRepeatController({
  initialDelayMs: REPEAT_INITIAL_DELAY_MS,
  getIntervalMs: currentRepeatIntervalMs,
  onTick: (dir) => {
    const [dx, dy] = DIR_DELTAS[dir];
    moveCursor(dx, dy);
  },
});

// § Exclusivity gate — a repeat-triggering action (a direction, or the dot1
// haptics trigger) only ever starts while it's the ONLY key/dot currently
// held. This matters because real usage layers other combos on top of the
// same keys/dots (panning, zooming, etc. all reuse cursor keys in
// combination with other keys) -- without this, a combo's second key going
// down mid-press would either get eaten as a spurious direction move, or a
// direction repeat already running would fight with whatever the combo is
// trying to do.
//
// The moment a second, different id goes down, any in-progress repeat is
// cancelled immediately (onCancel), even though the first key is still
// physically held. Deliberately does NOT auto-resume once back down to one
// held id -- resuming requires releasing everything and starting a fresh
// key-down, so "let go of the modifier but keep holding the arrow" doesn't
// silently restart cursoring mid-combo.
//
// Deliberately does NOT rely on every key-down being paired with a matching
// key-up to keep `held` accurate. Real BLE key-up reports can be dropped or
// delayed (observed in practice after a haptics trigger, likely the
// vibrator write briefly contending with the key-state notification) --
// trusting key-up as the only way out of "held" means one dropped key-up
// leaves a phantom entry that jams every future press, since held.size
// would never drop back to 1. Instead, ANY new key-down (not just
// a genuinely-concurrent one) clears whatever's currently held first --
// self-healing the very next time *any* key is pressed, at the cost of that
// one press being "eaten" to do the clearing rather than firing its own
// action. That's an accepted tradeoff: the user just presses again.
//
// Exported for verify-repeat.mjs, same transcription-testing approach as
// createRepeatController above.
export function createExclusiveGate({ onCancel }) {
  const held = new Set();
  function press(id, onSoloDown) {
    if (held.has(id)) return; // already down (incl. OS keyboard auto-repeat) -- no-op
    const clearingStaleOrOtherState = held.size > 0;
    if (clearingStaleOrOtherState) {
      onCancel();
      held.clear();
    }
    held.add(id);
    if (clearingStaleOrOtherState) return; // this press was eaten to clear prior state -- press again
    onSoloDown && onSoloDown();
  }
  function release(id, onUp) {
    if (!held.has(id)) return;
    held.delete(id);
    onUp && onUp();
  }
  return { press, release, size: () => held.size };
}

const exclusiveGate = createExclusiveGate({ onCancel: () => repeat.stopAll() });

// Any held direction should stop if the page loses focus, rather than
// leaving a phantom interval running with no way to release it (e.g. Alt+Tab
// away while a physical dot is still mechanically held down).
window.addEventListener('blur', () => repeat.stopAll());

const KEY_TO_DIR = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

// Every keydown/keyup on the page (not just direction keys) feeds the
// exclusivity gate, using event.key as the id -- a Shift, Ctrl, or any other
// key going down while an arrow is held cancels the arrow's repeat, the same
// as a second arrow would. Ignored entirely while a form control is
// focused, so editing the repeat-interval/haptics fields doesn't get read
// as a "second key" against nothing.
document.addEventListener('keydown', (event) => {
  if (isFormControlFocused()) return;
  const dir = KEY_TO_DIR[event.key];
  if (dir) { event.preventDefault(); stats.keydowns++; renderStats(); }
  exclusiveGate.press(event.key, dir ? () => repeat.keyDown(dir) : undefined);
});

document.addEventListener('keyup', (event) => {
  if (isFormControlFocused()) return;
  const dir = KEY_TO_DIR[event.key];
  exclusiveGate.release(event.key, dir ? () => repeat.keyUp(dir) : undefined);
});

// ---- Haptics ----
// requestVibrator is on/off-only -- there's no intensity parameter in the
// protocol (see dotpad-toolkit/README.md's "Haptics" section). repeatCount
// is silently clamped to 1-5 by the SDK regardless of what's requested;
// onMs/offMs are truncated to 10ms resolution.
function triggerTestHaptic() {
  if (!currentDevice) return;
  const onMs = Number(inputHapticOn.value) || 0;
  const offMs = Number(inputHapticOff.value) || 0;
  const repeatCount = Number(inputHapticRepeat.value) || 1;
  sdk.requestVibrator(currentDevice, onMs, offMs, repeatCount);
}
btnTestHaptic.addEventListener('click', triggerTestHaptic);

// ---- Dot Pad connection ----
// Cursor dots and the haptics-trigger dot are driven entirely by
// onKeyDown/onKeyUp now (real press/release), not the older onKey report --
// see dotpad-toolkit/README.md's "Two ways to hear about a key press"
// section for why these are separate channels with non-corresponding key
// names, and dotPadKeyToDot for the decode.
//
// Dot/direction convention (matches CURSOR_DOT in dotpad-toolkit/device/keys.js):
//   dot2=up, dot3=left, dot5=down, dot6=right, dot1=haptics test trigger, dot4=unused
const DOT_TO_DIR = { 2: 'up', 3: 'left', 5: 'down', 6: 'right' };

watchDotPad(sdk, DataCodes, {
  onConnected: (device) => {
    currentDevice = device;
    const dims = graphicsDimensions(device);
    displayW = dims.displayW;
    displayH = dims.displayH;
    cursorX = Math.min(cursorX, displayW - 1);
    cursorY = Math.min(cursorY, displayH - 1);
    btnConnect.hidden = true;
    btnConnect.disabled = false;
    btnDisconnect.hidden = false;
    // The grid must render immediately on connect -- see
    // dotpad-toolkit/README.md's "Message-line and graphics writes contend
    // over BLE" section. Send the graphic write first/undelayed, and defer
    // the "Connected" message-line write (CONNECT_MESSAGE_DELAY_MS, same
    // 1000ms tmap settled on) so it doesn't hold the grid write up.
    doSend();
    setMessage('Connected', CONNECT_MESSAGE_DELAY_MS);
  },
  onDisconnected: () => {
    currentDevice = null;
    repeat.stopAll();
    btnConnect.hidden = false;
    btnConnect.disabled = false;
    btnDisconnect.hidden = true;
    setMessage('Disconnected');
  },
  onConnectFailed: () => {
    setMessage('Connect failed');
    btnConnect.disabled = false;
  },
  onKeyDown: (device, dotPadKey) => {
    const dot = dotPadKeyToDot(dotPadKey);
    if (!dot) return;
    stats.keydowns++;
    renderStats();
    const dir = DOT_TO_DIR[dot];
    const action = dot === 1 ? () => triggerTestHaptic() : dir ? () => repeat.keyDown(dir) : undefined;
    // Every physical dot (including dot4, otherwise unused here) feeds the
    // same exclusivity gate as the keyboard path -- pressing any second dot
    // while one is held cancels an in-progress cursor repeat, same reasoning
    // as § Exclusivity gate above.
    exclusiveGate.press(`dot:${dot}`, action);
  },
  onKeyUp: (device, dotPadKey) => {
    const dot = dotPadKeyToDot(dotPadKey);
    if (!dot) return;
    const dir = DOT_TO_DIR[dot];
    exclusiveGate.release(`dot:${dot}`, dir ? () => repeat.keyUp(dir) : undefined);
  },
});

btnConnect.addEventListener('click', async () => {
  warmUpAudioContext(); // a real click handler is the reliable place to unlock audio -- see § Cursor click sound
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
