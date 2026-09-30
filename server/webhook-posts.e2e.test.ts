import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { launchVerificationServer, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

describe("post webhooks through the isolated server", () => {
  let session: VerificationServer;
  let restarted: ChildProcess | undefined;

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${session.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5_000),
    });
    const result = await response.json() as any;
    expect(response.ok, `${method} ${path}: ${response.status}`).toBe(true);
    return result;
  };

  const hookState = async (id: string) =>
    (await api("GET", "/api/webhooks")).webhooks.find((hook: any) => hook.id === id);
  const botState = async (id: string) =>
    (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === id);
  const texts = async (threadId: string) =>
    (await api("GET", `/api/threads/${threadId}/messages`)).messages
      .filter((message: any) => message.kind === "text")
      .map((message: any) => message.text);
  const deliver = async (url: string, text: string, id: string) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": id },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5_000),
    });
    expect(response.status).toBe(202);
    return await response.json();
  };
  const makeHook = (botId: string) => api("POST", "/api/webhooks", {
    name: "Monitoring updates", botId, delivery: "post", prompt: "",
  });
  const makeBot = async (name: string) => {
    const { bot } = await api("POST", "/api/bots", { name });
    return (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Conversation" })).bot;
  };

  beforeEach(async () => {
    session = await launchVerificationServer();
  }, 30_000);

  afterEach(async () => {
    await waitForExit(restarted, { signal: "SIGTERM" });
    restarted = undefined;
    await session?.close();
  });

  it("keeps each webhook's posts separate from selected conversations across a server restart", async () => {
    const bot = await makeBot("Monitoring bot");
    const firstChat = bot.threadId;
    const secondChat = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Another conversation" })).task.threadId;
    const created = await makeHook(bot.id);
    await deliver(created.credential.url, "first update", "first");
    expect(await texts(secondChat)).toEqual([]);
    const destination = (await hookState(created.webhook.id)).resultsThreadId;
    expect(destination).toEqual(expect.any(String));
    expect([firstChat, secondChat]).not.toContain(destination);
    expect((await botState(bot.id)).threadId).toBe(secondChat);

    await api("POST", `/api/bots/${bot.id}/tasks/${firstChat}`, {});
    await deliver(created.credential.url, "second update", "second");
    expect((await hookState(created.webhook.id)).resultsThreadId).toBe(destination);
    expect((await botState(bot.id)).threadId).toBe(firstChat);

    const other = await makeHook(bot.id);
    await deliver(other.credential.url, "another feed", "other");
    const otherDestination = (await hookState(other.webhook.id)).resultsThreadId;
    expect(otherDestination).not.toBe(destination);
    expect(await texts(otherDestination)).toEqual(["another feed"]);

    await waitForExit(session.child, { signal: "SIGTERM" });
    const log = openSync(session.info.logPath, "a", 0o600);
    try {
      restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: verificationServerEnvironment(process.env, session.info.dataDir, Number(new URL(session.info.url).port)),
        stdio: ["ignore", log, log],
      });
    } finally {
      closeSync(log);
    }
    await expect.poll(async () => {
      try { return (await fetch(`${session.info.url}/api/bots`, { signal: AbortSignal.timeout(1_000) })).status; }
      catch { return 0; }
    }, { timeout: 20_000 }).toBe(200);

    await api("POST", `/api/bots/${bot.id}/tasks/${secondChat}`, {});
    await deliver(created.credential.url, "third update", "third");
    expect((await hookState(created.webhook.id)).resultsThreadId).toBe(destination);
    expect((await botState(bot.id)).threadId).toBe(secondChat);
    expect(await texts(destination)).toEqual(["first update", "second update", "third update"]);
    expect(await texts(firstChat)).toEqual([]);
    expect(await texts(secondChat)).toEqual([]);
    expect((await api("GET", "/api/routines")).runs).toEqual([]);
    expect(await deliver(created.credential.url, "duplicate update", "third")).toMatchObject({ duplicate: true });
    expect(await texts(destination)).toEqual(["first update", "second update", "third update"]);
  }, 45_000);

  it("creates a visible destination after the previous results conversation is deleted", async () => {
    const bot = await makeBot("Monitoring bot");
    const created = await makeHook(bot.id);
    await deliver(created.credential.url, "before deletion", "before");
    const deleted = (await hookState(created.webhook.id)).resultsThreadId;
    await api("DELETE", `/api/bots/${bot.id}/tasks/${deleted}`);

    await deliver(created.credential.url, "after deletion", "after");
    const destination = (await hookState(created.webhook.id)).resultsThreadId;
    expect(destination).not.toBe(deleted);
    const fresh = await botState(bot.id);
    expect(fresh.tasks.map((task: any) => task.threadId)).toContain(destination);
    expect(fresh.threadId).toBe(bot.threadId);
    expect(await texts(destination)).toEqual(["after deletion"]);
    expect(await texts(bot.threadId)).toEqual([]);
  }, 30_000);

  it("posts only to the new bot after a webhook is reassigned", async () => {
    const original = await makeBot("Original bot");
    const target = await makeBot("New bot");
    const created = await makeHook(original.id);
    await deliver(created.credential.url, "original update", "original");
    const originalDestination = (await hookState(created.webhook.id)).resultsThreadId;
    await api("PATCH", `/api/webhooks/${created.webhook.id}`, { botId: target.id });

    await deliver(created.credential.url, "new bot update", "new-bot");
    const destination = (await hookState(created.webhook.id)).resultsThreadId;
    expect(destination).not.toBe(originalDestination);
    expect((await botState(target.id)).tasks.map((task: any) => task.threadId)).toContain(destination);
    expect(await texts(destination)).toEqual(["new bot update"]);
    expect(await texts(originalDestination)).toEqual(["original update"]);
    expect((await botState(target.id)).threadId).toBe(target.threadId);
    expect(await texts(target.threadId)).toEqual([]);
  }, 30_000);
});
