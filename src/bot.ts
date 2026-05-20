// coupang-bot-server/src/bot.ts
import TelegramBot from "node-telegram-bot-api";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "path";
import * as crypto from "crypto";

dotenv.config({ path: path.join(__dirname, "../.env") });

const BOT_TOKEN = process.env.BOT_TOKEN!;
const PAYMENT_PROVIDER_TOKEN = process.env.PAYMENT_PROVIDER_TOKEN || "";
const SUBSCRIPTION_DAYS = Number(process.env.SUBSCRIPTION_DAYS || 30);
const STARS_AMOUNT = Number(process.env.STARS_AMOUNT || 330);
const SUBSCRIPTION_PRICE_KRW = Number(process.env.SUBSCRIPTION_PRICE_KRW || 10000);

// Toss Bank manual-transfer flow (admin-approved, no merchant API)
const ADMIN_TELEGRAM_IDS: number[] = (
  process.env.ADMIN_TELEGRAM_IDS ||
  process.env.ADMIN_TELEGRAM_ID ||
  ""
)
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const SUPPORT_CHAT_ID = process.env.SUPPORT_CHAT_ID
  ? Number(process.env.SUPPORT_CHAT_ID)
  : null;
const TOSS_BANK_NAME = process.env.TOSS_BANK_NAME || "토스뱅크";
const TOSS_ACCOUNT_NUMBER = process.env.TOSS_ACCOUNT_NUMBER || "";
const TOSS_ACCOUNT_HOLDER = process.env.TOSS_ACCOUNT_HOLDER || "";
const TOSS_PRICE_KRW = Number(process.env.TOSS_PRICE_KRW || 10000);
const TOSS_DAYS = Number(process.env.TOSS_DAYS || 30);
const TOSS_ENABLED = SUPPORT_CHAT_ID !== null && TOSS_ACCOUNT_NUMBER !== "";

function isAdmin(userId: number): boolean {
  return ADMIN_TELEGRAM_IDS.includes(userId);
}

const INSTRUCTION_PATH = path.join(__dirname, "../instruction.html");

// ── Supabase (service key — server only) ────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
);

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ── Helpers ─────────────────────────────────────────────────
function mainKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "📊 Статус подписки" }],
        [{ text: "💳 Оплатить подписку" }],
        [{ text: "📖 Инструкция" }],
        [{ text: "❓ Помощь" }],
      ],
      resize_keyboard: true,
    },
  };
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function htmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 6-char uppercase memo, no easily-confused chars (0/O, 1/I, etc.)
function generateMemo(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return out;
}

async function sendInstruction(chatId: number): Promise<void> {
  try {
    await bot.sendDocument(
      chatId,
      INSTRUCTION_PATH,
      { caption: "📖 Инструкция по использованию бота" },
      { filename: "instruction.html", contentType: "text/html" },
    );
  } catch (e) {
    console.error("[sendInstruction] failed:", e);
  }
}

async function extendSubscription(
  telegramId: number,
  days: number,
): Promise<string> {
  const { data: user } = await supabase
    .from("users")
    .select("subscription_end")
    .eq("telegram_id", telegramId)
    .single();

  const base = user?.subscription_end
    ? new Date(Math.max(Date.now(), new Date(user.subscription_end).getTime()))
    : new Date();

  const newEnd = new Date(base.getTime() + days * 86400_000);

  await supabase
    .from("users")
    .update({
      subscription_status: "active",
      subscription_end: newEnd.toISOString(),
    })
    .eq("telegram_id", telegramId);

  return newEnd.toISOString();
}

