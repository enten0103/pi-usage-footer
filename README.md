# usage-footer — pi extension

Shows the **active provider's** quota/balance inline in the footer stats line (same line as
token/context stats). Only appears while a supported model is selected; otherwise the default footer
is restored.

```
↑1.2k ↓567 $0.004 (sub) 42.5%/262k · Kimi 5h 0% · 7d 99%        (kimi-coding) k3 • high
↑1.2k ↓567 $0.012 42.5%/262k · DeepSeek ¥110.00                 (deepseek) deepseek-v4-flash
```

| Provider (`model.provider`) | Source | Displayed |
| --- | --- | --- |
| `kimi-coding` | `GET api.kimi.com/coding/v1/usages` | `Kimi 5h <used%> · 7d <used%>` (warning ≥ 75%, error ≥ 90%) |
| `deepseek` | `GET api.deepseek.com/user/balance` | `DeepSeek ¥<total>` (error if unavailable / ≤ 0) |

## Refresh policy

- Every **2 minutes** while a supported model is active.
- Immediately on **model change** and **session start**.
- Once the agent **settles** (`agent_settled`), i.e. at the end of each conversation after retries,
  compaction, and queued follow-ups.

## Install

```bash
ln -sfn "$PWD/integrations/pi/usage-footer.ts" ~/.pi/agent/extensions/usage-footer.ts
```

Then in pi: `/reload` (or restart), and select a supported model.

## Command

`/usage` — refresh now and show details:

```
Kimi 5h: 0% used (100/100 left) · resets in 3h 36m
Kimi 7d: 99% used (1/100 left) · resets in 2d 19h
```

```
DeepSeek balance: ¥110.00 (granted ¥10.00 · topped up ¥100.00)
```

## How it works

- Credentials come from pi's own logins. The extension calls
  `ctx.modelRegistry.getProviderAuth(<provider>)`, which resolves API keys / refreshes OAuth tokens
  under pi's credential lock. It never reads or writes `auth.json`.
- `ctx.ui.setStatus()` always renders extension statuses on their own footer line, so the extension
  replaces the footer via `ctx.ui.setFooter()` while a supported model is active and re-renders the
  built-in layout (cwd line, token/cost/context stats, model name, other extensions' statuses) with
  the usage segment appended to the stats line. On unsupported models it restores the default footer.
- Network timeout is 15s; failures render as `<Provider> <message>` in warning color and clear on the
  next successful poll.
- The poller is started in `session_start`/`model_select` and cleared in `session_shutdown`.

## Adding a provider

Add a `ProviderSpec` entry in `PROVIDERS` (id, label, `matches`, `load`). `load` resolves auth via
`ctx.modelRegistry.getProviderAuth`, fetches, and returns `{ text, color, detail? }`.
