export type AccountType = "offline" | "microsoft" | "authlib";

/** What is stored in accounts.json. Secrets (tokens) live in the SecretStore, never here. */
export interface AccountRecord {
  id: string;
  type: AccountType;
  name: string;
  /** Player UUID with dashes. */
  uuid: string;
  createdAt: number;
  lastUsed?: number;
  /** microsoft */
  xuid?: string;
  skinUrl?: string;
  skinVariant?: "classic" | "slim";
  capeUrl?: string;
  /** authlib: Yggdrasil API root, server display name and the prefetched metadata (base64). */
  server?: string;
  serverName?: string;
  prefetched?: string;
  /** authlib: login name used to re-authenticate. */
  login?: string;
  /** Unix ms when the Minecraft access token expires (microsoft). */
  expiresAt?: number;
}

/** Account as shown to the UI. */
export interface PublicAccount {
  id: string;
  type: AccountType;
  name: string;
  uuid: string;
  server?: string;
  serverName?: string;
  skinUrl?: string;
  lastUsed?: number;
  /** True when a stored token exists that can be refreshed without user interaction. */
  signedIn: boolean;
}

export interface LoginChallenge {
  /** Code the user types on the Microsoft page. */
  userCode: string;
  verificationUri: string;
  /** Seconds until the code expires. */
  expiresIn: number;
  message?: string;
}

export class AuthError extends Error {
  readonly name = "AuthError";
  constructor(
    message: string,
    /** Stable machine-readable reason for the UI. */
    readonly reason:
      | "no-client-id"
      | "declined"
      | "expired"
      | "no-xbox-account"
      | "region-blocked"
      | "adult-verification"
      | "child-account"
      | "no-game"
      | "app-not-approved"
      | "network"
      | "invalid-credentials"
      | "needs-profile"
      | "unknown" = "unknown",
    readonly detail?: unknown,
  ) {
    super(message);
  }
}
