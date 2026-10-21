import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom has no PointerEvent, and the switch component dispatches one when it is clicked. A real
// browser has it, so a test that fell over here would be reporting jsdom's gap, not a fault in the
// product. MouseEvent carries everything the component reads.
if (typeof window.PointerEvent !== 'function') {
  window.PointerEvent = class PointerEvent extends window.MouseEvent {
    constructor(type, params = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
      this.pointerType = params.pointerType ?? 'mouse';
    }
  };
  globalThis.PointerEvent = window.PointerEvent;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // Tests that put the page at a ?t= address put it back, so the next test starts at a bare URL.
  window.history.replaceState(null, '', '/');
});
