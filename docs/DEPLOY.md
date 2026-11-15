# Deploying Bizzy (Vercel + Supabase)

> These steps were written from the code and the tools' documentation. They have **not yet been run end to end** against a real Vercel and Supabase account. Expect to adjust a label or two; the first real deploy should update this file.

You need: the GitHub repo, a Vercel account and a Supabase account. Keys are only ever pasted into Vercel's and Supabase's own settings pages, never into the code.

## 1. Push the code

```bash
git push -u origin main
```

## 2. Create the Supabase projects

The Free plan allows two projects, which is exactly what this needs:

| Project | Used by |
| --- | --- |
| `bizzy-prod` | The live site |
| `bizzy-preview` | Every Vercel preview deployment (shared database) |

For **each** project, in the Supabase dashboard:

1. **Authentication → Sign In / Providers → Email:** leave "Confirm email" **on**. Invites are bound to an email address, so addresses must be verified.
2. **Authentication → URL Configuration:**
   - `bizzy-prod`: Site URL = your production URL (e.g. `https://bizzy.example.com`). Add `https://bizzy.example.com/**` to Redirect URLs.
   - `bizzy-preview`: Site URL = your Vercel project URL. Add `https://*.vercel.app/**` to Redirect URLs.
3. Note three values (Project Settings → API, and the "Connect" button):
   - Project URL
   - The public `anon` (publishable) key
   - The **Session pooler** connection string for Postgres, with your database password filled in. Use the pooler string, not the direct one: Vercel builds cannot reach Supabase's direct IPv6 address.

4. **Authentication → OAuth Server** (needed for AI connections, Phase 2): switch it **on**, set the authorization path to `/oauth/consent`, and allow **dynamic client registration** (AI apps register themselves). Locally this is the `[auth.oauth_server]` block in `supabase/config.toml`. Not yet tried on a hosted project; the dashboard labels may differ.

Free projects pause after about a week without activity; you resume them from the dashboard.

## 3. Create the Vercel project

1. Vercel → Add New → Project → import `TreeTheCreator/Bizzy`. Framework preset: Next.js. Leave the build command as the default (`npm run build`).
2. Settings → Environment Variables. Add each variable **twice**, once per environment:

| Variable | Production | Preview |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | `bizzy-prod` URL | `bizzy-preview` URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `bizzy-prod` anon key | `bizzy-preview` anon key |
| `SUPABASE_DB_URL` | `bizzy-prod` pooler string | `bizzy-preview` pooler string |
| `NEXT_PUBLIC_APP_URL` | your production URL | *(leave unset)* |

Three more variables switch on Phase 2 features. All three are **secrets**: mark them "Sensitive" in Vercel, never prefix them with `NEXT_PUBLIC_`, and use each project's own values per environment. Without them the app still runs; the feature they power stays off and its Settings page says so.

| Variable | Switches on | Where to find it |
| --- | --- | --- |
| `SUPABASE_JWT_SECRET` | The REST API (`/api/v1`, API keys). The server uses it to sign a two-minute database token for the member an API key belongs to. | Supabase → Project Settings → JWT Keys → legacy JWT secret |
| `SUPABASE_SERVICE_ROLE_KEY` | Webhook delivery and the daily cleanup of orphaned files. Used only by those two workers. | Supabase → Project Settings → API keys → `service_role` |
| `CRON_SECRET` | The two daily jobs in `vercel.json`: the webhook retry sweep and the orphaned-file cleanup. Any long random string; Vercel sends it to the cron routes. | You make it up |

Treat `SUPABASE_JWT_SECRET` with the same care as the service-role key: anyone holding it can sign a token for any user. Not yet tried on a hosted project: if your project has moved to Supabase's newer asymmetric signing keys and no longer accepts tokens signed with the legacy secret, the API will answer 401 and needs a shared-secret (HS256) signing key added in the same dashboard page.

Webhooks are sent right after the request that caused them. The webhook cron job is only a retry sweep and runs once a day, which is the most Vercel's Hobby plan allows; on a paid plan you can shorten the schedule in `vercel.json`.

3. Deploy. During the build, `scripts/migrate.mjs` applies any new database migrations to that environment's database, then Next.js builds. A production build refuses to run if `SUPABASE_DB_URL` is missing, so code can never go live ahead of its schema.

## 4. Custom domain

Vercel → Settings → Domains → add your domain and follow the DNS instructions. Then update `NEXT_PUBLIC_APP_URL` (Production) and the Supabase Site URL / Redirect URLs to match, and redeploy.

## 5. First run checklist

1. Open the site, create your account, confirm the email, sign in.
2. Create a workspace. You are its owner.
3. Settings → Members → create an invite link and send it to a teammate.
4. After they join, Settings → Members → give them a role.

Because only you and selected people use Bizzy for now, consider switching **off** "Allow new users to sign up" in Supabase (Authentication → Sign In / Providers) once everyone has an account. Signing up never gives access to anyone else's workspace, but it does let strangers create accounts.

## How preview deployments work

Every pull request gets its own Vercel URL, all sharing the `bizzy-preview` database. A pull request that adds a migration applies it to that shared database when its preview builds, so avoid having two open pull requests with conflicting migrations. (Supabase's paid plan offers one database per pull request; the code needs no change to use it.)

## Email limits

Supabase's built-in email sender is limited to a handful of messages per hour, which is fine for a small private team. Before opening to the public, configure your own SMTP provider under Authentication → Emails.
