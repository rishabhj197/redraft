# A Redraft that works outside the browser

This is a design note, not a build plan for this week. The Chrome extension stays the product you use. What follows is how a later desktop app could offer the same hints in WhatsApp, Word, Slack, Google Docs, and mail apps, without becoming a different product.

The rule does not change. Redraft hints. It does not hand over a finished paragraph. The desktop app shows the same card the extension shows — your words, a shorter or sharper alternative, a one-line reason — and nothing in the document changes until you apply one hint.

## What "every interface" can honestly mean

No single program can see the text inside every app. Some apps draw real text the operating system can read. Some draw text as pixels (Google Docs does this). Some are a browser inside a desktop window. The practical goal is:

- One gesture that is the same everywhere: you are in a field, or you have selected a passage, and you press a shortcut.
- Hints for that passage, on screen, near the cursor.
- Apply replaces only the span the hint named.
- Where the app cannot see the text, it says so and offers the clipboard, rather than guessing.

Sites the extension already covers (Gmail and Notion in Chrome) stay on the extension. The desktop app is for the places a content script cannot go.

## The approaches

### 1. Select, then a hotkey (Tauri, Windows first)

A small desktop app sits in the tray. You select the words you want help with, or you are simply in a text field, and you press the same kind of shortcut the extension uses. The app reads that passage, asks for hints, and draws the panel.

Tauri is the right shell for this. It is a small native window plus a web view, so the panel can be the same idea as the extension's widget, and the hint logic can stay in the shared library. Windows comes first because that is the machine this needs to be proven on. macOS is the same app later, with a different way of reading the focused field (below). A Mac build that has not been tried on a Mac is not a feature.

This approach is the one to build. On its own it does not know how to read Word. It needs one of the reading methods below. The hotkey-and-panel half is the product. The reading half is a set of fallbacks.

**Limits.** A global hotkey can collide with other apps. The panel must not steal focus from the field, or the apply step will type into the wrong place. The app should do nothing when no text field is focused and nothing is selected.

### 2. Accessibility APIs (Windows UI Automation, macOS Accessibility)

Windows UI Automation and the macOS accessibility API are how a screen reader reads the focused control. If the control exposes its text — many native fields, a lot of Word, some Electron apps — Redraft can read the passage and write a replacement back through the same API.

This is the best way to change a span without touching the rest of the document, and it is the best chance of keeping the app's own undo (Ctrl+Z). It is also the only way that does not pretend the clipboard is the document.

**Limits.** Apps choose what to expose.

- Slack's desktop app and WhatsApp's desktop app are built on web technology. Some of their fields show up as text controls. Some do not, and a WhatsApp update can take the text away again. Treat success here as something you re-check, not as a promise.
- Word usually exposes text, but a selection inside a table, a comment, or a content control often does not. The app should detect "I can see a selection" versus "I can only see that a document is open".
- If the API returns the whole document, Redraft must still send only the selection or the paragraph around the caret. Reading a whole contract into a model call is a privacy failure even when the API allows it.
- Writing back through accessibility is slower and flakier than typing. If the write fails, do not fall through into a silent clipboard paste.

macOS is the same idea with a different API, and it needs the user to grant accessibility permission in System Settings. That permission is broad. The app should ask for it only when the Windows version has already proved the gesture is worth it, and the first-run screen should say, in one sentence, that the permission is how the app reads the field you are in, not how it watches the screen.

### 3. Clipboard fallback

When the field cannot be read, the shortcut copies the selection (the usual copy command), the app reads the clipboard, shows hints, and — only if you apply one — copies the replacement and pastes it over the selection.

**Limits.** This is a blunt tool.

- It replaces the whole selection, so the hint's span must be the selection, or the app must refuse. Pasting a single word over a paragraph you did not mean to replace is the failure this product exists to avoid.
- It clobbers whatever you had copied. The app should put the previous clipboard contents back after a successful paste, and it should not touch the clipboard at all until you press the shortcut.
- Paste does not always land in the app that had focus, and it often wipes that app's undo stack. Say so on the panel when this path is the one in use: "This will paste over the selection."
- If nothing is selected, do not send Ctrl+C. That is how you copy a whole document by accident.

Use the clipboard only as the fallback, and label it on the panel so you can feel which path you are on.

### 4. An input method, or a keyboard hook

An input method (the thing you use to type Chinese, Japanese, or a special keyboard) sits inside every keystroke. A low-level keyboard hook does the same from outside. Either one could, in theory, watch what you type in any app.

