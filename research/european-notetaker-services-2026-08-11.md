# European plug-and-play notetaker services (Fireflies equivalents)

**Date:** 2026-08-11
**Question:** find European, GDPR-compliant, plug-and-play meeting-notetaker services, equivalent to Fireflies.
**Companion docs:** [gdpr-review-2026-08-10.md](gdpr-review-2026-08-10.md) (the compliance gaps this is meant to close), [european-stt-providers-2026-08-11.md](european-stt-providers-2026-08-11.md) (the build-it-yourself alternative)

---

## The finding that changes the question

**"European notetaker" does not mean "no US processors". It means the US processors become someone else's contractual problem.**

jamie (Berlin) is the most widely recommended GDPR-first notetaker in this category. Its own published Art 28 DPA names **14 sub-processors**. Among them:

| Sub-processor | Established | Role | Hosting | Transfer basis |
|---|---|---|---|---|
| **Eleven Labs Inc.** | New York, USA | **"Transcription Provider"** | EU | SCCs (Art 46) |
| **Soniox Inc.** | California, USA | **"Transcription Provider"** | EU | SCCs |
| Modal Labs, Inc. | New York, USA | Infrastructure (serverless GPU) | EU | SCCs |
| Google Cloud EMEA | Dublin, Ireland | Cloud, Vertex AI | EU | EU-US DPF + SCCs |
| PlanetScale | San Francisco | Database | EU | SCCs |
| Cloudflare | San Francisco | Infrastructure | EU | SCCs |
| Paragon | Los Angeles | Integrations | EU | SCCs |
| Sentry, PostHog | San Francisco | Monitoring, analytics | EU | SCCs |
| WorkOS | San Francisco | SSO (metadata only) | **US** | SCCs |
| Loops | Washington DC | Marketing | **US** | SCCs |
| Plain | UK | Support | UK | UK adequacy |
| Langfuse GmbH | Berlin | LLM observability | EU | none |
| Better Stack | Prague | Logging | EU | none |

And from jamie's own data-handling docs: audio is uploaded to Frankfurt, processed on **Modal's serverless GPU**, then the transcript "is further processed via an **Anthropic or OpenAI** API to generate your meeting notes". Audio is deleted after processing; transcripts stay in Frankfurt.

**So switching from Tandem-on-ElevenLabs to jamie means sending client audio to ElevenLabs, via a German intermediary.** Plus Anthropic or OpenAI for the notes, which is also what Tandem does today.

To be clear, this is not a gotcha and jamie deserves credit: they publish the full list, name the transfer basis per sub-processor, and pin hosting to the EU. That transparency is exactly why this was checkable at all. Most competitors in this category do not publish anything comparable.

## Why buying still helps, and it is not the reason you would guess

The review found you are a **controller** with roughly one of the six required things in place. Missing: Art 28 contracts with each vendor, your own transfer mechanism, a lawful basis, Art 13 notice, a ROPA, and an Art 15(4) redaction mechanism.

A service like jamie does not remove US processors from the chain. What it removes is **your obligation to paper them yourself**:

- One Art 28 DPA with one EU-established controller-facing processor, instead of three (ElevenLabs, Mistral, Anthropic) that you currently do not have.
- Their SCCs and transfer assessments, not yours.
- Their sub-processor notification duty under Art 28(2), not your unilateral vendor picks, which is what Art 28(10) currently converts into controller liability for you.
- A published retention policy you can point a client at.

For a solo consultant, that paperwork is the expensive part. That is the real value proposition, not data locality.

**What it does not fix:** your lawful basis and the § 201 StGB consent problem. Every vendor here still records the call. Consent cures both limbs and no purchase substitutes for it. Also unfixed: Art 15(4) third-party redaction, which none of these tools do for you.

## Candidates

Verification status is marked honestly. Almost every "best European notetaker" listicle is published by one of the vendors on it, so treat unverified rows as marketing until you read the DPA.

