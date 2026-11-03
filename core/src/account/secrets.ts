import { chmod, readFile } from "node:fs/promises";
import { writeFileAtomic } from "../util/fsx";

/** Where refresh tokens and passwords go. Production wraps the OS keychain (Electron safeStorage). */
export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Cipher {
  encrypt(plain: string): string;
  decrypt(encoded: string): string;
}

/** Base64 only. Used in tests and where no OS facility exists; the file is at least private to the user. */
export const plainCipher: Cipher = {
  encrypt: (plain) => Buffer.from(plain, "utf8").toString("base64"),
  decrypt: (encoded) => Buffer.from(encoded, "base64").toString("utf8"),
};

export class FileSecretStore implements SecretStore {
  private cache?: Record<string, string>;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly cipher: Cipher = plainCipher,
  ) {}

  private async load(): Promise<Record<string, string>> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(this.path, "utf8")) as Record<string, string>;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  async get(key: string): Promise<string | undefined> {
    const data = await this.load();
    const encoded = data[key];
    if (encoded === undefined) return undefined;
    try {
      return this.cipher.decrypt(encoded);
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const data = await this.load();
    data[key] = this.cipher.encrypt(value);
    await this.flush();
  }

  async delete(key: string): Promise<void> {
    const data = await this.load();
    delete data[key];
    await this.flush();
  }

  private flush(): Promise<void> {
    this.writing = this.writing.then(async () => {
      await writeFileAtomic(this.path, JSON.stringify(this.cache ?? {}));
      await chmod(this.path, 0o600).catch(() => {});
    });
    return this.writing;
  }
}

export class MemorySecretStore implements SecretStore {
  readonly data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key);
  }
  async set(key: string, value: string) {
    this.data.set(key, value);
  }
  async delete(key: string) {
    this.data.delete(key);
  }
}
