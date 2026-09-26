import { join, resolve, sep } from 'path';
import { pathToFileURL } from 'url';
import { getEnabledExtensions } from 'kempo/server/utils/extensions/scopeCache.js';

/*
  Game types.

  A game is its own kempo (CMS) extension, and it says what it is in its kempo-config.json:

    "game": { "types": [ { "name": "tic-tac-toe", "module": "./game.js", "minPlayers": 2, "maxPlayers": 2 } ] }

  kempo stores that config in the extension table when the extension is installed, so this reads it from
  there. Nothing has to be loaded at startup and nothing depends on the order extensions load in, which
  is the trap an imperative "register my game" call in the extension's own module would fall into: it
  could run after the first player connects. Disabling the extension makes its types disappear.

  A type's id is `<extension>:<name>`, the same shape as a realtime channel, so two extensions cannot
  collide on a name.

  The module is the game's rules. Every function in it is optional:

    onCreate({ settings, ownerId })          returns the state a new game starts with
    onLoad({ session })                      the game is going live; rebuild `live` from `state` here
    onConnect({ session, player })           a player's first connection opened
    onDisconnect({ session, player })        a player's last connection closed
    onInput({ session, player, input })      a player sent input; returns the reply to that player
    onTick({ session, dt })                  the fixed-rate step, only for a type with a tickRate
    onSave({ session, save })                edit `save.state` to fold anything from `live` into what is saved
    onEnd({ session })                       the game stopped being live

  It is loaded once and kept in memory. Handling input never touches the database or the disk.
*/

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_TICK_RATE = 60;
const MAX_PLAYERS_LIMIT = 200;

const REPORTED = Symbol.for('kempo.game.reportedTypes');
if(!globalThis[REPORTED]) globalThis[REPORTED] = new Set();

const report = (message) => {
  if(globalThis[REPORTED].has(message)) return;
  globalThis[REPORTED].add(message);
  console.warn(`[kempo-game] ${message}`);
};

const modulePath = (extension, relative) => {
  if(typeof relative !== 'string' || !relative.startsWith('./')) return null;
  const root = join(process.cwd(), 'node_modules', extension);
  const full = resolve(root, relative);
  return full.startsWith(root + sep) ? full : null;
};

const integer = (value, fallback, min, max) => {
  if(value === undefined) return fallback;
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
};

/*
  A type that cannot be honoured is left out with a warning rather than half-working: a tick rate that is
  not a number, a module path that leaves the package. Better a missing type than a game that quietly
  behaves differently to what its extension declared.
*/
const normalise = (extension, raw) => {
  if(!raw || typeof raw.name !== 'string' || !NAME_PATTERN.test(raw.name)){
    report(`${extension} declares a game type with no valid name`);
    return null;
  }

  const id = `${extension}:${raw.name}`;
  const path = modulePath(extension, raw.module);
  if(!path){
    report(`${id} was left out: "module" must be a path inside the package that starts with ./`);
    return null;
  }

  const minPlayers = integer(raw.minPlayers, 1, 1, MAX_PLAYERS_LIMIT);
  const maxPlayers = integer(raw.maxPlayers, 1, 1, MAX_PLAYERS_LIMIT);
  const tickRate = integer(raw.tickRate, 0, 0, MAX_TICK_RATE);
  const autosaveSeconds = raw.autosaveSeconds === undefined ? null : integer(raw.autosaveSeconds, null, 0, 86400);
  const idleSeconds = raw.idleSeconds === undefined ? null : integer(raw.idleSeconds, null, 0, 86400);
  const removeAfterSeconds = integer(raw.removeAfterSeconds, 0, 0, 604800);

  if([minPlayers, maxPlayers, tickRate, removeAfterSeconds].includes(null) || (raw.autosaveSeconds !== undefined && autosaveSeconds === null) || (raw.idleSeconds !== undefined && idleSeconds === null)){
    report(`${id} was left out: a numeric option is not a whole number in range (tickRate 0 to ${MAX_TICK_RATE}, players 1 to ${MAX_PLAYERS_LIMIT})`);
    return null;
  }
  if(minPlayers > maxPlayers){
    report(`${id} was left out: minPlayers is greater than maxPlayers`);
    return null;
  }
  if(raw.defaultSettings !== undefined && (typeof raw.defaultSettings !== 'object' || raw.defaultSettings === null || Array.isArray(raw.defaultSettings))){
    report(`${id} was left out: defaultSettings must be an object`);
    return null;
  }

  return {
    id,
    extension,
    name: raw.name,
    label: typeof raw.label === 'string' && raw.label ? raw.label : raw.name,
    description: typeof raw.description === 'string' ? raw.description : '',
    modulePath: path,
    minPlayers,
    maxPlayers,
    tickRate,
    autosaveSeconds,
    idleSeconds,
    removeAfterSeconds,
    allowPlayerSave: raw.allowPlayerSave === true,
    defaultSettings: raw.defaultSettings || {},
  };
};

export const listTypes = async () => {
  const extensions = await getEnabledExtensions();
  const types = [];
  for(const extension of extensions){
    const declared = extension.kempo?.game?.types;
    if(!Array.isArray(declared)) continue;
    for(const raw of declared){
      const type = normalise(extension.name, raw);
      if(type) types.push(type);
    }
  }
  return types;
};

export const getType = async (id) => {
  if(typeof id !== 'string') return null;
  return (await listTypes()).find(type => type.id === id) || null;
};

/*
  Modules
*/

const MODULES = Symbol.for('kempo.game.modules');
if(!globalThis[MODULES]) globalThis[MODULES] = new Map();

export const clearModuleCache = () => globalThis[MODULES].clear();

/*
  Throws when the file cannot be imported, so the caller can tell "this game has no rules" from "its rules
  are broken", and report the second instead of treating the game as having none.
*/
export const loadModule = async (type) => {
  const cache = globalThis[MODULES];
  if(cache.has(type.modulePath)) return cache.get(type.modulePath);

  const loaded = await import(pathToFileURL(type.modulePath).href);
  const module = loaded.default && typeof loaded.default === 'object' ? { ...loaded, ...loaded.default } : loaded;
  cache.set(type.modulePath, module);
  return module;
};