| Service | Established | Capture | Verified from primary source? | Notes |
|---|---|---|---|---|
| **jamie** | Berlin, DE | bot-free, device audio | **Yes** (DPA + docs read) | Frankfurt hosting, audio deleted after processing. Transcription by ElevenLabs/Soniox, notes by Anthropic/OpenAI. Closest match to how Tandem itself works. |
| **tl;dv** | Berlin, DE | bot + bot-free | Partial | GCP + AWS + Hetzner, all EU data centres; Wasabi S3. Publishes a DPA, granular retention controls, AI-training opt-out. **Sub-processor list not retrieved, get it before deciding.** |
| **Leexi** | Belgium | bot | No | Data stored and in transit within France, ISO 27001. Public materials thin on sub-processors and model-training behaviour. |
| **Happy Scribe** | Barcelona, ES | bot + bot-free | No | EU data centre, SOC 2 Type II, 120+ languages. Also a full transcription/subtitling platform, useful if you want the post-production side. |
| **Noota** | France | bot | No | EU data centres, claims ISO 27001 + SOC 2, states sub-processors held to the same standard. |
| **MeetGeek** | Romania | bot | No | Offers **US and EU** hosting, so EU residency is a configuration you must verify, not a default. |
| **Rekap** | Switzerland | bot | No | Swiss infrastructure, but runs **Azure OpenAI** in a private environment. Switzerland is adequacy-covered; the Azure dependency is the thing to check. |

## Bot vs bot-free matters more than it looks

- **Bot joins the call** (Fireflies, Leexi, Noota, MeetGeek, tl;dv optionally): a visible third-party participant. This is *helpful* for notice, everyone can see recording is happening, but adds friction, can breach platform terms, and clients may object to an unknown vendor's bot in a confidential call.
- **Bot-free device capture** (jamie, Happy Scribe, tl;dv optionally, and Tandem): no extra participant. Legally this is the *same* posture Tandem has today, so the § 201 StGB analysis in the review carries over unchanged. It removes a consent signal rather than adding one, so the explicit consent flow matters more, not less.

## Recommendation

1. **If the goal is to stop carrying compliance risk personally: jamie.** EU-established, bot-free like Tandem, genuinely transparent, and the DPA is signable today. Accept that ElevenLabs remains in the chain, as their sub-processor rather than your unpapered vendor. Verify the DPA is actually executed for your account.
2. **Get tl;dv's sub-processor list before ranking it.** German, EU-only hosting and it has the strongest feature set of the group, but the chain is unverified. It may well beat jamie once visible.
3. **If the goal is genuinely no third-party processor: none of these qualify.** That is the self-hosted path, and it is the one Tandem is already most of the way toward. Note the upstream project this repo forks from, Meetily, now markets exactly this as its differentiator.
4. **Whichever you pick, the consent flow is still yours to build.** It was the top gap yesterday and no vendor closes it.

## To verify before committing

- [ ] tl;dv sub-processor list (trust.tldv.io, or security@tldv.io)
- [ ] Leexi, Happy Scribe, Noota, MeetGeek sub-processor lists, specifically who does STT and who does the LLM summarisation
- [ ] Whether any client contract has confidentiality or sub-processor clauses that a cloud notetaker would breach, flagged as **VERIFY** in the GDPR review and still open
- [ ] Retention defaults and whether audio is deleted post-processing or kept

## Sources

- [jamie DPA and sub-processor list](https://www.meetjamie.ai/data-processing-agreement), [jamie data-handling docs](https://docs.meetjamie.ai/faqs-troubleshooting/data)
- [tl;dv Trust Center](https://trust.tldv.io/), [tl;dv security commitment](https://tldv.io/features/security-commitment/), [tl;dv privacy](https://tldv.io/privacy/)
- [Leexi](https://www.leexi.ai/en/), [Noota GDPR guide](https://www.noota.io/en/gdpr-ai-guide)
- [Happy Scribe: GDPR-compliant AI note takers](https://www.happyscribe.com/blog/best-gdpr-compliant-ai-note-takers), [bot-free note takers in Europe](https://www.happyscribe.com/blog/best-bot-free-ai-note-takers-in-europe) (vendor-published, treat as directional)
- [OpenAI sub-processor list](https://openai.com/policies/sub-processor-list/)
