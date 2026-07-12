# Phone Access via Tailscale Serve

Reach this app from your phone (or any device on your Tailscale network) while keeping it bound to localhost — no exposure to the LAN or internet, no app-level authentication needed.

---

## The problem

This app binds to `127.0.0.1` (localhost) by design. That's correct — it provides no login/auth system, so localhost binding is the only access control. Today, nothing on the LAN or internet can reach it. That should stay true.

---

## The solution: Tailscale Serve

**Tailscale Serve** proxies a local port over your Tailscale network (tailnet) with automatic HTTPS, without changing what the app binds to.

- The app stays bound to `127.0.0.1` — no changes needed.
- Tailscale Serve runs on the same machine and makes the app reachable from any device on your tailnet (phone, laptop, etc.) that has the Tailscale app installed.
- Only authorized tailnet devices can reach it — the open internet and open LAN cannot.

---

## How to set it up

**1. Run the app persistently** (required)

This is the blocker: the app currently only runs via `npm run dev`/`npm start` when you start it manually. For `tailscale serve` to be useful day-to-day, the app needs to run persistently (systemd service, PM2, Docker container, etc.) on an always-on machine. **This is a separate deployment decision outside this note — plan it before you try Tailscale Serve.**

**2. Start Tailscale Serve** (once the app is running)

```bash
tailscale serve --bg http://127.0.0.1:3000
```

Replace `3000` with whichever port your app is actually on.

**3. Access from your phone**

Open the Tailscale app on your phone, make sure you're signed into the same tailnet, then navigate to:

```
https://<machine-name>.<tailnet-name>.ts.net
```

Example: `https://homepage.example-corp.ts.net`

Tailscale assigns the machine name and tailnet domain — you can check them in the Tailscale admin console or by running `tailscale status` on the machine.

---

## Checking status and stopping

```bash
# See what's being served
tailscale serve status

# Stop serving
tailscale serve --https=443 off
```

---

## Security reminder

Never run a command that would ALSO bind the app itself to a non-localhost address. The whole point is that the app keeps binding to `127.0.0.1` and Tailscale Serve does the tailnet exposure. Don't bridge that separation — it would remove the access control.
