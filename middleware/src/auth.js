import { createHmac, timingSafeEqual } from 'node:crypto';

// Verifies the Shopify session token sent by the POS extension.
// It's a JWT signed (HS256) with the app's client secret. We check the
// signature, expiry, that it was issued for our app, and that the shop is one
// we serve. No library needed for HS256.

const b64urlDecode = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function verifySessionToken(token, { apiKey, apiSecret, allowedShops, now = Date.now() }) {
  if (!token || typeof token !== 'string') throw new AuthError('Missing session token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('Malformed session token');
  const [headerB64, payloadB64, sigB64] = parts;

  const header = JSON.parse(b64urlDecode(headerB64).toString('utf8'));
  if (header.alg !== 'HS256') throw new AuthError('Unexpected token algorithm');

  const expected = createHmac('sha256', apiSecret).update(`${headerB64}.${payloadB64}`).digest();
  const actual = b64urlDecode(sigB64);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new AuthError('Bad token signature');
  }

  const claims = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  const nowSec = Math.floor(now / 1000);
  const skew = 10; // seconds of clock drift tolerated
  if (typeof claims.exp !== 'number' || claims.exp + skew < nowSec) throw new AuthError('Token expired');
  if (typeof claims.nbf === 'number' && claims.nbf - skew > nowSec) throw new AuthError('Token not yet valid');
  if (claims.aud !== apiKey) throw new AuthError('Token issued for a different app');

  const shop = String(claims.dest || '').replace(/^https?:\/\//, '');
  if (!allowedShops.includes(shop)) throw new AuthError(`Shop not allowed: ${shop || 'unknown'}`);

  return { shop, userId: claims.sub ?? null };
}

export class AuthError extends Error {}

// Express middleware. In development only, AUTH_DISABLED=true skips the check
// so the endpoints can be exercised with curl.
export function requireSession(env = process.env) {
  const allowedShops = String(env.SHOPIFY_ALLOWED_SHOPS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  return (req, res, next) => {
    if (env.AUTH_DISABLED === 'true' && env.NODE_ENV !== 'production') {
      req.session = { shop: allowedShops[0] || 'dev-shop.myshopify.com', userId: 'dev' };
      return next();
    }
    try {
      const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
      req.session = verifySessionToken(token, {
        apiKey: env.SHOPIFY_API_KEY,
        apiSecret: env.SHOPIFY_API_SECRET,
        allowedShops,
      });
      next();
    } catch (err) {
      res.status(401).json({ error: 'Not authorised' });
    }
  };
}
