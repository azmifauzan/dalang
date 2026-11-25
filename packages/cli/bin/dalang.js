#!/usr/bin/env node
// Terminals such as Ptyxis append the foreground command to the tab title; show "dalang", not
// "node /full/path/to/bin/dalang".
process.title = 'dalang';
// React picks its build from NODE_ENV when it is first loaded; the development build makes every
// terminal-room keystroke several times slower. Load the app with the production build, then
// restore the variable so agent CLIs, `npm install`, and verify commands see the user's own value.
const userNodeEnv = process.env.NODE_ENV;
if (userNodeEnv === undefined) process.env.NODE_ENV = 'production';
const { main } = await import('../bundle/cli.js');
if (userNodeEnv === undefined) delete process.env.NODE_ENV;

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
