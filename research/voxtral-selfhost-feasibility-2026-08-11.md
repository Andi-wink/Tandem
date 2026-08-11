# Self-hosting Voxtral Mini 4B Realtime on this machine: feasibility

**Date:** 2026-08-11
**Scope:** feasibility only. Nothing was downloaded, installed, pulled or started to produce this document.
**Companion:** [european-stt-providers-2026-08-11.md](european-stt-providers-2026-08-11.md), which recommends this model as the live path.
**Target:** `mistralai/Voxtral-Mini-4B-Realtime-2602`, Apache 2.0, BF16, causal streaming ASR.

---

## Verdict

**GO WITH PREREQUISITES, but NOT via vLLM.**

Split into the three decisions that actually matter:

| Path | Verdict | Why |
|---|---|---|
| **vLLM in Docker, current machine state** | **NO-GO** | Needs 28 to 41 GB of permanent growth in `docker_data.vhdx` on a C: drive with 45.4 GB free (4.8%). Also needs the WSL2 memory cap raised from 8 GB while the host has 2.97 GB free. |
| **vLLM in Docker or WSL2, after moving Docker's data-root to D: and raising the WSL cap** | **GO WITH PREREQUISITES, but a poor bet** | Technically clears. Inherits three open upstream stability bugs that specifically break hour-long sessions. The official vLLM recipe itself says to restart sessions periodically. |
| **Native Windows CUDA runtime (transformers, or a ggml/GGUF engine)** | **GO WITH PREREQUISITES, recommended** | No WSL2, no Docker, no vhdx growth, zero bytes on C:. Costs a CUDA torch install or a C++ build, and there is no `/v1/realtime` WebSocket, so the existing harness needs a shim or a rewrite. |

**The single biggest unknown is not disk or RAM: it is that there is no published real-time factor for this model on an RTX 3090.** The only concurrency data anywhere is a community report on a 4090. If the 3090 cannot hold RTF below 1.0 on one stream, every disk and RAM number below is moot. Measure that first, cheaply, before spending a gigabyte on the heavy path.

---

## Measured machine state (2026-08-11)

| | |
|---|---|
| RAM | 31.9 GB total, **2.97 GB free**, commit 69.5 GB of 115.9 GB |
| C: | **45.4 GB free** of 953.1 GB (4.8%) |
| D: | 1,296.7 GB free of 1,907.7 GB |
| GPU | RTX 3090, 24,576 MiB total, 6,428 MiB used, **~18.1 GB free VRAM**, driver 610.62 |
| Top RAM consumers | Antigravity 10.83 GB (100 procs), claude 5.57 GB, brave 3.76 GB, msedgewebview2 1.62 GB, language_server 1.51 GB |
| CUDA toolkit | v13.1 with `nvcc` present on PATH (also v11.6, v11.8, v12.0) |
| Project venv | `D:\Dev-projects\Tandem\.venv`, 2.06 GB, **torch 2.10.0+cpu, CUDA NOT available** |

---

## Q1. Is vLLM viable here at all?

vLLM has no first-party Windows build, so the paths are Docker Desktop with the WSL2 backend, or WSL2 Ubuntu directly.

**Both are installed and the GPU plumbing is present.**

- WSL 2.7.11.0, kernel 6.18.33.2, Windows 10.0.19045.6466. Two distros, both **Stopped**: `Ubuntu` (v2) and `docker-desktop` (v2).
- `C:\Windows\System32\lxss\lib` contains the driver-injected passthrough libraries: `libcuda.so.1.1`, `libnvidia-ml.so.1`, `libdxcore.so`, `nvidia-smi`, `libnvcuvid.so.1` and others. This is the host-side evidence that WSL2 CUDA passthrough is supported by driver 610.62. It is not proof that a container has ever used it, but the prerequisite is satisfied.
- Docker Desktop is configured with `"InferenceCanUseGPUVariant": true` in `%APPDATA%\Docker\settings-store.json`, which implies GPU-aware Docker features are enabled. Modern Docker Desktop bundles the NVIDIA container runtime for the WSL2 backend, so a separate `nvidia-container-toolkit` install is not required for `--gpus all`. I could not confirm the toolkit inside the distro without booting it, which was out of scope.
- `nvidia-smi` on the host reports the GPU healthy at 6,428 MiB used.

**The blocking configuration is `%USERPROFILE%\.wslconfig`:**

```
[wsl2]
memory=8GB
processors=16
swap=2GB
[experimental]
autoMemoryReclaim=gradual
sparseVhd=true
```

An 8 GB ceiling on the whole WSL2 VM is below what a comfortable 8.86 GB BF16 weight load plus the torch and CUDA runtime wants. This must be raised for either vLLM path.

