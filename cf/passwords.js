// ==========================================
// Client-side password stretching.
//
// Uses the Web Crypto API — a public, keyless, free API built into every
// browser. No dependency, no network call, no API key.
//
// The stretch runs here rather than in the Worker because Workers Free
// allows only 10ms CPU per invocation and server-side PBKDF2 would hard-fail
// with Error 1102. The Worker only ever runs a single SHA-256 on the result.
// ==========================================
const Passwords = (() => {
  const ITERATIONS = 600000; // OWASP 2023 guidance for PBKDF2-SHA256
  const enc = new TextEncoder();

  const toB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

  /**
   * Returns base64(SHA-256(pbkdf2(password))) as an opaque verifier.
   * The plaintext password never leaves the browser.
   *
   * The salt is derived from the username, which binds the verifier to the
   * account and keeps the function deterministic — useful because the Worker
   * stores only the verifier and never needs the salt separately.
   */
  async function derive(username, password) {
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(password.normalize("NFKC")),
      "PBKDF2",
      false,
      ["deriveBits"]
    );

    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: enc.encode("pkax:" + String(username).trim().toLowerCase()),
        iterations: ITERATIONS,
        hash: "SHA-256",
      },
      key,
      256
    );

    return toB64(await crypto.subtle.digest("SHA-256", bits));
  }

  return { derive, ITERATIONS };
})();