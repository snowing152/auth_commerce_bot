# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — run the bot from TypeScript via `ts-node` (no build step).
- `npm run build` — compile `src/` → `dist/` with `tsc`.
- `npm start` — run the compiled bot (`node dist/bot.js`). Requires `npm run build` first.

There is no test runner, linter, or formatter configured.

## Architecture

This is a single-file Telegram bot ([src/bot.ts](src/bot.ts)) that acts as the auth + billing companion for an external "Coupang Bot" web app. The bot itself owns no business logic beyond subscription state — Supabase is the source of truth.

### Flows, all routed through `/start`, reply-keyboard text matches, or inline callback queries

User-facing handlers (`/помощь`, `/статус подписки`, `/оплатить подписку`, `/инструкция`) are gated on `msg.chat.type === "private"` so messages in the support group don't trigger them.

1. **Login bridge** (`/start login_<token>`): the web app inserts a row into `auth_tokens` with a short-lived token, then deep-links the user to `t.me/<bot>?start=login_<token>`. The bot validates `expires_at`, upserts the user into `users` with a 1-day trial, and sets `auth_tokens.confirmed = true` plus `telegram_id`. The web app polls that row to know the login completed.
2. **Status** (regex `/статус подписки/i` against the reply keyboard): reads `users.subscription_status` and reports remaining days from either `trial_end` or `subscription_end`.
3. **Telegram payment** (regex `/оплатить подписку/i` → inline keyboard → `pay:tg` callback): branches on `PAYMENT_PROVIDER_TOKEN`. If set → Telegram Payments invoice in `KRW` (price hardcoded to `9900 * 100`). If unset → Telegram Stars invoice in `XTR` for `STARS_AMOUNT`. Both encode `{telegram_id, days}` as the invoice payload. `pre_checkout_query` is auto-approved; `successful_payment` writes a `payments` row and calls `extendSubscription` which adds `SUBSCRIPTION_DAYS` to `max(now, current subscription_end)`.
4. **Toss Bank manual transfer** (inline callback `pay:toss`, only shown when `TOSS_ENABLED`): no merchant API. Bot inserts a `payment_orders` row (`status='pending'`) with a 6-char unique `memo`, shows account number + memo, and offers a "✅ Я оплатил" button (`toss_paid:<order_id>`). That button atomically transitions to `user_claimed` and posts an Approve/Reject card into `SUPPORT_CHAT_ID` (`toss_approve:` / `toss_reject:`). Approve gates on `isAdmin(query.from.id)` (any id in `ADMIN_TELEGRAM_IDS`), atomically transitions `user_claimed → approved`, inserts a `payments` row with synthetic `telegram_charge_id='toss-<uuid>'`, and calls `extendSubscription(telegram_id, TOSS_DAYS)`. Reject only flips status and DMs the user. Both transitions are idempotent via `.eq('status', '<from>')`. The Approve/Reject card is edited in-place to show which admin decided.
5. **Support relay** (regex `/помощь/i` in private chats): the bot posts the request into `SUPPORT_CHAT_ID` with a `User-ID: <id>` marker line. Admins reply (Telegram-reply) to that message in the support group; a global `message` handler scoped to `SUPPORT_CHAT_ID` parses the marker out of `reply_to_message.text`, verifies the sender via `isAdmin`, and forwards their text to the user as the bot. One-shot — each new question requires the user to press "❓ Помощь" again. Requires the bot's privacy mode disabled in BotFather, otherwise it won't see admin replies in the group.

### Supabase schema (referenced, not defined in this repo)

- `users` — `telegram_id`, `first_name`, `username`, `subscription_status` (`trial` | `active` | expired), `trial_start/end`, `subscription_end`.
- `auth_tokens` — `token`, `expires_at`, `confirmed`, `telegram_id`.
- `payments` — `telegram_id`, `amount`, `currency`, `telegram_charge_id`, `provider_charge_id`, `days_granted`. Toss approvals reuse this table with `currency='KRW'` and `telegram_charge_id='toss-<order_id>'`; the `telegram_charge_id` column is the dedupe key for both Telegram and Toss paths.
- `payment_orders` (Toss flow) — `id` (uuid), `telegram_id`, `amount_krw`, `days`, `memo` (unique), `status` (`pending` | `user_claimed` | `approved` | `rejected`), `admin_id`, `created_at`, `decided_at`.

The bot uses the **service role key** and runs server-side only — never expose this build to a client.

### Required `.env` (loaded from repo root via `dotenv` with an explicit `path.join(__dirname, "../.env")`)

`BOT_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` are mandatory. `PAYMENT_PROVIDER_TOKEN` is optional and toggles the KRW vs Stars Telegram-payment path. `SUBSCRIPTION_DAYS` (default 30) and `STARS_AMOUNT` (default 300) tune the Telegram offer. Note: `.env` defines `SUBSCRIPTION_PRICE_KRW` but the code does not read it — the KRW price is hardcoded.

Admins and support group:
- `ADMIN_TELEGRAM_IDS` — comma-separated list of Telegram user ids who can approve Toss payments and reply through the support relay. Falls back to the legacy single `ADMIN_TELEGRAM_ID` if `ADMIN_TELEGRAM_IDS` is unset.
- `SUPPORT_CHAT_ID` — chat id of the shared support super-group (negative number). Required for both the Toss approval UI and the support relay. Bot must be added to that group with **privacy mode disabled** in BotFather, otherwise it won't see admin replies.

Toss Bank flow is enabled only when **both** `SUPPORT_CHAT_ID` and `TOSS_ACCOUNT_NUMBER` are set. Other Toss vars: `TOSS_BANK_NAME` (default `토스뱅크`), `TOSS_ACCOUNT_HOLDER`, `TOSS_PRICE_KRW` (default `500`, set to `9900` for prod), `TOSS_DAYS` (default `1`, set to `30` for prod). The amount stored in `payments.amount` for Toss rows is the raw KRW value (no `*100` multiplier), unlike Telegram-KRW rows which use `total_amount` from the Telegram API.

### Runtime model

`node-telegram-bot-api` is used in **long-polling** mode (`{ polling: true }`). There is no webhook server, no HTTP surface, and no graceful shutdown — the process is meant to run as a single instance (running two instances simultaneously will cause Telegram polling conflicts).
