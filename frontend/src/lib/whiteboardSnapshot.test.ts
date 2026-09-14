import { describe, it, expect } from 'vitest';
import { countShapes } from './whiteboardSnapshot';

const shape = (id: string) => ({ id, typeName: 'shape', type: 'geo' });
const page = { id: 'page:1', typeName: 'page', name: 'Page 1' };
const camera = { id: 'camera:1', typeName: 'camera', x: 0, y: 0, z: 1 };

describe('countShapes', () => {
  it('counts shapes in a flat { store } snapshot', () => {
    const snapshot = {
      store: { 'page:1': page, 'shape:a': shape('shape:a'), 'shape:b': shape('shape:b') },
      schema: {},
    };
    expect(countShapes(snapshot)).toBe(2);
  });

  it('counts shapes in a { document: { store } } snapshot', () => {
    const snapshot = {
      document: { store: { 'shape:a': shape('shape:a') }, schema: {} },
      session: {},
    };
    expect(countShapes(snapshot)).toBe(1);
  });

  it('returns 0 for an empty store', () => {
    expect(countShapes({ store: {} })).toBe(0);
    expect(countShapes({ document: { store: {} } })).toBe(0);
  });

  it('returns 0 when the store holds only non-shape records', () => {
    // The state a never-touched board saves: a page, a camera, an instance, but nothing drawn.
    expect(countShapes({ store: { 'page:1': page, 'camera:1': camera } })).toBe(0);
  });

  it('ignores non-shape records mixed in with shapes', () => {
    const snapshot = {
      store: {
        'page:1': page,
        'camera:1': camera,
        'shape:a': shape('shape:a'),
        'instance:1': { id: 'instance:1', typeName: 'instance' },
        'shape:b': shape('shape:b'),
        'shape:c': shape('shape:c'),
      },
    };
    expect(countShapes(snapshot)).toBe(3);
  });

  it('returns 0 for malformed or missing input instead of throwing', () => {
    expect(countShapes(null)).toBe(0);
    expect(countShapes(undefined)).toBe(0);
    expect(countShapes('not a snapshot')).toBe(0);
    expect(countShapes(42)).toBe(0);
    expect(countShapes([])).toBe(0);
    expect(countShapes({})).toBe(0);
    expect(countShapes({ store: 'nope' })).toBe(0);
    expect(countShapes({ document: null })).toBe(0);
    expect(countShapes({ store: { bad: null, worse: 7, 'shape:a': shape('shape:a') } })).toBe(1);
  });
});
