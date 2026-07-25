/**
 * Operational documents: how to run this thing locally, how it reaches
 * production, and what configuration it needs to work.
 *
 * The commands in these documents have to be real. A setup guide that invents
 * `npm run dev` for a project with no `dev` script is worse than no guide at
 * all, so every command is derived from a detected package manager, a script
 * that exists in the manifest, or a file that is present in the snapshot.
 */

import type { KnowledgeDoc } from '../../types';
import {
  citationsFor,
  detectionLabel,
  ensureCitations,
  filesMatching,
  findFile,
  firstExisting,
  pickScript,
  rankDetections,
  readManifest,
  repoName,
  topDetection,
  type CitationRef,
  type KnowledgeContext,
  type PackageManifest,
} from '../context';
import {
  bulletList,
  code,
  codeBlock,
  countLabel,
  fileRef,
  formatNumber,
  heading,
  joinWords,
  makeDoc,
  note,
  numberedList,
  section,
  table,
} from '../format';

// ---------------------------------------------------------------------------
// Package managers
// ---------------------------------------------------------------------------

interface PackageManagerProfile {
  readonly id: string;
  readonly name: string;
  /** Lockfile or manifest whose presence proves this manager is in use. */
  readonly marker: readonly string[];
  readonly install: string;
  /** Render the command that runs a named manifest script. */
  readonly run: (script: string) => string;
}

const PACKAGE_MANAGERS: readonly PackageManagerProfile[] = [
  {
    id: 'pnpm',
    name: 'pnpm',
    marker: ['pnpm-lock.yaml', 'pnpm-workspace.yaml'],
    install: 'pnpm install',
    run: (script) => `pnpm run ${script}`,
  },
  {
    id: 'yarn',
    name: 'Yarn',
    marker: ['yarn.lock'],
    install: 'yarn install',
    run: (script) => `yarn ${script}`,
  },
  {
    id: 'bun',
    name: 'Bun',
    marker: ['bun.lockb', 'bun.lock'],
    install: 'bun install',
    run: (script) => `bun run ${script}`,
  },
  {
    id: 'npm',
    name: 'npm',
    marker: ['package-lock.json', 'package.json'],
    install: 'npm install',
    run: (script) => `npm run ${script}`,
  },
  {
    id: 'poetry',
    name: 'Poetry',
    marker: ['poetry.lock'],
    install: 'poetry install',
    run: (script) => `poetry run ${script}`,
  },
  {
    id: 'pipenv',
    name: 'Pipenv',
    marker: ['Pipfile.lock', 'Pipfile'],
    install: 'pipenv install --dev',
    run: (script) => `pipenv run ${script}`,
  },
  {
    id: 'uv',
    name: 'uv',
    marker: ['uv.lock'],
    install: 'uv sync',
    run: (script) => `uv run ${script}`,
  },
  {
    id: 'pip',
    name: 'pip',
    marker: ['requirements.txt'],
    install: 'pip install -r requirements.txt',
    run: (script) => script,
  },
  {
    id: 'cargo',
    name: 'Cargo',
    marker: ['Cargo.lock', 'Cargo.toml'],
    install: 'cargo build',
    run: (script) => `cargo ${script}`,
  },
  {
    id: 'go',
    name: 'Go modules',
    marker: ['go.sum', 'go.mod'],
    install: 'go mod download',
    run: (script) => `go ${script}`,
  },
  {
    id: 'bundler',
    name: 'Bundler',
    marker: ['Gemfile.lock', 'Gemfile'],
    install: 'bundle install',
    run: (script) => `bundle exec ${script}`,
  },
  {
    id: 'composer',
    name: 'Composer',
    marker: ['composer.lock', 'composer.json'],
    install: 'composer install',
    run: (script) => `composer run ${script}`,
  },
  {
    id: 'maven',
    name: 'Maven',
    marker: ['pom.xml'],
    install: 'mvn install',
    run: (script) => `mvn ${script}`,
  },
  {
    id: 'gradle',
    name: 'Gradle',
    marker: ['gradlew', 'build.gradle', 'build.gradle.kts'],
    install: './gradlew build',
    run: (script) => `./gradlew ${script}`,
  },
];