Do not build this.

- It is the architecture of a keylogger. Even a careful one will be treated as one by Windows, by antivirus, and by anyone you show it to.
- It fights real input methods. If you ever type in another language, or dictate, it will break that.
- It invites the app to rewrite as you type. That is the opposite of a hint you choose to apply.
- The security review for a store listing, or for a company laptop, will stop here.

A shortcut you press on purpose is consent. A hook that sees every key is not.

### 5. A companion overlay

The panel itself should be a small always-on-top window, drawn by the desktop app, not injected into the other program. The extension uses a shadow DOM widget because it lives inside the page. Word and WhatsApp will not allow that. The overlay is the same cards: category, your span, the suggestion, the reason, Apply, Dismiss. Esc closes it. The apply shortcut applies the first hint and only the first hint.

The overlay does not read the screen. It displays what the hotkey path already fetched. It should not be a permanent bar. It appears when there are hints and goes away when you dismiss it or apply the last one.

**Limits.** Always-on-top windows get lost behind full-screen apps, and some games and meeting apps refuse them. That is acceptable. Position it near the caret when the accessibility API can say where the caret is, and near the mouse when it cannot.

## Google Docs, and other canvas editors

Google Docs draws text onto a canvas. A Chrome extension cannot read it. Accessibility APIs often cannot read it either, beyond a thin approximation that lags and misses formatting. There is no honest "live hints inside the Docs caret" design.

The desktop path for Docs is the clipboard fallback on an explicit selection, with the panel saying that Docs cannot be read directly. The extension should continue to refuse Docs rather than ship a broken content script. If a later Docs API appears that returns the selection to a signed-in add-on, that is a separate, smaller project, and it still has to hint rather than replace the paragraph.

The same rule covers any app that paints text: if we cannot point at the exact characters, we do not invent a match.

## Privacy

- The hotkey is the moment text is allowed to leave the field. Nothing is read in the background, and nothing is read from a window you have not invoked Redraft in.
- Prefer the selection, or the paragraph around the caret. Do not send the whole document because the API offered it.
- The model call is the only network hop for the text. Logs on the machine may keep the span and the suggestion. They should not keep a copy of every field you focused.
- Accessibility permission and a global hotkey are powers you can explain in a sentence. A keyboard hook is not. Do not take the permission you cannot explain.
- WhatsApp and mail contain other people's words. The lexicon stores the word you applied, not the chat it came from.

## Sharing one core with the extension

The extension's `lib/` folder is already the core: prompt assembly, the hint checks, the model request, the budget guard, and the eval runner. The desktop app should call that code, not grow a second prompt.

A sensible order:

1. **Now.** Use the extension. Do not start the desktop app until hints in Gmail and Notion are something you trust.
2. **Spike, Windows only.** A Tauri tray app. Shortcut, overlay, clipboard fallback. Prove it on Notepad first (easy), then Word (accessibility), then one Electron app (Slack or WhatsApp). Each either works or is written down as clipboard-only. Stop at the budget guard, same as the extension.
3. **Shared library.** Once the spike calls `buildSystemPrompt` and the hint guards for real, move `lib/` into a package both the extension and the desktop app import. Do it then, not before, or the package will be a second copy that drifts.
4. **Accessibility where it worked in the spike.** UI Automation for the apps that exposed text. Clipboard remains the labelled fallback.
5. **macOS.** Same overlay and the same library. Accessibility permission, tested on a Mac, not assumed from the Windows code.
6. **Backend.** When the desktop app exists, it should call the same place the extension will call in Phase 2 (see `docs/backend-and-evals.md`), so a hint accepted in Word and a hint accepted in Gmail land in one lexicon. Until that backend exists, the desktop app can hold its own local list, the way the extension does now.

The eval harness stays the judge of the prompt. The desktop app does not get its own prompt. A prompt change is a `PROMPT_VERSION` bump, a harness run, and both apps pick it up because they share the library.

## Recommendation

Build, later, a Windows Tauri app whose only gesture is a shortcut on a selection or the focused field. Show hints in an overlay. Apply one hint at a time. Read and write through Windows UI Automation when the control actually exposes the text, and use the clipboard only as a labelled fallback when it does not. Do not build an input method or a keyboard hook. Treat Google Docs as clipboard-on-selection, and keep the extension out of Docs. Share `lib/` with the extension once the spike is calling it for real, and point both at one backend only when that backend exists for a reason you already feel.

Until then the extension is the product, and this document is the map so the desktop work does not start from a different idea of Redraft.
