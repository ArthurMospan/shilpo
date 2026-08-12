/**
 * Drives a horizontal strip sideways ourselves instead of asking the platform to.
 *
 * Native `overflow-x` scrolling was the wrong thing to depend on, and it failed
 * on both clients at once for two unrelated reasons. On desktop it never had a
 * chance: dragging with a mouse does not scroll an overflow container in any
 * browser — that needs the scrollbar or a wheel, and the scrollbar is hidden
 * here by design. On the phone the strip moved and sprang back, which is the
 * native scroller and something else both claiming one gesture and neither
 * finishing it.
 *
 * Owning the gesture removes the whole class of problem: on `pointerdown` we
 * capture the pointer, so nothing can take it mid-drag, and we set `scrollLeft`
 * directly, so there is no momentum or snap to fight. Touch, mouse and pen all
 * arrive as the same events, which is why one path covers the phone and the
 * desktop that were failing differently.
 *
 * The axis is decided once per gesture and never revisited: the first movement
 * past the threshold says whether the gesture is ours or the page's, and a
 * vertical answer means we let go entirely so the page scrolls as it always did.
 * The strip's `touch-action: pan-y` is the other half of that bargain.
 */

/** Past this much movement the guest is dragging the strip, not tapping a card. */
export const DRAG_THRESHOLD_PX = 6;

type Axis = 'undecided' | 'horizontal' | 'vertical';

export function attachDragScroll(strip: HTMLElement): () => void {
    let pointerId = -1;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let axis: Axis = 'undecided';
    let dragged = false;

    const release = (): void => {
        if (pointerId !== -1 && strip.hasPointerCapture?.(pointerId)) {
            strip.releasePointerCapture(pointerId);
        }
        pointerId = -1;
        axis = 'undecided';
    };

    const onPointerDown = (event: PointerEvent): void => {
        // A second finger means a pinch, which is not ours to interpret.
        if (pointerId !== -1) return release();
        pointerId = event.pointerId;
        startX = event.clientX;
        startY = event.clientY;
        startLeft = strip.scrollLeft;
        axis = 'undecided';
        dragged = false;
    };

    const onPointerMove = (event: PointerEvent): void => {
        if (event.pointerId !== pointerId) return;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;

        if (axis === 'undecided') {
            if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
            axis = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
            // The page still owns every vertical gesture, including ones that
            // begin on a product card.
            if (axis === 'vertical') return release();
            strip.setPointerCapture?.(pointerId);
        }
        if (axis !== 'horizontal') return;

        dragged = true;
        strip.scrollLeft = startLeft - dx;
        // Only now, once the gesture is certainly a drag: doing this any earlier
        // would swallow the tap that chooses a product.
        event.preventDefault();
    };

    /** A drag that ends on a card must not also choose that card. */
    const onClick = (event: MouseEvent): void => {
        if (!dragged) return;
        event.preventDefault();
        event.stopPropagation();
        dragged = false;
    };

    strip.addEventListener('pointerdown', onPointerDown as EventListener);
    strip.addEventListener('pointermove', onPointerMove as EventListener);
    strip.addEventListener('pointerup', release);
    strip.addEventListener('pointercancel', release);
    strip.addEventListener('click', onClick as EventListener, true);

    return () => {
        strip.removeEventListener('pointerdown', onPointerDown as EventListener);
        strip.removeEventListener('pointermove', onPointerMove as EventListener);
        strip.removeEventListener('pointerup', release);
        strip.removeEventListener('pointercancel', release);
        strip.removeEventListener('click', onClick as EventListener, true);
    };
}
