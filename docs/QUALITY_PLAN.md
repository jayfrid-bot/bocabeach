# Data-quality plan

## Why

Every recent bug had the same shape. The app published a wrong number. Nothing
checked it. The owner saw the mistake at the beach.

Example, 2026-10-13. One cam, `boca-inlet-surf`, read "moderate 35% seaweed" at
1:20 PM. It was looking at a dark rock shelf. The other cams said none.

This plan puts a check between every number and the beach.

## The loop

1. **Catch.** A live watchdog flags a number that looks wrong. A daily auditor
   reads the whole day and writes a note.
2. **Check.** A second opinion looks at the same evidence. It runs by itself.
3. **Confirm.** The owner taps Right or Wrong. The owner can also report what is
   really on the beach.
4. **Learn.** Every answer is a label. Labels feed a golden test set and a
   weekly scorecard.
5. **Prove.** A replay tool runs the reader against the golden set. A CI gate
   blocks any reader or scoring change that makes it worse.

## Phases

| Phase | What ships | Status |
|---|---|---|
| 1 | Watchdog, second opinion, owner alert, labels, report sheet, verdicts that bind to the exact claim, disputed cams, the exact judged frame | Built, awaiting review and deploy |
| 2 | Replay tool and golden-set CI gate | Not started |
| 3 | Daily auditor note, and scorecard grades for seaweed, clarity, surf and sand | Not started |

## Phase 1: what is built

### Catch

**Seaweed, in the cam reader** (`scripts/cam_seaweed.py`). The reader already
holds a sudden jump to moderate or high until something confirms it. That hold
is the catch.

**Everything else, in the hourly archive** (`lib/quality/`). After the archiver
writes a beach's hourly row, the watchdog compares it to the hour before. The
two rows must be at most two hours apart.

| Signal | A jump is |
|---|---|
| Score | a drop of 15 or more |
| Surf | a change of 2 ft or more (estimated surf; raw wave height if a row has no estimate) |
| Sand temperature | a change of 10 F or more |
| Water clarity | a drop of 15 points or more |

A jump does not alert if a real cause explains it. A cause explains a signal
only if the matrix allows it, and only if it pushed the number the way it moved.

| Cause | Explains | Only when |
|---|---|---|
| Rain | score, clarity, sand | `rain_now` went from 0 to 1. For sand, the jump is a cooling. |
| Lightning | score, clarity | `lightning_near` went from 0 to 1. |
| Caps | score | A cap was added. Numbers inside a cap text are ignored. |
| Wind | score, surf, clarity | The wind moved 5 mph or more, either way. |
| Buoy | surf, score | The new wave reading is a buoy reading. For a score drop, the factor that fell most is the waves. |
| Cloud | sand, score | Cloud cover moved 30 points or more. For sand, the sand moved the opposite way. For a score drop, the factor that fell most is the sky, and cloud rose. |

So a cap change cannot hide a clarity or sand anomaly. Rain cannot hide a surf
jump. A buoy cannot excuse a score drop that something else caused.

The cause of a score drop is its **largest decline**: the factor whose share of
the score fell most. A factor that improved never leads a drop. The rules are in
`lib/quality/jumps.ts`.

### Check

When the reader holds a seaweed jump, it asks a second provider to read the same
image:

- A claim from Gemini, Groq or OpenRouter goes to Clef.
- A claim from Clef goes to Gemini.
- If that provider is not set up, there is no second opinion.

Each second opinion is exactly one provider HTTP attempt. There is no retry and
no second Gemini model. A tick makes at most six attempts. Clef also has its own
cap of 600 calls per UTC day.

If the second reader also says moderate or high, the reader confirms the jump
at once. The reading carries `confirmedBy: "second-opinion:<provider>"`.

If the second reader disagrees, three things happen. The jump stays held. The
cam becomes **disputed** for the rest of the beach-local day (see below). The
reader sends an alert to the app. If the second reader fails or calls the frame
unreadable, nothing changes.

