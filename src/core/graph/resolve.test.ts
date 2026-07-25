import { describe, expect, it } from 'vitest';

import { createResolver, isRelativeSpecifier, parseTsconfigAliases } from './resolve';

describe('createResolver — relative specifiers', () => {
  const paths = [
    'src/index.ts',
    'src/utils.ts',
    'src/components/Button.tsx',
    'src/components/index.ts',
    'src/legacy/helper.js',
    'src/data/config.json',
    'src/esm/target.ts',
  ];
  const resolve = createResolver(paths);

  it('infers a missing extension', () => {
    expect(resolve('src/index.ts', './utils')).toBe('src/utils.ts');
    expect(resolve('src/index.ts', './components/Button')).toBe('src/components/Button.tsx');
  });

  it('falls back to a directory index file', () => {
    expect(resolve('src/index.ts', './components')).toBe('src/components/index.ts');
  });

  it('prefers a file over a same-named directory index', () => {
    const withBoth = createResolver(['src/a.ts', 'src/utils.ts', 'src/utils/index.ts']);
    expect(withBoth('src/a.ts', './utils')).toBe('src/utils.ts');
  });

  it('resolves an exact path with its extension', () => {
    expect(resolve('src/index.ts', './data/config.json')).toBe('src/data/config.json');
    expect(resolve('src/index.ts', './legacy/helper.js')).toBe('src/legacy/helper.js');
  });

  it('rewrites the ESM .js specifier that TypeScript sources keep', () => {
    expect(resolve('src/index.ts', './esm/target.js')).toBe('src/esm/target.ts');
  });

  it('walks up through parent segments', () => {
    expect(resolve('src/components/Button.tsx', '../utils')).toBe('src/utils.ts');
  });

  it('returns null for a relative path that does not exist', () => {
    expect(resolve('src/index.ts', './missing')).toBeNull();
  });

  it('returns null for bare package specifiers', () => {
    expect(resolve('src/index.ts', 'react')).toBeNull();
    expect(resolve('src/index.ts', '@scope/pkg')).toBeNull();
  });
});

describe('createResolver — tsconfig path aliases', () => {
  const paths = ['src/app/page.tsx', 'src/lib/format.ts', 'src/components/ui/Card.tsx'];

  it('resolves the @/* to ./src/* pattern', () => {
    const resolve = createResolver(paths, { '@/*': ['src/*'] });

    expect(resolve('src/app/page.tsx', '@/lib/format')).toBe('src/lib/format.ts');
    expect(resolve('src/app/page.tsx', '@/components/ui/Card')).toBe('src/components/ui/Card.tsx');
    expect(resolve('src/app/page.tsx', '@/lib/missing')).toBeNull();
  });

  it('prefers the longest matching alias prefix', () => {
    const resolve = createResolver(paths, {
      '@/*': ['src/*'],
      '@/components/*': ['src/components/ui/*'],
    });

    expect(resolve('src/app/page.tsx', '@/components/Card')).toBe('src/components/ui/Card.tsx');
  });

  it('supports exact, non-wildcard aliases', () => {
    const resolve = createResolver(paths, { '~format': ['src/lib/format'] });
    expect(resolve('src/app/page.tsx', '~format')).toBe('src/lib/format.ts');
  });

  it('tries every target listed for an alias', () => {
    const resolve = createResolver(paths, { '@/*': ['nonexistent/*', 'src/*'] });
    expect(resolve('src/app/page.tsx', '@/lib/format')).toBe('src/lib/format.ts');
  });
});

describe('parseTsconfigAliases', () => {
  it('reads compilerOptions.paths from clean JSON', () => {
    const content = JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } });
    expect(parseTsconfigAliases(content)).toEqual({ '@/*': ['./src/*'] });
  });

  it('tolerates comments and trailing commas', () => {
    const content = `{
      // The editor and the bundler must agree on this map.
      "compilerOptions": {
        /* block comment */
        "baseUrl": ".",
        "paths": {
          "@/*": ["./src/*"], // app code
          "~/*": ["./test/*"],
        },
      },
    }`;

    expect(parseTsconfigAliases(content)).toEqual({
      '@/*': ['./src/*'],
      '~/*': ['./test/*'],
    });
  });

  it('does not strip a // that lives inside a string value', () => {
    const content = `{ "compilerOptions": { "paths": { "@/*": ["https://example.com/*"] } } }`;
    expect(parseTsconfigAliases(content)).toEqual({ '@/*': ['https://example.com/*'] });
  });

  it('returns an empty map for malformed or alias-free configs', () => {
    expect(parseTsconfigAliases('not json at all {{{')).toEqual({});
    expect(parseTsconfigAliases('{}')).toEqual({});
    expect(parseTsconfigAliases('{"compilerOptions":{}}')).toEqual({});
    expect(parseTsconfigAliases('{"compilerOptions":{"paths":{"@/*":"src/*"}}}')).toEqual({});
  });
});

