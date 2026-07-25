import '@testing-library/jest-dom/vitest';

// Keep test output focused on assertion failures rather than framework noise.
// Anything a test genuinely needs to assert on should be asserted, not printed.
const SILENCED = [/Warning: ReactDOM.render/, /not wrapped in act/];

const originalError = console.error;
console.error = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === 'string' && SILENCED.some((pattern) => pattern.test(first))) return;
  originalError(...args);
};
