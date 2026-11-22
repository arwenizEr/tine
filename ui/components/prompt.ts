/** Asks for a file or folder name. Resolves to null on cancel. */
export function promptName(title: string, initial = ""): Promise<string | null> {
  return new Promise((done) => {
    const restore = document.activeElement as HTMLElement | null;
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const form = document.createElement("form");
    form.className = "modal";
    const label = document.createElement("label");
    label.textContent = title;
    const input = document.createElement("input");
    input.value = initial;
    input.spellcheck = false;
    input.autocomplete = "off";
    const error = document.createElement("div");
    error.className = "modal-error";
    error.setAttribute("aria-live", "polite");
    label.append(input);
    form.append(label, error);
    backdrop.append(form);
    document.body.append(backdrop);

    const finish = (value: string | null) => {
      backdrop.remove();
      restore?.focus();
      done(value);
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name || name === "." || name === ".." || name.includes("/")) {
        error.textContent = "Enter a name without “/”.";
        return;
      }
      finish(name);
    };
    input.onkeydown = (e) => {
      if (e.key === "Escape") finish(null);
    };
    backdrop.onmousedown = (e) => {
      if (e.target === backdrop) finish(null);
    };
    input.focus();
    // Select the name without its extension, as Finder does.
    const dot = initial.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  });
}
