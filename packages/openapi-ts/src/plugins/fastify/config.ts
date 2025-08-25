import { definePluginConfig } from '../shared/utils/config';
import { handler } from './plugin';
import type { FastifyPlugin } from './types';

export const defaultConfig: FastifyPlugin['Config'] = {
  config: {
    exportFromIndex: false,
  },
  dependencies: ['@hey-api/typescript'],
  handler,
  name: 'fastify',
  output: 'fastify',
};

/**
 * Type helper for `fastify` plugin, returns {@link Plugin.Config} object
 */
export const defineConfig = definePluginConfig(defaultConfig);
