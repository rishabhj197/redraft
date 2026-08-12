function getFocusedText() {
  const el = document.activeElement;
  if (!el) return null;

  const tag = el.tagName ? el.tagName.toLowerCase() : "";

  if (tag === "textarea") {
    return el.value;
  }

  if (tag === "input" && el.type === "text") {
    return el.value;
  }

  if (el.isContentEditable) {
    return el.innerText;
  }

  return null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "REDRAFT_CAPTURE") return;

  const text = getFocusedText();

  if (text === null) {
    console.log(
      "Redraft: no textarea, text input, or contenteditable element is focused."
    );
    sendResponse();
    return;
  }

  chrome.runtime.sendMessage({ type: "REDRAFT_TEXT", text });
  sendResponse();
});
