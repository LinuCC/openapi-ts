export const clientDefaultConfig = {
  baseUrl: true,
  bundle: true,
  exportFromIndex: false,
} as const;

export const clientDefaultMeta = {
  dependencies: ['@hey-api/typescript'],
  output: 'client',
  tags: ['client'],
} as const;
