import Manager from './Manager.js';

/*
  One manager per process, held on a Symbol.for global rather than in module scope. kempo can be
  resolved twice in one process (a symlinked checkout during development, a hoisted copy beside a nested
  one), and the routes, the hooks and the SDK must all see the same running games.
*/
const KEY = Symbol.for('kempo.game.manager');

export default () => {
  if(!globalThis[KEY]) globalThis[KEY] = new Manager();
  return globalThis[KEY];
};
