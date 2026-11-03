import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Off-chain prepaid balances. One x402 payment buys a block of credits; after that, calls spend
// them and never touch the chain until the balance runs out. A balance belongs to an account: a
// signed agent identity (its Aleo address) or a bearer token.
export class CreditsStore {
  private readonly balances: Record<string, number>;
  private readonly pending = new Map<string, { account: string; credits: number }>();

  constructor(private readonly file: string) {
    this.balances = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  }

  balance(account: string): number {
    return this.balances[account] ?? 0;
  }

  has(account: string): boolean {
    return account in this.balances;
  }

  newToken(): string {
    return `cr_${randomBytes(24).toString("base64url")}`;
  }

  // Uses one credit. False if the account is missing, unknown or empty.
  spend(account: string | undefined): boolean {
    if (!account || !this.balances[account]) return false;
    this.balances[account]--;
    this.save();
    return true;
  }

  // Holds a top-up for `account` until its payment settles.
  reserve(paymentKey: string, account: string, credits: number) {
    this.pending.set(paymentKey, { account, credits });
  }

  commit(paymentKey: string) {
    const topUp = this.pending.get(paymentKey);
    if (!topUp) return;
    this.pending.delete(paymentKey);
    this.balances[topUp.account] = this.balance(topUp.account) + topUp.credits;
    this.save();
  }

  cancel(paymentKey: string) {
    this.pending.delete(paymentKey);
  }

  private save() {
    writeFileSync(this.file, JSON.stringify(this.balances, null, 2), { mode: 0o600 });
  }
}

// Identifies a payment both in the route handler (from its header) and in the settle hooks.
export const paymentKey = (payload: unknown) => createHash("sha256").update(JSON.stringify(payload)).digest("hex");
