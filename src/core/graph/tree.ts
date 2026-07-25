/**
 * Directory tree construction.
 *
 * The tree is the first thing a newcomer looks at, so a bare list of folder
 * names is a wasted opportunity — the reader already sees those in their editor.
 * What they cannot see is *what a folder is for*, and answering that is the
 * point of this module.
 *
 * `purpose` is built from two independent signals, and needs both:
 *
 *  - **Convention.** `hooks/`, `migrations/` and `cmd/` carry meaning that every
 *    developer in that ecosystem already shares. Restating it costs nothing and
 *    orients someone new to the stack.
 *  - **Observation.** Convention lies. A folder called `utils/` holding twelve
 *    React components is not a utility folder, and a reader deserves to know
 *    that before they open it. Counting what is actually inside also covers the
 *    majority case: folders whose names follow no convention at all.
 *
 * Neither signal alone is sufficient, so the description states the convention
 * and then immediately grounds it in a count of real contents.
 */

import type { RepoFile, TreeNode } from '../types';
import { basename, stem } from '../shared/paths';
import { detectLanguage, extensionOf } from '../shared/languages';
import { isConfigFile, isDocumentationFile, isTestFile } from '../shared/classify';

/**
 * Conventional folder meanings, keyed by lowercased directory name.
 *
 * Only names whose meaning is genuinely stable across projects are listed.
 * Guessing at ambiguous names would make the whole field untrustworthy.
 */
const FOLDER_PURPOSES: Readonly<Record<string, string>> = {
  src: 'Primary application source code.',
  source: 'Primary application source code.',
  app: 'Application shell and route-level screens.',
  components: 'Reusable presentation components.',
  component: 'Reusable presentation components.',
  ui: 'Low-level design-system building blocks.',
  lib: 'Shared library code and third-party integrations.',
  libs: 'Shared library code and third-party integrations.',
  utils: 'Small stateless helpers with no domain knowledge.',
  util: 'Small stateless helpers with no domain knowledge.',
  helpers: 'Small stateless helpers with no domain knowledge.',
  hooks: 'Reusable stateful logic packaged as React hooks.',
  api: 'HTTP surface — request handlers and endpoint definitions.',
  pages: 'Page-level views mapped directly to URLs.',
  routes: 'Route definitions and their handlers.',
  models: 'Domain models and persistence schemas.',
  model: 'Domain models and persistence schemas.',
  entities: 'Domain models and persistence schemas.',
  services: 'Business logic and calls out to external systems.',
  service: 'Business logic and calls out to external systems.',
  controllers: 'Request controllers coordinating models and views.',
  middleware: 'Interceptors that run between a request and its handler.',
  middlewares: 'Interceptors that run between a request and its handler.',
  migrations: 'Ordered database schema migrations. Append-only by convention.',
  public: 'Static files served verbatim at the site root.',
  static: 'Static files served verbatim at the site root.',
  assets: 'Images, fonts and other media bundled with the app.',
  styles: 'Stylesheets and design tokens.',
  css: 'Stylesheets and design tokens.',
  tests: 'Automated tests.',
  test: 'Automated tests.',
  __tests__: 'Automated tests.',
  spec: 'Automated tests.',
  specs: 'Automated tests.',
  e2e: 'End-to-end tests driving the real application.',
  docs: 'Project documentation.',
  doc: 'Project documentation.',
  documentation: 'Project documentation.',
  scripts: 'Developer and CI automation scripts, not shipped to users.',
  bin: 'Executable entry points.',
  config: 'Configuration for build, lint and runtime tooling.',
  configs: 'Configuration for build, lint and runtime tooling.',
  types: 'Shared type declarations with no runtime output.',
  typings: 'Shared type declarations with no runtime output.',
  store: 'Client-side state management.',
  stores: 'Client-side state management.',
  context: 'React context providers and their consumers.',
  contexts: 'React context providers and their consumers.',
  features: 'Feature-sliced modules, each owning its own UI, state and data access.',
  modules: 'Feature-sliced modules, each owning its own UI, state and data access.',
  cmd: 'Go command entry points — one executable per subdirectory.',
  internal: 'Go internal packages, importable only from within this module.',
  pkg: 'Go packages intended for import by other modules.',
  hack: 'Ad-hoc maintenance and development tooling.',
  examples: 'Runnable usage examples.',
  fixtures: 'Static sample data used by tests.',
  locales: 'Translation catalogues.',
  i18n: 'Internationalisation resources.',
};

