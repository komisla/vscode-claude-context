import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('webpack production builds do not emit source maps', async () => {
  const { default: createWebpackConfig } = (await import(
    pathToFileURL(path.join(process.cwd(), 'webpack.config.js')).href
  )) as {
    readonly default: (
      env?: unknown,
      argv?: { readonly mode?: string }
    ) => { readonly devtool: string | false };
  };

  const productionConfig = createWebpackConfig({}, { mode: 'production' });
  const developmentConfig = createWebpackConfig({}, { mode: 'development' });

  assert.equal(productionConfig.devtool, false);
  assert.equal(developmentConfig.devtool, 'hidden-source-map');
});
