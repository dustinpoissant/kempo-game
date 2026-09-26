/*
  Watches a JSON document for changes made through it, without the code making them having to say so.

  A game's module writes `session.live.players[id].x = 12` as it would to any object. The document
  handed to it is a proxy that notes which path was touched, and `drain()` turns those notes into the
  change list `public/utils/changes.js` applies on the other side. Reading the final value at drain
  time, rather than recording every write, is what makes ten writes to one path cost one operation.

  Only plain objects, arrays and JSON values belong in the document. Arrays are the unit of change
  for anything inside them: touching one element reports the whole array, which is the format's rule.

  Write through the document, not through a reference you kept to something you assigned into it: the
  tracker only hears about writes made via the proxy.
*/

const SEPARATOR = '\u0000';
const keyOf = path => path.join(SEPARATOR);
const clone = value => JSON.parse(JSON.stringify(value));
const isObject = value => value !== null && typeof value === 'object';

export default class Tracker {
  #root;
  #pending = new Map();
  #targets = new WeakMap();
  #proxies = new WeakMap();
  #onChange;

  constructor(root = {}, { onChange } = {}){
    this.#root = root;
    this.#onChange = onChange;
  }

  /*
    Access
  */

  get root(){
    return this.#wrap(this.#root, [], null);
  }

  get raw(){
    return this.#root;
  }

  get changed(){
    return this.#pending.size > 0;
  }

  snapshot = () => clone(this.#root);

  replace = (value) => {
    this.#root = this.#unwrap(value);
    this.#note([]);
  };

  /*
    Turns everything touched since the last drain into a change list. An operation on a path below
    another touched path is dropped, since the value it would send is already inside the one above.
  */
  drain = () => {
    const paths = [...this.#pending.values()].sort((a, b) => a.length - b.length);
    this.#pending.clear();

    const kept = new Set();
    const changes = [];

    for(const path of paths){
      let covered = false;
      for(let i = 0; i < path.length; i++){
        if(kept.has(keyOf(path.slice(0, i)))){
          covered = true;
          break;
        }
      }
      if(covered) continue;

      kept.add(keyOf(path));
      changes.push(this.#read(path));
    }

    return changes;
  };

  /*
    Internals
  */

  #read = (path) => {
    if(!path.length) return [[], clone(this.#root)];

    let current = this.#root;
    for(let i = 0; i < path.length - 1; i++){
      current = current?.[path[i]];
      if(!isObject(current)) return [path];
    }

    const last = path[path.length - 1];
    if(!Object.hasOwn(current, last) || current[last] === undefined) return [path];
    return [path, clone(current[last])];
  };

  #note = (path) => {
    this.#pending.set(keyOf(path), path);
    this.#onChange?.(path);
  };

  /*
    A tracked object assigned somewhere else is copied, never aliased. Two paths to one object would let a
    write through one change the other with only the first reported, and the copy on the far side would
    quietly disagree. It applies to a tracked object anywhere inside the value being assigned.
  */
  #unwrap = (value) => {
    if(!isObject(value)) return value;
    const target = this.#targets.get(value);
    if(target) return clone(target);
    for(const key of Object.keys(value)){
      const inner = value[key];
      if(isObject(inner)) value[key] = this.#unwrap(inner);
    }
    return value;
  };

  #wrap = (target, path, arrayPath) => {
    const key = keyOf(path);
    let byPath = this.#proxies.get(target);
    if(!byPath){
      byPath = new Map();
      this.#proxies.set(target, byPath);
    }
    const existing = byPath.get(key);
    if(existing) return existing;

    const reportPath = property => arrayPath ?? (Array.isArray(target) ? path : [...path, property]);

    const proxy = new Proxy(target, {
      get: (object, property) => {
        const value = object[property];
        if(typeof property === 'symbol' || !isObject(value)) return value;
        const childPath = [...path, property];
        return this.#wrap(value, childPath, arrayPath ?? (Array.isArray(value) ? childPath : null));
      },

      set: (object, property, value) => {
        if(typeof property === 'symbol'){
          object[property] = value;
          return true;
        }
        const raw = this.#unwrap(value);
        if(Object.hasOwn(object, property) && object[property] === raw) return true;
        object[property] = raw;
        this.#note(reportPath(property));
        return true;
      },

      deleteProperty: (object, property) => {
        if(typeof property === 'symbol') return delete object[property];
        if(!Object.hasOwn(object, property)) return true;
        delete object[property];
        this.#note(reportPath(property));
        return true;
      }
    });

    this.#targets.set(proxy, target);
    byPath.set(key, proxy);
    return proxy;
  };
}
