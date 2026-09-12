import assert from "node:assert/strict";
import test from "node:test";
import { createConversationScrollController } from "./use-conversation-scroll.ts";

function fixture() {
  const frames = new Map<number, FrameRequestCallback>();
  const changes: boolean[] = [];
  let nextFrame = 0;
  class Observer {
    static instances: Observer[] = [];
    observed = new Set<unknown>();
    disconnected = false;
    callback: () => void;
    constructor(callback: () => void) { this.callback = callback; Observer.instances.push(this); }
    observe(target: unknown) { this.observed.add(target); }
    unobserve(target: unknown) { this.observed.delete(target); }
    disconnect() { this.disconnected = true; this.observed.clear(); }
    trigger() { if (!this.disconnected) this.callback(); }
  }
  const view = {
    requestAnimationFrame(callback: FrameRequestCallback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
    ResizeObserver: Observer,
    MutationObserver: Observer,
  };
  class Scroller extends EventTarget {
    ownerDocument = { defaultView: view };
    scrollHeight = 1_000;
    clientHeight = 200;
    scrollTop = 800;
    children: unknown[] = [{}];
    scrolls: ScrollToOptions[] = [];
    scrollTo(options: ScrollToOptions) {
      this.scrolls.push(options);
      this.scrollTop = Math.max(0, Math.min(options.top ?? this.scrollTop, this.scrollHeight - this.clientHeight));
    }
    closest() { return null; }
  }
  const scroller = new Scroller();
  const controller = createConversationScrollController(scroller as unknown as HTMLElement, value => changes.push(value));
  const [resize, mutation] = Observer.instances;
  const emit = (type: string, properties: Record<string, unknown> = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), properties);
    scroller.dispatchEvent(event);
    return event;
  };
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  };
  const scroll = (top: number) => { scroller.scrollTop = top; emit("scroll"); };
  return { controller, scroller, changes, emit, flush, scroll, frames, resize, mutation };
}

test("stream updates coalesce into an instant scroll and late math resizing stays at the bottom", () => {
  const f = fixture();
  f.flush();
  f.scroller.scrolls.length = 0;
  f.scroller.scrollHeight = 1_200;
  f.controller.refresh();
  f.controller.refresh();
  assert.equal(f.frames.size, 1);
  f.flush();
  assert.equal(f.scroller.scrollTop, 1_000);
  assert.deepEqual(f.scroller.scrolls, [{ top: 1_200, behavior: "instant" }]);
  f.scroller.scrollHeight = 1_350;
  f.resize.trigger();
  f.flush();
  assert.equal(f.scroller.scrollTop, 1_150);
  assert.deepEqual(f.changes, []);
  f.controller.dispose();
});

test("the first tiny upward wheel cancels a pending frame before any offset changes", () => {
  const f = fixture();
  f.emit("wheel", { deltaY: -.1, ctrlKey: false });
  assert.deepEqual(f.changes, [false]);
  assert.equal(f.frames.size, 0);
  assert.deepEqual(f.scroller.scrolls.at(-1), { top: 800, behavior: "instant" });
  // A queued programmatic scroll event still reports the old bottom.
  f.emit("scroll");
  f.scroll(799.9);
  f.scroller.scrollHeight = 1_100;
  f.controller.refresh();
  f.resize.trigger();
  f.flush();
  assert.equal(f.scroller.scrollTop, 799.9);
  assert.deepEqual(f.changes, [false]);
  f.controller.dispose();
});

test("downward intent and a manual return to the actual bottom resume follow", () => {
  const f = fixture();
  f.emit("wheel", { deltaY: -1 });
  f.scroll(750);
  f.emit("wheel", { deltaY: 1 });
  f.scroll(790);
  assert.deepEqual(f.changes, [false]);
  f.scroll(800);
  assert.deepEqual(f.changes, [false, true]);
  f.scroller.scrollHeight = 1_050;
  f.flush();
  assert.equal(f.scroller.scrollTop, 850);
  f.controller.dispose();
});

for (const key of ["PageUp", "Home", "ArrowUp"]) {
  test(`${key} suspends before its browser scroll, even one pixel from the bottom`, () => {
    const f = fixture();
    f.scroller.scrollTop = 799;
    f.emit("keydown", { key });
    assert.deepEqual(f.changes, [false]);
    assert.equal(f.frames.size, 0);
    f.controller.dispose();
  });
}

test("a finger moving down suspends before the touch scroll moves upward", () => {
  const f = fixture();
  f.emit("touchstart", { touches: [{ clientY: 100 }] });
  f.emit("touchmove", { touches: [{ clientY: 100.1 }] });
  assert.deepEqual(f.changes, [false]);
  f.emit("scroll");
  assert.deepEqual(f.changes, [false]);
  f.controller.dispose();
});

test("scrollbar movement suspends and returning it to the bottom re-enables follow", () => {
  const f = fixture();
  f.flush();
  f.emit("pointerdown");
  f.scroll(799);
  assert.deepEqual(f.changes, [false]);
  f.scroll(800);
  assert.deepEqual(f.changes, [false, true]);
  f.controller.dispose();
});

test("an upward scrollbar drag still pauses when streaming increased content height", () => {
  const f = fixture();
  f.flush();
  f.emit("pointerdown");
  f.scroller.scrollHeight = 1_100;
  f.scroll(799.9);
  f.controller.refresh();
  f.resize.trigger();
  f.flush();
  assert.equal(f.scroller.scrollTop, 799.9);
  assert.deepEqual(f.changes, [false]);
  f.controller.dispose();
});

