/** Shows a short message at the bottom of the window. */
export function toast(message: string): void {
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "alert");
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 4000);
}
