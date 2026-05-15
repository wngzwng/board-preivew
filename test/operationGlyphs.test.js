import test from 'node:test';
import assert from 'node:assert/strict';
import {
  operationsToGlyphString,
  BOARD_OP_GLYPH,
} from '../src/board/operationGlyphs.js';

test('operationsToGlyphString', () => {
  assert.equal(
    operationsToGlyphString([
      { type: 'rotate_left' },
      { type: 'mirror_x' },
      { type: 'flip_z' },
    ]),
    'LXZ',
  );
  assert.equal(Object.keys(BOARD_OP_GLYPH).length, 5);
});
