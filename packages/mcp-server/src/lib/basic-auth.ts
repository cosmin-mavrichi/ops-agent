export interface SplitUrl {
  /** The URL without credentials, ending in "/" so relative paths resolve under it. */
  readonly base: URL;
  /** `Basic …` header value, when the URL carried credentials. */
  readonly authorization?: string;
}

/**
 * Moves basic auth from a URL into a header: fetch refuses URLs with credentials, and a URL that ends up
 * in an error message must not carry them.
 */
export function splitBasicAuth(raw: string): SplitUrl {
  const base = new URL(raw.endsWith("/") ? raw : `${raw}/`);
  if (!base.username && !base.password) return { base };

  const user = decodeURIComponent(base.username);
  const password = decodeURIComponent(base.password);
  base.username = "";
  base.password = "";
  return { base, authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` };
}