/**
 * Resolve the package manager to write commands for.
 *
 * The stack detector's opinion wins, because it saw the whole repository
 * (including a `packageManager` field). Falling back to lockfile presence keeps
 * the guide usable when detection produced nothing.
 */
function resolvePackageManager(context: KnowledgeContext): {
  readonly profile: PackageManagerProfile | null;
  readonly evidence: string;
} {
  const detected = topDetection(context.stack.packageManagers);
  if (detected) {
    const lower = detected.name.toLowerCase();
    const matched = PACKAGE_MANAGERS.find(
      (profile) => lower.includes(profile.id) || lower.includes(profile.name.toLowerCase()),
    );
    if (matched) {
      return {
        profile: matched,
        evidence: detected.evidence[0] ?? `detected as ${detectionLabel(detected)}`,
      };
    }
  }

  for (const profile of PACKAGE_MANAGERS) {
    const marker = firstExisting(context, profile.marker);
    if (marker) return { profile, evidence: `${marker} is committed` };
  }

  return { profile: null, evidence: 'no package manager marker was found' };
}

// ---------------------------------------------------------------------------
// Setup guide
// ---------------------------------------------------------------------------

const ENV_TEMPLATES = ['.env.example', '.env.sample', '.env.template', '.env.dist', 'env.example'];

