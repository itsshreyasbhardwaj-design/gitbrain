import { describe, expect, it } from 'vitest';

import { analyzeEnvVars } from './env';
import { makeSnapshot } from '../testing/fixtures';

describe('analyzeEnvVars', () => {
  it('finds JavaScript and TypeScript accessor forms', () => {
    const { envVars } = analyzeEnvVars(
      makeSnapshot({
        'src/a.ts': [
          'const a = process.env.API_URL;',
          "const b = process.env['SESSION_SECRET'];",
          'const c = import.meta.env.VITE_PUBLIC_KEY;',
        ].join('\n'),
      }),
    );

    expect(envVars.map((entry) => entry.name)).toEqual([
      'API_URL',
      'SESSION_SECRET',
      'VITE_PUBLIC_KEY',
    ]);
  });

  it('finds accessor forms across other ecosystems', () => {
    const { envVars } = analyzeEnvVars(
      makeSnapshot({
        'app/main.py': [
          "url = os.environ['DATABASE_URL']",
          "port = os.environ.get('PORT')",
          "mode = os.getenv('RUN_MODE')",
        ].join('\n'),
        'app/config.rb': "key = ENV['RAILS_MASTER_KEY']",
        'app/Main.java': 'String v = System.getenv("JAVA_HOME_OVERRIDE");',
        'app/main.rs': 'let v = std::env::var("RUST_LOG_LEVEL").unwrap();',
        'app/main.go': 'v := os.Getenv("GO_REGION")',
        'app/index.php': "$v = $_ENV['PHP_APP_KEY'];",
      }),
    );

    expect(envVars.map((entry) => entry.name).sort()).toEqual([
      'DATABASE_URL',
      'GO_REGION',
      'JAVA_HOME_OVERRIDE',
      'PHP_APP_KEY',
      'PORT',
      'RAILS_MASTER_KEY',
      'RUN_MODE',
      'RUST_LOG_LEVEL',
    ]);
  });

  it('finds shell interpolation in Compose files and Dockerfiles', () => {
    const { envVars } = analyzeEnvVars(
      makeSnapshot({
        'docker-compose.yml': [
          'services:',
          '  web:',
          '    image: app:${IMAGE_TAG}',
          '    command: run --db ${DB_HOST:-localhost}',
        ].join('\n'),
        Dockerfile: 'FROM node\nRUN echo ${BUILD_CHANNEL}\n',
      }),
    );

    expect(envVars.map((entry) => entry.name).sort()).toEqual([
      'BUILD_CHANNEL',
      'DB_HOST',
      'IMAGE_TAG',
    ]);
  });

  it('excludes NODE_ENV', () => {
    const { envVars, undocumented } = analyzeEnvVars(
      makeSnapshot({ 'src/a.ts': 'const mode = process.env.NODE_ENV;' }),
    );

    expect(envVars).toEqual([]);
    expect(undocumented).toEqual([]);
  });

  it('treats a variable as documented when an env template declares it', () => {
    const { envVars, undocumented } = analyzeEnvVars(
      makeSnapshot({
        'src/a.ts': 'const a = process.env.API_URL;\nconst b = process.env.SECRET_SALT;',
        '.env.example': '# API base\nAPI_URL=https://example.test\n# SECRET_SALT=\n',
      }),
    );

    expect(envVars.find((entry) => entry.name === 'API_URL')?.documented).toBe(true);
    // Commented-out template entries still count: they tell you the name exists.
    expect(envVars.find((entry) => entry.name === 'SECRET_SALT')?.documented).toBe(true);
    expect(undocumented).toEqual([]);
  });

  it('accepts .env.sample, .env.template and .env.defaults as templates', () => {
    for (const name of ['.env.sample', '.env.template', '.env.defaults']) {
      const { undocumented } = analyzeEnvVars(
        makeSnapshot({
          'src/a.ts': 'const a = process.env.API_URL;',
          [name]: 'API_URL=x',
        }),
      );
      expect(undocumented).toEqual([]);
    }
  });

  it('treats a README mention as documentation', () => {
    const { envVars, undocumented } = analyzeEnvVars(
      makeSnapshot({
        'src/a.ts': 'const a = process.env.STRIPE_SECRET_KEY;',
        'README.md': '## Configuration\n\nSet `STRIPE_SECRET_KEY` before starting the server.\n',
      }),
    );

    expect(envVars[0]?.documented).toBe(true);
    expect(undocumented).toEqual([]);
  });

  it('treats a Compose environment block as documentation', () => {
    const { undocumented } = analyzeEnvVars(
      makeSnapshot({
        'src/a.ts': 'const a = process.env.REDIS_URL;\nconst b = process.env.QUEUE_NAME;',
        'docker-compose.yml': [
          'services:',
          '  web:',
          '    environment:',
          '      - REDIS_URL=redis://cache:6379',
          '      QUEUE_NAME: default',
          '  db:',
          '    image: postgres',
        ].join('\n'),
      }),
    );

    expect(undocumented).toEqual([]);
  });

  it('reads the inline Compose environment sequence form', () => {
    const { undocumented } = analyzeEnvVars(
      makeSnapshot({
        'src/a.ts': 'const a = process.env.FEATURE_FLAG;',
        'compose.yaml': 'services:\n  web:\n    environment: [FEATURE_FLAG=on]\n',
      }),
    );

    expect(undocumented).toEqual([]);
  });

  it('lists variables that are read but documented nowhere', () => {
    const { envVars, undocumented } = analyzeEnvVars(
      makeSnapshot({
        'src/a.ts': 'const a = process.env.API_URL;\nconst b = process.env.SHADOW_TOKEN;',
        '.env.example': 'API_URL=https://example.test\n',
      }),
    );

    expect(undocumented).toEqual(['SHADOW_TOKEN']);
    expect(envVars.find((entry) => entry.name === 'SHADOW_TOKEN')?.documented).toBe(false);
  });

  it('collects every file that references a variable, sorted and deduplicated', () => {
    const { envVars } = analyzeEnvVars(
      makeSnapshot({
        'src/z.ts': 'const a = process.env.API_URL;\nconst b = process.env.API_URL;',
        'src/a.ts': 'const c = process.env.API_URL;',
      }),
    );

    expect(envVars[0]?.files).toEqual(['src/a.ts', 'src/z.ts']);
  });

  it('does not count a documentation-only mention as a usage', () => {
    const { envVars } = analyzeEnvVars(
      makeSnapshot({ 'docs/setup.md': 'Read `process.env.ONLY_IN_DOCS` at boot.' }),
    );

    expect(envVars).toEqual([]);
  });

  it('ignores an env template as a usage site', () => {
    const { envVars } = analyzeEnvVars(makeSnapshot({ '.env.example': 'ONLY_TEMPLATE=1\n' }));

    expect(envVars).toEqual([]);
  });

  it('ignores vendored and generated files', () => {
    const { envVars } = analyzeEnvVars(
      makeSnapshot({
        'vendor/pkg/a.ts': 'const a = process.env.VENDORED_ONLY;',
        'dist/bundle.js': 'const b = process.env.BUNDLED_ONLY;',
      }),
    );

    expect(envVars).toEqual([]);
  });

  it('returns empty results for an empty snapshot', () => {
    expect(analyzeEnvVars(makeSnapshot({}))).toEqual({ envVars: [], undocumented: [] });
  });
});
