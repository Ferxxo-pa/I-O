/** Post the signed amount to the company group. Quiet when the bot is not configured. */
export async function mirrorSignedUpdate(label: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat || !label) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: label }),
    });
  } catch {
    // The book still updates when Telegram is unreachable.
  }
}