// ── /start ───────────────────────────────────────────────────
bot.onText(/\/start(?:\s+login_(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const token = match?.[1];
  const tgUser = msg.from!;

  // Regular /start — no token
  if (!token) {
    return bot.sendMessage(
      chatId,
      `👋 Привет, <b>${htmlEscape(tgUser.first_name)}</b>!`,
      { parse_mode: "HTML", ...mainKeyboard() },
    );
  }

  // Login flow — verify token from Supabase (must still be unconfirmed).
  // Use server-set created_at + 5min instead of client-written expires_at
  // because the web app fills expires_at from the user's local clock,
  // which can drift and produce already-expired values.
  const { data, error } = await supabase
    .from("auth_tokens")
    .select("token, created_at, confirmed")
    .eq("token", token)
    .eq("confirmed", false)
    .single();

  if (error || !data) {
    return bot.sendMessage(chatId, "❌ Ссылка недействительна.");
  }

  const expiresAtMs = new Date(data.created_at).getTime() + 5 * 60_000;
  if (expiresAtMs < Date.now()) {
    return bot.sendMessage(chatId, "❌ Ссылка устарела. Войдите снова.");
  }

  // Upsert user
  const now = new Date();
  const { data: existing } = await supabase
    .from("users")
    .select("id")
    .eq("telegram_id", tgUser.id)
    .single();

  const isNewUser = !existing;

  if (isNewUser) {
    await supabase.from("users").insert({
      telegram_id: tgUser.id,
      first_name: tgUser.first_name,
      username: tgUser.username || null,
      subscription_status: "trial",
      trial_start: now.toISOString(),
      trial_end: new Date(now.getTime() + 3 * 86400_000).toISOString(),
    });
  }

  // Atomically claim the token — fails if another redemption raced us.
  const { data: claimed } = await supabase
    .from("auth_tokens")
    .update({ confirmed: true, telegram_id: tgUser.id })
    .eq("token", token)
    .eq("confirmed", false)
    .select("token");

  if (!claimed || claimed.length === 0) {
    return bot.sendMessage(chatId, "❌ Ссылка недействительна.");
  }

  await bot.sendMessage(
    chatId,
    `✅ <b>Вход выполнен!</b>\n\nВернитесь в приложение.`,
    { parse_mode: "HTML", ...mainKeyboard() },
  );

  if (isNewUser) {
    await sendInstruction(chatId);
  }
});

bot.onText(/инструкция/i, async (msg) => {
  if (msg.chat.type !== "private") return;
  await sendInstruction(msg.chat.id);
});

// ── Status ───────────────────────────────────────────────────
bot.onText(/статус подписки/i, async (msg) => {
  if (msg.chat.type !== "private") return;
  const { data: user } = await supabase
    .from("users")
    .select("subscription_status, trial_end, subscription_end")
    .eq("telegram_id", msg.from!.id)
    .single();

  if (!user) {
    return bot.sendMessage(msg.chat.id, "❌ Аккаунт не найден.");
  }

  const now = new Date();
  let text = "";

  if (user.subscription_status === "active" && user.subscription_end) {
    const days = Math.ceil(
      (new Date(user.subscription_end).getTime() - now.getTime()) / 86400_000,
    );
    text = `✅ <b>Подписка активна</b>\n📅 До: <b>${fmtDate(user.subscription_end)}</b>\n⏳ Осталось: <b>${days} дн.</b>`;
  } else if (user.subscription_status === "trial" && user.trial_end) {
    const days = Math.ceil(
      (new Date(user.trial_end).getTime() - now.getTime()) / 86400_000,
    );
    text = `🟡 <b>Пробный период</b>\n📅 До: <b>${fmtDate(user.trial_end)}</b>\n⏳ Осталось: <b>${days} дн.</b>`;
  } else {
    text = `❌ <b>Подписка истекла</b>`;
  }

  bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML", ...mainKeyboard() });
});

// ── Help ─────────────────────────────────────────────────────
// Two-step ticket flow: user presses "❓ Помощь" → bot asks to describe the
// problem → the user's next message (text or photo) is bundled and sent to
// the support chat. State is kept in-memory; lost on restart, which is fine
// for a one-shot flow.
const pendingHelp = new Set<number>();

bot.onText(/помощь/i, async (msg) => {
  if (msg.chat.type !== "private") return;
  if (SUPPORT_CHAT_ID === null) return;
  pendingHelp.add(msg.from!.id);
  await bot.sendMessage(
    msg.chat.id,
    "✍️ <b>Опишите вашу проблему</b> одним сообщением.\nМожно приложить скриншот.\n\nДля отмены отправьте /отмена.",
    { parse_mode: "HTML" },
  );
});

bot.onText(/^\/отмена$/i, async (msg) => {
  if (msg.chat.type !== "private") return;
  if (!pendingHelp.has(msg.from!.id)) return;
  pendingHelp.delete(msg.from!.id);
  await bot.sendMessage(msg.chat.id, "❌ Запрос отменён.", mainKeyboard());
});

// Collect the user's problem description and forward it to the support chat.
bot.on("message", async (msg) => {
  if (msg.chat.type !== "private") return;
  if (SUPPORT_CHAT_ID === null) return;
  if (!msg.from || !pendingHelp.has(msg.from.id)) return;
  // Let nav buttons and slash commands pass through to their own handlers.
  if (msg.text && /^(📊|💳|📖|❓|\/)/.test(msg.text)) return;
  if (!msg.text && !msg.photo) return;

  pendingHelp.delete(msg.from.id);

  const u = msg.from;
  const userLabel = u.username
    ? `@${u.username}`
    : `${u.first_name}${u.last_name ? " " + u.last_name : ""}`;
  const header = `🆘 <b>Запрос помощи</b>\n\nПользователь: <b>${htmlEscape(userLabel)}</b>\nUser-ID: <code>${u.id}</code>\n\n<i>Ответьте reply на это сообщение — бот перешлёт текст пользователю.</i>`;

  try {
    if (msg.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      const captionText = msg.caption ? `\n\n📝 ${htmlEscape(msg.caption)}` : "";
      await bot.sendPhoto(SUPPORT_CHAT_ID, largest.file_id, {
        caption: `${header}${captionText}`,
        parse_mode: "HTML",
      });
    } else if (msg.text) {
      await bot.sendMessage(
        SUPPORT_CHAT_ID,
        `${header}\n\n📝 ${htmlEscape(msg.text)}`,
        { parse_mode: "HTML" },
      );
    }
    await bot.sendMessage(
      msg.chat.id,
      "✅ Ваш запрос отправлен. Ожидайте ответа.",
      mainKeyboard(),
    );
  } catch (e) {
    console.error("[help-forward] failed:", e);
    await bot.sendMessage(
      msg.chat.id,
      "❌ Не удалось отправить запрос. Попробуйте позже.",
      mainKeyboard(),
    );
  }
});

// Relay admin replies from the support chat to the original user as the bot.
bot.on("message", async (msg) => {
  if (SUPPORT_CHAT_ID === null) return;
  if (msg.chat.id !== SUPPORT_CHAT_ID) return;
  if (!msg.reply_to_message) return;
  if (!msg.from || !isAdmin(msg.from.id)) return;
  if (!msg.text || msg.text.startsWith("/")) return;

  const replyText =
    msg.reply_to_message.text || msg.reply_to_message.caption || "";
  const match = replyText.match(/User-ID:\s*(\d+)/);
  if (!match) return;

  const targetUserId = Number(match[1]);
  try {
    await bot.sendMessage(
      targetUserId,
      `💬 <b>Ответ поддержки:</b>\n\n${htmlEscape(msg.text)}`,
      { parse_mode: "HTML" },
    );
    await bot.sendMessage(msg.chat.id, "✅ Отправлено пользователю.", {
      reply_to_message_id: msg.message_id,
    });
  } catch (e) {
    console.error("[support-relay] failed:", e);
    await bot.sendMessage(
      msg.chat.id,
      "❌ Не удалось доставить (юзер заблокировал бота?).",
      { reply_to_message_id: msg.message_id },
    );
  }
});

// ── Payment ──────────────────────────────────────────────────
async function sendTelegramInvoice(chatId: number, fromId: number) {
  if (PAYMENT_PROVIDER_TOKEN) {
    await bot.sendInvoice(
      chatId,
      "Coupang Bot — Pro подписка",
      `${SUBSCRIPTION_DAYS} дней полного доступа.`,
      JSON.stringify({ telegram_id: fromId, days: SUBSCRIPTION_DAYS }),
      PAYMENT_PROVIDER_TOKEN,
      "KRW",
      [{ label: `Pro — ${SUBSCRIPTION_DAYS} дней`, amount: SUBSCRIPTION_PRICE_KRW * 100 }],
    );
  } else {
    await bot.sendInvoice(
      chatId,
      "Coupang Bot — Pro подписка",
      `${SUBSCRIPTION_DAYS} дней полного доступа. ⭐ Оплата через Stars.`,
      JSON.stringify({ telegram_id: fromId, days: SUBSCRIPTION_DAYS }),
      "",
      "XTR",
      [{ label: `Pro — ${SUBSCRIPTION_DAYS} дней`, amount: STARS_AMOUNT }],
    );
  }
}

bot.onText(/оплатить подписку/i, async (msg) => {
  if (msg.chat.type !== "private") return;
  const chatId = msg.chat.id;

  const inline_keyboard: TelegramBot.InlineKeyboardButton[][] = [];
  inline_keyboard.push([
    {
      text: PAYMENT_PROVIDER_TOKEN ? "💳 Telegram (KRW)" : "⭐ Telegram Stars",
      callback_data: "pay:tg",
    },
  ]);
  if (TOSS_ENABLED) {
    inline_keyboard.push([
      { text: "🏦 Toss Bank Korea", callback_data: "pay:toss" },
    ]);
  }

  await bot.sendMessage(
    chatId,
    "Выберите способ оплаты(пока только оплата через перевод на Toss):",
    {
      reply_markup: { inline_keyboard },
    },
  );
});

async function startTossOrder(chatId: number, fromId: number) {
  let order: { id: string; memo: string } | null = null;
  for (let attempt = 0; attempt < 5 && !order; attempt++) {
    const memo = generateMemo();
    const { data, error } = await supabase
      .from("payment_orders")
      .insert({
        telegram_id: fromId,
        amount_krw: TOSS_PRICE_KRW,
        days: TOSS_DAYS,
        memo,
        status: "pending",
      })
      .select("id, memo")
      .single();
    if (!error && data) {
      order = data;
      break;
    }
    if (error && (error as { code?: string }).code !== "23505") {
      console.error("[toss-order-insert]", error);
      await bot.sendMessage(
        chatId,
        "❌ Не удалось создать заказ. Попробуйте позже.",
      );
      return;
    }
  }
  if (!order) {
    await bot.sendMessage(
      chatId,
      "❌ Не удалось создать заказ. Попробуйте позже.",
    );
    return;
  }

  const text = [
    `🏦 <b>Оплата переводом</b>`,
    ``,
    `Переведите <b>${TOSS_PRICE_KRW.toLocaleString("ko-KR")} KRW</b> на счёт:`,
    ``,
    `Банк: <b>${htmlEscape(TOSS_BANK_NAME)}</b>`,
    `Счёт: <b>${htmlEscape(TOSS_ACCOUNT_NUMBER)}</b>`,
    `Получатель: <b>${htmlEscape(TOSS_ACCOUNT_HOLDER)}</b>`,
    ``,
    `📝 Укажите в поле «받는분 통장표시» (memo):`,
    `<code>${order.memo}</code>`,
    ``,
    `После перевода нажмите кнопку ниже.`,
  ].join("\n");

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Я оплатил", callback_data: `toss_paid:${order.id}` }],
      ],
    },
  });
}

