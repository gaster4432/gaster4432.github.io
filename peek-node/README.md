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

## Protocol (v4)

`GET /` returns `{ok:true, service:'peek-signal-node', protocol:4}`.
`GET /ice` returns the STUN list; there is no media relay.

The host creates its room with `POST /room/create?role=host&sid=<tab-id>`.
The server returns `{ok:true, code, negotiation:0, protocol:4}`. The host
posts an offer immediately, before a viewer arrives.

All other requests use `/room?code=<CODE>&role=host|joiner&sid=<tab-id>`.
A viewer also supplies `attempt=<join-id>` on polls and `attempt` in POST
bodies. Each click of Join creates a new attempt while retaining its tab ID.

| Call | Meaning |
|---|---|
| `POST {a:'join', attempt}` | claim the viewer seat; returns its negotiation number |
| `GET` (long-poll, ≤15s) | receive `{t:'messages', msgs, negotiation}` |
| `POST {a:'message', attempt, msg:{t:'offer'|'answer'|'ice', data, negotiation}}` | exchange current negotiation details |
| `POST {a:'ack', negotiation}` | host confirms receipt of the answer |
| `POST {a:'leave', attempt, negotiation}` | viewer releases the seat |
| `POST {a:'close'}` | owning host deletes the room |

The first viewer receives the pre-deposited offer. Retrying, reconnecting,
or replacing an expired viewer starts a new negotiation and sends `ready`
to the host for a fresh offer. Old answers and ICE are rejected. Offers
are retained until answered; answers are retained until acknowledged.
Both tabs keep polling while connected to preserve their seats and receive
leave/close notifications. Video still flows directly browser-to-browser.

## Updating and testing

**Deploy `server.js`, `mailbox.js`, and the updated `peek/index.html` together.**
The page checks protocol 4 and reports an update mismatch instead of trying
an incompatible handshake. Restart the Altare server after uploading both
server files, then publish the page and refresh both tabs. Do not change
or overwrite the existing TLS certificate/key during this update.

Run `npm test` in this folder for mailbox regressions. Test the actual page
with two browsers too: first join, visible moving video, same-tab Retry,
Leave then Join, an active session beyond 40 seconds, and host Stop.
Local Chromium tests do not prove Firefox/Steam Deck behavior or NAT
connectivity between different networks.

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

## Notes

- Rooms live in RAM. A restart clears them; hosts just re-share their codes.
- The room code is the only "auth" — it's 6 characters from a 32-letter
  alphabet (~1e9), unguessable enough for helping a friend, not for hostile
  environments.
- The old Cloudflare worker (`peek-worker/`) is retired; this replaces it.
