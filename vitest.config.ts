import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

/**
 * Two projects, deliberately.
 *
 * The core analysis engine is pure TypeScript and runs in `node`, where it is
 * fast. Only component tests pay for jsdom, so a full run of several hundred
 * engine tests is not slowed down by a DOM none of them touch.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/core/**/*.ts', 'src/lib/**/*.ts'],
      exclude: ['**/*.test.ts', '**/types.ts', '**/index.ts', 'src/core/testing/**'],
      thresholds: {
        lines: 65,
        functions: 65,
        statements: 65,
        branches: 60,
      },
    },

    projects: [
      {
        plugins: [tsconfigPaths()],
        test: {
          name: 'core',
          environment: 'node',
          globals: true,
          include: [
            'src/**/*.test.ts',
            'tests/unit/**/*.test.ts',
            'tests/integration/**/*.test.ts',
          ],
          exclude: ['node_modules/**', '.next/**', 'tests/e2e/**'],
        },
      },
      {
        plugins: [tsconfigPaths(), react()],
        test: {
          name: 'ui',
          environment: 'jsdom',
          globals: true,
          include: ['src/**/*.test.tsx', 'tests/unit/**/*.test.tsx'],
          exclude: ['node_modules/**', '.next/**', 'tests/e2e/**'],
          setupFiles: ['./tests/setup.ts'],
        },
      },
    ],
  },
});