async function handleUserClaim(
  query: TelegramBot.CallbackQuery,
  orderId: string,
  chatId: number,
  fromId: number,
) {
  const { data: order, error } = await supabase
    .from("payment_orders")
    .select("id, telegram_id, amount_krw, days, memo, status")
    .eq("id", orderId)
    .single();

  if (error || !order) {
    await bot.answerCallbackQuery(query.id, { text: "Заказ не найден" });
    return;
  }
  if (order.telegram_id !== fromId) {
    await bot.answerCallbackQuery(query.id, { text: "Чужой заказ" });
    return;
  }

  if (order.status === "approved") {
    await bot.sendMessage(chatId, "✅ Этот заказ уже подтверждён.");
    await bot.answerCallbackQuery(query.id);
    return;
  }
  if (order.status === "rejected") {
    await bot.sendMessage(chatId, "❌ Этот заказ отклонён. Создайте новый.");
    await bot.answerCallbackQuery(query.id);
    return;
  }

  if (order.status === "pending") {
    const { data: updated } = await supabase
      .from("payment_orders")
      .update({ status: "user_claimed" })
      .eq("id", orderId)
      .eq("status", "pending")
      .select("id")
      .single();

    if (updated && SUPPORT_CHAT_ID !== null) {
      const u = query.from;
      const userLabel = u.username
        ? `@${u.username}`
        : `${u.first_name}${u.last_name ? " " + u.last_name : ""}`;
      const adminText = [
        `🏦 <b>Новый Toss-платёж</b>`,
        ``,
        `Пользователь: <b>${htmlEscape(userLabel)}</b> (id: <code>${fromId}</code>)`,
        `Сумма: <b>${order.amount_krw.toLocaleString("ko-KR")} KRW</b>`,
        `Дней: <b>${order.days}</b>`,
        `Memo: <code>${order.memo}</code>`,
      ].join("\n");
      await bot.sendMessage(SUPPORT_CHAT_ID, adminText, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Approve", callback_data: `toss_approve:${order.id}` },
              { text: "❌ Reject", callback_data: `toss_reject:${order.id}` },
            ],
          ],
        },
      });
    }
  }

  await bot.sendMessage(
    chatId,
    "⏳ Платёж проверяется администратором. Это может занять некоторое время.",
  );
  await bot.answerCallbackQuery(query.id);
}

