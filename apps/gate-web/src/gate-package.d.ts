// `@gavel/gate` is the repository's CommonJS domain package and ships no types.
// Only the three submodules the browser genuinely needs are declared; importing
// the package root would drag in `settlement.js` and its `node:crypto`
// dependency, which has no business in a browser bundle.
//
// The real, checked surface is declared in `gate-domain.ts`, the only module
// allowed to import these; everything else goes through that shim.
declare module '@gavel/gate/src/markdown.js' {
  const markdown: unknown;
  export default markdown;
}
declare module '@gavel/gate/src/quote.js' {
  const quote: unknown;
  export default quote;
}
declare module '@gavel/gate/src/constants.js' {
  const constants: unknown;
  export default constants;
}
