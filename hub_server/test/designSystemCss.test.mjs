import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Rules of the product's shared stylesheet that no component test can see, because component tests run without CSS.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the design system\'s button reset is in the base layer, so a button\'s own background and border are not overridden by it', () => {
  const source = fs.readFileSync(path.join(root, 'design-system', 'css', 'components.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  // Walk the file keeping the stack of open at-rules; find the rule whose selector is exactly `button` and say what it sits inside.
  const stack = [];
  let head = '';
  let found = null;
  for (const ch of source) {
    if (ch === '{') {
      const selector = head.trim();
      stack.push(selector);
      if (selector === 'button') found = stack.slice(0, -1);
      head = '';
    } else if (ch === '}') {
      stack.pop();
      head = '';
    } else if (ch === ';') {
      head = '';
    } else {
      head += ch;
    }
  }
  assert.ok(found, 'the file has a rule for button');
  assert.ok(found.includes('@layer base'), `the reset must be inside @layer base, but sits in: ${JSON.stringify(found)}`);
});