async function handleAdminDecision(
  query: TelegramBot.CallbackQuery,
  orderId: string,
  decision: "approved" | "rejected",
) {
  if (!isAdmin(query.from.id)) {
    await bot.answerCallbackQuery(query.id, { text: "Только для админов" });
    return;
  }

  const { data: updated } = await supabase
    .from("payment_orders")
    .update({
      status: decision,
      admin_id: query.from.id,
      decided_at: new Date().toISOString(),
    })
    .eq("id", orderId)
    .eq("status", "user_claimed")
    .select("id, telegram_id, amount_krw, days, memo")
    .single();

  if (!updated) {
    await bot.answerCallbackQuery(query.id, { text: "Уже обработан" });
    return;
  }

  if (decision === "approved") {
    const { error: insertErr } = await supabase.from("payments").insert({
      telegram_id: updated.telegram_id,
      amount: updated.amount_krw,
      currency: "KRW",
      telegram_charge_id: `toss-${updated.id}`,
      provider_charge_id: null,
      days_granted: updated.days,
    });
    if (insertErr && (insertErr as { code?: string }).code !== "23505") {
      console.error("[toss-payment-insert]", insertErr);
    }

    const newEnd = await extendSubscription(updated.telegram_id, updated.days);

    await bot.sendMessage(
      updated.telegram_id,
      `🎉 <b>Оплата прошла!</b>\nПодписка до: <b>${fmtDate(newEnd)}</b>\n\nЗапустите приложение ✅`,
      { parse_mode: "HTML", ...mainKeyboard() },
    );

    if (query.message) {
      await bot.editMessageText(
        `✅ <b>Approved</b> by ${htmlEscape(query.from.first_name)} — order <code>${updated.memo}</code>`,
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: "HTML",
        },
      );
    }
  } else {
    await bot.sendMessage(
      updated.telegram_id,
      "❌ Платёж отклонён администратором. Если это ошибка — свяжитесь с поддержкой.",
    );
    if (query.message) {
      await bot.editMessageText(
        `❌ <b>Rejected</b> by ${htmlEscape(query.from.first_name)} — order <code>${updated.memo}</code>`,
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: "HTML",
        },
      );
    }
  }

  await bot.answerCallbackQuery(query.id, {
    text: decision === "approved" ? "Approved" : "Rejected",
  });
}

