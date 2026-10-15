# Speech-to-Text on the Strix Halo box

Sets up a single always-on Whisper service that speaks the OpenAI API, shared by
Todo XP voice capture, laptop dictation, and Home Assistant voice.

```
Strix Halo box (10.0.0.156)
├─ :1234  LM Studio     gpt-oss-120b          (already running)
└─ :8081  whisper.cpp   large-v3-turbo        ← this document
             │
             ├── Todo XP voice capture       (WHISPER_BASE_URL)
             ├── laptop push-to-talk dictation
             └── Home Assistant voice        (via wyoming_openai on :10300)
```

One resident model, one endpoint — `POST /v1/audio/transcriptions` — and every
consumer is an off-the-shelf client. No glue code anywhere.

---

## Why whisper.cpp and not faster-whisper

`faster-whisper` / `speaches` is the usual recommendation, but its GPU backend
(CTranslate2) is **CUDA-only**, so on an AMD iGPU it silently falls back to CPU.
That matters more than it sounds:

| Backend | large-v3 throughput | 10s clip |
|---|---|---|
| Radeon 8060S iGPU (Vulkan) | ~10–11.5x realtime | **~1s** |
| CPU | ~1.2x realtime | ~8s |

whisper.cpp has a working Vulkan and ROCm path on gfx1151, so it's the one that
actually uses the hardware.

Use the **`large-v3-turbo`** model: roughly 8x faster than `large-v3` at
essentially the same accuracy, which puts a typical utterance around 0.3s.

---

## 1. Model

```bash
sudo mkdir -p /srv/whisper/models && cd /srv/whisper/models
sudo curl -LO https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
```

~1.6GB. If you later want a lower latency floor for dictation, grab
`ggml-large-v3-turbo-q8_0.bin` (~874MB) as well — on a bandwidth-bound iGPU the
quantised model is often *faster*. whisper.cpp serves one model per process, so
run it as a second container on another port rather than swapping.

## 2. Container

