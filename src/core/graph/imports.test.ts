import { describe, expect, it } from 'vitest';

import { importFamily, parseImports } from './imports';

/** Compact assertion helper: `specifier@line` pairs, in reported order. */
function shapeOf(path: string, content: string): string[] {
  return parseImports(path, content).map((item) => `${item.specifier}@${item.line}`);
}

describe('parseImports — JavaScript and TypeScript', () => {
  it('reads every static import form with correct 1-indexed lines', () => {
    const source = [
      `import './side-effect';`,
      `import defaultExport from 'a';`,
      `import * as namespace from 'b';`,
      `import { named, other as alias } from 'c';`,
      `import mixed, { alsoNamed } from 'd';`,
    ].join('\n');

    expect(shapeOf('src/index.ts', source)).toEqual([
      './side-effect@1',
      'a@2',
      'b@3',
      'c@4',
      'd@5',
    ]);
  });

  it('spans multi-line binding clauses without losing the opening line', () => {
    const source = ['import {', '  a,', '  b,', "} from './wide';"].join('\n');

    expect(parseImports('src/index.ts', source)).toEqual([
      { specifier: './wide', line: 1, kind: 'static' },
    ]);
  });

  it('classifies type-only imports separately from value imports', () => {
    const source = [`import type { Config } from './config';`, `import types from './types';`].join(
      '\n',
    );

    expect(parseImports('src/index.ts', source)).toEqual([
      { specifier: './config', line: 1, kind: 'type-only' },
      // `types` is an identifier, not the `type` modifier — regression guard.
      { specifier: './types', line: 2, kind: 'static' },
    ]);
  });

  it('reads re-exports, dynamic imports and require calls', () => {
    const source = [
      `export { a } from './a';`,
      `export * from './b';`,
      `export * as ns from './c';`,
      `export type { T } from './t';`,
      `const mod = require('./legacy');`,
      `const lazy = import('./lazy');`,
      `const awaited = await import('./awaited');`,
    ].join('\n');

    expect(parseImports('src/index.ts', source)).toEqual([
      { specifier: './a', line: 1, kind: 'export-from' },
      { specifier: './b', line: 2, kind: 'export-from' },
      { specifier: './c', line: 3, kind: 'export-from' },
      { specifier: './t', line: 4, kind: 'type-only' },
      { specifier: './legacy', line: 5, kind: 'require' },
      { specifier: './lazy', line: 6, kind: 'dynamic' },
      { specifier: './awaited', line: 7, kind: 'dynamic' },
    ]);
  });

  it('does not mistake import.meta or an identifier prefixed with import', () => {
    const source = [`const url = import.meta.url;`, `importantThing('./nope');`].join('\n');

    expect(parseImports('src/index.ts', source)).toEqual([]);
  });

  it('deduplicates identical specifier/line pairs', () => {
    const source = `import a from './dup'; import b from './dup';`;

    expect(parseImports('src/index.ts', source)).toEqual([
      { specifier: './dup', line: 1, kind: 'static' },
    ]);
  });

  it('returns nothing for languages without an import model', () => {
    expect(parseImports('README.md', `import a from 'b';`)).toEqual([]);
    expect(importFamily('README.md')).toBeNull();
  });
});

describe('parseImports — comment and string false positives', () => {
  it('ignores imports inside line comments', () => {
    const source = [
      `// import ghost from './ghost';`,
      `import real from './real'; // import trailing from './trailing';`,
    ].join('\n');

    expect(shapeOf('src/index.ts', source)).toEqual(['./real@2']);
  });

  it('ignores imports inside block comments', () => {
    const source = [
      `/*`,
      ` * import ghost from './ghost';`,
      ` * require('./ghost-require');`,
      ` */`,
      `import real from './real';`,
    ].join('\n');

    expect(shapeOf('src/index.ts', source)).toEqual(['./real@5']);
  });

  it('ignores import-shaped text inside string and template literals', () => {
    const source = [
      `const single = 'import ghost from "./ghost"';`,
      `const double = "import ghost2 from './ghost2'";`,
      "const template = `require('./ghost3')`;",
      `import real from './real';`,
    ].join('\n');

    expect(shapeOf('src/index.ts', source)).toEqual(['./real@4']);
  });

  it('is not derailed by regex literals or division containing quotes', () => {
    const source = [
      `const quoted = /['"]/g;`,
      `const ratio = total / count;`,
      `import real from './real';`,
    ].join('\n');

    expect(shapeOf('src/index.ts', source)).toEqual(['./real@3']);
  });

  it('ignores a Python docstring that mentions an import', () => {
    const source = ['"""', 'import ghost', '"""', 'import real'].join('\n');

    expect(shapeOf('app/main.py', source)).toEqual(['real@4']);
  });
});