bot.on("callback_query", async (query) => {
  const data = query.data || "";
  const chatId = query.message?.chat.id;
  const fromId = query.from.id;

  try {
    if (data === "pay:tg" && chatId) {
      await sendTelegramInvoice(chatId, fromId);
      await bot.answerCallbackQuery(query.id);
      return;
    }
    if (data === "pay:toss" && chatId) {
      if (!TOSS_ENABLED) {
        await bot.answerCallbackQuery(query.id, { text: "Метод недоступен" });
        return;
      }
      await startTossOrder(chatId, fromId);
      await bot.answerCallbackQuery(query.id);
      return;
    }
    if (data.startsWith("toss_paid:") && chatId) {
      const orderId = data.slice("toss_paid:".length);
      await handleUserClaim(query, orderId, chatId, fromId);
      return;
    }
    if (data.startsWith("toss_approve:")) {
      const orderId = data.slice("toss_approve:".length);
      await handleAdminDecision(query, orderId, "approved");
      return;
    }
    if (data.startsWith("toss_reject:")) {
      const orderId = data.slice("toss_reject:".length);
      await handleAdminDecision(query, orderId, "rejected");
      return;
    }
    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.error("[callback]", err);
    try {
      await bot.answerCallbackQuery(query.id, { text: "Ошибка" });
    } catch {}
  }
});

