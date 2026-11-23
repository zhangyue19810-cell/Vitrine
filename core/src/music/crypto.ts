import { constants, createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt, randomBytes } from "node:crypto";

/**
 * The request envelope of the NetEase Cloud Music web client ("weapi").
 *
 * The website encrypts every request body in the browser: the JSON text goes through AES-128-CBC twice (first with a
 * fixed key, then with a random 16 character key) and the random key travels beside it, reversed and encrypted with
 * RSA (no padding) under the site's public key. This is the same thing the website's own JavaScript does; it is not a
 * way around any access check. The public key is a parameter so tests can run against a key pair of their own.
 */

export const WEAPI_PRESET_KEY = "0CoJUm6Qyw8W8jud";
export const WEAPI_IV = "0102030405060708";
export const WEAPI_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;

const BASE62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export interface WeapiForm {
  params: string;
  encSecKey: string;
}

/** 16 random characters out of [a-zA-Z0-9]. Rejection sampling keeps every character equally likely. */
export function randomSecretKey(source: (size: number) => Uint8Array = randomBytes): string {
  let out = "";
  while (out.length < 16) {
    for (const byte of source(32)) {
      if (byte < 248 && out.length < 16) out += BASE62[byte % 62];
    }
  }
  return out;
}

export function aesCbcBase64(text: string, key: string, iv: string = WEAPI_IV): string {
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(key, "utf8"), Buffer.from(iv, "utf8"));
  return Buffer.concat([cipher.update(text, "utf8"), cipher.final()]).toString("base64");
}

export function aesCbcDecryptBase64(data: string, key: string, iv: string = WEAPI_IV): string {
  const decipher = createDecipheriv("aes-128-cbc", Buffer.from(key, "utf8"), Buffer.from(iv, "utf8"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

/** Textbook RSA of the reversed secret, left-padded with zeros to the modulus size, as lower-case hex. */
export function rsaNoPaddingHex(secret: string, publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem);
  const size = Math.ceil((key.asymmetricKeyDetails?.modulusLength ?? 1024) / 8);
  const reversed = Buffer.from([...secret].reverse().join(""), "utf8");
  if (reversed.length > size) throw new RangeError("secret key is longer than the RSA modulus");
  const block = Buffer.concat([Buffer.alloc(size - reversed.length), reversed]);
  return publicEncrypt({ key, padding: constants.RSA_NO_PADDING }, block).toString("hex");
}

export interface WeapiOptions {
  publicKey?: string;
  /** For tests: a fixed secret key instead of a random one. */
  secretKey?: string;
}

export function weapi(payload: unknown, options: WeapiOptions = {}): WeapiForm {
  const secretKey = options.secretKey ?? randomSecretKey();
  if (!/^[A-Za-z0-9]{16}$/.test(secretKey)) throw new RangeError("secret key must be 16 letters or digits");
  const first = aesCbcBase64(JSON.stringify(payload), WEAPI_PRESET_KEY);
  return {
    params: aesCbcBase64(first, secretKey),
    encSecKey: rsaNoPaddingHex(secretKey, options.publicKey ?? WEAPI_PUBLIC_KEY),
  };
}

/** The server's half of the envelope, used by the tests' stand-in for the site. */
export function weapiDecrypt(form: WeapiForm, privateKeyPem: string): unknown {
  const key = createPrivateKey(privateKeyPem);
  const block = privateDecrypt({ key, padding: constants.RSA_NO_PADDING }, Buffer.from(form.encSecKey, "hex"));
  let start = 0;
  while (start < block.length && block[start] === 0) start++;
  const secretKey = [...block.subarray(start).toString("utf8")].reverse().join("");
  const first = aesCbcDecryptBase64(form.params, secretKey);
  return JSON.parse(aesCbcDecryptBase64(first, WEAPI_PRESET_KEY));
}

/** eapi key from the web player; this is the app-level envelope, not a private credential. */
const EAPI_KEY = "e82ckenh8dichen8";

/** NetEase's app-facing eapi envelope: AES-128-ECB over the request URL, body and an MD5 digest. */
export function eapiForm(url: string, payload: unknown): { params: string } {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  const digest = createHash("md5").update(`nobody${url}use${text}md5forencrypt`).digest("hex");
  const plain = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(EAPI_KEY, "utf8"), null);
  return { params: Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString("hex").toUpperCase() };
}


/** Server-side/test-side counterpart of `eapiForm`, used by the local stand-in. */
export function eapiDecrypt(params: string): { url: string; data: unknown; digest: string } {
  const decipher = createDecipheriv("aes-128-ecb", Buffer.from(EAPI_KEY, "utf8"), null);
  const plain = Buffer.concat([decipher.update(Buffer.from(params, "hex")), decipher.final()]).toString("utf8");
  const match = /^(.*?)-36cd479b6b5-([\s\S]*?)-36cd479b6b5-(.*)$/.exec(plain);
  if (!match) throw new Error("invalid eapi envelope");
  return { url: match[1], data: JSON.parse(match[2]), digest: match[3] };
}
