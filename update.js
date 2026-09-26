import install from './install.js';

/*
  Updating is the same job as installing: make sure the indexes exist and otherwise leave everything
  alone. New settings, permissions and groups are added by kempo's own declarative diff before this
  runs, and existing values are never overwritten.
*/
export default async () => {
  await install();
};
