const form = document.querySelector<HTMLFormElement>("#pairing-form")!;
const input = document.querySelector<HTMLInputElement>("#token")!;
const statusElement = document.querySelector<HTMLElement>("#status")!;

void browser.storage.local.get("pairingToken").then((stored) => {
  if (typeof stored.pairingToken === "string")
    input.value = stored.pairingToken;
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void browser.storage.local
    .set({ pairingToken: input.value.trim() })
    .then(() => {
      statusElement.textContent = "Paired. You can close this tab.";
    });
});

export {};
