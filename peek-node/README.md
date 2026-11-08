# peek-signal-node

The signaling mailbox for [Peek](../peek/) — screen sharing with a code.

Zero dependencies. Node 18+. Two files: `mailbox.js` (room logic) and
`server.js` (HTTP/HTTPS plumbing + CORS).

## Run it

```sh
node server.js                 # plain HTTP on 0.0.0.0:25789
```

TLS turns on automatically as soon as `key.pem` + `fullchain.pem` (or
`cert.pem`) sit next to `server.js` or in the working directory — no env
vars needed. `TLS_KEY` / `TLS_CERT` override the search.

## Deploying on the Altare Node egg

The egg runs `node /home/container/${MAIN_FILE}` and auto-runs `npm install`
when a `package.json` sits at the container root. Zero dependencies, so that
step is instant either way:

- **Layout A** — upload the *contents* of this folder to the container root:
  `package.json` and `server.js` at `/home/container/`, set
  **MAIN_FILE = `server.js`**.
- **Layout B** — upload this folder as a subfolder and set
  **MAIN_FILE = `peek-node/server.js`** (nothing lands at the root, so the
  egg's `npm install` step is skipped — fine, there's nothing to install).

Install the cert to the container root and the egg just works:

```sh
~/.acme.sh/acme.sh --install-cert -d peek-signal.duckdns.org \
  --key-file /home/container/key.pem \
  --fullchain-file /home/container/fullchain.pem
```

acme.sh's cron renews and rewrites those files; **restart the server from
the panel** after a renewal to load the new cert.

## Protocol (for the curious)

Everything is `/room?code=<CODE>&role=host|joiner&sid=<random>`. The WebRTC
docs leave the signaling transport unspecified — this mailbox mirrors the
codelab's room lifecycle (created / joined / ready / full) with a per-role
inbox:

| Call | Meaning |
|---|---|
| `POST {a:'create'}` | host claims the code |
| `GET` (long-poll, ≤15s) | drain your inbox; parks until a message arrives |
| `POST {a:'message', msg:{t:'offer', data}}` | host posts its SDP offer (only the host may) |
| `POST {a:'message', msg:{t:'answer', data}}` | joiner posts its SDP answer (only the joiner may) |
| `POST {a:'message', msg:{t:'ice', data}}` | trickle an ICE candidate to the other peer |
| `POST {a:'message', msg:{t:'bye'}}` | hang up |
| `POST {a:'close'}` | host frees the code |

A fresh joiner registering clears any stale offer and pushes `ready` to the
host, which responds with a fresh offer — the codelab's `ready` → re-offer
flow. `GET /ice` returns the STUN/TURN list. `GET /` is a health check.

## HTTPS on a single non-standard port

The Peek page is served from `https://gaster4432.github.io`, so the browser
refuses to talk to a plain-HTTP API (mixed content). The container only has
port 25789 — no 80, no 443 — which knocks out Let's Encrypt's HTTP-01 and
TLS-ALPN-01 challenges. **DNS-01 is the only one left, and DuckDNS makes it
free:**

1. Create a subdomain at [duckdns.org](https://www.duckdns.org) (say,
   `peek-signal`), and point its IP at the container's public IP.
2. Install [acme.sh](https://github.com/acmesh-official/acme.sh) on the
   container and issue a cert using the DuckDNS DNS challenge — no ports
   involved:

   ```sh
   curl https://get.acme.sh | sh -s email=you@example.com
   export DuckDNS_Token=<your duckdns token>
   ~/.acme.sh/acme.sh --issue --dns dns_duckdns -d peek-signal.duckdns.org
   ~/.acme.sh/acme.sh --install-cert -d peek-signal.duckdns.org \
     --key-file ./key.pem --fullchain-file ./fullchain.pem
   ```

   acme.sh installs its own cron job, so renewals re-write those two files
   automatically — restart the server after a renewal (or point the env vars
   at acme.sh's live directory and skip the copy).

3. Start the server with `TLS_KEY` / `TLS_CERT` set.
4. Make sure `SIGNAL` at the top of [`peek/index.html`](../peek/index.html)
   matches your subdomain, and that the browser can reach
   `https://peek-signal.duckdns.org:25789/` (firewall/port-forward on the
   host, if any).

## TURN — when the direct P2P path fails

STUN punches through most home routers, but **symmetric NAT / CGNAT defeats
it** (common on rural US ISPs). Symptom: signaling succeeds, then the badge
says *connection failed*. The fix is a TURN relay — media only uses it when
the direct path fails, so it costs nothing on healthy links.

1. Get TURN credentials — [Cloudflare Calls TURN](https://developers.cloudflare.com/calls/turn/)
   (~1 TB/month free) or [metered.ca](https://www.metered.ca/tools/openrelay/)
   (free tier). You end up with a set of `turn:`/`turns:` URLs, a username
   and a secret.
2. Prefix the start command with the three variables:

   ```sh
   TURN_URLS="turn:host:3478?transport=udp,turn:host:3478?transport=tcp,turns:host:443?transport=tcp" \
   TURN_USERNAME="your-user" \
   TURN_CREDENTIAL="your-secret" \
   /usr/local/bin/node /home/container/server.js
   ```

3. Restart. `GET /ice` now hands the browsers the relay alongside STUN, and
   the viewer's badge shows `relayed` whenever the connection took that path.

## Notes

- Rooms live in RAM. A restart clears them; hosts just re-share their codes.
- The room code is the only "auth" — it's 6 characters from a 32-letter
  alphabet (~1e9), unguessable enough for helping a friend, not for hostile
  environments.
- The old Cloudflare worker (`peek-worker/`) is retired; this replaces it.
