import { parse } from 'node:path';

export const raw = true;
/**
 * @type {import('webpack').LoaderDefinitionFunction}
 */
export default function loader(content) {
  const name = parse(this.resourcePath).base;
  this.emitFile(name, content);

  // Use var to prevent TDZ. Use a custom function name __req instead of require
  // to prevent Rspack from parsing and recursively bundling the .node files.
  return `
    import { createRequire as __createRequire } from 'node:module';
    var __req = __createRequire(import.meta.url);
    var __binding = __req('./${name}');
    export default __binding;
  `;
}
