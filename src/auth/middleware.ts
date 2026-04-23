import type { Context, Next } from 'hono';
import type { AppEnv, OpenClawEnv } from '../types';
import { verifyAccessJWT } from './jwt';

/**
 * Options for creating an access middleware
 */
export interface AccessMiddlewareOptions {
  /** Response type: 'json' for API routes, 'html' for UI routes */
  type: 'json' | 'html';
  /** Whether to redirect to login when JWT is missing (only for 'html' type) */
  redirectOnMissing?: boolean;
}

/**
 * Check if running in development mode (skips CF Access auth + device pairing)
 */
export function isDevMode(env: OpenClawEnv): boolean {
  return env.DEV_MODE === 'true';
}

/**
 * Check if running in E2E test mode (skips CF Access auth but keeps device pairing)
 */
export function isE2ETestMode(env: OpenClawEnv): boolean {
  return env.E2E_TEST_MODE === 'true';
}

/**
 * Extract JWT from request headers or cookies
 */
export function extractJWT(c: Context<AppEnv>): string | null {
  const jwtHeader = c.req.header('CF-Access-JWT-Assertion');
  const jwtCookie = c.req.raw.headers
    .get('Cookie')
    ?.split(';')
    .find((cookie) => cookie.trim().startsWith('CF_Authorization='))
    ?.split('=')[1];

  return jwtHeader || jwtCookie || null;
}

const readCookie = (cookieHeader: string | null | undefined, name: string): string | null => {
  if (!cookieHeader) return null;
  const match = cookieHeader
    .split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name}=`));
  if (!match) return null;
  return decodeURIComponent(match.slice(name.length + 1));
};

export function extractGatewayToken(c: Context<AppEnv>): string | null {
  let queryToken: string | null = null;
  try {
    queryToken = new URL((c.req.raw as Request).url).searchParams.get('token');
  } catch {
    queryToken = null;
  }
  const bearerToken = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '') || null;
  const cookieToken = readCookie(c.req.header('Cookie'), 'openclaw_gateway_token');
  return queryToken || bearerToken || cookieToken;
}

const readGatewayTokenSources = (c: Context<AppEnv>) => {
  let queryToken: string | null = null;
  try {
    queryToken = new URL((c.req.raw as Request).url).searchParams.get('token');
  } catch {
    queryToken = null;
  }
  const bearerToken = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '') || null;
  const cookieToken = readCookie(c.req.header('Cookie'), 'openclaw_gateway_token');
  return { queryToken, bearerToken, cookieToken };
};

const buildGatewaySessionCookie = (token: string): string =>
  [
    `openclaw_gateway_token=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=86400',
  ].join('; ');

/**
 * Create a Cloudflare Access authentication middleware
 *
 * @param options - Middleware options
 * @returns Hono middleware function
 */
export function createAccessMiddleware(options: AccessMiddlewareOptions) {
  const { type, redirectOnMissing = false } = options;

  return async (c: Context<AppEnv>, next: Next) => {
    // Allow gateway-token-authenticated requests (service bindings, programmatic access).
    // These callers don't have a CF Access JWT but present the shared gateway token,
    // which OpenClaw itself will re-validate inside the container.
    const { queryToken, bearerToken, cookieToken } = readGatewayTokenSources(c);
    const incomingToken = queryToken || bearerToken || cookieToken;
    if (incomingToken && c.env.MOLTBOT_GATEWAY_TOKEN && incomingToken === c.env.MOLTBOT_GATEWAY_TOKEN) {
      const acceptsHtml = c.req.header('Accept')?.includes('text/html');
      if (queryToken && c.req.method === 'GET' && acceptsHtml) {
        const url = new URL((c.req.raw as Request).url);
        url.searchParams.delete('token');
        const response = c.redirect(url.toString(), 302);
        response.headers.append('Set-Cookie', buildGatewaySessionCookie(incomingToken));
        return response;
      }
      c.set('accessUser', { email: 'service@internal', name: 'Service Client' });
      c.set('gatewayTokenAuth', true);
      await next();
      if (bearerToken === incomingToken) {
        c.header('Set-Cookie', buildGatewaySessionCookie(incomingToken), { append: true });
      }
      return;
    }

    // Skip auth in dev mode or E2E test mode
    if (isDevMode(c.env) || isE2ETestMode(c.env)) {
      c.set('accessUser', { email: 'dev@localhost', name: 'Dev User' });
      return next();
    }

    const teamDomain = c.env.CF_ACCESS_TEAM_DOMAIN;
    const expectedAud = c.env.CF_ACCESS_AUD;

    // Check if CF Access is configured
    if (!teamDomain || !expectedAud) {
      if (type === 'json') {
        return c.json(
          {
            error: 'Cloudflare Access not configured',
            hint: 'Set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD environment variables',
          },
          500,
        );
      } else {
        return c.html(
          `
          <html>
            <body>
              <h1>Admin UI Not Configured</h1>
              <p>Set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD environment variables.</p>
            </body>
          </html>
        `,
          500,
        );
      }
    }

    // Get JWT
    const jwt = extractJWT(c);

    if (!jwt) {
      if (type === 'html' && redirectOnMissing) {
        return c.redirect(`https://${teamDomain}`, 302);
      }

      if (type === 'json') {
        return c.json(
          {
            error: 'Unauthorized',
            hint: 'Missing Cloudflare Access JWT. Ensure this route is protected by Cloudflare Access.',
          },
          401,
        );
      } else {
        return c.html(
          `
          <html>
            <body>
              <h1>Unauthorized</h1>
              <p>Missing Cloudflare Access token.</p>
              <a href="https://${teamDomain}">Login</a>
            </body>
          </html>
        `,
          401,
        );
      }
    }

    // Verify JWT
    try {
      const payload = await verifyAccessJWT(jwt, teamDomain, expectedAud);
      c.set('accessUser', { email: payload.email, name: payload.name });
      await next();
    } catch (err) {
      console.error('Access JWT verification failed:', err);

      if (type === 'json') {
        return c.json(
          {
            error: 'Unauthorized',
            details: err instanceof Error ? err.message : 'JWT verification failed',
          },
          401,
        );
      } else {
        return c.html(
          `
          <html>
            <body>
              <h1>Unauthorized</h1>
              <p>Your Cloudflare Access session is invalid or expired.</p>
              <a href="https://${teamDomain}">Login again</a>
            </body>
          </html>
        `,
          401,
        );
      }
    }
  };
}