**A failed alert is not lost.** The reader keeps it in `pendingAlerts` in the
feed file and retries it every tick until the app answers 2xx. It drops the
alert after 24 hours, or at once on a permanent refusal (400, 404, 413, 422). The
queued copy has no picture, so the feed file stays small.

### Disputed cams

A cam is disputed for the rest of its beach-local day when:

- the owner taps Wrong on one of its claims and the answer is none, low, or no
  value; or
- a second opinion disagrees with its claim.

The state is in the feed: `disputedCams`, same day only. While a cam is disputed,
its new moderate-or-high claims are held. They confirm only by one of these:

1. a second opinion that agrees;
2. a fresh other cam, itself not disputed, that claims moderate or high in the
   same tick;
3. an owner Right;
4. the same cam claiming moderate or high on at least 3 distinct frames over at
   least 90 minutes. A real bloom on a one-cam beach still publishes.

Plain two-frame persistence does not confirm a disputed cam. A disputed cam never
confirms another cam. A held claim on a disputed cam still alerts the owner,
inside the push limits. A fresh read of the cam below moderate restarts the frame
count. Any confirmation ends the dispute.

### Confirm

An alert reaches the owner in two ways: a push, and the review list.

**Alert rules.** The reader's POST uses its own secret, `QUALITY_INGEST_TOKEN`.
One beach may create at most 20 alerts per hour. D1 enforces that inside the
insert.

**Push rules.** D1 enforces them too. An alert that may push takes a push slot in
one atomic insert (`lib/quality/pushSlots.ts`).

- Only for watched beaches: the beaches with vision cams, plus `boca-raton`.
- Never between 9 PM and 7 AM, New York time.
- Not again for the same beach and signal within 3 hours of the last push.
- At most 3 pushes per day, counted from midnight New York time.

An alert that fails a rule is still stored. It shows in the review list. It does
not push. A push that fails gives its slot back.

**The archive only records.** The hourly archive request writes the alert and
takes the push slot. It never talks to APNs. The drain step sends the push:
`workers/history-cron` calls `POST /api/quality/drain` every minute, after its
archive pass. The drain sends at most 3 pushes per tick. Each APNs call is cut off
after 5 seconds. It drops a queued push that is more than 30 minutes old, and it
never sends in quiet hours.

**Subrequest budget.** The archive request keeps its 44-fetch build budget, plus
at most 2 for the cam feed, and no APNs. The drain is its own request. It makes
at most 3 pushes times 3 owner phones, so at most 9 APNs fetches, plus a few D1
statements.

**Push text.** Short and plain. Example: "Check: Boca Inlet cam says moderate
seaweed (35%). Other cams: none." A tap opens `/admin/review?alert=<id>`.

**Where the push goes.** Only to the push token stored on the owner session
(below). The push code never reads the general devices table or the general push
registration. Another person's registration can neither receive these alerts nor
redirect them.

**Review screen** (`/admin/review`). One card per open alert. It shows the
frame, one sentence to judge, what the app showed, the second reading, and the
other cams. Two big buttons: Right and Wrong. Wrong opens a one-tap picker for the
correct value. Seaweed: none, low, moderate, high. Clarity: clear, slightly
murky, murky. Surf, sand and score: a number. A second tap on the same alert
replaces the first answer.

**The saved frame.** The reader sends the exact image it judged with the alert,
shrunk to 150 KB or less. The app keeps it in the cam-frames R2 bucket under
`quality/<beach>/<cam>/<date>/<time>-<hash>.jpg`. The review screen labels it
"the exact frame". If no image came, or it could not be stored, the screen falls
back to the archived frame with the same hash, then to the nearest archived frame
of that cam. The label keeps the key.

### What an answer does

An alert names one **exact claim**: the cam, the frame (its hash for a feed cam,
else its time), when the reader scored it, and the beach-local date. An answer
binds to that claim. It never acts on "the cam" in general, on a different frame,
or on a reading that merely came before the tap.

