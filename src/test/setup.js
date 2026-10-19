import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // Tests that put the page at a ?t= address put it back, so the next test starts at a bare URL.
  window.history.replaceState(null, '', '/');
});
