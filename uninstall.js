import getManager from './server/utils/live/getManager.js';

/*
  Stops every running game first, saving each, since kempo drops this extension's tables straight
  afterwards and a save landing mid-drop is an error in the log for no reason.

  What is dropped is every game and every membership. That is this extension's data, and a game
  extension built on top of it will lose its saved games with it, which is worth a warning to whoever
  is uninstalling.
*/
export default async () => {
  await getManager().shutdown();
};