/**
 * Build the nested directory tree for a snapshot.
 *
 * Binary files are included: they contribute to `size` and `fileCount`, and a
 * folder of 200 PNGs is a fact about the repository worth surfacing.
 */
export function buildTree(files: readonly RepoFile[]): TreeNode {
  const root = newDirectory('/', '');

  for (const file of files) {
    const segments = file.path.split('/').filter(Boolean);
    if (segments.length === 0) continue;

    let cursor = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const name = segments[i];
      if (name === undefined) continue;
      const childPath = cursor.path ? `${cursor.path}/${name}` : name;
      let child = cursor.directories.get(name);
      if (!child) {
        child = newDirectory(name, childPath);
        cursor.directories.set(name, child);
      }
      cursor = child;
    }
    cursor.files.push(file);
  }

  return toTreeNode(root, true).node;
}

interface MutableDirectory {
  readonly name: string;
  readonly path: string;
  readonly directories: Map<string, MutableDirectory>;
  readonly files: RepoFile[];
}

function newDirectory(name: string, path: string): MutableDirectory {
  return { name, path, directories: new Map(), files: [] };
}

/**
 * Convert to the immutable shape, bubbling descendant files up as we go.
 *
 * Recursion depth here is the directory depth, not the file count, so it is
 * bounded by what a filesystem tolerates — a few dozen levels. Unlike the
 * module graph there is no stack-overflow hazard to engineer around.
 */
function toTreeNode(
  directory: MutableDirectory,
  isRoot: boolean,
): { node: TreeNode; files: RepoFile[] } {
  const descendants: RepoFile[] = [];
  const children: TreeNode[] = [];

  const subdirectories = [...directory.directories.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const subdirectory of subdirectories) {
    const result = toTreeNode(subdirectory, false);
    children.push(result.node);
    descendants.push(...result.files);
  }

  const ownFiles = [...directory.files].sort((a, b) =>
    basename(a.path).localeCompare(basename(b.path)),
  );
  for (const file of ownFiles) children.push(toFileNode(file));
  descendants.push(...ownFiles);

  const language = dominantLanguage(descendants);

  const node: TreeNode = {
    name: directory.name,
    path: directory.path,
    type: 'dir',
    size: descendants.reduce((total, file) => total + file.size, 0),
    fileCount: descendants.length,
    children,
    ...(language ? { language } : {}),
    purpose: describePurpose(directory.name, descendants, isRoot),
  };

  return { node, files: descendants };
}

function toFileNode(file: RepoFile): TreeNode {
  const language = detectLanguage(file.path);

  return {
    name: basename(file.path),
    path: file.path,
    type: 'file',
    size: file.size,
    fileCount: 1,
    ...(language.name === 'Other' ? {} : { language: language.name }),
  };
}

/**
 * Language accounting for the most bytes beneath a node.
 *
 * Bytes rather than file counts, because a directory of 40 one-line barrel
 * re-exports next to 3 large Python modules is a Python directory.
 */
