const apiKeyInput = document.getElementById("api-key");
const styleSelect = document.getElementById("style");
const saveButton = document.getElementById("save");
const status = document.getElementById("status");

function loadSaved() {
  chrome.storage.local.get(["apiKey", "style"], (result) => {
    if (result.apiKey) apiKeyInput.value = result.apiKey;
    if (result.style) styleSelect.value = result.style;
  });
}

function save() {
  const apiKey = apiKeyInput.value.trim();
  const style = styleSelect.value;

  chrome.storage.local.set({ apiKey, style }, () => {
    status.textContent = "Saved";
    setTimeout(() => {
      status.textContent = "";
    }, 2000);
  });
}

saveButton.addEventListener("click", save);
loadSaved();
