/*
  The one format a game's state travels in, shared by the server that produces it and the browser that
  applies it. It is imported from both sides, so what the server sends and what the client understands
  cannot drift apart.

  A change list is an array of operations:

    [path, value]   set the value at `path`
    [path]          delete whatever is at `path`

  and a path is an array of keys, so `[["players", "ann", "x"], 12]` sets `root.players.ann.x` to 12.
  The empty path is the whole document.

  Arrays are never addressed inside. Changing one element of an array sends the whole array, because a
  path into an array means nothing once the array has been reordered on one side and not the other.
  It also means `null` is an ordinary value, unlike JSON Merge Patch where it would mean "delete".
*/

const isObject = value => value !== null && typeof value === 'object';

export const applyChanges = (root, changes) => {
  let result = root;

  for(const change of changes){
    const [path, ...rest] = change;
    const isSet = rest.length > 0;

    if(!path.length){
      result = isSet ? structuredClone(rest[0]) : {};
      continue;
    }

    let current = result;
    let reachable = true;
    for(let i = 0; i < path.length - 1; i++){
      const key = path[i];
      if(!isObject(current[key])){
        if(!isSet){
          reachable = false;
          break;
        }
        current[key] = {};
      }
      current = current[key];
    }
    if(!reachable) continue;

    const last = path[path.length - 1];
    if(isSet) current[last] = structuredClone(rest[0]);
    else delete current[last];
  }

  return result;
};
