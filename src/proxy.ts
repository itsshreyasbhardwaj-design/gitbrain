/**
 * Edge proxy — the Next.js 16 replacement for the `middleware` convention.
 *
 * Clerk's handler is only engaged when Clerk is actually configured. Importing
 * `clerkMiddleware` unconditionally would make a missing publishable key a hard
 * boot failure, which would break the project's core promise that it runs with
 * zero configuration.
 */

import { NextResponse, type NextRequest } from 'next/server';

const clerkConfigured = Boolean(
  process.env.CLERK_SECRET_KEY && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
);

export default async function proxy(request: NextRequest): Promise<NextResponse> {
  if (!clerkConfigured) return NextResponse.next();

  const { clerkMiddleware } = await import('@clerk/nextjs/server');
  const handler = clerkMiddleware();

  // Clerk's handler returns a Response; normalise it to what Next expects.
  const result = await handler(request, {} as never);
  return (result as NextResponse | undefined) ?? NextResponse.next();
}

export const config = {
  matcher: [
    // Everything except static assets and image optimisation output.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
    '/api/(.*)',
  ],
};
