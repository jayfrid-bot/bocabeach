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
| 1 | Watchdog, second opinion, owner alert, labels, report sheet, the reader obeying owner verdicts, the exact judged frame | Built, awaiting review and deploy |
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

A jump with a real cause does not alert. These are the causes:

- `rain_now` changed.
- `lightning_near` changed.
- The set of score caps changed (flags, advisories, rain, wind). Numbers inside
  a cap text are ignored.
- The wind moved by 5 mph or more.
- The wave reading is an official observation (the buoy). This covers a surf
  jump, and a score jump that the waves led.
- The cloud cover swung by 30 points or more. This covers a sand jump, and a
  score jump that the sky factor led.

Only an unexplained jump alerts. The rules are in `lib/quality/jumps.ts`.

### Check

When the reader holds a seaweed jump, it asks a second provider to read the same
image:

- A claim from Gemini, Groq or OpenRouter goes to Clef.
- A claim from Clef goes to Gemini.
- If that provider is not set up, there is no second opinion.

If the second reader also says moderate or high, the reader confirms the jump
at once. The reading carries `confirmedBy: "second-opinion:<provider>"`.

If the second reader disagrees, the jump stays held. The reader sends an alert
to the app. If the second reader fails or calls the frame unreadable, nothing
changes. The jump stays held, as before.

Second opinions are rare. They run only on a held jump. A tick makes at most
six. Clef also has its own cap of 600 calls per UTC day.

### Confirm

An alert reaches the owner in two ways: a push, and the review list.

**Push rules.** These are in `lib/quality/pushPolicy.ts`.

- Only for watched beaches: the beaches with vision cams, plus `boca-raton`.
- Never between 9 PM and 7 AM, New York time.
- Not again for the same beach and signal within 3 hours of the last push.
- At most 3 pushes per day, counted from midnight New York time.

An alert that fails a rule is still stored. It shows in the review list. It does
not push. A push that fails does not count toward the daily 3.

**Push text.** Short and plain. Example: "Check: Boca Inlet cam says moderate
seaweed (35%). Other cams: none." A tap opens `/admin/review?alert=<id>`.

**Review screen** (`/admin/review`). One card per open alert. It shows the
saved camera frame, one sentence to judge, what the app showed, the second
reading, and the other cams. Two big buttons: Right and Wrong. Wrong opens a
one-tap picker for the correct value. Seaweed: none, low, moderate, high.
Clarity: clear, slightly murky, murky. Surf, sand and score: a number.

**The saved frame.** The reader sends the exact image it judged with the alert,
shrunk to 150 KB or less. The app keeps it in the cam-frames R2 bucket under
`quality/<beach>/<cam>/<date>/<time>-<hash>.jpg`. The review screen shows that
frame and labels it "the exact frame". If no image came, or it could not be
stored, the screen falls back to the archived frame with the same hash, then to
the nearest archived frame of that cam. The label keeps the key.

**The reader obeys the owner.** Once per beach per tick, the reader fetches the
owner's running seaweed verdicts: `GET /api/quality/overrides?slug=...` with the
`INGEST_TOKEN`. If that call fails, the reader behaves as it did before. A
verdict lasts until the end of the beach-local day.

- **Wrong** on a cam. The reader clears that cam's pending claim. For the rest
  of the day, that cam's moderate-or-high reads cannot confirm by persistence or
  by a second opinion. They publish as no seaweed and carry `ownerHold`. No
  claim is stored and no alert is sent. Another fresh cam that also reads
  moderate or high can still confirm it. A suppressed cam never confirms another
  cam. When a fresh read of that cam comes in below moderate, the verdict is
  spent. The reader writes it into `spentOverrides` in the feed, and the cam is
  judged like any other again.
- **Right** on a held claim. The held reading publishes at the claimed level
  with `confirmedBy: "owner"`. Its pending claim becomes a confirmed one, so the
  cam's next moderate-or-high frame is not held again.

The app applies the same verdicts when it summarizes the feed, so the card
changes at once, before the reader's next tick. A newer fresh reading from that
cam always wins over the verdict. The code is `lib/quality/seaweedOverrides.ts`
(app) and `scripts/quality_watch.py` (reader).

**Report conditions** (`/admin/report`). For the owner on the beach. Big taps
for seaweed and water clarity. Optional surf height, sand temperature and note.
Each answer saves as a label with the nearest saved frames of that beach. The
beach page shows a quiet "Report conditions" link, but only on a phone that has
passed the owner check once.

### Learn

Every answer and every report is a row in `quality_labels`. The row holds what
the app published, what was claimed, the truth when the owner gave it, and the
saved frame. Phases 2 and 3 read these rows.

## Owner setup

Do these once.

1. Apply the migration: `wrangler d1 migrations apply isitbeachday-plus --remote`
   (migration `0019_quality_loop.sql`).
2. Deploy the app.
3. Open `https://app.isitbeachday.com/admin/review` in the iPhone app. The
   screen says the phone is not on the owner list. It shows the device id. Copy
   it.
4. Set the secret: `wrangler secret put OWNER_DEVICE_IDS`. The value is the
   device id. Use commas to list more than one phone.
5. Open the review screen again. It now opens.

The secrets `INGEST_TOKEN`, `CAM_FRAME_URL_KEY` and the APNs keys already exist.
Phase 1 adds one new secret: `OWNER_DEVICE_IDS`. Pushes go to iPhones only.

**How the owner gate works.** A request must carry a device id on the list. It
must also carry that device's install token. The id alone is not enough. With
no list set, every owner screen stays closed.

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
| 2026-10-13 | `boca-inlet-surf` read a dark rock shelf as "moderate 35%" seaweed | `JumpConfirmationTests` and `SecondOpinionTests` in `scripts/cam_seaweed_test.py` replay it | Second opinion on a held jump, then an owner alert; the hourly watchdog for the score it would have moved |

## Known limits of phase 1

- A verdict covers seaweed only. Wrong on any other signal stores the label only.
- A verdict ends at the close of the beach-local day. A cam that keeps reading a
  false moderate tomorrow is held again, and will alert again.
- Cross-cam confirmation still works. If two cams both claim moderate, they
  confirm each other, except that a cam the owner marked Wrong cannot vouch for
  another.
- Archived frames and quality frames share one R2 bucket and its lifecycle rule.
  `wrangler.jsonc` says the rule deletes objects after 367 days. If that rule was
  written with a prefix filter, `quality/` is not covered: add a rule for it. If
  the rule covers the whole bucket, a quality frame expires after a year, and the
  label that names it keeps a dead key. Copy the frames behind golden-set labels
  out of R2 in phase 2.
- `scripts/cam_archive_remove.ts` erases a cam's `quality/` frames along with its
  archive frames when it can list R2. Without R2 listing credentials it cannot
  see them, and the script already refuses a real delete in that case.
