// Verifies the cursor-repeat state machine (extracted copy of
// createRepeatController in app.js) against a fake clock, since real
// keyboard/BLE timing isn't reliable enough to assert exact tick counts
// against. Same approach the old verify-accel.mjs used for the acceleration
// hack this replaces -- see app.js's § Cursor repeat comment for why real
// key-down/key-up beats that hack's timing heuristics.
function makeFakeClock() {
  let currentTime = 0;
  let nextId = 1;
  const timers = new Map(); // id -> { fireAt, fn, everyMs (intervals only) }
  function now() { return currentTime; }
  function setTimeout_(fn, ms) {
    const id = nextId++;
    timers.set(id, { fireAt: currentTime + ms, fn });
    return id;
  }
  function clearTimeout_(id) { timers.delete(id); }
  function setInterval_(fn, ms) {
    const id = nextId++;
    timers.set(id, { fireAt: currentTime + ms, fn, everyMs: ms });
    return id;
  }
  function clearInterval_(id) { timers.delete(id); }
  function advance(ms) {
    const target = currentTime + ms;
    for (;;) {
      let dueId = null, dueAt = Infinity;
      for (const [id, t] of timers) {
        if (t.fireAt <= target && t.fireAt < dueAt) { dueId = id; dueAt = t.fireAt; }
      }
      if (dueId === null) break;
      currentTime = dueAt;
      const t = timers.get(dueId);
      if (t.everyMs) t.fireAt = currentTime + t.everyMs; // interval reschedules itself
      else timers.delete(dueId); // one-shot consumes itself
      t.fn();
    }
    currentTime = target;
  }
  return { now, setTimeout: setTimeout_, clearTimeout: clearTimeout_, setInterval: setInterval_, clearInterval: clearInterval_, advance };
}

// Transcribed verbatim from app.js's createRepeatController.
function createRepeatController({ initialDelayMs, getIntervalMs, onTick, setTimer, clearTimer, setInt, clearInt }) {
  const held = new Map();
  function keyDown(dir) {
    if (held.has(dir)) return;
    onTick(dir);
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
  function stopAll() { for (const dir of [...held.keys()]) keyUp(dir); }
  return { keyDown, keyUp, stopAll, isHeld: (dir) => held.has(dir) };
}

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) { failures++; console.log(`FAIL ${label}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`); }
  else console.log(`ok   ${label}`);
}

function makeController(clock, intervalMs, ticks) {
  return createRepeatController({
    initialDelayMs: 200,
    getIntervalMs: () => intervalMs,
    onTick: (dir) => ticks.push({ dir, at: clock.now() }),
    setTimer: clock.setTimeout,
    clearTimer: clock.clearTimeout,
    setInt: clock.setInterval,
    clearInt: clock.clearInterval,
  });
}

// ---- Case 1: key-down moves once immediately, nothing more before the
// 200ms initial delay elapses.
{
  const clock = makeFakeClock();
  const ticks = [];
  const repeat = makeController(clock, 100, ticks);
  repeat.keyDown('left');
  clock.advance(199);
  check('one immediate tick, none before initial delay', ticks, [{ dir: 'left', at: 0 }]);
}

// ---- Case 2: after the 200ms initial delay, repeats fire at the
// configured interval until key-up.
{
  const clock = makeFakeClock();
  const ticks = [];
  const repeat = makeController(clock, 100, ticks);
  repeat.keyDown('right');
  clock.advance(200); // initial delay elapses -> first repeat tick
  clock.advance(100); // one interval -> second repeat tick
  clock.advance(100); // another interval -> third repeat tick
  check('immediate + 3 repeat ticks at the interval after the initial delay', ticks.map((t) => t.at), [0, 200, 300, 400]);
  repeat.keyUp('right');
  clock.advance(500);
  check('no further ticks after key-up', ticks.length, 4);
}

// ---- Case 3: key-up during the initial delay (before repeating starts)
// cancels cleanly -- only the one immediate tick ever fires.
{
  const clock = makeFakeClock();
  const ticks = [];
  const repeat = makeController(clock, 50, ticks);
  repeat.keyDown('up');
  clock.advance(100); // still inside the 200ms initial delay
  repeat.keyUp('up');
  clock.advance(1000);
  check('key-up during initial delay leaves only the immediate tick', ticks.length, 1);
}

