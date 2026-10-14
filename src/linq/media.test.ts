import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const upload = vi.hoisted(() => ({
  fetch: vi.fn(),
  release: vi.fn(async () => {}),
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: upload.fetch,
}));
import { sendMessageLinq } from "./send.js";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("loads an authorized local file through host media policy, uploads bytes, then sends its attachment id", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "linq-media-"));
  try {
    const file = path.join(dir, "hello.txt");
    await writeFile(file, "fixture content");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          attachment_id: "a1",
          upload_url: "https://uploads.example.com/a1",
          http_method: "PUT",
          required_headers: { "Content-Type": "text/plain" },
        }),
      )
      .mockResolvedValueOnce(Response.json({ message: { id: "m1" } }));
    vi.stubGlobal("fetch", fetcher);
    upload.fetch.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      release: upload.release,
    });
    await sendMessageLinq("linq:chat:c1", "caption", {
      config: { channels: { linq: { apiToken: "fixture" } } },
      mediaUrl: file,
      mediaLocalRoots: [dir],
    });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
      filename: "hello.txt",
      size_bytes: 15,
    });
    expect(upload.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://uploads.example.com/a1",
        init: expect.objectContaining({
          method: "PUT",
          headers: { "Content-Type": "text/plain" },
          body: new TextEncoder().encode("fixture content"),
          redirect: "error",
        }),
      }),
    );
    expect(upload.release).toHaveBeenCalledOnce();
    expect(JSON.parse(fetcher.mock.calls[1][1].body).message.parts).toEqual([
      { type: "text", value: "caption" },
      { type: "media", attachment_id: "a1" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
