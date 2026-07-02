/**
 * lib.ts — shared helpers for the Hermes engine Worker.
 * GitHub REST calls, markdown link-health checking, and the Anthropic
 * API call used for AI-drafted fixes. Kept dependency-free (raw fetch)
 * since Workers don't need a GitHub SDK for this small a surface.
 */

const GITHUB_API = "https://api.github.com";

export function ghHeaders(token?: string): HeadersInit {
  const h: HeadersInit = {
    Accept: "application/vnd.github+json",
    "User-Agent": "hermes-engine-worker",
  };
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

export async function getFile(
  owner: string,
  repo: string,
  path: string,
  token?: string
): Promise<{ content: string; sha: string } | null> {
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`,
    { headers: ghHeaders(token) }
  );
  if (!res.ok) return null;
  const json: any = await res.json();
  if (json.encoding !== "base64") return null;
  return { content: atob(json.content.replace(/\n/g, "")), sha: json.sha };
}

export async function getOpenIssueCount(
  owner: string,
  repo: string,
  token?: string
): Promise<number | null> {
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}?fields=open_issues_count`,
    { headers: ghHeaders(token) }
  );
  if (!res.ok) return null;
  const json: any = await res.json();
  return typeof json.open_issues_count === "number" ? json.open_issues_count : null;
}

/** Extracts markdown-style links [text](url) from a string. */
export function extractLinks(markdown: string): { text: string; url: string }[] {
  const links: { text: string; url: string }[] = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    links.push({ text: m[1], url: m[2] });
  }
  return links;
}

/** HEAD (falling back to GET) a URL to see if it's dead. Best-effort, short timeout. */
export async function isLinkDead(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    let res = await fetch(url, { method: "HEAD", signal: controller.signal, redirect: "follow" });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, { method: "GET", signal: controller.signal, redirect: "follow" });
    }
    return res.status >= 400;
  } catch {
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

export async function createBranch(
  owner: string,
  repo: string,
  newBranch: string,
  fromBranch: string,
  token: string
): Promise<boolean> {
  const refRes = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${fromBranch}`,
    { headers: ghHeaders(token) }
  );
  if (!refRes.ok) return false;
  const refJson: any = await refRes.json();
  const sha = refJson.object?.sha;
  if (!sha) return false;

  const createRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${newBranch}`, sha }),
  });
  return createRes.ok || createRes.status === 422;
}

export async function updateFile(
  owner: string,
  repo: string,
  path: string,
  branch: string,
  newContent: string,
  sha: string,
  message: string,
  token: string
): Promise<boolean> {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`, {
    method: "PUT",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: btoa(newContent),
      sha,
      branch,
    }),
  });
  return res.ok;
}

export async function openDraftPR(
  owner: string,
  repo: string,
  head: string,
  base: string,
  title: string,
  body: string,
  token: string
): Promise<string | null> {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ title, head, base, body, draft: true }),
  });
  if (!res.ok) return null;
  const json: any = await res.json();
  return json.html_url || null;
}

/**
 * Calls Claude (claude-sonnet-4-6) to draft a corrected README section
 * given a list of dead links. Returns null if no API key is configured
 * or the call fails — callers must treat that as "report only, no fix."
 */
export async function draftLinkFix(
  apiKey: string | undefined,
  readme: string,
  deadLinks: { text: string; url: string }[]
): Promise<string | null> {
  if (!apiKey || deadLinks.length === 0) return null;

  const prompt = `You are fixing dead links in a README.md file. Here are the dead links found (HTTP error or timeout):
${deadLinks.map((l) => `- [${l.text}](${l.url})`).join("\n")}

Here is the full README content:
---
${readme}
---

Return ONLY the full corrected README markdown with the dead links either removed (if no replacement is obvious) or replaced with a reasonable working equivalent. Do not add commentary. Do not wrap in code fences. If you cannot confidently fix a link, leave it as-is rather than guessing a URL.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) return null;
  const json: any = await res.json();
  const textBlock = (json.content || []).find((b: any) => b.type === "text");
  return textBlock?.text?.trim() || null;
}
