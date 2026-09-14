interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ASSETS: Fetcher;
  CATALOG_VERSION: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REDIRECT_URI: string;
  SESSION_SECRET: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
}

interface CatalogRow {
  year: number;
  county_id: string;
  county_name: string;
  county_sort: number;
  candidate_id: number;
  candidate_name: string;
  party: string;
  vision: string;
  candidate_source: string;
  category_id: number;
  category_name: string;
  category_sort: number;
  promise_id: number;
  promise_title: string;
  promise_detail: string;
  promise_source: string;
  promise_sort: number;
}

type CountyChoice = { slot: "birth" | "work"; id: string; name: string };

const SESSION_COOKIE = "mip_session";
const OAUTH_COOKIE = "mip_oauth";
const SESSION_SECONDS = 60 * 60 * 24 * 30;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status >= 500) console.error(error);
      const message = error instanceof HttpError ? error.message : "伺服器暫時無法處理請求";
      const status = error instanceof HttpError ? error.status : 500;
      return json({ error: message }, status);
    }
  },
};

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/healthz") {
    await env.DB.prepare("SELECT 1").first();
    return json({ ok: true });
  }
  if (url.pathname === "/api/catalog" && request.method === "GET") {
    return getCatalog(request, env);
  }
  if (url.pathname === "/api/me" && request.method === "GET") {
    return getMe(request, env);
  }
  if (url.pathname === "/api/profile/counties" && request.method === "POST") {
    requireSameOrigin(request);
    return saveCounties(request, env);
  }
  const voteMatch = url.pathname.match(/^\/api\/promises\/(\d+)\/vote$/);
  if (voteMatch && request.method === "POST") {
    requireSameOrigin(request);
    return saveVote(request, env, Number(voteMatch[1]));
  }
  if (url.pathname === "/auth/google" && request.method === "GET") {
    return startGoogleLogin(request, env);
  }
  if (url.pathname === "/auth/google/callback" && request.method === "GET") {
    return finishGoogleLogin(request, env);
  }
  if (url.pathname === "/auth/logout" && request.method === "POST") {
    requireSameOrigin(request);
    return logout(request, env);
  }
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
    throw new HttpError(404, "找不到這個功能");
  }
  return env.ASSETS.fetch(request);
}

async function getCatalog(request: Request, env: Env): Promise<Response> {
  const user = await currentUser(request, env);
  const cacheKey = `catalog:${env.CATALOG_VERSION || "v1"}`;
  let catalog = await env.CACHE.get(cacheKey, "json");
  if (!catalog) {
    const { results } = await env.DB.prepare(`
      SELECT e.year, co.id AS county_id, co.name AS county_name, co.sort_order AS county_sort,
             c.id AS candidate_id, c.name AS candidate_name, c.party, c.vision,
             c.source_reference AS candidate_source,
             g.id AS category_id, g.name AS category_name, g.sort_order AS category_sort,
             p.id AS promise_id, p.title AS promise_title, p.detail AS promise_detail,
             p.source_reference AS promise_source, p.sort_order AS promise_sort
      FROM promises p
      JOIN categories g ON g.id = p.category_id
      JOIN candidates c ON c.id = g.candidate_id
      JOIN elections e ON e.year = c.election_year
      JOIN counties co ON co.id = c.county_id
      ORDER BY e.year DESC, co.sort_order, g.sort_order, p.sort_order
    `).all<CatalogRow>();
    catalog = buildCatalog(results);
    await env.CACHE.put(cacheKey, JSON.stringify(catalog), { expirationTtl: 86400 });
  }

  const { results: tallies } = await env.DB.prepare(`
    SELECT promise_id,
           SUM(CASE WHEN verdict = 1 THEN 1 ELSE 0 END) AS achieved,
           SUM(CASE WHEN verdict = 0 THEN 1 ELSE 0 END) AS not_achieved,
           COUNT(*) AS total
    FROM votes
    GROUP BY promise_id
  `).all<{ promise_id: number; achieved: number; not_achieved: number; total: number }>();

  const viewerVotes = user
    ? (await env.DB.prepare("SELECT promise_id, verdict FROM votes WHERE user_id = ?")
        .bind(user.id)
        .all<{ promise_id: number; verdict: number }>()).results
    : [];
  const summary = await env.DB.prepare(
    "SELECT COUNT(*) AS total_votes, COUNT(DISTINCT user_id) AS voters FROM votes",
  ).first<{ total_votes: number; voters: number }>();

  return json({
    catalog,
    results: Object.fromEntries(tallies.map((row) => [row.promise_id, row])),
    viewerVotes: Object.fromEntries(viewerVotes.map((row) => [row.promise_id, row.verdict])),
    summary: { totalVotes: summary?.total_votes ?? 0, voters: summary?.voters ?? 0 },
  });
}

async function getMe(request: Request, env: Env): Promise<Response> {
  const user = await currentUser(request, env);
  if (!user) return json({ user: null, counties: [] });
  return json({ user, counties: await userCounties(env, user.id) });
}