test("content shrinking clamps the current bottom without misclassifying it as user intent", () => {
  const f = fixture();
  f.flush();
  f.scroller.scrollHeight = 700;
  f.scroll(500);
  assert.deepEqual(f.changes, []);
  f.scroller.scrollHeight = 750;
  f.resize.trigger();
  f.flush();
  assert.equal(f.scroller.scrollTop, 550);
  f.controller.dispose();
});

test("returning to latest stays stable when a disappearing footer increases the viewport", () => {
  const f = fixture();
  f.flush();
  f.emit("wheel", { deltaY: -1 });
  f.scroll(750);
  f.emit("wheel", { deltaY: 1 });
  f.scroll(800);
  f.flush();
  assert.deepEqual(f.changes, [false, true]);

  // Removing the old in-flow latest button adds 36px to the viewport. The
  // browser clamps the offset to the new bottom without an upward gesture.
  f.scroller.clientHeight += 36;
  f.scroll(764);
  assert.deepEqual(f.changes, [false, true]);
  f.scroller.scrollHeight = 1_100;
  f.resize.trigger();
  f.flush();
  assert.equal(f.scroller.scrollTop, 864);
  assert.deepEqual(f.changes, [false, true]);
  f.controller.dispose();
});

test("an upward drag away from the bottom still pauses while the viewport grows", () => {
  const f = fixture();
  f.flush();
  f.emit("pointerdown");
  f.scroller.clientHeight += 36;
  f.scroll(700);
  f.resize.trigger();
  f.flush();
  assert.equal(f.scroller.scrollTop, 700);
  assert.deepEqual(f.changes, [false]);
  f.controller.dispose();
});

test("a deliberate jump for a new question resumes and follows that question's later render", () => {
  const f = fixture();
  f.emit("wheel", { deltaY: -1 });
  f.scroll(500);
  f.controller.jumpToLatest();
  f.scroller.scrollHeight = 1_100;
  f.controller.refresh();
  f.flush();
  assert.equal(f.scroller.scrollTop, 900);
  assert.deepEqual(f.changes, [false, true]);
  f.controller.dispose();
});

test("End cancels native keyboard scrolling and follows the latest height during streaming", () => {
  const f = fixture();
  f.emit("keydown", { key: "ArrowUp" });
  f.scroll(500);
  const event = f.emit("keydown", { key: "End" });
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(f.changes, [false, true]);
  assert.equal(f.scroller.scrollTop, 800);
  f.scroller.scrollHeight = 1_300;
  f.controller.refresh();
  f.flush();
  assert.equal(f.scroller.scrollTop, 1_100);
  f.scroller.scrollHeight = 1_500;
  f.controller.refresh();
  f.flush();
  assert.equal(f.scroller.scrollTop, 1_300);
  assert.ok(f.scroller.scrolls.every(scroll => scroll.behavior === "instant"));
  f.controller.dispose();
});

test("Mac command arrows pause and jump while unrelated command shortcuts are preserved", () => {
  const f = fixture();
  const unrelated = f.emit("keydown", { key: "Home", metaKey: true });
  assert.deepEqual(f.changes, []);
  assert.equal(unrelated.defaultPrevented, false);
  f.emit("keydown", { key: "ArrowUp", metaKey: true });
  f.scroll(500);
  assert.deepEqual(f.changes, [false]);
  const jump = f.emit("keydown", { key: "ArrowDown", metaKey: true });
  assert.equal(jump.defaultPrevented, true);
  assert.equal(f.scroller.scrollTop, 800);
  assert.deepEqual(f.changes, [false, true]);
  f.controller.dispose();
});

test("jump cancels prior keyboard movement immediately and ignores a queued old offset before its frame", () => {
  const f = fixture();
  f.emit("keydown", { key: "PageUp" });
  f.scroll(500);
  f.controller.jumpToLatest();
  assert.equal(f.scroller.scrollTop, 800);
  f.scroll(520);
  assert.deepEqual(f.changes, [false, true]);
  f.scroller.scrollHeight = 1_200;
  f.flush();
  assert.equal(f.scroller.scrollTop, 1_000);
  assert.deepEqual(f.changes, [false, true]);
  f.controller.dispose();
});

test("a fresh upward user intent still cancels a just-requested jump before its frame", () => {
  const f = fixture();
  f.emit("wheel", { deltaY: -1 });
  f.controller.jumpToLatest();
  f.emit("wheel", { deltaY: -.1 });
  f.scroll(799.9);
  f.scroller.scrollHeight = 1_200;
  f.flush();
  assert.equal(f.scroller.scrollTop, 799.9);
  assert.deepEqual(f.changes, [false, true, false]);
  f.controller.dispose();
});

test("content without overflow keeps following as it grows into a scrollable answer", () => {
  const f = fixture();
  f.scroller.scrollHeight = 100;
  f.scroller.scrollTop = 0;
  f.emit("wheel", { deltaY: -1 });
  f.flush();
  assert.deepEqual(f.changes, []);
  f.scroller.scrollHeight = 350;
  f.resize.trigger();
  f.flush();
  assert.equal(f.scroller.scrollTop, 150);
  f.controller.dispose();
});

test("new message elements are observed; teardown removes observers, listeners and pending frames", () => {
  const f = fixture();
  const previous = f.scroller.children[0];
  const replacement = {};
  f.scroller.children = [replacement];
  f.mutation.trigger();
  assert.equal(f.resize.observed.has(previous), false);
  assert.equal(f.resize.observed.has(replacement), true);
  f.controller.dispose();
  assert.equal(f.frames.size, 0);
  assert.equal(f.resize.disconnected, true);
  assert.equal(f.mutation.disconnected, true);
  f.emit("wheel", { deltaY: -1 });
  f.emit("keydown", { key: "Home" });
  assert.deepEqual(f.changes, []);
});
