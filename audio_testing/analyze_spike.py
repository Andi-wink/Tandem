#!/usr/bin/env python
import json, sys
from pathlib import Path
from run_tandem_parakeet import normalize, wer_align

OUT = Path(__file__).parent / "spike_out"

def load(name):
    return [json.loads(l) for l in (OUT / name).read_text(encoding="utf-8").splitlines()]

def analyze(name):
    recs = load(name)
    meta = {}
    for r in recs:
        if r["dir"] == "meta" and "audio_send_done_t" in r.get("msg", {}):
            meta["audio_done"] = r["msg"]["audio_send_done_t"]
    partials, commits = [], []
    first_partial = None
    first_send = None
    last_send = None
    closed = None
    errors = []
    for r in recs:
        if r["dir"] == "send" and r.get("note","").startswith("frame#"):
            if first_send is None: first_send = r["t"]
            last_send = r["t"]
        if r["dir"] == "recv" and "msg" in r:
            mt = r["msg"].get("message_type","")
            if mt == "partial_transcript":
                partials.append(r["t"])
                if first_partial is None: first_partial = r["t"]
            elif mt in ("committed_transcript_with_timestamps",):
                commits.append((r["t"], r["msg"].get("text","")))
            elif "closed" in r["msg"]:
                closed = r["msg"]
            elif mt.endswith("error") or "error" in mt:
                errors.append((r["t"], mt, r["msg"]))
        if r["dir"] == "recv" and r.get("msg",{}).get("closed"):
            closed = r["msg"]
    # cadence
    cad = None
    if len(partials) > 1:
        span = partials[-1] - partials[0]
        cad = round(len(partials)/span, 2) if span > 0 else None
    ttfp = round(first_partial - first_send, 2) if (first_partial and first_send is not None) else None
    last_commit_t = commits[-1][0] if commits else None
    commit_latency = round(last_commit_t - meta["audio_done"], 2) if (last_commit_t and "audio_done" in meta) else None
    return dict(name=name, n_partials=len(partials), ttfp=ttfp, cadence=cad,
                n_commits=len(commits), commit_latency_after_end=commit_latency,
                closed=closed, errors=errors[:3])

def committed_text(name):
    f = OUT / f"committed_{name}.txt"
    return f.read_text(encoding="utf-8") if f.exists() else ""

for nm in ["a","b","c","d","f"]:
    fn = f"events_{nm}.jsonl"
    if (OUT/fn).exists():
        d = analyze(fn)
        print(f"\n=== {nm} ===")
        for k,v in d.items():
            if k=="name": continue
            print(f"  {k}: {v}")

# scenario e concurrency
for tag in ["e_s1","e_s2"]:
    fn=f"events_{tag}.jsonl"
    if (OUT/fn).exists():
        d=analyze(fn)
        print(f"\n=== {tag} ===")
        print("  n_partials",d["n_partials"],"n_commits",d["n_commits"],"ttfp",d["ttfp"],"errors",d["errors"],"closed",d["closed"])

# WER of scenario a vs ground truth
ref = normalize((Path(__file__).parent/"elevenlabs"/"clip_11.txt").read_text(encoding="utf-8"))
hyp = normalize(committed_text("a"))
S,D,I,N = wer_align(ref,hyp)
print(f"\n=== WER scenario a (committed vs clip_11.txt) ===")
print(f"  S={S} D={D} I={I} N={N}  WER={100*(S+D+I)/N:.2f}%")
print("  committed_a:", committed_text("a")[:300])
