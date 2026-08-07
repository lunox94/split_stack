export const MAX_ROUTE_ID_CHARACTERS = 256;

const MAX_HASH_CHARACTERS = 4_096;

export type AppRouteV2 =
  | { screen: "home" }
  | { screen: "lobby"; challengeId?: string }
  | { screen: "match"; matchId: string }
  | { screen: "result"; matchId: string }
  | { screen: "practice-leaderboard"; rulesHash: string };

export interface RouteTargetAvailability {
  challengeExists?: (challengeId: string) => boolean;
  liveMatchExists?: (matchId: string) => boolean;
  resultExists?: (matchId: string) => boolean;
  rulesHashIsCurrent?: (rulesHash: string) => boolean;
}

function homeRoute(): AppRouteV2 {
  return { screen: "home" };
}

function lobbyRoute(): AppRouteV2 {
  return { screen: "lobby" };
}

function assertRouteId(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ROUTE_ID_CHARACTERS
  ) {
    throw new RangeError(`${label} must contain 1-${MAX_ROUTE_ID_CHARACTERS} characters`);
  }
  return value;
}

function encodeRouteId(value: string, label: string): string {
  const validated = assertRouteId(value, label);
  try {
    return encodeURIComponent(validated);
  } catch {
    throw new TypeError(`${label} is not valid Unicode`);
  }
}

function decodeRouteId(segment: string): string | null {
  if (segment.length === 0 || segment.length > MAX_HASH_CHARACTERS) return null;
  try {
    const decoded = decodeURIComponent(segment);
    if (
      decoded.length === 0 ||
      decoded.length > MAX_ROUTE_ID_CHARACTERS ||
      encodeURIComponent(decoded) !== segment
    ) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function routeHash(value: string): string | null {
  if (typeof value !== "string") return null;
  if (value === "" || value === "index.html") return "";
  if (value.startsWith("#")) return value.slice(1);
  if (value.startsWith("index.html#")) return value.slice("index.html#".length);
  return null;
}

/** True only for fragments owned by the app and therefore safe to consume. */
export function isRecognizedAppRouteHash(value: string): boolean {
  const hash = routeHash(value);
  if (hash === null || hash === "") return false;
  return ["home", "lobby", "match", "result", "practice"].some(
    (prefix) => hash === prefix || hash.startsWith(`${prefix}/`),
  );
}

function malformedFallback(hash: string): AppRouteV2 {
  const prefix = hash.split("/", 1)[0];
  return prefix === "lobby" ||
      prefix === "match" ||
      prefix === "result" ||
      prefix === "practice"
    ? lobbyRoute()
    : homeRoute();
}

function parseSyntacticRoute(value: string): AppRouteV2 {
  const hash = routeHash(value);
  if (hash === null || hash === "" || hash === "home") return homeRoute();
  if (hash.length > MAX_HASH_CHARACTERS) return malformedFallback(hash);

  // The development Webxdc shim stores identity and peer controls in the hash.
  // They are host context, not an application navigation target.
  if (!hash.includes("/") && (hash.includes("=") || hash.includes("&"))) {
    return homeRoute();
  }
  if (hash === "lobby") return lobbyRoute();

  const segments = hash.split("/");
  if (
    segments.length === 3 &&
    segments[0] === "lobby" &&
    segments[1] === "challenge"
  ) {
    const challengeId = decodeRouteId(segments[2] ?? "");
    return challengeId === null
      ? lobbyRoute()
      : { screen: "lobby", challengeId };
  }
  if (segments.length === 2 && segments[0] === "match") {
    const matchId = decodeRouteId(segments[1] ?? "");
    return matchId === null ? lobbyRoute() : { screen: "match", matchId };
  }
  if (segments.length === 2 && segments[0] === "result") {
    const matchId = decodeRouteId(segments[1] ?? "");
    return matchId === null ? lobbyRoute() : { screen: "result", matchId };
  }
  if (
    segments.length === 3 &&
    segments[0] === "practice" &&
    segments[1] === "leaderboard"
  ) {
    const rulesHash = decodeRouteId(segments[2] ?? "");
    return rulesHash === null
      ? lobbyRoute()
      : { screen: "practice-leaderboard", rulesHash };
  }
  return malformedFallback(hash);
}

function safelyAvailable(
  predicate: ((identifier: string) => boolean) | undefined,
  identifier: string,
): boolean {
  if (predicate === undefined) return true;
  try {
    return predicate(identifier) === true;
  } catch {
    return false;
  }
}

export function resolveAppRoute(
  route: AppRouteV2,
  availability: RouteTargetAvailability = {},
): AppRouteV2 {
  if (
    route.screen === "lobby" &&
    route.challengeId !== undefined &&
    !safelyAvailable(availability.challengeExists, route.challengeId)
  ) {
    return lobbyRoute();
  }
  if (
    route.screen === "match" &&
    !safelyAvailable(availability.liveMatchExists, route.matchId)
  ) {
    return lobbyRoute();
  }
  if (
    route.screen === "result" &&
    !safelyAvailable(availability.resultExists, route.matchId)
  ) {
    return lobbyRoute();
  }
  if (
    route.screen === "practice-leaderboard" &&
    !safelyAvailable(availability.rulesHashIsCurrent, route.rulesHash)
  ) {
    return lobbyRoute();
  }
  return { ...route };
}

/** Parses location.hash or one of this module's relative hrefs without throwing. */
export function parseAppRoute(
  value: string,
  availability: RouteTargetAvailability = {},
): AppRouteV2 {
  try {
    return resolveAppRoute(parseSyntacticRoute(value), availability);
  } catch {
    return homeRoute();
  }
}

export function buildAppRouteHref(route: AppRouteV2): string {
  switch (route.screen) {
    case "home":
      return "index.html";
    case "lobby":
      return route.challengeId === undefined
        ? "index.html#lobby"
        : `index.html#lobby/challenge/${encodeRouteId(route.challengeId, "challenge ID")}`;
    case "match":
      return `index.html#match/${encodeRouteId(route.matchId, "match ID")}`;
    case "result":
      return `index.html#result/${encodeRouteId(route.matchId, "match ID")}`;
    case "practice-leaderboard":
      return `index.html#practice/leaderboard/${encodeRouteId(route.rulesHash, "rules hash")}`;
    default:
      throw new TypeError("Unknown application route");
  }
}