function dominantLanguage(files: readonly RepoFile[]): string | null {
  const bytes = new Map<string, number>();

  for (const file of files) {
    const language = detectLanguage(file.path);
    if (language.name === 'Other') continue;
    bytes.set(language.name, (bytes.get(language.name) ?? 0) + file.size);
  }

  let best: string | null = null;
  let bestBytes = -1;
  for (const [name, total] of bytes) {
    if (total > bestBytes || (total === bestBytes && best !== null && name < best)) {
      best = name;
      bestBytes = total;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Purpose descriptions
// ---------------------------------------------------------------------------

const ROUTE_STEMS = new Set(['route', 'router', 'routes', 'handler', 'handlers', '+server']);

/** `.tsx`/`.jsx` named in PascalCase, or a single-file component format. */
function isComponentFile(path: string): boolean {
  const extension = extensionOf(path);
  if (extension === 'vue' || extension === 'svelte') return true;
  if (extension !== 'tsx' && extension !== 'jsx') return false;
  if (isTestFile(path)) return false;
  return /^[A-Z]/.test(stem(path));
}

/**
 * A file that answers HTTP requests: named by convention, or living directly in
 * an `api/`-style folder.
 */
function isRouteFile(path: string): boolean {
  if (isTestFile(path)) return false;
  if (!detectLanguage(path).isSource) return false;
  if (ROUTE_STEMS.has(stem(path).toLowerCase())) return true;

  const parent = basename(path.slice(0, path.lastIndexOf('/') + 1).replace(/\/$/, ''));
  return parent === 'api' || parent === 'endpoints';
}

/**
 * A one-sentence explanation of what a folder is and what it holds.
 *
 * The convention clause is omitted when the folder name says nothing, and the
 * contents clause is omitted when the folder is empty — so an unrecognised,
 * empty folder still gets an honest description rather than a fabricated one.
 */
function describePurpose(name: string, files: readonly RepoFile[], isRoot: boolean): string {
  const convention = isRoot ? 'Repository root.' : FOLDER_PURPOSES[name.toLowerCase()];
  const contents = summarizeContents(files);

  if (convention && contents) return `${convention} Holds ${contents}.`;
  if (convention) return `${convention} Currently empty.`;
  if (contents) return `Holds ${contents}.`;
  return 'Empty directory.';
}

/**
 * Human-readable inventory of a folder's contents, most specific signal first.
 *
 * Categories deliberately overlap with the language tally — "12 React
 * components" and "18 TypeScript files" can describe the same files. That is
 * the useful reading: the first phrase says what they *are*, the second says
 * how much there is in total.
 */
function summarizeContents(files: readonly RepoFile[]): string {
  if (files.length === 0) return '';

  const phrases: string[] = [];

  const components = files.filter((file) => isComponentFile(file.path)).length;
  if (components > 0) phrases.push(`${components} React ${plural('component', components)}`);

  const routes = files.filter((file) => isRouteFile(file.path)).length;
  if (routes > 0) phrases.push(`${routes} API route ${plural('handler', routes)}`);

  const tests = files.filter((file) => isTestFile(file.path)).length;
  if (tests > 0) phrases.push(`${tests} test ${plural('file', tests)}`);

  const docs = files.filter((file) => isDocumentationFile(file.path)).length;
  if (docs > 0) phrases.push(`${docs} ${plural('document', docs)}`);

  if (phrases.length < 3) {
    const configs = files.filter(
      (file) => isConfigFile(file.path) && !isTestFile(file.path),
    ).length;
    if (configs > 0) phrases.push(`${configs} config ${plural('file', configs)}`);
  }

  const language = dominantLanguage(files);
  if (language && phrases.length < 3) {
    const count = files.filter((file) => detectLanguage(file.path).name === language).length;
    phrases.push(`${count} ${language} ${plural('file', count)}`);
  }

  if (phrases.length === 0) {
    phrases.push(`${files.length} ${plural('file', files.length)}`);
  }

  return joinPhrases(phrases.slice(0, 3));
}

function plural(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

/** `a`, `a and b`, `a, b and c`. */
function joinPhrases(phrases: readonly string[]): string {
  if (phrases.length <= 1) return phrases[0] ?? '';
  const head = phrases.slice(0, -1).join(', ');
  const tail = phrases[phrases.length - 1] ?? '';
  return `${head} and ${tail}`;
}
