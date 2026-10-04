/**
 * @jest-environment node
 */
import { serializeData } from '../src/renderer/utils/serialization';

describe('serializeData ancestor-only cycles', () => {
  test('serializes sibling shared references instead of marking them circular', () => {
    const shared = { n: 1 };
    const tree = { a: shared, b: shared };
    const out = serializeData(tree);
    expect(out.a).toEqual({ n: 1 });
    expect(out.b).toEqual({ n: 1 });
  });

  test('still replaces true ancestor cycles', () => {
    /** @type {any} */
    const node = { n: 1 };
    node.self = node;
    const out = serializeData(node);
    expect(out.self).toBe('[Circular]');
  });

  test('serializes array items without flattening ancestors', () => {
    const files = [
      { path: '/file1.pdf', name: 'file1.pdf' },
      { path: '/file2.pdf', name: 'file2.pdf' }
    ];
    const out = serializeData(files);
    expect(out).toEqual([
      { path: '/file1.pdf', name: 'file1.pdf' },
      { path: '/file2.pdf', name: 'file2.pdf' }
    ]);
  });
});
