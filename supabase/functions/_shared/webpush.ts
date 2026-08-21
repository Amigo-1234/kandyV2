/* ==========================================================================
   Web Push — RFC 8291 payload encryption and RFC 8292 (VAPID) signing
   --------------------------------------------------------------------------
   Written against the RFCs with WebCrypto rather than pulled from npm: the
   whole point of this file is that a private key never leaves the server, and
   a push library is a dependency that would sit directly on that key.

   Two independent pieces:

     encryptPayload()  RFC 8291 §3 — aes128gcm. Derives a content key from an
                       ECDH shared secret and the subscription's auth secret,
                       and returns the exact body bytes a push service expects.

     vapidHeaders()    RFC 8292 — an ES256 JWT proving who is sending, plus
                       the public key the subscription was created with.

   encryptPayload() is deliberately parameterised on `salt` and the ephemeral
   key so it can be run against the RFC's published test vector; production
   calls leave both out and get fresh randomness.
   ========================================================================== */

/* ---- base64url ---------------------------------------------------------- */

export function b64uToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function bytesToB64u(b: Uint8Array): string {
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/* ---- HKDF, spelled out -------------------------------------------------- */

/* Only ever one block long here, so the counter is a literal 0x01 rather than
   a loop — every output below is <= 32 bytes. */
async function hkdf(
  salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number,
): Promise<Uint8Array> {
  const prkKey = await crypto.subtle.importKey(
    "raw", salt as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const prk = new Uint8Array(await crypto.subtle.sign("HMAC", prkKey, ikm as BufferSource));

  const okmKey = await crypto.subtle.importKey(
    "raw", prk as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const okm = new Uint8Array(
    await crypto.subtle.sign("HMAC", okmKey, concat(info, Uint8Array.of(1)) as BufferSource),
  );
  return okm.slice(0, length);
}

/* ---- RFC 8291 ----------------------------------------------------------- */

export interface EncryptOptions {
  /** The subscription's p256dh, raw 65 bytes (0x04 || X || Y). */
  uaPublic: Uint8Array;
  /** The subscription's auth secret, 16 bytes. */
  authSecret: Uint8Array;
  payload: Uint8Array;
  /** Test-vector hooks. Omit both in production. */
  salt?: Uint8Array;
  asKeyPair?: CryptoKeyPair;
  recordSize?: number;
}

export async function encryptPayload(opts: EncryptOptions): Promise<Uint8Array> {
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const rs = opts.recordSize ?? 4096;

  const asKeys = opts.asKeyPair ?? await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  ) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));

  const uaKey = await crypto.subtle.importKey(
    "raw", opts.uaPublic as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256),
  );

  /* §3.3: the IKM is itself an HKDF over the shared secret, keyed by the
     subscription's auth secret and bound to BOTH public keys — which is what
     stops a captured ciphertext being replayed at a different subscriber. */
  const keyInfo = concat(utf8("WebPush: info\0"), opts.uaPublic, asPublic);
  const ikm = await hkdf(opts.authSecret, shared, keyInfo, 32);

  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  /* §2: a single record, so the delimiter is 0x02 (last record) not 0x01. */
  const plaintext = concat(opts.payload, Uint8Array.of(2));

  const aesKey = await crypto.subtle.importKey(
    "raw", cek as BufferSource, { name: "AES-GCM" }, false, ["encrypt"],
  );
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 },
    aesKey, plaintext as BufferSource,
  ));

  /* RFC 8188 §2.1 header: salt(16) || rs(4, big endian) || idlen(1) || keyid */
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs, false);
  header[20] = asPublic.length;                       // 65

  return concat(header, asPublic, ciphertext);
}

/* ---- RFC 8292 (VAPID) --------------------------------------------------- */

/**
 * The private key arrives as the raw `d` scalar. The public half is needed to
 * import it as a JWK, and is taken from the configured public key rather than
 * re-derived — if the two ever disagree the push service rejects the JWT,
 * which is the correct and loud failure.
 */
async function importVapidKey(privateD: string, publicKey: Uint8Array): Promise<CryptoKey> {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error("VAPID public key must be 65 uncompressed bytes");
  }
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC", crv: "P-256", ext: true, d: privateD,
      x: bytesToB64u(publicKey.slice(1, 33)),
      y: bytesToB64u(publicKey.slice(33, 65)),
    },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
}

export async function vapidHeaders(
  endpoint: string, publicKeyB64u: string, privateD: string, subject: string,
  nowSeconds?: number,
): Promise<Record<string, string>> {
  const aud = new URL(endpoint).origin;
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  /* 12h. The RFC caps it at 24h; shorter means a leaked token expires sooner
     and costs nothing, since one is minted per send. */
  const exp = now + 12 * 60 * 60;

  const header = bytesToB64u(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = bytesToB64u(utf8(JSON.stringify({ aud, exp, sub: subject })));
  const signingInput = utf8(`${header}.${body}`);

  const key = await importVapidKey(privateD, b64uToBytes(publicKeyB64u));
  /* WebCrypto returns r||s, which is exactly the JWS form. No DER unwrapping. */
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, signingInput as BufferSource,
  ));

  return {
    Authorization: `vapid t=${header}.${body}.${bytesToB64u(sig)}, k=${publicKeyB64u}`,
  };
}

/* ---- One send ----------------------------------------------------------- */

export interface PushResult {
  status: number;
  /** The push service says this subscription is gone; delete the row. */
  gone: boolean;
  error?: string;
}

export async function sendPush(
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: unknown,
  vapid: { publicKey: string; privateKey: string; subject: string },
  ttlSeconds = 60 * 60 * 24,
): Promise<PushResult> {
  try {
    const body = await encryptPayload({
      uaPublic: b64uToBytes(sub.p256dh),
      authSecret: b64uToBytes(sub.auth),
      payload: utf8(JSON.stringify(payload)),
    });

    const headers = await vapidHeaders(
      sub.endpoint, vapid.publicKey, vapid.privateKey, vapid.subject,
    );

    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(ttlSeconds),
        Urgency: "normal",
      },
      body: body as BufferSource,
    });

    /* 404 = never existed, 410 = unsubscribed. Both mean stop trying. */
    return { status: res.status, gone: res.status === 404 || res.status === 410 };
  } catch (e) {
    return { status: 0, gone: false, error: String((e as Error).message ?? e) };
  }
}