export function setupGuide(context: KnowledgeContext): KnowledgeDoc {
  const manifest = readManifest(context);
  const { profile, evidence } = resolvePackageManager(context);
  const runtimes = rankDetections(context.stack.runtimes);
  const envTemplate = firstExisting(context, ENV_TEMPLATES);
  const source = context.source;

  const prerequisites: string[] = [];
  for (const runtime of runtimes.slice(0, 3)) {
    prerequisites.push(
      `${detectionLabel(runtime)}${runtime.evidence[0] ? ` — ${runtime.evidence[0]}` : ''}`,
    );
  }
  if (manifest) {
    for (const [engine, range] of Object.entries(manifest.engines)) {
      prerequisites.push(`${engine} ${code(range)} (required by ${fileRef(manifest.path)})`);
    }
  }
  const nvmrc = findFile(context, '.nvmrc');
  if (nvmrc?.content) {
    prerequisites.push(`Node ${code(nvmrc.content.trim())} (pinned in ${fileRef('.nvmrc')})`);
  }
  const toolVersions = findFile(context, '.tool-versions');
  if (toolVersions?.content) {
    prerequisites.push(
      `Runtime versions pinned in ${fileRef('.tool-versions')}: ${code(toolVersions.content.trim().replace(/\n/g, '; '))}`,
    );
  }
  if (profile) prerequisites.push(`${profile.name} — ${evidence}`);
  const dockerCompose = firstExisting(context, [
    'docker-compose.yml',
    'docker-compose.yaml',
    'compose.yml',
    'compose.yaml',
  ]);
  if (dockerCompose) {
    prerequisites.push(
      `Docker, if you want the backing services — ${fileRef(dockerCompose)} defines them`,
    );
  }
  if (prerequisites.length === 0) {
    prerequisites.push(
      'None could be determined: no runtime was detected, no engine constraint is declared and no version file is committed.',
    );
  }

  const cloneCommand =
    source.kind === 'github'
      ? `git clone ${source.url}.git\ncd ${source.repo}`
      : `unzip ${source.filename}\ncd ${source.filename.replace(/\.(zip|tar|tar\.gz|tgz)$/i, '')}`;

  const dev = pickScript(manifest, ['dev', 'develop', 'start:dev', 'serve', 'start']);
  const build = pickScript(manifest, ['build', 'compile', 'bundle']);
  const test = pickScript(manifest, ['test', 'test:unit', 'tests', 'check']);
  const lint = pickScript(manifest, ['lint', 'lint:fix', 'check', 'verify']);

  const steps: string[] = [];

  steps.push(section('**Install the prerequisites.**', bulletList(prerequisites)));

  steps.push(section('**Get the code.**', codeBlock('bash', cloneCommand)));

  steps.push(
    section(
      '**Install dependencies.**',
      profile
        ? section(
            codeBlock('bash', profile.install),
            context.dependencies.hasLockfile
              ? 'A lockfile is committed, so this resolves to the exact versions the project was last built against.'
              : 'No lockfile is committed, so this may resolve to newer versions than the authors used.',
          )
        : 'No package manager was detected, so there is nothing to install. If dependencies are expected, the manifest is missing from this snapshot.',
    ),
  );

  steps.push(
    section(
      '**Configure the environment.**',
      envTemplate
        ? section(
            codeBlock('bash', `cp ${envTemplate} .env`),
            `${fileRef(envTemplate)} documents ${countLabel(context.security.envVars.filter((usage) => usage.documented).length, 'variable')}. ${
              context.security.undocumentedEnvVars.length > 0
                ? `A further ${countLabel(context.security.undocumentedEnvVars.length, 'variable')} are read by the code but absent from the template — see *Environment Variables*.`
                : 'Every variable the code reads is present in the template.'
            }`,
          )
        : context.security.envVars.length > 0
          ? `No environment template is committed, but the code reads ${countLabel(context.security.envVars.length, 'environment variable')}: ${joinWords(context.security.envVars.slice(0, 10).map((usage) => code(usage.name)))}. You will need values for these before the project runs. See *Environment Variables*.`
          : 'No environment template and no environment variable reads were found — the project appears to need no configuration.',
    ),
  );

  const runCommand = dev && profile ? profile.run(dev.name) : null;
  steps.push(
    section(
      '**Run it.**',
      runCommand && dev
        ? section(
            codeBlock('bash', runCommand),
            `This runs the ${code(dev.name)} script from ${fileRef(manifest?.path ?? 'package.json')}, which is ${code(dev.command)}.`,
          )
        : inferRunCommand(context, profile),
    ),
  );

  const testCommand = test && profile ? profile.run(test.name) : null;
  steps.push(
    section(
      '**Run the tests.**',
      testCommand && test
        ? section(codeBlock('bash', testCommand), `Runs ${code(test.command)}.`)
        : context.stack.testing.length > 0
          ? `No test script is declared, but ${joinWords(rankDetections(context.stack.testing).map((detection) => detectionLabel(detection)))} ${context.stack.testing.length === 1 ? 'is' : 'are'} present — invoke the runner directly.`
          : `No test script and no test framework were detected. ${context.stats.testFiles > 0 ? `${countLabel(context.stats.testFiles, 'test file')} exist but nothing declares how to run them.` : 'There are no test files either.'}`,
    ),
  );

  const scriptRows = manifest
    ? Object.entries(manifest.scripts).map(([name, command]) => [
        code(profile ? profile.run(name) : name),
        code(command),
      ])
    : [];

  const markdown = section(
    heading(1, 'Setup Guide'),
    `Everything below is derived from what is actually committed to ${code(repoName(context))}: ${profile ? `${profile.name} (${evidence})` : 'no detected package manager'}${manifest ? `, ${countLabel(Object.keys(manifest.scripts).length, 'manifest script')}` : ''}${envTemplate ? `, and the ${code(envTemplate)} template` : ''}.`,
    numberedList(steps),
    scriptRows.length > 0
      ? section(heading(2, 'Every available command'), table(['Command', 'Runs'], scriptRows))
      : null,
    build && profile
      ? section(
          heading(2, 'Production build'),
          codeBlock('bash', profile.run(build.name)),
          `Runs ${code(build.command)}. See *Deployment Guide* for where that output goes.`,
        )
      : null,
    lint && profile && lint.name !== test?.name
      ? `Before opening a pull request, run ${code(profile.run(lint.name))} (${code(lint.command)}).`
      : null,
  );

  const refs: CitationRef[] = [];
  if (manifest) refs.push({ file: manifest.path });
  if (envTemplate) refs.push({ file: envTemplate });
  if (nvmrc) refs.push({ file: '.nvmrc' });
  if (dockerCompose) refs.push({ file: dockerCompose });
  for (const runtime of runtimes) refs.push(...runtime.files.map((file) => ({ file })));
  for (const marker of profile?.marker ?? []) {
    if (findFile(context, marker)) refs.push({ file: marker });
  }

  return makeDoc(
    'setup-guide',
    'Setup Guide',
    profile
      ? `Install with ${code(profile.install)}${runCommand ? `, then run ${code(runCommand)}` : ''}.`
      : 'No package manager was detected, so dependency installation could not be described.',
    markdown,
    ensureCitations(context, citationsFor(context, refs, 10)),
  );
}

