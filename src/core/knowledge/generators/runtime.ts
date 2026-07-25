/**
 * Runtime-surface documents: authentication, the HTTP/RPC boundary, and
 * persistence.
 *
 * These three are the ones most easily faked, and a fabricated auth flow is
 * worse than no auth flow — it tells a reader the system is protected when
 * nobody has checked. So each generator states exactly what it searched for,
 * reports what it found with `file:line` evidence, and says plainly when the
 * answer is "nothing".
 */

import type { ApiEndpoint, KnowledgeDoc } from '../../types';
import {
  citationsFor,
  detectionLabel,
  ensureCitations,
  filesMatching,
  grep,
  rankDetections,
  repoName,
  topDetection,
  type CitationRef,
  type KnowledgeContext,
} from '../context';
import {
  bulletList,
  code,
  countLabel,
  fileRef,
  formatNumber,
  heading,
  joinWords,
  makeDoc,
  mermaid,
  mermaidLabel,
  note,
  section,
  table,
} from '../format';

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/** Packages whose presence is decisive evidence of an authentication strategy. */
const AUTH_PACKAGES: readonly { readonly match: RegExp; readonly label: string }[] = [
  { match: /^next-auth$|^@auth\//, label: 'Auth.js / NextAuth session handling' },
  { match: /^@clerk\//, label: 'Clerk hosted authentication' },
  { match: /^@auth0\/|^auth0$/, label: 'Auth0 hosted authentication' },
  { match: /^@supabase\/(supabase-js|ssr|auth-helpers)/, label: 'Supabase Auth' },
  { match: /^firebase$|^firebase-admin$/, label: 'Firebase Authentication' },
  { match: /^passport(-|$)/, label: 'Passport strategy middleware' },
  { match: /^lucia$|^oslo(-|$)/, label: 'Lucia session management' },
  {
    match: /^jsonwebtoken$|^jose$|^pyjwt$|^python-jose$|^jwt-decode$/,
    label: 'JWT signing or verification',
  },
  { match: /^bcrypt|^bcryptjs$|^argon2|^scrypt|^passlib$/, label: 'Password hashing' },
  {
    match: /^express-session$|^cookie-session$|^iron-session$|^@fastify\/session$/,
    label: 'Server-side sessions',
  },
  {
    match: /^authlib$|^django-allauth$|^devise$|^warden$/,
    label: 'Framework authentication library',
  },
  { match: /^casbin$|^@casl\//, label: 'Authorization policy engine' },
  { match: /^oauth|^simple-oauth2$|^openid-client$/, label: 'OAuth / OIDC client' },
];

/** Call sites that only appear in code that actually authenticates something. */
const AUTH_CODE_SIGNALS =
  /\b(jwt\.(sign|verify)|jsonwebtoken|getServerSession|useSession|signIn\(|signOut\(|bcrypt\.(hash|compare)|argon2\.(hash|verify)|passport\.(authenticate|use)|requireAuth|isAuthenticated|currentUser|withAuth|authorize\(|login_required|@login_required|check_password|set_password|createSession|destroySession|verifyToken|validateToken|Authorization:\s*Bearer)/;

/** Paths whose names claim to implement authentication. */
const AUTH_PATH_PATTERN =
  /(^|\/)(auth|authentication|authorization|session|sessions|login|signin|sign-in|signup|sign-up|oauth|identity|permissions|rbac)([./-]|$)/i;

/** Endpoint paths that look like the authentication surface. */
const AUTH_ENDPOINT_PATTERN =
  /(login|logout|signin|signout|signup|register|token|refresh|auth|session|oauth|callback|me|whoami)/i;

/** Environment variables that only exist to configure authentication. */
const AUTH_ENV_PATTERN =
  /(^|_)(JWT|AUTH|NEXTAUTH|SESSION|CLERK|SUPABASE|OAUTH|OIDC|SAML|COGNITO|OKTA|AUTH0|KEYCLOAK)(_|$)|SECRET$|CLIENT_ID$|CLIENT_SECRET$|_TOKEN$/;

export function authenticationFlow(context: KnowledgeContext): KnowledgeDoc {
  const packages = context.dependencies.dependencies.filter((dependency) =>
    AUTH_PACKAGES.some((entry) => entry.match.test(dependency.name)),
  );
  const packageLabels = [
    ...new Set(
      packages.flatMap((dependency) =>
        AUTH_PACKAGES.filter((entry) => entry.match.test(dependency.name)).map(
          (entry) => entry.label,
        ),
      ),
    ),
  ];

  const authFiles = filesMatching(context, AUTH_PATH_PATTERN, 20).filter((file) => !file.isBinary);
  const codeSignals = grep(context, AUTH_CODE_SIGNALS, 25);
  const authEndpoints = context.stack.api.endpoints.filter((endpoint) =>
    AUTH_ENDPOINT_PATTERN.test(endpoint.path),
  );
  const authEnvVars = context.security.envVars.filter((usage) => AUTH_ENV_PATTERN.test(usage.name));

  const implemented =
    packages.length > 0 ||
    codeSignals.length > 0 ||
    authEndpoints.length > 0 ||
    authFiles.length > 0;

  const searchedFor = bulletList([
    `Dependencies matching known authentication libraries (${joinWords(['next-auth', '@clerk/*', 'passport', 'jsonwebtoken', 'bcrypt', 'lucia', 'express-session', 'authlib', 'devise'].map((name) => code(name)))} and ${formatNumber(AUTH_PACKAGES.length)} patterns in total)`,
    `Source files whose path contains ${joinWords(['auth', 'session', 'login', 'signup', 'oauth', 'identity', 'permissions'].map((word) => code(word)))}`,
    `Call sites such as ${joinWords(['jwt.sign', 'jwt.verify', 'bcrypt.compare', 'getServerSession', 'passport.authenticate', 'requireAuth'].map((name) => code(name)))}`,
    'Detected HTTP endpoints whose path looks like a login, logout, token or callback route',
    'Environment variables named for secrets, client credentials or session configuration',
  ]);

  if (!implemented) {
    const markdown = section(
      heading(1, 'Authentication Flow'),
      `**No authentication or authorization implementation was detected in ${code(repoName(context))}.**`,
      'GitBrain does not have an authentication flow to describe here, and will not invent one. This is what it searched for and did not find:',
      searchedFor,
      authEnvVars.length > 0
        ? section(
            heading(2, 'One ambiguous signal'),
            `${countLabel(authEnvVars.length, 'environment variable')} carry names that often belong to an auth system — ${joinWords(authEnvVars.slice(0, 8).map((usage) => code(usage.name)))} — but no code was found that verifies a credential, issues a session or guards a route. Either the variables are used for something else, the auth layer lives in a service outside this repository, or it is configured entirely through a platform the code never names.`,
          )
        : null,
      section(
        heading(2, 'What this means'),
        bulletList([
          context.stack.api.endpoints.length > 0
            ? `${countLabel(context.stack.api.endpoints.length, 'HTTP endpoint')} were detected and none of them is guarded by anything GitBrain can see. If this service is reachable from a network, treat every endpoint as unauthenticated until proven otherwise.`
            : 'No HTTP surface was detected either, so there may simply be nothing to authenticate — a library, a CLI or a build tool needs no auth layer.',
          'Authentication enforced by a reverse proxy, an API gateway, a service mesh or a platform-level policy is invisible to static analysis of this repository.',
        ]),
      ),
      note(
        'Absence of evidence in a source snapshot is not proof that a deployed system is unauthenticated — but it does mean nothing in this repository authenticates anything.',
      ),
    );

    return makeDoc(
      'authentication-flow',
      'Authentication Flow',
      `No authentication implementation was detected in ${repoName(context)}; GitBrain reports what it searched for rather than inferring a flow.`,
      markdown,
      ensureCitations(
        context,
        citationsFor(
          context,
          authEnvVars.flatMap((usage) => usage.files.slice(0, 1).map((file) => ({ file }))),
          4,
        ),
      ),
    );
  }

  const strategy = packageLabels[0] ?? 'a hand-rolled implementation';
  const framework = topDetection(context.stack.frameworks);
  const database = topDetection(context.stack.databases);

  const participants = [
    { id: 'C', label: 'Client' },
    { id: 'A', label: framework ? detectionLabel(framework) : 'Application' },
    { id: 'S', label: packageLabels[0] ? shortLabel(packageLabels[0]) : 'Auth logic' },
  ];
  if (database) participants.push({ id: 'D', label: detectionLabel(database) });

  const loginEndpoint =
    authEndpoints.find((endpoint) => /login|signin|token/i.test(endpoint.path)) ?? authEndpoints[0];
  const guardSignal = codeSignals.find((signal) =>
    /requireAuth|isAuthenticated|getServerSession|withAuth|login_required|verifyToken/.test(
      signal.text,
    ),
  );

  const diagram = mermaid(
    [
      'sequenceDiagram',
      ...participants.map(
        (participant) =>
          `  participant ${participant.id} as ${mermaidLabel(participant.label, 24)}`,
      ),
      `  C->>A: ${loginEndpoint ? `${loginEndpoint.method} ${mermaidLabel(loginEndpoint.path, 32)}` : 'Credential submission'}`,
      `  A->>S: ${packageLabels[0] ? mermaidLabel(packageLabels[0], 34) : 'Verify credential'}`,
      ...(database ? [`  S->>D: Look up the account record`, `  D-->>S: Account`] : []),
      `  S-->>A: Session or token`,
      `  A-->>C: ${loginEndpoint ? 'Authenticated response' : 'Session established'}`,
      `  C->>A: Subsequent request with credential`,
      `  A->>S: ${guardSignal ? mermaidLabel(guardSignal.text, 34) : 'Re-validate credential'}`,
      `  S-->>A: Allow or reject`,
    ].join('\n'),
  );

  const markdown = section(
    heading(1, 'Authentication Flow'),
    `${code(repoName(context))} authenticates using ${strategy}${packageLabels.length > 1 ? `, alongside ${joinWords(packageLabels.slice(1))}` : ''}. The evidence below is what that conclusion rests on; the sequence diagram is the flow those components imply, not a trace of a running system.`,
    packageLabels.length > 0
      ? section(
          heading(2, 'Detected mechanisms'),
          table(
            ['Package', 'Role', 'Range', 'Declared in'],
            packages
              .slice(0, 15)
              .map((dependency) => [
                code(dependency.name),
                AUTH_PACKAGES.find((entry) => entry.match.test(dependency.name))?.label ??
                  'Authentication',
                code(dependency.range),
                code(dependency.manifest),
              ]),
          ),
        )
      : null,
    section(heading(2, 'Inferred flow'), diagram),
    codeSignals.length > 0
      ? section(
          heading(2, `Call sites (${formatNumber(codeSignals.length)})`),
          table(
            ['Location', 'Code'],
            codeSignals
              .slice(0, 15)
              .map((signal) => [fileRef(signal.file, signal.line), code(signal.text)]),
          ),
        )
      : null,
    authEndpoints.length > 0
      ? section(
          heading(2, `Authentication endpoints (${formatNumber(authEndpoints.length)})`),
          table(
            ['Method', 'Path', 'Defined at'],
            authEndpoints
              .slice(0, 20)
              .map((endpoint) => [
                code(endpoint.method.toUpperCase()),
                code(endpoint.path),
                fileRef(endpoint.file, endpoint.line),
              ]),
          ),
        )
      : null,
    authFiles.length > 0
      ? section(
          heading(2, 'Files that own the auth surface'),
          bulletList(
            authFiles
              .slice(0, 12)
              .map((file) => `${fileRef(file.path)} — ${countLabel(file.lines, 'line')}`),
          ),
        )
      : null,
    authEnvVars.length > 0
      ? section(
          heading(2, 'Configuration this flow depends on'),
          table(
            ['Variable', 'Read in', 'Documented'],
            authEnvVars.slice(0, 20).map((usage) => [
              code(usage.name),
              usage.files
                .slice(0, 3)
                .map((file) => code(file))
                .join(', ') || '—',
              usage.documented ? 'Yes' : '**No**',
            ]),
          ),
          authEnvVars.some((usage) => !usage.documented)
            ? 'Undocumented auth configuration is the most common cause of a deployment that starts but rejects every login.'
            : null,
        )
      : null,
    note(
      'The diagram is derived from the components that were detected, not from an execution trace. Verify the ordering against the call sites listed above before relying on it.',
    ),
  );

  const refs: CitationRef[] = [
    ...codeSignals.slice(0, 8).map((signal) => ({
      file: signal.file,
      startLine: signal.line,
      excerpt: signal.text,
    })),
    ...authEndpoints.slice(0, 4).map((endpoint) => ({
      file: endpoint.file,
      startLine: endpoint.line,
    })),
    ...authFiles.slice(0, 5).map((file) => ({ file: file.path })),
    ...context.dependencies.manifests.map((manifest) => ({ file: manifest })),
  ];

  return makeDoc(
    'authentication-flow',
    'Authentication Flow',
    `Authentication is implemented with ${strategy}, evidenced by ${countLabel(codeSignals.length, 'call site')} and ${countLabel(authEndpoints.length, 'auth endpoint')}.`,
    markdown,
    ensureCitations(context, citationsFor(context, refs, 12)),
  );
}

/** Trim a long capability label down to something a diagram participant can hold. */
function shortLabel(label: string): string {
  const cut = label.split(/\s+—|\s+\(/)[0] ?? label;
  const words = cut.split(/\s+/);
  return words.slice(0, 3).join(' ');
}

// ---------------------------------------------------------------------------
// API overview
// ---------------------------------------------------------------------------

export function apiOverview(context: KnowledgeContext): KnowledgeDoc {
  const api = context.stack.api;
  const endpoints = api.endpoints;

  if (endpoints.length === 0) {
    const markdown = section(
      heading(1, 'API Overview'),
      api.style === 'none' || api.style === 'unknown'
        ? `**No API surface was detected in ${code(repoName(context))}.**`
        : `GitBrain classified the API style as ${code(api.style)} but could not extract any individual endpoints.`,
      'It looks for route definitions in framework conventions (`app/**/route.ts`, `pages/api/**`, Express/Fastify/Koa router calls, FastAPI and Flask decorators, Django URL patterns, Go `http.HandleFunc`, Rails routes), GraphQL schema definitions, tRPC routers and gRPC service definitions.',
      api.evidence.length > 0
        ? section(heading(2, 'What was seen'), bulletList(api.evidence.slice(0, 8)))
        : 'None of those patterns matched, so this repository most likely does not serve network traffic directly — it may be a library, a CLI, a build tool, or a client that only consumes other services.',
    );

    return makeDoc(
      'api-overview',
      'API Overview',
      'No API endpoints were detected in this repository.',
      markdown,
      ensureCitations(context, []),
    );
  }

  const byResource = groupByResource(endpoints);
  const byMethod = new Map<string, number>();
  for (const endpoint of endpoints) {
    const method = endpoint.method.toUpperCase();
    byMethod.set(method, (byMethod.get(method) ?? 0) + 1);
  }

  const files = new Set(endpoints.map((endpoint) => endpoint.file));

  const markdown = section(
    heading(1, 'API Overview'),
    `${code(repoName(context))} exposes a ${api.style.toUpperCase()} interface (${api.confidence} confidence) with ${countLabel(endpoints.length, 'detected endpoint')} across ${countLabel(files.size, 'file')}, grouped into ${countLabel(byResource.length, 'resource')}.`,
    api.evidence.length > 0
      ? section(heading(2, 'How the style was determined'), bulletList(api.evidence.slice(0, 6)))
      : null,
    section(
      heading(2, 'Methods'),
      table(
        ['Method', 'Endpoints'],
        [...byMethod.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([method, count]) => [code(method), formatNumber(count)]),
      ),
    ),
    ...byResource.map((group) =>
      section(
        heading(2, `${group.resource} (${formatNumber(group.endpoints.length)})`),
        table(
          ['Method', 'Path', 'Defined at'],
          group.endpoints.map((endpoint) => [
            code(endpoint.method.toUpperCase()),
            code(endpoint.path),
            fileRef(endpoint.file, endpoint.line),
          ]),
        ),
      ),
    ),
    note(
      'Endpoints are extracted from route declarations in source. Routes registered dynamically, mounted from a variable prefix, or added by middleware at runtime will not appear here.',
    ),
  );

  const refs: CitationRef[] = endpoints
    .slice(0, 15)
    .map((endpoint) => ({ file: endpoint.file, startLine: endpoint.line }));

  return makeDoc(
    'api-overview',
    'API Overview',
    `${countLabel(endpoints.length, 'endpoint')} over ${api.style.toUpperCase()}, spanning ${countLabel(byResource.length, 'resource')}.`,
    markdown,
    ensureCitations(context, citationsFor(context, refs, 12)),
  );
}

interface ResourceGroup {
  readonly resource: string;
  readonly endpoints: readonly ApiEndpoint[];
}

/**
 * Group endpoints by their first meaningful path segment.
 *
 * Version prefixes (`/api`, `/v1`) are skipped so `/api/v1/users` and `/users`
 * land in the same group, which is how a reader thinks about them.
 */
function groupByResource(endpoints: readonly ApiEndpoint[]): readonly ResourceGroup[] {
  const groups = new Map<string, ApiEndpoint[]>();

  for (const endpoint of endpoints) {
    const segments = endpoint.path
      .split('/')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);

    const meaningful = segments.find(
      (segment) =>
        !/^(api|v\d+|graphql|rest|rpc)$/i.test(segment) &&
        !segment.startsWith(':') &&
        !segment.startsWith('{'),
    );

    const resource = meaningful ?? segments[0] ?? '/';
    const bucket = groups.get(resource);
    if (bucket) bucket.push(endpoint);
    else groups.set(resource, [endpoint]);
  }

  return [...groups.entries()]
    .map(([resource, list]) => ({
      resource,
      endpoints: list
        .slice()
        .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)),
    }))
    .sort(
      (a, b) => b.endpoints.length - a.endpoints.length || a.resource.localeCompare(b.resource),
    );
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/** Packages that prove a datastore is being talked to, and what kind. */
const DATA_PACKAGES: readonly { readonly match: RegExp; readonly label: string }[] = [
  { match: /^prisma$|^@prisma\/client$/, label: 'Prisma ORM' },
  { match: /^drizzle-orm$|^drizzle-kit$/, label: 'Drizzle ORM' },
  { match: /^typeorm$/, label: 'TypeORM' },
  { match: /^sequelize$/, label: 'Sequelize ORM' },
  { match: /^mongoose$/, label: 'Mongoose ODM' },
  { match: /^knex$|^kysely$/, label: 'SQL query builder' },
  { match: /^@mikro-orm\//, label: 'MikroORM' },
  { match: /^pg$|^postgres$|^node-postgres$|^psycopg2|^asyncpg$/, label: 'PostgreSQL driver' },
  { match: /^mysql2?$|^mariadb$/, label: 'MySQL driver' },
  { match: /^sqlite3$|^better-sqlite3$/, label: 'SQLite driver' },
  { match: /^mongodb$/, label: 'MongoDB driver' },
  { match: /^redis$|^ioredis$/, label: 'Redis client' },
  { match: /^sqlalchemy$|^alembic$/, label: 'SQLAlchemy' },
  { match: /^gorm\.io\/gorm$|^gorm$/, label: 'GORM' },
  { match: /^diesel$|^sqlx$/, label: 'Rust SQL toolkit' },
  { match: /^@supabase\/supabase-js$/, label: 'Supabase client' },
  { match: /^firebase-admin$/, label: 'Firestore / Realtime Database' },
];

const SCHEMA_PATH_PATTERN =
  /(schema\.prisma$|\.sql$|(^|\/)migrations?\/|(^|\/)models?[./]|(^|\/)entities?\/|(^|\/)schemas?\/|schema\.(ts|js|py|rb)$)/i;

const MODEL_PATTERN =
  /^\s*(?:model\s+([A-Za-z_]\w*)\s*\{|CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([A-Za-z_]\w*)|(?:export\s+)?const\s+([A-Za-z_]\w*)\s*=\s*(?:pg|mysql|sqlite)Table\(|class\s+([A-Za-z_]\w*)\s*\(\s*(?:db\.)?(?:Base|Model)\s*\))/;

export function databaseOverview(context: KnowledgeContext): KnowledgeDoc {
  const detections = rankDetections(context.stack.databases);
  const packages = context.dependencies.dependencies.filter((dependency) =>
    DATA_PACKAGES.some((entry) => entry.match.test(dependency.name)),
  );
  const schemaFiles = filesMatching(context, SCHEMA_PATH_PATTERN, 30);
  const models = grep(context, MODEL_PATTERN, 40);

  const anything =
    detections.length > 0 || packages.length > 0 || schemaFiles.length > 0 || models.length > 0;

  if (!anything) {
    const markdown = section(
      heading(1, 'Database Overview'),
      `**No datastore was detected in ${code(repoName(context))}.**`,
      'GitBrain searched for:',
      bulletList([
        `Declared database drivers and ORMs (${joinWords(['prisma', 'drizzle-orm', 'typeorm', 'mongoose', 'pg', 'mysql2', 'redis', 'sqlalchemy', 'gorm'].map((name) => code(name)))} and ${formatNumber(DATA_PACKAGES.length)} patterns in total)`,
        `Schema and migration files (${joinWords([code('schema.prisma'), code('*.sql'), code('migrations/'), code('models/'), code('entities/')])})`,
        'Table and model declarations in source (`model X {`, `CREATE TABLE`, `pgTable(`, SQLAlchemy model classes)',
        'Connection strings in environment configuration',
      ]),
      'None of them matched. The project either keeps no persistent state, stores it through a service accessed over HTTP, or reads and writes plain files.',
      context.security.envVars.filter((usage) =>
        /DATABASE|DB_|POSTGRES|MYSQL|MONGO|REDIS|SQL/i.test(usage.name),
      ).length > 0
        ? `One caveat: ${joinWords(
            context.security.envVars
              .filter((usage) => /DATABASE|DB_|POSTGRES|MYSQL|MONGO|REDIS|SQL/i.test(usage.name))
              .slice(0, 5)
              .map((usage) => code(usage.name)),
          )} appear in the environment configuration, which suggests a database exists somewhere even though no client code in this repository connects to one.`
        : null,
    );

    return makeDoc(
      'database-overview',
      'Database Overview',
      'No database, ORM or schema was detected in this repository.',
      markdown,
      ensureCitations(context, []),
    );
  }

  const modelNames = [
    ...new Set(
      models
        .map((match) => {
          const found = MODEL_PATTERN.exec(match.text);
          return found?.[1] ?? found?.[2] ?? found?.[3] ?? found?.[4] ?? null;
        })
        .filter((value): value is string => value !== null),
    ),
  ];

  const migrations = schemaFiles.filter((file) => /migrations?\//i.test(file.path));

  const markdown = section(
    heading(1, 'Database Overview'),
    detections.length > 0
      ? `${code(repoName(context))} persists data in ${joinWords(detections.map((detection) => `**${detectionLabel(detection)}** (${detection.confidence} confidence)`))}.`
      : `No database engine was named outright, but ${countLabel(packages.length, 'data-access package')} and ${countLabel(schemaFiles.length, 'schema file')} show that this project does persist state.`,
    detections.length > 0
      ? section(
          heading(2, 'Why'),
          bulletList(detections.flatMap((detection) => detection.evidence.slice(0, 3))),
        )
      : null,
    packages.length > 0
      ? section(
          heading(2, 'Data-access layer'),
          table(
            ['Package', 'Role', 'Range', 'Declared in'],
            packages.map((dependency) => [
              code(dependency.name),
              DATA_PACKAGES.find((entry) => entry.match.test(dependency.name))?.label ??
                'Data access',
              code(dependency.range),
              code(dependency.manifest),
            ]),
          ),
        )
      : null,
    modelNames.length > 0
      ? section(
          heading(2, `Declared models and tables (${formatNumber(modelNames.length)})`),
          `${joinWords(modelNames.slice(0, 30).map((name) => code(name)))}${modelNames.length > 30 ? `, and ${formatNumber(modelNames.length - 30)} more` : ''}.`,
          table(
            ['Declaration', 'Location'],
            models
              .slice(0, 25)
              .map((match) => [code(match.text.slice(0, 90)), fileRef(match.file, match.line)]),
          ),
        )
      : null,
    schemaFiles.length > 0
      ? section(
          heading(2, `Schema and migration files (${formatNumber(schemaFiles.length)})`),
          table(
            ['File', 'Lines'],
            schemaFiles.slice(0, 20).map((file) => [code(file.path), formatNumber(file.lines)]),
          ),
          migrations.length > 0
            ? `${countLabel(migrations.length, 'file')} sit under a migrations directory, so schema changes are version-controlled rather than applied by hand.`
            : 'No migrations directory was found — schema changes do not appear to be version-controlled in this repository.',
        )
      : null,
    note(
      'Model names are extracted by pattern matching on declarations. Tables created dynamically, or defined in a schema outside this repository, will not appear.',
    ),
  );

  const refs: CitationRef[] = [
    ...schemaFiles.slice(0, 6).map((file) => ({ file: file.path })),
    ...models.slice(0, 6).map((match) => ({
      file: match.file,
      startLine: match.line,
      excerpt: match.text,
    })),
    ...detections.flatMap((detection) => detection.files.slice(0, 2).map((file) => ({ file }))),
    ...context.dependencies.manifests.map((manifest) => ({ file: manifest })),
  ];

  const engine = detections[0];

  return makeDoc(
    'database-overview',
    'Database Overview',
    engine
      ? `Persists data in ${detectionLabel(engine)}${modelNames.length > 0 ? ` across ${countLabel(modelNames.length, 'declared model')}` : ''}.`
      : `No engine was named, but ${countLabel(packages.length, 'data-access package')} and ${countLabel(schemaFiles.length, 'schema file')} were found.`,
    markdown,
    ensureCitations(context, citationsFor(context, refs, 12)),
  );
}
