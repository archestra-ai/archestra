export function renderConnectedHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>WhatsApp Connected</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; background: #f0f0f0; color: #333;
    }
    @media (prefers-color-scheme: dark) { body { background: #1a1a1a; color: #e0e0e0; } }
    .container { text-align: center; padding: 2rem; }
    .icon { font-size: 4rem; margin-bottom: 1rem; }
    h1 { font-size: 1.5rem; margin-bottom: .5rem; }
    p { color: #666; margin-bottom: 1rem; }
    @media (prefers-color-scheme: dark) { p { color: #999; } }
    .unlink-btn {
      display: inline-block; padding: .5rem 1.5rem; border: 1px solid #ccc;
      border-radius: 6px; background: transparent; color: #666; cursor: pointer;
      font-size: .875rem; text-decoration: none;
    }
    .unlink-btn:hover { border-color: #999; color: #333; }
    @media (prefers-color-scheme: dark) {
      .unlink-btn { border-color: #444; color: #999; }
      .unlink-btn:hover { border-color: #666; color: #ccc; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">&#9989;</div>
    <h1>Connected</h1>
    <p>WhatsApp is linked and ready.</p>
    <form method="POST" action="./unlink">
      <button type="submit" class="unlink-btn">Unlink device</button>
    </form>
  </div>
</body>
</html>`
}

export function renderQrPageHtml(qrDataUrl: string | null): string {
  const qrContent = qrDataUrl
    ? `<img src="${qrDataUrl}" alt="QR Code" style="max-width:300px;width:100%">`
    : '<p style="color:#666">Starting...</p>'

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="3">
  <title>WhatsApp Connection</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; background: #f0f0f0; color: #333;
    }
    @media (prefers-color-scheme: dark) { body { background: #1a1a1a; color: #e0e0e0; } }
    .container { text-align: center; padding: 2rem; }
    h1 { font-size: 1.25rem; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Scan QR Code</h1>
    <div id="qr">${qrContent}</div>
  </div>
</body>
</html>`
}
