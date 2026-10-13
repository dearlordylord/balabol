import { HttpRouter, HttpServerResponse } from "effect/http"

const welcomePage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Balabol backend</title>
<style>
body { font: 18px/1.6 system-ui, sans-serif; max-width: 44rem; margin: 3rem auto; padding: 0 1.25rem; color: #18222b; background: #fafafa; }
h1 { line-height: 1.2; }
code { font-size: .9em; background: #e9edf0; padding: .15rem .35rem; border-radius: .25rem; overflow-wrap: anywhere; }
li { margin: .75rem 0; }
</style>
</head>
<body>
<main>
<h1>Balabol backend is running</h1>
<p>The conversation interface is the native iOS app. This browser page provides setup instructions; it is not a browser chat.</p>
<h2>Run on iOS Simulator</h2>
<ol>
<li>Keep the backend running in Terminal: use Node 24, then <code>pnpm build</code> and <code>pnpm start</code>.</li>
<li>Open <code>ios/Balabol.xcodeproj</code> in Xcode. Select the <strong>Balabol</strong> scheme and an iOS 17+ Simulator, then press Run.</li>
<li>In the app's <strong>Connect to Balabol</strong> screen, enter <code>http://127.0.0.1:8787</code> in the URL field and tap <strong>Connect</strong>.</li>
<li>Write in the <strong>Message</strong> field and tap <strong>Send</strong>. The current prototype saves text; replies and voice are not implemented yet.</li>
</ol>
<h2>Run on iPhone</h2>
<p>Choose your local signing team in Xcode and run the app on the device. Keep Tailscale connected on the Mac and iPhone. Start the backend with <code>BALABOL_HOST=&lt;Mac Tailscale IP&gt; pnpm start</code>, then enter <code>http://&lt;Mac Tailscale IP&gt;:8787</code> in the app and tap <strong>Connect</strong>.</p>
<p>The Terminal backend and native app are separate processes; both must stay running while you send messages. Custom ports must match the URL entered in the app.</p>
</main>
</body>
</html>`

export const welcomeRoutes = HttpRouter.add("GET", "/", HttpServerResponse.html(welcomePage))
