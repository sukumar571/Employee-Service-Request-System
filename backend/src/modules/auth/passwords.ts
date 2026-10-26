import bcrypt from 'bcryptjs';

/**
 * Password hashing / verification (docs/security-plan.md §2). bcrypt cost is supplied by config so
 * the test suite can lower it; the security policy default is 12. A transparent upgrade path is
 * left to the caller (re-hash when a stored hash has fewer rounds than the current policy at login).
 *
 * `bcryptjs` is used rather than the native `bcrypt` binding so a fresh clone needs no build
 * toolchain — the same reason the seed script uses it (ADR-001 §2.1).
 */

export async function hashPassword(password: string, rounds: number): Promise<string> {
  return bcrypt.hash(password, rounds);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    // A malformed stored hash must read as "wrong password", never as a 500 that leaks the value.
    return false;
  }
}

/**
 * Fixed cost-10 hash of a placeholder. On an unknown email we still run a bcrypt compare against
 * this so the response time does not reveal whether the account exists (security-plan §4.2 —
 * account-enumeration defence). Generated once and cached.
 */
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHash ??= bcrypt.hash('esrs-timing-equaliser-not-a-real-secret', 10);
  return dummyHash;
}

/** Verifies against the dummy hash so a miss costs the same CPU as a hit. Result is always false. */
export async function burnPasswordCompare(password: string): Promise<false> {
  await bcrypt.compare(password, await getDummyHash());
  return false;
}
