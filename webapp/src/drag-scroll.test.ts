import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachDragScroll, DRAG_THRESHOLD_PX } from './drag-scroll';

/**
 * The strip as the browser hands it to us: something that records listeners,
 * owns a `scrollLeft`, and can capture a pointer. Nothing here needs a real DOM
 * — what is under test is which gesture we claim and what we do with it.
 */
function fakeStrip() {
    const listeners = new Map<string, Function[]>();
    let captured = -1;
    const strip = {
        scrollLeft: 0,
        addEventListener(type: string, handler: Function) {
            listeners.set(type, [...(listeners.get(type) || []), handler]);
        },
        removeEventListener(type: string, handler: Function) {
            listeners.set(type, (listeners.get(type) || []).filter(one => one !== handler));
        },
        setPointerCapture(id: number) { captured = id; },
        releasePointerCapture() { captured = -1; },
        hasPointerCapture(id: number) { return captured === id; },
    };
    const fire = (type: string, event: any): void => {
        (listeners.get(type) || []).forEach(handler => handler(event));
    };
    return {
        strip,
        fire,
        get captured() { return captured; },
        get types() { return [...listeners.keys()].filter(type => (listeners.get(type) || []).length); },
    };
}

function pointer(x: number, y: number, id = 1) {
    let defaultPrevented = false;
    return {
        pointerId: id, clientX: x, clientY: y,
        preventDefault() { defaultPrevented = true; },
        get defaultPrevented() { return defaultPrevented; },
    };
}

function click() {
    let prevented = false;
    let stopped = false;
    return {
        preventDefault() { prevented = true; },
        stopPropagation() { stopped = true; },
        get prevented() { return prevented; },
        get stopped() { return stopped; },
    };
}

test('a sideways drag moves the strip by exactly the distance dragged', () => {
    const { strip, fire } = fakeStrip();
    attachDragScroll(strip as unknown as HTMLElement);
    strip.scrollLeft = 40;

    fire('pointerdown', pointer(200, 100));
    fire('pointermove', pointer(160, 102));
    assert.equal(strip.scrollLeft, 80, 'dragging 40px left scrolls 40px right');
    fire('pointermove', pointer(120, 104));
    assert.equal(strip.scrollLeft, 120, 'and it keeps tracking the finger, not the last step');
});

test('the pointer is captured, so nothing can take the gesture mid-drag', () => {
    const board = fakeStrip();
    attachDragScroll(board.strip as unknown as HTMLElement);

    board.fire('pointerdown', pointer(200, 100));
    assert.equal(board.captured, -1, 'not before we know it is a drag');
    board.fire('pointermove', pointer(150, 100));
    assert.equal(board.captured, 1);
    board.fire('pointerup', pointer(150, 100));
    assert.equal(board.captured, -1, 'and it is given back at the end');
});

test('a vertical gesture is left entirely to the page', () => {
    const board = fakeStrip();
    attachDragScroll(board.strip as unknown as HTMLElement);

    board.fire('pointerdown', pointer(200, 100));
    board.fire('pointermove', pointer(202, 160));
    assert.equal(board.strip.scrollLeft, 0, 'the strip must not creep sideways while the page scrolls');
    assert.equal(board.captured, -1, 'and we never took the pointer');
});

test('the axis is decided once and never revisited', () => {
    // A thumb arcs. Having answered "vertical", a later sideways component must
    // not suddenly start dragging the strip out from under the page scroll.
    const board = fakeStrip();
    attachDragScroll(board.strip as unknown as HTMLElement);

    board.fire('pointerdown', pointer(200, 100));
    board.fire('pointermove', pointer(202, 160));
    board.fire('pointermove', pointer(120, 170));
    assert.equal(board.strip.scrollLeft, 0);
});

test('a movement below the threshold is still a tap, not a drag', () => {
    const board = fakeStrip();
    attachDragScroll(board.strip as unknown as HTMLElement);

    board.fire('pointerdown', pointer(200, 100));
    board.fire('pointermove', pointer(200 - (DRAG_THRESHOLD_PX - 1), 100));
    assert.equal(board.strip.scrollLeft, 0);

    const tap = click();
    board.fire('click', tap);
    assert.equal(tap.prevented, false, 'choosing a product must survive an unsteady finger');
});

test('a drag that ends on a card does not also choose that card', () => {
    const board = fakeStrip();
    attachDragScroll(board.strip as unknown as HTMLElement);

    board.fire('pointerdown', pointer(200, 100));
    board.fire('pointermove', pointer(120, 100));
    board.fire('pointerup', pointer(120, 100));

    const tap = click();
    board.fire('click', tap);
    assert.equal(tap.prevented, true);
    assert.equal(tap.stopped, true);
});

test('the click after a drag is suppressed once, not forever', () => {
    const board = fakeStrip();
    attachDragScroll(board.strip as unknown as HTMLElement);

    board.fire('pointerdown', pointer(200, 100));
    board.fire('pointermove', pointer(120, 100));
    board.fire('pointerup', pointer(120, 100));
    board.fire('click', click());

    const later = click();
    board.fire('click', later);
    assert.equal(later.prevented, false, 'the next honest tap must go through');
});

test('the browser is told the horizontal gesture is spoken for', () => {
    const board = fakeStrip();
    attachDragScroll(board.strip as unknown as HTMLElement);

    board.fire('pointerdown', pointer(200, 100));
    const move = pointer(120, 100);
    board.fire('pointermove', move);
    assert.equal(move.defaultPrevented, true, 'or the native scroller starts a fling we then fight');
});

test('a second finger is not read as a drag', () => {
    const board = fakeStrip();
    attachDragScroll(board.strip as unknown as HTMLElement);

    board.fire('pointerdown', pointer(200, 100, 1));
    board.fire('pointerdown', pointer(300, 100, 2));
    board.fire('pointermove', pointer(240, 100, 2));
    assert.equal(board.strip.scrollLeft, 0, 'a pinch is not ours to interpret');
});

test('a cancelled gesture releases everything', () => {
    const board = fakeStrip();
    attachDragScroll(board.strip as unknown as HTMLElement);

    board.fire('pointerdown', pointer(200, 100));
    board.fire('pointermove', pointer(120, 100));
    board.fire('pointercancel', pointer(120, 100));
    assert.equal(board.captured, -1);

    board.fire('pointermove', pointer(60, 100));
    assert.equal(board.strip.scrollLeft, 80, 'and stops following a pointer it no longer holds');
});

test('detaching removes every listener it added', () => {
    const board = fakeStrip();
    const detach = attachDragScroll(board.strip as unknown as HTMLElement);
    assert.deepEqual(board.types.sort(), ['click', 'pointercancel', 'pointerdown', 'pointermove', 'pointerup']);
    detach();
    assert.deepEqual(board.types, []);
});
