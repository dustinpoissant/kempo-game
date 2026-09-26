import Tracker from '../server/utils/live/Tracker.js';
import { applyChanges } from '../public/utils/changes.js';

/*
  The tracker and the change format are the two halves of state sync, and the property that matters is
  the one a player would notice: after any sequence of writes, applying what the tracker reports to a
  copy leaves the copy identical to the original.
*/

const expect = (condition, message) => {
  if(!condition) throw new Error(message);
};

const canonical = value => JSON.stringify(value, (key, inner) => (
  inner && typeof inner === 'object' && !Array.isArray(inner)
    ? Object.fromEntries(Object.keys(inner).sort().map(name => [name, inner[name]]))
    : inner
));

const same = (a, b) => canonical(a) === canonical(b);

const mulberry32 = seed => () => {
  seed |= 0;
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const KEYS = ['a', 'b', 'c', 'd', 'e'];

/* Picks a random object or array somewhere in the document, going through the proxy so writes are seen */
const pick = (root, random) => {
  let current = root;
  for(let depth = 0; depth < 4; depth++){
    const keys = Object.keys(current).filter(key => current[key] !== null && typeof current[key] === 'object');
    if(!keys.length || random() < 0.35) break;
    current = current[keys[Math.floor(random() * keys.length)]];
  }
  return current;
};

const randomValue = (random, depth = 0) => {
  const roll = random();
  if(depth > 2 || roll < 0.4) return Math.floor(random() * 100);
  if(roll < 0.5) return null;
  if(roll < 0.6) return 'text' + Math.floor(random() * 10);
  if(roll < 0.7) return random() < 0.5;
  if(roll < 0.85) return Array.from({ length: Math.floor(random() * 4) }, () => randomValue(random, depth + 1));
  const object = {};
  for(const key of KEYS.slice(0, Math.floor(random() * 4))) object[key] = randomValue(random, depth + 1);
  return object;
};

const mutate = (root, random) => {
  const target = pick(root, random);
  const roll = random();

  if(Array.isArray(target)){
    if(roll < 0.4) target.push(randomValue(random, 2));
    else if(roll < 0.6 && target.length) target.splice(Math.floor(random() * target.length), 1);
    else if(roll < 0.8 && target.length) target[Math.floor(random() * target.length)] = randomValue(random, 2);
    else target.reverse();
    return;
  }

  const key = KEYS[Math.floor(random() * KEYS.length)];
  if(roll < 0.7) target[key] = randomValue(random);
  else if(roll < 0.9) delete target[key];
  else if(typeof target[key] === 'object' && target[key] !== null) target[key][KEYS[Math.floor(random() * KEYS.length)]] = randomValue(random, 2);
};

export default {
  'after any sequence of writes, applying the reported changes to a copy makes the copy identical': async ({ pass }) => {
    for(let seed = 1; seed <= 300; seed++){
      const random = mulberry32(seed);
      const tracker = new Tracker({ a: { b: { c: 1 } }, list: [1, 2, { x: 1 }], d: 'start' });
      let mirror = tracker.snapshot();

      for(let round = 0; round < 12; round++){
        const writes = 1 + Math.floor(random() * 6);
        for(let i = 0; i < writes; i++) mutate(tracker.root, random);

        mirror = applyChanges(mirror, tracker.drain());
        expect(same(mirror, tracker.raw), `seed ${seed}, round ${round}: the copy diverged.\n copy: ${JSON.stringify(mirror)}\n real: ${JSON.stringify(tracker.raw)}`);
      }
    }
    pass('300 random sequences converge');
  },

  'many writes to one path cost one operation, and a write that changes nothing costs none': async ({ pass }) => {
    const tracker = new Tracker({ player: { x: 0 } });
    for(let i = 1; i <= 50; i++) tracker.root.player.x = i;
    const changes = tracker.drain();
    expect(changes.length === 1 && same(changes[0], [['player', 'x'], 50]), `expected one set of the final value, got ${JSON.stringify(changes)}`);

    tracker.root.player.x = 50;
    expect(!tracker.changed && tracker.drain().length === 0, 'writing the value that is already there is not a change');
    pass('coalescing');
  },

  'a write below another written path is folded into it': async ({ pass }) => {
    const tracker = new Tracker({ a: { b: 1 } });
    tracker.root.a.b = 2;
    tracker.root.a = { b: 3, c: 4 };
    tracker.root.a.b = 5;
    const changes = tracker.drain();
    expect(changes.length === 1 && same(changes[0], [['a'], { b: 5, c: 4 }]), `expected one set of a, got ${JSON.stringify(changes)}`);
    pass('descendants folded');
  },

  'deleting reports a delete, and deleting then recreating reports the final value': async ({ pass }) => {
    const tracker = new Tracker({ gone: 1, back: 1 });
    delete tracker.root.gone;
    delete tracker.root.back;
    tracker.root.back = 2;
    const changes = tracker.drain();
    expect(changes.some(change => same(change, [['gone']])), 'a deleted key should be reported as a delete');
    expect(changes.some(change => same(change, [['back'], 2])), 'a key deleted and set again should be reported with its final value');
    pass('deletes');
  },

  'an array is the unit of change: touching one element sends the whole array, wherever it is': async ({ pass }) => {
    const tracker = new Tracker({ inventory: [{ id: 1, n: 1 }, { id: 2, n: 5 }], nested: { rows: [[1, 2], [3, 4]] } });
    tracker.root.inventory[1].n = 6;
    tracker.root.nested.rows[0].push(9);
    const changes = tracker.drain();
    expect(changes.length === 2, `two arrays were touched, got ${JSON.stringify(changes)}`);
    expect(changes.some(change => same(change, [['inventory'], [{ id: 1, n: 1 }, { id: 2, n: 6 }]])), 'the whole inventory array should be sent');
    expect(changes.some(change => same(change, [['nested', 'rows'], [[1, 2, 9], [3, 4]]])), 'the outermost array containing the change should be sent');
    pass('arrays are atomic');
  },

  'null is an ordinary value, not a deletion': async ({ pass }) => {
    const tracker = new Tracker({ target: 'someone' });
    tracker.root.target = null;
    const changes = tracker.drain();
    expect(same(changes, [[['target'], null]]), `setting null should send null, got ${JSON.stringify(changes)}`);
    const applied = applyChanges({ target: 'someone' }, changes);
    expect(applied.target === null && 'target' in applied, 'and it should arrive as null');
    pass('null');
  },

  'a tracked object assigned somewhere else is copied, so two paths never share one object': async ({ pass }) => {
    const tracker = new Tracker({ a: { hp: 1 }, b: {} });
    let mirror = tracker.snapshot();
    tracker.root.b.copied = tracker.root.a;
    tracker.root.b.wrapped = { inner: tracker.root.a };
    mirror = applyChanges(mirror, tracker.drain());

    tracker.root.a.hp = 3;
    tracker.root.b.copied.hp = 2;
    mirror = applyChanges(mirror, tracker.drain());

    expect(tracker.raw.b.copied !== tracker.raw.a && tracker.raw.b.wrapped.inner !== tracker.raw.a, 'the stored values are copies, and never a proxy');
    expect(tracker.raw.a.hp === 3 && tracker.raw.b.copied.hp === 2 && tracker.raw.b.wrapped.inner.hp === 1, 'a write to one place does not change another');
    expect(same(mirror, tracker.raw), `the far side agrees, got ${JSON.stringify(mirror)}`);
    pass('assigning tracked objects');
  },

  'replacing the whole document sends it all, and changes are reported to the onChange callback': async ({ pass }) => {
    const seen = [];
    const tracker = new Tracker({ old: true }, { onChange: path => seen.push(path.join('.')) });
    tracker.root.x = 1;
    tracker.replace({ fresh: [1, 2] });
    expect(same(tracker.drain(), [[[], { fresh: [1, 2] }]]), 'the empty path replaces everything, and earlier writes are moot');
    expect(same(seen, ['x', '']), `onChange should hear each change, got ${JSON.stringify(seen)}`);
    expect(same(applyChanges({ old: true }, [[[], { fresh: [1, 2] }]]), { fresh: [1, 2] }), 'applying the empty path replaces the document');
    pass('replace');
  },

  'applying a change is safe when the path is not there': async ({ pass }) => {
    expect(same(applyChanges({}, [[['a', 'b', 'c']]]), {}), 'deleting below a missing parent is a no-op');
    expect(same(applyChanges({}, [[['a', 'b', 'c'], 1]]), { a: { b: { c: 1 } } }), 'setting below a missing parent creates it');
    expect(same(applyChanges({ a: 5 }, [[['a', 'b'], 1]]), { a: { b: 1 } }), 'setting below a non-object replaces it');

    const value = { list: [2] };
    const result = applyChanges({}, [[['x'], value]]);
    value.list.push(3);
    expect(same(result.x, { list: [2] }), 'the applied value must not share structure with the change that carried it');
    pass('apply edge cases');
  }
};
