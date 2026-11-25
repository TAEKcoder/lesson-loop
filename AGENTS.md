# Classroom player release rules

- New work belongs in `next/`, then a new immutable `dist/releases/<version>/` directory. Keep older published release directories intact.
- `dist/release.json` announces an available release. It must never automatically select it. Apply only after the user clicks the update button; persist their chosen release locally.
- Keep the legacy root player stable apart from the manual update entry point. Do not reload or navigate the user's active class tab while they are teaching.
- The user has requested silent testing during class. Keep their player at volume 0, and route signal tests exclusively to a virtual audio sink. Do not restore audible volume without their instruction.
- Use an isolated preview origin for update-button and layout QA, so tests cannot alter the active class's selected release or stored library.
- Original user music stays in IndexedDB or local backup files. Never include it in published assets. QA fixtures and pages must be outside the deployable `dist/` before packaging.
- Every playback fix must cover real source timing, not only playhead UI and mocks. Preserve native 0.8x pitch and the requested rate across decoder resets.

- Layout preference: preserve the original outer teacher-sidebar and main-content layout. Place week buttons only inside the player card's left grid column, rather than introducing a global week rail or moving the teacher sidebar.
- Loudness correction is opt-in and defaults to 0 dB. Do not equate a UI100% value with another app's internal output gain, and do not raise the user's current volume automatically.

- Fade visuals represent the transport envelope and follow the audio context clock. Keep them display-only; do not add fake audio signal levels or alter the audio path for animation. Keep a separate visible mute indication.

- Desktop Safari uses native HTMLAudio output and native volume fades. Reuse its authorized media element across PCM decoder resets; keep Web Audio and optional gain out of that compatibility path.
- Use changeRate() for running playback, preserving the paused source position and canceling pending resume on stop/source change. Disable source-dependent controls until preparePosition() has completed.
- Native output signal QA must enforce irreversible mute on test elements; captureStream may feed only a virtual stream recorder, never a physical output. Never unmute the active Safari classroom for testing.

- Warmup auto-next uses sequential fades and one prepared successor, never overlapping native Safari elements. Manual stop, source selection, restore, or edits must cancel pending automatic play. Invalidate prepared audio on source replacement/removal/restore.
- Trimming is non-destructive absolute source time; never rewrite original audio or shift week timestamps. Automatic silence detection only suggests a draft, and Save applies it. Keep single-track repeat separate from auto-next/list repeat.
