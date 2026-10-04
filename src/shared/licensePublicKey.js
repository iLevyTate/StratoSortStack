// @ts-check
/**
 * Ed25519 PUBLIC key for offline license verification.
 *
 * The matching PRIVATE key never ships and never enters the repo — it lives
 * with the operator (see scripts/license/generate-keypair.js and
 * docs/CONFIG.md STRATOSORT_LICENSE_SIGNING_KEY). Licenses are strings of the
 * form `SSORT1-<base64url(payload)>.<base64url(signature)>`; the signature
 * covers the exact base64url payload segment bytes, so no JSON
 * canonicalization is involved in verification.
 *
 * NOTE: this is the DEVELOPMENT keypair's public half. Before the first
 * commercial release, run scripts/license/generate-keypair.js on an offline
 * machine and replace this constant with the production public key (runbook:
 * docs/RELEASING.md).
 */

const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA9itE4xdipSxIiGPzBrWGkxvp2HvQDG1Ot1VwJf9uc24=
-----END PUBLIC KEY-----`;

module.exports = { LICENSE_PUBLIC_KEY_PEM };
