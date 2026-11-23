import { errorMessage, webOpen } from "../ipc.ts";
import { promptName } from "./prompt.ts";
import { toast } from "./toast.ts";
import { toWebUrl } from "./weburl.ts";

const LAST = "lastWebUrl";

/** Asks for an address and opens it in its own window, next to the terminal. */
export async function openWebPage(): Promise<void> {
  let last = "";
  try {
    last = localStorage.getItem(LAST) ?? "";
  } catch {}
  const text = await promptName("Open web page", last, (v) => (toWebUrl(v) ? null : "Enter a web address, such as youtube.com."));
  const url = text && toWebUrl(text);
  if (!url) return;
  try {
    localStorage.setItem(LAST, url);
  } catch {}
  await webOpen(url).catch((e) => toast(errorMessage(e)));
}