**Second finding, and it is the one that costs disk:** `sparseVhd=true` is declared but **is not in effect on either virtual disk**. `fsutil sparse queryflag` returns "This file is NOT set as sparse" for both `docker_data.vhdx` and the Ubuntu `ext4.vhdx`. The setting only applies to disks created after it was set. So **all growth described below is permanent** until someone manually runs `Optimize-VHD` or `wsl --manage <distro> --set-sparse true`.

---

## Q2. True disk cost

### Measured inputs

| Item | Size | Source |
|---|---|---|
| `vllm/vllm-openai:latest` amd64 | **9.11 GB compressed** | Docker Hub v2 API, tag `v0.27.1`, 2026-08-11 |
| `vllm/vllm-openai:latest-cu129` | 11.41 GB compressed | same |
| `consolidated.safetensors` (Mistral format) | **8.86 GB** | HF API `?blobs=true` |
| `model.safetensors` (HF format) | **8.86 GB** | same |
| Whole HF repo | **17.72 GB** | both files, same weights in two formats |
| `docker_data.vhdx` current | **106.44 GB**, not sparse | `C:\Users\andre\AppData\Local\Docker\wsl\disk\` |
| Ubuntu `ext4.vhdx` current | **3.40 GB**, not sparse | `C:\Users\andre\AppData\Local\wsl\{d32a6a9a-...}\` |
| Existing HF cache on C: | **~27 GB**, `HF_HOME` unset | `C:\Users\andre\.cache\huggingface\hub`, dominated by whisper-large-v2 at 11.5 GB |

### The weight-download trap

The repo ships the same weights twice, in two formats, both matching `*.safetensors`. vLLM's HF downloader uses that allow-pattern, so a naive `vllm serve mistralai/Voxtral-Mini-4B-Realtime-2602` is liable to fetch **17.72 GB, not 8.86 GB**. Budget the larger number unless you pre-place exactly one format in the cache. This is a concrete, checkable risk and it doubles the model's disk line.

### Cost per path

Compressed image size is measured. Extracted-on-disk size is an **estimate** at roughly 2.0 to 2.5x, the usual ratio for CUDA-heavy images. I did not pull the image, so I cannot give a measured extracted figure.

**Path A, Docker + vLLM, default locations (everything lands on C:)**

| | |
|---|---|
| vLLM image extracted into `docker_data.vhdx` | ~18 to 23 GB (estimate) |
| Model weights | 8.86 GB best case, **17.72 GB** likely |
| **Permanent C: growth** | **~27 to 41 GB** |
| C: free afterwards | **4 to 18 GB of 953 GB** |

**NO-GO.** This is what nearly broke the machine already. A 106 GB non-sparse vhdx growing another 30 GB on a drive at 4.8% free is a system-stability problem, not just an inconvenience.

**Path B, WSL2 Ubuntu directly, `pip install vllm[audio]`**

| | |
|---|---|
| vllm + torch + the `nvidia-*` CUDA wheels in site-packages | ~12 to 18 GB (estimate, not measured) |
| pip cache during install unless `--no-cache-dir` | +5 to 8 GB transient |
| Model weights | 8.86 to 17.72 GB |
| **Permanent growth of `ext4.vhdx`** | **~21 to 36 GB**, from a 3.40 GB baseline |

Same NO-GO on C:, same verdict.

**Path C, native Windows transformers**

| | |
|---|---|
| Reinstall torch with CUDA into the existing D: venv | ~6 to 8 GB installed (estimate) |
| transformers 5.2+, `mistral-common[audio]` | <1 GB |
| Model weights via `HF_HOME` on D: | 8.86 GB |
| **C: growth** | **0 GB** |
| **D: growth** | **~15 to 18 GB** of 1,297 GB free |

**Path D, native Windows ggml/GGUF engine**

| | |
|---|---|
| Source checkout plus CUDA build artifacts | ~2 to 5 GB on D: |
| GGUF weights: Q8_0 4.73 GB, Q6_K 3.66 GB, Q4_K_M 2.83 GB, BF16 8.87 GB | pick one |
| **C: growth** | **0 GB** |
| **D: growth** | **~6 to 14 GB** |

### Can the model and image live on D:? Yes, and you should do it regardless

Three independent relocations, all worth doing on their own merits:

1. **Docker Desktop disk image location.** Settings, Resources, Advanced, "Disk image location". Point it at D:. This **frees 106.44 GB on C:** immediately and is the single highest-value action available, whether or not Voxtral ever happens. Docker must be stopped and it moves the whole vhdx, so allow time and 107 GB of headroom on D: (there is 1,297 GB).
2. **`HF_HOME` to D:.** Currently unset, so ~27 GB of Whisper and Docling weights sit on C:. Setting `HF_HOME=D:\hf-cache` and moving the existing `hub` directory frees ~27 GB on C: and puts all future Voxtral weights on D:.
3. **The Ubuntu distro.** WSL 2.7.11 supports `wsl --manage Ubuntu --move D:\wsl\Ubuntu`, moving the 3.40 GB `ext4.vhdx` and all its future growth off C:.

**Caveat if you go the Docker route:** do not bind-mount a Windows `D:\hf-cache` into the container. Cross-filesystem access from a WSL2 container to a Windows path goes over the 9p/virtiofs bridge and will make an 8.86 GB weight load painfully slow. Put the cache in a Docker volume (which then lives inside the relocated `docker_data.vhdx` on D:) or inside the Linux filesystem.

**Also reclaimable on C:, unrelated to this project:** `C:\Windows.old` at 12.1 GB.

---

## Q3. True RAM cost

**There is no documented host-RAM figure for vLLM loading a 4B BF16 model.** vLLM's memory documentation covers GPU only, and its single CPU-RAM line is about `mm_processor_cache_gb`. Every Voxtral OOM report upstream (#38233, #45022, #47533) is VRAM or encoder-cache, not host RAM. I will not invent a number.

What can be stated from the measured state:

- **Free physical RAM is 2.97 GB. Every path fails at that number.** Not marginal, fails.
- Commit charge is 69.5 GB of a 115.9 GB limit, so the machine is already paging. Adding a multi-gigabyte working set makes that worse before it makes it better.
- **VRAM is fine.** 18.1 GB free against a model documented as needing a single GPU with 16 GB or more, and 8.86 GB of BF16 weights. The GPU is not the constraint.

**To free RAM, in order of value:**

| Close | Frees |
|---|---|
| Antigravity (10.83 GB across 100 processes) | **10.8 GB** |
| brave (3.76 GB) | 3.8 GB |
| the second `claude` session (5.57 GB total across 31 procs) | up to 5.6 GB |
| msedgewebview2 (1.62 GB), firefox (1.04 GB) | 2.7 GB |

Closing Antigravity and Brave alone takes free RAM from 3 GB to roughly 17 GB.

**Realistic minimums:**

- **Paths A and B (vLLM in WSL2):** raise `.wslconfig` `memory` from 8 GB to **16 GB**, which means the host must have roughly **18 to 20 GB free** before starting so that `vmmem` can claim its ceiling without pushing Windows into swap. That requires closing Antigravity plus at least one browser. `autoMemoryReclaim=gradual` is already set, which helps on the way back down.
- **Path C (native transformers):** an 8.86 GB safetensors load, memory-mapped, then transferred to GPU. Budget **10 to 12 GB free host RAM** at peak. Closing Antigravity alone is sufficient.
- **Path D (GGUF via ggml):** weights are mmap'd and streamed to VRAM, so the host resident set stays small. Budget **3 to 5 GB free**. This is the only path that is close to workable on the machine as it stands right now.

---

## Q4. Is there a lighter path than vLLM?

Yes, and the answer changed the recommendation.

### llama.cpp: no

`docs/multimodal.md` lists only the older offline `ggml-org/Voxtral-Mini-3B-2507-GGUF`. The 4B Realtime model is absent. Issue [#19696 "Add Voxtral Realtime"](https://github.com/ggml-org/llama.cpp/issues/19696), opened 2026-02-17 by patrickvonplaten of Mistral, was folded into [#20914](https://github.com/ggml-org/llama.cpp/issues/20914), which is **closed as not planned**. The blocker is architectural: `mtmd_tokenize()` only handles fixed 30-second padded chunks, so causal small-chunk streaming needs an API redesign. `llama-server` has no `/v1/realtime` WebSocket and the design doc's Phase 3, which would have added one, was never built.

### HF transformers: yes, and it streams

This is the honest surprise. `VoxtralRealtimeForConditionalGeneration`, `VoxtralRealtimeProcessor`, `VoxtralRealtimeFeatureExtractor` and `VoxtralRealtimeConv1dPaddingCache` landed in **transformers 5.2.0**. The [docs page](https://huggingface.co/docs/transformers/model_doc/voxtral_realtime) has three sections: Offline, Batched Offline, and **Streaming Transcription**, the last flagged as an experimental API subject to change. The pattern is a generator of mel chunks fed to `model.generate()` on a thread with a `TextIteratorStreamer`. Delay is exposed as `num_delay_tokens`, config default 6, which is 480 ms at 80 ms per token, matching `transcription_delay_ms` in `tekken.json`.

Note the model card still carries the stale line "Due to its novel architecture, Voxtral Realtime is currently only support in vLLM" **alongside** a Transformers >= 5.2.0 entry in its own runtime list. The card contradicts itself, the transformers docs win.

This is plain PyTorch, so it runs on native Windows CUDA with no WSL2 and no Docker.

### mistral-inference: no, and it is archived

[github.com/mistralai/mistral-inference](https://github.com/mistralai/mistral-inference) was archived 2026-06-16, "no longer actively maintained", text and Pixtral vision only. Zero mentions of Voxtral or audio. `mistral-common` provides only the tokenizer and preprocessing, including the `tekken.json` where `transcription_delay_ms` lives. **Mistral ships no self-host runtime of its own for this model.**

### ggml/GGUF forks: yes, native Windows CUDA, no Python

- **[audio.cpp](https://github.com/0xShug0/audio.cpp)** (~1.3k stars, ggml, no Python). Supported-models table lists `Voxtral-Mini-4B-Realtime-2602` with runtime "GGUF 16/Q8/Q4, Stream". First-class Windows build: `.\scripts\build_windows.ps1 -Preset windows-cuda-release`. Release 0.4 (2026-07-23) added Voxtral Realtime ASR; 0.5 shipped 2026-07-31. Documents raw 16 kHz mono PCM streaming piped from ffmpeg, which matters for live mic capture. Mistral's own HF org publishes GGUFs targeting it: `mistral-experimental/AudioCPP-Voxtral-Mini-4B-Realtime-2602-GGUF`. Note "mistral-experimental" is not an explicit official endorsement.
  **Correction to a bad search result:** audio.cpp does **not** expose `ws://localhost:8000/v1/realtime`. Its server has only `GET /health`, `GET /v1/models`, `POST /v1/audio/speech`, `POST /v1/audio/transcriptions`, `POST /v1/tasks/run`. Streaming is CLI and library level.