| Answer | What it does to that claim |
|---|---|
| Right | Publish it at its level. Mark its pending claim confirmed (`confirmedBy: "owner"`). |
| Wrong, really moderate or high | Publish it at the corrected level, the same way. |
| Wrong, really none or low, or no value | Reject it: remove its pending claim and publish nothing for that frame. Dispute the cam for the rest of the day. |

The answer acts live only when the claim was made on **today's** beach-local
date and the alert has not expired. An answer to an older alert stores the label
and nothing else. The review screen says so.

Of several answers about one exact claim, the **latest wins**. The app and the
reader apply the same rule. Both are tested against one shared vector file,
`lib/quality/verdictVectors.json`.

**One atomic step.** The label, the alert status and the override are written in
one D1 batch. If any part fails, none of it sticks. Unique indexes allow one
active label and one active override per alert. A second tap supersedes the
first: the old rows stay as history. Two taps at once leave one active answer.

### The beach card after an answer

The conditions cache key includes a fingerprint of the answers in force
(`lib/quality/overrides.ts`). When the owner answers, the next request builds a
fresh snapshot. It does not wait for the 120-second cache.

What can still hold the old card is the page's own refresh, every 5 minutes,
and, if a network cache keeps the public conditions answer, its
`s-maxage=300, stale-while-revalidate=600`. So the review screen says: "The beach
card updates on its next refresh, within 5 minutes. A copy held by the network
can take up to 15." The numbers are in `lib/quality/client.ts`, and a test fails
if the code they describe changes.

There is no purge helper in the codebase and no tag cache behind the cache
(`open-next.config.ts`), so the edge copy cannot be purged.

**Report conditions** (`/admin/report`). For the owner on the beach. Big taps
for seaweed and water clarity. Optional surf height, sand temperature and note.
Each answer saves as a label with the nearest saved frames of that beach. The
beach page shows a quiet "Report conditions" link, but only on a phone that has
already opened the review screen as the owner.

### Learn

Every answer and every report is a row in `quality_labels`. The row holds what
the app published, what was claimed, the truth when the owner gave it, and the
saved frame. Phases 2 and 3 read these rows.

## Owner setup

### Secrets and settings

| Name | Where | What it is |
|---|---|---|
| `OWNER_ENROLL_CODE` | Worker secret | The one-time code a phone uses to become the owner. At least 16 characters. |
| `QUALITY_INGEST_TOKEN` | Worker secret **and** GitHub Actions secret | The reader's credential for `/api/quality/alerts` and `/api/quality/overrides`. It is separate from `INGEST_TOKEN`. |
| `CRON_SECRET` | already set | Also guards `/api/quality/drain`. |
| `INGEST_TOKEN`, `CAM_FRAME_URL_KEY`, APNs keys | already set | Unchanged. |

`OWNER_DEVICE_IDS` is gone. A device id proves nothing here.

Set them:

```
wrangler secret put OWNER_ENROLL_CODE
wrangler secret put QUALITY_INGEST_TOKEN
gh secret set QUALITY_INGEST_TOKEN
```

Use a long random value for each. The same `QUALITY_INGEST_TOKEN` value goes in
both places. The workflow `sargassum.yml` passes it to the reader.

### Enroll the owner's phone

1. Apply the migration: `wrangler d1 migrations apply isitbeachday-plus --remote`
   (migration `0019_quality_loop.sql`).
2. Deploy the app and `workers/history-cron`.
3. On the owner's iPhone, open
   `https://app.isitbeachday.com/admin/review#enroll=<OWNER_ENROLL_CODE>`.
   Use the `#` form. Browsers never send a `#` part to a server. The page reads
   the code, removes it from the address bar, and sends it in a request body. The
   server never logs it. A `?enroll=<code>` link also works, but the server sees
   that one in its request URL.
