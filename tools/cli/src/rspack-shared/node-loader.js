import { parse } from 'node:path';

export const raw = true;
/**
 * @type {import('webpack').LoaderDefinitionFunction}
 */
export default function loader(content) {
  const name = parse(this.resourcePath).base;
  this.emitFile(name, content);

  // Output CommonJS module.exports instead of ESM export default.
  // ESM `export default variable` causes rspack to generate a live-binding
  // getter placed BEFORE the let-declaration, causing TDZ on Node.js v22.
  // CJS module.exports avoids this issue entirely.
  return `
    'use strict';
    var _require = require;
    module.exports = _require('./${name}');
  `;
}
