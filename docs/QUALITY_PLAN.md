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

**The order of one tick.** For one beach, the reader works in three steps:

1. Local confirmation. A cam confirms on its own history (persistence, or the
   long rule for a disputed cam).
2. Second opinions, for every read that is still held. This finds which cams
   just became disputed.
3. Confirmation across cams, using the state that step 2 left.

So a cam whose second reader just disagreed cannot confirm another cam. Two cams
that both claim a bloom still confirm each other. A cam whose own second reader
just disagreed needs a backer that is already published, not one that is still
held. The cost: two cams that claim the same bloom now both use a second opinion
(it was none before). The cap of six attempts per tick still holds.

**A failed alert is not lost.** The reader keeps it in `pendingAlerts` in the
feed file and retries it every tick until the app answers 2xx. This includes an
alert it could not send because `QUALITY_INGEST_TOKEN` was unset. It drops the
alert after 24 hours, or at once on a permanent refusal (400, 404, 413, 422). The
queued copy has no picture, so the feed file stays small.

**A missing feed file never resets a beach.** The reader reads each beach's last
published file at the start of a tick. A true HTTP 404 means a new beach: it
starts empty. Any other failure (a network error, a 5xx, a body that does not
parse) is retried once. If it still fails, the reader stops the whole tick. It
writes nothing, still runs the webcam archive, and exits with an error. The
publish step replaces the whole branch with the files written in that cycle, so a
single beach cannot be skipped. The branch keeps the last good files. Starting a
beach from empty would erase its held claims, disputes and outbox. Five failed
cycles in a row end the loop, so a long outage shows as a red run.

### Disputed cams

A cam is disputed for the rest of its beach-local day when:

- the owner taps Wrong on one of its claims and the answer is none, low, or no
  value; or
- a second opinion disagrees with its claim.

The state is in the feed: `disputedCams`, same day only. While a cam is disputed,
its new moderate-or-high claims are held. They confirm only by one of these:

1. a second opinion that agrees;
2. a fresh other cam, itself not disputed, that claims moderate or high in the
   same tick (checked after the second opinions: see "The order of one tick");
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

**The alert and its slot are one step.** The alert insert and the slot
reservation run in one D1 batch. An alert never exists without its slot decision.
A slot is taken only for an alert that is still open and less than 30 minutes old.
A retry that finds the alert stored without a slot takes the missing slot, if the
alert is still open, still fresh, and the rules still allow it.

**The archive only records.** The hourly archive request writes the alert and
takes the push slot. It never talks to APNs. The drain step sends the push:
`workers/history-cron` calls `POST /api/quality/drain` every minute, after its
archive pass. The drain sends at most 3 pushes per tick. Each APNs call is cut off
after 5 seconds. It drops a queued push that is more than 30 minutes old, and it
never sends in quiet hours. It sends only for alerts that are still open.

**A push is sent at most once.** The drain claims a push before it calls APNs. A
slot moves through these states:

| State | Meaning |
|---|---|
| `queued` | Reserved. Waiting for the drain. |
| `attempting` | A drain claimed it with one conditional update that sets a fresh attempt id. Only that attempt id can finish or release it. |
| `sent` | APNs accepted it. The alert is marked pushed. |
| `unknown` | An attempt that was never finished for 10 minutes (the process died, or D1 failed after APNs said yes). It is **not** sent again, because the first send may have reached the phone. The review list says so. |

A send gives its slot back (the row is deleted) only on a **definitive** refusal:
Apple answered with an HTTP status (a 4xx or 5xx). A send with no answer (a
network error, or the 5-second timeout) may have been delivered, so it stays
`attempting` and becomes `unknown`; it is never released or re-sent. If the push
went to several phones, one acceptance counts as sent. A failure while clearing a
dead token never undoes a send that already went out. Only the attempt that holds
the slot can release it. Two drains that overlap cannot send the same push:
the one that loses the claim changes nothing. The daily purge deletes `sent` and
`unknown` slot rows older than 30 days.

**Subrequest budget.** The archive request keeps its 44-fetch build budget, plus
at most 2 for the cam feed, and no APNs. The drain is its own request. It makes
at most 3 pushes times 3 owner phones, so at most 9 APNs fetches, plus a few D1
statements.

**Push text.** Short and plain. Example: "Check: Boca Inlet cam says moderate
seaweed (35%). Other cams: none." A tap opens `/admin/review?alert=<id>`.

**Where the push goes.** Only to the push token stored on the owner session
(below). The push code never reads the general devices table or the general push
registration. Another person's registration can neither receive these alerts nor
redirect them. The database keeps this clean:

- A device has one active owner session. Enrolling again from the same device
  revokes the old session.
- A push token belongs to one active session. Setting it on a session takes it
  from any other, in one batch, and only while the requesting session is still
  active. A request whose session was revoked while it waited (the phone enrolled
  again) changes nothing and gets a 401, so it cannot strip the new session's token.
- The owner screens ask the native push plugin for a fresh token each visit. They
  never reuse a token an earlier beach registration saved on the phone.
- A token that Apple calls dead is cleared only if the session still holds that
  exact token. A late answer cannot erase a token the phone just refreshed.
- A send goes to each distinct token once.

**Review screen** (`/admin/review`). One card per open alert. Open alerts are
queried on their own, so a run of newer answered alerts can never push an open
one out of the list. A card says when its push may not have arrived (`unknown`). It shows the
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

