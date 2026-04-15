# MrQ Team Matrix

Internal tool for Product + Engineering. Lets the team capture each person's
16Personalities type and browse two views:

1. **Matrix** — interactive editor + coloured grid visualisation (with filters
   by team / tribe / squad, spectrum scales, profile cards, etc.).
2. **Cheat Sheet** — a shareable single-page summary per team / tribe / squad,
   with a "team diagnosis", ordered profile cards, and spectrum bars. Built
   from the same data, updates live.

Sits **behind MrQ's existing auth proxy** (Cloudflare Access / IAP). The app
itself has no login screen — every request that reaches it is assumed to be
an authorised MrQ user.

---

## Local dev

```bash
cd matrix-app
npm install
npm start
# → http://localhost:8080
```

Data is written to `./data/members.json`. Delete that file to re-seed the
12 starter members (current Product + Engineering roster).

Useful environment variables:

| Var        | Default          | Purpose                                     |
|------------|------------------|---------------------------------------------|
| `PORT`     | `8080`           | HTTP port                                   |
| `DATA_DIR` | `./data`         | Where `members.json` lives (persistent vol) |

---

## Deploy to Railway

The repo is already Dockerfile-ready. Flow:

1. **New project → Deploy from GitHub repo** → point at this folder.
2. Railway picks up `railway.json` and builds from `Dockerfile`.
3. **Add a Volume** on the service, mount it at `/data`. This is where
   `members.json` lives, so the roster survives redeploys.
4. Health check is at `/api/health` (already wired in `railway.json`).
5. Attach the service to your existing auth proxy (same pattern as the rest
   of the MrQ internal tools) and give it an internal subdomain, e.g.
   `matrix.mrq.internal`.

No secrets, no DB, no outbound calls — just the Node process and a JSON file.

---

## Sharing a filtered view

The cheat sheet reads filters from the URL, so any filtered view is
shareable just by copying the address bar. There's also a **Copy share link**
button in the header that does it for you.

Examples:

```
/?view=cheatsheet&team=Product
/?view=cheatsheet&team=Engineering
/?view=matrix&team=Product
```

Drop the link into Slack — the proxy auth handles the rest.

---

## API

All JSON, no auth headers (proxy does that).

| Method | Path                  | Purpose                        |
|--------|-----------------------|--------------------------------|
| GET    | `/api/health`         | Liveness                       |
| GET    | `/api/members`        | List everyone                  |
| POST   | `/api/members`        | Add one                        |
| PUT    | `/api/members/:id`    | Update one (partial allowed)   |
| DELETE | `/api/members/:id`    | Remove one                     |
| POST   | `/api/members/bulk`   | Replace the whole roster       |

Member shape:

```json
{
  "id": 1,
  "name": "Kate",
  "typeCode": "ENFJ",
  "identity": "T",
  "pcts": { "EI": 18, "SN": 70, "TF": 61, "JP": 46, "AT": 85 },
  "team":  "Product",
  "tribe": "",
  "squad": ""
}
```

`pcts` are the five 16Personalities sliders (0–100). `identity` is `A` (Assertive)
or `T` (Turbulent) — auto-derived from `AT` on create if omitted.

---

## Storage

JSON file at `${DATA_DIR}/members.json`. Atomic writes (`.tmp` + rename),
coalesced flushes. Good for a few hundred people. If you ever outgrow it,
swap the `load/save` functions in `server.js` for a Postgres client — the
REST layer doesn't need to change.

---

## Files

```
matrix-app/
├── Dockerfile
├── .dockerignore
├── railway.json
├── package.json
├── server.js          # Express + JSON-file store
└── public/
    └── index.html     # Full interactive tool + cheat sheet view
```
