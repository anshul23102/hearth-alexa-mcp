# Talking to Hearth

The simulator holds a spoken conversation, the way Alexa does:
- **Mic button** opens a conversation; **"Say Alexa"** (hands-free) waits for the wake word. After every spoken reply the mic re-opens for a follow-up with no wake word, and silence ends the conversation.
- **Context** carries across turns. Long conversations are trimmed at turn boundaries (never splitting a tool call from its result), so they no longer fail after about ten questions. The offline router also handles follow-ups ("what about the dog food?", "thanks", "no thanks"); full open-ended context needs the Bedrock brain.
- **Languages:** pick English (US or India), हिन्दी or Español; the wake word works in Devanagari too. With the Bedrock brain the model answers in whatever language you speak; the offline router's sentences exist in English, Spanish and Hindi.
- **The voice** is your browser's own text-to-speech. Hearth ranks the installed voices and picks the warmest natural one per language (a downloaded Premium or Enhanced voice always wins; on a Mac add one under System Settings, Accessibility, Spoken Content, System voice, Manage voices). Amazon's real Alexa voice is not available to third-party apps, so this is not that voice.
- **Privacy:** recognition uses the browser's speech service (Chrome sends the audio to Google). Nothing listens until you press the mic or turn hands-free on, the mic is closed while Alexa speaks, and there is no always-on background listening by default.
- **Limits:** no barge-in (you cannot interrupt her mid-sentence); hands-free needs Chrome and a quiet room; wake-word detection is plain speech recognition, not a trained hotword model, so it can miss or false-trigger.