An alert names one **exact claim**, and its dedupe key is that claim: beach, cam,
the frame (hash, else time) and the normalized `claimedAt`. A retry of the same
claim stores nothing new. The same image scored again later is a new claim and gets
its own alert (and its own outbox entry in the reader). Otherwise the reader's
second POST would be answered "already stored" by the first claim's alert, and the
current claim could never be answered. An alert names one **exact claim**: the cam, the frame (its hash for a feed cam,
else its time), and when the reader scored it (`claimedAt`). All three are
required. The app refuses an alert that lacks them, or whose hash is not a prefix
of the image's SHA-256, or whose time is not the alert's own. An answer binds to
that claim. It never acts on "the cam" in general, on a different frame,
or on a reading that merely came before the tap.

| Answer | What it does to that claim |
|---|---|
| Right | Publish it at its level. Mark its pending claim confirmed (`confirmedBy: "owner"`). |
| Wrong, really moderate or high | Publish it at the corrected level, the same way. |
| Wrong, really none or low, or no value | Reject it: remove its pending claim and publish nothing for that frame. Dispute the cam for the rest of the day. |

The answer acts live only when the claim was scored on **today's** beach-local
date and the alert has not expired. The date is the date of `claimedAt`, not the
frame's time. The app uses that one rule at ingest, at the answer and in the
reader. An answer to an older alert stores the label and nothing else. The review
screen says so.

The same image scored again later is a **different claim**: an answer about the
first does not touch the second.

**Replay.** The answers in force are one merged stream of publishes and rejects,
ordered by (created time, id), and applied in that order. Of several answers about
one exact claim, the latest wins. So Wrong, Right, Wrong on three frames of one
cam ends disputed, and Right, Wrong, Right ends not disputed. The feed's
`disputedCams` keeps the id of the verdict that began (`sinceId`) or ended
(`resolvedId`) each entry, and every comparison is on (time, id). So replaying the
same verdicts every tick changes nothing, even for two made in the same instant. A
test replays every shared vector more than once. The app and the
reader apply the same rule. Both are tested against one shared vector file,
`lib/quality/verdictVectors.json`, which has both sequences.

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

The owner uses the review screen inside the iPhone app, which has no address bar and
no universal links. A Safari enrollment cannot give a native push token, so enroll
**in the app**.

1. Apply the migration: `wrangler d1 migrations apply isitbeachday-plus --remote`
   (migration `0019_quality_loop.sql`).
2. Deploy the app and `workers/history-cron`.
3. In the iPhone app, allow notifications once (turning on alerts for any beach
   does it).
4. **Open the hidden door.** Open the Plus settings sheet (or scroll to the bottom
   of a beach page) and tap the "Support ID" line **5 times within 3 seconds**. The
   web view goes to `/admin/review`. Nothing on screen changes for anyone else.
5. A phone that is not enrolled sees only an **Owner code** box and an **Enroll**
   button. Paste `OWNER_ENROLL_CODE` and tap Enroll. The code is sent in a request
   body, never in an address, and the box is cleared after the try. It passes the
   same throttle as the link below.
6. The server makes an owner session. It returns a random 32-byte token once. The
   phone keeps it. The server keeps only its SHA-256, in `owner_sessions`.
7. The review screen asks the phone for a fresh push token and sends it to
   `POST /api/quality/owner/push-token`, which stores it on the owner session.
   Owner pushes go only there. If this fails, the screen tries again on the next
   load.

**Other ways in.** On a Mac or in Safari you can open
`https://app.isitbeachday.com/admin/review#enroll=<OWNER_ENROLL_CODE>`. Use the `#`
form only. Browsers never send a `#` part to a server. The page reads the code,
removes it from the address bar, and sends it in a request body. The server never
logs it. A `?enroll=<code>` link does **not** work: a query string would reach the
server and its logs, so the page ignores it. A Safari enrollment gives the session
no push token, so the phone gets no owner pushes until you enroll in the app.

**Tapping an owner push.** The push carries `https://app.isitbeachday.com/admin/review?alert=<id>`.
The app's tap handler (`lib/push/native.ts`, `lib/push/tapTarget.ts`) opens that
path in the web view. It accepts only a path on this app that a push is known to
open: `/` (the test push), a **real beach page** (`/<slug>`, checked against
`config/locations.ts`, which includes the beaches the admin console added),
`/admin/review` (with a plain numeric `alert`) and `/admin/report`. Every other
top-level route is refused, `/get-app` (it redirects off the app), `/support`,
`/find`, `/privacy`, `/sticker` and `/api` among them. A test walks the `app/`
folder so a new route cannot slip in: it fails until the route is added to
`RESERVED_ROUTES`. A second test reads every push producer's `url` and checks it
passes. An address on another host or scheme, a protocol-relative address, and any
other path are ignored.

**If the review screen cannot load.** Only a 401 or 403 shows the Owner code box.
A network error, a 429 or a 5xx keeps the owner signed in and shows "Try again",
never the code box: enrolling again from the same device would revoke the working
session.

Enrollment is rate limited: 5 tries per hour per address, 20 per hour in all. The
counters live in D1 (`owner_enroll_attempts`). One atomic statement bumps a
counter and refuses to pass the limit, so tries that arrive together cannot slip
past it. The daily purge deletes counters older than 2 days.

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
- A push whose attempt never finished is marked `unknown` and is not sent again.
  The owner may or may not have received it. The review list shows the alert
  either way.
- If the last published feed file of any beach cannot be read, the reader skips
  that whole tick (see "Check"). Five such ticks in a row end the loop.

## Separate hardening item (not in this change)

`POST /api/push/register-native` accepts a device id without its install token
and can overwrite that device's push token. The owner push path no longer depends
on it, so this change leaves it alone. It is still a real gap for every other
alert. Fix it separately: require the install token to change the token of a
device that has one on file.