Use the [Strix Halo toolbox images](https://github.com/dohr-michael/whisper-strix-halo-toolboxes),
built specifically for gfx1151. Start with **`vulkan-radv`** — Mesa is already
installed on Fedora, so there's no ROCm stack to set up, and Vulkan needs only
`/dev/dri` (ROCm also wants `/dev/kfd`).

```bash
podman run -d --name whisper \
  --device /dev/dri \
  --security-opt label=disable \
  -p 8081:8080 \
  -v /srv/whisper/models:/models:ro \
  --entrypoint whisper-server \
  ghcr.io/dohr-michael/whisper-strix-halo-toolboxes:vulkan-radv \
  -m /models/ggml-large-v3-turbo.bin \
  --host 0.0.0.0 --port 8080 \
  --inference-path /v1/audio/transcriptions \
  --language en --threads 8 --convert
```

Three deliberate changes from that repo's stock compose file:

- **`-p 8081:8080`, not `127.0.0.1:8081:8080`.** Upstream binds loopback-only.
  Todo XP runs on the Coolify host — a different machine — so loopback means it
  can never reach the service. This is the one that bites silently.
- **`--language en`, not `--language auto`.** Auto-detection costs an extra pass
  and genuinely misfires on short utterances, which is nearly all of this traffic.
- **`--security-opt label=disable`** (kept from upstream). Fedora runs SELinux
  enforcing; without it the device and volume mounts get denied.

`--convert` pulls in ffmpeg so the server accepts webm/opus/mp4 as well as WAV.
Todo XP sends 16kHz WAV regardless, but it makes every other client work
without thinking about codecs.

## 3. Verify

```bash
curl -s http://localhost:8081/v1/audio/transcriptions \
  -F file=@sample.wav -F response_format=json
```

Measured on this box (10.0.0.156) with `large-v3-turbo` and the Vulkan image:
an 11-second clip transcribed in **~0.39s**, about 29x realtime. Anything near
8s for that clip means it is running on CPU.

Note there is no `/v1/models` endpoint — whisper.cpp serves one resident model
and 404s that path. Use a real transcription request to health-check it.

Check `podman logs whisper` on startup and confirm it picked up the Radeon
8060S. **If it says CPU, Vulkan didn't attach** — you'll feel it immediately
(~8s per clip instead of under 1s). If Vulkan won't cooperate, switch the tag to
`rocm-fedora43` and add `--device /dev/kfd`.

## 4. Survive reboots

Fedora's current path is a Podman **Quadlet** — `podman generate systemd` is
deprecated.

```ini
# /etc/containers/systemd/whisper.container
[Unit]
Description=whisper.cpp STT server (Strix Halo / Vulkan)
After=network-online.target
Wants=network-online.target

[Container]
Image=ghcr.io/dohr-michael/whisper-strix-halo-toolboxes:vulkan-radv
ContainerName=whisper
Entrypoint=whisper-server
PublishPort=8081:8080
Volume=/srv/whisper/models:/models:ro
AddDevice=/dev/dri
SecurityLabelDisable=true
Exec=-m /models/ggml-large-v3-turbo.bin --host 0.0.0.0 --port 8080 --inference-path /v1/audio/transcriptions --language en --threads 8 --convert

[Service]
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl start whisper
```

Rootful keeps `/dev/dri` passthrough simple — no `video`/`render` group juggling
and no `loginctl enable-linger`.

## 5. Firewall

Fedora runs firewalld by default. Scope the port to the LAN rather than opening
it outright:

```bash
sudo firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=10.0.0.0/24 port port=8081 protocol=tcp accept'
sudo firewall-cmd --reload
```

**whisper.cpp's server has no authentication.** Keep it LAN-only; never port-forward
it. (Same treatment LM Studio on :1234 already has.)

---

## 6. Wire up Todo XP

That's the entire infrastructure dependency. In the app's environment:

```sh
WHISPER_BASE_URL=http://10.0.0.156:8081/v1
WHISPER_API_KEY=
```

There's no `WHISPER_MODEL` — whisper.cpp serves a single resident model, so the
app's `isWhisperConfigured()` keys on the base URL alone. Leave it unset and the
mic button simply doesn't render, exactly like the existing `LLM_BASE_URL`
features.

## 7. Laptop dictation

Several maintained clients already speak "any OpenAI-compatible
`/v1/audio/transcriptions`" — point them at `http://10.0.0.156:8081/v1`:

- [whisper-talk](https://github.com/aljazceru/whisper-talk) — system-wide, with
  push-to-talk / toggle / auto modes.
- [driegert/whisper-dictate](https://github.com/driegert/whisper-dictate) — a
  single bash script; hotkey, speak, hotkey, text is pasted at the cursor.
  Easiest to read and modify.
- [OpenWhispr](https://openwhispr.com/) — fullest package (tray app, optional AI
  post-formatting), cross-platform.

Check **X11 vs Wayland** before picking: text injection differs (`xdotool` vs
`wtype`/`ydotool`), and Wayland's input isolation pushes most tools to
clipboard-paste instead of synthetic typing. On GNOME/Wayland, clipboard-paste is
the reliable route.

## 8. Home Assistant voice

HA's voice pipeline speaks the **Wyoming** protocol, not OpenAI.
[`wyoming_openai`](https://github.com/roryeckel/wyoming_openai) is a drop-in
translator — run it as a small second container:

```yaml
services:
  wyoming-openai:
    image: ghcr.io/roryeckel/wyoming_openai:latest
    restart: unless-stopped
    ports:
      - "10300:10300"
    environment:
      WYOMING_URI: tcp://0.0.0.0:10300
      STT_OPENAI_URL: http://10.0.0.156:8081/v1
      STT_MODELS: whisper-1
      WYOMING_LANGUAGES: en
```

Then in HA: **Settings → Devices & Services → Add Integration → Wyoming
Protocol**, URI `tcp://10.0.0.156:10300`. Select it as the STT engine in your
Assist pipeline.

### The latency trap

STT stops being the bottleneck the moment you do this — and the conversation
agent becomes it. On Strix Halo, `gpt-oss-120b` prefills at roughly 400–730
tok/s and decodes at ~50 tok/s. HA's LLM prompt includes every exposed entity
and its state, so a typical 1–3k-token prompt costs **2–5 seconds before the
first token**. Budget:

| Stage | Cost |
|---|---|
| STT (whisper turbo, iGPU) | ~0.3s |
| `gpt-oss-120b` conversation agent | **2–5s** |
| TTS (Piper, local) | ~0.2s |

Three levers, in order of effect:

1. **Turn on "prefer handling commands locally."** HA matches built-in intents
   first and only falls through to the LLM when nothing matches. "Turn on the
   kitchen lights" then never touches the model and lands in well under a
   second; only open questions pay the LLM cost, where a few seconds is fine.
2. **Expose only the entities you actually voice-control.** Prompt size is the
   single biggest input to prefill time, and most HA installs expose far more
   than they need.
3. **Consider a second, smaller model for HA.** `gpt-oss-20b` prefills ~1900
   tok/s and decodes ~73 tok/s — several times quicker end to end. LM Studio can
   hold both resident (~60GB + ~12GB against your 128GB), so Todo XP can keep
   using the 120b while HA talks to the 20b.

HA's built-in OpenAI integration doesn't expose a custom base URL, so to point a
conversation agent at LM Studio you need one of the community integrations —
[ha-openai-compatible](https://github.com/adamjs83/ha-openai-compatible) or
[extended_openai_conversation](https://github.com/jekalmin/extended_openai_conversation).

TTS is worth leaving on Piper at the HA end — it's fast and the quality gap
rarely justifies another GPU service. If you do want Kokoro later, the same
`wyoming_openai` bridge carries TTS as well.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| ~8s per clip | Vulkan didn't attach; check `podman logs whisper` for the device line |
| Todo XP can't reach it, `curl` on the box works | Port bound to `127.0.0.1`, or firewalld blocking the LAN |
| Permission denied on `/dev/dri` or `/models` | Missing `--security-opt label=disable` (SELinux) |
| Garbled transcript of short utterances | `--language auto` guessing wrong; pin `--language en` |
| 400 on upload | Non-WAV input without `--convert` |
| Silence transcribes as "Thank you." | Known Whisper behaviour — see below |

## Silence hallucination

Whisper invents text for silence, confidently. On this setup, 0.5s of digital
silence transcribes as `" Thank you."`. Other common artifacts are "Thanks for
watching!", "you", "Bye." and Amara.org subtitle credits.

**`no_speech_prob` does not help.** Measured here it was `7.9e-11` for pure
silence against `1.7e-10` for real speech — the same order of magnitude, so it
cannot be thresholded. `avg_logprob` (-0.29 vs -0.08) separates them a little
but the ranges overlap too much to rely on.

Todo XP defends in two places: the recorder won't upload audio whose level
never crossed a noise floor, and `src/server/llm/transcribe.ts` drops
transcripts matching a short list of known artifacts. Anything else you point
at this server — dictation, Home Assistant — should expect the same behaviour
and gate on input level rather than on Whisper's own confidence fields.
