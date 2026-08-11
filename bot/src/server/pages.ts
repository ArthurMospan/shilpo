// Standalone pages shown in the external browser during the OAuth handshake.
// They are intentionally dependency-free: this window is opened by Silpo's
// redirect, outside the Mini App bundle.

function shell(title: string, accent: string, icon: string, heading: string, body: string, extraScript = ''): string {
    return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 24px;
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: #171717; background: radial-gradient(circle at 50% 30%, #fff5ed 0, #f7f7f5 55%);
  }
  .card {
    width: min(100%, 380px); padding: 32px 26px; text-align: center;
    background: #fff; border-radius: 26px; box-shadow: 0 18px 48px rgba(47, 29, 14, .12);
  }
  .icon {
    width: 62px; height: 62px; margin: 0 auto 20px; display: grid; place-items: center;
    border-radius: 20px; font-size: 30px; background: ${accent};
  }
  h1 { margin: 0 0 10px; font-size: 22px; letter-spacing: -.03em; }
  p { margin: 0; color: #6f6f68; font-size: 14px; line-height: 1.55; }
  .hint { margin-top: 22px; font-size: 12px; color: #9a9a92; }
</style>
</head>
<body>
  <main class="card">
    <div class="icon">${icon}</div>
    <h1>${heading}</h1>
    <p>${body}</p>
    <p class="hint">Це вікно можна закрити.</p>
  </main>
  <script>${extraScript}</script>
</body>
</html>`;
}

export function connectedPage(): string {
    return shell(
        'Кабінет Сільпо підключено',
        'linear-gradient(135deg, #ffe8d4, #ffd6b3)',
        '🍊',
        'Готово!',
        'Кабінет Сільпо підключено. Повертайся в Telegram — Шільпо вже шукає товари зі списку.',
        // Telegram closes the in-app browser itself when the WebApp API is present.
        'setTimeout(function(){ try { window.Telegram?.WebApp?.close(); } catch (e) {} window.close(); }, 1800);'
    );
}

export function errorPage(heading: string, body: string): string {
    return shell('Щось пішло не так', 'linear-gradient(135deg, #ffe4e4, #ffd0d0)', '😞', heading, body);
}
