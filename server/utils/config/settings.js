import { getSetting } from 'kempo/server/sdk.js';

export const OWNER = 'kempo-game';

/*
  What a site can tune without a deploy. The declared defaults live in kempo-config.json; these are
  the fallbacks used when a setting has somehow not been created yet, so the two must agree.
*/
export const DEFAULTS = {
  autosaveSeconds: 30,
  idleSeconds: 30,
  maxStateBytes: 5000000,
  maxSettingsBytes: 100000,
  maxGamesPerUser: 50,
};

const number = async (name, fallback) => {
  const [, stored] = await getSetting(OWNER, name, fallback);
  const value = Number(stored);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export const readConfig = async () => ({
  autosaveSeconds: await number('autosave_seconds', DEFAULTS.autosaveSeconds),
  idleSeconds: await number('idle_seconds', DEFAULTS.idleSeconds),
  maxStateBytes: await number('max_state_bytes', DEFAULTS.maxStateBytes),
  maxSettingsBytes: await number('max_settings_bytes', DEFAULTS.maxSettingsBytes),
  maxGamesPerUser: await number('max_games_per_user', DEFAULTS.maxGamesPerUser),
});
