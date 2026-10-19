// Kartice — AI preko ključa aplikacije (Supabase Edge Function, Deno)
// Aplikacija šalje isto telo koje bi poslala Gemini API-ju (generateContent), a ova funkcija:
// proveri prijavljenog korisnika, u bazi proveri blokadu, prekidač i dnevni limit (ai_take),
// pozove Gemini ključem iz tajne GEMINI_API_KEY i vrati Google-ov odgovor nepromenjen.
// Model bira admin (app_config.model), ne aplikacija. Ključ nikad ne napušta server.
// Tajne (supabase secrets set): GEMINI_API_KEY. SUPABASE_URL i SUPABASE_SERVICE_ROLE_KEY daje Supabase sam.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/";
const MAX_BODY = 20 * 1048576;   // isto ograničenje kao kod Google-a za zahtev sa ugrađenim fajlom
const MAX_OUT = 32768;           // najviše izlaznih tokena po pozivu
const ORIGINS = [/^https:\/\/aleksapjescic\.github\.io$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];

function corsHeaders(origin: string): Record<string, string> {
  const ok = ORIGINS.some((re) => re.test(origin));
  return {
    "Access-Control-Allow-Origin": ok ? origin : "https://aleksapjescic.github.io",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Expose-Headers": "x-ai-used, x-ai-limit",
    "Vary": "Origin",
  };
}
function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin") ?? "");
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405, cors);

  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return json({ error: "no_key" }, 500, cors);
  // stariji projekti daju SUPABASE_SERVICE_ROLE_KEY, noviji (sb_secret_ ključevi) i SUPABASE_SECRET_KEY
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SECRET_KEY");
  if (!serviceKey) return json({ error: "server" }, 500, cors);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ko zove
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: who } = jwt ? await db.auth.getUser(jwt) : { data: { user: null } };
  const user = who?.user;
  if (!user) return json({ error: "auth" }, 401, cors);

  // telo zahteva
  if (+(req.headers.get("content-length") ?? 0) > MAX_BODY) return json({ error: "too_big" }, 413, cors);
  let body: Record<string, any>;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return json({ error: "too_big" }, 413, cors);
    body = JSON.parse(text);
  } catch {
    return json({ error: "bad_request" }, 400, cors);
  }
  // spisak Gemini modela za izbor u admin panelu: samo za administratora i ne troši dnevni limit
  if (body?.listModels === true) {
    const { data: prof } = await db.from("profiles").select("role").eq("user_id", user.id).maybeSingle();
    if (prof?.role !== "admin") return json({ error: "forbidden" }, 403, cors);
    const r = await fetch(GEMINI_API + "models?pageSize=1000", { headers: { "x-goog-api-key": key } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: { message: j?.error?.message ?? r.statusText } }, 502, cors);
    const models = (j.models ?? [])
      .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m: any) => ({ id: String(m.name).replace(/^models\//, ""), name: String(m.displayName ?? m.name) }))
      .filter((m: any) => /^gemini-/.test(m.id) && !/embedding|tts|image|live|audio|native|aqa|robotics|computer/i.test(m.id));
    return json({ models }, 200, cors);
  }
  if (!Array.isArray(body?.contents)) return json({ error: "bad_request" }, 400, cors);

  // blokada, prekidač i dnevni limit; poziv se odmah broji
  const take = await db.rpc("ai_take", { uid: user.id });
  if (take.error) return json({ error: "server" }, 500, cors);
  const t = take.data as { ok: boolean; reason?: string; used?: number; limit?: number | null; model?: string };
  if (!t.ok) {
    const status = t.reason === "limit" ? 429 : t.reason === "auth" ? 401 : 403;
    return json({ error: t.reason, used: t.used ?? 0, limit: t.limit ?? null }, status, cors);
  }

  // samo polja koja aplikacija koristi; model i gornja granica izlaza su serverski
  const gen = { ...(body.generationConfig ?? {}) };
  gen.maxOutputTokens = Math.min(Math.max(+gen.maxOutputTokens || MAX_OUT, 1), MAX_OUT);
  const payload: Record<string, unknown> = { contents: body.contents, generationConfig: gen };
  if (body.systemInstruction) payload.systemInstruction = body.systemInstruction;

  let res: Response, out: string;
  try {
    res = await fetch(GEMINI_API + "models/" + encodeURIComponent(t.model ?? "gemini-3.8-flash") + ":generateContent", {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    out = await res.text();
  } catch {
    await db.rpc("ai_finish", { uid: user.id, tokens: 0, ok: false });
    return json({ error: "upstream" }, 502, cors);
  }

  let tokens = 0;
  try {
    const m = JSON.parse(out).usageMetadata ?? {};
    tokens = (m.promptTokenCount ?? 0) + (m.candidatesTokenCount ?? 0) + (m.thoughtsTokenCount ?? 0);
  } catch { /* odgovor nije JSON; vraća se kakav jeste */ }
  await db.rpc("ai_finish", { uid: user.id, tokens, ok: res.ok });

  const used = res.ok ? (t.used ?? 0) : Math.max((t.used ?? 1) - 1, 0);
  return new Response(out, {
    status: res.status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "x-ai-used": String(used),
      "x-ai-limit": t.limit == null ? "" : String(t.limit),
    },
  });
});