describe('createResolver — Python', () => {
  const paths = [
    'app/__init__.py',
    'app/main.py',
    'app/models.py',
    'app/api/__init__.py',
    'app/api/routes.py',
    'app/api/schemas.py',
    'shared/util.py',
    'src/deep/pkg/mod.py',
    'src/deep/pkg/user.py',
  ];
  const resolve = createResolver(paths);

  it('resolves a single-dot relative import to the current package', () => {
    expect(resolve('app/api/routes.py', '.schemas')).toBe('app/api/schemas.py');
    expect(resolve('app/api/routes.py', '.')).toBe('app/api/__init__.py');
  });

  it('resolves a double-dot relative import to the parent package', () => {
    expect(resolve('app/api/routes.py', '..models')).toBe('app/models.py');
    expect(resolve('app/api/routes.py', '..')).toBe('app/__init__.py');
  });

  it('resolves dotted absolute module paths from the repository root', () => {
    expect(resolve('app/main.py', 'app.api.routes')).toBe('app/api/routes.py');
    expect(resolve('app/main.py', 'shared.util')).toBe('shared/util.py');
    expect(resolve('app/main.py', 'app.api')).toBe('app/api/__init__.py');
  });

  it('resolves absolute imports against an intermediate source root', () => {
    // `src/` is the source root, so `pkg.user` is relative to it.
    expect(resolve('src/deep/pkg/mod.py', 'pkg.user')).toBe('src/deep/pkg/user.py');
  });

  it('returns null for third-party and standard-library modules', () => {
    expect(resolve('app/main.py', 'os')).toBeNull();
    expect(resolve('app/main.py', 'django.db')).toBeNull();
  });
});

describe('createResolver — Go', () => {
  const paths = [
    'go.mod',
    'cmd/server/main.go',
    'internal/store/store.go',
    'internal/store/query.go',
    'internal/store/store_test.go',
    'pkg/api/handler.go',
  ];
  const resolve = createResolver(paths);

  it('matches an internal package by its directory suffix', () => {
    expect(resolve('cmd/server/main.go', 'github.com/acme/demo/internal/store')).toBe(
      'internal/store/query.go',
    );
    expect(resolve('cmd/server/main.go', 'github.com/acme/demo/pkg/api')).toBe(
      'pkg/api/handler.go',
    );
  });

  it('ignores test files when picking the representative file', () => {
    const only = createResolver(['internal/only/only_test.go', 'cmd/main.go']);
    expect(only('cmd/main.go', 'example.com/m/internal/only')).toBeNull();
  });

  it('returns null for standard-library packages', () => {
    expect(resolve('cmd/server/main.go', 'fmt')).toBeNull();
    expect(resolve('cmd/server/main.go', 'net/http')).toBeNull();
  });
});

describe('createResolver — Rust', () => {
  const paths = [
    'src/main.rs',
    'src/config.rs',
    'src/api/mod.rs',
    'src/api/routes.rs',
    'src/utils/helpers.rs',
  ];
  const resolve = createResolver(paths);

  it('resolves crate-rooted paths', () => {
    expect(resolve('src/api/routes.rs', 'crate::config::Config')).toBe('src/config.rs');
    expect(resolve('src/main.rs', 'crate::api')).toBe('src/api/mod.rs');
  });

  it('resolves mod declarations to sibling files', () => {
    expect(resolve('src/main.rs', 'config')).toBe('src/config.rs');
    expect(resolve('src/api/mod.rs', 'routes')).toBe('src/api/routes.rs');
  });

  it('resolves super:: to the parent module directory', () => {
    // `src/api/routes.rs` sits in module `api`, whose parent is the crate root.
    expect(resolve('src/api/routes.rs', 'super::config')).toBe('src/config.rs');
    expect(resolve('src/api/routes.rs', 'super::nothing')).toBeNull();
  });

  it('returns null for external crates', () => {
    expect(resolve('src/main.rs', 'std::collections::HashMap')).toBeNull();
    expect(resolve('src/main.rs', 'serde::Deserialize')).toBeNull();
  });
});

describe('createResolver — Ruby and PHP', () => {
  it('treats an extensionless Ruby specifier as file-relative', () => {
    const resolve = createResolver(['lib/app.rb', 'lib/helper.rb']);
    expect(resolve('lib/app.rb', 'helper')).toBe('lib/helper.rb');
    expect(resolve('lib/app.rb', 'json')).toBeNull();
  });

  it('resolves PHP includes relative to the including file', () => {
    const resolve = createResolver(['src/App.php', 'src/bootstrap.php']);
    expect(resolve('src/App.php', 'bootstrap.php')).toBe('src/bootstrap.php');
  });
});

describe('isRelativeSpecifier', () => {
  it('recognises dot-prefixed forms only', () => {
    expect(isRelativeSpecifier('./a')).toBe(true);
    expect(isRelativeSpecifier('../a')).toBe(true);
    expect(isRelativeSpecifier('.')).toBe(true);
    expect(isRelativeSpecifier('..')).toBe(true);
    expect(isRelativeSpecifier('.hidden')).toBe(false);
    expect(isRelativeSpecifier('react')).toBe(false);
  });
});