// ---- Case 4: a duplicate key-down for an already-held direction is
// ignored (guards against a stray repeated hardware key-down report).
{
  const clock = makeFakeClock();
  const ticks = [];
  const repeat = makeController(clock, 100, ticks);
  repeat.keyDown('down');
  repeat.keyDown('down'); // duplicate -- should not add a second immediate tick
  check('duplicate key-down for a held direction is a no-op', ticks.length, 1);
  check('isHeld reflects the single active hold', repeat.isHeld('down'), true);
}

// ---- Case 5: two directions held concurrently repeat independently. This
// tests createRepeatController alone -- app.js never actually calls it this
// way in practice, since createExclusiveGate (Cases 6-8 below) sits in
// front of it and refuses to start a second repeat while another id is
// already held. Kept as a unit test of what this primitive can do on its
// own, not a claim about real app behavior.
{
  const clock = makeFakeClock();
  const ticks = [];
  const repeat = makeController(clock, 100, ticks);
  repeat.keyDown('left');
  clock.advance(50);
  repeat.keyDown('up'); // started 50ms after 'left'
  clock.advance(150); // left's initial delay (200ms) elapses at t=200
  clock.advance(50);  // up's initial delay (started at 50) elapses at t=250
  const byDir = { left: ticks.filter((t) => t.dir === 'left').map((t) => t.at), up: ticks.filter((t) => t.dir === 'up').map((t) => t.at) };
  check('two concurrent holds repeat on independent schedules', byDir, { left: [0, 200], up: [50, 250] });
}

// Transcribed verbatim from app.js's createExclusiveGate.
function createExclusiveGate({ onCancel, setTimer, clearTimer }) {
  const held = new Set();
  let pending = null;
  function clearPending() {
    if (pending === null) return;
    clearTimer(pending.timerId);
    pending = null;
  }
  function press(id, onSoloDown, soloDelayMs = 0) {
    if (held.has(id)) return;
    const clearingStaleOrOtherState = held.size > 0;
    if (clearingStaleOrOtherState) {
      clearPending();
      onCancel();
      held.clear();
    }
    held.add(id);
    if (clearingStaleOrOtherState) return;
    if (!onSoloDown) return;
    if (soloDelayMs <= 0) { onSoloDown(); return; }
    pending = { id, onSoloDown, timerId: setTimer(() => { pending = null; onSoloDown(); }, soloDelayMs) };
  }
  function release(id, onUp) {
    if (!held.has(id)) return;
    held.delete(id);
    if (pending !== null && pending.id === id) {
      const onSoloDown = pending.onSoloDown;
      clearPending();
      onSoloDown();
    }
    onUp && onUp();
  }
  return { press, release, size: () => held.size, cancelPending: clearPending };
}

// ---- Case 6: a solo key-down starts the action; a second key-down while
// the first is still held does NOT start its own action.
{
  const clock = makeFakeClock();
  const ticks = [];
  const repeat = makeController(clock, 100, ticks);
  const gate = createExclusiveGate({ onCancel: () => repeat.stopAll() });
  gate.press('left', () => repeat.keyDown('left'));
  gate.press('right', () => repeat.keyDown('right')); // second id -- should not start
  check('only the solo key-down actually started a repeat', { leftHeld: repeat.isHeld('left'), rightHeld: repeat.isHeld('right') }, { leftHeld: false, rightHeld: false });
}

// ---- Case 7: a second key-down while a repeat is already running cancels
// it immediately -- no further ticks, even though the first key is still
// physically held.
{
  const clock = makeFakeClock();
  const ticks = [];
  const repeat = makeController(clock, 100, ticks);
  const gate = createExclusiveGate({ onCancel: () => repeat.stopAll() });
  gate.press('left', () => repeat.keyDown('left'));
  clock.advance(200); // repeat is now active (immediate tick + first repeat tick)
  gate.press('shift', undefined); // a second, non-direction key goes down
  check('repeat cancelled the instant a second key goes down', repeat.isHeld('left'), false);
  clock.advance(1000);
  check('no further ticks after cancellation, even with the first key still held', ticks.length, 2);
}