/** Best-effort run command when the manifest declares no dev script. */
function inferRunCommand(context: KnowledgeContext, profile: PackageManagerProfile | null): string {
  const manifest = readManifest(context);
  const runnable = context.entryPoints.filter(
    (point) => point.kind === 'server' || point.kind === 'cli' || point.kind === 'app',
  );
  const primary = runnable[0] ?? context.entryPoints[0];

  if (manifest && manifest.binNames.length > 0) {
    return section(
      `The manifest declares ${countLabel(manifest.binNames.length, 'executable')}: ${joinWords(manifest.binNames.map((name) => code(name)))}. After linking the package, invoke one of them directly.`,
      profile ? codeBlock('bash', `${profile.install}\n${manifest.binNames[0] ?? ''} --help`) : '',
    );
  }

  if (!primary) {
    return 'No run script and no entry point were detected, so GitBrain cannot say how this project is started. It may be a library with no executable form.';
  }

  const guess = guessInvocation(primary.path);
  return section(
    `No run script is declared. The entry point is ${fileRef(primary.path)} (${primary.reason}), which is normally invoked as:`,
    guess ? codeBlock('bash', guess) : '',
    'That command is inferred from the file type, not read from a manifest — confirm it before relying on it.',
  );
}

function guessInvocation(path: string): string | null {
  if (/\.[cm]?[jt]sx?$/.test(path)) return `node ${path}`;
  if (/\.py$/.test(path)) return `python ${path}`;
  if (/\.rb$/.test(path)) return `ruby ${path}`;
  if (/\.go$/.test(path)) return `go run ${path}`;
  if (/\.rs$/.test(path)) return 'cargo run';
  if (/\.sh$/.test(path)) return `bash ${path}`;
  if (/\.php$/.test(path)) return `php ${path}`;
  return null;
}

// ---------------------------------------------------------------------------
// Deployment guide
// ---------------------------------------------------------------------------

const PLATFORM_FILES: readonly { readonly path: string; readonly platform: string }[] = [
  { path: 'vercel.json', platform: 'Vercel' },
  { path: 'netlify.toml', platform: 'Netlify' },
  { path: 'fly.toml', platform: 'Fly.io' },
  { path: 'railway.json', platform: 'Railway' },
  { path: 'railway.toml', platform: 'Railway' },
  { path: 'render.yaml', platform: 'Render' },
  { path: 'Procfile', platform: 'Heroku-style buildpack host' },
  { path: 'app.yaml', platform: 'Google App Engine' },
  { path: 'serverless.yml', platform: 'Serverless Framework' },
  { path: 'template.yaml', platform: 'AWS SAM' },
  { path: 'wrangler.toml', platform: 'Cloudflare Workers' },
  { path: 'now.json', platform: 'Vercel (legacy)' },
  { path: 'captain-definition', platform: 'CapRover' },
];

const CI_FILE_PATTERN =
  /^(\.github\/workflows\/.+\.ya?ml|\.gitlab-ci\.yml|\.circleci\/config\.yml|Jenkinsfile|\.drone\.yml|azure-pipelines\.yml|\.travis\.yml|buildspec\.ya?ml|cloudbuild\.ya?ml|\.woodpecker\.ya?ml)$/;

const CONTAINER_PATTERN =
  /(^|\/)(Dockerfile[^/]*|docker-compose\.ya?ml|compose\.ya?ml|Containerfile)$/;

const K8S_PATTERN = /(^|\/)(k8s|kubernetes|deploy|charts|helm|manifests)\/.+\.(ya?ml|tpl)$/;

