/**
 * Extension -> language mapping, plus a stable colour per language.
 *
 * Colours are drawn from the GitHub Linguist palette so that charts, graph
 * nodes and treemaps agree with what developers already recognise.
 */

export interface LanguageDefinition {
  readonly name: string;
  readonly color: string;
  /** True when GitBrain should parse imports and compute complexity for it. */
  readonly isSource: boolean;
}

const L = (name: string, color: string, isSource = true): LanguageDefinition => ({
  name,
  color,
  isSource,
});

/** Keyed by lowercase extension without the leading dot. */
const EXTENSION_MAP: Readonly<Record<string, LanguageDefinition>> = {
  // JavaScript / TypeScript
  ts: L('TypeScript', '#3178c6'),
  tsx: L('TypeScript', '#3178c6'),
  mts: L('TypeScript', '#3178c6'),
  cts: L('TypeScript', '#3178c6'),
  js: L('JavaScript', '#f1e05a'),
  jsx: L('JavaScript', '#f1e05a'),
  mjs: L('JavaScript', '#f1e05a'),
  cjs: L('JavaScript', '#f1e05a'),

  // Web
  vue: L('Vue', '#41b883'),
  svelte: L('Svelte', '#ff3e00'),
  astro: L('Astro', '#ff5a03'),
  html: L('HTML', '#e34c26', false),
  htm: L('HTML', '#e34c26', false),
  css: L('CSS', '#563d7c', false),
  scss: L('SCSS', '#c6538c', false),
  sass: L('Sass', '#a53b70', false),
  less: L('Less', '#1d365d', false),

  // Backend / systems
  py: L('Python', '#3572A5'),
  pyi: L('Python', '#3572A5'),
  rb: L('Ruby', '#701516'),
  go: L('Go', '#00ADD8'),
  rs: L('Rust', '#dea584'),
  java: L('Java', '#b07219'),
  kt: L('Kotlin', '#A97BFF'),
  kts: L('Kotlin', '#A97BFF'),
  scala: L('Scala', '#c22d40'),
  swift: L('Swift', '#F05138'),
  m: L('Objective-C', '#438eff'),
  mm: L('Objective-C++', '#6866fb'),
  c: L('C', '#555555'),
  h: L('C', '#555555'),
  cpp: L('C++', '#f34b7d'),
  cc: L('C++', '#f34b7d'),
  cxx: L('C++', '#f34b7d'),
  hpp: L('C++', '#f34b7d'),
  cs: L('C#', '#178600'),
  php: L('PHP', '#4F5D95'),
  ex: L('Elixir', '#6e4a7e'),
  exs: L('Elixir', '#6e4a7e'),
  erl: L('Erlang', '#B83998'),
  hs: L('Haskell', '#5e5086'),
  clj: L('Clojure', '#db5855'),
  dart: L('Dart', '#00B4AB'),
  lua: L('Lua', '#000080'),
  r: L('R', '#198CE7'),
  jl: L('Julia', '#a270ba'),
  zig: L('Zig', '#ec915c'),
  sol: L('Solidity', '#AA6746'),

  // Shell / infra
  sh: L('Shell', '#89e051'),
  bash: L('Shell', '#89e051'),
  zsh: L('Shell', '#89e051'),
  fish: L('Shell', '#89e051'),
  ps1: L('PowerShell', '#012456'),
  tf: L('Terraform', '#844FBA'),
  hcl: L('HCL', '#844FBA'),
  dockerfile: L('Dockerfile', '#384d54'),

  // Data / config
  json: L('JSON', '#292929', false),
  jsonc: L('JSON', '#292929', false),
  json5: L('JSON', '#292929', false),
  yaml: L('YAML', '#cb171e', false),
  yml: L('YAML', '#cb171e', false),
  toml: L('TOML', '#9c4221', false),
  xml: L('XML', '#0060ac', false),
  ini: L('INI', '#d1dbe0', false),
  env: L('Dotenv', '#e5d55c', false),
  sql: L('SQL', '#e38c00', false),
  graphql: L('GraphQL', '#e10098', false),
  gql: L('GraphQL', '#e10098', false),
  proto: L('Protocol Buffers', '#c33a3a', false),
  prisma: L('Prisma', '#0c344b', false),

  // Docs
  md: L('Markdown', '#083fa1', false),
  mdx: L('MDX', '#fcb32c', false),
  rst: L('reStructuredText', '#141414', false),
  txt: L('Text', '#6b7280', false),
  adoc: L('AsciiDoc', '#73a0c5', false),
};

/** Files that have no extension but are meaningful by exact name. */
const FILENAME_MAP: Readonly<Record<string, LanguageDefinition>> = {
  dockerfile: L('Dockerfile', '#384d54'),
  makefile: L('Makefile', '#427819', false),
  rakefile: L('Ruby', '#701516'),
  gemfile: L('Ruby', '#701516'),
  procfile: L('Procfile', '#6b7280', false),
  brewfile: L('Ruby', '#701516'),
  justfile: L('Just', '#384d54', false),
  cmakelists: L('CMake', '#DA3434', false),
};

const UNKNOWN: LanguageDefinition = L('Other', '#6b7280', false);

/**
 * Resolve the language for a repo-relative path.
 *
 * Handles compound extensions (`.d.ts`), extension-less well-known filenames
 * (`Dockerfile`), and dotfiles (`.gitignore`).
 */
export function detectLanguage(path: string): LanguageDefinition {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();

  const byName = FILENAME_MAP[base];
  if (byName) return byName;

  // `Dockerfile.prod`, `CMakeLists.txt` and friends.
  const stem = base.split('.')[0] ?? '';
  const byStem = FILENAME_MAP[stem];
  if (byStem && base.startsWith(`${stem}.`)) return byStem;

  const ext = extensionOf(path);
  if (!ext) return UNKNOWN;

  return EXTENSION_MAP[ext] ?? UNKNOWN;
}

/**
 * Lowercase extension without the dot.
 *
 * Dotfiles like `.gitignore` have no extension by this definition, which is
 * what callers want — `.gitignore` is a config file, not a "gitignore" type.
 */
export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** True when GitBrain parses imports and computes complexity for this path. */
export function isSourceFile(path: string): boolean {
  return detectLanguage(path).isSource;
}

export function languageColor(name: string): string {
  for (const def of Object.values(EXTENSION_MAP)) {
    if (def.name === name) return def.color;
  }
  for (const def of Object.values(FILENAME_MAP)) {
    if (def.name === name) return def.color;
  }
  return UNKNOWN.color;
}
