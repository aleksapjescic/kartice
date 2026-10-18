// Kartice — dnevni podsetnik za učenje (Supabase Edge Function, Deno)
// Poziva ga pg_cron svakih 15 minuta (supabase/cron.sql). Za svaku pretplatu proverava da li je kod
// korisnika (po njegovoj vremenskoj zoni) stiglo vreme podsetnika i da li danas ima kartica za
// ponavljanje; ako ima, šalje Web Push jednom dnevno.
// Tajne (supabase secrets set): CRON_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_CONTACT.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import webpush from "npm:web-push@3.6.7";

const DAY_START_H = 4; // isto kao u aplikaciji (srs.js): dan za učenje počinje u 4 ujutru

// lokalni datum i minut u danu za vremensku zonu
function localNow(tz: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: +get("hour") * 60 + +get("minute") };
}
// kraj današnjeg dana za učenje (sledećih 4 ujutru) kao vreme u ms, za zonu tz
function endOfStudyDay(tz: string) {
  const now = Date.now(), l = localNow(tz);
  const minsLeft = (24 * 60 - l.minutes) + DAY_START_H * 60 - (l.minutes < DAY_START_H * 60 ? 24 * 60 : 0);
  return now + minsLeft * 60000;
}
function plural(n: number) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "kartica";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "kartice";
  return "kartica";
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) return new Response("forbidden", { status: 403 });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  webpush.setVapidDetails("mailto:" + (Deno.env.get("VAPID_CONTACT") ?? "kartice@example.com"),
    Deno.env.get("VAPID_PUBLIC_KEY")!, Deno.env.get("VAPID_PRIVATE_KEY")!);

  const { data: subs, error } = await sb.from("push_subs").select("*");
  if (error) return Response.json({ error: error.message }, { status: 500 });
  let sent = 0, skipped = 0;
  for (const s of subs ?? []) {
    const l = localNow(s.tz || "Europe/Belgrade");
    const [h, m] = String(s.remind_at || "19:00").split(":").map(Number);
    const at = h * 60 + m;
    if (l.minutes < at || l.minutes >= at + 15 || s.last_sent === l.date) { skipped++; continue; }
    // stavke u rasporedu (stanje različito od "nova") koje dospevaju do kraja dana; rokovi su ms sa 13 cifara,
    // pa poređenje teksta daje isti redosled kao poređenje brojeva
    const { count } = await sb.from("items").select("id", { count: "exact", head: true })
      .eq("user_id", s.user_id).eq("kind", "rev").eq("deleted", false)
      .neq("data->>st", "0").lte("data->>due", String(endOfStudyDay(s.tz)));
    if (count && count > 0) {
      try {
        await webpush.sendNotification(s.sub, JSON.stringify({
          title: "Kartice", body: `Danas te čeka ${count} ${plural(count)} za ponavljanje.`, url: "./",
        }));
        sent++;
      } catch (e) {
        // pretplata više ne važi (aplikacija obrisana, obaveštenja isključena)
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) { await sb.from("push_subs").delete().eq("endpoint", s.endpoint); continue; }
      }
    }
    await sb.from("push_subs").update({ last_sent: l.date }).eq("endpoint", s.endpoint);
  }
  return Response.json({ sent, skipped });
});