bot.on("pre_checkout_query", async (query) => {
  const expectedAmount =
    query.currency === "KRW"
      ? SUBSCRIPTION_PRICE_KRW * 100
      : query.currency === "XTR"
        ? STARS_AMOUNT
        : null;

  let payload: { telegram_id?: number; days?: number };
  try {
    payload = JSON.parse(query.invoice_payload);
  } catch {
    return bot.answerPreCheckoutQuery(query.id, false, {
      error_message: "Некорректный счёт.",
    });
  }

  const ok =
    expectedAmount !== null &&
    query.total_amount === expectedAmount &&
    payload.telegram_id === query.from.id &&
    payload.days === SUBSCRIPTION_DAYS;

  if (!ok) {
    console.error("[pre-checkout-mismatch]", {
      from: query.from.id,
      query,
      payload,
    });
    return bot.answerPreCheckoutQuery(query.id, false, {
      error_message: "Несоответствие данных счёта.",
    });
  }

  bot.answerPreCheckoutQuery(query.id, true);
});

bot.on("successful_payment", async (msg) => {
  const payment = msg.successful_payment!;
  const fromId = msg.from!.id;

  let payload: { telegram_id?: number; days?: number };
  try {
    payload = JSON.parse(payment.invoice_payload);
  } catch {
    console.error("[payment-parse]", { fromId, raw: payment.invoice_payload });
    return bot.sendMessage(
      msg.chat.id,
      "❌ Некорректные данные платежа. Свяжитесь с поддержкой.",
    );
  }

  if (
    typeof payload.telegram_id !== "number" ||
    typeof payload.days !== "number" ||
    payload.telegram_id !== fromId ||
    payload.days <= 0 ||
    payload.days > SUBSCRIPTION_DAYS
  ) {
    console.error("[payment-mismatch]", {
      fromId,
      payload,
      charge: payment.telegram_payment_charge_id,
    });
    return bot.sendMessage(
      msg.chat.id,
      "❌ Несоответствие данных платежа. Свяжитесь с поддержкой.",
    );
  }

  const { error: insertErr } = await supabase.from("payments").insert({
    telegram_id: fromId,
    amount: payment.total_amount,
    currency: payment.currency,
    telegram_charge_id: payment.telegram_payment_charge_id,
    provider_charge_id: payment.provider_payment_charge_id || null,
    days_granted: payload.days,
  });

  if (insertErr) {
    if ((insertErr as { code?: string }).code === "23505") {
      // Duplicate telegram_charge_id — Telegram redelivery, already credited.
      return;
    }
    console.error("[payment-insert]", insertErr);
    return bot.sendMessage(
      msg.chat.id,
      "❌ Ошибка обработки платежа. Свяжитесь с поддержкой.",
    );
  }

  const newEnd = await extendSubscription(fromId, payload.days);

  bot.sendMessage(
    msg.chat.id,
    `🎉 <b>Оплата прошла!</b>\nПодписка до: <b>${fmtDate(newEnd)}</b>\n\nЗапустите приложение ✅`,
    { parse_mode: "HTML", ...mainKeyboard() },
  );
});

bot.on("polling_error", (err) => console.error("[polling]", err.message));
console.log("🤖 Coupang Bot started.");

/**
 * Graceful shutdown on SIGTERM (sent by Railway during redeploy).
 * Ensures polling stops cleanly before the process exits.
 */
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Stopping bot polling...');

  bot.stopPolling()
    .then(() => {
      console.log('Polling stopped. Exiting.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Error stopping polling:', err);
      process.exit(1);
    });
});
