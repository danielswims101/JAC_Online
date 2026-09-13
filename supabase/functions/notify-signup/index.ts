// Tidelyne — notify-signup Edge Function
//
// Emails the site owner when a real account is created. Called by the site
// right after signUp() with { user_id }. Nothing in the request body is
// trusted: the user is looked up server-side with the service role, must
// exist, and must have been created in the last 15 minutes — so this cannot
// be used to spam the inbox with invented names or addresses.
// Best-effort: every path returns 200 so a notification hiccup never surfaces
// as a signup failure.
//
// Secrets: RESEND_API_KEY, NOTIFY_EMAIL (set in Supabase → Edge Functions → Secrets)

import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
  "https://danielswims101.github.io",
  "http://localhost:8000",
  "http://localhost:8655",
  "http://127.0.0.1:8000",
]);
const MAX_ACCOUNT_AGE_MS = 15 * 60 * 1000;

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://danielswims101.github.io",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return json(req, { sent: false, reason: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const userId = String(body?.user_id ?? "");
    if (!UUID.test(userId)) return json(req, { sent: false, reason: "user_id required" });

    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const NOTIFY_EMAIL = Deno.env.get("NOTIFY_EMAIL");
    if (!RESEND_API_KEY || !NOTIFY_EMAIL) {
      return json(req, { sent: false, reason: "Email not configured yet." });
    }

    // Look the account up ourselves — never trust the browser's copy.
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error || !data?.user) return json(req, { sent: false, reason: "Unknown user" });
    const user = data.user;

    const ageMs = Date.now() - new Date(user.created_at).getTime();
    if (!(ageMs >= 0 && ageMs <= MAX_ACCOUNT_AGE_MS)) {
      return json(req, { sent: false, reason: "Not a new account" });
    }

    let username = String(user.user_metadata?.username ?? "").slice(0, 24);
    if (!username) {
      const { data: prof } = await admin.from("profiles").select("username").eq("id", user.id).maybeSingle();
      username = String(prof?.username ?? "(no username yet)").slice(0, 24);
    }
    const email = String(user.email ?? "(no email)").slice(0, 200);
    const when = new Date(user.created_at).toLocaleString("en-US", { timeZone: "America/New_York" });

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: "Tidelyne <onboarding@resend.dev>",
        to: NOTIFY_EMAIL,
        subject: `New Tidelyne signup: ${username}`,
        html: `<h2>New Tidelyne account</h2>
          <p><strong>Username:</strong> ${escapeHtml(username)}</p>
          <p><strong>Email:</strong> ${escapeHtml(email)}</p>
          <p><strong>Created:</strong> ${escapeHtml(when)} (New York time)</p>
          <p><strong>Email confirmed:</strong> ${user.email_confirmed_at ? "yes" : "not yet"}</p>`,
      }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) console.error("resend error:", res.status, out);
    return json(req, { sent: res.ok });
  } catch (e) {
    console.error("notify-signup error:", e);
    return json(req, { sent: false, error: "internal" });
  }
});
