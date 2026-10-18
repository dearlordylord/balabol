# Balabol

**Purpose:** Define the product's shared language.
**Audience:** Product owners and contributors, including coding agents.
**Status:** Active.
**Authority:** User-confirmed terminology from the prototype scope discussion.
**Expected use:** Use these terms in requirements, interfaces, and behavior descriptions.
**Lifecycle:** Update when a domain term is agreed or its meaning changes.

Balabol is a personal conversational assistant with one enduring conversation.

## Language

**Conversation**:
The single continuing exchange between the user and the assistant. Ending a voice session or restarting the application does not create another conversation.
_Avoid_: Chat collection, conversation picker

**Voice session**:
A period of live spoken interaction within the conversation. The same conversation can continue across many voice sessions.

**Memory**:
The enduring record and retained context of the conversation, available to the assistant across voice sessions.

**Recognition hypothesis**:
Temporary text that may change before an utterance is finalized. It is not a saved message.

**Finalized utterance**:
A finished recognition result. It becomes part of the conversation only after acceptance.

**Accepted input**:
A user message confirmed as durably saved in the single conversation. Rechecking its acceptance does not create another message.

**Interrupted reply**:
Assistant text collected before a response was stopped. The saved text may include words whose audio the user did not hear; it does not imply user agreement.

**Microphone mute**:
Stops microphone input without cancelling captured speech recognition, durable admission, reply generation or playback. It is separate from ending a voice session or interrupting an assistant reply.