export function deploymentGuide(context: KnowledgeContext): KnowledgeDoc {
  const manifest = readManifest(context);
  const { profile } = resolvePackageManager(context);

  const detections = rankDetections(context.stack.deployment);
  const ci = rankDetections(context.stack.ci);
  const platformFiles = PLATFORM_FILES.filter((entry) => findFile(context, entry.path));
  const ciFiles = filesMatching(context, CI_FILE_PATTERN, 12);
  const containers = filesMatching(context, CONTAINER_PATTERN, 10);
  const k8s = filesMatching(context, K8S_PATTERN, 10);
  const terraform = filesMatching(context, /\.tf$/, 6);

  const build = pickScript(manifest, ['build', 'compile', 'bundle', 'dist']);
  const start = pickScript(manifest, ['start', 'serve', 'start:prod', 'preview']);

  const anything =
    detections.length > 0 ||
    ci.length > 0 ||
    platformFiles.length > 0 ||
    ciFiles.length > 0 ||
    containers.length > 0 ||
    k8s.length > 0 ||
    terraform.length > 0;

  if (!anything) {
    const markdown = section(
      heading(1, 'Deployment Guide'),
      `**No deployment configuration was detected in ${code(repoName(context))}.**`,
      'GitBrain looked for:',
      bulletList([
        `Platform manifests: ${joinWords(PLATFORM_FILES.slice(0, 8).map((entry) => code(entry.path)))} and others`,
        `CI pipelines: ${joinWords([code('.github/workflows/*.yml'), code('.gitlab-ci.yml'), code('.circleci/config.yml'), code('Jenkinsfile')])}`,
        `Container definitions: ${joinWords([code('Dockerfile'), code('docker-compose.yml')])}`,
        `Infrastructure as code: ${joinWords([code('*.tf'), code('k8s/**'), code('charts/**')])}`,
      ]),
      'None of them are present, so this repository is not deployed from its own contents. It is either a library published to a registry, a component of a larger system that owns the deployment, or deployed by a process that lives elsewhere.',
      build || start
        ? section(
            heading(2, 'What is available anyway'),
            'The manifest does declare commands that a deployment would use:',
            table(
              ['Purpose', 'Command'],
              [
                build && profile ? ['Build', code(profile.run(build.name))] : [],
                start && profile ? ['Start', code(profile.run(start.name))] : [],
              ].filter((row) => row.length > 0),
            ),
          )
        : null,
    );

    return makeDoc(
      'deployment-guide',
      'Deployment Guide',
      'No deployment platform, CI pipeline or container definition was detected in this repository.',
      markdown,
      ensureCitations(context, citationsFor(context, manifest ? [{ file: manifest.path }] : [], 3)),
    );
  }

  const platformNames = [
    ...new Set([
      ...detections.map((detection) => detectionLabel(detection)),
      ...platformFiles.map((entry) => entry.platform),
    ]),
  ];

  const pipelineSteps: string[] = [];
  if (ciFiles.length > 0) {
    pipelineSteps.push(
      `CI runs from ${joinWords(ciFiles.slice(0, 4).map((file) => fileRef(file.path)))}${ci.length > 0 ? ` (${joinWords(ci.map((detection) => detectionLabel(detection)))})` : ''}.`,
    );
  }
  if (build && profile) {
    pipelineSteps.push(
      `The build step is ${code(profile.run(build.name))}, which runs ${code(build.command)}.`,
    );
  }
  if (containers.length > 0) {
    pipelineSteps.push(
      `The artifact is a container image, defined by ${joinWords(containers.slice(0, 3).map((file) => fileRef(file.path)))}.`,
    );
  }
  if (platformNames.length > 0) {
    pipelineSteps.push(`It is deployed to ${joinWords(platformNames)}.`);
  }
  if (start && profile) {
    pipelineSteps.push(
      `In production the process is started with ${code(profile.run(start.name))} (${code(start.command)}).`,
    );
  }
  if (pipelineSteps.length === 0) {
    pipelineSteps.push(
      'Configuration files are present but declare no build or start command that GitBrain can quote.',
    );
  }

  const markdown = section(
    heading(1, 'Deployment Guide'),
    platformNames.length > 0
      ? `${code(repoName(context))} deploys to ${joinWords(platformNames)}.`
      : `${code(repoName(context))} has no platform manifest, but its deployment is described by ${countLabel(ciFiles.length + containers.length + k8s.length, 'configuration file')} in the repository.`,
    section(heading(2, 'The pipeline, as configured'), numberedList(pipelineSteps)),
    platformFiles.length > 0
      ? section(
          heading(2, 'Platform configuration'),
          table(
            ['File', 'Platform'],
            platformFiles.map((entry) => [fileRef(entry.path), entry.platform]),
          ),
        )
      : null,
    detections.length > 0
      ? section(
          heading(2, 'Detected deployment targets'),
          bulletList(
            detections.map(
              (detection) =>
                `**${detectionLabel(detection)}** (${detection.confidence} confidence)${detection.evidence[0] ? ` — ${detection.evidence[0]}` : ''}`,
            ),
          ),
        )
      : null,
    ciFiles.length > 0
      ? section(
          heading(2, `CI pipelines (${formatNumber(ciFiles.length)})`),
          table(
            ['File', 'Lines'],
            ciFiles.map((file) => [fileRef(file.path), formatNumber(file.lines)]),
          ),
        )
      : null,
    containers.length > 0
      ? section(
          heading(2, 'Containers'),
          bulletList(
            containers.map((file) => `${fileRef(file.path)} — ${countLabel(file.lines, 'line')}`),
          ),
          describeDockerfile(
            context,
            containers.map((file) => file.path),
          ),
        )
      : null,
    k8s.length > 0
      ? section(
          heading(2, 'Kubernetes and charts'),
          bulletList(k8s.map((file) => fileRef(file.path))),
        )
      : null,
    terraform.length > 0
      ? section(
          heading(2, 'Infrastructure as code'),
          `${countLabel(terraform.length, 'Terraform file')}: ${joinWords(terraform.map((file) => fileRef(file.path)))}.`,
        )
      : null,
    context.security.undocumentedEnvVars.length > 0
      ? note(
          `Before the first deploy, resolve the ${countLabel(context.security.undocumentedEnvVars.length, 'undocumented environment variable')} listed in *Environment Variables* — an undeclared variable is the most common cause of a build that passes CI and fails on boot.`,
        )
      : null,
  );

  const refs: CitationRef[] = [
    ...platformFiles.map((entry) => ({ file: entry.path })),
    ...ciFiles.map((file) => ({ file: file.path })),
    ...containers.map((file) => ({ file: file.path })),
    ...k8s.slice(0, 3).map((file) => ({ file: file.path })),
    ...terraform.slice(0, 2).map((file) => ({ file: file.path })),
  ];
  if (manifest) refs.push({ file: manifest.path });

  return makeDoc(
    'deployment-guide',
    'Deployment Guide',
    platformNames.length > 0
      ? `Deploys to ${joinWords(platformNames.slice(0, 3))}${ciFiles.length > 0 ? ` via ${countLabel(ciFiles.length, 'CI pipeline')}` : ''}.`
      : `${countLabel(ciFiles.length + containers.length, 'deployment configuration file')} describe how this project is built and shipped.`,
    markdown,
    ensureCitations(context, citationsFor(context, refs, 12)),
  );
}

