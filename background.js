const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1024;

const STYLE_PROMPTS = {
  plain:
    "Rewrite the user's text following George Orwell's rules for clear writing: prefer short, plain words over long or fancy ones, cut every word that isn't doing work, use the active voice, and never use a long word where a short one will do.",
  classic:
    "Rewrite the user's text in the classic prose style described by Thomas & Turner in Clear and Simple as the Truth: confident and unhedged, presenting the truth rather than explaining or arguing for it, as if it were self-evident. State things as direct, declarative fact. Do not hedge through generic constructions like \"one must\" or \"one should\", and do not soften statements with qualifiers — the writer sees the truth clearly and simply says it.",
  warm:
    "Rewrite the user's text in a warm, conversational tone: use contractions, address the reader directly in the second person, and write as if speaking to a friend.",
};

const KEATING_RULE =
  "Also apply the Keating rule: eliminate lazy intensifiers and vague qualifiers (such as \"very\", \"really\", \"quite\", \"extremely\") and replace them with a single precise, stronger word.";

const NO_OP_INSTRUCTION =
  "If the text already fits the target style and cannot be meaningfully improved, return it completely unchanged. Do not make edits for their own sake.";

const OUTPUT_INSTRUCTION =
  "Return only the rewritten text. Do not include any preamble, explanation, labels, or surrounding quotation marks.";

function buildSystemPrompt(style) {
  const base = STYLE_PROMPTS[style] ?? STYLE_PROMPTS.plain;
  return `${base} ${KEATING_RULE} ${NO_OP_INSTRUCTION} ${OUTPUT_INSTRUCTION}`;
}

async function redraft(text, style, apiKey) {
  let response;
  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: buildSystemPrompt(style),
        messages: [{ role: "user", content: text }],
      }),
    });
  } catch (error) {
    console.log("Redraft: network error calling the Anthropic API.", error.message);
    return;
  }

  if (!response.ok) {
    const body = await response.text();
    console.log("Redraft: Anthropic API request failed.", {
      status: response.status,
      body,
    });
    return;
  }

  const data = await response.json();
  const redraftText = data.content?.[0]?.text ?? "";

  console.log("Redraft: original text", text);
  console.log("Redraft: redrafted text", redraftText);
  console.log("Redraft: usage", data.usage);
}

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
    const apiKey = result.apiKey;
    const style = result.style ?? "plain";

    if (!apiKey) {
      console.log("Redraft: no API key saved. Set one on the options page.");
      return;
    }

    redraft(message.text, style, apiKey);
  });
});
