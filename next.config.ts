import type { NextConfig } from 'next';

/**
 * Content Security Policy.
 *
 * GitBrain renders Markdown generated from untrusted repository contents, so
 * the CSP is the backstop behind `rehype-sanitize`. Two relaxations are
 * deliberate and worth stating:
 *
 *   - `'unsafe-inline'` in `style-src`: React Flow and the inline SVG charts
 *     set positions via the `style` attribute, which cannot be nonce'd.
 *   - `'unsafe-eval'` in development only: Turbopack's HMR runtime needs it.
 *     It is absent in production.
 */
function contentSecurityPolicy(isDev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // Clerk and OpenRouter are contacted only when configured; both are
    // listed unconditionally because the policy is static.
    "connect-src 'self' https://api.github.com https://codeload.github.com https://openrouter.ai https://*.clerk.accounts.dev https://*.supabase.co",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    'upgrade-insecure-requests',
  ].join('; ');
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // Fail the production build on a type error rather than shipping it.
  // (Next 16 no longer takes an `eslint` key; `pnpm verify` and CI run ESLint.)
  typescript: { ignoreBuildErrors: false },

  experimental: {
    // Import only the icons actually used instead of the whole barrel.
    optimizePackageImports: ['lucide-react', '@xyflow/react', 'framer-motion'],
  },

  async headers() {
    const isDev = process.env.NODE_ENV !== 'production';

    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: contentSecurityPolicy(isDev) },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