/** Quote the Dockerfile's own base image and entrypoint rather than guessing. */
function describeDockerfile(context: KnowledgeContext, paths: readonly string[]): string | null {
  const dockerfilePath = paths.find((path) => /Dockerfile/i.test(path));
  if (!dockerfilePath) return null;

  const file = findFile(context, dockerfilePath);
  if (!file?.content) return null;

  const lines = file.content.split(/\r?\n/);
  const bases: string[] = [];
  let exposed: string | null = null;
  let entry: string | null = null;

  for (const line of lines) {
    const from = /^\s*FROM\s+(\S+)/i.exec(line);
    if (from?.[1]) bases.push(from[1]);
    const expose = /^\s*EXPOSE\s+(.+)$/i.exec(line);
    if (expose?.[1] && !exposed) exposed = expose[1].trim();
    const cmd = /^\s*(CMD|ENTRYPOINT)\s+(.+)$/i.exec(line);
    if (cmd?.[2]) entry = `${cmd[1]?.toUpperCase() ?? 'CMD'} ${cmd[2].trim()}`;
  }

  const parts: string[] = [];
  if (bases.length > 0) {
    parts.push(
      bases.length > 1
        ? `A ${formatNumber(bases.length)}-stage build from ${joinWords(bases.map((base) => code(base)))}.`
        : `Built from ${code(bases[0] ?? '')}.`,
    );
  }
  if (exposed) parts.push(`Exposes port ${code(exposed)}.`);
  if (entry) parts.push(`Starts with ${code(entry)}.`);

  return parts.length > 0 ? parts.join(' ') : null;
}

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