- **[transcribe.cpp](https://github.com/handy-computer/transcribe.cpp)** (1.7k stars, MIT, "llama.cpp for STT"). Lists `voxtral-mini-4b-realtime-2602 (streaming audio-LLM)`, builds with `-DTRANSCRIBE_CUDA=ON`, and exposes real causal-streaming knobs: `--stream-chunk-ms`, `--stream-voxtral-delay` (default 6 = 480 ms, range 80 ms to 2.4 s). Claims the final transcript is byte-equal to the offline path. **Caveats: 16 kHz mono WAV input only, no mic or stdin path documented, no server mode documented, and the published performance table covers only Apple M4 Max and AMD Vulkan, with no Windows/CUDA benchmark.**
- Weaker: `andrijdavid/voxtral.cpp` (23 commits, no server, Windows build undocumented), `antirez/voxtral.c` (elegant but Unix-only, no CUDA).

### Everything else: no

Ollama (issue #12440 only ever asked for the offline 3B, closed with no maintainer reply), LM Studio (a "Voxtral voice" feature exists in Bionic, but no evidence it is the Realtime-2602 model or that any realtime API is exposed), SGLang (RFC #22474 for `WS /v1/realtime` is closed and inactive, targets Qwen3-ASR, never names Voxtral), LocalAI (issue #8401 requesting exactly this is open with no PR since 2026-02-04), Speaches (has `/v1/realtime` but is faster-whisper based, no Voxtral), TensorRT-LLM (not found).

Native-Windows vLLM wheels do exist (`SystemPanic/vllm-windows`, `aivrar/vllm-windows-build` v0.26.0 CUDA 12.8, SM 8.6 covers the 3090) but **neither documents audio-model support or the `/v1/realtime` WebSocket**. Treat "vLLM natively on Windows with working Voxtral realtime" as unverified.

### GGUF availability and quantisation

Confirmed GGUF repos for the realtime model include `handy-computer/Voxtral-Mini-4B-Realtime-2602-gguf` (385k downloads, updated 2026-06-28) at BF16 8.87 GB, Q8_0 4.73 GB, Q6_K 3.66 GB, Q5_K_M 3.28 GB, **Q4_K_M 2.83 GB**.

transcribe.cpp publishes 2.07 to 2.09% WER on LibriSpeech test-clean across every shipped quant, concluding the ladder is "WER-neutral down to Q4_K_M". **Be skeptical:** LibriSpeech test-clean is read, clean, single-speaker English, close to a best case. There are no published quant-vs-WER numbers for multilingual, long-form or noisy multi-speaker audio, which is exactly Tandem's workload. And with 18.1 GB of free VRAM you do not need to quantise at all, so treat quantisation as a disk optimisation, not an accuracy decision.

### Weighing this against the existing stack

Tandem already ships whisper.cpp via `whisper-rs` and links a ggml C++ engine on Windows CUDA. A ggml/GGUF Voxtral engine is **architecturally the same move already made**, with no Python, no Docker and no WSL2. A Docker plus vLLM stack introduces an entire new runtime tier, a VM, and a 106 GB vhdx, for a model that would have to be reached over a WebSocket anyway. On fit alone, the ggml path wins by a wide margin.

The cost is that **no lighter runtime serves `/v1/realtime`**. Only vLLM does. If that wire protocol is required, either write a thin WebSocket shim over a streaming C API, or use vLLM.

---

## Q5. Is the model gated on Hugging Face?

**No.** `https://huggingface.co/api/models/mistralai/Voxtral-Mini-4B-Realtime-2602` returns `"gated": false`, `"private": false`, `"license": "apache-2.0"`. No terms acceptance, no access request, no token required. Created 2026-01-21, last modified 2026-03-11, ~2.15M downloads in 30 days.

**No blocker here.**

---

## Q6. Version compatibility

**`/v1/realtime` is genuinely shipped and released, not behind a PR, nightly or feature flag.**

- The WebSocket Realtime API landed in **vLLM v0.16.0**, published 2026-02-25. Release notes: "**Realtime API**: A new WebSocket-based Realtime API enables streaming audio interactions (#33187), building on the Voxtral realtime infrastructure."
- The **official recipe pins `min_vllm_version: "0.20.0"`** (published 2026-04-27, recipe `date_added: 2026-05-13`), with the reasoning that "the Voxtral Realtime architecture has been registered since v0.16.0, but v0.20.0 is the first stable release with the architecture documented in the supported-models list". Current stable is v0.27.1 (2026-08-11), so 0.20.0 is comfortably behind.
- **The architectures are distinct.** Batch/offline Voxtral Mini 3B 2507 is `VoxtralForConditionalGeneration`, landed in v0.10.0 (2025-07-24). Streaming Realtime 2602 is `VoxtralRealtimeGeneration`, a separate supported-models entry under "Realtime Transcription".
- No enable flag. The endpoint registers automatically for realtime-capable architectures. Install needs `vllm[audio]` and `mistral-common[audio] >= 1.9.0`, plus Transformers v5 (v4 spams warnings, vllm#34642).

**Recipe serve command, verbatim:**

```bash
VLLM_DISABLE_COMPILE_CACHE=1 vllm serve mistralai/Voxtral-Mini-4B-Realtime-2602 \
  --tokenizer-mode mistral \
  --compilation_config '{"cudagraph_mode": "PIECEWISE"}'
```

Startup line to look for: `Route: /v1/realtime, Endpoint: realtime_endpoint`.

`--tokenizer-mode mistral` is the only mandatory flag, because the tokenizer only loads through `mistral_common`. `--config_format` and `--load_format` appear only in user-written bug reports, not the recipe or the model card, and are unnecessary. `--max-model-len` defaults to 131072, about 3 hours; at one text token per 80 ms of audio, a 1-hour meeting needs at least 45000. Note the URL cited in the previous research doc, `docs.vllm.ai/projects/recipes/en/latest/Mistral/Voxtral.html`, is **404**; recipes now live at `recipes.vllm.ai` backed by YAML in `vllm-project/recipes`.

### The stability finding, which is more important than the version finding

Four open upstream issues, all of which hit exactly Tandem's use case of long continuous client calls:

- **[#47614](https://github.com/vllm-project/vllm/issues/47614)** (2026-07-04, **open**): "self-sustained blank-token rut mutes live transcription for minutes over real speech". Reproduced on A4000, L40S and a 4090 laptop. The blank token is emitted for 1 to 20 minutes over real speech and **the audio in the hole is lost**. For a client call this is a data-loss bug, not a quality bug.
- **[#36015](https://github.com/vllm-project/vllm/issues/36015)**: Voxtral realtime transcription **silently hangs after roughly 10 minutes** of continuous streaming. Unhandled `TimeoutError` in a background task, connection stays open, no output, no error.
- **[#35863](https://github.com/vllm-project/vllm/issues/35863)** (RTX 5090, 2026-03-03): "stops returning transcribed text starting from the 3rd concurrent session". **Closed by stale-bot 2026-07-03 with zero human replies**, not fixed.
- **[#38233](https://github.com/vllm-project/vllm/issues/38233)** (RTX 5060 Ti 16 GB, 2026-03-26, **open**): `encoder_cache_usage` saturates at 1.0 immediately, hard `EngineDeadError` when tokens exceed `max_model_len`.

Candidate fix PRs **#45022, #45833, #47615, #44364, #51167 are all still open and unmerged as of 2026-08-11**, two to three months after filing. The official recipe's own troubleshooting section says: "Hangs / crashes on long sessions, known upstream issue. Restart sessions periodically as a workaround."

**This is why the vLLM path is a poor bet even after the disk and RAM prerequisites are met.** The reference runtime cannot currently be trusted to stream a one-hour call without silently losing minutes of it, and Tandem's entire value proposition is not losing the call.

---

## Q7. Realtime factor

**There is no published RTF or concurrency benchmark for this model on an RTX 3090. NOT FOUND. I am not estimating one.**

What exists:

- The only official throughput claim, from both the HF card and the vLLM recipe: "throughput exceeding 12.5 tokens/second" on a single 16 GB GPU. **This is the model's frame rate, not a capacity benchmark.** One token is 80 ms of audio, so 12.5 tok/s is exactly RTF 1.0 for a single stream. It says the model can keep up, it says nothing about margin.
- Recipe benchmarks are **WER only** (Fleurs): 480 ms delay gives 8.72% average and 4.90% English; 160 ms gives 12.60%; 2400 ms gives 6.73%.
- The only concurrency data anywhere is HF discussion #25, an **RTX 4090 24 GB** report from user `oleslav` (2026-03-04): 58 streams at 10-second chunks (`max-model-len=200`), 34 at 20 s, 13 at 1 min, 9 at 5 min, with ~97% KV cache at 10 concurrent 4-minute-chunk streams. The same user concluded the configuration was **insufficient for production** with multiple indefinite streams.
- A "RTFX 93.32" figure that surfaced in a web summary of the HF page **does not exist in the raw README** and should be treated as a summariser fabrication.

A 3090 is roughly 60 to 70% of a 4090 on this class of work, but extrapolating a number Tandem would then plan against would be exactly the overselling this assessment is meant to avoid. **Measure it.** Tandem needs one stream, not 58, so the bar is low, but it is unproven on this hardware.

---

## Assessment of `audio_testing/run_voxtral_realtime_wer.py`

Untracked, never executed, and it should not be run as-is. It was reviewed statically only.

**What is good.** The imports all resolve: `vad_segments_live` and `MIN_SEGMENT_SAMPLES` exist in [run_scribe_meeting_wer.py](../audio_testing/run_scribe_meeting_wer.py#L69), and `read_wav_16k_mono`, `normalize`, `wer_align`, `REF_DIR`, `CLIPS_DIR` exist in [run_tandem_parakeet.py](../audio_testing/run_tandem_parakeet.py#L32). Reusing the identical VAD and scorer rather than reimplementing them is the right call and preserves comparability with the Scribe numbers. Two pieces of honesty in the docstring deserve credit: that `--delay-ms` is a label and not applied, and that scoring against ElevenLabs output biases every absolute number in ElevenLabs' favour. Separating `--feed vad` from `--feed continuous` and refusing to conflate them is also correct.

**Defects, worst first.**

1. **The wire protocol is guessed, not verified** ([run_voxtral_realtime_wer.py#L287-L296](../audio_testing/run_voxtral_realtime_wer.py#L287)). It sends `{"type": "session.update", "model": ...}` with `model` at the top level, whereas the OpenAI Realtime shape nests configuration under a `"session"` object. **More seriously, it never declares an audio format or sample rate anywhere**, then feeds 16 kHz PCM16. If the server assumes the OpenAI default of 24 kHz, the audio is silently resampled or misread and the harness produces a plausible-looking but meaningless WER. This is the failure mode that wastes a day. Verify against a live server's `session.created` payload before trusting any number it prints.
2. **Sending `input_audio_buffer.commit` before any audio** ([#L290](../audio_testing/run_voxtral_realtime_wer.py#L290)) to "open the stream" is asserted from "the vLLM example" but is not in any documentation I could find. Unverified.
3. **A promised flag does not exist.** The docstring at [#L52](../audio_testing/run_voxtral_realtime_wer.py#L52) tells the reader to "See `--dump-disagreements`". `argparse` defines only `--clips`, `--delay-ms`, `--pace`, `--feed`, `--host`, `--port`, `--model`. The flag was never implemented.
4. **Dead code in `analyze()`** ([#L327-L331](../audio_testing/run_voxtral_realtime_wer.py#L327)): a `lags` list is built with the comment "placeholder, refined below" and then discarded, because the refinement happens in a different function.
5. **Misleading dead computation in `main()`** ([#L485](../audio_testing/run_voxtral_realtime_wer.py#L485)): `pooled(..., "wer")` is called for the done-event branch, which recomputes the streamed WER, and its results are then thrown away in favour of a manual sum below. Reads as a bug even though it is inert.
6. **Silent onset loss** in `build_schedule_continuous` ([#L162](../audio_testing/run_voxtral_realtime_wer.py#L162)): `onset_marks` is a dict keyed by frame index, so two VAD onsets inside the same 250 ms frame collide and one is dropped. Affects time-to-first-delta only, not WER.

**Verdict on the script: a reasonable skeleton, but its central assumption (the WebSocket message shape and audio format) is unverified, and it is written against the one runtime this document recommends against.** If the recommendation below is taken, the transport layer needs rewriting anyway; the VAD, feeding schedule and scoring halves are worth keeping verbatim.

---

## What this will cost in disk and RAM

The section that matters, given what just broke the machine.

### Disk

| Action | C: effect | D: effect |
|---|---|---|
| **Move Docker disk image location to D:** | **+106.4 GB free** | -106.4 GB |
| **Set `HF_HOME=D:\hf-cache` and move the existing cache** | **+27 GB free** | -27 GB |
| Delete `C:\Windows.old` | +12.1 GB free | 0 |
| `wsl --manage Ubuntu --move D:\wsl\Ubuntu` | +3.4 GB free | -3.4 GB |
| Then: Path A or B (vLLM) | 0 | -30 to -42 GB |
| Then: Path C (transformers) | 0 | -15 to -18 GB |
| Then: Path D (GGUF) | 0 | -6 to -14 GB |

C: goes from 45.4 GB free to roughly **191 GB free** after the first three moves, before any Voxtral work begins. D: has 1,297 GB and absorbs everything without strain.

**Without those relocations, every path that touches Docker or WSL2 is NO-GO, and Path C is NO-GO too if the HF cache stays on C:.**

Also budget the fact that neither vhdx is sparse. Once `docker_data.vhdx` grows it does not shrink back. If Docker is relocated to D: that stops mattering, which is a second reason to do it first.

### RAM

| Path | Free host RAM needed at peak | Currently short by |
|---|---|---|
| A / B, vLLM in WSL2 (cap raised 8 GB -> 16 GB) | **18 to 20 GB** | 15 to 17 GB |
| C, native transformers | **10 to 12 GB** | 7 to 9 GB |
| D, native GGUF/ggml | **3 to 5 GB** | 0 to 2 GB |

Closing **Antigravity (10.8 GB)** is mandatory for every path except D. Closing Brave (3.8 GB) as well clears Path C comfortably and gets Paths A and B within reach.

VRAM is never the constraint: 18.1 GB free against 8.86 GB of BF16 weights.

---

## Prerequisite checklist

**Do first, regardless of which path wins (these are pure wins and cost nothing but time):**

- [ ] Move Docker Desktop's disk image location to D:. Frees **106.4 GB** on C:.
- [ ] Set `HF_HOME=D:\hf-cache`, move `C:\Users\andre\.cache\huggingface\hub` there. Frees **~27 GB** on C:.
- [ ] Delete `C:\Windows.old`. Frees **12.1 GB**.
- [ ] Close Antigravity before any model work. Frees **10.8 GB** of RAM.

**Path D, recommended first attempt (audio.cpp or transcribe.cpp, native Windows CUDA):**

- [ ] Confirm Visual Studio C++ build tools are present. CUDA v13.1 with `nvcc` is already on PATH, verified.
- [ ] Build `audio.cpp` with `.\scripts\build_windows.ps1 -Preset windows-cuda-release` and confirm it links against the 3090.
- [ ] Fetch **one** GGUF, Q8_0 at 4.73 GB, into `D:\hf-cache`. Not BF16 unless a quantisation regression shows up.
- [ ] **Measure RTF on a single stream on the 3090 before anything else.** This is the go/no-go gate for the entire project, and it costs ~5 GB of disk to answer.
- [ ] Only then decide whether a `/v1/realtime` WebSocket shim over the streaming C API is worth writing.

**Path C, the correctness reference (native Windows transformers):**

- [ ] Reinstall torch with CUDA into `D:\Dev-projects\Tandem\.venv`. It is currently **2.10.0+cpu**, which cannot see the GPU. Roughly 6 to 8 GB.
- [ ] `pip install "transformers>=5.2.0" "mistral-common[audio]>=1.9.0"`.
- [ ] Fetch `consolidated.safetensors` **only** (8.86 GB), not the whole 17.72 GB repo.
- [ ] Use the documented streaming snippet as ground truth to diff any C++ runtime against.

**Path A or B, only if `/v1/realtime` is genuinely required:**

- [ ] All of the "do first" items above, non-negotiable.
- [ ] Raise `.wslconfig` `memory` from 8 GB to 16 GB, and delete the vhdx and recreate it, or run `wsl --manage <distro> --set-sparse true`, so `sparseVhd=true` actually applies.
- [ ] Close Antigravity and at least one browser before starting the VM.
- [ ] Pin vLLM **>= 0.20.0**, ideally current stable 0.27.1.
- [ ] Pre-place exactly one weight format to avoid the 17.72 GB double-download.
- [ ] Serve with `--tokenizer-mode mistral` and confirm `Route: /v1/realtime` appears at startup.
- [ ] **Before trusting any WER number, run a 60-minute continuous stream and check for issues #36015 (10-minute silent hang) and #47614 (blank-token muting).** If either reproduces, stop.

---

## Recommendation

**Do not build this on vLLM.**

Three reasons, in order:

1. **Fit.** Tandem already links a ggml C++ engine on Windows CUDA through `whisper-rs`. `audio.cpp` or `transcribe.cpp` is the same shape as a move already made: no Python, no Docker, no WSL2, no vhdx, and everything lives on D:. vLLM adds a VM, a container runtime and 30 to 42 GB to a machine already at 4.8% free on C:.
2. **Stability.** vLLM's Voxtral realtime path has an open, reproduced bug that silently mutes transcription for up to 20 minutes and loses that audio, an open silent hang after 10 minutes of continuous streaming, and five unmerged fix PRs sitting two to three months old. The official recipe's advice is to restart sessions periodically. Tandem records hour-long client calls, and losing part of one is worse than any WER difference under discussion.
3. **Cost of being wrong.** Path D costs ~5 GB on D: to answer the only question that actually gates the project, which is whether the 3090 sustains RTF below 1.0. Path A costs 30 to 42 GB and a Docker relocation to answer the same question.

**Sequence:**

1. Do the four "do first" reclamations. They are worth ~145 GB on C: and 10.8 GB of RAM on their own merits, whatever happens next.
2. Build `audio.cpp` natively, pull one Q8_0 GGUF, and measure single-stream RTF and rough WER on `clip_11` through `clip_16`. This is the go/no-go.
3. If RTF clears, stand up Path C (transformers streaming) as the correctness reference and diff the two transcripts. Quantisation-neutrality is claimed on LibriSpeech only, so verify it on the German `clip_07` and on real multi-speaker call audio before believing it.
4. Rewrite `run_voxtral_realtime_wer.py`'s transport layer against whichever runtime wins, keeping its VAD, feed schedule and scoring code unchanged. Fix the six defects listed above at the same time.
5. Treat `/v1/realtime` as a nice-to-have. If it turns out to be required, a thin WebSocket shim over a streaming C API is far cheaper than a WSL2 vLLM installation, and it would not inherit vLLM's open long-session bugs.

**Keep hosted Mistral Voxtral Realtime ($0.36/audio-hr, EU-sited) as the fallback in the meantime.** It is not transfer-clean and needs a discretionary ZDR approval, per the [companion research](european-stt-providers-2026-08-11.md), but it works today and costs nothing in disk.

---

## Sources

- [vLLM recipe YAML for Voxtral-Mini-4B-Realtime-2602](https://github.com/vllm-project/recipes/blob/main/models/mistralai/Voxtral-Mini-4B-Realtime-2602.yaml), [recipes.vllm.ai page](https://recipes.vllm.ai/mistralai/Voxtral-Mini-4B-Realtime-2602)
- [vLLM v0.16.0 release](https://github.com/vllm-project/vllm/releases/tag/v0.16.0), [v0.10.0 release](https://github.com/vllm-project/vllm/releases/tag/v0.10.0), [realtime API docs](https://github.com/vllm-project/vllm/blob/main/docs/serving/online_serving/speech_to_text.md), [supported models](https://github.com/vllm-project/vllm/blob/main/docs/models/supported_models.md), [conserving memory](https://github.com/vllm-project/vllm/blob/main/docs/configuration/conserving_memory.md)
- vLLM issues [#36015](https://github.com/vllm-project/vllm/issues/36015), [#35863](https://github.com/vllm-project/vllm/issues/35863), [#38233](https://github.com/vllm-project/vllm/issues/38233), [#47614](https://github.com/vllm-project/vllm/issues/47614); PRs [#45022](https://github.com/vllm-project/vllm/pull/45022), [#45833](https://github.com/vllm-project/vllm/pull/45833), [#47615](https://github.com/vllm-project/vllm/pull/47615)
- [HF model card](https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602), [HF API metadata](https://huggingface.co/api/models/mistralai/Voxtral-Mini-4B-Realtime-2602), [HF discussion #25, 4090 concurrency](https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602/discussions/25), [Voxtral Realtime paper](https://arxiv.org/pdf/2602.11298)
- [transformers voxtral_realtime docs](https://huggingface.co/docs/transformers/model_doc/voxtral_realtime)
- [llama.cpp multimodal docs](https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md), issues [#19696](https://github.com/ggml-org/llama.cpp/issues/19696), [#20914](https://github.com/ggml-org/llama.cpp/issues/20914)
- [audio.cpp](https://github.com/0xShug0/audio.cpp), [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp), [transcribe.cpp Voxtral Realtime doc](https://github.com/handy-computer/transcribe.cpp/blob/main/docs/models/voxtral-realtime.md), [mistral-inference, archived](https://github.com/mistralai/mistral-inference)
- Docker Hub v2 API, `vllm/vllm-openai` tag sizes, queried 2026-08-11
- Local machine state measured 2026-08-11 via `nvidia-smi`, `wsl --status`, `wsl --version`, the `Lxss` registry key, `fsutil sparse queryflag`, `Get-CimInstance Win32_OperatingSystem` and `Get-PSDrive`
