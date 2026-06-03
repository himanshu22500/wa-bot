# wa-bot

> Scheduled WhatsApp greetings, sent automatically from a serverless-ish AWS setup that costs **≈ $0.90/month**.

A small automation that sends WhatsApp messages on a daily schedule (e.g. *good morning / afternoon / evening*) using [`whatsapp-web.js`](https://wwebjs.dev/). The interesting part isn't the messaging — it's the **cost-optimised AWS architecture**: instead of paying for a server that runs 24/7, the EC2 instance is **stopped 99% of the time** and woken only for the ~30 seconds each send actually takes.

---

## Why this exists

A naive deployment leaves a `t3a.micro` running around the clock (~$11.30/mo) to do ~90 seconds of work a day. This project instead treats compute as ephemeral: an external scheduler **starts** the box just before each send, the box **does its job and shuts itself down**, and you pay only for the minutes it's awake.

| | Always-on | This project |
|---|---|---|
| Instance uptime | 730 hrs/mo | ~7.5 hrs/mo |
| **Monthly cost** | ~$11.30 | **≈ $0.90** |

Everything that makes it cheap (the scheduler, alerting, permissions) sits inside AWS's always-free tiers, so the bill is essentially just the EBS disk.

## Architecture

```
                         ┌──────────────────────────┐
   EventBridge Scheduler │  cron(57 7,12,18 IST)     │
   (starts the instance) └────────────┬─────────────┘
                                       │ ec2:StartInstances
                                       ▼
                         ┌──────────────────────────┐
                         │  EC2 (normally STOPPED)   │
                         │  on boot:                 │
                         │   1. systemd oneshot runs │
                         │   2. pick greeting by hour │
                         │   3. send via WhatsApp Web │
                         │   4. shutdown -h (self-stop)│
                         └───────┬───────────────┬───┘
                       on failure│               │ always
                                 ▼               ▼
                          SNS → email       instance STOPS
                          (alert)           (billing pauses)
```

- **Trigger lives outside the instance.** Because the box is off, cron-on-the-box can't fire it — [Amazon EventBridge Scheduler](https://docs.aws.amazon.com/scheduler/) starts it on a timezone-aware cron.
- **The instance is self-terminating.** A `systemd` oneshot service runs [`boot-send.sh`](./boot-send.sh) on boot, which sends the right greeting for the current hour and then `shutdown`s (instance-initiated shutdown is set to *stop*, not *terminate*).
- **Failures page you.** A non-zero send exits to an SNS topic → email.
- **Guards for safety:** outside the scheduled hours the script assumes a *manual/maintenance* boot and stays up without sending; a `DRY_RUN` marker exercises the whole path without messaging anyone.

## Tech stack

`Node.js` · `whatsapp-web.js` (Puppeteer/Chromium) · `AWS EC2` · `EventBridge Scheduler` · `SNS` · `IAM` · `systemd` · `bash`

## Repo layout

| File | Purpose |
|---|---|
| `send.js` | Connects to WhatsApp Web, sends to recipients from `config.json`. Supports `--message`, `--login`, `--dry-run`. |
| `boot-send.sh` | Boot entrypoint: pick greeting → send → alert-on-failure → self-stop. |
| `wa-bot-boot.service` | systemd unit that runs `boot-send.sh` on boot. |
| `config.example.json` | Template for recipients/message (copy to `config.json`, which is gitignored). |
| `.env.example` | Template for host-local settings (region, SNS ARN). |

> **Not in this repo (by design):** the WhatsApp session (`.wwebjs_auth/` — that's account credentials), real recipient numbers (`config.json`), and account-specific ARNs (`.env`). See [Security](#security).

## Local quickstart

```bash
npm install
cp config.example.json config.json    # edit recipients + message
npm run login                          # scan the QR once; session saved to .wwebjs_auth/
npm run send                           # send to everyone in config.json
```

`send.js` flags:
- `--login` — authenticate only (scan QR), don't send.
- `--message "text"` — override the message for this run.
- `--dry-run` (or `WA_DRY_RUN=1`) — connect and log *"would send"* without messaging.

## Deploying the start/stop architecture (sketch)

1. Launch an **x86_64** instance (see [Gotchas](#gotchas)) and install Node + Chromium's shared libs.
2. Copy the project over, `npm install`, `npm run login` once (the session persists on the EBS disk).
3. Create `.env` from `.env.example` with your region + SNS topic ARN.
4. Install & enable `wa-bot-boot.service`; set instance-initiated-shutdown-behavior to **stop**.
5. Create an EventBridge Scheduler schedule that calls `ec2:StartInstances` on your cron (timezone-aware), with an IAM role allowing just that action.
6. (Optional) An SNS topic + email subscription for failure alerts; give the instance an IAM role with `sns:Publish`.

## Security

- **The WhatsApp session is a credential.** `.wwebjs_auth/` is fully gitignored — committing it would let anyone message as you.
- **No secrets or PII in the repo.** Recipient numbers live in `config.json` (ignored); account IDs/ARNs live in `.env` (ignored). Only templates with placeholders are committed.
- **Least-privilege IAM.** The scheduler role can only `StartInstances` on this one instance; the instance role can only `Publish` to the alert topic.

## Gotchas (lessons learned)

- **Puppeteer's bundled Chrome isn't published for ARM64 Linux.** A Graviton (`t4g`) instance fails with a broken Chrome stub, and the snap Chromium workaround drags in a huge desktop runtime that fills a small disk. Use **x86_64** so Puppeteer's bundled Chrome just works.
- **Automating WhatsApp Web is against WhatsApp's ToS.** Fine for low-volume personal use to people who expect your messages; not for bulk/marketing. Use responsibly.
- **macOS/laptop schedulers are unreliable** for fixed-time jobs (sleep skips them) — hence moving to always-available cloud compute.

## Roadmap

- [ ] Move runtime config (recipients, messages) to **SSM Parameter Store** so changes need no SSH.
- [ ] `git pull`-on-boot so deploys are just `git push`.
- [ ] GitHub Actions CI: syntax-check + config validation.
- [ ] Infrastructure-as-Code (Terraform) for the instance, schedule, IAM, SNS.
- [ ] Richer messages (templates, media, multiple recipients/timezones).

## License

MIT
