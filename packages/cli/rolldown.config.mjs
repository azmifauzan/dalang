// Inlines the private @dalang/* workspace packages so the published tarball is self-contained.
// Third-party packages stay external and are installed from `dependencies`.
export default {
  input: 'dist/cli.js',
  platform: 'node',
  external: [/^node:/, /^(?!\.|\/|@dalang\/)[^:]+$/],
  output: { file: 'bundle/cli.js', format: 'esm' },
};
