# Lecue

Real-time lecture transcription and context-aware Q&A for live classes.

Lecue helps students follow a lecture while it is happening: speech is transcribed in real time, questions are answered using the current lecture context, and previous sessions remain available for review.

## Product highlights

- Real-time speech transcription with Deepgram
- Context-aware questions and answers using the current transcript
- Source links when web search is used
- Classroom and session management
- Search across related previous lessons
- Persistent transcripts, questions, and lecture materials
- Email and Google authentication
- Usage metering and credit-based billing
- Responsive desktop and mobile layouts

## Architecture

```text
Browser
  ├─ microphone input
  ├─ live transcript and Q&A interface
  └─ authenticated session
       │
       ├─ Next.js application routes
       ├─ Deepgram temporary-token flow
       ├─ OpenAI / Anthropic / Google model integrations
       ├─ Supabase Auth, Postgres, Storage, and Row Level Security
       └─ Paddle checkout and webhook-based credit accounting
```

The browser receives short-lived transcription tokens. Long-lived provider credentials and billing operations stay on the server. Credits are granted from verified payment webhooks and consumed atomically per recorded minute.

## Tech stack

- Next.js 15 App Router
- TypeScript
- Supabase Auth, Postgres, Storage, and RLS
- Deepgram streaming transcription
- OpenAI, Anthropic, and Google model APIs
- Paddle Billing
- Vitest and type checking
- GitHub Actions

## Run locally

Requirements:

- Node.js 20 or later
- A Supabase project
- Provider credentials for the features you want to enable

```sh
git clone https://github.com/dbgudwn43890-del/lecture-live.git
cd lecture-live
npm install
cp .env.example .env.local
npm run dev
```

Configure the required environment variables in `.env.local`. Apply the SQL migrations in `supabase/migrations/` to a development Supabase project. Never commit API keys, service-role keys, webhook secrets, or user credentials.

Open [http://localhost:3000](http://localhost:3000). Microphone access requires localhost or HTTPS.

For Google sign-in, Supabase **Authentication → URL Configuration → Redirect URLs** must allow both `http://localhost:3000/auth/callback` and `http://localhost:3000/auth/callback?next=*`. The login page includes an encoded destination in `next`; allowing only the bare callback can send the browser to the production Site URL instead. Keep Site URL set to the production domain. Use `localhost` consistently when signing in and opening the classroom; `127.0.0.1` has separate cookies and would need its own allowed callback.

## Validation

```sh
npm run typecheck
npm run test:rate-limit
npm run test:chunks
npm run test:billing
npm run build
```

## Status

The main lecture, authentication, classroom, transcript, Q&A, usage-metering, and billing flows are implemented. Deployment and production launch require completing the provider, business, and support configuration.

## License

This project is maintained by [dbgudwn43890-del](https://github.com/dbgudwn43890-del).
