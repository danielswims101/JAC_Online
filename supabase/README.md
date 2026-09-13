# Supabase backend (project `gzqovsffnziumfbmqdes`)

The live backend is managed in the Supabase dashboard; this folder is the
version-controlled copy so changes are reviewable.

| Path | What it is |
| --- | --- |
| `migrations/20260913_auth_hardening.sql` | Profiles are private (own row only), `username_taken(text)` RPC for the signup form, server-side profile creation trigger, `ai_usage` locked to the service role. Already applied. |
| `functions/ask-ai/index.ts` | Streams Claude replies; enforces 20 messages / 5 h per user; safety preamble; crisis messages get a fixed supportive reply and never reach the model. Secret: `ANTHROPIC_API_KEY`. |
| `functions/notify-signup/index.ts` | Emails the owner on each real signup. Verifies the user server-side (`{ user_id }` only). Secrets: `RESEND_API_KEY`, `NOTIFY_EMAIL`. |

## Tables the site uses

- `profiles (id → auth.users, username, preferences, created_at)` — RLS: owner only.
- `ai_usage (user_id, created_at)` — RLS on, no policies: only the `ask-ai` function (service role) can touch it.

`chat_threads`, `chat_messages`, `usage_log` are unused leftovers from an earlier design
(safe: owner-only policies). `jarvis_memory` / `jarvis_calendar` belong to a different
app that shares this project.

## Deploying a function change

Edit the file here, then in the dashboard: Edge Functions → the function → Deploy
(paste the file), or with the CLI: `supabase functions deploy ask-ai`.