export function environmentVariables(context: KnowledgeContext): KnowledgeDoc {
  const usages = context.security.envVars.slice().sort((a, b) => a.name.localeCompare(b.name));
  const template = firstExisting(context, ENV_TEMPLATES);

  if (usages.length === 0) {
    const markdown = section(
      heading(1, 'Environment Variables'),
      `**No environment variable reads were found in ${code(repoName(context))}.**`,
      `GitBrain scans for ${joinWords([code('process.env.X'), code('import.meta.env.X'), code('os.environ["X"]'), code('os.getenv("X")'), code('ENV["X"]'), code('std::env::var("X")')].map((form) => form))} and for names declared in committed ${code('.env')} templates.`,
      template
        ? `${fileRef(template)} is committed but nothing in the source reads from it, which usually means the template has outlived the code that used it.`
        : 'Nothing matched, and no environment template is committed. The project appears to need no runtime configuration.',
    );

    return makeDoc(
      'environment-variables',
      'Environment Variables',
      'No environment variables are read anywhere in this repository.',
      markdown,
      ensureCitations(context, citationsFor(context, template ? [{ file: template }] : [], 2)),
    );
  }

  const undocumented = usages.filter((usage) => !usage.documented);
  const documented = usages.length - undocumented.length;

  const rows = usages.map((usage) => [
    code(usage.name),
    usage.files.length === 0
      ? '—'
      : `${usage.files
          .slice(0, 3)
          .map((file) => code(file))
          .join(', ')}${usage.files.length > 3 ? ` (+${usage.files.length - 3})` : ''}`,
    formatNumber(usage.files.length),
    usage.documented ? 'Yes' : '**No**',
  ]);

  const markdown = section(
    heading(1, 'Environment Variables'),
    `${countLabel(usages.length, 'environment variable')} are read across the codebase. ${documented} of them ${documented === 1 ? 'is' : 'are'} documented in ${template ? fileRef(template) : 'a committed template'}; ${undocumented.length === 0 ? 'none are missing' : `**${formatNumber(undocumented.length)} ${undocumented.length === 1 ? 'is' : 'are'} not**`}.`,
    template
      ? null
      : '**No environment template is committed at all.** Every variable below has to be discovered by reading the source, which is exactly the failure mode a `.env.example` exists to prevent.',
    section(
      heading(2, 'All variables'),
      table(['Variable', 'Read in', 'Files', 'Documented'], rows),
    ),
    undocumented.length > 0
      ? section(
          heading(2, `Action list — ${formatNumber(undocumented.length)} undocumented`),
          `Add each of these to ${template ? code(template) : code('.env.example')} with a placeholder value and a one-line comment. Until then, a new environment cannot be provisioned without reading the source.`,
          numberedList(
            undocumented.map(
              (usage) =>
                `${code(usage.name)} — read in ${joinWords(usage.files.slice(0, 3).map((file) => fileRef(file)))}${usage.files.length > 3 ? ` and ${formatNumber(usage.files.length - 3)} more` : ''}`,
            ),
          ),
          template
            ? null
            : codeBlock('bash', undocumented.map((usage) => `${usage.name}=`).join('\n')),
        )
      : section(
          heading(2, 'Action list'),
          'None. Every environment variable the code reads is present in the committed template.',
        ),
    context.security.secrets.length > 0
      ? note(
          `${countLabel(context.security.secrets.length, 'hard-coded secret')} were also found in the source — those are credentials that were never moved into the environment at all. See *Security Risks*.`,
        )
      : null,
  );

  const refs: CitationRef[] = [];
  if (template) refs.push({ file: template });
  for (const usage of usages) {
    for (const file of usage.files.slice(0, 1)) refs.push({ file });
  }

  return makeDoc(
    'environment-variables',
    'Environment Variables',
    `${countLabel(usages.length, 'environment variable')} are read; ${undocumented.length === 0 ? 'all are documented' : `${formatNumber(undocumented.length)} are undocumented`}.`,
    markdown,
    ensureCitations(context, citationsFor(context, refs, 12)),
  );
}

/** Re-exported so tests can assert on the manifest shape the guides consume. */
export type { PackageManifest };