async function saveCounties(request: Request, env: Env): Promise<Response> {
  const user = await requireUser(request, env);
  const body = await readJson<{ birthCountyId?: string | null; workCountyId?: string | null }>(request);
  const selected = [body.birthCountyId, body.workCountyId].filter((value): value is string => Boolean(value));
  if (new Set(selected).size !== selected.length) {
    throw new HttpError(400, "出生地與工作地請選擇不同縣市；若相同可只填其中一項");
  }
  if (selected.length) {
    const placeholders = selected.map(() => "?").join(",");
    const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM counties WHERE id IN (${placeholders})`)
      .bind(...selected)
      .first<{ count: number }>();
    if ((row?.count ?? 0) !== selected.length) throw new HttpError(400, "縣市選項不正確");
  }

  const statements = [env.DB.prepare("DELETE FROM user_counties WHERE user_id = ?").bind(user.id)];
  if (body.birthCountyId) {
    statements.push(env.DB.prepare(
      "INSERT INTO user_counties (user_id, slot, county_id) VALUES (?, 'birth', ?)",
    ).bind(user.id, body.birthCountyId));
  }
  if (body.workCountyId) {
    statements.push(env.DB.prepare(
      "INSERT INTO user_counties (user_id, slot, county_id) VALUES (?, 'work', ?)",
    ).bind(user.id, body.workCountyId));
  }
  await env.DB.batch(statements);
  return json({ counties: await userCounties(env, user.id) });
}

async function saveVote(request: Request, env: Env, promiseId: number): Promise<Response> {
  const user = await requireUser(request, env);
  const body = await readJson<{ verdict?: string }>(request);
  if (body.verdict !== "achieved" && body.verdict !== "not_achieved") {
    throw new HttpError(400, "投票選項不正確");
  }
  const promise = await env.DB.prepare(`
    SELECT co.id AS county_id
    FROM promises p
    JOIN categories g ON g.id = p.category_id
    JOIN candidates c ON c.id = g.candidate_id
    JOIN counties co ON co.id = c.county_id
    WHERE p.id = ?
  `).bind(promiseId).first<{ county_id: string }>();
  if (!promise) throw new HttpError(404, "找不到這項政見");
  const allowed = await env.DB.prepare(
    "SELECT 1 AS ok FROM user_counties WHERE user_id = ? AND county_id = ?",
  ).bind(user.id, promise.county_id).first<{ ok: number }>();
  if (!allowed) throw new HttpError(403, "你只能投票給出生地或工作地所設定的縣市");

  const verdict = body.verdict === "achieved" ? 1 : 0;
  await env.DB.prepare(`
    INSERT INTO votes (user_id, promise_id, verdict)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, promise_id) DO UPDATE SET
      verdict = excluded.verdict,
      updated_at = CURRENT_TIMESTAMP
  `).bind(user.id, promiseId, verdict).run();

  const result = await env.DB.prepare(`
    SELECT promise_id,
           SUM(CASE WHEN verdict = 1 THEN 1 ELSE 0 END) AS achieved,
           SUM(CASE WHEN verdict = 0 THEN 1 ELSE 0 END) AS not_achieved,
           COUNT(*) AS total
    FROM votes WHERE promise_id = ? GROUP BY promise_id
  `).bind(promiseId).first();
  return json({ result, viewerVote: verdict });
}

async function startGoogleLogin(request: Request, env: Env): Promise<Response> {
  requireAuthConfig(env);
  const url = new URL(request.url);
  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = base64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const payload = await signPayload({ state, verifier, exp: Date.now() + 10 * 60 * 1000 }, env.SESSION_SECRET);
  const redirectUri = env.GOOGLE_REDIRECT_URI || `${url.origin}/auth/google/callback`;
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      "Set-Cookie": cookie(OAUTH_COOKIE, payload, 600, url.protocol === "https:"),
    },
  });
}

async function finishGoogleLogin(request: Request, env: Env): Promise<Response> {
  requireAuthConfig(env);
  const url = new URL(request.url);
  if (url.searchParams.get("error")) throw new HttpError(400, "Google 登入已取消");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const signed = parseCookies(request.headers.get("Cookie") || "")[OAUTH_COOKIE];
  const oauth = signed
    ? await verifyPayload<{ state: string; verifier: string; exp: number }>(signed, env.SESSION_SECRET)
    : null;
  if (!code || !state || !oauth || oauth.exp < Date.now() || oauth.state !== state) {
    throw new HttpError(400, "登入驗證已過期，請重新登入");
  }

  const redirectUri = env.GOOGLE_REDIRECT_URI || `${url.origin}/auth/google/callback`;
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: oauth.verifier,
    }),
  });
  if (!tokenResponse.ok) throw new HttpError(502, "Google 登入交換憑證失敗");
  const tokens = await tokenResponse.json<{ access_token?: string }>();
  if (!tokens.access_token) throw new HttpError(502, "Google 未回傳登入憑證");

  const infoResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!infoResponse.ok) throw new HttpError(502, "無法讀取 Google 使用者資料");
  const info = await infoResponse.json<{
    sub?: string; email?: string; email_verified?: boolean; name?: string; picture?: string;
  }>();
  if (!info.sub || !info.email || !info.email_verified) {
    throw new HttpError(403, "需要已驗證電子郵件的 Google 帳號");
  }

  await env.DB.prepare(`
    INSERT INTO users (id, email, name, avatar_url)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email,
      name = excluded.name,
      avatar_url = excluded.avatar_url,
      updated_at = CURRENT_TIMESTAMP
  `).bind(info.sub, info.email, info.name || info.email, info.picture || null).run();

  const sessionToken = randomToken(32);
  const tokenHash = await sha256Hex(sessionToken);
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP"),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .bind(tokenHash, info.sub, expiresAt),
  ]);
  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", cookie(SESSION_COOKIE, sessionToken, SESSION_SECONDS, url.protocol === "https:"));
  headers.append("Set-Cookie", clearCookie(OAUTH_COOKIE, url.protocol === "https:"));
  return new Response(null, { status: 302, headers });
}

async function logout(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const raw = parseCookies(request.headers.get("Cookie") || "")[SESSION_COOKIE];
  if (raw) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(raw)).run();
  return json({ ok: true }, 200, { "Set-Cookie": clearCookie(SESSION_COOKIE, url.protocol === "https:") });
}

async function currentUser(request: Request, env: Env): Promise<UserRow | null> {
  const raw = parseCookies(request.headers.get("Cookie") || "")[SESSION_COOKIE];
  if (!raw) return null;
  return env.DB.prepare(`
    SELECT u.id, u.email, u.name, u.avatar_url
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP
  `).bind(await sha256Hex(raw)).first<UserRow>();
}

async function requireUser(request: Request, env: Env): Promise<UserRow> {
  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, "請先使用 Google 登入");
  return user;
}

async function userCounties(env: Env, userId: string): Promise<CountyChoice[]> {
  const { results } = await env.DB.prepare(`
    SELECT uc.slot, co.id, co.name
    FROM user_counties uc JOIN counties co ON co.id = uc.county_id
    WHERE uc.user_id = ? ORDER BY CASE uc.slot WHEN 'birth' THEN 0 ELSE 1 END
  `).bind(userId).all<CountyChoice>();
  return results;
}

function buildCatalog(rows: CatalogRow[]) {
  const years = new Map<number, any>();
  for (const row of rows) {
    let year = years.get(row.year);
    if (!year) {
      year = { year: row.year, counties: [] };
      years.set(row.year, year);
    }
    let county = year.counties.find((item: any) => item.id === row.county_id);
    if (!county) {
      county = {
        id: row.county_id,
        name: row.county_name,
        candidate: {
          id: row.candidate_id,
          name: row.candidate_name,
          party: row.party,
          vision: row.vision,
          source: row.candidate_source,
          categories: [],
        },
      };
      year.counties.push(county);
    }
    let category = county.candidate.categories.find((item: any) => item.id === row.category_id);
    if (!category) {
      category = { id: row.category_id, name: row.category_name, promises: [] };
      county.candidate.categories.push(category);
    }
    category.promises.push({
      id: row.promise_id,
      title: row.promise_title,
      detail: row.promise_detail,
      source: row.promise_source,
    });
  }
  return Array.from(years.values());
}

function requireSameOrigin(request: Request) {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== new URL(request.url).origin) throw new HttpError(403, "請求來源驗證失敗");
}

function requireAuthConfig(env: Env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    throw new HttpError(503, "Google 登入尚未完成設定");
  }
}

async function readJson<T>(request: Request): Promise<T> {
  const contentLength = Number(request.headers.get("Content-Length") || "0");
  if (contentLength > 4096) throw new HttpError(413, "請求內容過大");
  try {
    return await request.json<T>();
  } catch {
    throw new HttpError(400, "請使用正確的 JSON 格式");
  }
}

async function signPayload(value: unknown, secret: string): Promise<string> {
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(value)));
  const signature = await hmac(payload, secret);
  return `${payload}.${signature}`;
}

async function verifyPayload<T>(signed: string, secret: string): Promise<T | null> {
  const [payload, signature] = signed.split(".");
  if (!payload || !signature || !(await safeEqual(signature, await hmac(payload, secret)))) return null;
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as T;
  } catch {
    return null;
  }
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes: number): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return base64Url(data);
}

function base64Url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function safeEqual(left: string, right: string): Promise<boolean> {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function parseCookies(header: string): Record<string, string> {
  return Object.fromEntries(header.split(";").flatMap((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [] : [[part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))]];
  }));
}

function cookie(name: string, value: string, maxAge: number, secure: boolean): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function clearCookie(name: string, secure: boolean): string {
  return cookie(name, "", 0, secure);
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      ...headers,
    },
  });
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
