function canonicalValue(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical numbers must be finite");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (value === undefined) throw new TypeError("Canonical values cannot contain undefined");
  if (typeof value !== "object") {
    throw new TypeError(`Unsupported canonical value type: ${typeof value}`);
  }
  if (seen.has(value)) throw new TypeError("Canonical values cannot contain cycles");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalValue(entry, seen)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical values must use plain objects and arrays");
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key], seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalize(value: unknown): string {
  return canonicalValue(value, new WeakSet());
}

export function hashText32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    hash ^= code & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= code >>> 8;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function hashCanonical(value: unknown): number {
  return hashText32(canonicalize(value));
}

export function hashCanonicalHex(value: unknown): string {
  return hashCanonical(value).toString(16).padStart(8, "0");
}