4. The server makes an owner session. It returns a random 32-byte token once. The
   phone keeps it. The server keeps only its SHA-256, in `owner_sessions`.
5. Turn on alerts for any beach in the app once. The review screen then sends the
   phone's push token to `POST /api/quality/owner/push-token`, which stores it on
   the owner session. Owner pushes go only there.

Enrollment is rate limited: 5 tries per hour per address, 20 per hour in all.

### Rotate or revoke

- **Change the code:** `wrangler secret put OWNER_ENROLL_CODE`. The old code
  cannot enroll anyone new. Sessions already made keep working.
- **Revoke a phone, or every phone:**
  `wrangler d1 execute isitbeachday-plus --remote --command "UPDATE owner_sessions SET revoked = 1"`
  (add `WHERE id = <n>` for one). A revoked session cannot call any owner route
  and receives no push.

### How the owner gate works

Every owner route needs `Authorization: Bearer <owner token>`. The route checks
the token before it reads any body. It then reads the body with a streaming size
cap of 8 KB. The token is not accepted from a body or a URL. Every owner answer,
and every `/admin/*` page, forbids framing with `Content-Security-Policy:
frame-ancestors 'none'` and `X-Frame-Options: DENY`. With no `OWNER_ENROLL_CODE`
set, nobody can enroll.

## Working rules

### A new signal needs five answers

Before any new number goes to the beach, write down:

1. **What is the truth source?** Something the app can compare against: a buoy,
   a flag, a cam, the owner.
2. **What fools it in low light and at night?** Say how the signal knows it
   should stay quiet.
3. **What confirms a jump?** One reading is not enough. Name the second look.
4. **When does it expire?** A reading must not outlive the frame it came from.
5. **What does the card say when it does not know?** Never a stale number. Say
   "unknown" in plain words.

### Every incident leaves two things

- A **regression test** that uses the real data from the incident.
- A **monitor** that would have fired.

If one is missing, the incident is not closed.

## Incident log

| Date | What went wrong | Regression test | Monitor |
|---|---|---|---|
| 2026-10-13 | `boca-inlet-surf` read a dark rock shelf as "moderate 35%" seaweed | `JumpConfirmationTests`, `SecondOpinionTests` and `DisputedCamTests` in `scripts/cam_seaweed_test.py` replay it, including the frame that follows a disagreement | Second opinion on a held jump, a disputed cam, then an owner alert; the hourly watchdog for the score it would have moved |

## Known limits of phase 1

- An answer covers seaweed only. Wrong on any other signal stores the label only.
- A dispute and an answer's live effect end with the beach-local day. A cam that
  keeps reading a false moderate tomorrow is held again, and will alert again.
- A disputed cam on a one-cam beach publishes a real bloom only after 3 distinct
  frames over 90 minutes, unless the owner taps Right sooner.
- Archived frames and quality frames share one R2 bucket and its lifecycle rule.
  `wrangler.jsonc` says the rule deletes objects after 367 days. If that rule was
  written with a prefix filter, `quality/` is not covered: add a rule for it. If
  the rule covers the whole bucket, a quality frame expires after a year, and the
  label that names it keeps a dead key. Copy the frames behind golden-set labels
  out of R2 in phase 2.
- `scripts/cam_archive_remove.ts` erases a cam's `quality/` frames along with its
  archive frames when it can list R2. Without R2 listing credentials it cannot
  see them, and the script already refuses a real delete in that case.
- A queued push that the drain cannot send (no owner phone enrolled, a failed
  send, quiet hours, or older than 30 minutes) is not retried. The alert stays in
  the review list.

## Separate hardening item (not in this change)

`POST /api/push/register-native` accepts a device id without its install token
and can overwrite that device's push token. The owner push path no longer depends
on it, so this change leaves it alone. It is still a real gap for every other
alert. Fix it separately: require the install token to change the token of a
device that has one on file.
