import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    // Default to node; individual files opt into jsdom via a docblock comment.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
