// Allow importing `.txt` files as raw strings. tsup/esbuild is configured
// (see tsup.config.ts `loader: { '.txt': 'text' }`) to embed them at build
// time, so the runtime value is the file's contents.
declare module '*.txt' {
  const content: string;
  export default content;
}