// ---- Case 8: releasing back down to exactly one held id does NOT
// auto-resume the cancelled repeat -- only a fresh key-down does.
{
  const clock = makeFakeClock();
  const ticks = [];
  const repeat = makeController(clock, 100, ticks);
  const gate = createExclusiveGate({ onCancel: () => repeat.stopAll() });
  gate.press('left', () => repeat.keyDown('left'));
  clock.advance(50);
  gate.press('shift', undefined); // cancels 'left's repeat
  gate.release('shift', undefined); // back down to just 'left' still held
  clock.advance(1000);
  check('no auto-resume after releasing back to one held id', ticks.length, 1); // just the original immediate tick
  gate.release('left', () => repeat.keyUp('left'));
  gate.press('left', () => repeat.keyDown('left')); // fresh key-down
  check('a fresh key-down after full release starts a new repeat', ticks.length, 2);
}

// ---- Case 9: a key-up that never arrives (dropped BLE report) must not
// jam the gate forever -- this is the actual bug found on real hardware:
// dot1's key-up occasionally never arrives after a haptics trigger, and the
// old key-up-only cleanup left `dot:1` stuck in `held` permanently, so
// held.size never dropped back to 1 and every later cursor press got
// treated as "a second key is down" and silently swallowed.
{
  const clock = makeFakeClock();
  const ticks = [];
  const repeat = makeController(clock, 100, ticks);
  const gate = createExclusiveGate({ onCancel: () => repeat.stopAll() });

  gate.press('dot:1', () => {}); // dot1 haptics trigger fires
  // ...its key-up never arrives -- 'dot:1' is now permanently stuck in
  // `held` under the old design.

  gate.press('dot:3', () => repeat.keyDown('left')); // first cursor press after the stuck key
  check('the first press after a stuck key is eaten to clear it, not fired', ticks.length, 0);
  gate.release('dot:3', () => repeat.keyUp('left')); // user releases and, as instructed, tries again

  gate.press('dot:3', () => repeat.keyDown('left')); // press again, as the user is told to
  check('a subsequent press of the same key fires normally once the stuck state is cleared', ticks.length, 1);

  gate.release('dot:3', () => repeat.keyUp('left'));
  clock.advance(1000);
  check('and releases/repeats behave normally from here on', ticks.length, 1);
}

// ---- Case 10: a solo press with soloDelayMs commits after the window
// elapses, same net effect as an immediate press just later -- this is the
// real dot-pad path (CHORD_HOLD_MS in app.js).
{
  const clock = makeFakeClock();
  const ticks = [];
  const repeat = makeController(clock, 100, ticks);
  const gate = createExclusiveGate({ onCancel: () => repeat.stopAll(), setTimer: clock.setTimeout, clearTimer: clock.clearTimeout });
  gate.press('dot:3', () => repeat.keyDown('left'), 30);
  check('nothing fires yet -- still inside the hold-and-see window', ticks.length, 0);
  clock.advance(29);
  check('still nothing one tick before the window elapses', ticks.length, 0);
  clock.advance(1);
  check('commits at exactly the window', ticks.map((t) => t.at), [30]);
}

// ---- Case 11: a second dot joining within the window means the first
// dot's solo action never fires at all -- not fired-then-cancelled, the
// actual "chords must not trigger single-key behavior" requirement.
{
  const clock = makeFakeClock();
  const ticks = [];
  const repeat = makeController(clock, 100, ticks);
  const gate = createExclusiveGate({ onCancel: () => repeat.stopAll(), setTimer: clock.setTimeout, clearTimer: clock.clearTimeout });
  gate.press('dot:3', () => repeat.keyDown('left'), 30); // first dot of a chord
  clock.advance(10);
  gate.press('dot:2', () => repeat.keyDown('up'), 30); // second dot joins mid-window -- eaten to clear
  clock.advance(1000);
  check('neither chord dot ever triggered a single-key action', ticks.length, 0);
}

// ---- Case 12: releasing before the window elapses (a genuine quick tap)
// commits immediately rather than waiting out the rest of the window or
// being dropped -- a real tap must still register, and promptly.
{
  const clock = makeFakeClock();
  const ticks = [];
  const repeat = makeController(clock, 100, ticks);
  const gate = createExclusiveGate({ onCancel: () => repeat.stopAll(), setTimer: clock.setTimeout, clearTimer: clock.clearTimeout });
  gate.press('dot:3', () => repeat.keyDown('left'), 30);
  clock.advance(10); // released well before the 30ms window would elapse
  gate.release('dot:3', () => repeat.keyUp('left'));
  check('a quick tap commits immediately on release, not delayed to t=30', ticks.map((t) => t.at), [10]);
  clock.advance(1000);
  check('and the just-committed repeat.keyDown was immediately paired with keyUp -- no lingering repeat', ticks.length, 1);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