describe('parseImports — single-file component formats', () => {
  it('reads Vue script blocks and skips the template', () => {
    const source = [
      `<template>`,
      `  <div>import ghost from './ghost'</div>`,
      `</template>`,
      ``,
      `<script setup lang="ts">`,
      `import { ref } from 'vue';`,
      `import Button from './Button.vue';`,
      `</script>`,
    ].join('\n');

    expect(shapeOf('src/App.vue', source)).toEqual(['vue@6', './Button.vue@7']);
  });

  it('reads Svelte script blocks', () => {
    const source = [
      `<script lang="ts">`,
      `  import { onMount } from 'svelte';`,
      `</script>`,
      ``,
      `<p>require('./ghost')</p>`,
    ].join('\n');

    expect(shapeOf('src/Counter.svelte', source)).toEqual(['svelte@2']);
  });

  it('reads Astro frontmatter', () => {
    const source = [
      `---`,
      `import Layout from '../layouts/Layout.astro';`,
      `---`,
      `<h1>import ghost from './ghost'</h1>`,
    ].join('\n');

    expect(shapeOf('src/pages/index.astro', source)).toEqual(['../layouts/Layout.astro@2']);
  });
});

describe('parseImports — Python', () => {
  it('reads plain, aliased, multiple and dotted imports', () => {
    const source = [`import os`, `import os.path as p`, `import json, sys`].join('\n');

    expect(shapeOf('app/main.py', source)).toEqual(['os@1', 'os.path@2', 'json@3', 'sys@3']);
  });

  it('preserves leading dots on relative from-imports', () => {
    const source = [
      `from . import sibling`,
      `from .relative import thing`,
      `from ..pkg.deep import other`,
      `from a.b.c import d`,
    ].join('\n');

    expect(shapeOf('app/api/routes.py', source)).toEqual([
      '.@1',
      '.relative@2',
      '..pkg.deep@3',
      'a.b.c@4',
    ]);
  });

  it('handles indented imports inside a function body', () => {
    const source = ['def load():', '    import heavy', '    return heavy'].join('\n');

    expect(shapeOf('app/lazy.py', source)).toEqual(['heavy@2']);
  });
});

describe('parseImports — Go', () => {
  it('reads single and grouped import forms', () => {
    const source = [
      `package main`,
      ``,
      `import "fmt"`,
      ``,
      `import (`,
      `\t"os"`,
      `\tstr "strings"`,
      ``,
      `\t"github.com/acme/demo/internal/store"`,
      `)`,
      ``,
      `var s = "not/an/import"`,
    ].join('\n');

    expect(shapeOf('cmd/server/main.go', source)).toEqual([
      'fmt@3',
      'os@6',
      'strings@7',
      'github.com/acme/demo/internal/store@9',
    ]);
  });
});

describe('parseImports — Rust', () => {
  it('reads use and mod declarations, collapsing brace groups', () => {
    const source = [
      `use crate::config::Config;`,
      `use std::collections::HashMap;`,
      `use super::helpers::{a, b};`,
      `mod utils;`,
      `pub mod api;`,
      `mod inline { pub fn x() {} }`,
      `// use ghost::thing;`,
    ].join('\n');

    expect(shapeOf('src/main.rs', source)).toEqual([
      'crate::config::Config@1',
      'std::collections::HashMap@2',
      'super::helpers@3',
      'utils@4',
      'api@5',
    ]);
  });
});

describe('parseImports — Ruby, PHP and the JVM family', () => {
  it('reads Ruby require and require_relative', () => {
    const source = [
      `require 'json'`,
      `require_relative 'helper'`,
      `# require 'ghost'`,
      `x = "require 'ghost2'"`,
    ].join('\n');

    expect(parseImports('lib/app.rb', source)).toEqual([
      { specifier: 'json', line: 1, kind: 'require' },
      { specifier: 'helper', line: 2, kind: 'require' },
    ]);
  });

  it('reads PHP use statements without matching closure captures', () => {
    const source = [
      `<?php`,
      `use App\\Models\\User;`,
      `use function App\\Helpers\\format;`,
      `require_once 'vendor/autoload.php';`,
      `$f = function () use ($x) { return $x; };`,
    ].join('\n');

    expect(parseImports('src/App.php', source)).toEqual([
      { specifier: 'App\\Models\\User', line: 2, kind: 'static' },
      { specifier: 'App\\Helpers\\format', line: 3, kind: 'static' },
      { specifier: 'vendor/autoload.php', line: 4, kind: 'require' },
    ]);
  });

  it('reads Java and Kotlin imports', () => {
    const java = [
      `package com.example;`,
      ``,
      `import java.util.List;`,
      `import static org.junit.Assert.assertEquals;`,
    ].join('\n');
    expect(shapeOf('src/Main.java', java)).toEqual([
      'java.util.List@3',
      'org.junit.Assert.assertEquals@4',
    ]);

    const kotlin = [`import kotlin.math.max`, `import com.example.Model as M`].join('\n');
    expect(shapeOf('src/Main.kt', kotlin)).toEqual(['kotlin.math.max@1', 'com.example.Model@2']);
  });
});
