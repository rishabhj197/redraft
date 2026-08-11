chrome.commands.onCommand.addListener((command) => {
  if (command !== "trigger-redraft") return;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.id) return;

    chrome.tabs.sendMessage(tab.id, { type: "REDRAFT_CAPTURE" }, () => {
      if (chrome.runtime.lastError) {
        console.log(
          "Redraft: could not reach the content script on this tab.",
          chrome.runtime.lastError.message
        );
      }
    });
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "REDRAFT_TEXT") return;

  chrome.storage.local.get(["apiKey", "style"], (result) => {
    console.log({
      text: message.text,
      style: result.style ?? null,
      hasApiKey: Boolean(result.apiKey),
    });
  });
});
