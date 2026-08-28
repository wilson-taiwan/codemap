# User guide — Fleuron

Current as of **v1.0.0**. In-app help is the same content: press **Help** on the welcome screen or toolbar, or **`?`** / **Cmd+/** anytime.

---

## What you need

| Item | Description |
|------|-------------|
| **The app** | Installed once from the `.dmg` (macOS) or `.exe` (Windows) |
| **An account** | Yours alone. Create it in Settings or as the first step of Join a group. Colleagues never see it. |
| **A group key** | Eight characters from **Group & sync…**. That is the only thing a second coder carries. |
| **Transcripts in Box** | De-identified files. Both of you import the same file under the same study label. |

The app is the tool; the **project** is a `.fleuron` folder on *this* computer. Coding travels through sync. Transcripts travel through Box. **Never copy, sync, or share the live project folder.**

---

## 1. Open or join

**Returning on this machine.** Recent projects on the home screen. Click a row.

**Joining a study someone else started.**

1. Ask for the group key (eight characters, e.g. `K7RM-2QWD`). Case, spaces, and dashes do not matter.
2. Home screen → **Join a group**. If you are not signed in, create an account or sign in first — **Confirm password** is required. **Forgot password?** emails a short code; type it in the app. There is nothing to click in the message.
3. Paste the key and confirm the name the group should file your coding under.
4. **Create a new copy** (usual) or **Use a folder already on this computer** if this machine already has the study. Binding a folder that belongs to a *different* group is refused.
5. Link each transcript from Box. Fleuron checks the passage count against the group's copy.
6. **Start coding** enables once every transcript is linked.

**Starting a new study.** Home screen → **Set up a new study** (⌘N). Then **⋯ → Group & sync… → Start a group** and send the key.

---

## 2. Import a transcript

1. **Import** in the transcript panel (or the empty-state button).
2. First interview: enter a **study label** (`P07`) → continue → pick the file.
3. Format is detected from contents: WebVTT, SRT, plain text with speaker labels, Word `.docx`, CSV.

**+ New interview** for another participant. The label *is* the interview identity — `P07` and `P7` are two different interviews. Repeat interviews need distinct labels (`P07-1`).

**Re-importing** replaces that interview's segments — review coding afterward.

---

## 3. Code

Coding happens **where the text is**, not in the codebook.

1. Click a passage for the whole turn, or **drag across words** for a phrase.
2. A bubble appears beside the selection. Type to find a code, or type a new name and press **Enter** to create and apply in one step.
3. Click a pill in the bubble to take that code off. Removing the last code removes your coding of that target.
4. **⌘Z / Ctrl+Z** undoes the last coding change (25 steps). **⇧⌘Z / Ctrl+Y** redoes.

A phrase is underlined in the code's colour; a whole-turn coding tints the turn more lightly. Both can exist on the same passage. Hover overlapping highlights to see which codes cover them.

**The codebook is a reference.** A plain click expands the numbered, quoted list of passages that code is on. Apply and filter survive on right-click.

On a grouped project the toolbar shows the name you confirmed when you joined — it is not a picker. Change it in **Group & sync…**.

---

## 4. Notes

- **A note on a coding** appears in the right rail only when a note exists or you ask for one. In the transcript, a note icon sits beside the highlighted passage; click it to open an inline card. Both editors autosave. Use **Notes** in the transcript toolbar to hide or show all markers.
- **Notes on this interview** (⋯ menu) are interview-wide, autosave, and **never sync** — they stay on this computer.

---

## 5. Working with your other coder

**Transcripts go through Box. Coding goes through sync. Nothing else moves.**

1. Put the de-identified transcript in the team's Box folder — study IDs only, in the text *and* the filename.
2. You both create the interview with **the same study label** and import that same file.
3. Sync runs when coding pauses, on window blur, and on a slow pull cycle. **Sync now** in **Group & sync…** forces a run.

What crosses the network when you collaborate: which passage, which codes, which coder — coded-span references plus your de-identified study/participant label, interview segment counts, and content hashes. **No transcript text, no memos, no file paths.** Segment hashes are derived from transcript content, so two people importing the same file independently produce identical hashes.

Two people coding the same passage produce two records. In reflexive TA that divergence is data. There is no lock and no taking turns. One person on two machines merges; it does not 409 forever.

Every codebook field syncs word-for-word: names, definitions, colours, inclusion/exclusion criteria, examples, hierarchy, retire/restore state. Memos stay local. Because criteria and examples are synced verbatim, author them de-identified from the start. Coding *decisions* travel as coded-span references; transcript text never does.

**Forgot password?** Settings (or Join a group if unsigned) → **I already have one** → **Forgot password?** Type the short code from the email.

---

## 6. Export

**⋯ → Export files** (⇧⌘E / Ctrl+Shift+E) writes `exports/coded-segments.csv` and per-interview markdown. Those files contain verbatim quotes — they belong in Box, never in sync.

---

## Workspace

```
┌─────────────┬──────────────────────────┬─────────────┐
│  Codebook   │   Transcript             │   Note      │
│  click =    │   search · import        │   (when a   │
│  passages   │   drag or click to code  │    note     │
│  right-click│   bubble names it        │    exists)  │
│  = apply    │                          │             │
├─────────────┴──────────────────────────┴─────────────┤
│  picker · search · ⋯  (Group & sync, Settings, Export, Help)
└──────────────────────────────────────────────────────┘
```

---

## The one rule worth memorising

| | What it is | What to do |
|---|---|---|
| **Folder** ending `.fleuron` | Your working project — a live database | **Keep it on your own computer.** Never copy it into Box/Drive. |

---

## Troubleshooting

| Problem | What to do |
|---------|------------|
| macOS blocks the app | System Settings → Privacy & Security → Open Anyway (first time) |
| Windows SmartScreen | Confirm you downloaded from the official releases page, then **More info** → **Run anyway**. Never use file Properties to unblock anything |
| macOS says “damaged” or malware | Stop — that is not the ordinary warning. Delete and re-download from the official page; file an install issue if it repeats |
| Forgot password | Settings → I already have one → Forgot password? Type the short code from the email |
| Teammate's codes missing | Open **Group & sync…** → **Sync now**. You must be signed in. |
| Chip says "3 to send" | Coding is already saved here; that count has not reached the group yet |
| Sync refuses / passages don't line up | Different transcript or different study label. Re-import the same Box file under the same label |
| Recent project won't open | Folder moved — remove the row, then Open project… |
| Join wants an account first | That is the first step of the wizard. Continue stays hidden until you are signed in |
| Folder already in another group | Binding would mix two studies — use **Create a new copy** instead |

---

## Reflexive TA

Disagreements are **discussed**, not resolved by majority vote. The app tracks who coded what. It does not compute IRR or Cohen's kappa.
