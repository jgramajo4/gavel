"use strict";

// Progressive enhancement: with JavaScript off, every runtime remains readable.
const tablist = document.querySelector(".runtime-tabs");
const tabs = Array.from(tablist.querySelectorAll("a"));
const panels = tabs.map(tab => document.querySelector(tab.getAttribute("href")));
tablist.setAttribute("role", "tablist");

function selectTab(index, moveFocus = false) {
  tabs.forEach((tab, i) => {
    tab.setAttribute("aria-selected", String(i === index));
    tab.tabIndex = i === index ? 0 : -1;
    panels[i].hidden = i !== index;
  });
  if (moveFocus) {
    tabs[index].focus({ preventScroll: true });
    tabs[index].scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  }
}

tabs.forEach((tab, index) => {
  tab.setAttribute("role", "tab");
  tab.setAttribute("aria-controls", panels[index].id);
  panels[index].setAttribute("role", "tabpanel");
  panels[index].tabIndex = 0;
  tab.addEventListener("click", event => {
    event.preventDefault();
    selectTab(index);
  });
  tab.addEventListener("keydown", event => {
    let next;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    if (event.key === " ") next = index;
    if (next === undefined) return;
    event.preventDefault();
    selectTab(next, true);
  });
});

function selectHash() {
  const index = panels.findIndex(panel => `#${panel.id}` === location.hash);
  if (index !== -1) selectTab(index);
  return index;
}
selectTab(Math.max(0, selectHash()));
window.addEventListener("hashchange", selectHash);

document.querySelectorAll("[data-copy]").forEach(button => {
  button.hidden = false;
  let resetTimer;
  const originalLabel = button.textContent;
  button.addEventListener("click", async () => {
    const command = document.getElementById(button.dataset.copy);
    const status = document.getElementById("copy-status");
    clearTimeout(resetTimer);
    try {
      await navigator.clipboard.writeText(command.textContent);
      button.textContent = "Copied ✓";
      status.textContent = "Command copied to clipboard.";
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(command);
      selection.removeAllRanges();
      selection.addRange(range);
      command.closest("pre").focus();
      button.textContent = "Select & copy";
      status.textContent = "Clipboard unavailable. The command is selected; press Control+C or Command+C to copy.";
    }
    resetTimer = setTimeout(() => { button.textContent = originalLabel; }, 2500);
  });
});
